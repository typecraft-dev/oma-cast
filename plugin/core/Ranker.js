
var SEPARATORS = "\t\n -./()[]"
var MAX = Number.MAX_SAFE_INTEGER
var SEARCH_TERM_WINDOW_MS = 1468800000

var TYPE_PRIORITY = {
  application: 5,
  command: 4,
  quicklink: 3,
  "menu-bar": 3,
  preference: 1,
  file: 1,
  "calendar-event": 1,
  contact: 0
}

function isSeparator(ch) {
  return ch !== "" && SEPARATORS.indexOf(ch) !== -1
}

var _normCache = {}
var _normSize = 0
function normalizeCached(s) {
  var key = String(s === undefined || s === null ? "" : s)
  // Bounded string-keyed cache: titles repeat across keystrokes and
  // rebuilds, and normalize() scans the whole string every call. [D]
  var hit = _normCache[key]
  if (hit && hit.len === key.length) return hit
  var r = normalize(key)
  // Cap growth with a counter (Object.keys().length per call was itself
  // O(cache) on this hot path). App libraries hold hundreds of titles. [D]
  if (_normSize > 5000) { _normCache = {}; _normSize = 0 }
  _normCache[key] = { normalizedText: r.normalizedText, wordBoundaries: r.wordBoundaries, len: key.length }
  _normSize++
  return _normCache[key]
}


function normalize(s) {
  var text = String(s === undefined || s === null ? "" : s)
  var boundaries = []
  for (var i = 0; i < text.length; i++) {
    boundaries.push(i > 0 && /[a-z0-9]/.test(text.charAt(i - 1)) && /[A-Z]/.test(text.charAt(i)))
  }
  return { normalizedText: text.toLowerCase(), wordBoundaries: boundaries }
}

var TRANSLIT = {
  "ß": "ss", "æ": "ae", "Æ": "AE", "ø": "o", "Ø": "O", "đ": "d", "Đ": "D",
  "ł": "l", "Ł": "L", "œ": "oe", "Œ": "OE", "þ": "th", "Þ": "Th", "ð": "d", "Ð": "D",
  "ı": "i", "ħ": "h", "Ħ": "H"
}

var _transCache = {}
var _transSize = 0
function transliterateCached(s) {
  var key = String(s === undefined || s === null ? "" : s)
  var hit = _transCache[key]
  if (hit !== undefined) return hit
  var r = transliterate(key)
  if (_transSize > 5000) { _transCache = {}; _transSize = 0 }
  _transCache[key] = r
  _transSize++
  return r
}

function transliterate(s) {

  var text = String(s === undefined || s === null ? "" : s)
  if (typeof text.normalize === "function") text = text.normalize("NFD").replace(/[̀-ͯ]/g, "")
  var out = ""
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i)
    out += TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch
  }
  return out
}


