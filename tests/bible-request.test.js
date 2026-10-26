const test = require("node:test")
const assert = require("node:assert/strict")
const R = require("../plugin/core/BibleRequest.js")

test("changing or clearing a query invalidates and aborts the active request", () => {
  let s = R.initial()
  let p = R.setWanted(s, "john/3/16", 0); assert.equal(p.schedule, true); s = p.state
  let begun = R.start(s, "john/3/16"); assert.equal(begun.started, true); s = begun.state
  p = R.setWanted(s, "romans/8/28", 1)
  assert.equal(p.abort, true); assert.equal(p.schedule, true); assert.equal(p.state.activeKey, "")
  const stale = R.complete(p.state, "john/3/16", begun.token, 200, true, 2)
  assert.equal(stale.accepted, false)
  p = R.setWanted(p.state, "", 3)
  assert.equal(p.schedule, false)
})

test("only the current wanted request may complete", () => {
  let s = R.setWanted(R.initial(), "john/3/16", 0).state
  const begun = R.start(s, "john/3/16"); s = begun.state
  assert.equal(R.complete(s, "john/3/16", begun.token - 1, 200, true, 1).accepted, false)
  const done = R.complete(s, "john/3/16", begun.token, 200, true, 1)
  assert.equal(done.accepted, true); assert.equal(done.state.activeKey, "")
})

test("temporary failures retry after ten seconds", () => {
  let s = R.setWanted(R.initial(), "john/3/16", 0).state
  let begun = R.start(s, "john/3/16"); s = begun.state
  let done = R.complete(s, "john/3/16", begun.token, 503, false, 1000); s = done.state
  assert.equal(R.canSchedule(s, "john/3/16", 10999), false)
  assert.equal(R.canSchedule(s, "john/3/16", 11000), true)
})

test("not-found responses use a longer negative-cache cooldown", () => {
  let s = R.setWanted(R.initial(), "john/999/1", 0).state
  let begun = R.start(s, "john/999/1"); s = begun.state
  s = R.complete(s, "john/999/1", begun.token, 404, false, 1000).state
  assert.equal(R.canSchedule(s, "john/999/1", 300999), false)
  assert.equal(R.canSchedule(s, "john/999/1", 301000), true)
})
