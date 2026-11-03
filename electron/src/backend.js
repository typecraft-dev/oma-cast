// Port of plugin/Backend.qml to node: the in-process backend the window
// talks to through core/Rpc. Same method surface, same names, same
// semantics; platform calls (clipboard, launching, opening URLs, pasting,
// agent hand-off) arrive as injected `host` adapters so this file stays
// testable outside Electron. Omarchy-menu providers/guards do not exist on
// Windows; apps come from the Start Menu instead. [D]
var Rpc = require("../../plugin/core/Rpc.js")
var Paths = require("../../plugin/core/Paths.js")
var Log = require("../../plugin/core/Log.js")
var Schema = require("../../plugin/core/Schema.js")
var Ranker = require("../../plugin/core/Ranker.js")
var Frecency = require("../../plugin/core/Frecency.js")
var RootSearch = require("../../plugin/core/RootSearch.js")
var Calculator = require("../../plugin/core/Calculator.js")
var Agent = require("../../plugin/core/Agent.js")
var FileSearch = require("../../plugin/core/FileSearch.js")
var SettingsView = require("../../plugin/core/SettingsView.js")
var winSettings = require("./windows-settings")
var themes = require("./themes")
var jsonStore = require("./json-store")
var calcData = require("./calculator-data")

// doctor/system.info report this: one source of truth with the installer.
var VERSION = require("../package.json").version

