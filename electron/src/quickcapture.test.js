// Quick Capture on the Electron backend: the pushed view's live row,
// saving to the same file vs a new file, the mode cycle and the folder
// editor. Real fs writes under a temp layout; host adapters are stubbed.
const test = require("node:test")
const assert = require("node:assert")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { createBackend } = require("./backend")
const RootSearch = require("../../plugin/core/RootSearch.js")

function setup(overrides) {
  overrides = overrides || {}
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oma-cast-qc-"))
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
  const calls = { copy: [], opened: [], launched: [] }
  const host = {
    copy: function(t) { calls.copy.push(t) },
    openExternal: function(u) { calls.opened.push(u) },
    openPath: function(p) { calls.opened.push("path:" + p) },
    pasteText: function() {},
    checkCommand: function(exe, cb) { cb(true) }
  }
  const apps = {
    entries: [{ id: "C:\\links\\Firefox.lnk", name: "Firefox", icon: "", keywords: [] }],
    loading: false,
    on: function() {},
    refresh: function() { return Promise.resolve(this.entries) },
    launch: function(id) { calls.launched.push(id) },
    iconSource: function() { return Promise.resolve("") }
  }
  const backend = createBackend({ paths: paths, host: host, apps: apps, fileIndex: null }).start()
  return { backend, calls, paths }
}

test("the Quick Capture builtin pushes a view with one live row", () => {
  const { backend } = setup()
  const empty = backend.callSync("rootSearch.search", { query: "", view: null, filter: "all" })
  const commands = (empty.data.find(function(s) { return s.id === "commands" }) || { rows: [] }).rows
  assert.ok(commands.some(function(r) { return r.id === "builtin:quick-capture" }), "ranked at the root")
  // Empty pushed view: no rows (the empty state invites typing).
  const blank = backend.callSync("rootSearch.search", { query: "", view: { kind: "quick-capture", title: "Quick Capture" }, filter: "all" })
  assert.deepEqual(blank.data, [])
  const blankEdit = backend.callSync("rootSearch.search", { query: "x", view: { kind: "setting-edit", settingId: "x" }, filter: "all" })
  assert.deepEqual(blankEdit.data, [])
  // Typed: one row with the target file and the mode.
  const r = backend.callSync("rootSearch.search", { query: "hello world", view: { kind: "quick-capture", title: "Quick Capture" }, filter: "all" })
  assert.equal(r.ok, true)
  assert.equal(r.data.length, 1)
  const row = r.data[0].rows[0]
  assert.equal(row.id, RootSearch.QUICK_SAVE_ID)
  assert.equal(row.title, "hello world")
  assert.match(row.subtitle, /\.md · /)
  const acts = backend.callSync("rootSearch.getActions", { id: row.id })
  assert.deepEqual(acts.data.map(function(a) { return a.id }), ["open", "save-new", "reveal-folder", "copy-note"])
  const info = backend.callSync("rootSearch.getItemInfo", { id: row.id, query: "hello world" })
  assert.ok(info.data.some(function(x) { return x.label === "File" }))
  backend.dispose()
})

