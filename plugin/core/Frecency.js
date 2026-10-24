
var LAMBDA = Math.LN2 / 10
var DAY = 86400
var EXP_GUARD = 709.78
var VISIT_BONUS = 100
var SEARCH_TERM_WINDOW_MS = 1468800000
var MAX_SEARCH_TERMS = 20

function isNumber(value) {
  return typeof value === "number" && isFinite(value)
}

function score(anchorSec, nowSec) {
  if (!isNumber(anchorSec) || !isNumber(nowSec)) return 1
  return Math.max(1, Math.exp(Math.min(EXP_GUARD, LAMBDA * (anchorSec - nowSec) / DAY)))
}

function visit(anchorSec, nowSec) {
  var t = Number(nowSec)
  var a = isNumber(anchorSec) ? Math.max(anchorSec, t) : t
  var s = Math.max(1, Math.exp(Math.min(EXP_GUARD, LAMBDA * (a - t) / DAY)))
  var s2 = s + VISIT_BONUS
  if (!(s2 >= 1)) return t
  return t + DAY * Math.log(Math.min(s2, Number.MAX_VALUE)) / LAMBDA
}

function recordVisit(entry, nowMs, searchTerm) {
  var prior = entry && typeof entry === "object" ? entry : {}
  var nowSec = nowMs / 1000
  var terms = Array.isArray(prior.searchTerms) ? prior.searchTerms.slice() : []
  var term = String(searchTerm === undefined || searchTerm === null ? "" : searchTerm).trim().toLowerCase()
  if (term) {
    terms = terms.filter(function(t) { return t && t.term !== term })
    terms.push({ term: term, at: nowMs })
    if (terms.length > MAX_SEARCH_TERMS) terms = terms.slice(terms.length - MAX_SEARCH_TERMS)
  }
  return {
    anchor: visit(prior.anchor, nowSec),
    openedAt: nowMs,
    searchTerms: terms
  }
}

if (typeof module !== "undefined") {
  module.exports = {
    LAMBDA: LAMBDA,
    VISIT_BONUS: VISIT_BONUS,
    SEARCH_TERM_WINDOW_MS: SEARCH_TERM_WINDOW_MS,
    MAX_SEARCH_TERMS: MAX_SEARCH_TERMS,
    score: score,
    visit: visit,
    recordVisit: recordVisit
  }
}
