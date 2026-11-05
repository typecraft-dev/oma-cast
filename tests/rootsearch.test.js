const test = require("node:test")
const assert = require("node:assert/strict")
const Ranker = require("../plugin/core/Ranker.js")
const Frecency = require("../plugin/core/Frecency.js")
const OmarchyMenu = require("../plugin/core/OmarchyMenu.js")
const RS = require("../plugin/core/RootSearch.js")

const deps = { Ranker, Frecency, OmarchyMenu }
const NOW = Date.UTC(2026, 9, 19, 12)

const apps = ["firefox", "chromium", "signal-desktop", "org.gnome.Nautilus", "Alacritty", "libreoffice-writer"].map((id) => ({
  id,
  name: { firefox: "Firefox", chromium: "Chromium", "signal-desktop": "Signal", "org.gnome.Nautilus": "Files", Alacritty: "Alacritty", "libreoffice-writer": "LibreOffice Writer" }[id],
  genericName: { firefox: "Web Browser", chromium: "Web Browser", "org.gnome.Nautilus": "File Manager" }[id] || "",
  keywords: [],
  icon: id
}))

const menu = OmarchyMenu.buildTree(OmarchyMenu.parse(`{
  "system": {"label":"System"},
  "system.lock": {"icon":"l","label":"Lock","action":"omarchy-system-lock"},
  "system.shutdown": {"label":"Shutdown","action":"omarchy-system shutdown"},
  "trigger": {"label":"Trigger"},
  "trigger.toggle": {"label":"Toggle"},
  "trigger.toggle.nightlight": {"label":"Nightlight","action":"omarchy-toggle-nightlight"},
  "style": {"label":"Style"},
  "style.font": {"label":"Font","provider":"fonts"}
}`).items, [])

function candidates(guards, providerItems) {
  return apps.map(RS.appCandidate)
    .concat(RS.menuCandidates(menu, guards || { when: {}, checked: {}, disabled: {} }, providerItems || {}, deps))
    .concat(RS.BUILTINS.map(RS.builtinCandidate))
}

function ctx(extra) {
  return Object.assign({ commands: {}, frecency: {}, nowMs: NOW, sensitivity: "medium" }, extra || {})
}

const titles = (section) => section.rows.map((r) => r.candidate.title)
const results = (query, c) => RS.rootSections(candidates(), query, c || ctx(), deps)

test("fir finds Firefox first (Phase 1 accept)", () => {
  const sections = results("fir")
  assert.equal(sections[0].id, "results")
  assert.equal(titles(sections[0])[0], "Firefox")
})

test("a query always ends with the fallback section", () => {
  const sections = results("zzzz-nothing")
  assert.equal(sections.length, 1)
  assert.equal(sections[0].id, "fallback-commands")
  assert.equal(sections[0].title, "Use “zzzz-nothing” with…")
  assert.deepEqual(titles(sections[0]), ["Search Google", "Search DuckDuckGo", "Search unduck", "Ask default agent"])
})

test("agent hand-off is explicit, stays after apps/web search, and only appears at root with a query", () => {
  const sections = results("firefox")
  assert.equal(sections[0].rows[0].candidate.id, "app:firefox")
  const row = sections.at(-1).rows.at(-1).candidate
  assert.equal(row.id, "fallback:agent")
  assert.match(row.subtitle, /Ctrl\+Alt\+Enter/)
  assert.deepEqual(RS.actionsFor(row).map(a => a.id), ["open"])
  assert.ok(!results("").flatMap(s => s.rows).some(r => r.candidate.id === row.id))
  assert.ok(!RS.submenuSections(candidates(), "trigger", "question?", ctx(), deps).flatMap(s => s.rows).some(r => r.candidate.id === row.id))
})

test("an exact alias puts its command on top (Phase 1 accept)", () => {
  const c = ctx({ commands: { "app:chromium": { alias: "ff" } } })
  assert.equal(titles(results("ff", c)[0])[0], "Chromium")
  assert.equal(titles(results("f", c)[0])[0], "Chromium", "an alias prefix also wins over title scores")
})

test("launching bumps frecency and teaches the query (Phase 1 accept)", () => {
  const before = titles(results("web")[0])
  assert.deepEqual(before.slice(0, 2), ["Chromium", "Firefox"])
  const visit = Frecency.recordVisit(null, NOW - 1000, "web")
  const c = ctx({ frecency: { "app:firefox": visit } })
  assert.deepEqual(titles(results("web", c)[0]).slice(0, 2), ["Firefox", "Chromium"])
})

