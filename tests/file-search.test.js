const test = require("node:test")
const assert = require("node:assert/strict")
const FS = require("../core/FileSearch.js")

process.env.TZ = "UTC"

const HOME = "/home/ada"
const NOW = Date.UTC(2026, 10, 9, 12, 0)          // 9 Nov 2026
const day = 86400
const t = (daysAgo) => Math.round(NOW / 1000 - daysAgo * day)

// Hand-written `stat --printf '%F|%Y|%s|%n\0'` output.
function listing(rows) {
  return rows.map(([type, daysAgo, path, size]) => `${type}|${t(daysAgo)}|${size || 0}|${path}`).join("\0") + "\0"
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
  const odd = FS.parseListing("junk\0regular file|100|5|/home/ada/a|b.txt\0", HOME)
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

test("visit bonus: none unopened, ~30 after one open, capped at 40", () => {
  assert.equal(FS.visitBonus(1), 0)
  assert.equal(FS.visitBonus(undefined), 0)
  assert.equal(FS.visitBonus(100), 30)                // 15 * log10(100)
  assert.equal(FS.visitBonus(1e6), 40)                // 15 * 6 = 90, capped
})

// Draft report v2.docx: word start 60 + recent 8 = 68, +30 for an open
// = 98, still under report.js (108) and Report.pdf (100), above Reports (84).
test("a bonus lifts an opened file above unopened prefix matches", () => {
  const bonus = (e) => (e.name === "Draft report v2.docx" ? 30 : 0)
  assert.deepEqual(FS.search(entries, "report", NOW, 3, bonus).map((e) => e.name),
    ["report.js", "Report.pdf", "Draft report v2.docx"])
})

test("size labels use decimal units", () => {
  assert.equal(FS.sizeLabel(0), "0 bytes")
  assert.equal(FS.sizeLabel(1), "1 byte")
  assert.equal(FS.sizeLabel(999), "999 bytes")
  assert.equal(FS.sizeLabel(1500), "1.5 KB")
  assert.equal(FS.sizeLabel(12000), "12 KB")
  assert.equal(FS.sizeLabel(3400000), "3.4 MB")
  assert.equal(FS.sizeLabel(2500000000), "2.5 GB")
})

test("recent lists files newest first, without folders", () => {
  assert.deepEqual(FS.recent(entries, 3).map((e) => e.name), ["quarterly-reports.zip", "Draft report v2.docx", "summary.txt"])
})

test("details and preview kinds for the Search Files pane", () => {
  const [img, txt, big, pdf] = FS.parseListing(listing([
    ["regular file", 3, "/home/ada/Pictures/cat.PNG", 2048],
    ["regular file", 3, "/home/ada/notes.md", 900],
    ["regular file", 3, "/home/ada/huge.log", 5000000],
    ["regular file", 40, "/home/ada/Personal/Uni/Report.pdf", 1234567]
  ]), HOME)
  assert.equal(FS.previewKind(img), "image")
  assert.equal(FS.previewKind(txt), "text")
  assert.equal(FS.previewKind(big), "glyph", "text over 1 MB is not read")
  assert.equal(FS.previewKind(pdf), "glyph")
  const d = FS.details(pdf, NOW, () => "relative")
  assert.deepEqual(d, {
    path: "/home/ada/Personal/Uni/Report.pdf", name: "Report.pdf", where: "~/Personal/Uni",
    type: "PDF document", size: "1.2 MB", modified: "30 Sep", glyph: "\uf1c1", preview: "glyph"
  })
})
