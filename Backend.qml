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
import "core/Calculator.js" as Calculator
import "core/Backend.js" as BackendCore
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

  readonly property double startedAt: Date.now()
  readonly property var deps: ({ Ranker: Ranker, Frecency: Frecency, OmarchyMenu: OmarchyMenu })

  property var candidates: []
  property int candidatesRevision: 0
  readonly property bool loading: menuSource.loading || nativeSearch.pending !== null
  // Bumped when exchange rates or zone offsets arrive, so an open
  // calculator row re-evaluates.
  readonly property int calculatorRevision: (calculatorData.rates ? 1 : 0) + calculatorData.ratesFetchedAt + calculatorData.zonesAt

  signal notification(string method, var data)


  // The method surface lives in core/Backend.js, shared with the macOS app.
  // This file only wires it to the shell: stores, clipboard, launching.
  readonly property var core: BackendCore.create({
    version: backend.version,
    paths: backend.paths,
    startedAt: backend.startedAt,
    stores: { settings: settingsStore, frecency: frecencyStore, calculator: calculatorStore },
    calculatorData: calculatorData,
    config: function() { return backend.config },
    hour12: function() { return backend.hour12 },
    ready: function() { return backend.ready },
    log: function(level, category, message, metadata) { backend.log(level, category, message, metadata) },
    notify: function(method, data) { backend.notification(method, data) },
    info: function() { return { desktop: backend.desktop, appLibrary: !!backend.appLibrary } },
    copy: function(text) { clipboard.copy(text) },
    // Copies, waits for our window to unmap, then pastes.
    paste: function(text) { clipboard.paste(text) },
    openUrl: function(url) { Util.execArgv(["omarchy-launch-browser", url]) },
    openApp: function(candidate) { appFocuser.open(candidate) },
    launchApp: function(candidate) { backend.launchApp(candidate) },
    runSystem: function(name) { throw new Error("Unknown system command " + name) },
    summonPlugin: function(id, payload) { backend.summonPlugin(id, payload) },
    runShell: function(command) { Util.execDetached(command) },
    menuTree: function() { return menuSource.tree }
  }, { Rpc: Rpc, Schema: Schema, Ranker: Ranker, Frecency: Frecency, RootSearch: RootSearch, Calculator: Calculator, OmarchyMenu: OmarchyMenu })

  function call(method, data) { return backend.core.call(method, data) }
  function callSync(method, data) { return backend.core.callSync(method, data) }
  function cancelSearch() { nativeSearch.cancel() }

  function searchAsync(data, callback) {
    nativeSearch.cancel()
    var query = String(data && data.query || "").trim()
    var view = data && data.view
    if (!query || (view && view.kind !== "root")) {
      callback(backend.callSync("rootSearch.search", data))
      return
    }
    nativeSearch.search(Ranker.transliterate(query.toLowerCase()), backend.core.searchContext().sensitivity, function(matches) {
      callback(backend.callSync("rootSearch.search", Object.assign({}, data, { fleaHits: matches })))
    })
  }

  NativeSearch {
    id: nativeSearch
    onFailed: function(message) { backend.log("warning", "search", message) }
  }
  function subscribe(method, callback) { return backend.core.subscribe(method, callback) }
  function emit(method, data) { backend.core.emit(method, data) }

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
    var entries = FleaSearch.entries(next, Ranker.transliterate)
    nativeSearch.cancel()
    backend.core.setCandidates(next)
    backend.candidates = next
    nativeSearch.ids = next.map(function(c) { return c.id })
    nativeSearch.entries = entries
    backend.candidatesRevision++
  }

  Timer {
    id: rebuildTimer
    interval: 30
    onTriggered: backend.rebuildCandidates()
  }

  // 12- or 24-hour clock from config.json clockFormat, else the Qt locale.
  readonly property bool hour12: backend.config.clockFormat === "auto"
    ? Qt.locale().timeFormat(Locale.ShortFormat).toLowerCase().indexOf("ap") >= 0
    : backend.config.clockFormat === "12h"

  function summonPlugin(id, payload) {
    if (backend.summon && backend.summon(id, payload)) return
    Quickshell.execDetached(["omarchy-shell", "shell", "summon", id, payload || "{}"])
  }

  function launchApp(candidate) {
    if (backend.appLibrary) backend.appLibrary.launch(candidate.appId, candidate.title)
    else Util.execArgv(["uwsm-app", "--", "gtk-launch", candidate.appId + ".desktop"])
  }

  Component.onCompleted: mkdirs.running = true

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

  Component.onDestruction: { settingsStore.flush(); frecencyStore.flush(); calculatorStore.flush() }
  onNotification: function(method, data) {
    if (method === "window.visibilityChanged" && data && data.visible) {
      menuSource.refresh()
      calculatorData.refresh()
    }
  }

  // Clipboard text goes over stdin, never argv (other users can read argv).
  function copyText(text) { clipboard.copy(text) }

  ClipboardWriter {
    id: clipboard
    onFailed: function(message) { backend.log("error", "clipboard", message, null) }
  }

  AppFocuser {
    id: appFocuser
    onLaunchRequested: function(candidate) { backend.launchApp(candidate) }
  }


  Process {
    id: mkdirs
    // Moves directories left under the old name, then creates everything
    // owner-only and repairs modes left readable by older builds.
    command: Paths.setupArgv(backend.paths, [Schema.documents.settings.file, Schema.documents.frecency.file, Schema.documents.calculator.file]
      .map(function(file) { return backend.paths.db + "/" + file }))
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
