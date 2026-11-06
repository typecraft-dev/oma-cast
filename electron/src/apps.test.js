// Apps library: the cold-start cache, the hardened scan parse, and the
// empty-scan guard. From a cold start the library used to begin empty and
// wait on an async PowerShell pass (seconds on a cold boot), so the first
// shows searched commands/files/fallbacks but zero apps.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { createApps, APPS_CACHE_VERSION } = require("./apps")

function scanJson(rows) {
  return JSON.stringify(rows.map(function(r) {
    return r.appid
      ? { name: r.name, link: "", target: "", appid: r.appid }
      : { name: r.name, link: r.link, target: r.target || "" }
  }))
}
const NOTION = { name: "Notion", link: "C:\\links\\Notion.lnk", target: "C:\\Apps\\Notion\\Notion.exe" }
const STORE = { name: "Notion Store", appid: "Notion_abc!App" }

function execOk(stdout) {
  return function(bin, args, opts, cb) { cb(null, stdout) }
}

test("a scan populates entries and persists the cache", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oma-apps-"))
  const cachePath = path.join(dir, "apps.json")
  const apps = createApps({ cachePath: cachePath, execFile: execOk(scanJson([NOTION, STORE])) })
  assert.equal(apps.entries.length, 0)
  assert.equal(apps.scanned, false)
  await apps.refresh()
  assert.equal(apps.entries.length, 2)
  assert.equal(apps.scanned, true)
  assert.ok(fs.existsSync(cachePath), "cache written")
  const doc = JSON.parse(fs.readFileSync(cachePath, "utf8"))
  assert.equal(doc.v, APPS_CACHE_VERSION)
  assert.equal(doc.entries.length, 2)
  assert.deepEqual(Object.keys(doc.entries[0]).sort(), ["id", "link", "name", "target"])
})

test("the cache preloads, so a cold start paints apps before any scan", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oma-apps-"))
  const cachePath = path.join(dir, "apps.json")
  const first = createApps({ cachePath: cachePath, execFile: execOk(scanJson([NOTION])) })
  await first.refresh()
  assert.equal(first.entries.length, 1)

  // Second launch: PowerShell has not answered yet, but the library is
  // already populated from disk.
  let scanned = false
  const second = createApps({
    cachePath: cachePath,
    execFile: function(bin, args, opts, cb) { scanned = true; /* never answers: cold PowerShell */ }
  })
  assert.equal(second.entries.length, 1, "cached Notion is present at birth")
  assert.equal(second.scanned, true, "the Files latch opens at once")
  assert.equal(second.entries[0].keywords.length, 0)
  assert.equal(scanned, false, "no scan has run")
})

test("a BOM or blank output no longer empties the library", async () => {
  const apps = createApps({ execFile: execOk("﻿" + scanJson([NOTION]) + "\r\n") })
  await apps.refresh()
  assert.equal(apps.entries.length, 1)
  assert.equal(apps.entries[0].name, "Notion")

  const blank = createApps({ execFile: execOk("\r\n") })
  await blank.refresh()
  assert.equal(blank.entries.length, 0)
  assert.equal(blank.scanned, true)
})

test("a single-object payload wraps to an array", async () => {
  const apps = createApps({ execFile: execOk(JSON.stringify({ name: "Solo", link: "C:\\s.lnk", target: "" })) })
  await apps.refresh()
  assert.equal(apps.entries.length, 1)
})

test("an empty scan keeps the previous entries and the good cache", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oma-apps-"))
  const cachePath = path.join(dir, "apps.json")
  const warnings = []
  const apps = createApps({
    cachePath: cachePath,
    execFile: execOk(scanJson([NOTION])),
    log: function(level, message) { warnings.push([level, message]) }
  })
  await apps.refresh()
  assert.equal(apps.entries.length, 1)
  const cached = fs.readFileSync(cachePath, "utf8")

  // Transient failure: PowerShell answers nothing this time.
  const failing = createApps({
    cachePath: cachePath,
    execFile: execOk(""),
    log: function(level, message) { warnings.push([level, message]) }
  })
  // Seed the failing instance with the good entries, as a live backend
  // would hold after the earlier successful scan.
  failing.entries = apps.entries.slice()
  let emitted = 0
  failing.on("changed", function() { emitted++ })
  await failing.refresh(true)
  assert.equal(failing.entries.length, 1, "previous entries survive the empty scan")
  assert.equal(fs.readFileSync(cachePath, "utf8"), cached, "the good cache is not overwritten")
  assert.ok(warnings.some(function(w) { return w[0] === "warning" && /0 rows/.test(w[1]) }))
  assert.equal(emitted, 0, "no change emitted when nothing changed")
})

test("backend: a cached app ranks on the very first search, before any scan", () => {
  const { createBackend } = require("./backend")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oma-apps-be-"))
  const cachePath = path.join(dir, "apps.json")
  fs.writeFileSync(cachePath, JSON.stringify({
    v: APPS_CACHE_VERSION, at: Date.now(),
    entries: [{ id: "C:\\links\\Notion.lnk", name: "Notion", target: "C:\\Apps\\Notion.exe", link: "C:\\links\\Notion.lnk" }]
  }))
  const paths = {
    home: dir, config: dir, configFile: path.join(dir, "config.json"),
    scriptCommands: dir, data: dir, db: dir, extensions: dir, extensionSupport: dir,
    clipboard: dir, notesAttachments: dir, cache: dir, state: dir, logs: dir, backups: dir, runtime: dir
  }
  let scans = 0
  const apps = createApps({
    cachePath: cachePath,
    execFile: function(bin, args, opts, cb) { scans++; /* PowerShell still cold */ }
  })
  assert.equal(apps.entries.length, 1, "cache preloaded in the factory")
  const backend = createBackend({ paths: paths, host: {}, apps: apps }).start()
  const r = backend.callSync("rootSearch.search", { query: "notion", view: null, filter: "all" })
  assert.equal(r.ok, true)
  const results = r.data.find(function(s) { return s.id === "results" })
  assert.ok(results && results.rows.some(function(x) { return x.title === "Notion" }), "Notion ranks with no scan")
  backend.dispose()
})
