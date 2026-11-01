// The Backend.qml port against a temp XDG-free layout: the full RPC
// surface with fake app entries and stubbed host adapters. Windows-only
// execution stays behind the stubs, so everything here runs under node.
const test = require("node:test")
const assert = require("node:assert")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { createBackend } = require("./backend")

function setup(overrides) {
  overrides = overrides || {}
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oma-cast-backend-"))
  const paths = {
    home: root, config: path.join(root, "config"), configFile: path.join(root, "config", "config.json"),
    scriptCommands: path.join(root, "config", "script-commands"),
    data: path.join(root, "data"), db: path.join(root, "data", "db"),
    extensions: path.join(root, "data", "extensions"), extensionSupport: path.join(root, "data", "extension-support"),
    clipboard: path.join(root, "data", "clipboard"), notesAttachments: path.join(root, "data", "notes"),
    cache: path.join(root, "cache"), state: path.join(root, "state"),
    logs: path.join(root, "state", "logs"), backups: path.join(root, "state", "backups"),
    runtime: path.join(root, "runtime")
  }
  const calls = { copy: [], opened: [], launched: [], pasted: [], commands: [] }
  const host = {
    copy: function(t) { calls.copy.push(t) },
    openExternal: function(u) { calls.opened.push(u) },
    pasteText: function(t) { calls.pasted.push(t) },
    checkCommand: function(exe, cb) { calls.commands.push(exe); cb(true) }
  }
  const apps = overrides.apps || {
    entries: [
      { id: "C:\\links\\Firefox.lnk", name: "Firefox", icon: "", keywords: [] },
      { id: "C:\\links\\Files.lnk", name: "Files", icon: "", keywords: [] }
    ],
    loading: false,
    launched: [],
    on: function() {},
    refresh: function() { return Promise.resolve(this.entries) },
    launch: function(id) { calls.launched.push(id) },
    iconSource: function() { return Promise.resolve("") }
  }
  const fileIndex = overrides.fileIndex || null
  if (overrides.config) {
    fs.mkdirSync(paths.config, { recursive: true })
    fs.writeFileSync(paths.configFile, JSON.stringify(overrides.config))
  }
  const backend = createBackend({ paths: paths, host: host, apps: apps, fileIndex: fileIndex }).start()
  return { backend, calls, paths, apps }
}

test("system.info reports the windows desktop and the method surface", () => {
  const { backend } = setup()
  const r = backend.callSync("system.info", null)
  assert.equal(r.ok, true)
  assert.equal(r.data.desktop, "windows")
  assert.equal(r.data.appLibrary, true)
  assert.equal(r.data.applications, 2, "the fixture's two Start Menu entries")
  assert.ok(r.data.methods.indexOf("rootSearch.search") >= 0)
  assert.ok(r.data.methods.indexOf("calculator.calculate") >= 0)
  backend.dispose()
})

test("root search ranks the Start Menu apps and keeps the builtins", () => {
  const { backend } = setup()
  // Query: the app ranks first in Results.
  const r = backend.callSync("rootSearch.search", { query: "fire", view: null, filter: "all" })
  assert.equal(r.ok, true)
  const results = r.data.find(function(s) { return s.id === "results" })
  assert.ok(results, "has a Results section")
  assert.equal(results.rows[0].title, "Firefox")
  assert.equal(results.rows[0].kind, "app")

  // Empty root: the quicklinks and Calculator History are commands; the
  // summon-only Omarchy builtin is dropped on Windows.
  const empty = backend.callSync("rootSearch.search", { query: "", view: null, filter: "all" })
  const commandRows = (empty.data.find(function(s) { return s.id === "commands" }) || { rows: [] }).rows
  const ids = commandRows.map(function(x) { return x.id })
  assert.ok(ids.indexOf("builtin:google-search") >= 0)
  assert.ok(ids.indexOf("builtin:duckduckgo-search") >= 0)
  assert.ok(ids.indexOf("builtin:calculator-history") >= 0)
  assert.ok(ids.indexOf("builtin:omarchy-menu") < 0)
  // Applications section lists the Start Menu entries.
  const appsSection = empty.data.find(function(s) { return s.id === "apps" })
  assert.ok(appsSection, "has an Applications section")
  assert.equal(appsSection.rows.length, 2)
  backend.dispose()
})

