const test = require("node:test")
const assert = require("node:assert/strict")
const Ranker = require("../plugin/core/Ranker.js")
const Frecency = require("../plugin/core/Frecency.js")
const OmarchyMenu = require("../plugin/core/OmarchyMenu.js")
const RootSearch = require("../plugin/core/RootSearch.js")
const Files = require("../plugin/core/Files.js")

const File = (name, isText) => Files.rowFromItem({ path: "/home/u/codes/" + name, name }, "/home/u") || null
const rows = ["README.md", "src/app.ts", "docs/guide.md"].map((name) => File(name))
const more = Files.showAllRow()

const deps = { Ranker, Frecency, OmarchyMenu }
const candidate = { id: "app:firefox", type: "application", kind: "app", title: "Firefox", subtitle: "", keywords: [], rootSearch: { when: "always" } }
const ctx = (extra) => Object.assign({ commands: {}, frecency: {}, nowMs: Date.UTC(2026, 9, 20), sensitivity: "medium" }, extra || {})

test("files come after results and before fallbacks", () => {
  const sections = RootSearch.rootSections([candidate], "readme", ctx({ includeFiles: true, fileRows: rows }), deps)
  assert.deepEqual(sections.map((s) => s.id), ["files", "fallback-commands"])
  assert.equal(sections[0].rows[0].candidate.id, "file:/home/u/codes/README.md")
  assert.equal(sections[0].rows[0].record, null)
})

test("an exact or prefix app match suppresses the files section", () => {
  const sections = RootSearch.rootSections([candidate], "fir", ctx({ includeFiles: true, fileRows: rows }), deps)
  assert.equal(sections[0].id, "results")
  assert.ok(!sections.some((s) => s.id === "files"))
})

test("files need three characters and the include flag", () => {
  assert.ok(!RootSearch.rootSections([candidate], "re", ctx({ includeFiles: true, fileRows: rows }), deps).some((s) => s.id === "files"))
  assert.ok(!RootSearch.rootSections([candidate], "readme", ctx({ includeFiles: false, fileRows: rows }), deps).some((s) => s.id === "files"))
})

test("permissive fuzzy matches are suppressed unless the name is plausible", () => {
  assert.ok(!RootSearch.rootSections([candidate], "zzoma", ctx({ includeFiles: true, fileRows: rows }), deps).some((s) => s.id === "files"))
  assert.ok(RootSearch.rootSections([candidate], "readme", ctx({ includeFiles: true, fileRows: rows }), deps).some((s) => s.id === "files"))
  assert.ok(RootSearch.rootSections([candidate], "src/app", ctx({ includeFiles: true, fileRows: rows }), deps).some((s) => s.id === "files"))
  const charon = Files.rowFromItem({ path: "/home/u/codes/charon/README.md", relativePath: "codes/charon/README.md", name: "README.md" }, "/home/u")
  assert.ok(RootSearch.rootSections([candidate], "charon", ctx({ includeFiles: true, fileRows: [charon] }), deps).some((s) => s.id === "files"))
})

test("old contexts without file fields do not throw", () => {
  const sections = RootSearch.rootSections([candidate], "readme", ctx(), deps)
  assert.equal(sections[0].id, "fallback-commands")
})

test("show-all row is rendered when the caller appends it", () => {
  const sections = RootSearch.rootSections([candidate], "readme", ctx({ includeFiles: true, fileRows: rows.concat([more]) }), deps)
  const files = sections.find((s) => s.id === "files")
  assert.equal(files.rows.length, 4)
  assert.equal(files.rows[3].candidate.kind, "files-more")
})

test("files view is a single section of cached rows", () => {
  const sections = RootSearch.filesSections(rows, "read")
  assert.equal(sections.length, 1)
  assert.deepEqual(sections[0].rows.map((r) => r.candidate.title), ["README.md", "src/app.ts", "docs/guide.md"])
  assert.deepEqual(RootSearch.filesSections([], "x"), [])
})

test("file actions return early, with editor only for text", () => {
  const text = RootSearch.actionsFor(File("src/app.ts", true))
  assert.deepEqual(text.slice(0, 2).map((a) => a.id), ["open", "open-in-editor"])
  assert.ok(text.some((a) => a.id === "copy-path") && text.some((a) => a.id === "reveal"))
  assert.ok(!text.some((a) => a.id === "favorite-add" || a.id === "set-alias" || a.id === "disable"))

  const image = RootSearch.actionsFor(File("photo.png", false))
  assert.deepEqual(image.slice(0, 1).map((a) => a.id), ["open"])
  assert.ok(!image.some((a) => a.id === "open-in-editor"))

  assert.deepEqual(RootSearch.actionsFor({ kind: "files-more" }).map((a) => a.id), ["show-all-files"])
})