function fuzzyMatch(target, query, options) {
  var literalDots = !!(options && options.literalQueryDots)
  var tn = normalizeCached(target)
  var t = tn.normalizedText
  var bounds = tn.wordBoundaries
  var q = String(query === undefined || query === null ? "" : query).toLowerCase()

  function querySep(ch) {
    if (literalDots && ch === ".") return false
    return isSeparator(ch)
  }

  if (q.length === 0) return "unmatched"
  if (t === q) return "exact"

  var sepCount = 0
  for (var i = 0; i < q.length; i++) if (querySep(q.charAt(i))) sepCount++
  var u = q.length - sepCount
  if (u > t.length) return "unmatched"

  // Cheap subsequence gate: every non-separator query char must appear
  // in order in the target — necessary for any DP alignment to exist.
  // O(n) scan that skips the O(q*n^2) DP for the (typical) non-match.
  // Separator query chars match any separator, so they always pass. [D]
  var gi = 0
  for (var gq = 0; gq < q.length; gq++) {
    var gch = q.charAt(gq)
    if (querySep(gch)) continue
    gi = t.indexOf(gch, gi)
    if (gi < 0) return "unmatched"
    gi++
  }

  if (u > 2) {
    var ti = 0
    for (var qi = 0; qi < q.length; qi++) {
      var qc = q.charAt(qi)
      if (querySep(qc)) {
        for (var s = ti; s < t.length; s++) {
          if (isSeparator(t.charAt(s))) { ti = s + 1; break }
        }
        continue
      }
      var found = t.indexOf(qc, ti)
      if (found < 0) return "unmatched"
      ti = found + 1
    }
  }

  var n = t.length
  var NEG = -Infinity
  var prev = null
  var d = -1
  var p = 0
  var skipped = 0

  for (var row = 0; row < q.length; row++) {
    var ch = q.charAt(row)
    var chSep = querySep(ch)
    var cur = []
    for (var z = 0; z < n; z++) cur.push(NEG)
    var firstCol = -1
    var end = Math.min(n, n - (u - 1 - p))

    for (var e = d + 1; e < end; e++) {
      var tc = t.charAt(e)
      var sepMatch = chSep && isSeparator(tc)
      if (!(tc === ch || sepMatch)) continue

      var cellScore
      if (sepMatch) cellScore = 1
      else if (p === 0 && e === 0) cellScore = 4
      else {
        var wordStart = bounds[e] || (e > 0 && isSeparator(t.charAt(e - 1)))
        cellScore = (wordStart && !isSeparator(tc)) ? 3 : 2
      }

      var cell = NEG
      if (p === 0) {
        cell = cellScore
      } else {
        for (var r = d; r < e; r++) {
          if (prev[r] === NEG) continue
          var v = prev[r] + cellScore - (r === e - 1 ? 0 : 1)
          if (v > cell) cell = v
        }
      }
      if (cell === NEG) continue
      cur[e] = cell
      if (firstCol < 0) firstCol = e
    }

    if (firstCol >= 0) {
      d = firstCol
      p++
      prev = cur
    } else if (chSep) {
      skipped++
    } else {
      return "unmatched"
    }
  }

  if (!prev) return "unmatched"
  var best = NEG
  for (var k = 0; k < prev.length; k++) if (prev[k] > best) best = prev[k]
  if (best === NEG) return "unmatched"
  return { score: best, skipped: skipped }
}

function matchScore(match) {
  if (match === "exact") return MAX
  if (!match || match === "unmatched") return -MAX
  return match.score
}

function passesThreshold(match, queryLength, sensitivity) {
  if (match === "exact") return true
  if (!match || match === "unmatched") return false
  var mode = sensitivity || "medium"
  var len = queryLength - match.skipped
  if (mode === "low") return true
  if (mode === "high") return match.score > 2 * len
  return match.score >= 1.5 * (len - 2) + 4
}

function aliasMatch(alias, query) {
  var a = String(alias || "").toLowerCase()
  var q = String(query || "").toLowerCase()
  if (!a || !q) return "unmatched"
  if (a === q) return "exact"
  if (a.length > q.length && a.indexOf(q) === 0) return "prefix"
  return "unmatched"
}

function searchTermMatch(terms, query, frecency, openedAtMs, nowMs) {
  var none = { kind: "none", count: 0 }
  if (!Array.isArray(terms) || terms.length === 0) return none
  if (!(Number(frecency) > 1)) return none
  if (typeof openedAtMs !== "number" || !isFinite(openedAtMs)) return none
  if (nowMs - openedAtMs > SEARCH_TERM_WINDOW_MS) return none
  var q = String(query || "").toLowerCase()
  if (!q) return none

  var best = none
  for (var i = 0; i < terms.length; i++) {
    var raw = terms[i]
    var s = String(raw && typeof raw === "object" ? raw.term : raw || "").toLowerCase()
    if (!s) continue
    var m = none
    if (s === q) m = { kind: "exact", count: 0 }
    else if (s.length > q.length && s.indexOf(q) === 0) m = { kind: "prefix", count: 0 }
    else if (q.indexOf(s) === 0) {
      var leftover = q.length - s.length
      if (leftover >= 1 && leftover <= 3) m = { kind: "overbounds", count: leftover }
    }
    if (searchTermRank(m) > searchTermRank(best)) best = m
  }
  return best
}

