const test = require("node:test")
const assert = require("node:assert/strict")
const { clampPosition, wordStart, wordEnd, deletionRange } = require("../core/TextCursor.js")

test("wordStart walks back over whitespace and then the word", () => {
  const text = "alpha beta  gamma"
  assert.equal(wordStart(text, text.length), 12)
  assert.equal(wordStart(text, 12), 6)
  assert.equal(wordStart(text, 11), 6)
  assert.equal(wordStart(text, 6), 0)
  assert.equal(wordStart(text, 5), 0)
  assert.equal(wordStart(text, 0), 0)
})

test("wordEnd walks forward over whitespace and then the word", () => {
  const text = "alpha beta  gamma"
  assert.equal(wordEnd(text, 0), 5)
  assert.equal(wordEnd(text, 5), 10)
  assert.equal(wordEnd(text, 10), 17)
  assert.equal(wordEnd(text, text.length), text.length)
})

test("word bounds use characters, not bytes", () => {
  assert.equal(wordStart("héllo wörld", 11), 6)
  assert.equal(wordStart("héllo wörld", 6), 0)
  assert.equal(wordEnd("héllo wörld", 0), 5)
  assert.equal(wordEnd("你好 世界", 3), 5)
  assert.equal(wordStart("你好 世界", 5), 3)
})

test("deletionRange deletes the word next to a collapsed caret", () => {
  assert.deepEqual(deletionRange("alpha beta", 10, 10, false), { start: 6, end: 10 })
  assert.deepEqual(deletionRange("alpha beta ", 11, 11, false), { start: 6, end: 11 })
  assert.deepEqual(deletionRange("alpha beta", 0, 0, true), { start: 0, end: 5 })
  assert.deepEqual(deletionRange("alpha beta", 3, 3, true), { start: 3, end: 5 })
  assert.deepEqual(deletionRange("", 0, 0, false), { start: 0, end: 0 })
  assert.deepEqual(deletionRange("", 0, 0, true), { start: 0, end: 0 })
})

test("deletionRange deletes the selection whatever the caret side", () => {
  assert.deepEqual(deletionRange("alpha beta", 8, 2, false), { start: 2, end: 8 })
  assert.deepEqual(deletionRange("alpha beta", 2, 8, true), { start: 2, end: 8 })
})

test("clampPosition keeps positions inside the text", () => {
  assert.equal(clampPosition("abc", -4), 0)
  assert.equal(clampPosition("abc", 99), 3)
  assert.equal(clampPosition("abc", 1.6), 2)
  assert.equal(clampPosition("abc", "x"), 0)
  assert.equal(clampPosition(null, 2), 0)
})
