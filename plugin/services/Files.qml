import QtQuick
import Quickshell
import Quickshell.Io
import "../core/Files.js" as Files

// File-search sidecar (docs/file-search.md §4–5). Owns the process,
// protocol, status snapshot and the row cache. The launcher never blocks on it.
Item {
  id: service

  property bool enabled: false
  property string root: "~"
  property string home: ""
  property var helperCandidates: []
  property string frecencyDb: ""
  property string runtimeDir: ""
  property bool followSymlinks: false

  property int binaryIndex: 0
  readonly property string binary: helperCandidates.length > 0 ? String(helperCandidates[Math.min(binaryIndex, helperCandidates.length - 1)] || "") : ""

  property string spawnRoot: "~"
  property bool active: false
  property bool ready: false
  property bool protocolOk: false
  property bool stopping: false
  property string state: "stopped"          // stopped|disabled|starting|scanning|ready|error
  property var status: ({ state: "stopped" })
  property string lastError: ""
  property bool helperMissing: false
  property bool missingNotified: false

  property var rows: []
  property string rowsQuery: ""
  property int rowsTotal: 0
  property var rowsById: ({})
  property int revision: 0
  property int statusRevision: 0

  property var pending: ({})
  property var inFlight: null
  property string desiredQuery: ""
  property string queuedQuery: ""
  property var controlQueue: []
  property int nextId: 1
  property int restartAttempts: 0
  property string pendingReindex: ""

  signal message(string level, string text, var metadata)
  signal helperUnavailable()

  readonly property bool loading: state === "starting" || state === "scanning"

  function logDebug(line) {
    service.message("debug", String(line), null)
  }

  function start() {
    if (!service.enabled) return
    if (!service.binary) {
      service.markMissing()
      return
    }
    if (service.active) return
    service.spawnRoot = service.root
    service.stopping = false
    service.helperMissing = false
    service.state = "starting"
    service.active = true
  }

  function stop() {
    if (!service.active && !proc.running) {
      service.state = "stopped"
      service.status = ({ state: "stopped" })
      service.statusRevision++
      return
    }
    service.stopping = true
    if (service.ready) service.call("shutdown", {})
    service.active = false
    service.state = "stopped"
    service.status = ({ state: "stopped" })
    service.statusRevision++
    stopTimer.restart()
  }

  function retry() {
    service.binaryIndex = 0
    service.helperMissing = false
    service.missingNotified = false
    service.lastError = ""
    service.restartAttempts = 0
    if (service.active) {
      service.active = false
      Qt.callLater(function() { service.start() })
    } else {
      service.start()
    }
  }

  function markMissing() {
    service.helperMissing = true
    service.active = false
    service.ready = false
    service.protocolOk = false
    service.state = "error"
    service.lastError = "helper-missing"
    if (!service.missingNotified) {
      service.missingNotified = true
      service.helperUnavailable()
    }
  }

  // Called from LauncherWindow on every query change. Empty clears the cache;
  // a non-empty query is sent once the helper is ready.
  function request(query) {
    var q = String(query || "")
    service.desiredQuery = q
    service.queuedQuery = ""
    if (!service.enabled || !q) {
      service.setRows([], "", 0)
      return
    }
    if (service.helperMissing) return
    if (!service.active) service.start()
    if (!service.ready || !service.protocolOk || service.state !== "ready" || service.helperMissing) return
    if (service.inFlight) {
      if (service.inFlight.query !== q) service.queuedQuery = q
      return
    }
    service.sendSearch(q)
  }

  function sendSearch(query) {
    if (!service.ready || !service.protocolOk || service.state !== "ready") return
    var id = service.nextId++
    service.pending[id] = { method: "search", query: query }
    service.inFlight = { id: id, query: query }
    service.send({ id: id, method: "search", params: { query: query, limit: Files.VIEW_FILE_LIMIT } })
  }

  function track(path) {
    if (!service.enabled || !path) return
    var item = { method: "track", params: { path: String(path) } }
    if (!service.ready || !service.protocolOk) {
      service.controlQueue.push(item)
      return
    }
    var id = service.nextId++
    service.pending[id] = { method: "track" }
    service.send({ id: id, method: item.method, params: item.params })
  }

  function reindex(nextRoot) {
    service.spawnRoot = String(nextRoot || service.root)
    service.setRows([], "", 0)
    if (service.active && service.ready && service.protocolOk) {
      service.call("reindex", { root: service.spawnRoot })
      service.pendingReindex = ""
      service.state = "scanning"
      service.statusRevision++
      statusTimer.restart()
    } else {
      service.pendingReindex = service.spawnRoot
    }
  }

  function resetRanking() {
    if (!service.active) {
      // No helper owns the LMDB, so deleting it is enough.
      Quickshell.execDetached(["rm", "-rf", service.frecencyDb])
      service.setRows([], "", 0)
      service.statusRevision++
      return
    }
    if (service.active && service.ready && service.protocolOk) {
      service.call("reset", {})
      service.setRows([], "", 0)
      service.state = "scanning"
      service.statusRevision++
      statusTimer.restart()
    }
  }

  function send(object) {
    if (!proc.running || !service.ready) return
    proc.write(JSON.stringify(object) + "\n")
  }

  // Every request needs a pending entry: responses are routed by id. Searches
  // and tracks are added separately because they carry extra state.
  function call(method, params) {
    var id = service.nextId++
    service.pending[id] = { method: method }
    service.send({ id: id, method: method, params: params || {} })
    return id
  }

  function flushControl() {
    while (service.controlQueue.length > 0) {
      var item = service.controlQueue.shift()
      var id = service.nextId++
      service.pending[id] = { method: item.method }
      service.send({ id: id, method: item.method, params: item.params })
    }
  }

  function setRows(next, query, total) {
    var map = ({})
    for (var i = 0; i < next.length; i++) map[next[i].id] = next[i]
    service.rows = next
    service.rowsQuery = query
    service.rowsTotal = total
    service.rowsById = map
    service.revision++
  }

  function cachedRows(query) {
    return service.rowsQuery === String(query || "") ? service.rows : []
  }

  function cachedTotal(query) {
    return service.rowsQuery === String(query || "") ? service.rowsTotal : 0
  }

  // Root section rows: at most three files, plus a compact "Show all" row
  // when FFF found more.
  function rootRows(query) {
    if (service.rowsQuery !== String(query || "")) return []
    var out = Files.rootRows(service.rows)
    if (service.rowsTotal > out.length) out = out.concat([Files.showAllRow()])
    return out
  }

  function rowFor(id) {
    return service.rowsById[String(id || "")] || null
  }

  function statusSnapshot() {
    var out = { enabled: service.enabled, root: service.root, state: service.state, error: service.lastError }
    for (var key in service.status) out[key] = service.status[key]
    out.enabled = service.enabled
    out.root = service.root
    out.state = service.state
    if (service.lastError) out.error = service.lastError
    return out
  }

  function handleStarted() {
    service.ready = true
    service.protocolOk = false
    service.state = "starting"
    service.lastError = ""
    service.call("hello", {})
  }

  function handleLine(line) {
    var message
    try {
      message = JSON.parse(String(line))
    } catch (e) {
      service.logDebug("unparseable line: " + line)
      return
    }
    var pending = service.pending[message.id]
    if (!pending) return
    delete service.pending[message.id]

    if (message.error !== undefined) {
      service.handleError(pending, String(message.error || "error"))
      return
    }
    var result = message.result || {}

    if (pending.method === "hello") {
      service.protocolOk = Number(result.protocol) === 1
      if (!service.protocolOk) {
        service.state = "error"
        service.lastError = "helper protocol mismatch"
        service.stopping = true
        service.call("shutdown", {})
        service.active = false
        service.message("error", "file search helper is out of date; run oma-cast files build", null)
        return
      }
      service.call("status", {})
      return
    }

    if (pending.method === "status") {
      service.status = result
      service.state = String(result.state || "error")
      service.lastError = String(result.error || "")
      if (service.state === "scanning" || service.state === "starting") statusTimer.restart()
      else statusTimer.stop()
      service.statusRevision++
      if (service.state === "ready") {
        service.restartAttempts = 0
        service.flushControl()
        if (service.pendingReindex) {
          var target = service.pendingReindex
          service.pendingReindex = ""
          service.call("reindex", { root: target })
          service.state = "scanning"
          service.statusRevision++
          statusTimer.restart()
          return
        }
        if (service.desiredQuery) {
          if (service.inFlight) {
            if (service.inFlight.query !== service.desiredQuery) service.queuedQuery = service.desiredQuery
          } else if (service.rowsQuery !== service.desiredQuery) {
            service.sendSearch(service.desiredQuery)
          }
        }
      }
      return
    }

    if (pending.method === "search") {
      service.inFlight = null
      var query = String(result.query || pending.query || "")
      if (query === service.desiredQuery) {
        service.setRows(Files.rowsFromResponse(result, service.home), query, Number(result.totalMatched || 0))
      }
      if (service.queuedQuery && service.queuedQuery !== query) {
        var next = service.queuedQuery
        service.queuedQuery = ""
        service.sendSearch(next)
      }
      return
    }

    if (pending.method === "reindex" || pending.method === "reset") {
      service.state = "scanning"
      service.statusRevision++
      statusTimer.restart()
    }
  }

  function handleError(pending, error) {
    if (pending && pending.method === "search") {
      service.inFlight = null
      if (pending.query === service.desiredQuery) service.setRows([], "", 0)
    }
    if (pending && pending.method === "hello") {
      service.protocolOk = false
      service.state = "error"
      service.active = false
    }
    if (pending && pending.method === "status") {
      service.state = "error"
    }
    service.lastError = error
    service.message("warning", "file search: " + error, null)
  }

  function handleExit(code, exitStatus) {
    service.ready = false
    service.protocolOk = false
    service.inFlight = null
    service.pending = ({})
    if (service.stopping) {
      service.stopping = false
      service.state = "stopped"
      return
    }
    if (code === 127) {
      service.markMissing()
      return
    }
    service.state = "error"
    service.lastError = "helper exited (" + code + ")"
    service.statusRevision++
    var delay = ([1000, 2000, 5000, 10000, 30000])[Math.min(service.restartAttempts, 4)]
    service.restartAttempts++
    restartTimer.interval = delay
    restartTimer.restart()
  }

  function handleRunningChanged() {
    if (service.active && !proc.running && !service.stopping && service.state === "starting") {
      // QProcess::FailedToStart emits runningChanged, not exited.
      if (service.binaryIndex < service.helperCandidates.length - 1) {
        service.binaryIndex++
        service.active = false
        Qt.callLater(function() { service.start() })
      } else {
        service.markMissing()
      }
    }
  }

  onEnabledChanged: {
    if (!service.enabled) {
      service.setRows([], "", 0)
      service.stop()
    } else {
      service.restartAttempts = 0
      if (service.desiredQuery) service.request(service.desiredQuery)
    }
  }

  Component.onDestruction: service.stop()

  Process {
    id: proc
    running: service.active
    stdinEnabled: true
    environment: ({ RUST_LOG: "off" })
    command: {
      var argv = [service.binary, "--root", service.spawnRoot,
                  "--frecency-db", service.frecencyDb,
                  "--runtime-dir", service.runtimeDir]
      if (service.followSymlinks) argv.push("--follow-symlinks")
      return argv
    }
    stdout: SplitParser { onRead: function(line) { service.handleLine(line) } }
    stderr: SplitParser { onRead: function(line) { service.logDebug(line) } }
    onStarted: service.handleStarted()
    onExited: function(code, exitStatus) { service.handleExit(code, exitStatus) }
    onRunningChanged: service.handleRunningChanged()
  }

  Timer {
    id: statusTimer
    interval: 1000
    repeat: true
    onTriggered: if (service.ready && service.protocolOk && service.state === "scanning")
      service.call("status", {})
  }

  Timer {
    id: restartTimer
    interval: 1000
    repeat: false
    onTriggered: {
      if (!service.enabled || service.helperMissing) return
      service.active = false
      Qt.callLater(function() { service.start() })
    }
  }

  Timer {
    id: stopTimer
    interval: 1500
    repeat: false
    onTriggered: {
      if (proc.running) proc.signal(15)
      killTimer.restart()
    }
  }

  Timer {
    id: killTimer
    interval: 2000
    repeat: false
    onTriggered: {
      if (proc.running) proc.signal(9)
      service.stopping = false
      service.active = false
      service.state = "stopped"
    }
  }
}
