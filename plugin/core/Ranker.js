// Root-search ranking, ported from Raycast (reference/02-backend.md §4.2–4.5,
// SPEC §7.3). Keep this literal: generic fuzzy finders rank differently.
//
// Candidate shape:
//   {
//     id, type,                 // type: application | command | quicklink | menu-bar | preference | file | calendar-event | contact
//     title, subtitle?,
//     alternateTitles?: [string], keywords?: [string],
//     alias?,                   // user alias, matched exact/prefix
//     bundleId?,                // app id; a keyword only when the query contains "."
//     frecency?,                // score from Frecency.score(), default 1
//     openedAt?,                // ms of last launch
//     searchTerms?: [{term, at}] | [string],   // queries that launched it
//     pinPriority?,             // number: pinned candidate, lower first
//     alwaysMatching?,          // listed even when the text does not match
//     sortHeuristic?, extensionTitle?,
//     boostedTerms?: [string]   // queries for which it is a boosted search term (Raycast dXi)
//   }

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

// SEPARATORS as a lookup table: isSeparator runs per cell of the fuzzy match.
var SEPARATOR_SET = (function() {
  var set = Object.create(null)
  for (var i = 0; i < SEPARATORS.length; i++) set[SEPARATORS.charAt(i)] = true
  return set
})()

function isSeparator(ch) {
  return SEPARATOR_SET[ch] === true
}

// ---------------------------------------------------------- normalisation

// normalize() and transliterate() depend only on their input, and root
// search feeds them the same titles, subtitles and keywords on every
// keystroke, so their results are memoized by string. Callers must treat
// the returned values as read-only. [D] Each cache is dropped whole once it
// holds CACHE_LIMIT entries, which bounds memory without LRU bookkeeping.
var CACHE_LIMIT = 8192

function createCache() {
  return { entries: Object.create(null), size: 0 }
}

var normalizeCache = createCache()
var transliterateCache = createCache()

function cacheGet(cache, key) {
  return cache.entries[key]
}

function cacheSet(cache, key, value) {
  if (cache.size >= CACHE_LIMIT) {
    cache.entries = Object.create(null)
    cache.size = 0
  }
  cache.entries[key] = value
  cache.size++
  return value
}

function clearCaches() {
  normalizeCache = createCache()
  transliterateCache = createCache()
}

// Char-code forms of /[a-z0-9]/ and /[A-Z]/ (ASCII only, as before).
function isLowerOrDigit(code) {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57)
}

function isUpper(code) {
  return code >= 65 && code <= 90
}

// {normalizedText, wordBoundaries}: boundaries[n] is true when char n-1 is
// [a-z0-9] and char n is [A-Z] (camelCase), from the original casing.
function normalize(s) {
  var text = String(s === undefined || s === null ? "" : s)
  var cached = cacheGet(normalizeCache, text)
  if (cached !== undefined) return cached
  var boundaries = []
  for (var i = 0; i < text.length; i++) {
    boundaries.push(i > 0 && isLowerOrDigit(text.charCodeAt(i - 1)) && isUpper(text.charCodeAt(i)))
  }
  return cacheSet(normalizeCache, text, { normalizedText: text.toLowerCase(), wordBoundaries: boundaries })
}

var TRANSLIT = {
  "ß": "ss", "æ": "ae", "Æ": "AE", "ø": "o", "Ø": "O", "đ": "d", "Đ": "D",
  "ł": "l", "Ł": "L", "œ": "oe", "Œ": "OE", "þ": "th", "Þ": "Th", "ð": "d", "Ð": "D",
  "ı": "i", "ħ": "h", "Ħ": "H"
}

// ASCII transliteration. Keeps the string length stable for single-char
// diacritic folds; the multi-char map entries may lengthen it.
function transliterate(s) {
  var input = String(s === undefined || s === null ? "" : s)
  var cached = cacheGet(transliterateCache, input)
  if (cached !== undefined) return cached
  var text = input
  if (typeof text.normalize === "function") text = text.normalize("NFD").replace(/[̀-ͯ]/g, "")
  var out = ""
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i)
    out += TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch
  }
  return cacheSet(transliterateCache, input, out)
}

// ------------------------------------------------------------ fuzzy match

