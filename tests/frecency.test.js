const test = require("node:test")
const assert = require("node:assert/strict")
const F = require("../plugin/core/Frecency.js")

const T = 1_800_000_000
const DAY = 86400
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)

test("unvisited and malformed anchors score 1", () => {
  assert.equal(F.score(null, T), 1)
  assert.equal(F.score(undefined, T), 1)
  assert.equal(F.score(NaN, T), 1)
  assert.equal(F.score(T - 100 * DAY, T), 1)
})

test("a first visit scores 101 and halves every 10 days", () => {
  const anchor = F.visit(null, T)
  near(F.score(anchor, T), 101)
  near(F.score(anchor, T + 10 * DAY), 50.5)
  near(F.score(anchor, T + 20 * DAY), 25.25)
})

test("each visit adds 100 to the decayed score", () => {
  const a1 = F.visit(null, T)
  const a2 = F.visit(a1, T + 10 * DAY)
  near(F.score(a2, T + 10 * DAY), 150.5)
  const a3 = F.visit(a2, T + 10 * DAY)
  near(F.score(a3, T + 10 * DAY), 250.5)
})

test("the exp overflow guard keeps scores finite", () => {
  const huge = F.visit(T + 1e9 * DAY, T)
  assert.ok(Number.isFinite(huge))
  assert.ok(Number.isFinite(F.score(T + 1e9 * DAY, T)))
})

test("recordVisit stores anchor, openedAt and deduped lowercased terms", () => {
  const nowMs = T * 1000
  let e = F.recordVisit(null, nowMs, "  Fir ")
  assert.deepEqual(e.searchTerms, [{ term: "fir", at: nowMs }])
  assert.equal(e.openedAt, nowMs)
  near(F.score(e.anchor, T), 101)
  e = F.recordVisit(e, nowMs + 1000, "ff")
  e = F.recordVisit(e, nowMs + 2000, "FIR")
  assert.deepEqual(e.searchTerms.map((t) => t.term), ["ff", "fir"])
  e = F.recordVisit(e, nowMs + 3000, "")
  assert.equal(e.searchTerms.length, 2)
  for (let i = 0; i < 30; i++) e = F.recordVisit(e, nowMs + 4000 + i, "q" + i)
  assert.equal(e.searchTerms.length, F.MAX_SEARCH_TERMS)
  assert.equal(e.searchTerms[e.searchTerms.length - 1].term, "q29")
})

test("the search-term window is 17 days", () => {
  assert.equal(F.SEARCH_TERM_WINDOW_MS, 17 * DAY * 1000)
})
