const test = require("node:test")
const assert = require("node:assert/strict")
const FS = require("../core/FileSearch.js")

process.env.TZ = "UTC"

const HOME = "/home/ada"
const NOW = Date.UTC(2026, 10, 9, 12, 0)          // 9 Nov 2026
const day = 86400
const t = (daysAgo) => Math.round(NOW / 1000 - daysAgo * day)

// Hand-written `stat --printf '%F|%Y|%n\0'` output.
function listing(rows) {
  return rows.map(([type, daysAgo, path]) => `${type}|${t(daysAgo)}|${path}`).join("\0") + "\0"
}

const entries = FS.parseListing(listing([
  ["regular file", 40, "/home/ada/Personal/Uni/Report.pdf"],
  ["regular file", 2, "/home/ada/Personal/Uni/Draft report v2.docx"],
  ["regular file", 400, "/home/ada/Personal/Uni/MyReportNotes.md"],
  ["regular file", 1, "/home/ada/Downloads/quarterly-reports.zip"],
  ["directory", 10, "/home/ada/Personal/Reports"],
  ["regular file", 3, "/home/ada/Personal/Reports/summary.txt"],
  ["regular file", 5, "/home/ada/Projects/omacast/src/report.js"],
  ["regular file", 5, "/etc/passwd"]
]), HOME)

const names = (q, limit) => FS.search(entries, q, NOW, limit || 10).map((e) => e.name)

test("parseListing keeps home paths and reads type, time and folders", () => {
  assert.equal(entries.length, 7, "/etc/passwd is outside home and dropped")
  const report = entries[0]
  assert.equal(report.name, "Report.pdf")
  assert.equal(report.dir, "Personal/Uni")
  assert.equal(report.rel, "Personal/Uni/Report.pdf")
  assert.equal(report.mtime, t(40))
  assert.equal(report.folder, false)
  assert.equal(entries[4].folder, true)
  assert.equal(entries[4].name, "Reports")
})

test("parseListing survives empty input, junk records and | in names", () => {
  assert.deepEqual(FS.parseListing("", HOME), [])
  const odd = FS.parseListing("junk\0regular file|100|/home/ada/a|b.txt\0", HOME)
  assert.equal(odd.length, 1)
  assert.equal(odd[0].name, "a|b.txt")
})

// Worked by hand from the rules: exact stem 100, name prefix 80, word start
// 60, inside the name 40, path only 10; +12 under a day, +8 under a week,
// +4 under a month; ties go to the shorter path.
//   report.js 100+8, Report.pdf 100+0, Reports/ 80+4,
//   quarterly-reports.zip 60+8 (31 chars), Draft report v2.docx 60+8 (33),
//   MyReportNotes.md 60+0. summary.txt matches only its folder: left out.
test("'report' ranks exact names, then prefixes, then word starts", () => {
  assert.deepEqual(names("report"), [
    "report.js", "Report.pdf", "Reports",
    "quarterly-reports.zip", "Draft report v2.docx", "MyReportNotes.md"
  ])
})

// uni (path, 10) + report: Report.pdf 10+100, Draft 10+60+8, MyReportNotes 10+60.
test("every token must match, and the name must hold at least one", () => {
  assert.deepEqual(names("uni report"), ["Report.pdf", "Draft report v2.docx", "MyReportNotes.md"])
  assert.deepEqual(names("reports summary"), ["summary.txt"])
  assert.deepEqual(names("uni zzz"), [])
})

test("recency breaks ties between equal name matches", () => {
  const two = FS.parseListing(listing([
    ["regular file", 300, "/home/ada/a/notes.md"],
    ["regular file", 0.5, "/home/ada/b/notes.md"]
  ]), HOME)
  assert.deepEqual(FS.search(two, "notes", NOW, 5).map((e) => e.dir), ["b", "a"])
})

test("short queries return nothing and the limit holds", () => {
  assert.deepEqual(names("r"), [])
  assert.equal(FS.search(entries, "report", NOW, 2).length, 2)
})

test("glyphs, breadcrumbs and the row candidate", () => {
  assert.equal(FS.glyphFor(entries[0]), "", "pdf")
  assert.equal(FS.glyphFor(entries[4]), "", "folder")
  assert.equal(FS.glyphFor({ folder: false, lowerName: "noext" }), "")
  assert.equal(FS.breadcrumb(""), "~")
  assert.equal(FS.breadcrumb("Personal"), "~ › Personal")
  assert.equal(FS.breadcrumb("Personal/Uni"), "~ › Personal › Uni")
  assert.equal(FS.breadcrumb("a/b/c/d/e"), "d › e")
  const c = FS.candidate(entries[0], NOW, () => "relative")
  assert.equal(c.id, "file:/home/ada/Personal/Uni/Report.pdf")
  assert.equal(c.title, "Report.pdf")
  assert.equal(c.subtitle, "~ › Personal › Uni")
  assert.equal(c.typeLabel, "30 Sep", "40 days before 9 Nov 2026")
  assert.equal(c.kind, "file")
})

test("modified label: relative for a week, then day and month, then month and year", () => {
  const rel = (ms, now) => `rel ${Math.round((now - ms) / 86400000)}d`
  assert.equal(FS.modifiedLabel(NOW - 2 * day * 1000, NOW, rel), "rel 2d")
  assert.equal(FS.modifiedLabel(NOW - 40 * day * 1000, NOW, rel), "30 Sep")
  assert.equal(FS.modifiedLabel(NOW - 400 * day * 1000, NOW, rel), "Oct 2025")
})