// af(target, query, {literalQueryDots}) → "exact" | "unmatched" | {score, skipped}.
function fuzzyMatch(target, query, options) {
  var literalDots = !!(options && options.literalQueryDots)
  var tn = normalize(target)
  var t = tn.normalizedText
  var bounds = tn.wordBoundaries
  var q = String(query === undefined || query === null ? "" : query).toLowerCase()

  function querySep(ch) {
    if (literalDots && ch === ".") return false
    return isSeparator(ch)
  }

  if (q.length === 0) return "unmatched"  // [I] callers handle the empty query before matching
  if (t === q) return "exact"

  var sepCount = 0
  for (var i = 0; i < q.length; i++) if (querySep(q.charAt(i))) sepCount++
  var u = q.length - sepCount
  if (u > t.length) return "unmatched"

  // Subsequence precheck.
  if (u > 2) {
    var ti = 0
    for (var qi = 0; qi < q.length; qi++) {
      var qc = q.charAt(qi)
      if (querySep(qc)) {
        // [I] "skips one separator in the target if one is present": advance
        // past the next target separator when there is one, else ignore.
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
      else if (p === 0 && e === 0) cellScore = 4 // [I] "first row" = first row that matches (p == 0)
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
      // [I] An unmatched separator row is dropped; for the last row the
      // previous row's best still stands, so a trailing space does not unmatch.
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

// of(): exact → +MAX, unmatched/absent → -MAX, else the score.
function matchScore(match) {
  if (match === "exact") return MAX
  if (!match || match === "unmatched") return -MAX
  return match.score
}

// rf(match, queryLen, sensitivity), default medium [O backend default].
function passesThreshold(match, queryLength, sensitivity) {
  if (match === "exact") return true
  if (!match || match === "unmatched") return false
  var mode = sensitivity || "medium"
  var len = queryLength - match.skipped
  if (mode === "low") return true
  if (mode === "high") return match.score > 2 * len
  return match.score >= 1.5 * (len - 2) + 4
}

// J7e(alias, query)
function aliasMatch(alias, query) {
  var a = String(alias || "").toLowerCase()
  var q = String(query || "").toLowerCase()
  if (!a || !q) return "unmatched"
  if (a === q) return "exact"
  if (a.length > q.length && a.indexOf(q) === 0) return "prefix"
  return "unmatched"
}

// Y7e: learned search terms. Count only for items with frecency > 1 opened
// within 17 days. Best kept: exact > prefix > overbounds (larger count).
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

// exact 3 > prefix 2 > overbounds 1 (larger count better) > none 0.
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

// q7e: does `q` occur in `title` as a whole word (start/end, separator or
// camelCase boundary on both sides)?
function wholeWordIn(title, q) {
  var tn = normalize(title)
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

// ---------------------------------------------------------- per candidate

// iXi: the ranking record for one candidate against a query.
function buildRecord(candidate, query, options) {
  var opts = options || {}
  var sensitivity = opts.sensitivity || "medium"
  var nowMs = typeof opts.nowMs === "number" ? opts.nowMs : Date.now()
  var literalDots = !!opts.literalQueryDots
  var c = candidate || {}
  var q = String(query || "").trim().toLowerCase() // [I] surrounding whitespace is not part of the query
  var tq = transliterate(q)
  var frecency = typeof c.frecency === "number" && isFinite(c.frecency) ? c.frecency : 1

  var title = transliterate(String(c.title || ""))
  // JYi: a query starting with "/" matches the title's first "/" as a space.
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
    titleMatch: "none",           // exact | prefix | none
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
  record.keywords = keywords.map(function(k) { return fuzzyMatch(String(k || ""), q, { literalQueryDots: literalDots }) })

  record.searchTerm = searchTermMatch(c.searchTerms, q, frecency, c.openedAt, nowMs)

  // Title boost ($Yi/eXi): queries of 3+ chars without whitespace.
  if (q.length >= 3 && !/\s/.test(q)) {
    if (record.title !== "exact" && wholeWordIn(title, tq)) {
      var floor = 4 + (q.length - 1) * 2 + 0.5
      if (record.titleScore < floor) record.titleScore = floor
    }
    var exactAlternate = record.alternates.some(function(m) { return m === "exact" })
    if (exactAlternate) {
      record.titleMatch = "exact"
    } else {
      // [I] Literal reading: the alternate-title max is part of the boost step.
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

// ------------------------------------------------------------- ordering

var COLLATE_OPTIONS = { numeric: true, sensitivity: "base" }
// ECMA-402 defines localeCompare(b, locales, options) as a new Collator's
// compare, so one shared Collator orders the same without building one per
// comparison. QML's engine may lack Intl; it keeps the localeCompare path.
var collator = typeof Intl !== "undefined" && Intl.Collator ? new Intl.Collator(undefined, COLLATE_OPTIONS) : null

function collate(a, b) {
  if (collator) return collator.compare(String(a || ""), String(b || ""))
  return String(a || "").localeCompare(String(b || ""), undefined, COLLATE_OPTIONS)
}

function heuristic(record) {
  var h = record.candidate.sortHeuristic
  return typeof h === "number" && isFinite(h) ? h : 0 // [I] missing heuristic sorts as 0
}

// B4: plain tiebreak.
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

// sXi: main comparator for text-matched candidates. ctx = {hasExactTitle,
// hasExactSearchTerm} over the bucket being sorted.
function compareMatched(a, b, ctx) {
  var context = ctx || {}
  var aExactAlias = a.alias === "exact", bExactAlias = b.alias === "exact"
  // 1. exact alias
  if (aExactAlias !== bExactAlias) return aExactAlias ? -1 : 1

  var aTermExact = a.searchTerm.kind === "exact", bTermExact = b.searchTerm.kind === "exact"
  // 2. exact title somewhere and exact search term somewhere
  if (context.hasExactTitle && context.hasExactSearchTerm) {
    if (aTermExact !== bTermExact) return aTermExact ? -1 : 1
    if (aTermExact && bTermExact && a.frecency !== b.frecency) return b.frecency - a.frecency
  }

  // 3. boosted search term, unless the other is more frecent (> 1)
  if (a.isBoostedSearchTerm !== b.isBoostedSearchTerm) {
    var boosted = a.isBoostedSearchTerm ? a : b
    var other = a.isBoostedSearchTerm ? b : a
    if (!(other.frecency > 1 && other.frecency > boosted.frecency)) return a.isBoostedSearchTerm ? -1 : 1
  }

  // 4. contacts lose unless more frecent or more strongly matched
  var aContact = a.typePriority === 0 && a.type === "contact"
  var bContact = b.typePriority === 0 && b.type === "contact"
  if (aContact !== bContact) {
    var contact = aContact ? a : b
    var rival = aContact ? b : a
    var contactWins = (contact.frecency > 1 && contact.frecency > rival.frecency)
      || (hasStrongMatch(contact) && !hasStrongMatch(rival))
    if (!contactWins) return aContact ? 1 : -1
  }

  // 5. exact titles
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

  // 6. exact search term
  if (aTermExact !== bTermExact) return aTermExact ? -1 : 1
  if (aTermExact && bTermExact) {
    if (a.frecency !== b.frecency) return b.frecency - a.frecency
    return comparePlain(a, b)
  }

  // 7. exact subtitle
  if (a.subtitleExact !== b.subtitleExact) return a.subtitleExact ? -1 : 1
  if (a.subtitleExact && b.subtitleExact) {
    if (a.frecency !== b.frecency) return b.frecency - a.frecency
    if (a.titleScore !== b.titleScore) return b.titleScore - a.titleScore
    return comparePlain(a, b)
  }

  // 8. alias prefix, then search-term prefix
  var aAliasPrefix = a.alias === "prefix", bAliasPrefix = b.alias === "prefix"
  if (aAliasPrefix !== bAliasPrefix) return aAliasPrefix ? -1 : 1
  var aTermPrefix = a.searchTerm.kind === "prefix", bTermPrefix = b.searchTerm.kind === "prefix"
  if (aTermPrefix !== bTermPrefix) return aTermPrefix ? -1 : 1
  // [I] "if both prefix": either both alias-prefix or both term-prefix.
  if ((aAliasPrefix && bAliasPrefix) || (aTermPrefix && bTermPrefix)) {
    if (a.frecency !== b.frecency) return b.frecency - a.frecency
  }

  // 9. overbounds: a count of 3+ on either side decides
  var ao = overboundsCount(a), bo = overboundsCount(b)
  if ((ao >= 3 || bo >= 3) && ao !== bo) return bo - ao

  // 10. best of title and subtitle score
  var aBest = Math.max(a.titleScore, a.subtitleScore)
  var bBest = Math.max(b.titleScore, b.subtitleScore)
  if (aBest !== bBest) return bBest - aBest

  // 11. frecency
  if (a.frecency !== b.frecency) return b.frecency - a.frecency
  // 12. title score
  if (a.titleScore !== b.titleScore) return b.titleScore - a.titleScore
  // 13. type priority
  if (a.typePriority !== b.typePriority) return b.typePriority - a.typePriority
  // 14. sort heuristic
  var h = heuristic(a) - heuristic(b)
  if (h !== 0) return h
  // 15. title collator
  return collate(a.candidate.title, b.candidate.title)
}

function sign(x) {
  return x < 0 ? -1 : (x > 0 ? 1 : 0)
}

// Stable sort (index tiebreak), independent of the engine's sort.
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

// cXi: ordered [{candidate, record}] for a section's candidates.
function rank(candidates, query, options) {
  var list = Array.isArray(candidates) ? candidates : []
  var q = String(query || "").trim()
  var records = list.map(function(c) { return buildRecord(c, q, options) })
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
    CACHE_LIMIT: CACHE_LIMIT,
    normalize: normalize,
    transliterate: transliterate,
    clearCaches: clearCaches,
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
