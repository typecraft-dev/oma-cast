const test = require("node:test")
const assert = require("node:assert/strict")
const S = require("../core/Superwhisper.js")

const now = new Date(2026, 10, 4, 15, 0).getTime()
const item = (ts, meta) => ({ timestamp: String(ts), audioPath: "/a/Output.ogg", metadata: meta })
const raw = JSON.stringify({ items: [
  item(1, { datetime: new Date(now - 86400000).toISOString(), result: "Yesterday's note", rawResult: "yesterdays note", duration: 65000, modelName: "S1-Voice", recordingDevice: "linux:input:Built-in Microphones" }),
  item(2, { datetime: new Date(now - 60000).toISOString(), result: "Start and stop", rawResult: "Start and stop" }),
  item(3, { datetime: new Date(now).toISOString(), result: "   " })
], total: 3 })

test("parses CLI history, newest first, dropping empty dictations", () => {
  const list = S.parseHistory(raw)
  assert.deepEqual(list.map((e) => e.id), ["2", "1"])
  assert.equal(list[1].device, "Built-in Microphones")
  assert.deepEqual(S.parseHistory("not json"), [])
  assert.deepEqual(S.parseHistory("{}"), [])
})

test("the history view needs history on and at least one entry", () => {
  const show = (enabled, entries) => JSON.stringify({ config: { linux: { historyEnabled: enabled } }, history: { entries } })
  assert.equal(S.historyAvailable(show(true, 873)), true)
  assert.equal(S.historyAvailable(show(false, 873)), false)
  assert.equal(S.historyAvailable(show(true, 0)), false)
  assert.equal(S.historyAvailable("oops"), false)
})

test("sections by day with search", () => {
  const list = S.parseHistory(raw)
  assert.deepEqual(S.sections(list, "", now).map((s) => s.title), ["Today", "Yesterday"])
  assert.deepEqual(S.sections(list, "NOTE", now).flatMap((s) => s.rows.map((r) => r.candidate.id)), ["superwhisper:1"])
})

test("detail and actions", () => {
  const [today, yesterday] = S.parseHistory(raw)
  const d = S.detail(yesterday)
  assert.equal(d.text, "Yesterday's note")
  assert.deepEqual(d.info.filter((r) => ["Duration", "Words", "Voice model"].includes(r.label)).map((r) => r.value), ["1 min 5 s", "2", "S1-Voice"])
  assert.deepEqual(S.actionsFor(yesterday, "Ghostty").map((a) => a.id), ["paste", "copy", "copy-raw", "open-in-superwhisper"])
  assert.ok(!S.actionsFor(today).some((a) => a.id === "copy-raw"))
})
