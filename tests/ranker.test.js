const test = require("node:test")
const assert = require("node:assert/strict")
const R = require("../plugin/core/Ranker.js")

const NOW = 1_800_000_000_000
const DAY_MS = 86_400_000
const titles = (ranked) => ranked.map((x) => x.candidate.title)
const app = (title, extra = {}) => ({ id: title, type: "application", title, ...extra })

test("normalize lowercases and marks camelCase boundaries", () => {
  const n = R.normalize("LibreOffice")
  assert.equal(n.normalizedText, "libreoffice")
  assert.deepEqual(n.wordBoundaries.map((b, i) => (b ? i : -1)).filter((i) => i >= 0), [5])
})

test("transliterate folds diacritics to ASCII", () => {
  assert.equal(R.transliterate("Café Ærø Straße"), "Cafe AEro Strasse")
})

test("fuzzyMatch golden scores", () => {
  assert.deepEqual(R.fuzzyMatch("Firefox", "fir"), { score: 8, skipped: 0 })
  assert.deepEqual(R.fuzzyMatch("Firefox", "fx"), { score: 5, skipped: 0 })
  assert.deepEqual(R.fuzzyMatch("LibreOffice Writer", "lw"), { score: 6, skipped: 0 })
  assert.deepEqual(R.fuzzyMatch("LibreOffice Writer", "lo"), { score: 6, skipped: 0 })
  assert.deepEqual(R.fuzzyMatch("Visual Studio Code", "vsc"), { score: 8, skipped: 0 })
  assert.deepEqual(R.fuzzyMatch("foo-bar", "f-b"), { score: 7, skipped: 0 })
  assert.deepEqual(R.fuzzyMatch("Font Viewer", "fir"), { score: 6, skipped: 0 })
  assert.deepEqual(R.fuzzyMatch("LibreOffice Writer", "fir"), { score: 5, skipped: 0 })
})

test("fuzzyMatch exact, unmatched and separator skipping", () => {
  assert.equal(R.fuzzyMatch("Firefox", "firefox"), "exact")
  assert.equal(R.fuzzyMatch("abc", "cba"), "unmatched")
  assert.equal(R.fuzzyMatch("Files", "fir"), "unmatched")
  assert.equal(R.fuzzyMatch("ab", "abc"), "unmatched")
  assert.deepEqual(R.fuzzyMatch("Firefox", "fire "), { score: 10, skipped: 1 })
  assert.equal(R.fuzzyMatch("org-gnome", "org.g", { literalQueryDots: true }), "unmatched")
  assert.notEqual(R.fuzzyMatch("org-gnome", "org.g"), "unmatched")
})

test("thresholds by sensitivity at their boundaries", () => {
  const m = (score, skipped = 0) => ({ score, skipped })
  assert.ok(R.passesThreshold(m(6), 3, "medium"))
  assert.ok(!R.passesThreshold(m(5), 3, "medium"))
  assert.ok(R.passesThreshold(m(5.5), 3, "medium"))
  assert.ok(R.passesThreshold(m(5.5), 4, "medium") === false)
  assert.ok(R.passesThreshold(m(5.5, 1), 4, "medium"))
  assert.ok(!R.passesThreshold(m(6), 3, "high"))
  assert.ok(R.passesThreshold(m(6.5), 3, "high"))
  assert.ok(R.passesThreshold(m(-3), 3, "low"))
  assert.ok(!R.passesThreshold(m(5), 3))
  assert.ok(R.passesThreshold("exact", 9, "high"))
  assert.ok(!R.passesThreshold("unmatched", 1, "low"))
})

test("query 'fir' over a realistic app list", () => {
  const apps = ["Firefox", "Files", "Fire Dragon", "Chromium", "Signal", "LibreOffice Writer", "Alacritty", "Font Viewer"].map((t) => app(t))
  assert.deepEqual(titles(R.rank(apps, "fir", { nowMs: NOW })), ["Fire Dragon", "Firefox", "Font Viewer"])
  assert.deepEqual(titles(R.rank(apps, "fir", { nowMs: NOW, sensitivity: "high" })), ["Fire Dragon", "Firefox"])
  apps[0].frecency = 101
  assert.deepEqual(titles(R.rank(apps, "fir", { nowMs: NOW })), ["Firefox", "Fire Dragon", "Font Viewer"])
})

test("aliases: exact beats everything, prefix beats a better title", () => {
  assert.equal(R.aliasMatch("ff", "ff"), "exact")
  assert.equal(R.aliasMatch("ffx", "ff"), "prefix")
  assert.equal(R.aliasMatch("f", "ff"), "unmatched")
  const items = [
    app("Firefox", { alias: "ff" }),
    { id: "c", type: "command", title: "ff", frecency: 500 },
    app("Fluffy")
  ]
  assert.equal(titles(R.rank(items, "ff", { nowMs: NOW }))[0], "Firefox")
  const prefix = [app("Fluffy Forest"), { id: "x", type: "command", title: "Xylophone", alias: "flu" }]
  assert.deepEqual(titles(R.rank(prefix, "fl", { nowMs: NOW })), ["Xylophone", "Fluffy Forest"])
})

