// Updates the launcher's row ListModel in place instead of clear() + refill.
//
// clear() destroys every delegate, so a ListView that the user has scrolled
// snaps back to its top whenever rows are rebuilt; background refreshes
// (guards, provider items, frecency) rebuild while the window is open. This
// keeps the rows the old and new lists share — matched by rowKind + itemId
// from both ends — touches a shared row only when one of its fields changed,
// and inserts or removes only the rows in between.
//
// Loaded both by QML (`import "../core/RowDiff.js" as RowDiff`) and by
// node --test, so it stays plain ES5 with no QML globals.

function sameKey(a, b) {
  return a.rowKind === b.rowKind && a.itemId === b.itemId
}

function sameFields(current, next) {
  for (var k in next) if (current[k] !== next[k]) return false
  return true
}

// Makes `model` (ListModel-like: count, get, set, insert, remove) equal to
// the array `next` of row objects. Returns whether anything changed.
function apply(model, next) {
  var oldCount = model.count
  var newCount = next.length

  var head = 0
  while (head < oldCount && head < newCount && sameKey(model.get(head), next[head])) head++
  var tail = 0
  while (tail < oldCount - head && tail < newCount - head
         && sameKey(model.get(oldCount - 1 - tail), next[newCount - 1 - tail])) tail++

  var oldMid = oldCount - head - tail
  var newMid = newCount - head - tail
  var rewrite = Math.min(oldMid, newMid)

  var changed = oldMid > 0 || newMid > 0
  for (var i = 0; i < head; i++) {
    if (sameFields(model.get(i), next[i])) continue
    model.set(i, next[i])
    changed = true
  }
  for (var r = 0; r < rewrite; r++) model.set(head + r, next[head + r])
  if (oldMid > newMid) model.remove(head + rewrite, oldMid - newMid)
  for (var n = rewrite; n < newMid; n++) model.insert(head + n, next[head + n])
  for (var t = 0; t < tail; t++) {
    var at = newCount - tail + t
    if (sameFields(model.get(at), next[at])) continue
    model.set(at, next[at])
    changed = true
  }
  return changed
}

function indexOfItem(model, id) {
  if (!id) return -1
  for (var i = 0; i < model.count; i++) {
    var row = model.get(i)
    if (row.rowKind === "item" && row.itemId === id) return i
  }
  return -1
}

if (typeof module !== "undefined") {
  module.exports = {
    apply: apply,
    indexOfItem: indexOfItem
  }
}
