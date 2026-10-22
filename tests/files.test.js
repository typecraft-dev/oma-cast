const test = require("node:test")
const assert = require("node:assert/strict")
const Files = require("../plugin/core/Files.js")

test("rows map FFF items and shorten an exact home prefix", () => {
  const row = Files.rowFromItem({ path: "/home/u/codes/app/src/app.ts", name: "app.ts" }, "/home/u")
  assert.equal(row.id, "file:/home/u/codes/app/src/app.ts")
  assert.equal(row.kind, "file")
  assert.equal(row.title, "app.ts")
  assert.equal(row.subtitle, "~/codes/app/src")
  assert.equal(row.isText, true)
  assert.equal(row.iconName, "text-x-generic")
  assert.equal(Files.shortenHome("/home/u2/x", "/home/u"), "/home/u2/x")
  assert.equal(Files.shortenHome("/home/u", "/home/u"), "~")
})

test("invalid items are dropped", () => {
  assert.equal(Files.rowFromItem(null, "/home/u"), null)
  assert.equal(Files.rowFromItem({ path: "relative.ts", name: "relative.ts" }, "/home/u"), null)
  assert.equal(Files.rowFromItem({ path: "/x", name: "" }, "/home/u").title, "x")
})

test("display names are sanitized but paths stay untouched", () => {
  assert.equal(Files.sanitizeName("a\nb\tc"), "a b c")
  assert.equal(Files.sanitizeName("evil\u202egnp.exe"), "evilgnp.exe")
  assert.equal(Files.sanitizeName("\u200b"), "Unnamed file")
})

test("text and icon classification", () => {
  for (const name of ["a.ts", "README", "Makefile", "config.yml", "build.nix"]) {
    assert.equal(Files.isTextLike(name), true, name)
  }
  assert.equal(Files.isTextLike("photo.png"), false)
  assert.equal(Files.iconFor("photo.png"), "image-x-generic")
  assert.equal(Files.iconFor("doc.pdf"), "application-pdf")
  assert.equal(Files.iconFor("archive.tar"), "package-x-generic")
  assert.equal(Files.iconFor("whatever.bin"), "text-x-generic")
})

test("rowsFromResponse caps at the view limit and filters bad items", () => {
  const items = []
  for (let i = 0; i < 80; i++) items.push({ path: `/home/u/f${i}.txt`, name: `f${i}.txt` })
  items.push({ path: "bad", name: "bad" })
  const rows = Files.rowsFromResponse({ items }, "/home/u")
  assert.equal(rows.length, Files.VIEW_FILE_LIMIT)
  assert.equal(rows[0].title, "f0.txt")
})

test("root rows cap at three and add Show All only when there are more", () => {
  const rows = ["a", "b", "c", "d"].map((name) => Files.rowFromItem({ path: `/h/${name}`, name }, "/h"))
  assert.deepEqual(Files.rootRows(rows).map((r) => r.title), ["a", "b", "c"])
  assert.equal(Files.isShowAllId(Files.showAllRow().id), true)
  assert.equal(Files.isFileId(rows[0].id), true)
  assert.equal(Files.isFileId("files:more"), false)
})

test("stale responses are only current when both queries match", () => {
  assert.equal(Files.isCurrent("a", "a", "a"), true)
  assert.equal(Files.isCurrent("a", "b", "b"), false)
  assert.equal(Files.isCurrent("a", "a", "b"), false)
})