test("search terms: exact beats a stronger title, expires after 17 days", () => {
  const terms = [{ term: "browser", at: NOW - DAY_MS }]
  assert.deepEqual(R.searchTermMatch(terms, "browser", 101, NOW - DAY_MS, NOW), { kind: "exact", count: 0 })
  assert.deepEqual(R.searchTermMatch(terms, "brow", 101, NOW - DAY_MS, NOW), { kind: "prefix", count: 0 })
  assert.deepEqual(R.searchTermMatch(terms, "browsers!", 101, NOW - DAY_MS, NOW), { kind: "overbounds", count: 2 })
  assert.deepEqual(R.searchTermMatch(terms, "browser1234", 101, NOW - DAY_MS, NOW), { kind: "none", count: 0 })
  assert.equal(R.searchTermMatch(terms, "browser", 1, NOW - DAY_MS, NOW).kind, "none")
  assert.equal(R.searchTermMatch(terms, "browser", 101, NOW - 18 * DAY_MS, NOW).kind, "none")

  const items = [
    app("Firefox", { subtitle: "Web Browser", frecency: 101, openedAt: NOW - DAY_MS, searchTerms: ["web"] }),
    app("Web Builder")
  ]
  assert.deepEqual(titles(R.rank(items, "web", { nowMs: NOW })), ["Firefox", "Web Builder"])
  items[0].openedAt = NOW - 18 * DAY_MS
  assert.deepEqual(titles(R.rank(items, "web", { nowMs: NOW })), ["Web Builder", "Firefox"])
})

test("overbounds of 3+ beats a better title score", () => {
  const items = [
    app("Terminal", { frecency: 50, openedAt: NOW - DAY_MS, searchTerms: ["te"] }),
    app("Tetris")
  ]
  assert.deepEqual(titles(R.rank(items, "tetr", { nowMs: NOW })), ["Tetris"])
  const items2 = [
    app("Kitty", { keywords: ["terminal"], frecency: 50, openedAt: NOW - DAY_MS, searchTerms: ["t"] }),
    app("Tetris")
  ]
  assert.deepEqual(titles(R.rank(items2, "term", { nowMs: NOW })), ["Kitty"])
  const items3 = [
    app("Kitty", { keywords: ["terminal"], frecency: 50, openedAt: NOW - DAY_MS, searchTerms: ["t"] }),
    app("Termius")
  ]
  assert.deepEqual(titles(R.rank(items3, "term", { nowMs: NOW })), ["Kitty", "Termius"])
})

test("title boost for whole-word queries of 3+ chars", () => {
  const r = R.buildRecord(app("LibreOffice Writer"), "writer", { nowMs: NOW })
  assert.equal(r.titleScore, 4 + 5 * 2 + 0.5)
  assert.ok(R.wholeWordIn("LibreOffice Writer", "office"))
  assert.ok(!R.wholeWordIn("Firefox", "fire"))
  assert.equal(R.buildRecord(app("Writerly Notes App"), "writer", { nowMs: NOW }).titleScore, 14)
  const items = [app("Writerly Notes App"), app("LibreOffice Writer")]
  assert.deepEqual(titles(R.rank(items, "writer", { nowMs: NOW })), ["LibreOffice Writer", "Writerly Notes App"])
})

test("empty query orders pins first, then frecency, alias, type, title", () => {
  const items = [
    { id: "1", type: "command", title: "Zeta" },
    app("Beta"),
    app("Alpha"),
    { id: "4", type: "command", title: "Gamma", alias: "g" },
    app("Pinned Two", { pinPriority: 2 }),
    app("Pinned One", { pinPriority: 1 }),
    { id: "7", type: "quicklink", title: "Hot", frecency: 300 }
  ]
  assert.deepEqual(titles(R.rank(items, "", { nowMs: NOW })), [
    "Pinned One", "Pinned Two",
    "Hot",
    "Gamma",
    "Alpha", "Beta",
    "Zeta"
  ])
})

test("exact titles win over fuzzy ones in a bucket", () => {
  const items = [app("Code Editor"), { id: "c", type: "command", title: "Code" }]
  assert.deepEqual(titles(R.rank(items, "code", { nowMs: NOW })), ["Code", "Code Editor"])
})

test("subtitles count only when they differ from the title", () => {
  const r = R.buildRecord(app("Files", { subtitle: "files" }), "fil", { nowMs: NOW })
  assert.equal(r.subtitle, null)
  const r2 = R.buildRecord(app("Nautilus", { subtitle: "Files" }), "files", { nowMs: NOW })
  assert.ok(r2.subtitleExact)
  assert.ok(r2.isMatching)
})

test("bundle ids match only when the query has a dot", () => {
  const c = app("Firefox", { bundleId: "org.mozilla.firefox" })
  assert.ok(!R.buildRecord(c, "mozilla", { nowMs: NOW }).isMatching)
  assert.ok(R.buildRecord(c, "org.moz", { nowMs: NOW }).isMatching)
})

test("pinned and always-matching buckets", () => {
  const items = [
    app("Firefox"),
    { id: "p", type: "command", title: "Pinned Fire", pinPriority: 1 },
    { id: "a", type: "command", title: "Search Web", alwaysMatching: true },
    { id: "pa", type: "command", title: "Pinned Always", pinPriority: 0, alwaysMatching: true }
  ]
  assert.deepEqual(titles(R.rank(items, "fire", { nowMs: NOW })), ["Pinned Fire", "Pinned Always", "Firefox", "Search Web"])
})