test("well-known Windows apps carry search aliases", () => {
  const { keywordsFor } = require("./apps")
  assert.ok(keywordsFor("File Explorer").indexOf("files") >= 0)
  assert.ok(keywordsFor("Snipping Tool").indexOf("screenshot") >= 0)
  assert.ok(keywordsFor("Notepad").indexOf("notes") >= 0)
  assert.ok(keywordsFor("Task Manager").indexOf("taskmgr") >= 0)
  assert.ok(keywordsFor("Remote Desktop Connection").indexOf("rdp") >= 0)
  assert.deepEqual(keywordsFor("Google Chrome"), [])
  assert.deepEqual(keywordsFor(""), [])
  assert.deepEqual(keywordsFor(null), [])
})

test("a single-token app search finds the app, not path-only file hits", () => {
  const { keywordsFor } = require("./apps")
  function stubApps(entries) {
    return {
      entries: entries,
      loading: false,
      on: function() {},
      refresh: function() { return Promise.resolve(this.entries) },
      launch: function() {},
      iconSource: function() { return Promise.resolve("") }
    }
  }
  const { backend } = setup({
    apps: stubApps([
      { id: "C:\\links\\File Explorer.lnk", name: "File Explorer", icon: "", keywords: keywordsFor("File Explorer") },
      { id: "C:\\links\\Notepad.lnk", name: "Notepad", icon: "", keywords: keywordsFor("Notepad") },
      { id: "C:\\links\\Snipping Tool.lnk", name: "Snipping Tool", icon: "", keywords: keywordsFor("Snipping Tool") }
    ]),
    fileIndex: {
      // data.db matches "files" by PATH only (...\\Files\\data.db): the junk
      // that used to fill the Files section instead of the app.
      entries: [
        { p: "C:\\Users\\u\\Files\\data.db", n: "data.db", d: false, m: 1 },
        { p: "C:\\Users\\u\\Documents\\notes.txt", n: "notes.txt", d: false, m: 2 },
        { p: "C:\\Users\\u\\Pictures\\screenshot-1.png", n: "screenshot-1.png", d: false, m: 3 }
      ],
      ready: true, loading: false, lastIndexedAt: Date.now(),
      start: function() {}, refreshIfStale: function() {}, setIncludeHidden: function() {},
      on: function() {}
    }
  })
  // "files": File Explorer ranks through its alias; no Files section for
  // a name query with no name hits.
  const files = backend.callSync("rootSearch.search", { query: "files", view: null, filter: "all" })
  assert.equal(files.ok, true)
  const results = files.data.find(function(s) { return s.id === "results" })
  assert.ok(results, "has a Results section")
  assert.equal(results.rows[0].title, "File Explorer")
  assert.equal(results.rows[0].kind, "app")
  assert.ok(!files.data.some(function(s) { return s.id === "files" }), "path-only data.db stays out")
  // "notes": both the app (alias) and the genuine name hit surface.
  const notes = backend.callSync("rootSearch.search", { query: "notes", view: null, filter: "all" })
  const nres = notes.data.find(function(s) { return s.id === "results" })
  assert.ok(nres.rows.some(function(r) { return r.title === "Notepad" }), "Notepad ranks")
  const nfiles = notes.data.find(function(s) { return s.id === "files" })
  assert.ok(nfiles && nfiles.rows.some(function(r) { return r.title === "notes.txt" }), "notes.txt still surfaces")
  // "screenshot": the tool ranks through its alias next to the file.
  const shot = backend.callSync("rootSearch.search", { query: "screenshot", view: null, filter: "all" })
  const sres = shot.data.find(function(s) { return s.id === "results" })
  assert.ok(sres.rows.some(function(r) { return r.title === "Snipping Tool" }), "Snipping Tool ranks")
  backend.dispose()
})

