import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "core/Rpc.js" as Rpc
import "core/Paths.js" as Paths
import "core/Log.js" as Log
import "core/Schema.js" as Schema
import "core/Ranker.js" as Ranker
import "core/Frecency.js" as Frecency
import "core/OmarchyMenu.js" as OmarchyMenu
import "core/RootSearch.js" as RootSearch
import "core/Agent.js" as Agent
import "core/Calculator.js" as Calculator
import "services"

Item {
  id: backend

  readonly property string version: "0.1.0"
  readonly property var paths: Paths.resolve(function(name) { return Quickshell.env(name) })
  readonly property string desktop: Quickshell.env("HYPRLAND_INSTANCE_SIGNATURE") ? "hyprland" : "unknown"

  property var appLibrary: null
  property var summon: null

  property var config: Schema.withConfigDefaults(null)
  property bool directoriesReady: false
  readonly property bool ready: directoriesReady && settingsStore.loaded && frecencyStore.loaded && calculatorStore.loaded

  readonly property var registry: Rpc.createRegistry()
  readonly property double startedAt: Date.now()
  readonly property var deps: ({ Ranker: Ranker, Frecency: Frecency, OmarchyMenu: OmarchyMenu })

  property var candidates: []
  property var candidatesById: ({})
  property int candidatesRevision: 0
  readonly property bool loading: menuSource.loading || filesService.loading || agentLauncher.checking
  readonly property var filesSettings: Schema.withFilesDefaults(settingsStore.loaded ? settingsStore.doc.files : null)
  readonly property int filesRevision: filesService.revision
  readonly property int filesStatusRevision: filesService.statusRevision
  // Bumped when exchange rates or zone offsets arrive, so an open
  // calculator row re-evaluates.
  readonly property int calculatorRevision: (calculatorData.rates ? 1 : 0) + calculatorData.ratesFetchedAt + calculatorData.zonesAt

  signal notification(string method, var data)
  signal filesHelperUnavailable()


  function call(method, data) { return Rpc.call(backend.registry, method, data) }
  function callSync(method, data) { return Rpc.callSync(backend.registry, method, data) }
  function subscribe(method, callback) { return Rpc.subscribe(backend.registry, method, callback) }

  function emit(method, data) {
    Rpc.emit(backend.registry, method, data, function(m, error) {
      backend.log("error", "rpc", "subscriber of " + m + " threw: " + error)
    })
    backend.notification(method, data)
  }

  function log(level, category, message, metadata) {
    if (!Log.shouldLog(level, backend.config.logLevel)) return
    var line = Log.format(level, category, message, metadata)
    var i = Log.levelIndex(level)
    if (i >= Log.levelIndex("error")) console.error(line)
    else if (i >= Log.levelIndex("warning")) console.warn(line)
    else if (i >= Log.levelIndex("info")) console.info(line)
    else console.log(line)
  }


  function appEntries() {
    if (backend.appLibrary) return backend.appLibrary.sortedEntries("").map(function(row) { return row.entry })
    return (DesktopEntries.applications.values || []).filter(function(e) { return !e.noDisplay })
  }

  function rebuildCandidates() {
    var next = []
    var apps = backend.appEntries()
    for (var i = 0; i < apps.length; i++) if (apps[i] && apps[i].id) next.push(RootSearch.appCandidate(apps[i]))
    next = next.concat(RootSearch.menuCandidates(menuSource.tree, menuSource.guards, menuSource.providerItems, backend.deps))
    for (var b = 0; b < RootSearch.BUILTINS.length; b++) next.push(RootSearch.builtinCandidate(RootSearch.BUILTINS[b]))
    var byId = ({})
    for (var j = 0; j < next.length; j++) byId[next[j].id] = next[j]
    backend.candidates = next
    backend.candidatesById = byId
    backend.candidatesRevision++
  }

  Timer {
    id: rebuildTimer
    interval: 30
    onTriggered: backend.rebuildCandidates()
  }

  function searchContext(query) {
    var q = String(query || "")
    var include = q.length > 0 && backend.filesSettings.enabled && backend.filesSettings.includeInRootSearch
    return {
      commands: settingsStore.loaded ? settingsStore.doc.commands : ({}),
      frecency: frecencyStore.loaded ? frecencyStore.doc.items : ({}),
      nowMs: Date.now(),
      sensitivity: settingsStore.loaded ? settingsStore.doc.general.rootSearchSensitivity : "medium",
      includeFiles: !!include,
      fileRows: include ? filesService.rootRows(q) : []
    }
  }

  function decorated(id) {
    var c = backend.candidatesById[id]
    return c ? RootSearch.decorate(c, backend.searchContext(""), backend.deps) : null
  }

  // ------------------------------------------------------------ calculator

  // 12- or 24-hour clock from the Qt locale, as the system shows it.
  readonly property bool hour12: Qt.locale().timeFormat(Locale.ShortFormat).toLowerCase().indexOf("ap") >= 0

  function calculatorEnv() {
    return {
      nowMs: Date.now(),
      localOffset: -new Date().getTimezoneOffset(),
      hour12: backend.hour12,
      rates: backend.config.currencyRates ? calculatorData.rates : null,
      zones: calculatorData.zones,
      remToPxRate: 16                    // Raycast's default remToPxRate [O]
    }
  }

  function calculate(query) {
    try {
      return Calculator.evaluate(query, backend.calculatorEnv())
    } catch (e) {
      backend.log("error", "calculator", "evaluating failed: " + e, { query: query })
      return null
    }
  }

  function saveCalculation(entry) {
    calculatorStore.update(function(doc) {
      doc.history = Calculator.pushHistory(doc.history, {
        id: String(Date.now()), query: entry.query, result: entry.result, copy: entry.copy, kind: entry.kind
      }, Date.now())
    })
    backend.emit("calculator.historyStateChanged", null)
  }

  // An action on the inline Calculator row or a Calculator History entry.
  // entry: {query, result, copy, kind}; history: whether it is saved already.
  function calculatorAction(action, entry, historyId) {
    switch (action) {
      case "open":
      case "copy-answer":
        if (!historyId) backend.saveCalculation(entry)
        Util.execArgv(["wl-copy", "--", entry.copy])
        return { close: true, hud: "Copied to Clipboard" }
      case "paste-answer":
        if (!historyId) backend.saveCalculation(entry)
        // Omarchy's own paste: copies, waits for our window to unmap, types.
        Util.execArgv(["omarchy-clipboard-paste-text", entry.copy])
        return { close: true }
      case "copy-question-answer":
        if (!historyId) backend.saveCalculation(entry)
        Util.execArgv(["wl-copy", "--", entry.query + " = " + entry.result])
        return { close: true, hud: "Copied to Clipboard" }
      case "open-history":
        return { push: { kind: "calculator-history", title: "Calculator History" } }
      case "delete-entry":
        calculatorStore.update(function(doc) { doc.history = doc.history.filter(function(h) { return h.id !== historyId }) })
        backend.emit("calculator.historyStateChanged", null)
        return { toast: { style: "success", title: "Entry deleted" } }
      case "delete-all-entries":
        calculatorStore.update(function(doc) { doc.history = [] })
        backend.emit("calculator.historyStateChanged", null)
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

  // ------------------------------------------------------------- execution

  function summonPlugin(id, payload) {
    if (backend.summon && backend.summon(id, payload)) return
    Quickshell.execDetached(["omarchy-shell", "shell", "summon", id, payload || "{}"])
  }

  function runShell(command) {
    var summon = OmarchyMenu.summonAction(command)
    if (summon) backend.summonPlugin(summon.id, summon.payload)
    else Util.execDetached(command)
  }

  function recordVisit(id, query) {
    if (!frecencyStore.loaded) return
    frecencyStore.update(function(doc) {
      doc.items[id] = Frecency.recordVisit(doc.items[id] || null, Date.now(), query || "")
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
    backend.emit("settings.commandSettingsChanged", { commandId: id })
  }

  function omarchyRouteFor(candidate) {
    if (candidate.kind === "omarchy-action") {
      var item = menuSource.tree.items[candidate.menuId]
      return item && item.parent ? item.parent : "root"
    }
    return candidate.kind === "omarchy-link" ? candidate.target : candidate.menuId
  }

  // One action on one file row. Files never touch frecency.json or the
  // command catalog; FFF's LMDB records the open.
  function performFileAction(file, action) {
    switch (action) {
      case "open":
        Util.execArgv(["xdg-open", file.path])
        filesService.track(file.path)
        return { close: true }
      case "open-in-editor":
        Util.execArgv(["omarchy-launch-editor", file.path])
        filesService.track(file.path)
        return { close: true }
      case "reveal":
        Util.execArgv(["uwsm-app", "--", "nautilus", "--select", file.path])
        return { close: true }
      case "copy-path":
        Util.execArgv(["wl-copy", "--", file.path])
        return { close: true, hud: "Copied to Clipboard" }
      case "copy-name":
        Util.execArgv(["wl-copy", "--", file.fileName])
        return { close: true, hud: "Copied to Clipboard" }
    }
    throw new Error("Unknown file action " + action)
  }

  // One action on one row. Returns what the UI should do next:
  // { close, push: {view}, toast: {style, title}, hud: "text" }.
  function performAction(data) {
    var id = String(data && data.id || "")
    var action = String(data && data.action || "open")
    var query = String(data && data.query || "").trim()

    if (id === "files:more") return { push: { kind: "files", title: "Files", query: query } }
    if (id.indexOf("file:") === 0) {
      var file = filesService.rowFor(id)
      if (!file) throw new Error("Unknown file " + id)
      return backend.performFileAction(file, action)
    }

    var candidate = backend.decorated(id)
    if (!candidate) throw new Error("Unknown command " + id)

    if (action === "open") {
      switch (candidate.kind) {
        case "app":
          backend.recordVisit(id, query)
          if (backend.appLibrary) backend.appLibrary.launch(candidate.appId, candidate.title)
          else Util.execArgv(["uwsm-app", "--", "gtk-launch", candidate.appId + ".desktop"])
          return { close: true }
        case "omarchy-action":
          if (candidate.disabled) return { toast: { style: "failure", title: candidate.title + " is already set up" } }
          backend.recordVisit(id, query)
          backend.runShell(candidate.action)
          return { close: true }
        case "omarchy-menu":
          backend.recordVisit(id, query)
          return { push: { kind: "menu", menuId: candidate.menuId, title: candidate.title } }
        case "omarchy-link":
          backend.recordVisit(id, query)
          var target = menuSource.tree.items[candidate.target]
          if (!target) return { toast: { style: "failure", title: "Menu " + candidate.target + " not found" } }
          return { push: { kind: "menu", menuId: target.id, title: target.label } }
        case "builtin":
          backend.recordVisit(id, query)
          if (candidate.run.push) return { push: candidate.run.push }
          if (candidate.run.summon) backend.summonPlugin(candidate.run.summon, candidate.run.payload || "{}")
          return { close: true }
        case "fallback":
          Util.execArgv(["omarchy-launch-browser", RootSearch.fallbackUrl(candidate, query)])
          return { close: true }
      }
      throw new Error("Cannot open " + id)
    }

    switch (action) {
      case "open-in-omarchy-menu":
        backend.summonPlugin("omarchy.menu", JSON.stringify({ menu: backend.omarchyRouteFor(candidate) }))
        return { close: true }
      case "copy-command":
      case "copy-id":
        Util.execArgv(["wl-copy", "--", action === "copy-id" ? candidate.appId + ".desktop" : candidate.action])
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
        backend.updateCommand(id, function(s) { delete s.alias; return s })
        return { toast: { style: "success", title: "Alias removed" } }
      case "reset-ranking":
        frecencyStore.update(function(doc) { delete doc.items[id] })
        return { toast: { style: "success", title: "Ranking reset" } }
      case "disable":
        backend.updateCommand(id, function(s) { s.enabled = false; return s })
        return { toast: { style: "success", title: candidate.title + " disabled" } }
    }
    throw new Error("Unknown action " + action)
  }


  function filesStatus() {
    var settings = Schema.withFilesDefaults(settingsStore.loaded ? settingsStore.doc.files : null)
    var snapshot = filesService.statusSnapshot()
    if (!settings.enabled) snapshot.state = "disabled"
    snapshot.enabled = settings.enabled
    snapshot.root = settings.root
    return snapshot
  }

  function filesRequest(query) {
    filesService.request(query)
  }

  function updateFilesSettings(data) {
    if (!settingsStore.loaded) throw new Error("settings not loaded")
    if (settingsStore.readOnly) throw new Error("settings are read-only: " + (settingsStore.lastError || "written by a newer build"))
    var patch = data && typeof data === "object" ? data : {}
    var allowed = { enabled: "boolean", root: "string", includeInRootSearch: "boolean", followSymlinks: "boolean" }
    for (var key in patch) {
      if (allowed[key] === undefined) throw new Error("Unknown file setting " + key)
      if (typeof patch[key] !== allowed[key]) throw new Error("Setting " + key + " must be a " + allowed[key])
    }
    if (patch.root !== undefined) {
      patch.root = String(patch.root).trim()
      if (!patch.root) throw new Error("The file root cannot be empty")
      if (patch.root !== "~" && patch.root.charAt(0) !== "/") throw new Error("The file root must be ~ or an absolute path")
    }
    var before = Schema.withFilesDefaults(settingsStore.doc.files)
    var next = Schema.withFilesDefaults(Object.assign({}, settingsStore.doc.files || {}, patch))
    settingsStore.update(function(doc) { doc.files = next })
    backend.emit("settings.filesSettingsChanged", next)
    if (next.enabled !== before.enabled && !next.enabled) filesService.stop()
    if (next.root !== before.root) filesService.reindex(next.root)
    return next
  }

  function registerServices() {
    Rpc.register(backend.registry, "system", {
      healthPing: function() { return null },
      healthDatabase: function() {
        var t0 = Date.now()
        JSON.stringify(settingsStore.doc)
        JSON.stringify(frecencyStore.doc)
        return {
          workMs: Date.now() - t0,
          settings: { loaded: settingsStore.loaded, readOnly: settingsStore.readOnly, error: settingsStore.lastError },
          frecency: { loaded: frecencyStore.loaded, readOnly: frecencyStore.readOnly, error: frecencyStore.lastError },
          loaded: settingsStore.loaded, readOnly: settingsStore.readOnly, error: settingsStore.lastError
        }
      },
      info: function() {
        return {
          version: backend.version,
          desktop: backend.desktop,
          ready: backend.ready,
          uptimeMs: Date.now() - backend.startedAt,
          candidates: backend.candidates.length,
          appLibrary: !!backend.appLibrary,
          methods: Rpc.methods(backend.registry)
        }
      },
      getPaths: function() { return backend.paths }
    })

    Rpc.register(backend.registry, "settings", {
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
        }
        settingsStore.update(function(doc) { for (var k in patch) doc.general[k] = patch[k] })
        backend.emit("settings.generalSettingsChanged", settingsStore.doc.general)
        return settingsStore.doc.general
      },
      getAllCommandSettings: function() { return settingsStore.doc.commands },
      getCommandSettings: function(data) { return settingsStore.doc.commands[String(data && data.commandId || "")] || {} },
      updateCommandSettings: function(data) {
        var id = String(data && data.commandId || "")
        if (!backend.candidatesById[id]) throw new Error("Unknown command " + id)
        if (data.alias !== undefined && data.alias !== null) {
          var alias = String(data.alias).trim().toLowerCase()
          if (/\s/.test(alias)) throw new Error("An alias cannot contain spaces")
          var commands = settingsStore.doc.commands
          for (var other in commands) {
            if (other !== id && commands[other].alias === alias && alias) throw new Error("Alias “" + alias + "” is already used by " + ((backend.candidatesById[other] || {}).title || other))
          }
        }
        backend.updateCommand(id, function(s) {
          if (data.alias !== undefined) { if (data.alias) s.alias = String(data.alias).trim().toLowerCase(); else delete s.alias }
          if (data.enabled !== undefined) { if (data.enabled === false) s.enabled = false; else delete s.enabled }
          return s
        })
        return settingsStore.doc.commands[id] || {}
      }
    })

    Rpc.register(backend.registry, "files", {
      status: function() { return backend.filesStatus() },
      updateSettings: function(data) { return backend.updateFilesSettings(data) },
      reindex: function() {
        filesService.reindex(backend.filesSettings.root)
        return backend.filesStatus()
      },
      resetRanking: function() {
        filesService.resetRanking()
        return backend.filesStatus()
      },
      retry: function() {
        filesService.retry()
        return backend.filesStatus()
      }
    })

    Rpc.register(backend.registry, "rootSearch", {
      search: function(data) {
        var query = String(data && data.query || "")
        var view = data && data.view
        var ctx = backend.searchContext(query)
        var sections
        if (view && view.kind === "menu")
          sections = RootSearch.submenuSections(backend.candidates, view.menuId, query, ctx, backend.deps)
        else if (view && view.kind === "files")
          sections = RootSearch.filesSections(filesService.cachedRows(query), query)
        else if (view && view.kind === "calculator-history")
          sections = RootSearch.historySections(calculatorStore.doc.history, query, ctx.nowMs, Calculator.filterHistory)
        else {
          if (query.trim()) ctx.calculation = backend.calculate(query)
          sections = RootSearch.rootSections(backend.candidates, query, ctx, backend.deps)
        }
        return sections.map(function(s) {
          return { id: s.id, title: s.title, rows: s.rows.map(function(r) { return r.candidate }) }
        })
      },
      getActions: function(data) {
        var id = String(data && data.id || "")
        if (id === "files:more") return RootSearch.actionsFor({ kind: "files-more" })
        if (id.indexOf("file:") === 0) {
          var file = filesService.rowFor(id)
          if (!file) throw new Error("Unknown file " + id)
          return RootSearch.actionsFor(file)
        }
        if (id === RootSearch.CALCULATOR_ID) return RootSearch.actionsFor({ kind: "calculator" })
        if (id.indexOf("calculator-history:") === 0) return RootSearch.actionsFor({ kind: "calculator-history" })
        var candidate = backend.decorated(id)
        if (!candidate) {
          var fallback = RootSearch.FALLBACKS.filter(function(f) { return f.id === id })[0]
          if (!fallback) throw new Error("Unknown command " + id)
          return RootSearch.actionsFor({ kind: "fallback", title: fallback.title })
        }
        return RootSearch.actionsFor(candidate)
      },
      performAction: function(data) {
        var fallback = RootSearch.FALLBACKS.filter(function(f) { return f.id === (data && data.id) })[0]
        if (fallback) {
          if (fallback.id === Agent.FALLBACK_ID) {
            agentLauncher.start(data.query)
            return { pending: true }
          }
          Util.execArgv(["omarchy-launch-browser", RootSearch.fallbackUrl(fallback, data.query)])
          return { close: true }
        }
        // The calculator row is the query itself, evaluated again.
        if (data && data.id === RootSearch.CALCULATOR_ID) {
          var calc = backend.calculate(String(data.query || ""))
          if (!calc) throw new Error("Nothing to calculate")
          return backend.calculatorAction(String(data.action || "open"), { query: calc.input, result: calc.result, copy: calc.copy, kind: calc.kind }, "")
        }
        if (data && String(data.id).indexOf("calculator-history:") === 0) {
          var entry = backend.historyEntry(data.id)
          if (!entry) throw new Error("No such history entry")
          return backend.calculatorAction(String(data.action || "open"), entry, entry.id)
        }
        return backend.performAction(data)
      },
      getSearchHistory: function() { return frecencyStore.loaded ? frecencyStore.doc.searchHistory : [] }
    })

    // Names from Raycast's calculator namespace (ref 02 §2).
    Rpc.register(backend.registry, "calculator", {
      calculate: function(data) { return backend.calculate(String(data && data.query || "")) },
      historyGetAll: function() { return calculatorStore.loaded ? calculatorStore.doc.history : [] },
      historyDelete: function(data) { return backend.calculatorAction("delete-entry", null, String(data && data.id || "")) },
      historyDeleteAll: function() { return backend.calculatorAction("delete-all-entries", null, "") },
      refreshCurrencies: function() {
        if (!backend.config.currencyRates) throw new Error("currencyRates is off in config.json")
        calculatorData.fetchRates()
        return null
      },
      getCurrencies: function() {
        var r = calculatorData.rates
        return {
          enabled: backend.config.currencyRates,
          date: r ? r.date : null,
          base: r ? r.base : null,
          currencies: r ? Object.keys(r.rates).concat([r.base]).sort() : [],
          fetchedAt: calculatorData.ratesFetchedAt || null,
          zones: Object.keys(calculatorData.zones).length
        }
      }
    })

    Rpc.register(backend.registry, "frecency", {
      visit: function(data) { backend.recordVisit(String(data.id), String(data.query || "")); return null },
      get: function(data) {
        var entry = frecencyStore.doc.items[String(data && data.id || "")]
        return entry ? { anchor: entry.anchor, openedAt: entry.openedAt, score: Frecency.score(entry.anchor, Date.now() / 1000), searchTerms: entry.searchTerms } : null
      }
    })
  }

  Component.onCompleted: {
    registerServices()
    mkdirs.running = true
  }

  onAppLibraryChanged: rebuildTimer.restart()

  Connections {
    target: backend.appLibrary
    ignoreUnknownSignals: true
    function onAppsChanged() { rebuildTimer.restart() }
  }

  Connections {
    target: backend.appLibrary ? null : DesktopEntries.applications
    ignoreUnknownSignals: true
    function onValuesChanged() { rebuildTimer.restart() }
  }

  // Guards and providers describe live system state: refresh them each open.
  Component.onDestruction: { filesService.stop(); settingsStore.flush(); frecencyStore.flush(); calculatorStore.flush() }
  onNotification: function(method, data) {
    if (method === "window.visibilityChanged" && data && data.visible) {
      menuSource.refresh()
      calculatorData.refresh()
    }
    if (method === "window.visibilityChanged" && data && !data.visible) agentLauncher.cancel()
  }

  AgentLauncher {
    id: agentLauncher
    onPrepared: function(argv) { backend.emit("agent.launchReady", { argv: argv }) }
    onFailed: function(message) { backend.emit("agent.launchFailed", { message: message }) }
  }


  Process {
    id: mkdirs
    command: ["mkdir", "-p"].concat(Paths.directoriesToCreate(backend.paths))
    onExited: function(exitCode) {
      if (exitCode !== 0) backend.log("error", "paths", "could not create data directories", { exitCode: exitCode })
      backend.directoriesReady = true
    }
  }

  OmarchyMenuSource {
    id: menuSource
    onRevisionChanged: rebuildTimer.restart()
    onMessage: function(level, text, metadata) { backend.log(level, "omarchy-menu", text, metadata) }
  }

  Files {
    id: filesService
    enabled: backend.filesSettings.enabled
    root: backend.filesSettings.root
    home: backend.paths.home
    helperCandidates: backend.paths.helperCandidates
    frecencyDb: backend.paths.fffDb + "/frecency"
    runtimeDir: backend.paths.runtime
    followSymlinks: backend.filesSettings.followSymlinks
    onMessage: function(level, text, metadata) { backend.log(level, "files", text, metadata) }
    onHelperUnavailable: backend.filesHelperUnavailable()
  }

  JsonStore {
    id: settingsStore
    ready: backend.directoriesReady
    path: backend.paths.db + "/" + Schema.documents.settings.file
    migrations: Schema.documents.settings.migrations
    onMessage: function(level, text, metadata) { backend.log(level, "store", text, metadata) }
  }

  JsonStore {
    id: frecencyStore
    ready: backend.directoriesReady
    path: backend.paths.db + "/" + Schema.documents.frecency.file
    migrations: Schema.documents.frecency.migrations
    onMessage: function(level, text, metadata) { backend.log(level, "store", text, metadata) }
  }

  JsonStore {
    id: calculatorStore
    ready: backend.directoriesReady
    path: backend.paths.db + "/" + Schema.documents.calculator.file
    migrations: Schema.documents.calculator.migrations
    onMessage: function(level, text, metadata) { backend.log(level, "store", text, metadata) }
  }

  CalculatorData {
    id: calculatorData
    cacheDir: backend.directoriesReady ? backend.paths.cache : ""
    ratesEnabled: backend.config.currencyRates
    onMessage: function(level, text, metadata) { backend.log(level, "calculator", text, metadata) }
  }

  readonly property int dataRevision: candidatesRevision + (settingsStore.loaded ? 1 : 0) + (frecencyStore.loaded ? 1 : 0)
  property int storeRevision: 0
  Connections { target: settingsStore; function onChanged() { backend.storeRevision++ } }
  Connections { target: frecencyStore; function onChanged() { backend.storeRevision++ } }
  Connections { target: calculatorStore; function onChanged() { backend.storeRevision++ } }

  FileView {
    path: backend.directoriesReady ? backend.paths.configFile : ""
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try {
        backend.config = Schema.withConfigDefaults(JSON.parse(text()))
      } catch (e) {
        backend.config = Schema.withConfigDefaults(null)
        backend.log("warning", "config", "ignoring unreadable " + path + ": " + e)
      }
    }
    onLoadFailed: backend.config = Schema.withConfigDefaults(null)
  }
}
