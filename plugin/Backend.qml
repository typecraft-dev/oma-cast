import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "core/Rpc.js" as Rpc
import "core/Paths.js" as Paths
import "core/Log.js" as Log
import "core/Schema.js" as Schema
import "core/Ranker.js" as Ranker
import "core/FleaSearch.js" as FleaSearch
import "core/Frecency.js" as Frecency
import "core/OmarchyMenu.js" as OmarchyMenu
import "core/RootSearch.js" as RootSearch
import "core/Quicklinks.js" as Quicklinks
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
  readonly property var deps: ({ Ranker: Ranker, Frecency: Frecency, OmarchyMenu: OmarchyMenu, Quicklinks: Quicklinks })

  property var candidates: []
  property var candidatesById: ({})
  property int candidatesRevision: 0
  readonly property bool loading: menuSource.loading || agentLauncher.checking || nativeSearch.pending !== null
  // Bumped when exchange rates or zone offsets arrive, so an open
  // calculator row re-evaluates.
  readonly property int calculatorRevision: (calculatorData.rates ? 1 : 0) + calculatorData.ratesFetchedAt + calculatorData.zonesAt

  signal notification(string method, var data)


  function call(method, data) { return Rpc.call(backend.registry, method, data) }
  function callSync(method, data) { return Rpc.callSync(backend.registry, method, data) }
  function cancelSearch() { nativeSearch.cancel() }

  function searchAsync(data, callback) {
    nativeSearch.cancel()
    var query = String(data && data.query || "").trim()
    var view = data && data.view
    if (!query || (view && view.kind !== "root")) {
      callback(backend.callSync("rootSearch.search", data))
      return
    }
    nativeSearch.search(Ranker.transliterate(query.toLowerCase()), backend.searchContext().sensitivity, function(matches) {
      callback(backend.callSync("rootSearch.search", Object.assign({}, data, { fleaHits: matches })))
    })
  }

  NativeSearch {
    id: nativeSearch
    onFailed: function(message) { backend.log("warning", "search", message) }
  }
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
    if (quicklinksStore.loaded) next = next.concat(Quicklinks.list(quicklinksStore.doc).map(Quicklinks.toCandidate))
    var byId = ({})
    for (var j = 0; j < next.length; j++) byId[next[j].id] = next[j]
    var entries = FleaSearch.entries(next, Ranker.transliterate)
    nativeSearch.cancel()
    backend.candidates = next
    backend.candidatesById = byId
    nativeSearch.ids = next.map(function(c) { return c.id })
    nativeSearch.entries = entries
    backend.candidatesRevision++
  }

  Timer {
    id: rebuildTimer
    interval: 30
    onTriggered: backend.rebuildCandidates()
  }

  function searchContext() {
    return {
      commands: settingsStore.loaded ? settingsStore.doc.commands : ({}),
      frecency: frecencyStore.loaded ? frecencyStore.doc.items : ({}),
      nowMs: Date.now(),
      sensitivity: settingsStore.loaded ? settingsStore.doc.general.rootSearchSensitivity : "medium"
    }
  }

  function decorated(id) {
    var c = backend.candidatesById[id]
    return c ? RootSearch.decorate(c, backend.searchContext(), backend.deps) : null
  }

  // ------------------------------------------------------------ calculator

  // 12- or 24-hour clock from config.json clockFormat, else the Qt locale.
  readonly property bool hour12: backend.config.clockFormat === "auto"
    ? Qt.locale().timeFormat(Locale.ShortFormat).toLowerCase().indexOf("ap") >= 0
    : backend.config.clockFormat === "12h"

  function calculatorEnv() {
    return {
      nowMs: Date.now(),
      localOffset: -new Date().getTimezoneOffset(),
      hour12: backend.hour12,
      rates: backend.config.currencyRates ? calculatorData.rates : null,
      zones: calculatorData.zones,
      remToPxRate: backend.config.remToPxRate,
      workHoursPerDay: backend.config.workHoursPerDay
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

  function openMenu(item) {
    if (item.provider && !OmarchyMenu.PROVIDERS[item.provider]) {
      backend.summonPlugin("omarchy.menu", JSON.stringify({ menu: item.id }))
      return { close: true }
    }
    return { push: { kind: "menu", menuId: item.id, title: item.label } }
  }

  function launchApp(candidate) {
    if (backend.appLibrary) backend.appLibrary.launch(candidate.appId, candidate.title)
    else Util.execArgv(["uwsm-app", "--", "gtk-launch", candidate.appId + ".desktop"])
  }

  function performAction(data) {
    var id = String(data && data.id || "")
    var action = String(data && data.action || "open")
    var query = String(data && data.query || "").trim()
    var candidate = backend.decorated(id)
    if (!candidate) throw new Error("Unknown command " + id)

    if (action === "open") {
      switch (candidate.kind) {
        case "app":
          backend.recordVisit(id, query)
          appFocuser.open(candidate)
          return { close: true }
        case "omarchy-action":
          if (candidate.disabled) return { toast: { style: "failure", title: candidate.title + " is already set up" } }
          backend.recordVisit(id, query)
          backend.runShell(candidate.action)
          return { close: true }
        case "omarchy-menu":
          backend.recordVisit(id, query)
          return backend.openMenu(menuSource.tree.items[candidate.menuId])
        case "omarchy-link":
          backend.recordVisit(id, query)
          var target = menuSource.tree.items[candidate.target]
          if (!target) return { toast: { style: "failure", title: "Menu " + candidate.target + " not found" } }
          return backend.openMenu(target)
        case "builtin":
          if (candidate.run.url) {
            var values = (data && data.arguments) || {}
            var missing = RootSearch.missingArgument(candidate.arguments, values)
            if (missing >= 0) throw new Error("Type a " + candidate.arguments[missing].placeholder.toLowerCase() + " first")
            backend.recordVisit(id, query)
            Util.execArgv(["omarchy-launch-browser", RootSearch.fillArguments(candidate.run.url, values)])
            return { close: true }
          }
          backend.recordVisit(id, query)
          if (candidate.run.quicklinks) return backend.quicklinksCommand(candidate.run.quicklinks)
          if (candidate.run.push) return { push: candidate.run.push }
          if (candidate.run.summon) backend.summonPlugin(candidate.run.summon, candidate.run.payload || "{}")
          return { close: true }
        case "quicklink":
          return backend.openQuicklink(candidate.quicklinkId, (data && data.arguments) || {}, query)
        case "fallback":
          Util.execArgv(["omarchy-launch-browser", RootSearch.fallbackUrl(candidate, query)])
          return { close: true }
      }
      throw new Error("Cannot open " + id)
    }

    switch (action) {
      case "open-new":
        backend.recordVisit(id, query)
        backend.launchApp(candidate)
        return { close: true }
      case "open-in-omarchy-menu":
        backend.summonPlugin("omarchy.menu", JSON.stringify({ menu: backend.omarchyRouteFor(candidate) }))
        return { close: true }
      case "edit-quicklink":
        var editing = Quicklinks.get(quicklinksStore.doc, candidate.quicklinkId)
        return { push: backend.quicklinkForm("Edit Quicklink", editing) }
      case "copy-link":
        Util.execArgv(["wl-copy", "--", Quicklinks.get(quicklinksStore.doc, candidate.quicklinkId).link])
        return { close: true, hud: "Copied to Clipboard" }
      case "delete-quicklink":
        // The confirm alert, as for the other destructive actions [O].
        if (!(data && data.confirmed)) return { confirm: {
          title: "Delete Quicklink", destructive: true, primary: "Delete",
          message: "Delete “" + candidate.title + "”? This also removes its alias, favourite and ranking."
        } }
        var deleted = backend.callSync("quicklinks.delete", { id: candidate.quicklinkId })
        if (!deleted.ok) throw new Error(deleted.error)
        return { toast: { style: "success", title: "Quicklink deleted" } }
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
        // Undo on Ctrl+T: there is no settings window to re-enable it yet.
        return { toast: { style: "success", title: candidate.title + " disabled", actions: [
          { id: "undo", title: "Undo", done: candidate.title + " enabled",
            call: { method: "settings.updateCommandSettings", data: { commandId: id, enabled: true } } }
        ] } }
    }
    throw new Error("Unknown action " + action)
  }

  // ------------------------------------------------------------ quicklinks

  function installedApps() {
    // Every app with a desktop entry, even one hidden from search; not
    // NoDisplay handlers, which are not meant to be launched by hand.
    return Quicklinks.installedApps((DesktopEntries.applications.values || []).filter(function(e) { return !e.noDisplay }))
  }

  // Month and day names for {date}; "" is the system locale.
  function localeNames(name) {
    var locale = name ? Qt.locale(name) : Qt.locale()
    return {
      month: function(i, long) { return locale.monthName(i, long ? Locale.LongFormat : Locale.ShortFormat) },
      day: function(i, long) { return locale.dayName(i, long ? Locale.LongFormat : Locale.ShortFormat) }
    }
  }

  // The Name / Link / Open With form; `item` is null when creating.
  function quicklinkForm(title, item) {
    var value = item || {}
    return {
      kind: "quicklink-form",
      title: title,
      quicklinkId: item && item.id ? item.id : "",
      focus: 0,
      fields: [
        { key: "name", label: "Name", value: value.name || "", placeholder: "Quicklink name" },
        { key: "link", label: "Link", value: value.link || "", placeholder: "https://google.com/search?q={argument}" },
        { key: "openWith", label: "Open With", value: value.openWith || "", picker: true }
      ]
    }
  }

  function quicklinksCommand(name) {
    if (name === "create") {
      // A URL or path on the clipboard fills an untouched form when it arrives.
      if (!pasteProc.running) backend.paste(false, function(text) {
        var suggested = Quicklinks.suggestion(text)
        if (suggested) backend.emit("quicklinks.autofill", suggested)
      })
      return { push: backend.quicklinkForm("Create Quicklink", null) }
    }
    if (name === "search") return { push: { kind: "quicklinks", title: "Search Quicklinks" } }
    if (name === "import") return { push: { kind: "quicklink-import", title: "Import Quicklinks" } }
    return backend.exportQuicklinks()
  }

  function storeQuicklinks(doc) {
    // Only items: the store keeps schemaVersion and schemaHistory beside them.
    if (!quicklinksStore.update(function(stored) { stored.items = doc.items })) throw new Error("quicklinks are read-only: " + (quicklinksStore.lastError || "written by a newer build"))
    backend.rebuildCandidates()
  }

  // Arguments first (a form), then the clipboard or selection, then open.
  // values come from the launcher's argument pills, by name.
  function openQuicklink(id, values, query) {
    var item = Quicklinks.get(quicklinksStore.doc, id)
    if (!item) return { toast: { style: "failure", title: "Quicklink not found" } }
    var parsed = Quicklinks.parseLink(item.link)
    if (parsed.error) return { toast: { style: "failure", title: parsed.error } }
    var missing = parsed.arguments.some(function(a) { return !a.defaultValue && !String(values[a.name] || "").trim() })
    if (!missing) return backend.launchQuicklink(item, values, query)
    // `oma-cast run` without values: the launcher focuses the empty pill.
    return { arguments: { id: "quicklink:" + item.id, title: item.name } }
  }

  function launchQuicklink(item, values, query) {
    var parsed = Quicklinks.parseLink(item.link)
    var args = parsed.error ? parsed : Quicklinks.argumentValues(parsed, values)
    if (args.error) return { toast: { style: "failure", title: args.error } }
    var ctx = { now: Date.now(), values: args.values, clipboard: "", selection: "", uuid: Quicklinks.randomUuid(), names: backend.localeNames }
    if (!parsed.needsClipboard && !parsed.needsSelection) return backend.finishLaunch(item, ctx, query)
    if (pasteProc.running) return { toast: { style: "failure", title: "Still reading the clipboard" } }
    // Read what the link needs, then open. The launcher has closed by then,
    // so a failure becomes a notification.
    var notifyFailure = function(title, message) {
      backend.log("warning", "quicklinks", title + ": " + message)
      Quickshell.execDetached(["notify-send", "--app-name=oma-cast", title, message])
    }
    var opened = function() {
      var outcome = backend.finishLaunch(item, ctx, query)
      if (!outcome.toast) return
      notifyFailure(item.name, outcome.toast.title)
    }
    var withSelection = function() {
      if (!parsed.needsSelection) { opened(); return }
      backend.paste(true, function(text) { ctx.selection = text; opened() })
    }
    if (parsed.needsClipboard) backend.paste(false, function(text, ok) {
      if (!ok) return notifyFailure(item.name, "The clipboard has no text to put in the link")
      ctx.clipboard = text
      withSelection()
    })
    else withSelection()
    return { close: true }
  }

  // Reads the clipboard (or the primary selection) as text: done(text, ok),
  // where ok is false when it is empty, not text, or the read timed out.
  function paste(primary, done) {
    pasteProc.collected = ""
    pasteProc.done = done
    pasteProc.command = ["timeout", "2", "wl-paste"].concat(primary ? ["--primary"] : []).concat(["--no-newline", "--type", "text"])
    pasteProc.running = true
  }

  function finishLaunch(item, ctx, query) {
    var expanded = Quicklinks.expand(item.link, ctx)
    if (expanded.error) return { toast: { style: "failure", title: expanded.error } }
    var argv = Quicklinks.openArgv(expanded.url, item.openWith, backend.paths.home)
    if (!argv) return { toast: { style: "failure", title: "Cannot open " + expanded.url } }
    backend.recordVisit("quicklink:" + item.id, query)
    Util.execArgv(argv)
    return { close: true }
  }

  function exportQuicklinks() {
    var rows = Quicklinks.exportList(quicklinksStore.doc)
    if (rows.length === 0) return { toast: { style: "failure", title: "No quicklinks to export" } }
    if (exportProc.running) return { toast: { style: "failure", title: "Already exporting" } }
    exportProc.payload = JSON.stringify(rows, null, 2) + "\n"
    exportProc.count = rows.length
    exportProc.running = true
    return { toast: { style: "success", title: "Exporting…" } }
  }

  // A path the user typed, read synchronously; "" when it cannot be read.
  function readTextFile(path) {
    importFile.failed = ""
    if (importFile.path === path) importFile.reload()
    else importFile.path = path
    var text = importFile.text()
    if (importFile.failed) throw new Error("Cannot read " + path + ": " + importFile.failed)
    return text
  }

  // From a file (sync), or from the clipboard: then {pending: true} and the
  // result arrives as quicklinks.imported. Either way {ok, title, added, …}.
  function importQuicklinks(input) {
    var path = String(input || "").trim()
    if (path === "~" || path.indexOf("~/") === 0) path = backend.paths.home + path.slice(1)
    if (path && path.charAt(0) !== "/") throw new Error("Type a full path, starting with / or ~")
    if (path) return backend.importText(backend.readTextFile(path), path + " is empty")
    if (pasteProc.running) throw new Error("Still reading the clipboard")
    backend.paste(false, function(text) {
      var outcome
      try { outcome = backend.importText(text, "The clipboard is empty") }
      catch (e) { outcome = { ok: false, title: String(e.message || e) } }
      backend.emit("quicklinks.imported", outcome)
    })
    return { pending: true, ok: true, title: "Reading the clipboard…" }
  }

  function importText(text, emptyMessage) {
    if (!String(text || "").trim()) throw new Error(emptyMessage)
    var r = Quicklinks.importText(quicklinksStore.doc, text, { apps: backend.installedApps(), now: Date.now() })
    if (r.error) throw new Error(r.error)
    if (r.added > 0) backend.storeQuicklinks(r.doc)
    var parts = [r.added + " imported"]
    if (r.duplicates) parts.push(r.duplicates + " already saved")
    if (r.withoutApp) parts.push(r.withoutApp + " set to the default app")
    if (r.failed.length) parts.push("skipped " + r.failed.join(", "))
    return { ok: r.added > 0 || r.failed.length === 0, title: parts.join(" · "), added: r.added, duplicates: r.duplicates, withoutApp: r.withoutApp, failed: r.failed }
  }

  // ------------------------------------------------------------- services

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
          quicklinks: { loaded: quicklinksStore.loaded, readOnly: quicklinksStore.readOnly, error: quicklinksStore.lastError },
          // Kept for Phase 0 callers.
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
          var choices = Schema.generalChoices[key]
          if (choices && choices.indexOf(patch[key]) < 0) throw new Error("Setting " + key + " must be one of " + choices.join(", "))
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

    Rpc.register(backend.registry, "rootSearch", {
      search: function(data) {
        var query = String(data && data.query || "")
        var view = data && data.view
        var ctx = backend.searchContext()
        if (data && data.fleaHits) ctx.fleaHits = data.fleaHits
        var sections
        if (view && view.kind === "menu") sections = RootSearch.submenuSections(backend.candidates, view.menuId, query, ctx, backend.deps)
        else if (view && view.kind === "quicklinks") sections = RootSearch.quicklinkSections(backend.candidates, query, ctx, backend.deps)
        else if (view && view.kind === "calculator-history") sections = RootSearch.historySections(calculatorStore.doc.history, query, ctx.nowMs, Calculator.filterHistory)
        else {
          ctx.filter = String(data && data.filter || "all")
          if (query.trim() && ctx.filter === "all") ctx.calculation = backend.calculate(query)
          sections = RootSearch.rootSections(backend.candidates, query, ctx, backend.deps)
        }
        return sections.map(function(s) {
          return { id: s.id, title: s.title, rows: s.rows.map(function(r) { return r.candidate }) }
        })
      },
      getActions: function(data) {
        var rowId = String(data && data.id || "")
        if (rowId === RootSearch.CALCULATOR_ID) return RootSearch.actionsFor({ kind: "calculator" })
        if (rowId.indexOf("calculator-history:") === 0) return RootSearch.actionsFor({ kind: "calculator-history" })
        var candidate = backend.decorated(rowId)
        if (!candidate && (rowId === "url:open" || rowId === "url:create"))
          return RootSearch.actionsFor({ kind: rowId === "url:open" ? "url-open" : "url-create", title: rowId === "url:open" ? "Open in Browser" : "Create Quicklink" })
        if (!candidate) {
          var fallback = RootSearch.FALLBACKS.filter(function(f) { return f.id === data.id })[0]
          if (!fallback) throw new Error("Unknown command " + (data && data.id))
          return RootSearch.actionsFor({ kind: "fallback", title: fallback.title })
        }
        return RootSearch.actionsFor(candidate)
      },
      getItemInfo: function(data) {
        var rowId = String(data && data.id || "")
        var nowMs = Date.now()
        if (rowId === RootSearch.CALCULATOR_ID) {
          var calc = backend.calculate(String(data.query || ""))
          return calc ? RootSearch.aboutFor(RootSearch.calculatorCandidate(calc), nowMs) : []
        }
        if (rowId.indexOf("calculator-history:") === 0) {
          var entry = backend.historyEntry(rowId)
          return entry ? RootSearch.aboutFor(RootSearch.historyCandidate(entry, nowMs), nowMs) : []
        }
        var candidate = backend.decorated(rowId)
        if (!candidate) {
          var f = RootSearch.FALLBACKS.filter(function(x) { return x.id === rowId })[0]
          if (!f) throw new Error("Unknown command " + rowId)
          return RootSearch.aboutFor({ id: f.id, kind: "fallback", title: f.title, typeLabel: "Fallback", url: f.url }, nowMs)
        }
        return RootSearch.aboutFor(candidate, nowMs)
      },
      performAction: function(data) {
        // Destructive commands come back as a confirmation unless confirmed.
        if (!(data && data.confirmed)) {
          var confirm = RootSearch.confirmationFor(String(data && data.id || ""), String(data && data.action || "open"))
          if (confirm) return { confirm: confirm }
        }
        var fallback = RootSearch.FALLBACKS.filter(function(f) { return f.id === (data && data.id) })[0]
        if (fallback) {
          if (fallback.id === Agent.FALLBACK_ID) {
            agentLauncher.start(data.query)
            return { pending: true }
          }
          Util.execArgv(["omarchy-launch-browser", RootSearch.fallbackUrl(fallback, data.query)])
          return { close: true }
        }
        // So are the rows for a typed web address.
        var url = data && (data.id === "url:open" || data.id === "url:create") ? Quicklinks.webAddress(data.query) : ""
        if (url && data.id === "url:open") {
          var argv = Quicklinks.openArgv(url, "", backend.paths.home)
          if (!argv) return { toast: { style: "failure", title: "Cannot open " + url } }
          Util.execArgv(argv)
          return { close: true }
        }
        if (url) return { push: backend.quicklinkForm("Create Quicklink", Quicklinks.suggestion(data.query)) }
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

    Rpc.register(backend.registry, "quicklinks", {
      list: function() { return Quicklinks.list(quicklinksStore.doc) },
      get: function(data) { return Quicklinks.get(quicklinksStore.doc, String(data && data.id || "")) },
      openWithChoices: function(data) { return Quicklinks.openWithChoices(backend.installedApps(), data && data.query, data && data.current) },
      openWithLabel: function(data) { return Quicklinks.openWithLabel(backend.installedApps(), String(data && data.id || "")) },
      // {name, link, iconName?, openWith?}
      save: function(data) {
        var r = Quicklinks.save(quicklinksStore.doc, data || {}, { apps: backend.installedApps(), now: Date.now() })
        if (r.error) throw new Error(r.error)
        backend.storeQuicklinks(r.doc)
        return r.item
      },
      // {id, name, link, iconName?, openWith?}
      update: function(data) {
        var r = Quicklinks.update(quicklinksStore.doc, String(data && data.id || ""), data || {}, { apps: backend.installedApps(), now: Date.now() })
        if (r.error) throw new Error(r.error)
        backend.storeQuicklinks(r.doc)
        return r.item
      },
      // Also forgets its alias, favourite slot and ranking.
      "delete": function(data) {
        var id = String(data && data.id || "")
        var r = Quicklinks.remove(quicklinksStore.doc, id)
        if (r.error) throw new Error(r.error)
        backend.storeQuicklinks(r.doc)
        if (settingsStore.doc.commands["quicklink:" + id]) backend.updateCommand("quicklink:" + id, function() { return {} })
        frecencyStore.update(function(doc) { delete doc.items["quicklink:" + id] })
        return null
      },
      // {path?}: a JSON file, or the clipboard when empty.
      "import": function(data) { return backend.importQuicklinks(data && data.path) },
      "export": function() { return backend.exportQuicklinks() },
      // {id, values?, query?}
      open: function(data) {
        var item = Quicklinks.get(quicklinksStore.doc, String(data && data.id || ""))
        if (!item) throw new Error("Quicklink not found")
        return backend.launchQuicklink(item, (data && data.values) || {}, String(data && data.query || ""))
      }
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

  Component.onDestruction: { settingsStore.flush(); frecencyStore.flush(); calculatorStore.flush(); quicklinksStore.flush() }
  onNotification: function(method, data) {
    if (method === "window.visibilityChanged" && data && data.visible) {
      menuSource.refresh()
      calculatorData.refresh()
    }
    if (method === "window.visibilityChanged" && data && !data.visible) agentLauncher.cancel()
  }

  AppFocuser {
    id: appFocuser
    onLaunchRequested: function(candidate) { backend.launchApp(candidate) }
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

  JsonStore {
    id: quicklinksStore
    ready: backend.directoriesReady
    path: backend.paths.db + "/" + Schema.documents.quicklinks.file
    migrations: Schema.documents.quicklinks.migrations
    onMessage: function(level, text, metadata) { backend.log(level, "store", text, metadata) }
  }

  // wl-paste goes through the data-control protocol, so it works while the
  // launcher is unfocused or closed. Quickshell.clipboardText would not.
  Process {
    id: pasteProc
    property var done: null
    property string collected: ""
    stdout: SplitParser { onRead: function(line) { pasteProc.collected += line + "\n" } }
    onExited: function(exitCode) {
      var done = pasteProc.done
      pasteProc.done = null
      if (done) done(exitCode === 0 ? pasteProc.collected.replace(/\n$/, "") : "", exitCode === 0)
    }
  }

  // Export: a JSON file in Downloads (or home), also put on the clipboard.
  // The JSON goes through stdin, so no file contents reach an argv.
  Process {
    id: exportProc
    property string payload: ""
    property int count: 0
    stdinEnabled: true
    command: ["sh", "-c", "d=$(xdg-user-dir DOWNLOAD 2>/dev/null); [ -d \"$d\" ] || d=$HOME; f=\"$d/oma-cast-quicklinks-$(date +%F).json\"; cat > \"$f\" && wl-copy --type text/plain < \"$f\" && printf %s \"$f\""]
    property string path: ""
    property string errors: ""
    stdout: SplitParser { onRead: function(line) { exportProc.path = line } }
    stderr: SplitParser { onRead: function(line) { exportProc.errors = line } }
    onStarted: { exportProc.write(exportProc.payload); exportProc.stdinEnabled = false }
    onExited: function(exitCode) {
      exportProc.stdinEnabled = true
      var where = exportProc.path.replace(backend.paths.home, "~")
      backend.emit("quicklinks.exported", exitCode === 0
        ? { ok: true, title: "Exported " + exportProc.count + (exportProc.count === 1 ? " quicklink" : " quicklinks") + " to " + where + " and the clipboard" }
        : { ok: false, title: "Export failed: " + (exportProc.errors || "exit " + exitCode) })
      exportProc.path = ""
      exportProc.errors = ""
    }
  }

  FileView {
    id: importFile
    property string failed: ""
    blockAllReads: true
    printErrors: false
    onLoadFailed: function(error) { importFile.failed = FileViewError.toString(error) }
  }

  // Bumped whenever ranking inputs change, so views re-query.
  readonly property int dataRevision: candidatesRevision + (settingsStore.loaded ? 1 : 0) + (frecencyStore.loaded ? 1 : 0)
  property int storeRevision: 0
  Connections { target: settingsStore; function onChanged() { backend.storeRevision++ } }
  Connections { target: frecencyStore; function onChanged() { backend.storeRevision++ } }
  Connections { target: quicklinksStore; function onChanged() { backend.storeRevision++; rebuildTimer.restart() } }
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
