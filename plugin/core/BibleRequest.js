// Pure lifecycle state for the asynchronous Bible lookup. QML owns the XHR;
// this module decides which request is current, when failures may retry, and
// whether a completion is stale.
function initial() { return { wantedKey: "", activeKey: "", token: 0, failures: ({}) } }

function copy(state) {
  return { wantedKey: state.wantedKey || "", activeKey: state.activeKey || "", token: Number(state.token) || 0,
    failures: Object.assign({}, state.failures || {}) }
}

function setWanted(state, key, now) {
  var next = copy(state), wanted = String(key || "")
  if (next.wantedKey === wanted) return { state: next, changed: false, abort: false, schedule: canSchedule(next, wanted, now) }
  var abort = !!next.activeKey
  next.wantedKey = wanted
  next.activeKey = ""
  if (abort) next.token++ // makes an abort callback stale before xhr.abort()
  return { state: next, changed: true, abort: abort, schedule: canSchedule(next, wanted, now) }
}

function canSchedule(state, key, now) {
  var wanted = String(key || "")
  return !!wanted && state.wantedKey === wanted && !state.activeKey && Number((state.failures || {})[wanted] || 0) <= now
}

function start(state, key) {
  var next = copy(state), wanted = String(key || "")
  if (!wanted || next.wantedKey !== wanted || next.activeKey) return { state: next, started: false, token: next.token }
  next.activeKey = wanted
  next.token++
  return { state: next, started: true, token: next.token }
}

function complete(state, key, token, status, ok, now) {
  var next = copy(state), wanted = String(key || "")
  if (next.activeKey !== wanted || next.wantedKey !== wanted || next.token !== token)
    return { state: next, accepted: false }
  next.activeKey = ""
  if (ok) delete next.failures[wanted]
  else next.failures[wanted] = now + (status === 404 ? 5 * 60 * 1000 : 10 * 1000)
  return { state: next, accepted: true, retryAt: next.failures[wanted] || 0 }
}

if (typeof module !== "undefined") module.exports = {
  initial: initial, setWanted: setWanted, canSchedule: canSchedule, start: start, complete: complete
}
