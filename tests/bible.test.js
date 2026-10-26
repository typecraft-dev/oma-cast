const test = require("node:test")
const assert = require("node:assert/strict")
const Bible = require("../plugin/core/Bible.js")
test("parses common Bible references and same-chapter intervals", () => {
  assert.deepEqual(Bible.parseReference("John 3:16"), { book: "John", slug: "john", code: "JHN", chapter: 3, verse: 16, verseEnd: 16, range: false, reference: "John 3:16", key: "john/3/16" })
  assert.equal(Bible.parseReference("1 Cor. 13:4–7").reference, "1 Corinthians 13:4–7")
  assert.equal(Bible.parseReference("ps 23:1-4").key, "psalms/23/1-4")
  assert.equal(Bible.parseReference("John3:16").key, "john/3/16")
  assert.equal(Bible.parseReference("Jn3:16").reference, "John 3:16")
  assert.equal(Bible.parseReference("1Cor13:4-7").reference, "1 Corinthians 13:4–7")
})
test("rejects ordinary searches, reversed ranges, and unknown books", () => {
  assert.equal(Bible.parseReference("mark 3"), null); assert.equal(Bible.parseReference("John 3:18-16"), null); assert.equal(Bible.parseReference("Narnia 1:1"), null)
})
test("builds API and source URLs", () => {
  const ref = Bible.parseReference("John 3:16-18")
  assert.equal(Bible.apiUrl(ref), "https://api.midvash.com/v1/web/john/3/16-18")
  assert.equal(Bible.fallbackApiUrl(ref), "https://bible-api.com/John%203%3A16-18?translation=web")
  assert.equal(Bible.sourceUrl(ref), "https://ebible.org/study/?w1=bible&t1=local%3Aeng-web&v1=JN3_16")
})
test("a range displays only its first verse followed by an ellipsis", () => {
  const got = Bible.result(Bible.parseReference("John 3:16-18"), { data: { verses: ["First verse.", "Second verse."] } })
  assert.equal(got.text, "First verse. …"); assert.equal(got.copy, "First verse."); assert.equal(got.translation, "World English Bible (WEB)")
})

test("normalizes the fallback provider response", () => {
  const ref = Bible.parseReference("John3:16-18")
  const got = Bible.fallbackResult(ref, { verses: [{ text: "  First\n verse.  " }, { text: "Second." }] })
  assert.equal(got.text, "First verse. …")
  assert.equal(got.copy, "First verse.")
})
