const test = require("node:test")
const assert = require("node:assert/strict")
const FS = require("../plugin/core/FileSearch.js")

const HOME = "/home/u"

function fd(paths) { return paths.join("\0") + "\0" }

test("fdArgv searches the last term under home with fixed strings", () => {
  const argv = FS.fdArgv("work invoice", HOME)
  assert.deepEqual(argv.slice(-3), ["--", "invoice", HOME])
  assert.ok(argv.includes("--fixed-strings"))
  assert.ok(argv.includes("--print0"))
  assert.deepEqual(FS.fdArgv("oma cast spec", HOME).slice(-3), ["--", "spec", HOME])
})

test("searchable needs two characters", () => {
  assert.equal(FS.searchable("a"), false)
  assert.equal(FS.searchable(" ab "), true)
})

test("parse marks folders, drops home itself and shortens the parent", () => {
  const rows = FS.parse(fd(["/home/u/", "/home/u/Documents/"]), "doc", HOME)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, "folder")
  assert.equal(rows[0].subtitle, "~")
  assert.equal(rows[0].iconName, "folder")
  assert.equal(rows[0].path, "/home/u/Documents")
})

test("exact and prefix names outrank deep substring matches", () => {
  const rows = FS.parse(fd([
    "/home/u/Projects/app/src/old-report-helper.ts",
    "/home/u/Work/report.pdf",
    "/home/u/Work/reports/",
    "/home/u/Work/q3/monthly report final.docx"
  ]), "report", HOME)
  assert.deepEqual(rows.map((r) => r.title), ["report.pdf", "reports", "monthly report final.docx", "old-report-helper.ts"])
})

test("extra terms filter on the whole path", () => {
  const rows = FS.parse(fd(["/home/u/Work/invoice.pdf", "/home/u/Downloads/invoice.pdf"]), "work invoice", HOME)
  assert.deepEqual(rows.map((r) => r.subtitle), ["~/Work"])
})

test("rank re-filters previous candidates for a longer query", () => {
  const prev = FS.parse(fd(["/home/u/a/notes.md", "/home/u/a/notebook/"]), "no", HOME)
  assert.deepEqual(FS.rank(prev, "notes", HOME).map((r) => r.title), ["notes.md"])
})

test("icons follow the extension", () => {
  assert.equal(FS.iconFor("a.PDF", false), "application-pdf")
  assert.equal(FS.iconFor("Makefile", false), "text-x-generic")
})

test("fileUri percent-encodes each segment", () => {
  assert.equal(FS.fileUri("/home/u/My Files/a#1.txt"), "file:///home/u/My%20Files/a%231.txt")
})
