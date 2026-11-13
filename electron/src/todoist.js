// Todoist v1 client (https://api.todoist.com/api/v1) behind the Electron
// backend. Node's https module, not the renderer's fetch: with
// nodeIntegration there is no CORS preflight for the Authorization header.
// Same surface as plugin/services/TodoistSource.qml (token, tasks,
// loading, revision, refresh/createTask/completeTask/deleteTask) so the
// two backends stay symmetric. [D]
var https = require("https")
var Todoist = require("../../plugin/core/Todoist.js")

var TIMEOUT_MS = 15000

// requestFn injection point for tests: (options, onResponse) like
// https.request. The stub answers synchronously through the same events.
function createTodoist(opts) {
  opts = opts || {}
  var requestFn = opts.requestFn || https.request
  var getToken = opts.getToken || function() { return opts.token || "" }
  var log = opts.log || function() {}

  var state = { tasks: [], loading: false, revision: 0, seq: 0 }
  var listeners = { changed: [], message: [] }

  function emitChanged() { (listeners.changed || []).forEach(function(cb) { cb() }) }
  function emitMessage(level, text, meta) { (listeners.message || []).forEach(function(cb) { cb(level, text, meta) }) }

  function failure(status, body) {
    var json = null
    try { json = body ? JSON.parse(body) : null } catch (e) { json = null }
    var err = new Error(Todoist.apiError(status, json))
    err.todoistCode = status
    return err
  }

  function call(method, path, payload) {
    return new Promise(function(resolve, reject) {
      var token = String(getToken() || "")
      if (!token) { reject(new Error("Set TODOIST_TOKEN or add \"todoistToken\" to config.json — see README")); return }
      // Method + path only: answers "did it send to the api" from
      // main.log without ever printing the token. [D]
      log("info", "todoist request", { method: method, path: path })
      var body = payload ? JSON.stringify(payload) : null
      var req
      try {
        req = requestFn({
          hostname: "api.todoist.com",
          path: "/api/v1" + path,
          method: method,
          timeout: TIMEOUT_MS,
          headers: {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Content-Length": body ? Buffer.byteLength(body) : 0
          }
        }, function(res) {
          var chunks = ""
          res.on("data", function(c) { chunks += c })
          res.on("end", function() {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              if (!chunks) { resolve(null); return }
              try { resolve(JSON.parse(chunks)) } catch (e) { reject(new Error("Todoist answered unreadable JSON")) }
            } else {
              var err = failure(res.statusCode, chunks)
              log("warning", "todoist request failed", { method: method, path: path, status: res.statusCode })
              reject(err)
            }
          })
        })
      } catch (e) { reject(new Error("Todoist request failed: " + (e && e.message || e))); return }
      req.on("error", function(e) {
        log("warning", "todoist request failed", { method: method, path: path, error: String((e && e.message) || e) })
        reject(new Error("Todoist request failed: " + ((e && e.message) || e)))
      })
      req.on("timeout", function() {
        try { req.destroy() } catch (e) {}
        log("warning", "todoist request failed", { method: method, path: path, error: "timeout" })
        reject(new Error("Todoist timed out — try again."))
      })
      if (body) req.write(body)
      req.end()
    })
  }

  // Only the latest refresh wins: a slow list must not clobber a newer
  // one (complete/delete chain a refresh after every mutation). [D]
  function refresh() {
    var my = ++state.seq
    state.loading = true
    emitChanged()
    return call("GET", "/tasks?limit=" + Todoist.LIST_LIMIT).then(function(json) {
      if (my !== state.seq) return state.tasks
      state.tasks = (json && Array.isArray(json.results)) ? json.results : []
      state.loading = false
      state.revision++
      log("info", "todoist refreshed", { tasks: state.tasks.length })
      emitChanged()
      return state.tasks
    }).catch(function(err) {
      if (my === state.seq) {
        state.loading = false
        emitChanged()
        emitMessage("warning", "todoist refresh failed", { error: String(err && err.message || err) })
      }
      throw err
    })
  }

  // Mutations re-sync afterwards so the cache never disagrees with the
  // server. A 404 self-heals (the task is already gone server-side).
  function afterMutation(promise) {
    return promise.then(function(res) {
      return refresh().then(function() { return res }, function() { return res })
    }, function(err) {
      if (err && err.todoistCode === 404) {
        return refresh().then(function() { throw err }, function() { throw err })
      }
      throw err
    })
  }

  var api = {
    get tasks() { return state.tasks },
    get loading() { return state.loading },
    get revision() { return state.revision },
    on: function(event, cb) { (listeners[event] = listeners[event] || []).push(cb) },
    refresh: refresh,
    createTask: function(text) {
      var err = Todoist.validateText(text)
      if (err) return Promise.reject(new Error(err))
      return afterMutation(call("POST", "/tasks/quick", { text: String(text).trim(), meta: true }))
    },
    completeTask: function(id) {
      if (!String(id || "").trim()) return Promise.reject(new Error("No such task"))
      return afterMutation(call("POST", "/tasks/" + encodeURIComponent(String(id)) + "/close"))
    },
    deleteTask: function(id) {
      if (!String(id || "").trim()) return Promise.reject(new Error("No such task"))
      return afterMutation(call("DELETE", "/tasks/" + encodeURIComponent(String(id))))
    },
    // Structured add-form submit: the body is already shaped +
    // validated by Todoist.createTaskBody in the backend. [D]
    createStructured: function(body) {
      if (!body || !String(body.content || "").trim()) return Promise.reject(new Error("Type a description first"))
      return afterMutation(call("POST", "/tasks", body))
    }
  }
  return api
}

if (typeof module !== "undefined") {
  module.exports = { createTodoist: createTodoist, TIMEOUT_MS: TIMEOUT_MS }
}
