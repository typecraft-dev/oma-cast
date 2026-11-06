// Port of plugin/services/CalculatorData.qml: ECB exchange rates (cached
// daily, 12 h max age, 30 min retry) plus current UTC offsets for every
// zone Calculator.js knows. Node has Intl, so zones come from
// Intl.DateTimeFormat instead of the shell's one-shot strftime pass.
var fs = require("fs")
var path = require("path")
var Calculator = require("../../plugin/core/Calculator.js")

var RATES_URL = "https://api.frankfurter.dev/v1/latest"
var RATES_MAX_AGE_MS = 12 * 3600 * 1000   // ECB publishes once a working day
var RETRY_AFTER_MS = 30 * 60 * 1000
var ZONES_MAX_AGE_MS = 10 * 60 * 1000     // catches DST switches

function validRates(doc) {
  if (!doc || typeof doc.base !== "string" || !doc.rates || typeof doc.rates !== "object") return null
  var out = {}
  for (var code in doc.rates) if (/^[A-Z]{3}$/.test(code) && typeof doc.rates[code] === "number" && doc.rates[code] > 0) out[code] = doc.rates[code]
  return { base: doc.base, date: String(doc.date || ""), rates: out }
}

// One zone's minutes east of UTC right now (Intl longOffset: "GMT+02:00").
function zoneOffset(zone, nowMs) {
  try {
    var fmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset", dateStyle: "short", timeStyle: "medium" })
    var parts = fmt.formatToParts(new Date(nowMs || Date.now()))
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type !== "timeZoneName") continue
      var m = parts[i].value.match(/GMT([+-])(\d\d):(\d\d)/)
      if (m) return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
      if (parts[i].value === "GMT") return 0
    }
  } catch (e) { /* unknown zone */ }
  return null
}

function buildZones(nowMs) {
  var out = {}
  var list = Calculator.zoneList()
  for (var i = 0; i < list.length; i++) {
    var offset = zoneOffset(list[i], nowMs)
    if (offset !== null) out[list[i]] = offset
  }
  return out
}

function createData(opts) {
  opts = opts || {}
  var data = {
    cacheDir: opts.cacheDir || "",
    ratesEnabled: opts.ratesEnabled !== false,
    rates: null,
    zones: {},
    ratesFetchedAt: 0,
    ratesTriedAt: 0,
    zonesAt: 0,
    cacheRead: false,
    request: null,
    _listeners: { message: [] }
  }
  data.on = function(event, cb) { data._listeners[event].push(cb) }
  function log(level, text, meta) { (data._listeners.message || []).forEach(function(cb) { cb(level, text, meta) }) }

  function cachePath() { return data.cacheDir ? path.join(data.cacheDir, "currencies.json") : "" }

  data.refresh = function() {
    // Zones are purely on-demand (ensureZones from tz-shaped calculator
    // queries): rebuilding them here reintroduces jank every 10 min on
    // the show path. [D]
    var now = Date.now()
    if (data.ratesEnabled && data.cacheRead && !data.request
        && now - data.ratesFetchedAt > RATES_MAX_AGE_MS && now - data.ratesTriedAt > RETRY_AFTER_MS)
      data.fetchRates()
  }

  data.fetchRates = function() {
    data.ratesTriedAt = Date.now()
    if (data.request) return
    var cancelled = false
    data.request = { abort: function() { cancelled = true } }
    var timer = setTimeout(function() {
      if (cancelled || !data.request) return
      data.request = null
      log("warning", "exchange rates request timed out", null)
    }, 15000)

    fetch(RATES_URL).then(function(res) {
      if (!res.ok) throw new Error("HTTP " + res.status)
      return res.json()
    }).then(function(json) {
      if (cancelled) return
      data.request = null
      clearTimeout(timer)
      var parsed = validRates(json)
      if (!parsed) { log("warning", "could not fetch exchange rates", null); return }
      data.rates = parsed
      data.ratesFetchedAt = Date.now()
      try {
        if (data.cacheDir) fs.mkdirSync(data.cacheDir, { recursive: true })
        fs.writeFileSync(cachePath(), JSON.stringify({ fetchedAt: data.ratesFetchedAt, base: parsed.base, date: parsed.date, rates: parsed.rates }))
      } catch (e) { /* cache is best-effort */ }
      log("info", "exchange rates updated", { date: parsed.date, currencies: Object.keys(parsed.rates).length })
    }).catch(function(err) {
      if (cancelled) return
      data.request = null
      clearTimeout(timer)
      log("warning", "could not fetch exchange rates", { error: String(err && err.message || err) })
    })
  }

  data.refreshZones = function() {
    data.zones = buildZones(Date.now())
    data.zonesAt = Date.now()
  }

  // Zones are built lazily (66 Intl constructors, ~30 ms cold): the
  // backend calls ensureZones only for queries that name a place.
  // Nothing at startup runs Intl or the network on the show path. [D]
  data.ensureZones = function() {
    if (Date.now() - data.zonesAt > ZONES_MAX_AGE_MS) data.refreshZones()
  }

  // Read the disk cache first (like FileView onLoaded), then refresh.
  data.start = function() {
    var p = cachePath()
    if (p) {
      try {
        var doc = JSON.parse(fs.readFileSync(p, "utf8"))
        var parsed = validRates(doc)
        if (parsed) {
          data.rates = parsed
          data.ratesFetchedAt = Number(doc.fetchedAt) || 0
        }
      } catch (e) { log("warning", "ignoring unreadable exchange-rate cache", null) }
    }
    data.cacheRead = true
    // Post-show: zones + the first rates fetch (undici lazy-init alone is
    // ~70 ms) must never block the window. Rates are cached daily, so a
    // one-loop delay is invisible. [D]
    setImmediate(function() {
      try { data.refresh() } catch (e) {}
    })
  }

  return data
}

if (typeof module !== "undefined") {
  module.exports = { createData: createData, validRates: validRates, zoneOffset: zoneOffset, buildZones: buildZones, RATES_URL: RATES_URL }
}
