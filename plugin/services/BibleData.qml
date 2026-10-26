import QtQuick
import Quickshell.Io
import "../core/Bible.js" as Bible
import "../core/BibleRequest.js" as BibleRequest

// Midvash is primary; bible-api.com is the WEB fallback. Successful results
// persist so previously viewed verses remain available while offline.
Item {
  id: data
  property string cacheDir: ""
  property var cache: ({})
  property var cacheTimes: ({})
  property bool cacheRead: false
  property var pendingRef: null
  property var request: null
  property string requestSource: ""
  property int requestToken: 0
  property var lifecycle: BibleRequest.initial()
  property int revision: 0
  property string lastCompletedKey: ""
  property bool lastSucceeded: false
  readonly property int cacheLimit: 256
  signal message(string level, string text, var metadata)

  function has(key) { return data.cache[String(key || "")] !== undefined }

  function lookup(query) {
    var ref = Bible.parseReference(query)
    var key = ref ? ref.key : ""
    var cached = ref ? data.cache[key] : undefined
    var plan = BibleRequest.setWanted(data.lifecycle, key, Date.now())
    if (plan.changed) {
      data.lifecycle = plan.state
      data.pendingRef = ref
      debounce.stop()
      if (plan.abort && data.request) {
        var stale = data.request
        data.request = null
        data.requestSource = ""
        timeout.stop()
        stale.abort()
      }
      if (plan.schedule && cached === undefined) debounce.restart()
    }
    if (!ref) return null
    if (cached !== undefined) return cached
    if (!plan.changed && plan.schedule && !debounce.running) debounce.restart()
    return null
  }

  function fetch(ref) {
    var begun = BibleRequest.start(data.lifecycle, ref.key)
    data.lifecycle = begun.state
    if (!begun.started) return
    data.requestToken = begun.token
    data.startHttp(ref, begun.token, "primary")
  }

  function startHttp(ref, token, source) {
    var xhr = new XMLHttpRequest()
    data.request = xhr
    data.requestSource = source
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== XMLHttpRequest.DONE || data.request !== xhr) return
      data.request = null
      timeout.stop()
      var value = null
      try {
        if (xhr.status === 200) value = source === "primary"
          ? Bible.result(ref, JSON.parse(xhr.responseText))
          : Bible.fallbackResult(ref, JSON.parse(xhr.responseText))
      } catch (e) { value = null }
      if (!value && source === "primary") { data.startHttp(ref, token, "fallback"); return }
      data.finish(ref, token, xhr.status, value, source)
    }
    xhr.open("GET", source === "primary" ? Bible.apiUrl(ref) : Bible.fallbackApiUrl(ref))
    xhr.send()
    timeout.restart()
  }

  function finish(ref, token, status, value, source) {
    var done = BibleRequest.complete(data.lifecycle, ref.key, token, status, !!value, Date.now())
    if (!done.accepted) return
    data.lifecycle = done.state
    data.requestSource = ""
    if (value) {
      data.store(ref.key, value)
      data.message("info", "Bible verse fetched", { provider: source, reference: ref.reference })
    }
    data.lastCompletedKey = ref.key
    data.lastSucceeded = !!value
    data.revision++
    if (!value) data.message("warning", "could not fetch " + ref.reference, { status: status, providers: 2 })
  }

  function store(key, value) {
    var next = Object.assign({}, data.cache)
    var times = Object.assign({}, data.cacheTimes)
    value.cached = false
    next[key] = value
    times[key] = Date.now()
    var keys = Object.keys(times).sort(function(a, b) { return times[b] - times[a] })
    for (var i = data.cacheLimit; i < keys.length; i++) { delete next[keys[i]]; delete times[keys[i]] }
    data.cache = next
    data.cacheTimes = times
    if (data.cacheRead) data.persist()
  }

  function persist() { cacheFile.setText(JSON.stringify({ version: 1, entries: data.serializedEntries() })) }

  function serializedEntries() {
    var out = ({})
    for (var key in data.cache) out[key] = { fetchedAt: data.cacheTimes[key] || 0, value: data.cache[key] }
    return out
  }

  Timer { id: debounce; interval: 180; onTriggered: if (data.pendingRef) data.fetch(data.pendingRef) }
  Timer {
    id: timeout; interval: 10000
    onTriggered: {
      if (!data.request || !data.pendingRef) return
      var ref = data.pendingRef, xhr = data.request, token = data.requestToken, source = data.requestSource
      data.request = null
      timeout.stop()
      xhr.abort()
      if (source === "primary") { data.startHttp(ref, token, "fallback"); return }
      data.finish(ref, token, 0, null, "fallback")
    }
  }

  FileView {
    id: cacheFile
    path: data.cacheDir ? data.cacheDir + "/bible.json" : ""
    atomicWrites: true
    printErrors: false
    onLoaded: {
      var next = Object.assign({}, data.cache), times = Object.assign({}, data.cacheTimes)
      try {
        var doc = JSON.parse(text()), entries = doc && doc.version === 1 ? doc.entries || {} : {}
        for (var key in entries) {
          var entry = entries[key], value = entry && entry.value
          if (!value || typeof value.text !== "string" || typeof value.reference !== "string") continue
          value.cached = true
          next[key] = value
          times[key] = Number(entry.fetchedAt) || 0
        }
      } catch (e) { data.message("warning", "ignoring unreadable Bible cache", null) }
      data.cache = next
      data.cacheTimes = times
      data.cacheRead = true
      data.revision++
    }
    onLoadFailed: { data.cacheRead = true; if (Object.keys(data.cache).length) data.persist() }
  }
}