function createBackend(opts) {
  opts = opts || {}
  var paths = opts.paths || Paths.resolveWindows(opts.env || function(k) { return process.env[k] })
  var host = opts.host || {}
  var apps = opts.apps
  var fileIndex = opts.fileIndex || null
  var processes = opts.processes || null
  var nowMs = opts.now || Date.now

  var registry = Rpc.createRegistry()
  var startedAt = nowMs()

  var config = Schema.withConfigDefaults(null)
  var directoriesReady = false

  var candidates = []
  var candidatesById = {}
  var candidatesRevision = 0
  var storeRevision = 0
  var agentChecking = false
  var listeners = { notification: [] }

  var settingsStore = jsonStore.createStore({ path: paths.db + "/" + Schema.documents.settings.file, migrations: Schema.documents.settings.migrations, now: nowMs })
  var frecencyStore = jsonStore.createStore({ path: paths.db + "/" + Schema.documents.frecency.file, migrations: Schema.documents.frecency.migrations, now: nowMs })
  var calculatorStore = jsonStore.createStore({ path: paths.db + "/" + Schema.documents.calculator.file, migrations: Schema.documents.calculator.migrations, now: nowMs })
  var calculatorData = calcData.createData({ cacheDir: paths.cache, ratesEnabled: config.currencyRates })

  function log(level, category, message, metadata) {
    if (!Log.shouldLog(level, config.logLevel)) return
    var line = Log.format(level, category, message, metadata)
    if (opts.log) opts.log(level, line)
    else console.log(line)
  }
  function notify(method, data) {
    (listeners.notification || []).forEach(function(cb) { cb(method, data) })
  }
  function emit(method, data) {
    Rpc.emit(registry, method, data, function(m, error) { log("error", "rpc", "subscriber of " + m + " threw: " + error) })
    notify(method, data)
  }

  // ------------------------------------------------------------- general
  var api = {
    version: VERSION,
    paths: paths,
    apps: apps || null,
    registry: registry,
    get loading() { return !!((apps && apps.loading) || agentChecking
      || (fileIndex && fileIndex.loading) || (processes && processes.loading)) },
    get ready() { return directoriesReady && settingsStore.loaded && frecencyStore.loaded && calculatorStore.loaded },
    get storeRevision() { return storeRevision },
    get candidatesRevision() { return candidatesRevision },
    // Bumped when exchange rates or zone offsets arrive (the open
    // calculator row re-evaluates) — QML's calculatorRevision.
    get calculatorRevision() { return (calculatorData.rates ? 1 : 0) + calculatorData.ratesFetchedAt + calculatorData.zonesAt },
    get config() { return config },
    call: function(method, data) { return Rpc.call(registry, method, data) },
    callSync: function(method, data) { return Rpc.callSync(registry, method, data) },
    subscribe: function(method, callback) { return Rpc.subscribe(registry, method, callback) },
    emit: emit,
    onNotification: function(cb) { listeners.notification.push(cb) },
    // The Quickshell.iconPath / appLibrary.iconSource slot: resolve a row's
    // iconName (a .lnk path on Windows) to a drawable URL, lazily.
    appsIcon: function(iconName) {
      return apps && apps.iconSource ? apps.iconSource(String(iconName || "")) : Promise.resolve("")
    }
  }

  function searchContext() {
    return {
      commands: settingsStore.loaded ? settingsStore.doc.commands : {},
      frecency: frecencyStore.loaded ? frecencyStore.doc.items : {},
      nowMs: nowMs(),
      sensitivity: settingsStore.loaded ? settingsStore.doc.general.rootSearchSensitivity : "medium"
    }
  }
  // Decorated-list memo: one clone + Math.exp per candidate per data
  // change (not per keystroke). Keyed on both revisions plus a 60 s time
  // bucket — frecency ordering is monotonic in anchor at fixed now, so a
  // bucket never reorders; the bucket only bounds absolute-value drift.
  // [D]
  var decorMemo = { rev: -1, srev: -1, bucket: -1, list: [] }
  // Final mapped-sections memo for the app-only root path (see search).
  // [D]
  var bMemo = { key: null, src: null, out: null }
  function decoratedList(ctx) {
    var bucket = Math.floor(ctx.nowMs / 60000)
    if (decorMemo.rev !== candidatesRevision || decorMemo.srev !== storeRevision || decorMemo.bucket !== bucket) {
      var list = []
      for (var i = 0; i < candidates.length; i++) {
        if (!RootSearchIsEnabled(candidates[i], ctx)) continue
        list.push(RootSearch.decorate(candidates[i], ctx, deps))
      }
      decorMemo = { rev: candidatesRevision, srev: storeRevision, bucket: bucket, list: list }
    }
    return decorMemo.list
  }
  function RootSearchIsEnabled(c, ctx) {
    var settings = ctx.commands && ctx.commands[c.id]
    return !(settings && settings.enabled === false)
  }
  function deepFreezeSections(sections) {
    try {
      for (var i = 0; i < sections.length; i++) {
        Object.freeze(sections[i].rows)
        Object.freeze(sections[i])
      }
      Object.freeze(sections)
    } catch (e) {}
    return sections
  }
  function decorated(id) {
    var c = candidatesById[id]
    return c ? RootSearch.decorate(c, searchContext(), deps) : null
  }

  // ---------------------------------------------------------- candidates
  function appEntries() {
    return (apps ? apps.entries : []).filter(function(e) { return e && e.id && !e.noDisplay })
  }
  function rebuildCandidates() {
    var next = []
    var list = appEntries()
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id) next.push(RootSearch.appCandidate(list[i]))
    // No omarchy-shell to summon on Windows: drop the summoning builtin.
    for (var b = 0; b < RootSearch.BUILTINS.length; b++) {
      var def = RootSearch.BUILTINS[b]
      if (def.run && def.run.summon) continue
      next.push(RootSearch.builtinCandidate(def))
    }
    var byId = {}
    for (var j = 0; j < next.length; j++) byId[next[j].id] = next[j]
    candidates = next
    candidatesById = byId
    candidatesRevision++
  }

  var rebuildTimer = null
  function scheduleRebuild() {
    if (rebuildTimer) return
    rebuildTimer = setTimeout(function() { rebuildTimer = null; rebuildCandidates() }, 30)
  }

  var deps = { Ranker: Ranker, Frecency: Frecency }

  // ---------------------------------------------------------- calculator
  function calculatorEnv() {
    var hour12
    if (config.clockFormat === "auto") {
      var hc = ""
      try { hc = new Intl.DateTimeFormat().resolvedOptions().hourCycle || "" } catch (e) {}
      hour12 = hc === "h12" || hc === "h11"
    } else hour12 = config.clockFormat === "12h"
    return {
      nowMs: nowMs(),
      localOffset: -new Date().getTimezoneOffset(),
      hour12: hour12,
      rates: config.currencyRates ? calculatorData.rates : null,
      zones: calculatorData.zones,
      remToPxRate: config.remToPxRate,
      workHoursPerDay: config.workHoursPerDay
    }
  }
  function calculate(query) {
    try {
      return Calculator.evaluate(query, calculatorEnv())
    } catch (e) {
      log("error", "calculator", "evaluating failed: " + e, { query: query })
      return null
    }
  }
  function saveCalculation(entry) {
    calculatorStore.update(function(doc) {
      doc.history = Calculator.pushHistory(doc.history, {
        id: String(nowMs()), query: entry.query, result: entry.result, copy: entry.copy, kind: entry.kind
      }, nowMs())
    })
    emit("calculator.historyStateChanged", null)
  }

  // An action on the inline Calculator row or a Calculator History entry.
  function calculatorAction(action, entry, historyId) {
    switch (action) {
      case "open":
      case "copy-answer":
        if (!historyId) saveCalculation(entry)
        if (host.copy) host.copy(entry.copy)
        return { close: true, hud: "Copied to Clipboard" }
      case "paste-answer":
        if (!historyId) saveCalculation(entry)
        // Copies, waits for the window to unmap, sends Ctrl+V — the
        // omarchy-clipboard-paste-text contract, executed in main. [D]
        if (host.pasteText) host.pasteText(entry.copy)
        return { close: true }
      case "copy-question-answer":
        if (!historyId) saveCalculation(entry)
        if (host.copy) host.copy(entry.query + " = " + entry.result)
        return { close: true, hud: "Copied to Clipboard" }
      case "open-history":
        return { push: { kind: "calculator-history", title: "Calculator History" } }
      case "delete-entry":
        calculatorStore.update(function(doc) { doc.history = doc.history.filter(function(h) { return h.id !== historyId }) })
        emit("calculator.historyStateChanged", null)
        return { toast: { style: "success", title: "Entry deleted" } }
      case "delete-all-entries":
        calculatorStore.update(function(doc) { doc.history = [] })
        emit("calculator.historyStateChanged", null)
        return { toast: { style: "success", title: "History cleared" } }
    }
    throw new Error("Unknown action " + action)
  }
  function historyEntry(id) {
    var key = String(id).slice("calculator-history:".length)
    var list = calculatorStore.loaded ? calculatorStore.doc.history : []
    for (var i = 0; i < list.length; i++) if (list[i].id === key) return list[i]
    return null
  }

  // ------------------------------------------------------------- agent
  // The authorized hand-off (SPEC §2.0) becomes a config template on
  // Windows: agentCommand containing {prompt}, e.g. `wt.exe -w 0 claude`.
  // Empty → the action explains how to enable it. [D]
  var agentTimer = null
  function agentArgv(query) {
    var prompt = String(query === undefined || query === null ? "" : query)
    if (!prompt.trim()) throw new Error("Type a question first")
    if (prompt.indexOf("\u0000") >= 0) throw new Error("Questions cannot contain a NUL character")
    if (prompt.length > 16384) throw new Error("Keep the question under 16,385 characters")
    var template = String(config.agentCommand || "").trim()
    if (!template) throw new Error("Set agentCommand in config.json, e.g. \"wt.exe claude -- \\\"{prompt}\\\"\"")
    var quoted = '"' + prompt.replace(/(["\\])/g, "\\$1") + '"'
    return template.indexOf("{prompt}") >= 0
      ? template.split("{prompt}").join(quoted)
      : template + " " + quoted
  }
  function agentStart(query) {
    var command
    try { command = agentArgv(query) } catch (e) { emit("agent.launchFailed", { message: String(e.message || e) }); return }
    if (agentChecking) { emit("agent.launchFailed", { message: "Agent launch is already being checked" }); return }
    agentChecking = true
    var first = command.trim().split(/\s+/)[0].replace(/^"|"$/g, "")
    var done = false
    function finish(ok, message) {
      if (done) return
      done = true
      agentChecking = false
      if (agentTimer) { clearTimeout(agentTimer); agentTimer = null }
      if (!ok) { emit("agent.launchFailed", { message: message }); return }
      emit("agent.launchReady", { argv: command })
    }
    agentTimer = setTimeout(function() { finish(false, "Agent launch check timed out. Try again.") }, 5000)
    if (host.checkCommand) {
      host.checkCommand(first, function(ok, message) {
        finish(ok, message || "Agent command not found. Check agentCommand in config.json.")
      })
    } else finish(true)
  }

  // ----------------------------------------------------------- execution
  function recordVisit(id, query) {
    if (!frecencyStore.loaded) return
    frecencyStore.update(function(doc) {
      doc.items[id] = Frecency.recordVisit(doc.items[id] || null, nowMs(), query || "")
      if (query) doc.searchHistory = Schema.pushSearchHistory(doc.searchHistory, query)
    })
  }
  function updateCommand(id, mutator) {
    settingsStore.update(function(doc) {
      var current = doc.commands[id] || {}
      var next = mutator(JSON.parse(JSON.stringify(current)))
      var empty = true
      for (var k in next) if (next[k] !== null && next[k] !== undefined && next[k] !== "") empty = false
      if (empty) delete doc.commands[id]
      else doc.commands[id] = next
    })
    emit("settings.commandSettingsChanged", { commandId: id })
  }

  function toRow(c) { return { candidate: c, record: null } }

  // Kill Process view rows: biggest working set first (the snapshot
  // arrives sorted), PID as the subtitle, memory as the type label. [D]
  function processCandidate(r) {
    return {
      id: "process:" + r.pid,
      type: "process",
      kind: "process",
      title: r.name,
      subtitle: "PID " + r.pid,
      typeLabel: r.ws > 0 ? (Math.round(r.ws / 1048576 * 10) / 10) + " MB" : "",
      glyph: "\uf2db",                 // nf-fa-microchip
      glyphFont: "",
      pid: r.pid,
      path: r.path,
      rootSearch: { when: "searching" }
    }
  }
  function processRow(pid) {
    return processes ? processes.rows.filter(function(r) { return r.pid === Number(pid) })[0] : null
  }
  function actionsForSetting() {
    return [{ id: "open", title: "Change", shortcut: "↵", section: "primary", icon: "\uf0ad" }]
  }
  // A Windows Settings row opens the Settings app on that page; the
  // builtin row ("Windows Settings") pushes the list itself.
  function actionsForWindowsSetting() {
    return [{ id: "open", title: "Open Settings Page", shortcut: "↵", section: "primary", icon: "\uf013" }]
  }
  function matchesWindowsBuiltin(c, query) {
    var q = String(query || "").trim().toLowerCase()
    if (!q) return true
    var hay = (c.title + " " + c.subtitle + " " + (c.keywords || []).join(" ")).toLowerCase()
    var parts = q.split(/\s+/)
    for (var i = 0; i < parts.length; i++) if (hay.indexOf(parts[i]) < 0) return false
    return true
  }
  function actionsForProcess(row) {
    var list = [{ id: "open", title: "Kill Process", shortcut: "↵", section: "primary", icon: "\uf111" }]
    if (row && row.path) list.push({ id: "reveal", title: "Reveal in Explorer", shortcut: "Ctrl ↵", section: "primary", icon: "\uf06e" })
    list.push({ id: "copy-pid", title: "Copy PID", shortcut: "Ctrl Shift C", section: "copy", icon: "\uf0c5" })
    return list
  }

  // ------------------------------------------------------------ settings
  // The place for themes: %APPDATA%\oma-cast\themes\<name>\colors.toml,
  // next to config.json; the bundled copy ships inside the app.
  var pathLib = require("path")
  var themeRoots = {
    bundledDir: pathLib.join(__dirname, "..", "themes"),
    userDir: paths.config ? pathLib.join(paths.config, "themes") : ""
  }
  function themeNames() {
    return themes.listThemes(themeRoots).map(function(t) { return t.name })
  }
  function themeChoiceBag() { return { themes: themeNames() } }
  // ↵ on a settings row cycles to the next value: "general" goes through
  // the same validated store path as the RPC, "config" rewrites
  // config.json (the hotkey is re-registered immediately). [D]
  function applyConfigValue(key, value) {
    if (!Schema.validConfigValue(key, value)) throw new Error("Invalid value for " + key)
    config[key] = value
    try {
      require("fs").writeFileSync(paths.configFile, JSON.stringify(config, null, 2) + "\n")
    } catch (e) { throw new Error("cannot write " + paths.configFile + ": " + (e && e.message || e)) }
    // hotkey: main re-registers the accelerator; openAtLogin: main
    // re-applies the HKCU Run login item (app.setLoginItemSettings). [D]
    if ((key === "hotkey" || key === "openAtLogin") && host.configChanged) host.configChanged()
    if (key === "fileSearchIncludeHidden" && fileIndex && fileIndex.setIncludeHidden) fileIndex.setIncludeHidden(value)
    if (key === "fileSearchProvider" && fileIndex && fileIndex.setProvider) fileIndex.setProvider(value)
    // The renderer repaints (theme / font / geometry come from config).
    emit("settings.configChanged", { key: key, value: value })
  }
  function applySetting(id, action) {
    if (action !== "open") throw new Error("Unknown action " + action)
    var def = SettingsView.find(id)
    if (!def) throw new Error("Unknown setting " + id)
    var current = SettingsView.valueOf(def, settingsStore.loaded ? settingsStore.doc.general : {}, config)
    var next = SettingsView.cycle(def, current, themeChoiceBag())
    if (def.scope === "general") {
      var patch = {}
      patch[def.key] = next
      var r = Rpc.callSync(registry, "settings.updateGeneralSettings", patch)
      if (!r.ok) throw r.error
    } else {
      applyConfigValue(def.key, next)
    }
    return { toast: { style: "success", title: def.label + ": " + SettingsView.format(def, next) } }
  }

  // ms-settings: deep link — no confirmation, the Settings app decides
  // what a page does on this Windows build. [D]
  function windowsSettingAction(id, action) {
    if (action !== "open") throw new Error("Unknown action " + action)
    var uri = String(id).slice("winset:".length)
    var page = winSettings.find(uri)
    if (!page) throw new Error("Unknown settings page " + uri)
    if (host.openExternal) host.openExternal(page.uri)
    return { close: true, hud: "Opening " + page.title }
  }

  // ---------------------------------------------------- processes (kill)
  function processAction(id, action) {
    var pid = Number(String(id).slice("process:".length))
    var row = processRow(pid)
    if (action === "copy-pid") {
      if (host.copy) host.copy(String(pid))
      return { toast: { style: "success", title: "PID " + pid + " copied" } }
    }
    if (action === "reveal") {
      if (!row || !row.path) throw new Error("Path unavailable for PID " + pid)
      if (host.reveal) host.reveal(row.path)
      return { close: true }
    }
    if (action !== "open") throw new Error("Unknown action " + action)
    if (!row) throw new Error("No such process " + pid)
    // Synchronous taskkill: a couple hundred ms on an explicit user action,
    // and the sync RPC world gets its toast immediately. [D]
    var res = processes.kill(pid)
    processes.remove(pid)
    if (!res.ok) {
      return { toast: { style: "failure", title: "Could not kill " + row.name + (res.message ? ": " + res.message : "") } }
    }
    processes.refresh(true)
    return { toast: { style: "success", title: row.name + " (" + pid + ") killed" } }
  }

  // ---------------------------------------------------------------- files
  function fileAction(id, action) {
    var p = String(id).slice("file:".length)
    if (action === "copy-path") {
      if (host.copy) host.copy(p)
      return { close: true, hud: "Copied to Clipboard" }
    }
    if (action === "reveal") { if (host.reveal) host.reveal(p); return { close: true } }
    if (action === "open") { if (host.openPath) host.openPath(p); return { close: true } }
    throw new Error("Unknown action " + action)
  }

  // ↵ on an app: if that program already has a window, take the user
  // there instead of spawning a second instance — main asks the focus
  // helper (process → hwnd → restore + focus) and answers async; only
  // "not running" (or no bridge) falls back to the launch. The exe name
  // comes from the shortcut target, or — for Store/MSIX rows, which carry
  // no path — from the package family prefix (Notion_…!App → Notion); a
  // wrong guess just answers none and launches as before. Wrapper
  // shortcuts (explorer/cmd targets with the real app in their arguments,
  // which we do not parse) never ask: they would "find" the desktop. The
  // whole decision is logged so a live machine can show which way it went. [D]
  var WRAPPER_EXES = { explorer: 1, cmd: 1, powershell: 1, pwsh: 1, wscript: 1, cscript: 1, mshta: 1, rundll32: 1 }
  function launchApp(candidate) {
    var appId = String(candidate.appId || "")
    var exe = ""
    if (apps) {
      var list = apps.entries || []
      for (var i = 0; i < list.length; i++) {
        var e = list[i]
        if (!e || e.id !== appId) continue
        if (e.target && /\.exe$/i.test(String(e.target))) {
          exe = String(e.target).replace(/\\/g, "/").split("/").pop().replace(/\.exe$/i, "")
          if (WRAPPER_EXES[exe.toLowerCase()]) exe = ""
        } else if (appId.indexOf("uwp:") === 0) {
          exe = appId.slice(4).split("_")[0]
        }
        break
      }
    }
    if (exe && host.focusAppWindow) {
      log("info", "app", "switch requested", { appId: appId, exe: exe })
      host.focusAppWindow(exe, function(taken) {
        log("info", "app", taken ? "switched to the open window" : "no window found — launching", { exe: exe })
        if (!taken && apps) apps.launch(appId)
      })
      return
    }
    log("info", "app", "direct launch", { appId: appId, exe: exe || null })
    if (apps) apps.launch(appId)
  }

  // A pushed web-search row launches its engine with the view query. The
  // builtin that pushed it earns the frecency visit (the old pill flow did
  // recordVisit on the builtin too), so the engine rises with use. [D]
  function webSearchAction(id, action, query) {
    if (action !== "open") throw new Error("Unknown action " + action)
    var engine = "fallback:" + String(id).slice("web-search:".length)
    var fb = RootSearch.engineFallback(engine)
    if (!fb) throw new Error("Unknown command " + id)
    if (!String(query || "").trim()) throw new Error("Type a query first")
    var builtinId = RootSearch.builtinIdForEngine(engine)
    if (candidatesById[builtinId]) recordVisit(builtinId, query)
    if (host.openExternal) host.openExternal(RootSearch.fallbackUrl(fb, query))
    return { close: true }
  }

  function performAction(data) {
    var id = String(data && data.id || "")
    var action = String(data && data.action || "open")
    var query = String(data && data.query || "").trim()
    // View rows resolve without a stored candidate.
    if (id.indexOf("setting:") === 0) return applySetting(id, action)
    if (id.indexOf("winset:") === 0) return windowsSettingAction(id, action)
    if (id.indexOf("process:") === 0) return processAction(id, action)
    if (id.indexOf("file:") === 0) return fileAction(id, action)
    if (id.indexOf("web-search:") === 0) return webSearchAction(id, action, query)
    var candidate = decorated(id)
    if (!candidate) throw new Error("Unknown command " + id)

    if (action === "open") {
      switch (candidate.kind) {
        case "app":
          recordVisit(id, query)
          launchApp(candidate)
          return { close: true }
        case "builtin":
          if (candidate.run.power) {
            // All power actions fire immediately and close the window
            // first (sleep delays past the unmap; shutdown/restart run
            // shutdown.exe /t 0). No frecency for power actions — they
            // must not crowd Suggestions. [D]
            var powerHud = { shutdown: "Shutting down…", restart: "Restarting…", sleep: "Sleeping…" }
            if (host.power) host.power(candidate.run.power, 0)
            return { close: true, hud: powerHud[candidate.run.power] || "Done" }
          }
          if (candidate.run.url) {
            var values = (data && data.arguments) || {}
            var missing = RootSearch.missingArgument(candidate.arguments, values)
            if (missing >= 0) throw new Error("Type a " + candidate.arguments[missing].placeholder.toLowerCase() + " first")
            recordVisit(id, query)
            if (host.openExternal) host.openExternal(RootSearch.fillArguments(candidate.run.url, values))
            return { close: true }
          }
          recordVisit(id, query)
          if (candidate.run.push) {
            // The Kill Process view wants a fresh snapshot on entry.
            if (candidate.run.push.kind === "processes" && processes) processes.refresh()
            return { push: candidate.run.push }
          }
          return { close: true }
        case "fallback":
          if (host.openExternal) host.openExternal(RootSearch.fallbackUrl(candidate, query))
          return { close: true }
      }
      throw new Error("Cannot open " + id)
    }

    switch (action) {
      case "copy-command":
      case "copy-id":
        if (host.copy) host.copy(action === "copy-id" ? candidate.appId : candidate.action)
        return { close: true, hud: "Copied to Clipboard" }
      case "favorite-add":
      case "favorite-remove":
      case "favorite-up":
      case "favorite-down":
        var orders = RootSearch.reorderFavorites(settingsStore.doc.commands, id, action)
        settingsStore.update(function(doc) {
          for (var key in orders) {
            var entry = doc.commands[key] || {}
            if (orders[key] === null) delete entry.favoriteOrder
            else entry.favoriteOrder = orders[key]
            if (Object.keys(entry).length === 0) delete doc.commands[key]
            else doc.commands[key] = entry
          }
        })
        var titles = { "favorite-add": "Added to Favorites", "favorite-remove": "Removed from Favorites", "favorite-up": "Moved Up", "favorite-down": "Moved Down" }
        return { toast: { style: "success", title: titles[action] } }
      case "set-alias":
        return { push: { kind: "alias", commandId: id, title: "Alias for " + candidate.title, value: candidate.alias } }
      case "remove-alias":
        updateCommand(id, function(s) { delete s.alias; return s })
        return { toast: { style: "success", title: "Alias removed" } }
      case "reset-ranking":
        frecencyStore.update(function(doc) { delete doc.items[id] })
        return { toast: { style: "success", title: "Ranking reset" } }
      case "disable":
        updateCommand(id, function(s) { s.enabled = false; return s })
        // Undo on Ctrl+T: there is no settings window to re-enable it yet.
        return { toast: { style: "success", title: candidate.title + " disabled", actions: [
          { id: "undo", title: "Undo", done: candidate.title + " enabled",
            call: { method: "settings.updateCommandSettings", data: { commandId: id, enabled: true } } }
        ] } }
    }
    throw new Error("Unknown action " + action)
  }

  // ------------------------------------------------------------- registry
  function registerServices() {
    Rpc.register(registry, "system", {
      healthPing: function() { return null },
      healthDatabase: function() {
        var t0 = nowMs()
        JSON.stringify(settingsStore.doc)
        JSON.stringify(frecencyStore.doc)
        return {
          workMs: nowMs() - t0,
          settings: { loaded: settingsStore.loaded, readOnly: settingsStore.readOnly, error: settingsStore.lastError },
          frecency: { loaded: frecencyStore.loaded, readOnly: frecencyStore.readOnly, error: frecencyStore.lastError },
          loaded: settingsStore.loaded, readOnly: settingsStore.readOnly, error: settingsStore.lastError
        }
      },
      info: function() {
        return {
          version: api.version,
          desktop: "windows",
          ready: api.ready,
          uptimeMs: nowMs() - startedAt,
          candidates: candidates.length,
          appLibrary: !!apps,
          // How many Start Menu / Desktop / Store entries the library
          // holds — `oma-cast doctor` prints it to catch a short list. [D]
          applications: apps ? apps.entries.length : 0,
          methods: Rpc.methods(registry)
        }
      },
      getPaths: function() { return paths },
      // Kept for old toasts: Cancel used to abort a scheduled
      // shutdown/restart (shutdown /a); power actions are immediate now.
      cancelPowerShutdown: function() { if (host.cancelPower) host.cancelPower(); return null }
    })

    Rpc.register(registry, "settings", {
      getGeneralSettings: function() {
        if (!settingsStore.loaded) throw new Error("settings not loaded")
        return settingsStore.doc.general
      },
      updateGeneralSettings: function(data) {
        if (!settingsStore.loaded) throw new Error("settings not loaded")
        if (settingsStore.readOnly) throw new Error("settings are read-only: " + (settingsStore.lastError || "written by a newer build"))
        var patch = data && typeof data === "object" ? data : {}
        var current = settingsStore.doc.general
        for (var key in patch) {
          if (current[key] === undefined) throw new Error("Unknown general setting " + key)
          if (typeof patch[key] !== typeof current[key]) throw new Error("Setting " + key + " must be a " + typeof current[key])
          var choices = Schema.generalChoices[key]
          if (choices && choices.indexOf(patch[key]) < 0) throw new Error("Setting " + key + " must be one of " + choices.join(", "))
        }
        settingsStore.update(function(doc) { for (var k in patch) doc.general[k] = patch[k] })
        emit("settings.generalSettingsChanged", settingsStore.doc.general)
        return settingsStore.doc.general
      },
      getAllCommandSettings: function() { return settingsStore.doc.commands },
      getCommandSettings: function(data) { return settingsStore.doc.commands[String(data && data.commandId || "")] || {} },
      updateCommandSettings: function(data) {
        var id = String(data && data.commandId || "")
        if (!candidatesById[id]) throw new Error("Unknown command " + id)
        if (data.alias !== undefined && data.alias !== null) {
          var alias = String(data.alias).trim().toLowerCase()
          if (/\s/.test(alias)) throw new Error("An alias cannot contain spaces")
          var commands = settingsStore.doc.commands
          for (var other in commands) {
            if (other !== id && commands[other].alias === alias && alias) throw new Error("Alias “" + alias + "” is already used by " + ((candidatesById[other] || {}).title || other))
          }
        }
        updateCommand(id, function(s) {
          if (data.alias !== undefined) { if (data.alias) s.alias = String(data.alias).trim().toLowerCase(); else delete s.alias }
          if (data.enabled !== undefined) { if (data.enabled === false) s.enabled = false; else delete s.enabled }
          return s
        })
        return settingsStore.doc.commands[id] || {}
      }
    })

    Rpc.register(registry, "rootSearch", {
      search: function(data) {
        var query = String(data && data.query || "")
        var view = data && data.view
        var ctx = searchContext()
        var sections
        if (view && view.kind === "settings") {
          var srows = SettingsView.rowsFor(
            settingsStore.loaded ? settingsStore.doc.general : {}, config, query, themeChoiceBag()).map(toRow)
          // "Windows Settings" leads the launcher's own Settings view:
          // two ways in, both labelled settings. [D]
          var winBuiltin = candidatesById["builtin:windows-settings"]
          if (winBuiltin && matchesWindowsBuiltin(winBuiltin, query)) srows.unshift(toRow(decorated(winBuiltin.id)))
          sections = [{ id: "settings", title: "", rows: srows }]
        } else if (view && view.kind === "windows-settings") {
          sections = winSettings.sections(query).map(function(s) {
            return { id: s.id, title: s.title, rows: s.rows.map(toRow) }
          })
        } else if (view && view.kind === "processes") {
          if (processes && !processes.loading) processes.refresh()
          var needle = query.trim().toLowerCase()
          var prows = (processes ? processes.rows : []).filter(function(r) {
            return !needle || r.name.toLowerCase().indexOf(needle) >= 0 || String(r.pid).indexOf(needle) === 0
          }).map(processCandidate)
          sections = prows.length ? [{ id: "processes", title: "", rows: prows.map(toRow) }] : []
        } else if (view && view.kind === "calculator-history") sections = RootSearch.historySections(calculatorStore.doc.history, query, ctx.nowMs, Calculator.filterHistory)
        else if (view && view.kind === "web-search") sections = RootSearch.webSearchSections(view.engine, query)
        else {
          ctx.filter = String(data && data.filter || "all")
          ctx.decorated = decoratedList(ctx)
          if (query.trim() && ctx.filter === "all") ctx.calculation = calculate(query)
          // App-search result memo: identical query + filter + data +
          // calculator output returns the mapped sections with a shallow
          // copy (row refs are never mutated downstream; the RPC layer
          // serializes). Time-varying calculator rows carry their output
          // in the key, so they miss instead of going stale. The Files
          // tier bypasses (walker cache churns independently). [D]
          var fq = query.trim()
          var filesTier = ctx.filter === "all" && fq.length >= 2 && fileIndex && fileIndex.ready && !(data && data.skipFiles)
          var calcKey = ctx.calculation ? ctx.calculation.copy : ""
          var bKey = !view && !filesTier ? query + "\n" + ctx.filter + "\n" + calcKey : null
          if (bKey && bMemo.key === bKey && bMemo.src === ctx.decorated) {
            // Shared frozen reference: the RPC/IPC boundary serializes,
            // so no caller can mutate the cache; freezing turns a
            // violation into a loud error instead of silent pollution. [D]
            return bMemo.out
          }
          sections = RootSearch.rootSections(candidates, query, ctx, deps)
          // SPEC §8.6: a Files section after Results (before the “Use ‘q’
          // with…” fallbacks), once the query is long enough to plausibly
          // be a file name. A single-token name query ("files", "notes")
          // only matches file NAMES: a path-only hit (C:\…\Files\data.db
          // for "files") is how an app search turns into a wall of files.
          // Path bags stay for multi-token and path-like queries (slashes,
          // a drive colon, ~). [D]
          var fq = query.trim()
          // ...until the first app scan lands: the file index loads from
          // its disk cache synchronously while the Start Menu scan is an
          // async PowerShell pass, so without this a cold show's first
          // keystrokes render Files before Applications even exists.
          // Stubs without the latch (tests) read as already-scanned. [D]
          var appsReady = !apps || apps.scanned !== false
          if (ctx.filter === "all" && fq.length >= 2 && fileIndex && fileIndex.ready && appsReady && !(data && data.skipFiles)) {
            var pathLike = /[\/\\~:]/.test(fq) || fq.split(/\s+/).length > 1
            // Everything mode: Everything generates candidates system-wide
            // and instantly; the same ranker tiers them (nameOnly included).
            // A dead Everything (not installed/running) answers null and
            // the walk pool serves that query instead. [D]
            var pool = fileIndex.entries
            if (config.fileSearchProvider === "everything" && fileIndex.searchEverything) {
              var esPool = fileIndex.searchEverything(fq, 100)
              if (esPool) pool = esPool
            }
            var matches = FileSearch.match(pool, fq, { limit: 30, nameOnly: !pathLike })
            if (matches.length > 0) {
              var fileSection = { id: "files", title: "Files", rows: matches.map(function(m) { return toRow(FileSearch.candidate(m.entry)) }) }
              var at = -1, fb = -1
              for (var si = 0; si < sections.length; si++) {
                if (sections[si].id === "results") at = si
                if (sections[si].id === "fallback-commands") fb = si
              }
              if (at >= 0) sections.splice(at + 1, 0, fileSection)
              else if (fb >= 0) sections.splice(fb, 0, fileSection)
              else sections.push(fileSection)
            }
          }
        }
        var mapped = sections.map(function(s) {
          return { id: s.id, title: s.title, rows: s.rows.map(function(r) { return r.candidate }) }
        })
        if (bKey && !view && !filesTier) bMemo = { key: bKey, src: ctx.decorated, out: deepFreezeSections(mapped) }
        return mapped
      },
      getActions: function(data) {
        var rowId = String(data && data.id || "")
        if (rowId.indexOf("setting:") === 0) return actionsForSetting()
        if (rowId.indexOf("winset:") === 0) return actionsForWindowsSetting()
        if (rowId === "builtin:windows-settings") return [{ id: "open", title: "Open Windows Settings", shortcut: "↵", section: "primary", icon: "\uf17a" }]
        if (rowId.indexOf("process:") === 0) return actionsForProcess(processRow(String(rowId).slice("process:".length)))
        if (rowId.indexOf("file:") === 0) return FileSearch.actionsForFile()
        if (rowId.indexOf("web-search:") === 0) {
          var wfb = RootSearch.engineFallback("fallback:" + rowId.slice("web-search:".length))
          if (!wfb) throw new Error("Unknown command " + rowId)
          return RootSearch.actionsFor({ kind: "web-search", title: wfb.title })
        }
        if (rowId === RootSearch.CALCULATOR_ID) return RootSearch.actionsFor({ kind: "calculator" })
        if (rowId.indexOf("calculator-history:") === 0) return RootSearch.actionsFor({ kind: "calculator-history" })
        var candidate = decorated(rowId)
        if (!candidate) {
          var fallback = RootSearch.FALLBACKS.filter(function(f) { return f.id === data.id })[0]
          if (!fallback) throw new Error("Unknown command " + (data && data.id))
          return RootSearch.actionsFor({ kind: "fallback", title: fallback.title })
        }
        return RootSearch.actionsFor(candidate)
      },
      getItemInfo: function(data) {
        var rowId = String(data && data.id || "")
        if (rowId.indexOf("setting:") === 0) {
          var sdef = SettingsView.find(rowId)
          if (!sdef) throw new Error("Unknown setting " + rowId)
          var sval = SettingsView.valueOf(sdef, settingsStore.loaded ? settingsStore.doc.general : {}, config)
          return [
            { label: "Setting", value: sdef.label },
            { label: "Value", value: SettingsView.format(sdef, sval) },
            { label: "Scope", value: sdef.scope === "general" ? "settings.json" : "config.json" },
            { label: "Hint", value: sdef.hint }
          ]
        }
        if (rowId.indexOf("winset:") === 0) {
          var wpage = winSettings.find(String(rowId).slice("winset:".length))
          if (!wpage) return []
          return [
            { label: "Setting", value: wpage.title },
            { label: "Category", value: wpage.category },
            { label: "URI", value: wpage.uri }
          ]
        }
        if (rowId.indexOf("process:") === 0) {
          var prow = processRow(String(rowId).slice("process:".length))
          if (!prow) return []
          return [
            { label: "Name", value: prow.name },
            { label: "PID", value: String(prow.pid) },
            { label: "Memory", value: prow.ws > 0 ? (Math.round(prow.ws / 1048576 * 10) / 10) + " MB" : "" },
            { label: "Path", value: prow.path || "" }
          ]
        }
        if (rowId.indexOf("file:") === 0) {
          var fpath = String(rowId).slice("file:".length)
          var hit = fileIndex ? fileIndex.entries.filter(function(e) { return e.p === fpath })[0] : null
          var infoRows = [
            { label: "Path", value: fpath },
            { label: "Kind", value: hit ? (hit.d ? "Folder" : "File") : "File" }
          ]
          if (hit && hit.m) infoRows.push({ label: "Modified", value: new Date(hit.m).toLocaleString() })
          return infoRows
        }
        if (rowId.indexOf("web-search:") === 0) {
          var weng = "fallback:" + rowId.slice("web-search:".length)
          var wcand = RootSearch.webSearchCandidate(weng, data.query)
          if (!wcand) throw new Error("Unknown command " + rowId)
          return RootSearch.aboutFor(wcand, nowMs())
        }
        var now2 = nowMs()
        if (rowId === RootSearch.CALCULATOR_ID) {
          var calc = calculate(String(data.query || ""))
          return calc ? RootSearch.aboutFor(RootSearch.calculatorCandidate(calc), now2) : []
        }
        if (rowId.indexOf("calculator-history:") === 0) {
          var entry = historyEntry(rowId)
          return entry ? RootSearch.aboutFor(RootSearch.historyCandidate(entry, now2), now2) : []
        }
        var candidate = decorated(rowId)
        if (!candidate) {
          var f = RootSearch.FALLBACKS.filter(function(x) { return x.id === rowId })[0]
          if (!f) throw new Error("Unknown command " + rowId)
          return RootSearch.aboutFor({ id: f.id, kind: "fallback", title: f.title, typeLabel: "Fallback", url: f.url }, now2)
        }
        return RootSearch.aboutFor(candidate, now2)
      },
      performAction: function(data) {
        // Destructive commands come back as a confirmation unless confirmed.
        if (!(data && data.confirmed)) {
          var confirm = RootSearch.confirmationFor(String(data && data.id || ""), String(data && data.action || "open"))
          if (confirm) return { confirm: confirm }
          // Kill Process rows confirm first (destructive, Alert.qml).
          if (String(data && data.id || "").indexOf("process:") === 0) {
            var kpid = Number(String(data.id).slice("process:".length))
            var krow = processRow(kpid)
            if (!krow) throw new Error("No such process " + kpid)
            return { confirm: { title: "Kill " + krow.name + "?",
              message: "PID " + kpid + " ends immediately. Unsaved data in " + krow.name + " is lost.",
              primary: "Kill Process", destructive: true } }
          }
        }
        var fallback = RootSearch.FALLBACKS.filter(function(f) { return f.id === (data && data.id) })[0]
        if (fallback) {
          if (fallback.id === Agent.FALLBACK_ID) {
            agentStart(data.query)
            return { pending: true }
          }
          if (host.openExternal) host.openExternal(RootSearch.fallbackUrl(fallback, data.query))
          return { close: true }
        }
        // A pushed web search runs the engine's URL template against the view query.
        if (data && String(data.id).indexOf("web-search:") === 0) {
          return webSearchAction(String(data.id), String(data.action || "open"), String(data.query || ""))
        }
        // The calculator row is the query itself, evaluated again.
        if (data && data.id === RootSearch.CALCULATOR_ID) {
          var calc = calculate(String(data.query || ""))
          if (!calc) throw new Error("Nothing to calculate")
          return calculatorAction(String(data.action || "open"), { query: calc.input, result: calc.result, copy: calc.copy, kind: calc.kind }, "")
        }
        if (data && String(data.id).indexOf("calculator-history:") === 0) {
          var entry = historyEntry(data.id)
          if (!entry) throw new Error("No such history entry")
          return calculatorAction(String(data.action || "open"), entry, entry.id)
        }
        return performAction(data)
      },
      getSearchHistory: function() { return frecencyStore.loaded ? frecencyStore.doc.searchHistory : [] }
    })

    // Names from Raycast's calculator namespace (ref 02 §2).
    Rpc.register(registry, "themes", {
      // The bundled + user themes on disk (name, dir, source) — also what
      // the Theme setting row cycles through.
      list: function() { return themes.listThemes(themeRoots) },
      resolve: function(data) {
        var r = themes.resolve(String(data && data.name || ""), themeRoots)
        return { name: r.name, source: r.source }
      }
    })

    Rpc.register(registry, "calculator", {
      calculate: function(data) { return calculate(String(data && data.query || "")) },
      historyGetAll: function() { return calculatorStore.loaded ? calculatorStore.doc.history : [] },
      historyDelete: function(data) { return calculatorAction("delete-entry", null, String(data && data.id || "")) },
      historyDeleteAll: function() { return calculatorAction("delete-all-entries", null, "") },
      refreshCurrencies: function() {
        if (!config.currencyRates) throw new Error("currencyRates is off in config.json")
        calculatorData.fetchRates()
        return null
      },
      getCurrencies: function() {
        var r = calculatorData.rates
        return {
          enabled: config.currencyRates,
          date: r ? r.date : null,
          base: r ? r.base : null,
          currencies: r ? Object.keys(r.rates).concat([r.base]).sort() : [],
          fetchedAt: calculatorData.ratesFetchedAt || null,
          zones: Object.keys(calculatorData.zones).length
        }
      }
    })

    Rpc.register(registry, "frecency", {
      visit: function(data) { recordVisit(String(data.id), String(data.query || "")); return null },
      get: function(data) {
        var entry = frecencyStore.doc.items[String(data && data.id || "")]
        return entry ? { anchor: entry.anchor, openedAt: entry.openedAt, score: Frecency.score(entry.anchor, nowMs() / 1000), searchTerms: entry.searchTerms } : null
      }
    })
  }

  // -------------------------------------------------------------- config
  var configWatcher = null
  function loadConfig() {
    var fs = require("fs")
    var before = JSON.stringify(config)
    try {
      config = Schema.withConfigDefaults(JSON.parse(fs.readFileSync(paths.configFile, "utf8")))
    } catch (e) {
      if (e && e.code !== "ENOENT") log("warning", "config", "ignoring unreadable " + paths.configFile + ": " + e)
      config = Schema.withConfigDefaults(null)
    }
    calculatorData.ratesEnabled = config.currencyRates
    // Edited on disk (by hand or by `oma-cast.ps1 install`): the renderer
    // repaints and main re-applies the hotkey and the login item — this
    // is how a config edit reaches the process that owns both. [D]
    if (before !== JSON.stringify(config)) {
      emit("settings.configChanged", { key: "*", value: null })
      if (host.configChanged) host.configChanged()
    }
  }

  // --------------------------------------------------------------- start
  api.start = function() {
    // mkdir -p for Paths.directoriesToCreate.
    var fs = require("fs")
    try {
      Paths.directoriesToCreate(paths).forEach(function(dir) { fs.mkdirSync(dir, { recursive: true }) })
    } catch (e) { log("error", "paths", "could not create data directories", { error: String(e && e.message || e) }) }
    directoriesReady = true

    registerServices()
    settingsStore.on("changed", function() { storeRevision++ })
    frecencyStore.on("changed", function() { storeRevision++ })
    calculatorStore.on("changed", function() { storeRevision++ })
    settingsStore.on("message", function(level, text, meta) { log(level, "store", text, meta) })
    frecencyStore.on("message", function(level, text, meta) { log(level, "store", text, meta) })
    calculatorStore.on("message", function(level, text, meta) { log(level, "store", text, meta) })
    calculatorData.on("message", function(level, text, meta) { log(level, "calculator", text, meta) })

    loadConfig()
    // Watch the config *directory* so the watcher survives a missing
    // config.json and picks up its first creation (FileView semantics).
    try {
      configWatcher = require("fs").watch(paths.config, { persistent: false }, function(event, name) {
        if (!name || String(name) === "config.json") loadConfig()
      })
    } catch (e) { /* config watch is best-effort */ }

    settingsStore.start()
    frecencyStore.start()
    calculatorStore.start()
    calculatorData.start()
    // The file index loads its cache synchronously and re-walks when stale;
    // either way the window rebuilds when it lands.
    if (fileIndex) {
      fileIndex.on("changed", function() { candidatesRevision++ })
      fileIndex.start()
    }
    if (processes) processes.on("changed", function() { candidatesRevision++ })

    if (apps) {
      // Log the library size on every scan: `oma-cast doctor` prints it
      // too, and together they show whether "missing apps" is a scan
      // problem or a ranking problem. [D]
      apps.on("changed", function() {
        log("info", "app", "library refreshed", { entries: apps.entries.length })
        scheduleRebuild()
      })
      apps.refresh()
    }
    rebuildCandidates()
    return api
  }

  // Window visibility hook from the QML backend's notification handler:
  // refresh zones/rates when shown, cancel a pending agent check on hide.
  api.visibility = function(visible) {
    if (visible) {
      calculatorData.refresh()
      if (apps) apps.refresh()
      if (fileIndex) fileIndex.refreshIfStale()
    } else if (agentChecking) { agentChecking = false; if (agentTimer) { clearTimeout(agentTimer); agentTimer = null } }
  }

  api.dispose = function() {
    settingsStore.dispose()
    frecencyStore.dispose()
    calculatorStore.dispose()
    if (configWatcher) { try { configWatcher.close() } catch (e) {} }
  }

  return api
}

if (typeof module !== "undefined") {
  module.exports = { createBackend: createBackend, VERSION: VERSION }
}