function searchTermClass(m) {
  if (!m) return 0
  if (m.kind === "exact") return 3
  if (m.kind === "prefix") return 2
  if (m.kind === "overbounds") return 1
  return 0
}

function searchTermRank(m) {
  return searchTermClass(m) * 10 + (m && m.kind === "overbounds" ? m.count : 0)
}

function wholeWordIn(title, q) {
  var tn = normalizeCached(title)
  var t = tn.normalizedText
  var b = tn.wordBoundaries
  var from = 0
  while (true) {
    var at = t.indexOf(q, from)
    if (at < 0) return false
    var endAt = at + q.length
    var startOk = at === 0 || isSeparator(t.charAt(at - 1)) || b[at]
    var endOk = endAt === t.length || isSeparator(t.charAt(endAt)) || b[endAt]
    if (startOk && endOk) return true
    from = at + 1
  }
}


function buildRecord(candidate, query, options) {
  var opts = options || {}
  var sensitivity = opts.sensitivity || "medium"
  var nowMs = typeof opts.nowMs === "number" ? opts.nowMs : Date.now()
  var literalDots = !!opts.literalQueryDots
  var c = candidate || {}
  var q = String(query || "").trim().toLowerCase()
  var tq = opts.tq !== undefined ? opts.tq : transliterateCached(q)
  var frecency = typeof c.frecency === "number" && isFinite(c.frecency) ? c.frecency : 1

  var title = transliterateCached(String(c.title || ""))
  if (tq.charAt(0) === "/") title = title.replace("/", " ")
  var titleLower = title.toLowerCase()
  var alternates = Array.isArray(c.alternateTitles) ? c.alternateTitles.map(function(a) { return String(a || "") }) : []

  var record = {
    candidate: c,
    query: q,
    type: c.type,
    typePriority: TYPE_PRIORITY[c.type] !== undefined ? TYPE_PRIORITY[c.type] : 0,
    frecency: frecency,
    hasAlias: !!c.alias,
    alias: aliasMatch(c.alias, q),
    isBoostedSearchTerm: false,
    title: "unmatched",
    titleMatch: "none",
    titleScore: -MAX,
    alternates: [],
    subtitle: null,
    subtitleExact: false,
    subtitleScore: -MAX,
    keywords: [],
    searchTerm: { kind: "none", count: 0 },
    textMatched: false,
    isMatching: !!c.alwaysMatching
  }
  if (!q) return record

  record.isBoostedSearchTerm = Array.isArray(c.boostedTerms) && c.boostedTerms.some(function(term) {
    return String(term || "").toLowerCase() === q
  })

  record.title = fuzzyMatch(title, tq, { literalQueryDots: literalDots })
  if (record.title === "exact") record.titleMatch = "exact"
  else if (titleLower.indexOf(q) === 0 || alternates.some(function(a) { return a.toLowerCase().indexOf(q) === 0 }))
    record.titleMatch = "prefix"
  record.titleScore = matchScore(record.title)

  record.alternates = alternates.map(function(a) { return fuzzyMatch(a, q, { literalQueryDots: literalDots }) })

  var subtitle = String(c.subtitle || "")
  if (subtitle && subtitle.toLowerCase() !== String(c.title || "").toLowerCase()) {
    record.subtitle = fuzzyMatch(subtitle, q, { literalQueryDots: literalDots })
    record.subtitleExact = record.subtitle === "exact"
    record.subtitleScore = matchScore(record.subtitle)
  }

  var keywords = Array.isArray(c.keywords) ? c.keywords.slice() : []
  if (subtitle) {
    keywords.push(String(c.title || "") + " " + subtitle)
    keywords.push(subtitle + " " + String(c.title || ""))
  }
  if (c.bundleId && q.indexOf(".") !== -1) keywords.push(String(c.bundleId))
  // Keywords only feed the textMatched boolean — ordering uses title /
  // subtitle scores. If the title already passes, skip every keyword DP.
  // (Subtitle still runs: its score feeds ranking.) [D]
  var titlePassed = record.alias !== "unmatched"
    || passesThreshold(record.title, len, sensitivity)
    || record.alternates.some(function(m) { return passesThreshold(m, len, sensitivity) })
    || passesThreshold(record.subtitle, len, sensitivity)
  record.keywords = titlePassed ? [] : keywords.map(function(k) { return fuzzyMatch(String(k || ""), q, { literalQueryDots: literalDots }) })

  record.searchTerm = searchTermMatch(c.searchTerms, q, frecency, c.openedAt, nowMs)

  if (q.length >= 3 && !/\s/.test(q)) {
    if (record.title !== "exact" && wholeWordIn(title, tq)) {
      var floor = 4 + (q.length - 1) * 2 + 0.5
      if (record.titleScore < floor) record.titleScore = floor
    }
    var exactAlternate = record.alternates.some(function(m) { return m === "exact" })
    if (exactAlternate) {
      record.titleMatch = "exact"
    } else {
      for (var i = 0; i < record.alternates.length; i++) {
        var s = matchScore(record.alternates[i])
        if (s > record.titleScore) record.titleScore = s
      }
    }
  }

  var len = q.length
  record.textMatched = record.alias !== "unmatched"
    || passesThreshold(record.title, len, sensitivity)
    || record.alternates.some(function(m) { return passesThreshold(m, len, sensitivity) })
    || passesThreshold(record.subtitle, len, sensitivity)
    || record.keywords.some(function(m) { return passesThreshold(m, len, sensitivity) })
  record.isMatching = !!c.alwaysMatching || record.textMatched
  return record
}


