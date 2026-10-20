const test = require("node:test")
const assert = require("node:assert/strict")
const RowDiff = require("../plugin/core/RowDiff.js")

// A stand-in for QML's ListModel that records what the view would see:
// `resets` counts the times every delegate is destroyed (clear()), which is
// what sends a ListView back to its top.
function model(initial) {
  const items = (initial || []).map((r) => Object.assign({}, r))
  const log = { resets: 0, sets: 0, inserts: 0, removes: 0 }
  return {
    items, log,
    get count() { return items.length },
    get(i) { return items[i] },
    clear() { items.length = 0; log.resets++ },
    append(r) { items.push(Object.assign({}, r)); log.inserts++ },
    insert(i, r) { items.splice(i, 0, Object.assign({}, r)); log.inserts++ },
    remove(i, n) { items.splice(i, n || 1); log.removes++ },
    set(i, r) { items[i] = Object.assign({}, r); log.sets++ }
  }
}

const row = (id, extra) => Object.assign({ rowKind: "item", itemId: id, title: id, subtitle: "", checked: false }, extra || {})
const section = (id) => ({ rowKind: "section", itemId: "section:" + id, title: id, subtitle: "", checked: false })

function screen(n) {
  const rows = [section("results")]
  for (let i = 0; i < n; i++) rows.push(row("r" + i))
  return rows
}

test("a background refresh with the same rows changes nothing on screen", () => {
  const m = model(screen(40))
  assert.equal(RowDiff.apply(m, screen(40)), false)
  assert.deepEqual(m.log, { resets: 0, sets: 0, inserts: 0, removes: 0 })
})

test("a refresh that flips one row's state updates only that row", () => {
  const m = model(screen(40))
  const next = screen(40)
  next[25] = row("r24", { checked: true })
  assert.equal(RowDiff.apply(m, next), true)
  assert.equal(m.log.resets, 0, "no clear(): the list must not jump to the top")
  assert.equal(m.log.sets, 1)
  assert.equal(m.items[25].checked, true)
})

test("rows that arrive later are added at the end without a reset", () => {
  const m = model(screen(10))
  RowDiff.apply(m, screen(14))
  assert.equal(m.log.resets, 0)
  assert.equal(m.log.inserts, 4)
  assert.deepEqual(m.items.map((r) => r.itemId), screen(14).map((r) => r.itemId))
})

test("shrinking removes the tail in one call", () => {
  const m = model(screen(30))
  RowDiff.apply(m, screen(3))
  assert.equal(m.log.resets, 0)
  assert.equal(m.log.removes, 1)
  assert.deepEqual(m.items.map((r) => r.itemId), screen(3).map((r) => r.itemId))
})

test("a row inserted in the middle shifts the rest instead of rewriting them", () => {
  const m = model(screen(20))
  const next = screen(20)
  next.splice(5, 0, row("new"))
  RowDiff.apply(m, next)
  assert.equal(m.log.resets, 0)
  assert.equal(m.log.inserts, 1)
  assert.equal(m.log.sets, 0)
  assert.deepEqual(m.items.map((r) => r.itemId), next.map((r) => r.itemId))
})

test("a row removed from the middle is removed, not rewritten", () => {
  const m = model(screen(20))
  const next = screen(20)
  next.splice(8, 1)
  RowDiff.apply(m, next)
  assert.equal(m.log.sets, 0)
  assert.equal(m.log.removes, 1)
  assert.deepEqual(m.items.map((r) => r.itemId), next.map((r) => r.itemId))
})

test("a completely different result list ends equal to the new rows", () => {
  const m = model(screen(20))
  const next = [section("other")].concat(["a", "b", "c"].map((id) => row(id)))
  RowDiff.apply(m, next)
  assert.deepEqual(m.items, next)
})

test("random edits always converge to the new rows", () => {
  let seed = 7
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  for (let round = 0; round < 300; round++) {
    const before = screen(rand(30))
    const after = before.map((r) => Object.assign({}, r)).filter(() => rand(5) !== 0)
    for (let k = rand(4); k > 0; k--) after.splice(rand(after.length + 1), 0, row("x" + round + "-" + k, { checked: !!rand(2) }))
    if (after.length && rand(3) === 0) after[rand(after.length)].title = "changed"
    const m = model(before)
    RowDiff.apply(m, after)
    assert.deepEqual(m.items, after, "round " + round)
    assert.equal(m.log.resets, 0)
  }
})

test("indexOfItem finds the row a selection should follow", () => {
  const rows = screen(5)
  const m = model(rows)
  assert.equal(RowDiff.indexOfItem(m, "r3"), 4)
  assert.equal(RowDiff.indexOfItem(m, "section:results"), -1, "sections are not selectable")
  assert.equal(RowDiff.indexOfItem(m, "gone"), -1)
})
