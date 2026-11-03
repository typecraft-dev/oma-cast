const test = require("node:test")
const assert = require("node:assert/strict")
const Log = require("../core/Log.js")

test("levels filter by threshold, unknown levels count as info", () => {
  assert.ok(Log.shouldLog("error", "info"))
  assert.ok(!Log.shouldLog("debug", "info"))
  assert.ok(Log.shouldLog("bogus", "info"))
  assert.ok(!Log.shouldLog("bogus", "warning"))
})

test("lines carry level, category and one-line metadata", () => {
  assert.equal(Log.format("warning", "store", "slow", { ms: 3 }), '[omacast] [warning] [store] slow {"ms":3}')
  assert.equal(Log.format("info", "", "hi"), "[omacast] [info] hi")
})
