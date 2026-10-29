const test = require("node:test")
const assert = require("node:assert/strict")
const { update, snapshot } = require("../plugin/core/Rows.js")

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


test("a failed search removes retained rows before they can be clicked", () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm")
  const source = fs.readFileSync(path.join(__dirname, "../plugin/ui/LauncherWindow.qml"), "utf8")
  const start = source.indexOf("  function applySearch(")
  const body = source.slice(source.indexOf("{", start) + 1, source.indexOf("\n  }", start))
  const records = [{ itemId: "old-result" }]
  const rows = { get count() { return records.length }, remove(at, n) { records.splice(at, n) } }
  let selection = 0, error = ""
  const window = { showToast(_, message) { error = message }, select(index) { selection = index } }
  vm.runInNewContext("(function() {" + body + "})()", { result: { ok: false, error: "Search unavailable" }, window, rows, Rows: { update } })
  assert.equal(records.length, 0)
  assert.equal(selection, -1)
  assert.equal(error, "Search unavailable")
})


test("selection is a value snapshot across in-place model changes", () => {
  const handle = { itemId: "old", title: "Old", argsJson: "[]" }
  const model = { count: 1, get() { return handle } }
  const selected = snapshot(model, 0)
  handle.itemId = "new"
  handle.title = "New"
  assert.equal(selected.itemId, "old")
  assert.equal(selected.title, "Old")
  assert.equal(snapshot(model, 0).itemId, "new")
  assert.equal(snapshot(model, -1), null)
})
