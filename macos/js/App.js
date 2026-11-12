// The macOS app's JavaScript side: wires core/*.js together the way
// Backend.qml and LauncherWindow.qml do on Omarchy, on top of a few native
// primitives from Swift (macos/Sources/omacast/JSEngine.swift). Swift only
// draws App.state() and forwards events; every decision lives in core/.
//
// native (all synchronous unless noted):
//   env(name)                          environment variable or ""
//   readFile(path) -> string|null      null when missing
//   writeFile(path, text) -> ""|error  atomic, mode 0600
//   mtime(path) -> ms|0
//   listDir(path) -> [names]           [] when missing
//   ensurePrivateDirs([dirs]) -> ""|error   mkdir -p, then chmod 0700
//   log(line)
//   copy(text), paste(text), readClipboard() -> string
//   openUrl(url) -> ""|error
//   openApp(path) / launchNew(path) -> ""|error
//   runSystem(name) -> ""|error
//   later(ms, fn) -> id, cancel(id)
//   fetch(url, fn(status, body))       asynchronous GET
//   zoneOffsets([names]) -> {name: minutes east of UTC}
//   hour12() -> bool                   from the macOS locale
//   changed()                          redraw from App.state()
//   dismiss(), show(), hud(text)
//   quit()

var VERSION = "0.1.0"

