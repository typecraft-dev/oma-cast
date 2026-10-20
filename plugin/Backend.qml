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
import "core/Quicklinks.js" as Quicklinks
import "services"

// The clone's backend, in-process (SPEC §2.0). It owns the paths, the host
// config, the persisted documents, the root-search providers and the method
// registry; the launcher UI and the IPC handler both go through call().
Item {
  id: backend

  readonly property string version: "0.1.0"
  readonly property var paths: Paths.resolve(function(name) { return Quickshell.env(name) })
  readonly property string desktop: Quickshell.env("HYPRLAND_INSTANCE_SIGNATURE") ? "hyprland" : "unknown"

  // Omarchy's shared app library (shell.appLibrary), injected by Launcher.qml.
  property var appLibrary: null
  // Asks the shell to summon a plugin in-process; injected by Launcher.qml.
  property var summon: null

  property var config: Schema.withConfigDefaults(null)
  property bool directoriesReady: false
  readonly property bool ready: directoriesReady && settingsStore.loaded && frecencyStore.loaded

  readonly property var registry: Rpc.createRegistry()
  readonly property double startedAt: Date.now()
  readonly property var deps: ({ Ranker: Ranker, Frecency: Frecency, OmarchyMenu: OmarchyMenu, Quicklinks: Quicklinks })

  // Every root-search candidate, rebuilt when a provider changes.
  property var candidates: []
  property var candidatesById: ({})
  property int candidatesRevision: 0
  readonly property bool loading: menuSource.loading

  signal notification(string method, var data)

  // ------------------------------------------------------------- dispatch

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

  // ------------------------------------------------------------ candidates

  function appEntries() {
    if (backend.appLibrary) return backend.appLibrary.sortedEntries("").map(function(row) { return row.entry })
    // Outside a menu-kind load the shell hands us no library; read entries directly.
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
    backend.candidates = next
    backend.candidatesById = byId
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

  // ------------------------------------------------------------- execution

  // The shell lets a third-party plugin summon only itself in-process, so
  // other plugins (omarchy.menu, omarchy.clipboard) go through its CLI.
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

  // The parent menu an action lives in, for "Open in Omarchy Menu".
  function omarchyRouteFor(candidate) {
    if (candidate.kind === "omarchy-action") {
      var item = menuSource.tree.items[candidate.menuId]
      return item && item.parent ? item.parent : "root"
    }
    return candidate.kind === "omarchy-link" ? candidate.target : candidate.menuId
  }

  // One action on one row. Returns what the UI should do next:
  // { close, push: {view}, toast: {style, title}, hud: "text" }.
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
          if (candidate.run.quicklinks) return backend.quicklinksCommand(candidate.run.quicklinks)
          if (candidate.run.summon) backend.summonPlugin(candidate.run.summon, candidate.run.payload || "{}")
          return { close: true }
        case "quicklink":
          return backend.openQuicklink(candidate.quicklinkId, query)
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
      case "edit-quicklink":
        var editing = Quicklinks.get(quicklinksStore.doc, candidate.quicklinkId)
        return { push: backend.quicklinkForm("Edit Quicklink", editing) }
      case "copy-link":
        Util.execArgv(["wl-copy", "--", Quicklinks.get(quicklinksStore.doc, candidate.quicklinkId).link])
        return { close: true, hud: "Copied to Clipboard" }
      case "delete-quicklink":
        return { push: { kind: "confirm-delete", quicklinkId: candidate.quicklinkId, title: "Delete " + candidate.title + "?" } }
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
  function openQuicklink(id, query) {
    var item = Quicklinks.get(quicklinksStore.doc, id)
    if (!item) return { toast: { style: "failure", title: "Quicklink not found" } }
    var parsed = Quicklinks.parseLink(item.link)
    if (parsed.error) return { toast: { style: "failure", title: parsed.error } }
    if (parsed.arguments.length === 0) return backend.launchQuicklink(item, {}, query)
    // The launcher asks for them in inline fields, then calls quicklinks.open.
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
      // Raycast's probe answers with nothing [O]; the round trip is the point.
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
      // Partial update; only known keys with a matching type are accepted.
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
      // {commandId, alias?, enabled?}; null clears a field. [O name]
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
      // {query, view?: {kind:"menu", menuId}} -> sections of plain rows.
      search: function(data) {
        var query = String(data && data.query || "")
        var view = data && data.view
        var ctx = backend.searchContext()
        var sections = view && view.kind === "menu"
          ? RootSearch.submenuSections(backend.candidates, view.menuId, query, ctx, backend.deps)
          : (view && view.kind === "quicklinks"
            ? RootSearch.quicklinkSections(backend.candidates, query, ctx, backend.deps)
            : RootSearch.rootSections(backend.candidates, query, ctx, backend.deps))
        return sections.map(function(s) {
          return { id: s.id, title: s.title, rows: s.rows.map(function(r) { return r.candidate }) }
        })
      },
      getActions: function(data) {
        var candidate = backend.decorated(String(data && data.id || ""))
        if (!candidate && (data.id === "url:open" || data.id === "url:create"))
          return RootSearch.actionsFor({ kind: data.id === "url:open" ? "url-open" : "url-create", title: data.id === "url:open" ? "Open in Browser" : "Create Quicklink" })
        if (!candidate) {
          var fallback = RootSearch.FALLBACKS.filter(function(f) { return f.id === data.id })[0]
          if (!fallback) throw new Error("Unknown command " + (data && data.id))
          return RootSearch.actionsFor({ kind: "fallback", title: fallback.title })
        }
        return RootSearch.actionsFor(candidate)
      },
      performAction: function(data) {
        // Fallbacks are rows, not stored candidates.
        var fallback = RootSearch.FALLBACKS.filter(function(f) { return f.id === (data && data.id) })[0]
        if (fallback) {
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
  Component.onDestruction: { settingsStore.flush(); frecencyStore.flush(); quicklinksStore.flush() }
  onNotification: function(method, data) {
    if (method === "window.visibilityChanged" && data && data.visible) menuSource.refresh()
  }

  // ------------------------------------------------------------ persistence

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

  // config.json is optional and hand-edited; it hot-reloads on save.
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
