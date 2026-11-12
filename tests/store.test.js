const test = require("node:test")
const assert = require("node:assert/strict")
const Migrate = require("../core/Migrate.js")
const Schema = require("../core/Schema.js")
const Store = require("../core/Store.js")
const Policy = require("../core/CalculatorData.js")

function store() {
  const logs = []
  const s = Store.create({ path: "/db/settings.json", migrations: Schema.settingsMigrations, Migrate, now: () => 0, log: (level, text) => logs.push([level, text]) })
  return { s, logs }
}

test("a missing file migrates to the latest schema and asks to be written", () => {
  const { s } = store()
  const r = s.ingest("")
  assert.equal(r.replaced, true)
  assert.equal(s.loaded, true)
  assert.equal(JSON.parse(r.write).schemaVersion, Schema.settingsMigrations.length)
  assert.equal(s.pendingWrite(), null, "nothing new after the first write")
})

test("updates produce one write each, and our own write coming back is ignored", () => {
  const { s } = store()
  const first = s.ingest("").write
  assert.equal(s.update((doc) => { doc.general.uiZoom = 1.2 }), true)
  const text = s.pendingWrite()
  assert.equal(JSON.parse(text).general.uiZoom, 1.2)
  assert.equal(s.ingest(text).replaced, false)
  assert.notEqual(first, text)
})

test("an unreadable or newer file is never overwritten", () => {
  const broken = store()
  broken.s.ingest("{ nope")
  assert.equal(broken.s.readOnly, true)
  assert.equal(broken.s.update(() => {}), false)
  assert.equal(broken.s.pendingWrite(), null)
  assert.match(broken.logs[0][1], /left untouched/)

  const newer = store()
  newer.s.ingest(JSON.stringify({ schemaVersion: 99, general: {}, commands: {} }))
  assert.equal(newer.s.loaded, true)
  assert.equal(newer.s.readOnly, true)
  assert.equal(newer.s.update(() => {}), false)

  const refused = store()
  refused.s.refuse("cannot read")
  assert.equal(refused.s.readOnly, true)
})

test("calculator data: rates are validated, cached and refreshed on schedule", () => {
  assert.deepEqual(Policy.validRates({ base: "EUR", date: "2026-11-12", rates: { USD: 1.1, bad: 2, GBP: -1 } }), { base: "EUR", date: "2026-11-12", rates: { USD: 1.1 } })
  assert.equal(Policy.validRates({ rates: {} }), null)
  const cached = Policy.readCache(Policy.cacheText({ base: "EUR", date: "d", rates: { USD: 1.1 } }, 42))
  assert.equal(cached.fetchedAt, 42)
  assert.equal(Policy.readCache("{"), null)
  const now = 100 * 3600 * 1000
  const due = { enabled: true, cacheRead: true, pending: false, fetchedAt: 0, triedAt: 0 }
  assert.equal(Policy.shouldFetchRates(due, now), true)
  assert.equal(Policy.shouldFetchRates({ ...due, enabled: false }, now), false)
  assert.equal(Policy.shouldFetchRates({ ...due, pending: true }, now), false)
  assert.equal(Policy.shouldFetchRates({ ...due, triedAt: now - 1000 }, now), false, "a failed try waits before retrying")
  assert.equal(Policy.shouldFetchRates({ ...due, fetchedAt: now - 1000 }, now), false)
  assert.equal(Policy.zonesStale(now - Policy.ZONES_MAX_AGE_MS - 1, now), true)
})