function collate(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" })
}

function heuristic(record) {
  var h = record.candidate.sortHeuristic
  return typeof h === "number" && isFinite(h) ? h : 0
}

function comparePlain(a, b) {
  if (a.frecency !== b.frecency) return b.frecency - a.frecency
  if (a.hasAlias !== b.hasAlias) return a.hasAlias ? -1 : 1
  if (a.typePriority !== b.typePriority) return b.typePriority - a.typePriority
  var h = heuristic(a) - heuristic(b)
  if (h !== 0) return h
  var ext = collate(a.candidate.extensionTitle, b.candidate.extensionTitle)
  if (ext !== 0) return ext
  return collate(a.candidate.title, b.candidate.title)
}

function hasStrongMatch(r) {
  return r.alias === "exact" || r.alias === "prefix"
    || r.titleMatch === "exact" || r.titleMatch === "prefix"
    || r.subtitleExact
    || r.searchTerm.kind === "exact" || r.searchTerm.kind === "prefix"
}

function overboundsCount(r) {
  return r.searchTerm.kind === "overbounds" ? r.searchTerm.count : 0
}

function compareMatched(a, b, ctx) {
  var context = ctx || {}
  var aExactAlias = a.alias === "exact", bExactAlias = b.alias === "exact"
  if (aExactAlias !== bExactAlias) return aExactAlias ? -1 : 1

  var aTermExact = a.searchTerm.kind === "exact", bTermExact = b.searchTerm.kind === "exact"
  if (context.hasExactTitle && context.hasExactSearchTerm) {
    if (aTermExact !== bTermExact) return aTermExact ? -1 : 1
    if (aTermExact && bTermExact && a.frecency !== b.frecency) return b.frecency - a.frecency
  }

  if (a.isBoostedSearchTerm !== b.isBoostedSearchTerm) {
    var boosted = a.isBoostedSearchTerm ? a : b
    var other = a.isBoostedSearchTerm ? b : a
    if (!(other.frecency > 1 && other.frecency > boosted.frecency)) return a.isBoostedSearchTerm ? -1 : 1
  }

  var aContact = a.typePriority === 0 && a.type === "contact"
  var bContact = b.typePriority === 0 && b.type === "contact"
  if (aContact !== bContact) {
    var contact = aContact ? a : b
    var rival = aContact ? b : a
    var contactWins = (contact.frecency > 1 && contact.frecency > rival.frecency)
      || (hasStrongMatch(contact) && !hasStrongMatch(rival))
    if (!contactWins) return aContact ? 1 : -1
  }

  if (context.hasExactTitle) {
    var aExactTitle = a.titleMatch === "exact", bExactTitle = b.titleMatch === "exact"
    if (aExactTitle && bExactTitle) {
      var classDiff = searchTermRank(b.searchTerm) - searchTermRank(a.searchTerm)
      if (classDiff !== 0) return classDiff
      if (a.frecency !== b.frecency) return b.frecency - a.frecency
      return comparePlain(a, b)
    }
    if (aExactTitle !== bExactTitle) return aExactTitle ? -1 : 1
  }

  if (aTermExact !== bTermExact) return aTermExact ? -1 : 1
  if (aTermExact && bTermExact) {
    if (a.frecency !== b.frecency) return b.frecency - a.frecency
    return comparePlain(a, b)
  }

  if (a.subtitleExact !== b.subtitleExact) return a.subtitleExact ? -1 : 1
  if (a.subtitleExact && b.subtitleExact) {
    if (a.frecency !== b.frecency) return b.frecency - a.frecency
    if (a.titleScore !== b.titleScore) return b.titleScore - a.titleScore
    return comparePlain(a, b)
  }

  var aAliasPrefix = a.alias === "prefix", bAliasPrefix = b.alias === "prefix"
  if (aAliasPrefix !== bAliasPrefix) return aAliasPrefix ? -1 : 1
  var aTermPrefix = a.searchTerm.kind === "prefix", bTermPrefix = b.searchTerm.kind === "prefix"
  if (aTermPrefix !== bTermPrefix) return aTermPrefix ? -1 : 1
  if ((aAliasPrefix && bAliasPrefix) || (aTermPrefix && bTermPrefix)) {
    if (a.frecency !== b.frecency) return b.frecency - a.frecency
  }

  var ao = overboundsCount(a), bo = overboundsCount(b)
  if ((ao >= 3 || bo >= 3) && ao !== bo) return bo - ao

  var aBest = Math.max(a.titleScore, a.subtitleScore)
  var bBest = Math.max(b.titleScore, b.subtitleScore)
  if (aBest !== bBest) return bBest - aBest

  if (a.frecency !== b.frecency) return b.frecency - a.frecency
  if (a.titleScore !== b.titleScore) return b.titleScore - a.titleScore
  if (a.typePriority !== b.typePriority) return b.typePriority - a.typePriority
  var h = heuristic(a) - heuristic(b)
  if (h !== 0) return h
  return collate(a.candidate.title, b.candidate.title)
}

