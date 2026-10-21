const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const path = require("path")
const Ranker = require("../plugin/core/Ranker.js")
const Frecency = require("../plugin/core/Frecency.js")
const OmarchyMenu = require("../plugin/core/OmarchyMenu.js")
const RS = require("../plugin/core/RootSearch.js")

const deps = { Ranker, Frecency, OmarchyMenu }
const NOW = Date.UTC(2026, 9, 19, 12)

// Candidates that exercise every way a record can match: camelCase titles,
// diacritics and multi-char transliterations, alternates, subtitles,
// keywords, bundle ids, aliases, learned terms, pins and alwaysMatching.
const synthetic = [
  { id: "a1", type: "application", title: "Firefox", keywords: ["Web Browser"], bundleId: "org.mozilla.firefox" },
  { id: "a2", type: "application", title: "LibreOffice Writer", keywords: ["Word Processor"], bundleId: "libreoffice-writer" },
  { id: "a3", type: "application", title: "Łódź Straße Ærø", subtitle: "Ortsnamen" },
  { id: "a4", type: "application", title: "Café Crème", alternateTitles: ["Coffee Cream"] },
  { id: "c1", type: "command", title: "Toggle Nightlight", subtitle: "Trigger › Toggle", keywords: ["night shift", "hyprsunset"] },
  { id: "c2", type: "command", title: "setWallpaper", subtitle: "Style › Background" },
  { id: "c3", type: "command", title: "Lock Screen", subtitle: "System", alias: "ls" },
  { id: "c4", type: "command", title: "Update System", subtitle: "Omarchy", frecency: 3, openedAt: NOW - 1000, searchTerms: [{ term: "upd", at: NOW }] },
  { id: "c5", type: "command", title: "Pinned Thing", pinPriority: 0 },
  { id: "c6", type: "command", title: "Always Here", alwaysMatching: true },
  { id: "c7", type: "quicklink", title: "Search GitHub", subtitle: "github.com/search?q=", boostedTerms: ["gh"] },
  { id: "c8", type: "command", title: "Screenshot (region)", keywords: ["capture/area"] }
]

function realCandidates() {
  const omarchyPath = process.env.OMARCHY_PATH || "/usr/share/omarchy"
  const menuFile = path.join(omarchyPath, "default/omarchy/omarchy-menu.jsonc")
  if (!fs.existsSync(menuFile)) return []
  const tree = OmarchyMenu.buildTree(OmarchyMenu.parse(fs.readFileSync(menuFile, "utf8")).items, [])
  return RS.menuCandidates(tree, null, {}, deps)
}

const QUERIES = [
  "f", "fi", "fir", "firefox", "FIREFOX", " fir ", "x", "zz", "q",
  "lodz", "łódź", "strasse", "straße", "aero", "ærø", "cafe", "café", "creme", "coffee",
  "tn", "toggle night", "night-light", "sw", "set wall", "wallpaper", "sWall",
  "ls", "l", "lo", "upd", "update", "updx", "pin", "always", "gh", "github.com", "org.moz",
  "screenshot (", "capture/", "/s", "a/b", "...", "-", "t o g", "omarchy update system", "theme"
]

function ids(ranked) {
  return ranked.map((r) => r.candidate.id + ":" + r.record.titleScore + ":" + r.record.textMatched)
}

for (const [name, list] of [["synthetic", synthetic], ["Omarchy menu", realCandidates()]]) {
  test(`prefilter leaves rank() output unchanged (${name})`, { skip: list.length === 0 && "no Omarchy menu on this machine" }, () => {
    const extra = list.filter((c, i) => i % 7 === 0).flatMap((c) => [c.title.slice(0, 2), c.title.toLowerCase().slice(1, 5)])
    for (const sensitivity of ["low", "medium", "high"]) {
      for (const query of QUERIES.concat(extra)) {
        const options = { sensitivity, nowMs: NOW }
        const indexed = list.map((c) => Object.assign({ searchChars: Ranker.searchChars(c) }, c))
        const reference = ids(Ranker.rank(list, query, Object.assign({ prefilter: false }, options)))
        assert.deepEqual(ids(Ranker.rank(list, query, options)), reference, `${sensitivity} ${JSON.stringify(query)}`)
        assert.deepEqual(ids(Ranker.rank(indexed, query, options)), reference, `indexed ${sensitivity} ${JSON.stringify(query)}`)
      }
    }
  })
}

test("mightMatch rejects a candidate missing a query character", () => {
  const c = synthetic[0]
  assert.equal(Ranker.mightMatch(c, "fox", "fox"), true)
  assert.equal(Ranker.mightMatch(c, "fqx", "fqx"), false)
  assert.equal(Ranker.mightMatch(c, "fire fox", "fire fox"), true, "separators are not required characters")
})

test("mightMatch keeps aliases, always-matching rows and transliterated titles", () => {
  assert.equal(Ranker.mightMatch(synthetic[6], "l", "l"), true)
  assert.equal(Ranker.mightMatch(Object.assign({}, synthetic[6], { title: "Zzz", subtitle: "" }), "ls", "ls"), true, "alias")
  assert.equal(Ranker.mightMatch(synthetic[9], "qqq", "qqq"), true, "alwaysMatching")
  assert.equal(Ranker.mightMatch(synthetic[2], "lodz", "lodz"), true, "Łódź folds to lodz")
  assert.equal(Ranker.mightMatch(synthetic[2], "strasse", "strasse"), true, "ß folds to ss")
})

test("rootSections gives the same sections with indexed candidates", () => {
  const ctx = { commands: { a1: { alias: "ff" } }, frecency: {}, nowMs: NOW, sensitivity: "medium" }
  const list = realCandidates().concat(RS.BUILTINS.map(RS.builtinCandidate))
  const indexed = RS.indexCandidates(list.map((c) => Object.assign({}, c)), deps)
  for (const query of ["", "f", "ff", "theme", "font", "zzz", "fqx"]) {
    const plain = RS.rootSections(list, query, ctx, deps).map((s) => s.rows.map((r) => r.candidate.id))
    assert.deepEqual(RS.rootSections(indexed, query, ctx, deps).map((s) => s.rows.map((r) => r.candidate.id)), plain, JSON.stringify(query))
  }
})
