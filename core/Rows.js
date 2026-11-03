function same(current, next) {
  var keys = Object.keys(next)
  for (var i = 0; i < keys.length; i++) if (current[keys[i]] !== next[keys[i]]) return false
  return true
}

// Keep existing delegates alive across search answers, as Flea 0.3.12's StableModel does for listings.
function update(model, next) {
  var shared = Math.min(model.count, next.length)
  for (var i = 0; i < shared; i++) if (!same(model.get(i), next[i])) model.set(i, next[i])
  if (model.count > next.length) model.remove(next.length, model.count - next.length)
  if (model.count < next.length) model.append(next.slice(model.count))
}

// ListModel.get returns a mutable handle, so selection must keep a separate value.
function snapshot(model, index) {
  return index >= 0 && index < model.count ? Object.assign({}, model.get(index)) : null
}

if (typeof module !== "undefined") module.exports = { update, snapshot }