function sign(x) {
  return x < 0 ? -1 : (x > 0 ? 1 : 0)
}

function stableSort(records, compare) {
  var indexed = records.map(function(r, i) { return { r: r, i: i } })
  indexed.sort(function(x, y) {
    var c = sign(compare(x.r, y.r))
    return c !== 0 ? c : x.i - y.i
  })
  return indexed.map(function(x) { return x.r })
}

function pinOf(record) {
  var p = record.candidate.pinPriority
  return typeof p === "number" && isFinite(p) ? p : null
}

function bucketContext(records) {
  return {
    hasExactTitle: records.some(function(r) { return r.titleMatch === "exact" }),
    hasExactSearchTerm: records.some(function(r) { return r.searchTerm.kind === "exact" })
  }
}

function byPinThen(then) {
  return function(a, b) {
    var d = pinOf(a) - pinOf(b)
    return d !== 0 ? d : then(a, b)
  }
}

// Hoisted prefilter for rank(): O(total text length) subsequence scan over
// every searchable field. A candidate that fails here cannot text-match
// (every fuzzyMatch needs its non-separator chars in order), so rank()
// skips transliterate + all DP work for it. Provably result-identical:
// candidates with alias/searchTerms/boosts/pins/alwaysMatching always
// take the full path. [D]
function subseqHit(text, q) {
  var t = String(text || "").toLowerCase()
  var qq = String(q || "").toLowerCase()
  var gi = 0
  for (var i = 0; i < qq.length; i++) {
    var ch = qq.charAt(i)
    if (isSeparator(ch)) continue
    gi = t.indexOf(ch, gi)
    if (gi < 0) return false
    gi++
  }
  return true
}