function create(native, M) {
  var paths = M.Paths.resolve(function(name) { return native.env(name) }, "darwin")
  var startedAt = Date.now()
  var config = M.Schema.withConfigDefaults(null)
  var configMtime = -1

  function log(level, category, message, metadata) {
    if (!M.Log.shouldLog(level, config.logLevel)) return
    native.log(M.Log.format(level, category, message, metadata))
  }

  // ------------------------------------------------------------- storage

  var themesDir = paths.config + "/themes"
  var setupError = native.ensurePrivateDirs([paths.config, paths.db, paths.cache, paths.logs, paths.backups, paths.runtime, themesDir])
  if (setupError) log("error", "paths", "could not create data directories: " + setupError)

  // core/Store.js does the parsing, migrating and write decisions; this
  // reads and writes the file, debounces saves, and re-reads on show when
  // the file changed on disk (SPEC: re-enable a command by editing it).
  function jsonStore(name) {
    var spec = M.Schema.documents[name]
    var path = paths.db + "/" + spec.file
    var store = M.Store.create({ path: path, migrations: spec.migrations, Migrate: M.Migrate,
      log: function(level, text, metadata) { log(level, "store", text, metadata) } })
    var lastMtime = 0, saveTimer = null

    function save(text) {
      if (text === null) return
      var error = native.writeFile(path, text)
      if (error) log("error", "store", "cannot write " + path + ": " + error)
      lastMtime = native.mtime(path)
    }
    function load() {
      var text = native.readFile(path)
      lastMtime = native.mtime(path)
      save(store.ingest(text === null ? "" : text).write)
    }

    var update = store.update
    store.update = function(mutator) {
      if (!update(mutator)) return false
      if (saveTimer) native.cancel(saveTimer)
      saveTimer = native.later(250, function() { saveTimer = null; save(store.pendingWrite()) })
      return true
    }
    store.flush = function() {
      if (!saveTimer) return
      native.cancel(saveTimer)
      saveTimer = null
      save(store.pendingWrite())
    }
    store.refresh = function() {
      var m = native.mtime(path)
      if (m && m !== lastMtime && !saveTimer) load()
    }
    load()
    return store
  }

  var stores = { settings: jsonStore("settings"), frecency: jsonStore("frecency"), calculator: jsonStore("calculator") }

  function loadConfig() {
    var m = native.mtime(paths.configFile)
    if (m === configMtime) return
    configMtime = m
    var text = native.readFile(paths.configFile)
    if (text === null) { config = M.Schema.withConfigDefaults(null); return }
    try { config = M.Schema.withConfigDefaults(JSON.parse(text)) } catch (e) {
      config = M.Schema.withConfigDefaults(null)
      log("warning", "config", "ignoring unreadable " + paths.configFile + ": " + e)
    }
  }
  loadConfig()

  // ------------------------------------------------------------- calculator data

  // core/CalculatorData.js decides when to refresh; this fetches and caches.
  var Policy = M.CalculatorData
  var ratesCache = paths.cache + "/currencies.json"
  var calculatorData = {
    rates: null, zones: {}, ratesFetchedAt: 0, ratesTriedAt: 0, zonesAt: 0, pending: false,
    fetchRates: function() {
      var self = calculatorData
      self.ratesTriedAt = Date.now()
      self.pending = true
      native.fetch(Policy.RATES_URL, function(status, body) {
        self.pending = false
        var parsed = null
        try { parsed = status === 200 ? Policy.validRates(JSON.parse(body)) : null } catch (e) { parsed = null }
        if (!parsed) { log("warning", "calculator", "could not fetch exchange rates", { status: status }); return }
        self.rates = parsed
        self.ratesFetchedAt = Date.now()
        native.writeFile(ratesCache, Policy.cacheText(parsed, self.ratesFetchedAt))
        log("info", "calculator", "exchange rates updated", { date: parsed.date, currencies: Object.keys(parsed.rates).length })
        launcher.refresh()
      })
    },
    refresh: function() {
      var self = calculatorData, now = Date.now()
      if (Policy.zonesStale(self.zonesAt, now)) {
        self.zones = native.zoneOffsets(M.Calculator.zoneList())
        self.zonesAt = now
      }
      if (Policy.shouldFetchRates({ enabled: config.currencyRates, cacheRead: true, pending: self.pending,
                                    fetchedAt: self.ratesFetchedAt, triedAt: self.ratesTriedAt }, now))
        self.fetchRates()
    }
  }

  var cachedText = native.readFile(ratesCache)
  if (cachedText !== null) {
    var cached = Policy.readCache(cachedText)
    if (cached) { calculatorData.rates = cached.rates; calculatorData.ratesFetchedAt = cached.fetchedAt }
    else log("warning", "calculator", "ignoring unreadable exchange-rate cache")
  }

  // ------------------------------------------------------------- backend

  function check(error, what) { if (error) throw new Error(what + ": " + error) }

  var apps = []

  var backend = M.Backend.create({
    version: VERSION,
    paths: paths,
    startedAt: startedAt,
    stores: stores,
    calculatorData: calculatorData,
    config: function() { return config },
    hour12: function() {
      return config.clockFormat === "auto" ? !!native.hour12() : config.clockFormat === "12h"
    },
    ready: function() { return stores.settings.loaded && stores.frecency.loaded && stores.calculator.loaded },
    log: log,
    notify: function() {},
    info: function() { return { desktop: "macos", platform: "darwin", apps: apps.length } },
    copy: function(text) { native.copy(String(text)) },
    paste: function(text) { native.paste(String(text)) },
    openUrl: function(url) { check(native.openUrl(url), "Could not open " + url) },
    openApp: function(c) { check(native.openApp(c.appPath), "Could not open " + c.title) },
    launchApp: function(c) { check(native.launchNew(c.appPath), "Could not open " + c.title) },
    runSystem: function(name) {
      if (name === "quit-omacast") { native.later(50, function() { flush(); native.quit() }); return { close: true } }
      check(native.runSystem(name), "Could not run " + name)
      return { close: true }
    },
    summonPlugin: function(id) { throw new Error("No plugin " + id + " on macOS") },
    runShell: function() { throw new Error("Shell actions are Omarchy-only") },
    menuTree: function() { return null },
    adjustActions: M.MacCommands.adjustActions,
    adjustAbout: M.MacCommands.adjustAbout,
    copyId: function(c) { return c.appId }
  }, M)

  function rebuildCandidates() {
    var list = apps.map(function(entry) { return M.MacCommands.appCandidate(M.RootSearch, entry) })
    backend.setCandidates(list.concat(M.MacCommands.commandCandidates(M.RootSearch)))
  }
  rebuildCandidates()

  // ------------------------------------------------------------- themes

  // macos/js/Themes.js: built-ins plus <config>/themes/*.json, re-read on show.
  var themeFiles = [], themeCatalog = M.Themes.catalog([])
  function loadThemes() {
    themeFiles = native.listDir(themesDir).filter(function(n) { return /\.json$/i.test(n) }).sort().map(function(name) {
      return M.Themes.parseFile(name, native.readFile(themesDir + "/" + name) || "")
    })
    themeFiles.forEach(function(f) { if (f.error) log("warning", "themes", f.error) })
    themeCatalog = M.Themes.catalog(themeFiles)
  }
  loadThemes()

  function themeId() {
    return stores.settings.loaded ? String(stores.settings.doc.general.theme || "system") : "system"
  }

  // ------------------------------------------------------------- launcher

  var visible = false

  var launcher = M.LauncherState.create({
    platform: "macos",
    backend: backend,
    filters: M.RootSearch.FILTERS,
    missingArgument: M.RootSearch.missingArgument,
    symbolFor: M.MacCommands.symbolFor,
    host: {
      dismiss: function() { native.dismiss() },
      show: function() { native.show() },
      hud: function(text) { native.hud(String(text)) },
      copy: function(text) { native.copy(String(text)) },
      readClipboard: function() { return native.readClipboard() },
      later: function(ms, fn) { return native.later(ms, fn) },
      cancel: function(id) { native.cancel(id) },
      changed: function() { native.changed() }
    }
  })

  function flush() { stores.settings.flush(); stores.frecency.flush(); stores.calculator.flush() }

  function parse(json) {
    if (json === undefined || json === null || json === "") return null
    return typeof json === "string" ? JSON.parse(json) : json
  }

  return {
    paths: paths,
    backend: backend,
    launcher: launcher,

    // Swift → JS. Arguments and results are JSON strings.
    state: function() {
      var s = launcher.state()
      s.theme = M.Themes.resolve(themeId(), themeCatalog)
      return JSON.stringify(s)
    },
    themes: function() {
      loadThemes()
      var list = [{ id: "system", name: "System (light/dark, accent colour)", builtin: true }]
      for (var id in themeCatalog) list.push({ id: id, name: themeCatalog[id].theme.name, builtin: themeCatalog[id].builtin })
      return JSON.stringify({
        current: M.Themes.SYSTEM_IDS.indexOf(themeId()) >= 0 ? "system" : themeId(),
        folder: themesDir,
        themes: list,
        errors: themeFiles.filter(function(f) { return f.error }).map(function(f) { return f.error })
      })
    },
    key: function(json) { return launcher.key(parse(json)) },
    shown: function(payloadJson) {
      visible = true
      loadConfig()
      loadThemes()
      stores.settings.refresh(); stores.frecency.refresh(); stores.calculator.refresh()
      calculatorData.refresh()
      launcher.prepare(parse(payloadJson) || {})
    },
    hidden: function() { visible = false; launcher.hidden() },
    isVisible: function() { return visible },
    hover: function(index) { launcher.hover(index) },
    click: function(index) { launcher.click(index) },
    clickPopup: function(index) { launcher.clickPopup(index) },
    clickArgument: function(index) { launcher.clickArgument(index) },
    toggleDropdown: function() { launcher.toggleDropdown() },
    dismissPopups: function() { launcher.dismissPopups() },
    confirmAlert: function() { launcher.confirmAlert() },
    cancelAlert: function() { launcher.cancelAlert() },
    back: function() { launcher.pop() },
    run: function(id) { return JSON.stringify(launcher.run(String(id))) },
    call: function(method, json) {
      var data
      try { data = parse(json) } catch (e) { return JSON.stringify({ ok: false, error: "data is not JSON: " + e }) }
      var r = backend.callSync(String(method), data)
      if (visible && r.ok && /^(settings|rootSearch|calculator|frecency)\./.test(method)) launcher.refresh()
      return JSON.stringify(r)
    },
    setApps: function(json) {
      apps = parse(json) || []
      rebuildCandidates()
      launcher.refresh()
    },
    config: function() { return JSON.stringify(config) },
    disabledCommands: function() {
      var commands = stores.settings.loaded ? stores.settings.doc.commands : {}
      var out = []
      for (var id in commands) {
        if (commands[id].enabled !== false) continue
        var c = backend.candidatesById[id]
        out.push({ id: id, title: c ? c.title : id })
      }
      return JSON.stringify(out)
    },
    general: function() { return JSON.stringify(backend.callSync("settings.getGeneralSettings", null).data || {}) },
    flush: flush,
    log: log
  }
}

if (typeof module !== "undefined") module.exports = { create: create, VERSION: VERSION }
