// When and what to refresh for the calculator's live inputs: ECB exchange
// rates (SPEC §8, cached daily from frankfurter.dev) and time-zone offsets.
// Shared by services/CalculatorData.qml and the macOS app; the hosts only
// fetch, read the cache file and ask the OS for zone offsets.

var RATES_URL = "https://api.frankfurter.dev/v1/latest"
var RATES_MAX_AGE_MS = 12 * 3600 * 1000      // ECB publishes once a working day
var RETRY_AFTER_MS = 30 * 60 * 1000
var ZONES_MAX_AGE_MS = 10 * 60 * 1000        // catches DST switches

// {base, date, rates: {CODE: perBase}} with only well-formed rates, or null.
function validRates(doc) {
  if (!doc || typeof doc.base !== "string" || !doc.rates || typeof doc.rates !== "object") return null
  var out = {}
  for (var code in doc.rates) if (/^[A-Z]{3}$/.test(code) && typeof doc.rates[code] === "number" && doc.rates[code] > 0) out[code] = doc.rates[code]
  return { base: doc.base, date: String(doc.date || ""), rates: out }
}

// The cache file's text -> { rates, fetchedAt } or null.
function readCache(text) {
  try {
    var doc = JSON.parse(text)
    var rates = validRates(doc)
    return rates ? { rates: rates, fetchedAt: Number(doc.fetchedAt) || 0 } : null
  } catch (e) {
    return null
  }
}

function cacheText(rates, fetchedAt) {
  return JSON.stringify({ fetchedAt: fetchedAt, base: rates.base, date: rates.date, rates: rates.rates })
}

function zonesStale(zonesAt, nowMs) {
  return nowMs - zonesAt > ZONES_MAX_AGE_MS
}

// s: { enabled, cacheRead, pending, fetchedAt, triedAt }
function shouldFetchRates(s, nowMs) {
  return !!s.enabled && !!s.cacheRead && !s.pending
    && nowMs - s.fetchedAt > RATES_MAX_AGE_MS && nowMs - s.triedAt > RETRY_AFTER_MS
}

if (typeof module !== "undefined") {
  module.exports = {
    RATES_URL: RATES_URL, RATES_MAX_AGE_MS: RATES_MAX_AGE_MS, RETRY_AFTER_MS: RETRY_AFTER_MS, ZONES_MAX_AGE_MS: ZONES_MAX_AGE_MS,
    validRates: validRates, readCache: readCache, cacheText: cacheText, zonesStale: zonesStale, shouldFetchRates: shouldFetchRates
  }
}
