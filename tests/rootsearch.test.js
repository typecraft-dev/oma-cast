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
  assert.deepEqual(titles(sections[0]), ["Search Google", "Search DuckDuckGo"])
})

test("an exact alias puts its command on top (Phase 1 accept)", () => {
  const c = ctx({ commands: { "app:chromium": { alias: "ff" } } })
  assert.equal(titles(results("ff", c)[0])[0], "Chromium")
  assert.equal(titles(results("f", c)[0])[0], "Chromium", "an alias prefix also wins over title scores")
})

test("launching bumps frecency and teaches the query (Phase 1 accept)", () => {
  // Chromium and Signal tie for "i" on title score alone; a launch decides it.
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
  assert.equal(sections[0].id, "fallback-commands")
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

// Screenshots view (local addition).
const shots = [
  { path: "/s/screenshot-2026-10-19_09-05-07.png", name: "screenshot-2026-10-19_09-05-07.png", modifiedMs: NOW - 3600e3, versions: [
    { path: "/s/.edits/screenshot-2026-10-19_09-05-07/original.png", name: "original.png", modifiedMs: NOW - 7200e3 },
    { path: "/s/.edits/screenshot-2026-10-19_09-05-07/edit-2026-10-19_10-00-00.png", name: "edit-2026-10-19_10-00-00.png", modifiedMs: NOW - 3600e3 },
    { path: "/s/.edits/screenshot-2026-10-19_09-05-07/edit-2026-10-19_10-00-00-2.png", name: "edit-2026-10-19_10-00-00-2.png", modifiedMs: NOW - 3600e3 }
  ] },
  { path: "/s/old.png", name: "old.png", modifiedMs: NOW - 5 * 86400e3, versions: [] }
]

test("screenshots: today and earlier, readable titles, edit count", () => {
  const sections = RS.screenshotSections(shots, "", NOW)
  assert.deepEqual(sections.map((s) => s.title), ["Today", "Earlier"])
  const first = sections[0].rows[0].candidate
  assert.equal(first.title, "2026-10-19 09:05:07")
  assert.equal(first.subtitle, "PNG · 2 edits")
  assert.equal(first.hasVersions, true)
  assert.equal(first.imagePath, "/s/screenshot-2026-10-19_09-05-07.png")
  assert.equal(sections[1].rows[0].candidate.title, "old")
  assert.equal(RS.screenshotSections(shots, "OLD", NOW).length, 1)
})

test("screenshots: versions newest first, original last", () => {
  const rows = RS.versionSections(shots[0], NOW)[0].rows.map((r) => r.candidate)
  assert.deepEqual(rows.map((c) => c.title), ["Latest edit", "Edit", "Original"])
  assert.equal(rows[0].subtitle, "2026-10-19 10:00:00")
  assert.equal(rows[0].id, "screenshot-version:screenshot-2026-10-19_09-05-07.png/edit-2026-10-19_10-00-00-2.png")
  assert.deepEqual(RS.versionSections(shots[1], NOW), [])
})

test("screenshots: actions", () => {
  assert.deepEqual(RS.actionsFor({ kind: "screenshot", hasVersions: false }).map((a) => a.id), ["edit-screenshot", "view-screenshot", "convert", "copy-image", "copy-path", "show-in-files"])
  assert.ok(RS.actionsFor({ kind: "screenshot", hasVersions: true }).some((a) => a.id === "edit-original"))
  assert.equal(RS.actionsFor({ kind: "screenshot-version" })[0].id, "edit-version")
})

test("screenshots: a converted copy says what it is", () => {
  const c = RS.screenshotCandidate({ path: "/s/x", name: "screenshot-2026-10-21_19-38-52-medium.jpg", modifiedMs: NOW, bytes: 377382, versions: [] }, NOW)
  assert.equal(c.title, "2026-10-21 19:38:52")
  assert.equal(c.subtitle, "JPG · medium-size copy · 377 KB")
  const o = RS.screenshotCandidate({ path: "/s/y", name: "screenshot-2026-10-21_19-38-52.png", modifiedMs: NOW, bytes: 1725209, versions: [] }, NOW)
  assert.equal(o.subtitle, "PNG · 1.7 MB")
})
