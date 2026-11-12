import QtQuick
import Quickshell.Io
import "../core/Calculator.js" as Calculator
import "../core/CalculatorData.js" as Policy

// Live inputs for core/Calculator.js: ECB exchange rates (SPEC §8: cached
// daily, frankfurter.dev) and the current UTC offset of every time zone the
// calculator knows. QML's JS engine has no Intl, so one bash process asks
// strftime for all of them (~40 ms).
Item {
  id: data

  // $XDG_CACHE_HOME/omacast; empty until the directory exists.
  property string cacheDir: ""
  property bool ratesEnabled: true

  property var rates: null          // {base, date, rates: {CODE: perBase}}
  property var zones: ({})          // IANA name -> minutes east of UTC

  property double ratesFetchedAt: 0
  property double ratesTriedAt: 0
  property double zonesAt: 0
  property bool cacheRead: false
  property var request: null

  signal message(string level, string text, var metadata)

  // Cheap; called on every launcher open.
  function refresh() {
    var now = Date.now()
    if (Policy.zonesStale(data.zonesAt, now) && !zoneProcess.running) zoneProcess.running = true
    if (Policy.shouldFetchRates({ enabled: data.ratesEnabled, cacheRead: data.cacheRead, pending: !!data.request,
                                  fetchedAt: data.ratesFetchedAt, triedAt: data.ratesTriedAt }, now))
      data.fetchRates()
  }

  function fetchRates() {
    data.ratesTriedAt = Date.now()
    var xhr = new XMLHttpRequest()
    data.request = xhr
    xhr.onreadystatechange = function() {
      // data is null once the plugin reloads with this request in flight.
      if (!data || xhr.readyState !== XMLHttpRequest.DONE || data.request !== xhr) return
      data.request = null
      requestTimeout.stop()
      var parsed = null
      try { parsed = xhr.status === 200 ? Policy.validRates(JSON.parse(xhr.responseText)) : null } catch (e) { parsed = null }
      if (!parsed) {
        data.message("warning", "could not fetch exchange rates", { status: xhr.status })
        return
      }
      data.rates = parsed
      data.ratesFetchedAt = Date.now()
      cache.setText(Policy.cacheText(parsed, data.ratesFetchedAt))
      data.message("info", "exchange rates updated", { date: parsed.date, currencies: Object.keys(parsed.rates).length })
    }
    xhr.open("GET", Policy.RATES_URL)
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
      var cached = Policy.readCache(text())
      if (cached) {
        data.rates = cached.rates
        data.ratesFetchedAt = cached.fetchedAt
      } else data.message("warning", "ignoring unreadable exchange-rate cache", null)
      data.cacheRead = true
      data.refresh()
    }
    onLoadFailed: { data.cacheRead = true; data.refresh() }
  }

  Process {
    id: zoneProcess
    command: ["bash", "-c", "for z in \"$@\"; do TZ=$z printf '%s %(%z)T\\n' \"$z\" -1; done", "omacast-zones"].concat(Calculator.zoneList())
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
