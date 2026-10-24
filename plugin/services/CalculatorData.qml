import QtQuick
import Quickshell.Io
import "../core/Calculator.js" as Calculator

// Live inputs for core/Calculator.js: ECB exchange rates (SPEC §8: cached
// daily, frankfurter.dev) and the current UTC offset of every time zone the
// calculator knows. QML's JS engine has no Intl, so one bash process asks
// strftime for all of them (~40 ms).
Item {
  id: data

  // $XDG_CACHE_HOME/oma-cast; empty until the directory exists.
  property string cacheDir: ""
  property bool ratesEnabled: true

  property var rates: null          // {base, date, rates: {CODE: perBase}}
  property var zones: ({})          // IANA name -> minutes east of UTC

  property double ratesFetchedAt: 0
  property double ratesTriedAt: 0
  property double zonesAt: 0
  property bool cacheRead: false
  property var request: null

  readonly property string ratesUrl: "https://api.frankfurter.dev/v1/latest"
  readonly property double ratesMaxAgeMs: 12 * 3600 * 1000     // ECB publishes once a working day
  readonly property double retryAfterMs: 30 * 60 * 1000
  readonly property double zonesMaxAgeMs: 10 * 60 * 1000       // catches DST switches

  signal message(string level, string text, var metadata)

  // Cheap; called on every launcher open.
  function refresh() {
    var now = Date.now()
    if (now - data.zonesAt > data.zonesMaxAgeMs && !zoneProcess.running) zoneProcess.running = true
    if (data.ratesEnabled && data.cacheRead && !data.request
        && now - data.ratesFetchedAt > data.ratesMaxAgeMs && now - data.ratesTriedAt > data.retryAfterMs)
      data.fetchRates()
  }

  function validRates(doc) {
    if (!doc || typeof doc.base !== "string" || !doc.rates || typeof doc.rates !== "object") return null
    var out = {}
    for (var code in doc.rates) if (/^[A-Z]{3}$/.test(code) && typeof doc.rates[code] === "number" && doc.rates[code] > 0) out[code] = doc.rates[code]
    return { base: doc.base, date: String(doc.date || ""), rates: out }
  }

  function fetchRates() {
    data.ratesTriedAt = Date.now()
    var xhr = new XMLHttpRequest()
    data.request = xhr
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== XMLHttpRequest.DONE || data.request !== xhr) return
      data.request = null
      requestTimeout.stop()
      var parsed = null
      try { parsed = xhr.status === 200 ? data.validRates(JSON.parse(xhr.responseText)) : null } catch (e) { parsed = null }
      if (!parsed) {
        data.message("warning", "could not fetch exchange rates", { status: xhr.status })
        return
      }
      data.rates = parsed
      data.ratesFetchedAt = Date.now()
      cache.setText(JSON.stringify({ fetchedAt: data.ratesFetchedAt, base: parsed.base, date: parsed.date, rates: parsed.rates }))
      data.message("info", "exchange rates updated", { date: parsed.date, currencies: Object.keys(parsed.rates).length })
    }
    xhr.open("GET", data.ratesUrl)
    xhr.send()
    requestTimeout.restart()
  }

  Timer {
    id: requestTimeout
    interval: 15000
    onTriggered: {
      if (!data.request) return
      var xhr = data.request
      data.request = null
      xhr.abort()
      data.message("warning", "exchange rates request timed out", null)
    }
  }

  FileView {
    id: cache
    path: data.cacheDir ? data.cacheDir + "/currencies.json" : ""
    atomicWrites: true
    printErrors: false
    onLoaded: {
      try {
        var doc = JSON.parse(text())
        var parsed = data.validRates(doc)
        if (parsed) {
          data.rates = parsed
          data.ratesFetchedAt = Number(doc.fetchedAt) || 0
        }
      } catch (e) {
        data.message("warning", "ignoring unreadable exchange-rate cache", null)
      }
      data.cacheRead = true
      data.refresh()
    }
    onLoadFailed: { data.cacheRead = true; data.refresh() }
  }

  Process {
    id: zoneProcess
    command: ["bash", "-c", "for z in \"$@\"; do TZ=$z printf '%s %(%z)T\\n' \"$z\" -1; done", "oma-cast-zones"].concat(Calculator.zoneList())
    stdout: StdioCollector {
      onStreamFinished: {
        var next = ({})
        var lines = text.split("\n")
        for (var i = 0; i < lines.length; i++) {
          var m = /^(\S+) ([+-])(\d\d)(\d\d)$/.exec(lines[i])
          if (m) next[m[1]] = (m[2] === "-" ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4]))
        }
        data.zones = next
        data.zonesAt = Date.now()
      }
    }
  }

  Component.onCompleted: zoneProcess.running = true
}