test("deep Omarchy items only appear while searching, with breadcrumbs", () => {
  const empty = results("")
  const all = empty.flatMap((s) => s.rows.map((r) => r.candidate.title))
  assert.ok(all.includes("System") && all.includes("Trigger"))
  assert.ok(!all.includes("Nightlight"))
  const night = results("nightlight")[0].rows[0].candidate
  assert.equal(night.title, "Nightlight")
  assert.equal(night.subtitle, "Trigger › Toggle")
  assert.equal(night.kind, "omarchy-action")
})

test("empty root: favorites, suggestions, commands, applications", () => {
  const c = ctx({
    commands: { "omarchy:system.lock": { favoriteOrder: 0 } },
    frecency: { "app:signal-desktop": Frecency.recordVisit(null, NOW - 1000, "") }
  })
  const sections = results("", c)
  assert.deepEqual(sections.map((s) => s.id), ["favorites", "suggestions", "commands", "apps"])
  assert.deepEqual(titles(sections[0]), ["Lock"])
  assert.deepEqual(titles(sections[1]), ["Signal"])
  assert.ok(!titles(sections[3]).includes("Signal"), "suggested apps are not repeated")
})

test("hidden menu rows (when: false) and disabled commands are left out", () => {
  const sections = RS.rootSections(candidates({ when: { "system.shutdown": false }, checked: {}, disabled: {} }), "shutdown", ctx(), deps)
  const rowIds = sections.flatMap(s => s.rows).map(r => r.candidate.id)
  // The hidden Omarchy menu row stays out; the built-in Shut Down command
  // (added for Windows) legitimately matches the same query.
  assert.ok(!rowIds.includes("omarchy:system.shutdown"))
  assert.ok(rowIds.includes("builtin:shutdown"))
  assert.ok(rowIds.includes("fallback:google"))
  const off = results("signal", ctx({ commands: { "app:signal-desktop": { enabled: false } } }))
  assert.ok(!off.some((s) => s.id === "results" && titles(s).includes("Signal")))
})

test("a submenu lists its children, and searches its descendants", () => {
  const children = RS.submenuSections(candidates(), "trigger", "", ctx(), deps)
  assert.deepEqual(titles(children[0]), ["Toggle"])
  const found = RS.submenuSections(candidates(), "trigger", "night", ctx(), deps)
  assert.deepEqual(titles(found[0]), ["Nightlight"])
})

test("provider rows are searchable under their menu", () => {
  const rows = OmarchyMenu.providerItems("style.font", "fonts", "Iosevka\tIosevka\tIosevka\n")
  const sections = RS.rootSections(candidates(null, { "style.font": rows }), "iosevka", ctx(), deps)
  const hit = sections[0].rows[0].candidate
  assert.equal(hit.title, "Iosevka")
  assert.equal(hit.subtitle, "Style › Font")
  assert.equal(hit.checked, true)
})

test("actions: primary first, favourites and alias offered", () => {
  const app = RS.decorate(RS.appCandidate(apps[0]), ctx(), deps)
  const ids = RS.actionsFor(app).map((a) => a.id)
  assert.equal(ids[0], "open")
  assert.ok(ids.includes("favorite-add") && ids.includes("set-alias") && ids.includes("copy-id"))
  const menuItem = RS.decorate(candidates().find((c) => c.id === "omarchy:system.lock"), ctx(), deps)
  assert.deepEqual(RS.actionsFor(menuItem).slice(0, 2).map((a) => a.id), ["open", "open-in-omarchy-menu"])
})

test("favourite reordering", () => {
  const cmds = { a: { favoriteOrder: 0 }, b: { favoriteOrder: 1 }, c: {} }
  assert.deepEqual(RS.reorderFavorites(cmds, "c", "favorite-add"), { a: 0, b: 1, c: 2 })
  assert.deepEqual(RS.reorderFavorites(cmds, "b", "favorite-up"), { b: 0, a: 1 })
  assert.deepEqual(RS.reorderFavorites(cmds, "a", "favorite-remove"), { a: null, b: 0 })
})

test("fallback URLs encode the query", () => {
  assert.equal(RS.fallbackUrl(RS.FALLBACKS[0], " a&b c "), "https://www.google.com/search?q=a%26b%20c")
})

test("a typed domain opens in the browser instead of being searched", () => {
  const sections = results("apple.com")
  assert.deepEqual(sections.map((s) => s.id), ["url", "fallback-commands"])
  const row = sections[0].rows[0].candidate
  assert.equal(row.id, RS.URL_ID)
  assert.equal(row.kind, "url")
  assert.equal(row.url, "https://apple.com")
  assert.equal(row.title, "apple.com")
  assert.equal(row.subtitle, "https://apple.com")
  assert.deepEqual(RS.actionsFor(row).map((a) => a.id), ["open", "copy-url"])
  assert.ok(RS.aboutFor(row, NOW).some((r) => r.label === "URL" && r.value === "https://apple.com"))
  // The Applications filter drops the command row; an empty query has none.
  assert.deepEqual(results("apple.com", ctx({ filter: "applications" })).map((s) => s.id), [])
  assert.ok(!results("").some((s) => s.id === "url"))
})

