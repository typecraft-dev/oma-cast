// Quick Capture pure logic: directory resolution, file naming, entry
// formatting and validation. No Qt, no fs — the backends own I/O.
const test = require("node:test")
const assert = require("node:assert/strict")
const QC = require("../plugin/core/QuickCapture.js")
const RS = require("../plugin/core/RootSearch.js")
const SettingsView = require("../plugin/core/SettingsView.js")
const Schema = require("../plugin/core/Schema.js")

const NOW = Date.UTC(2026, 10, 11, 14, 30, 0)

test("modes default to daily and have titles", () => {
  assert.deepEqual(QC.MODES, ["inbox", "daily", "new"])
  assert.equal(QC.validMode("inbox"), "inbox")
  assert.equal(QC.validMode("daily"), "daily")
  assert.equal(QC.validMode("new"), "new")
  assert.equal(QC.validMode(""), "daily")
  assert.equal(QC.validMode("gigantic"), "daily")
  assert.equal(QC.MODE_TITLES.inbox, "Same file (inbox)")
})

test("empty text is rejected, long text capped", () => {
  assert.equal(QC.validateText(""), "Type a note first")
  assert.equal(QC.validateText("   "), "Type a note first")
  assert.equal(QC.validateText("hello"), null)
  assert.match(QC.validateText("x".repeat(10001)), /under/)
  assert.match(QC.validateText("a\x00b"), /NUL/)
})

test("directory validation accepts empty (the default)", () => {
  assert.equal(QC.validateDir(""), null)
  assert.equal(QC.validateDir(null), null)
  assert.equal(QC.validateDir("~/Notes"), null)
  assert.equal(QC.validateDir("/home/u/notes"), null)
  assert.match(QC.validateDir("a\x00b"), /NUL/)
})

test("resolveDir falls back to data/notes and expands ~", () => {
  const opts = { home: "/home/u", data: "/home/u/.local/share/oma-cast", sep: "/" }
  assert.equal(QC.resolveDir("", opts), "/home/u/.local/share/oma-cast/notes")
  assert.equal(QC.resolveDir("  ", opts), "/home/u/.local/share/oma-cast/notes")
  assert.equal(QC.resolveDir("~", opts), "/home/u")
  assert.equal(QC.resolveDir("~/Notes", opts), "/home/u/Notes")
  assert.equal(QC.resolveDir("/tmp/notes/", opts), "/tmp/notes")
  assert.equal(QC.resolveDir("Notes", opts), "/home/u/Notes")
})

test("resolveDir uses backslashes on Windows paths", () => {
  const opts = { home: "C:\\Users\\u", data: "C:\\Users\\u\\AppData\\Local\\oma-cast", sep: "\\" }
  assert.equal(QC.resolveDir("", opts), "C:\\Users\\u\\AppData\\Local\\oma-cast\\notes")
  assert.equal(QC.resolveDir("~\\Notes", opts), "C:\\Users\\u\\Notes")
})

test("file names: inbox is fixed, daily is dated, new is timestamped", () => {
  assert.equal(QC.fileNameFor("inbox", NOW), "inbox.md")
  assert.match(QC.fileNameFor("daily", NOW), /^\d{4}-\d{2}-\d{2}\.md$/)
  assert.match(QC.fileNameFor("new", NOW), /^\d{4}-\d{2}-\d{2}-\d{6}\.md$/)
  assert.equal(QC.fileNameFor("bogus", NOW), QC.fileNameFor("daily", NOW))
  assert.equal(QC.targetFor("inbox", NOW).append, true)
  assert.equal(QC.targetFor("daily", NOW).append, true)
  assert.equal(QC.targetFor("new", NOW).append, false)
})

test("append entries are one markdown line with a timestamp", () => {
  const line = QC.formatEntry("hello world", NOW)
  assert.match(line, /^- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] hello world\n$/)
  assert.equal(QC.formatEntry("a\nb", NOW).indexOf("\n"), QC.formatEntry("a\nb", NOW).length - 1, "embedded newlines collapse to one line")
  const content = QC.newFileContent("hello", NOW)
  assert.match(content, /^# \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n\nhello\n$/)
})

test("preview truncates long notes", () => {
  assert.equal(QC.previewTitle("hello"), "hello")
  assert.ok(QC.previewTitle("x".repeat(100)).length <= 60)
  assert.match(QC.previewTitle("x".repeat(100)), /…$/)
})

test("the builtin pushes the capture view and the row shapes", () => {
  const def = RS.BUILTINS.find(function(b) { return b.id === "builtin:quick-capture" })
  assert.ok(def, "builtin exists")
  assert.equal(def.run.push.kind, "quick-capture")
  assert.ok(def.keywords.indexOf("capture") >= 0)
  const cand = RS.quickCaptureCandidate("hello", "inbox.md · Same file", "hello", "inbox.md", "/home/u/notes", "inbox")
  assert.equal(cand.id, RS.QUICK_SAVE_ID)
  assert.equal(cand.kind, "quick-capture")
  assert.deepEqual(RS.actionsFor(cand).map(function(a) { return a.id }), ["open", "save-new", "reveal-folder", "copy-note"])
  assert.deepEqual(RS.actionsFor(cand).map(function(a) { return a.shortcut }), ["↵", "", "", "Ctrl Shift C"],
    "Ctrl+↵ submits (Save Capture); Save as New File lives in the action panel" )
  assert.deepEqual(RS.quickCaptureSections("", "p", "s", "q", "f", "d", "m"), [], "empty query shows the empty state, not a row")
  assert.equal(RS.quickCaptureSections("hi", "hi", "inbox.md · Same file", "hi", "inbox.md", "/d", "inbox")[0].rows[0].candidate.id, RS.QUICK_SAVE_ID)
  const about = Object.fromEntries(RS.aboutFor(cand, NOW).map(function(r) { return [r.label, r.value] }))
  assert.equal(about.File, "inbox.md")
  assert.equal(about.Folder, "/home/u/notes")
})

test("settings carry the folder and the mode", () => {
  const mode = SettingsView.find("setting:general:quickCaptureMode")
  const dir = SettingsView.find("setting:general:quickCaptureDir")
  assert.ok(mode && dir, "both rows exist")
  assert.equal(SettingsView.format(mode, "inbox"), "Same file (inbox)")
  assert.equal(SettingsView.format(dir, ""), "Default")
  assert.equal(SettingsView.format(dir, "~/Notes"), "~/Notes")
  assert.equal(SettingsView.cycle(dir, "~/Notes"), "~/Notes", "text has no cycle target — ↵ pushes the editor")
  assert.deepEqual(Schema.generalChoices.quickCaptureMode, ["inbox", "daily", "new"])
})
