// Windows path layout and the JsonStore port: migrations on first load,
// debounced atomic writes, read-only on unreadable JSON.
const test = require("node:test")
const assert = require("node:assert")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const Paths = require("../../plugin/core/Paths.js")
const Schema = require("../../plugin/core/Schema.js")
const { createStore } = require("./json-store")

test("resolveWindows maps the same keys to Roaming/Local folders", () => {
  const env = {
    USERPROFILE: "C:\\Users\\test",
    APPDATA: "C:\\Users\\test\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local"
  }
  const p = Paths.resolveWindows(function(name) { return env[name] })
  assert.equal(p.config, "C:\\Users\\test\\AppData\\Roaming\\oma-cast")
  assert.equal(p.configFile, "C:\\Users\\test\\AppData\\Roaming\\oma-cast\\config.json")
  assert.equal(p.db, "C:\\Users\\test\\AppData\\Local\\oma-cast\\db")
  assert.equal(p.cache, "C:\\Users\\test\\AppData\\Local\\Temp\\oma-cast")
  assert.equal(p.state, "C:\\Users\\test\\AppData\\Local\\State\\oma-cast")
  assert.equal(p.logs, "C:\\Users\\test\\AppData\\Local\\State\\oma-cast\\logs")
  // Every XDG key survives so callers never branch on platform.
  const linux = Paths.resolve(function(name) {
    return { HOME: "/home/u", XDG_CONFIG_HOME: "/home/u/.config", XDG_DATA_HOME: "/home/u/.local/share", XDG_CACHE_HOME: "/home/u/.cache", XDG_STATE_HOME: "/home/u/.local/state", XDG_RUNTIME_DIR: "/run/u", UID: "1000" }[name]
  })
  assert.deepEqual(Object.keys(p).sort(), Object.keys(linux).sort())
})

test("createStore migrates a missing file to a fresh document and writes it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oma-cast-store-"))
  const file = path.join(dir, "settings.json")
  const store = createStore({ path: file, migrations: Schema.documents.settings.migrations })
  const messages = []
  store.on("message", function(level, text) { messages.push(level + ":" + text) })
  store.start()
  assert.equal(store.loaded, true)
  assert.equal(store.readOnly, false)
  assert.equal(store.doc.schemaVersion, 2)
  assert.equal(store.doc.general.windowMode, "expanded")
  assert.equal(store.doc.general.quickCaptureMode, "daily")
  assert.equal(store.doc.general.quickCaptureDir, "")
  assert.deepEqual(store.doc.commands, {})
  // Migration changed the document → written immediately.
  await new Promise(function(r) { setTimeout(r, 50) })
  assert.ok(fs.existsSync(file))
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion, 2)

  // update() persists after the 250 ms debounce.
  let changed = 0
  store.on("changed", function() { changed++ })
  store.update(function(doc) { doc.general.uiZoom = 1.2 })
  assert.equal(changed, 1)
  // The migrated write on disk still has the default zoom until the
  // debounce fires.
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).general.uiZoom, 1)
  await new Promise(function(r) { setTimeout(r, 350) })
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).general.uiZoom, 1.2)
  store.dispose()
})

test("createStore marks unreadable documents read-only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oma-cast-store-"))
  const file = path.join(dir, "frecency.json")
  fs.writeFileSync(file, "{ not json")
  const store = createStore({ path: file, migrations: Schema.documents.frecency.migrations })
  store.start()
  assert.equal(store.loaded, false)
  assert.equal(store.readOnly, true)
  assert.match(store.lastError, /unreadable/)
  assert.equal(store.update(function() {}), false)
  store.dispose()
})

test("a document from a newer build is left untouched", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oma-cast-store-"))
  const file = path.join(dir, "calculator.json")
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, history: [] }))
  const store = createStore({ path: file, migrations: Schema.documents.calculator.migrations })
  store.start()
  assert.equal(store.loaded, true)
  assert.equal(store.readOnly, true)
  assert.equal(store.doc.schemaVersion, 99)
  const before = fs.readFileSync(file, "utf8")
  store.update(function(doc) { doc.history.push({}) })
  assert.equal(fs.readFileSync(file, "utf8"), before)
  store.dispose()
})
