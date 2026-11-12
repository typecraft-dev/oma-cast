const test = require("node:test")
const assert = require("node:assert/strict")
const { update, snapshot } = require("../core/Rows.js")

test("stable updates keep unchanged rows and batch additions without resetting the model", () => {
  const records = [{ itemId: "a", title: "A" }, { itemId: "b", title: "B" }], calls = []
  const first = records[0]
  const model = {
    get count() { return records.length }, get(i) { return records[i] },
    set(i, data) { calls.push("set"); records[i] = data },
    remove(i, n) { calls.push("remove"); records.splice(i, n) },
    append(data) { calls.push("append"); records.push(...data) }
  }
  update(model, [{ ...first }, { itemId: "c", title: "C" }, { itemId: "d", title: "D" }])
  assert.equal(records[0], first)
  assert.deepEqual(calls, ["set", "append"])
  calls.length = 0
  update(model, [{ ...first }])
  assert.deepEqual(calls, ["remove"])
  assert.equal(records[0], first)
  update(model, [])
  assert.equal(records.length, 0)
})