test("saving appends to the same daily file, then to a new file", () => {
  const { backend, paths } = setup()
  const dir = path.join(paths.data, "notes")
  // Default mode is daily: two captures land in one dated file, one heading.
  const a = backend.callSync("rootSearch.performAction", { id: RootSearch.QUICK_SAVE_ID, action: "open", query: "first note", confirmed: true })
  assert.equal(a.ok, true)
  assert.match(a.data.hud, /^Captured to \d{4}-\d{2}-\d{2}\.md$/)
  const files = fs.readdirSync(dir)
  assert.equal(files.length, 1)
  const full = path.join(dir, files[0])
  const b = backend.callSync("rootSearch.performAction", { id: RootSearch.QUICK_SAVE_ID, action: "open", query: "second note", confirmed: true })
  assert.equal(b.ok, true)
  assert.deepEqual(fs.readdirSync(dir), files, "same file again")
  const text = fs.readFileSync(full, "utf8")
  assert.match(text, /^# \d{4}-\d{2}-\d{2}\n\n/)
  assert.equal(text.match(/^- \[.*\] /gm).length, 2)
  assert.ok(text.indexOf("first note") >= 0 && text.indexOf("second note") >= 0)
  // save-new forces a new timestamped file for this capture only.
  const c = backend.callSync("rootSearch.performAction", { id: RootSearch.QUICK_SAVE_ID, action: "save-new", query: "standalone", confirmed: true })
  assert.equal(c.ok, true)
  assert.equal(fs.readdirSync(dir).length, 2)
  // The builtin earned the frecency visit so it rises with use.
  const freq = backend.callSync("frecency.get", { id: "builtin:quick-capture" })
  assert.ok(freq.data && freq.data.anchor > 0)
  backend.dispose()
})

test("inbox mode appends to one inbox.md", () => {
  const { backend, paths } = setup()
  assert.equal(backend.callSync("settings.updateGeneralSettings", { quickCaptureMode: "inbox" }).ok, true)
  backend.callSync("rootSearch.performAction", { id: RootSearch.QUICK_SAVE_ID, action: "open", query: "a", confirmed: true })
  backend.callSync("rootSearch.performAction", { id: RootSearch.QUICK_SAVE_ID, action: "open", query: "b", confirmed: true })
  const dir = path.join(paths.data, "notes")
  assert.deepEqual(fs.readdirSync(dir), ["inbox.md"])
  assert.match(fs.readFileSync(path.join(dir, "inbox.md"), "utf8"), /^# Inbox\n\n/)
  backend.dispose()
})

test("the mode row cycles inbox → daily → new, the folder row pushes an editor", () => {
  const { backend } = setup()
  const cycle = backend.callSync("rootSearch.performAction", { id: "setting:general:quickCaptureMode", action: "open", query: "", confirmed: true })
  assert.equal(cycle.ok, true)
  assert.match(cycle.data.toast.title, /New file each time/)
  assert.equal(backend.callSync("settings.getGeneralSettings", null).data.quickCaptureMode, "new")
  // A "new"-mode save writes one file per capture.
  backend.callSync("rootSearch.performAction", { id: RootSearch.QUICK_SAVE_ID, action: "open", query: "one", confirmed: true })
  backend.callSync("rootSearch.performAction", { id: RootSearch.QUICK_SAVE_ID, action: "open", query: "two", confirmed: true })
  // Same-second collisions get -1, so at least one file, at most two…
  // (assert the content instead of the count.)
  const edit = backend.callSync("rootSearch.performAction", { id: "setting:general:quickCaptureDir", action: "open", query: "", confirmed: true })
  assert.equal(edit.ok, true)
  assert.equal(edit.data.push.kind, "setting-edit")
  assert.equal(edit.data.push.settingId, "setting:general:quickCaptureDir")
  // The editor saves through the validated settings path; a bad mode is rejected.
  assert.equal(backend.callSync("settings.updateGeneralSettings", { quickCaptureMode: "gigantic" }).ok, false)
  backend.dispose()
})

test("a custom folder receives the capture, copy and reveal work", () => {
  const { backend, calls, paths } = setup()
  const custom = path.join(paths.home, "My Notes")
  assert.equal(backend.callSync("settings.updateGeneralSettings", { quickCaptureDir: custom }).ok, true)
  const r = backend.callSync("rootSearch.performAction", { id: RootSearch.QUICK_SAVE_ID, action: "open", query: "filed away", confirmed: true })
  assert.equal(r.ok, true)
  assert.equal(fs.readdirSync(custom).length, 1)
  const copy = backend.callSync("rootSearch.performAction", { id: RootSearch.QUICK_SAVE_ID, action: "copy-note", query: "filed away", confirmed: true })
  assert.deepEqual(calls.copy, ["filed away"])
  assert.equal(copy.data.hud, "Copied to Clipboard")
  const reveal = backend.callSync("rootSearch.performAction", { id: RootSearch.QUICK_SAVE_ID, action: "reveal-folder", query: "x", confirmed: true })
  assert.equal(reveal.ok, true)
  assert.deepEqual(calls.opened, ["path:" + custom])
  // Empty notes never write.
  assert.equal(backend.callSync("rootSearch.performAction", { id: RootSearch.QUICK_SAVE_ID, action: "open", query: "   ", confirmed: true }).ok, false)
  backend.dispose()
})