test("URL detection is conservative about ordinary searches", () => {
  assert.equal(RS.typedUrl("www.org").url, "https://www.org")
  assert.equal(RS.typedUrl("  apple.com  ").url, "https://apple.com")
  assert.equal(RS.typedUrl("https://example.com/a?b=1#c").url, "https://example.com/a?b=1#c")
  assert.equal(RS.typedUrl("http://localhost:3000/x").url, "http://localhost:3000/x")
  assert.equal(RS.typedUrl("192.168.1.1:8080").url, "https://192.168.1.1:8080")
  assert.equal(RS.typedUrl("sub.domain.co.uk/path").url, "https://sub.domain.co.uk/path")
  // An explicit scheme always wins, even for a country TLD that doubles as
  // a file extension.
  assert.equal(RS.typedUrl("https://main.rs").url, "https://main.rs")
  for (const q of ["apple pie", "1.5", "12.3.4", "notes", "notes.txt", "foo.js", "main.ts", "main.rs", "notes.md", "deploy.sh", "mailto:a@b.com", "https://", "ftp://x.com", "example.com:99999"]) {
    assert.equal(RS.typedUrl(q), null, q)
  }
})

test("web searches push a dedicated search view with a full query bar", () => {
  const google = results("google")[0].rows[0].candidate
  assert.equal(google.id, "builtin:google-search")
  assert.deepEqual(google.arguments || [], [], "no inline pill arguments")
  assert.equal(google.run.push.kind, "web-search")
  assert.equal(google.run.push.engine, "fallback:google")
  assert.equal(results("ddg")[0].rows[0].candidate.id, "builtin:duckduckgo-search")
  // The pushed view: empty query shows nothing, a typed query yields one row.
  assert.deepEqual(RS.webSearchSections("fallback:google", ""), [])
  assert.deepEqual(RS.webSearchSections("fallback:google", "   "), [])
  const sections = RS.webSearchSections("fallback:google", "hello world")
  assert.equal(sections.length, 1)
  const row = sections[0].rows[0].candidate
  assert.equal(row.id, "web-search:google")
  assert.equal(row.kind, "web-search")
  assert.equal(row.title, "Search Google")
  assert.equal(row.subtitle, "hello world")
  assert.equal(RS.fallbackUrl(RS.engineFallback("fallback:google"), "hello world"), "https://www.google.com/search?q=hello%20world")
  assert.equal(RS.builtinIdForEngine("fallback:duckduckgo"), "builtin:duckduckgo-search")
  assert.deepEqual(RS.actionsFor(row).map((a) => a.id), ["open"])
})

test("the root filter narrows by type and drops calculator and fallbacks", () => {
  const apps = results("", ctx({ filter: "applications" }))
  assert.deepEqual(apps.map((s) => s.id), ["apps"])
  const commands = results("lock", ctx({ filter: "commands", calculation: { result: "1" } }))
  assert.ok(commands.every((s) => s.id === "results"))
  assert.ok(commands[0].rows.every((r) => r.candidate.type === "command"))
  assert.deepEqual(RS.FILTERS.map((f) => f.id), ["all", "applications", "commands"])
})

test("power commands and delete-all ask for confirmation", () => {
  assert.equal(RS.confirmationFor("omarchy:system.shutdown", "open").primary, "Shut Down")
  assert.equal(RS.confirmationFor("omarchy:system.shutdown", "copy-command"), null)
  assert.equal(RS.confirmationFor("omarchy:system.lock", "open"), null)
  assert.ok(RS.confirmationFor("calculator-history:x", "delete-all-entries").destructive)
})

test("the about panel describes a row", () => {
  const lock = results("lock")[0].rows[0].candidate
  const about = Object.fromEntries(RS.aboutFor(lock, NOW).map((r) => [r.label, r.value]))
  assert.equal(about.Command, "omarchy-system-lock")
  assert.equal(about.ID, "omarchy:system.lock")
  assert.equal(about.Location, "System")
  const calc = RS.aboutFor({ kind: "calculator", calcInput: "2+2", calcResult: "4", calcResultCaption: "Four" }, NOW)
  assert.deepEqual(calc.map((r) => r.label), ["Question", "Answer", "Type"])
})
