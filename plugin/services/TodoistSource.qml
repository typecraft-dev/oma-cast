import QtQuick
import "../core/Todoist.js" as Todoist

// Todoist v1 task cache (https://api.todoist.com/api/v1). Qt's
// XMLHttpRequest is the same mechanism CalculatorData.qml uses for
// frankfurter.dev: setRequestHeader allows Authorization (not a forbidden
// header) and same-origin is not enforced, so api.todoist.com is fine.
// One request at a time through a small queue — mutations are sequential
// user actions, and every mutation re-syncs the list afterwards so the
// cache never disagrees with the server. [D]
Item {
  id: service

  property string token: ""
  property var tasks: []
  property bool loading: false
  property int revision: 0

  property var _queue: []
  property bool _busy: false
  property var _current: null

  signal changed()
  signal message(string level, string text, var metadata)
  // kind: refreshed | created | completed | deleted. text is the task
  // content (for frecency + toasts); refreshed carries none.
  signal done(string kind, string text)
  signal failed(string message)

  function refresh() {
    service._enqueue({ method: "GET", path: "/tasks?limit=" + Todoist.LIST_LIMIT, kind: "refreshed", text: "" })
  }

  function createTask(text) {
    var err = Todoist.validateText(text)
    if (err) { service.failed(err); return }
    if (!service.token) { service.failed("Set TODOIST_TOKEN or add \"todoistToken\" to config.json — see README"); return }
    service._enqueue({ method: "POST", path: "/tasks/quick", body: { text: String(text).trim(), meta: true }, kind: "created", text: String(text).trim() })
  }

  function completeTask(id) {
    if (!String(id || "").trim()) { service.failed("No such task"); return }
    if (!service.token) { service.failed("Set TODOIST_TOKEN or add \"todoistToken\" to config.json — see README"); return }
    service._enqueue({ method: "POST", path: "/tasks/" + encodeURIComponent(String(id)) + "/close", kind: "completed", text: "" })
  }

  function deleteTask(id) {
    if (!String(id || "").trim()) { service.failed("No such task"); return }
    if (!service.token) { service.failed("Set TODOIST_TOKEN or add \"todoistToken\" to config.json — see README"); return }
    service._enqueue({ method: "DELETE", path: "/tasks/" + encodeURIComponent(String(id)), kind: "deleted", text: "" })
  }

  // Structured add-form submit: the body is already shaped + validated
  // by Todoist.createTaskBody in the backend. Kind "created" so the
  // toast + frecency + resync match the quick-add path. [D]
  function createStructured(bodyText) {
    var body = null
    try { body = JSON.parse(String(bodyText)) } catch (e) { body = null }
    if (!body || !String(body.content || "").trim()) { service.failed("Type a description first"); return }
    if (!service.token) { service.failed("Set TODOIST_TOKEN or add \"todoistToken\" to config.json — see README"); return }
    service._enqueue({ method: "POST", path: "/tasks", body: body, kind: "created", text: String(body.content).trim() })
  }

  function _enqueue(op) {
    service._queue = service._queue.concat([op])
    service._pump()
  }

  function _pump() {
    if (service._busy || service._queue.length === 0) return
    service._busy = true
    service._current = service._queue[0]
    service._queue = service._queue.slice(1)
    service.loading = true
    service.changed()
    service._send(service._current)
  }

  function _send(op) {
    if (!service.token) {
      service._finish(false, "Set TODOIST_TOKEN or add \"todoistToken\" to config.json — see README", null)
      return
    }
    var xhr = new XMLHttpRequest()
    op.xhr = xhr
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== XMLHttpRequest.DONE || service._current !== op) return
      var json = null
      try { json = xhr.responseText ? JSON.parse(xhr.responseText) : null } catch (e) { json = null }
      if (xhr.status >= 200 && xhr.status < 300) service._finish(true, "", json)
      else service._finish(false, Todoist.apiError(xhr.status, json), { status: xhr.status })
    }
    xhr.open(op.method, Todoist.API_BASE + op.path)
    xhr.setRequestHeader("Authorization", "Bearer " + service.token)
    xhr.setRequestHeader("Content-Type", "application/json")
    xhr.send(op.body ? JSON.stringify(op.body) : null)
    timeout.restart()
  }

  function _finish(ok, message, json) {
    timeout.stop()
    var op = service._current
    service._current = null
    service._busy = false
    if (!op) return
    if (op.kind === "refreshed") {
      if (ok) {
        service.tasks = (json && Array.isArray(json.results)) ? json.results : []
        service.revision++
        service.loading = service._queue.length > 0
        service.changed()
        service.done("refreshed", "")
      } else {
        // A background refresh failing is routine (offline, bad token) —
        // log it, don't toast: the next push retries. [D]
        service.loading = service._queue.length > 0
        service.changed()
        service.message("warning", "todoist refresh failed", { error: message })
      }
    } else if (ok) {
      // Mutations re-sync first so the cache never disagrees; the toast
      // follows from done(), the list from the refresh's changed(). [D]
      service.loading = service._queue.length > 0
      service.changed()
      if (op.kind !== "refreshed")
        service.message("info", "todoist " + op.method + " " + op.path + " ok", null)
      service.done(op.kind, op.text)
      service.refresh()
      return
    } else {
      service.loading = service._queue.length > 0
      service.changed()
      // A 404 self-heals: the task is already gone server-side, so drop
      // the error into a refresh and report that. [D]
      if (message === Todoist.apiError(404, null)) service.refresh()
      // Method + path + status land in the shell log so a failed delete
      // answers "did it send to the api" without printing the token. [D]
      service.message("warning", "todoist " + op.method + " " + op.path + " failed", { error: message, status: json && json.status })
      service.failed(message)
    }
    service._pump()
  }

  Timer {
    id: timeout
    interval: 15000
    onTriggered: {
      var op = service._current
      if (!op) return
      try { if (op.xhr) op.xhr.abort() } catch (e) {}
      service._finish(false, "Todoist timed out — try again.", null)
    }
  }
}
