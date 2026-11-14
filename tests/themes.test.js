const test = require("node:test")
const assert = require("node:assert/strict")
const T = require("../core/Themes.js")

const rows = [
  "/c/previews/tokyo-night.png\t/c/thumbs/a.jpg",
  "/c/previews/catppuccin-latte.png\t/c/thumbs/b.jpg",
  "/c/previews/last-horizon.mp4\t/c/thumbs/c.jpg",
  "",
  "/c/previews/tokyo-night.jpg\t/c/thumbs/d.jpg"
].join("\n")

test("parses Omarchy's picker rows into sorted themes", () => {
  const themes = T.parseRows(rows)
  assert.deepEqual(themes.map((t) => t.name), ["Catppuccin Latte", "Last Horizon", "Tokyo Night"])
  assert.equal(themes[1].image, "/c/thumbs/c.jpg")
  assert.equal(themes[2].image, "/c/previews/tokyo-night.png")
  assert.equal(T.displayName("rose-pine"), "Rose Pine")
})

test("checks the current theme, searches, and labels the action", () => {
  const themes = T.parseRows(rows)
  const list = T.sections(themes, "tokyo-night", "")[0].rows.map((r) => r.candidate)
  assert.deepEqual(list.filter((c) => c.checked).map((c) => c.id), ["theme:tokyo-night"])
  assert.deepEqual(T.sections(themes, "", "latte")[0].rows.map((r) => r.candidate.title), ["Catppuccin Latte"])
  assert.deepEqual(T.sections(themes, "", "zzz"), [])
  assert.equal(T.actionsFor(themes[2], "tokyo-night")[0].title, "Reapply Theme")
  assert.equal(T.detail(themes[0], "x").image, "/c/previews/catppuccin-latte.png")
})