function needsFullRecord(c, q, tq) {
  if (c.alwaysMatching || pinOf({ candidate: c }) !== null) return true
  if (c.alias) return true
  if (c.boostedTerms && c.boostedTerms.length) return true
  if (c.searchTerms && c.searchTerms.length) return true
  // Compare in transliterated space: buildRecord matches transliterate()
  // output, so gating on raw strings would falsely reject ("cafe" vs
  // "Café" — the blocker the differential-fuzz review caught). [D]
  var t = transliterateCached(String(c.title || ""))
  if (subseqHit(t, tq)) return true
  var alts = c.alternateTitles || []
  for (var i = 0; i < alts.length; i++) if (subseqHit(transliterateCached(alts[i]), tq)) return true
  if (c.subtitle && subseqHit(transliterateCached(c.subtitle), tq)) return true
  var kw = c.keywords || []
  for (var k = 0; k < kw.length; k++) if (subseqHit(transliterateCached(kw[k]), tq)) return true
  if (c.bundleId && q.indexOf(".") !== -1 && subseqHit(transliterateCached(c.bundleId), tq)) return true
  if (c.subtitle && (subseqHit(transliterateCached(String(c.title || "") + " " + c.subtitle), tq)
    || subseqHit(transliterateCached(c.subtitle + " " + String(c.title || "")), tq))) return true
  return false
}

function rank(candidates, query, options) {
  var list = Array.isArray(candidates) ? candidates : []
  var q = String(query || "").trim()
  var ql = q.toLowerCase()
  var opts = options || {}
  if (opts.tq === undefined) opts = Object.assign({}, opts, { tq: transliterateCached(ql) })
  var records = []
  for (var mi = 0; mi < list.length; mi++) {
    // Fast reject before transliterate + DP: provably non-matching
    // candidates are dropped without a record (they match nothing and
    // carry no pin/alias/terms that bucketing could observe). [D]
    if (q && !needsFullRecord(list[mi], ql, opts.tq)) continue
    records.push(buildRecord(list[mi], q, opts))
  }
  var ordered

  if (!q) {
    var pinned = records.filter(function(r) { return pinOf(r) !== null })
    var rest = records.filter(function(r) { return pinOf(r) === null })
    ordered = stableSort(pinned, byPinThen(comparePlain)).concat(stableSort(rest, comparePlain))
  } else {
    var b1 = [], b2 = [], b3 = [], b4 = []
    for (var i = 0; i < records.length; i++) {
      var r = records[i]
      if (!r.isMatching) continue
      var isPinned = pinOf(r) !== null
      if (isPinned && r.textMatched) b1.push(r)
      else if (isPinned) b2.push(r)
      else if (r.textMatched) b3.push(r)
      else b4.push(r)
    }
    var c1 = bucketContext(b1), c3 = bucketContext(b3)
    ordered = stableSort(b1, byPinThen(function(a, b) { return compareMatched(a, b, c1) }))
      .concat(stableSort(b2, byPinThen(comparePlain)))
      .concat(stableSort(b3, function(a, b) { return compareMatched(a, b, c3) }))
      .concat(stableSort(b4, comparePlain))
  }

  return ordered.map(function(r) { return { candidate: r.candidate, record: r } })
}

if (typeof module !== "undefined") {
  module.exports = {
    SEPARATORS: SEPARATORS,
    TYPE_PRIORITY: TYPE_PRIORITY,
    normalize: normalize,
    transliterate: transliterate,
    fuzzyMatch: fuzzyMatch,
    matchScore: matchScore,
    passesThreshold: passesThreshold,
    aliasMatch: aliasMatch,
    searchTermMatch: searchTermMatch,
    wholeWordIn: wholeWordIn,
    buildRecord: buildRecord,
    comparePlain: comparePlain,
    compareMatched: compareMatched,
    rank: rank
  }
}
