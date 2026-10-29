const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const F = require("../plugin/core/FleaSearch.js")
const R = require("../plugin/core/Ranker.js")

const source = fs.readFileSync(path.join(__dirname, "../plugin/services/NativeSearch.qml"), "utf8")
function harness() {
  const events = [], writes = []
  const service = { entries: [{ title: "Files" }], ids: ["files"], serial: 0, loadId: 0, loaded: false, disabled: false, pending: null, failed: m => events.push(m) }
  const helper = { running: false, write: s => writes.push(JSON.parse(s)) }
  const timeout = { active: false, restart() { this.active = true }, stop() { this.active = false } }
  const context = vm.createContext({ service, helper, timeout, FleaSearch: F })
  for (const name of ["cancel", "invalidate", "search", "load", "send", "fail", "receive"]) {
    const start = source.indexOf("  function " + name + "(")
    const end = source.indexOf("\n  }", start) + 4
    vm.runInContext(source.slice(start, end).trim(), context)
    service[name] = context[name]
  }
  return { service, helper, timeout, events, writes, reply: obj => service.receive(JSON.stringify(obj)) }
}
const hit = { index: 0, title: 4000000, alternate: null, subtitle: null, keyword: null }

test("native service waits for load, suppresses stale replies, and cancels hidden queries", () => {
  const h = harness(), got = []
  h.service.search("fi", "medium", r => got.push(r))
  const first = h.service.pending.id
  h.service.load()
  h.reply({ id: h.service.loadId, loaded: 1 })
  assert.equal(h.writes.at(-1).query, "fi")
  h.service.search("files", "medium", r => got.push(r))
  h.reply({ id: first, hits: [hit] })
  assert.equal(got.length, 0)
  h.reply({ id: h.service.pending.id, hits: [hit] })
  assert.equal(got[0].files.title, 4000000)
  assert.equal(h.timeout.active, false)
  h.service.search("new", "medium", r => got.push(r))
  const hidden = h.service.pending.id
  h.service.cancel()
  h.reply({ id: hidden, hits: [hit] })
  assert.equal(got.length, 1)
})

test("candidate reload cannot apply a reply using the previous index", () => {
  const h = harness(), got = []
  h.service.loaded = true
  h.helper.running = true
  h.service.search("fi", "medium", r => got.push(r))
  const stale = h.service.pending.id
  h.service.entries = [{ title: "Firefox" }]
  h.service.ids = ["firefox"]
  h.service.invalidate()
  assert.deepEqual(got, [null])
  h.reply({ id: stale, hits: [hit] })
  assert.deepEqual(got, [null])
  h.service.search("fire", "medium", r => got.push(r))
  h.reply({ id: h.service.loadId, loaded: 1 })
  h.reply({ id: h.service.pending.id, hits: [hit] })
  assert.equal(got[1].firefox.title, 4000000)
})

test("malformed replies, invalid scores and service failures all permit fallback", () => {
  for (const reply of ["not json", '{"id":1}', JSON.stringify({ id: 1, hits: [{ ...hit, title: "500" }] })]) {
    const h = harness(), got = []
    h.service.search("bad", "medium", r => got.push(r))
    h.service.receive(reply)
    assert.deepEqual(got, [null])
    assert.equal(h.service.disabled, true)
    assert.equal(h.helper.running, false)
  }
  const h = harness(), got = []
  h.service.search("one", "medium", r => got.push(r))
  h.service.fail("missing executable or timeout")
  h.service.fail("late exit")
  h.service.search("two", "medium", r => got.push(r))
  assert.deepEqual(got, [null, null])
})

test("protocol rejects duplicate entries and bounds, and folds native input like the ranker", () => {
  assert.throws(() => F.hits({ hits: [hit, hit] }, ["x"]), /repeats/)
  assert.throws(() => F.hits({ hits: [{ ...hit, index: 1 }] }, ["x"]), /index/)
  assert.throws(() => F.hits({ hits: [{ index: 0 }] }, ["x"]), /score/)
  assert.equal(F.entries([{ title: "Café", keywords: ["Straße"] }], R.transliterate)[0].keywords[0], "Strasse")
})

test("native scores retain exact aliases, learning, pins, alternate names and frecency", () => {
  const c = [
    { id: "long", title: "Firefox Developer Edition", type: "application" },
    { id: "short", title: "Firefox", type: "application" },
    { id: "alias", title: "Unrelated", alias: "fir", type: "application" }
  ]
  const scores = { long: { ...hit }, short: { ...hit } }
  const ids = extra => R.rank(c, "fir", { fleaHits: scores, nowMs: 1000, ...extra }).map(r => r.candidate.id)
  assert.deepEqual(ids(), ["alias", "short", "long"])
  c[0].frecency = 100
  assert.deepEqual(ids(), ["alias", "long", "short"])
  c[1].pinPriority = 1
  assert.equal(ids()[0], "short")
  delete c[1].pinPriority
  c[1].frecency = 100
  assert.equal(ids()[1], "short")
  c[0].openedAt = 1000
  c[0].searchTerms = ["fir"]
  assert.equal(ids()[1], "long")
  scores.short = { ...hit, title: null, alternate: 5000000 }
  assert.equal(R.buildRecord(c[1], "fir", { fleaHits: scores }).titleMatch, "exact")
})


test("obsolete errors cannot disable a newer valid request", () => {
  const h = harness(), got = []
  h.service.loaded = true
  h.helper.running = true
  h.service.search("old", "unsupported", r => got.push(r))
  const old = h.service.pending.id
  h.service.search("new", "medium", r => got.push(r))
  h.reply({ id: old, error: "unsupported sensitivity" })
  assert.equal(h.service.disabled, false)
  assert.equal(got.length, 0)
  h.reply({ id: h.service.pending.id, hits: [hit] })
  assert.equal(got.length, 1)
})

test("all-null hits trigger fallback instead of phantom results", () => {
  const invalid = harness(), got = []
  invalid.service.search("fi", "medium", r => got.push(r))
  invalid.reply({ id: invalid.service.pending.id, hits: [{ ...hit, title: null }] })
  assert.equal(invalid.service.disabled, true)
  assert.equal(got.at(-1), null)
})

test("keyword-only tiers rank exact ahead of typo while titles keep priority", () => {
  const c = [{ id: "typo", title: "Alpha", frecency: 100 }, { id: "exact", title: "Zulu", frecency: 1 }]
  const fleaHits = {
    typo: { title: null, alternate: null, subtitle: null, keyword: 999000 },
    exact: { title: null, alternate: null, subtitle: null, keyword: 5000000 }
  }
  assert.deepEqual(R.rank(c, "browser", { fleaHits }).map(r => r.candidate.id), ["exact", "typo"])
  fleaHits.typo.title = 2000001
  assert.equal(R.rank(c, "browser", { fleaHits })[0].candidate.id, "typo")
})
