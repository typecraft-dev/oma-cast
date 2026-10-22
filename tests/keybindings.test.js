const test = require("node:test")
const assert = require("node:assert/strict")
const KB = require("../plugin/core/Keybindings.js")
const Ranker = require("../plugin/core/Ranker.js")
const RS = require("../plugin/core/RootSearch.js")

const output = `SUPER SHIFT + F                    → File manager
SUPER + W / SUPER + Q               → Close window
SUPER SHIFT + H                     → Notion
SUPER SHIFT + RETURN                → Browser
SUPER + code:20                     → Custom → action
`

test("parses live display records, alternate chords and custom descriptions", () => {
  const rows = KB.parse(output)
  assert.equal(rows.length, 5)
  assert.equal(rows[0].shortcutKeys, "Super Shift F")
  assert.equal(rows[1].shortcutKeys, "Super W / Super Q")
  assert.equal(rows[3].shortcutKeys, "Super Shift Return")
  assert.equal(rows[4].title, "Custom → action")
  assert.deepEqual(KB.parse(output + output), rows)
  assert.deepEqual(KB.parse("invalid\n → no chord\nSUPER + X → "), [])
})

test("stable IDs do not depend on ordering or padding", () => {
  const original = KB.parse(output)[0]
  const refreshed = KB.parse("SUPER SHIFT + H → Notion\nSUPER SHIFT + F → File manager")[1]
  assert.equal(original.id, refreshed.id)
})

test("finds actions, personal bindings, chords with or without plus, and fuzzy text", () => {
  const rows = KB.parse(output)
  for (const query of ["file manager", "super shift f", "Super+Shift+F", "fl mgr"])
    assert.equal(KB.search(rows, query, Ranker)[0].title, "File manager", query)
  assert.equal(KB.search(rows, "notion", Ranker)[0].title, "Notion")
  assert.deepEqual(KB.search(rows, "", Ranker), rows)
  assert.deepEqual(KB.search(rows, "zzzz-unmatched", Ranker), [])
})

test("shortcut rows only offer copying, and markup stays literal data", () => {
  const row = KB.parse('SUPER + X → <img src="https://example.invalid/tracker">')[0]
  assert.equal(row.title, '<img src="https://example.invalid/tracker">')
  assert.deepEqual(RS.actionsFor(row).map(action => action.id), ["copy-shortcut"])
})

test("a single letter in a chord matches the key, not letters inside Shift", () => {
  const rows = KB.parse("SUPER SHIFT + RETURN → Browser\nSUPER SHIFT + F → File manager")
  assert.equal(KB.search(rows, "super+shift+f", Ranker)[0].title, "File manager")
})

test("chord searches do not combine alternative chords or match a different key", () => {
  const rows = KB.parse("SUPER + W / SUPER SHIFT + Q → Close window\nSUPER + F20 → Other")
  assert.deepEqual(KB.search(rows, "super shift w", Ranker), [])
  assert.deepEqual(KB.search(rows, "super f2", Ranker), [])
  assert.equal(KB.search(rows, "super shift q", Ranker)[0].title, "Close window")
})

test("exact chords rank above chords with extra modifiers", () => {
  const rows = KB.parse("SUPER ALT + F → Full width\nSUPER + F → Full screen")
  assert.deepEqual(KB.search(rows, "super f", Ranker).map(row => row.title), ["Full screen", "Full width"])
})