test("the Files section waits for the first app scan", () => {
  function stubApps(scanned) {
    return {
      entries: [{ id: "C:\\links\\Firefox.lnk", name: "Firefox", icon: "", keywords: [] }],
      loading: true,
      scanned: scanned,
      on: function() {},
      refresh: function() { return Promise.resolve(this.entries) },
      launch: function() {},
      iconSource: function() { return Promise.resolve("") }
    }
  }
  function stubFiles() {
    return {
      entries: [{ p: "C:/Users/u/Downloads/firefox-setup.exe", n: "firefox-setup.exe", d: false, m: 2 }],
      ready: true, loading: false, lastIndexedAt: Date.now(),
      start: function() {}, refreshIfStale: function() {}, on: function() {}
    }
  }
  // Scan still in flight: the app ranks, Files stays hidden.
  const pending = setup({ apps: stubApps(false), fileIndex: stubFiles() })
  const r = pending.backend.callSync("rootSearch.search", { query: "firefox", view: null, filter: "all" })
  const results = r.data.find(function(s) { return s.id === "results" })
  assert.ok(results && results.rows.some(function(row) { return row.title === "Firefox" }), "the app ranks while scanning")
  assert.ok(!r.data.some(function(s) { return s.id === "files" }), "no Files before the first scan")
  pending.backend.dispose()
  // Scan landed: the same query grows the Files section.
  const done = setup({ apps: stubApps(true), fileIndex: stubFiles() })
  const r2 = done.backend.callSync("rootSearch.search", { query: "firefox", view: null, filter: "all" })
  assert.ok(r2.data.some(function(s) { return s.id === "files" }), "Files surface after the scan")
  done.backend.dispose()
})

test("the Files section can come from Everything, falling back to the walk", () => {
  const esPool = [
    { p: "D:/Vault/report-q3.txt", n: "report-q3.txt", d: false, m: 9, nl: "report-q3.txt", pl: "d:/vault/report-q3.txt" }
  ]
  const esCalls = []
  let esAnswer = esPool
  let provided = null
  const { backend, paths } = setup({
    config: { fileSearchProvider: "everything" },
    fileIndex: {
      entries: [
        { p: "C:/Users/u/Documents/notes.txt", n: "notes.txt", d: false, m: 2 }
      ],
      ready: true, loading: false, lastIndexedAt: Date.now(),
      start: function() {}, refreshIfStale: function() {}, on: function() {},
      setProvider: function(v) { provided = v },
      searchEverything: function(q, limit) { esCalls.push([q, limit]); return esAnswer }
    }
  })
  // Everything mode: the live pool feeds Files, ranked by the same ranker.
  const r = backend.callSync("rootSearch.search", { query: "report-q3", view: null, filter: "all" })
  assert.equal(r.ok, true)
  assert.deepEqual(esCalls, [["report-q3", 100]])
  const files = r.data.find(function(s) { return s.id === "files" })
  assert.ok(files && files.rows.some(function(row) { return row.title === "report-q3.txt" }), "Everything hit surfaces")
  // A dead Everything answers null: the walk pool serves that query.
  esAnswer = null
  const r2 = backend.callSync("rootSearch.search", { query: "notes", view: null, filter: "all" })
  const files2 = r2.data.find(function(s) { return s.id === "files" })
  assert.ok(files2 && files2.rows.some(function(row) { return row.title === "notes.txt" }), "walk fallback serves")
  // The setting row flips the provider live: config file + setProvider.
  const a = backend.callSync("rootSearch.performAction", { id: "setting:config:fileSearchProvider", action: "open", query: "", confirmed: true })
  assert.equal(a.ok, true)
  assert.equal(a.data.toast.title, "File Search Provider: Built-in Index")
  assert.equal(provided, "built-in")
  assert.equal(JSON.parse(fs.readFileSync(paths.configFile, "utf8")).fileSearchProvider, "built-in")
  backend.dispose()
})

test("an inline calculation appears as the Calculator row and ↵ copies", () => {
  const { backend, calls } = setup()
  const r = backend.callSync("rootSearch.search", { query: "1 + 1", view: null, filter: "all" })
  assert.equal(r.ok, true)
  const calc = r.data.find(function(s) { return s.id === "calculator" })
  assert.ok(calc, "calculator section first")
  assert.equal(calc.rows[0].calcResult, "2")
  const a = backend.callSync("rootSearch.performAction", { id: "calculator:result", action: "open", query: "1 + 1", confirmed: true })
  assert.equal(a.ok, true)
  assert.equal(a.data.close, true)
  assert.equal(a.data.hud, "Copied to Clipboard")
  assert.deepEqual(calls.copy, ["2"])
  // …and it lands in Calculator History.
  const hist = backend.callSync("calculator.historyGetAll", null)
  assert.equal(hist.ok, true)
  assert.equal(hist.data.length, 1)
  assert.equal(hist.data[0].query, "1 + 1")
  backend.dispose()
})

test("opening an app records a frecency visit and launches the link", () => {
  const { backend, calls } = setup()
  const r = backend.callSync("rootSearch.performAction", { id: "app:C:\\links\\Firefox.lnk", action: "open", query: "ff", confirmed: true })
  assert.equal(r.ok, true)
  assert.equal(r.data.close, true)
  assert.deepEqual(calls.launched, ["C:\\links\\Firefox.lnk"])
  const freq = backend.callSync("frecency.get", { id: "app:C:\\links\\Firefox.lnk" })
  assert.equal(freq.ok, true)
  assert.ok(freq.data.anchor > 0)
  assert.deepEqual(freq.data.searchTerms.map(function(t) { return t.term }), ["ff"])
  // The search term was recorded in history too.
  const hist = backend.callSync("rootSearch.getSearchHistory", null)
  assert.deepEqual(hist.data, ["ff"])
  backend.dispose()
})

test("favorites, aliases and disable round-trip through settings", () => {
  const { backend } = setup()
  const id = "app:C:\\links\\Files.lnk"
  const fav = backend.callSync("rootSearch.performAction", { id: id, action: "favorite-add", query: "", confirmed: true })
  assert.equal(fav.data.toast.title, "Added to Favorites")
  const all = backend.callSync("settings.getAllCommandSettings", null)
  assert.equal(all.data[id].favoriteOrder, 0)

  const alias = backend.callSync("rootSearch.performAction", { id: id, action: "set-alias", query: "", confirmed: true })
  assert.equal(alias.data.push.kind, "alias")
  const saved = backend.callSync("settings.updateCommandSettings", { commandId: id, alias: "f" })
  assert.equal(saved.ok, true)
  assert.equal(saved.data.alias, "f")
  // Duplicate aliases are rejected (same rule as the QML backend).
  const dup = backend.callSync("settings.updateCommandSettings", { commandId: "app:C:\\links\\Firefox.lnk", alias: "f" })
  assert.equal(dup.ok, false)
  assert.match(dup.error, /already used/)

  const disabled = backend.callSync("rootSearch.performAction", { id: id, action: "disable", query: "", confirmed: true })
  assert.match(disabled.data.toast.title, /disabled/)
  assert.equal(disabled.data.toast.actions[0].id, "undo")
  // Disabled rows drop out of search…
  const gone = backend.callSync("rootSearch.search", { query: "Files", view: null, filter: "all" })
  const rows = gone.data.flatMap(function(s) { return s.rows })
  assert.equal(rows.filter(function(x) { return x.id === id }).length, 0)
  // …until the toast's Undo re-enables it.
  const undo = backend.callSync(disabled.data.toast.actions[0].call.method, disabled.data.toast.actions[0].call.data)
  assert.equal(undo.ok, true)
  const back = backend.callSync("rootSearch.search", { query: "Files", view: null, filter: "all" })
  assert.ok(back.data.flatMap(function(s) { return s.rows }).some(function(x) { return x.id === id }))
  backend.dispose()
})

test("the agent hand-off needs agentCommand and preflights the executable", () => {
  const { backend, calls } = setup()
  const failed = []
  backend.onNotification(function(m, d) { if (m === "agent.launchFailed") failed.push(d.message) })
  backend.callSync("rootSearch.performAction", { id: "fallback:agent", action: "open", query: "why is the sky blue", confirmed: true })
  assert.match(failed[0], /agentCommand/)
  assert.deepEqual(calls.commands, [])

  // Configure the template: the preflight runs, the launch is prepared.
  backend.callSync("settings.getGeneralSettings", null)
  fs.writeFileSync(backend.paths.configFile, JSON.stringify({ agentCommand: "wt.exe claude {prompt}" }))
  // config reload is watched on the config directory; give it a beat.
  return new Promise(function(resolve) {
    setTimeout(function() {
      const ready = []
      backend.onNotification(function(m, d) { if (m === "agent.launchReady") ready.push(d.argv) })
      backend.callSync("rootSearch.performAction", { id: "fallback:agent", action: "open", query: "why is the sky blue", confirmed: true })
      setTimeout(function() {
        assert.deepEqual(calls.commands, ["wt.exe"])
        assert.equal(ready.length, 1)
        assert.equal(ready[0], 'wt.exe claude "why is the sky blue"')
        backend.dispose()
        resolve()
      }, 100)
    }, 200)
  })
})

test("general settings validate like the QML backend", () => {
  const { backend } = setup()
  const bad = backend.callSync("settings.updateGeneralSettings", { windowMode: "gigantic" })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /must be one of/)
  const good = backend.callSync("settings.updateGeneralSettings", { windowMode: "compact", uiZoom: 1.2 })
  assert.equal(good.ok, true)
  assert.equal(good.data.windowMode, "compact")
  backend.dispose()
})
