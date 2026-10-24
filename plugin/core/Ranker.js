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

function isSeparator(ch) {
  return ch !== "" && SEPARATORS.indexOf(ch) !== -1
}

// isSeparator by char code: \t \n space - . / ( ) [ ]
function isSeparatorCode(code) {
  switch (code) {
    case 9: case 10: case 32: case 45: case 46: case 47: case 40: case 41: case 91: case 93: return true
    default: return false
  }
}

// ---------------------------------------------------------- normalisation

// Per-string memo for normalize/transliterate. Candidate strings repeat on
// every keystroke, and recomputing them was most of the search time. [D]
// Plain prototype-less objects: Qt's JS engine looks string keys up there
// several times faster than in a Map.
var MEMO_LIMIT = 20000

function newMemo() {
  return { table: Object.create(null), size: 0 }
}

function memoGet(memo, key) {
  return memo.table[key]
}

function memoSet(memo, key, value) {
  if (memo.size >= MEMO_LIMIT) { memo.table = Object.create(null); memo.size = 0 }
  if (memo.table[key] === undefined) memo.size++
  memo.table[key] = value
}

var normalizeMemo = newMemo()
var translitMemo = newMemo()

function isLowerOrDigit(code) {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57)
}

// {normalizedText, wordBoundaries}: boundaries[n] is true when char n-1 is
// [a-z0-9] and char n is [A-Z] (camelCase), from the original casing.
// The result is shared through the memo; callers must not mutate it.
function normalize(s) {
  var text = String(s === undefined || s === null ? "" : s)
  var hit = memoGet(normalizeMemo, text)
  if (hit) return hit
  var boundaries = new Array(text.length)
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i)
    boundaries[i] = i > 0 && code >= 65 && code <= 90 && isLowerOrDigit(text.charCodeAt(i - 1))
  }
  var lower = text.toLowerCase()
  // For the fuzzy matcher: separator flags and positions, and word starts
  // (a camelCase boundary or the char after a separator).
  var seps = new Array(lower.length)
  var starts = new Array(lower.length)
  var sepPositions = []
  for (var j = 0; j < lower.length; j++) {
    seps[j] = isSeparatorCode(lower.charCodeAt(j))
    if (seps[j]) sepPositions.push(j)
    starts[j] = !!boundaries[j] || (j > 0 && seps[j - 1])
  }
  var out = { normalizedText: lower, wordBoundaries: boundaries, seps: seps, starts: starts, sepPositions: sepPositions }
  memoSet(normalizeMemo, text, out)
  return out
}

var TRANSLIT = {
  "ß": "ss", "æ": "ae", "Æ": "AE", "ø": "o", "Ø": "O", "đ": "d", "Đ": "D",
  "ł": "l", "Ł": "L", "œ": "oe", "Œ": "OE", "þ": "th", "Þ": "Th", "ð": "d", "Ð": "D",
  "ı": "i", "ħ": "h", "Ħ": "H"
}

// ASCII transliteration. Keeps the string length stable for single-char
// diacritic folds; the multi-char map entries may lengthen it.
function transliterate(s) {
  var text = String(s === undefined || s === null ? "" : s)
  var hit = memoGet(translitMemo, text)
  if (hit !== undefined) return hit
  var out = text
  // Plain ASCII has nothing to fold.
  if (/[^\x00-\x7f]/.test(text)) {
    if (typeof text.normalize === "function") text = text.normalize("NFD").replace(/[̀-ͯ]/g, "")
    out = ""
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i)
      out += TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch
    }
  }
  memoSet(translitMemo, text, out)
  return out
}

// ------------------------------------------------------------ fuzzy match

// af(target, query, {literalQueryDots}) → "exact" | "unmatched" | {score, skipped}.
function fuzzyMatch(target, query, options) {
  return matchNormalized(normalize(target), query, options)
}

// fuzzyMatch on an already normalized target. Works on char codes with two
// reused score rows; the scores are the same as the cell-by-cell
// description in ref 02 §4.3.
function matchNormalized(tn, query, options) {
  var literalDots = !!(options && options.literalQueryDots)
  var t = tn.normalizedText
  var bounds = tn.wordBoundaries
  var q = String(query === undefined || query === null ? "" : query).toLowerCase()

  if (q.length === 0) return "unmatched"
  if (t === q) return "exact"

  var qSep = new Array(q.length)
  var sepCount = 0
  for (var i = 0; i < q.length; i++) {
    var code = q.charCodeAt(i)
    qSep[i] = !(literalDots && code === 46) && isSeparatorCode(code)
    if (qSep[i]) sepCount++
  }
  var u = q.length - sepCount
  if (u > t.length) return "unmatched"

  // One non-separator character: the DP is a single row whose best cell is
  // 4 at position 0, else 3 at a word start, else 2.
  if (q.length === 1 && sepCount === 0) {
    var at = t.indexOf(q)
    if (at < 0) return "unmatched"
    if (at === 0) return { score: 4, skipped: 0 }
    if (isSeparatorCode(q.charCodeAt(0))) return { score: 2, skipped: 0 } // a literal "."
    for (; at >= 0; at = t.indexOf(q, at + 1)) {
      if (bounds[at] || isSeparatorCode(t.charCodeAt(at - 1))) return { score: 3, skipped: 0 }
    }
    return { score: 2, skipped: 0 }
  }

  // Subsequence precheck. The DP below only matches query characters at
  // increasing positions, so without query separators a failed subsequence
  // test is always "unmatched"; running it for short queries too only skips
  // work. [D] (Raycast runs it for u > 2.)
  if (u > 2 || sepCount === 0) {
    var ti = 0
    for (var qi = 0; qi < q.length; qi++) {
      if (qSep[qi]) {
        // [I] "skips one separator in the target if one is present": advance
        // past the next target separator when there is one, else ignore.
        for (var s = ti; s < t.length; s++) {
          if (isSeparatorCode(t.charCodeAt(s))) { ti = s + 1; break }
        }
        continue
      }
      var found = t.indexOf(q.charAt(qi), ti)
      if (found < 0) return "unmatched"
      ti = found + 1
    }
  }

  // The DP, sparse: a row only has cells where the target character equals
  // the query character (any separator, for a separator row), so each row
  // walks those positions with indexOf instead of every column. Scores are
  // the same as the dense table: a cell adds its char score to the best
  // reachable cell of the previous matched row, adjacent (e-1) for free or
  // further back for -1.
  var n = t.length
  var NEG = -Infinity
  var seps = tn.seps
  var starts = tn.starts
  var sepPositions = tn.sepPositions
  var prevPos = null, prevVal = null   // previous matched row: positions ascending, scores
  var d = -1
  var p = 0
  var skipped = 0

  for (var row = 0; row < q.length; row++) {
    var ch = q.charAt(row)
    var chSep = qSep[row]
    var end = Math.min(n, n - (u - 1 - p))
    var curPos = [], curVal = []
    var j = 0             // prev entries before j are folded into gapBest
    var gapBest = NEG     // best previous cell at or before e-2
    var sIdx = 0
    var e
    if (chSep) {
      while (sIdx < sepPositions.length && sepPositions[sIdx] <= d) sIdx++
      e = sIdx < sepPositions.length ? sepPositions[sIdx] : -1
    } else {
      e = t.indexOf(ch, d + 1)
    }

    while (e >= 0 && e < end) {
      var cellScore
      if (chSep) cellScore = 1
      else if (p === 0 && e === 0) cellScore = 4
      else cellScore = (starts[e] && !seps[e]) ? 3 : 2

      var cell
      if (p === 0) {
        cell = cellScore
      } else {
        while (j < prevPos.length && prevPos[j] <= e - 2) {
          if (prevVal[j] > gapBest) gapBest = prevVal[j]
          j++
        }
        var adjacent = j < prevPos.length && prevPos[j] === e - 1 ? prevVal[j] + cellScore : NEG
        var gapped = gapBest + cellScore - 1
        cell = adjacent > gapped ? adjacent : gapped
      }
      if (cell !== NEG) {
        curPos.push(e)
        curVal.push(cell)
      }

      if (chSep) e = ++sIdx < sepPositions.length ? sepPositions[sIdx] : -1
      else e = t.indexOf(ch, e + 1)
    }

    if (curPos.length > 0) {
      d = curPos[0]
      p++
      prevPos = curPos
      prevVal = curVal
    } else if (chSep) {
      // [I] An unmatched separator row is dropped; for the last row the
      // previous row's best still stands, so a trailing space does not unmatch.
      skipped++
    } else {
      return "unmatched"
    }
  }

  if (!prevVal) return "unmatched"
  var best = NEG
  for (var k = 0; k < prevVal.length; k++) if (prevVal[k] > best) best = prevVal[k]
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
  return wholeWordInNormalized(normalize(title), q)
}

function wholeWordInNormalized(tn, q) {
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

// The query-independent half of buildRecord, kept per candidate id while
// the candidate's text fields stay the same objects. [D]
var prepMemo = newMemo()

function prepare(c) {
  var rawTitle = String(c.title || "")
  var titleT = transliterate(rawTitle)
  var alternates = Array.isArray(c.alternateTitles) ? c.alternateTitles.map(function(a) { return String(a || "") }) : []
  var subtitle = String(c.subtitle || "")
  var keywords = Array.isArray(c.keywords) ? c.keywords.map(function(k) { return String(k || "") }) : []
  if (subtitle) {
    keywords.push(rawTitle + " " + subtitle)
    keywords.push(subtitle + " " + rawTitle)
  }
  return {
    // identity of the source fields, to tell when the entry is stale
    title: c.title, subtitle: c.subtitle, keywords: c.keywords,
    alternateTitles: c.alternateTitles, bundleId: c.bundleId,

    titleT: titleT,
    titleN: normalize(titleT),
    alternatesLower: alternates.map(function(a) { return a.toLowerCase() }),
    alternatesN: alternates.map(normalize),
    subtitleN: subtitle && subtitle.toLowerCase() !== rawTitle.toLowerCase() ? normalize(subtitle) : null,
    keywordsN: keywords.map(normalize),
    bundleN: c.bundleId ? normalize(String(c.bundleId)) : null,
    chars: null
  }
}

function prepared(c) {
  var id = c.id
  var hit = id === undefined || id === null ? undefined : memoGet(prepMemo, id)
  if (hit && hit.title === c.title && hit.subtitle === c.subtitle && hit.keywords === c.keywords
      && hit.alternateTitles === c.alternateTitles && hit.bundleId === c.bundleId) return hit
  var prep = prepare(c)
  if (id !== undefined && id !== null) memoSet(prepMemo, id, prep)
  return prep
}

// Every character any of the candidate's matched texts contains.
function charsOf(prep) {
  if (prep.chars) return prep.chars
  var set = {}
  var texts = [prep.titleN].concat(prep.alternatesN, prep.keywordsN)
  if (prep.subtitleN) texts.push(prep.subtitleN)
  if (prep.bundleN) texts.push(prep.bundleN)
  for (var i = 0; i < texts.length; i++) {
    var t = texts[i].normalizedText
    for (var j = 0; j < t.length; j++) set[t.charAt(j)] = true
  }
  prep.chars = set
  return set
}

// What a query needs from a candidate's texts: its distinct non-separator
// characters, and whether it has no separators at all (then the whole query
// must be a subsequence of one text). null when the query is not plain
// ASCII, since transliteration could then make the title match differ.
function requirements(q) {
  var chars = []
  var plain = true
  for (var i = 0; i < q.length; i++) {
    var code = q.charCodeAt(i)
    if (code > 127) return null
    if (isSeparatorCode(code)) plain = false
    else if (chars.indexOf(q.charAt(i)) < 0) chars.push(q.charAt(i))
  }
  return { query: q, chars: chars, plain: plain }
}

function isSubsequence(q, t) {
  var at = 0
  for (var i = 0; i < q.length; i++) {
    at = t.indexOf(q.charAt(i), at)
    if (at < 0) return false
    at++
  }
  return true
}

// False only when no text of the candidate can fuzzy-match: a required
// character is missing from all of them, or (for a query without
// separators) the query is a subsequence of none. Every fuzzyMatch then
// fails, so the candidate can match through its alias or alwaysMatching
// alone.
function mayTextMatch(prep, req) {
  var set = charsOf(prep)
  for (var i = 0; i < req.chars.length; i++) if (!set[req.chars[i]]) return false
  if (!req.plain) return true
  var q = req.query
  if (isSubsequence(q, prep.titleN.normalizedText)) return true
  if (prep.subtitleN && isSubsequence(q, prep.subtitleN.normalizedText)) return true
  for (var a = 0; a < prep.alternatesN.length; a++) if (isSubsequence(q, prep.alternatesN[a].normalizedText)) return true
  for (var k = 0; k < prep.keywordsN.length; k++) if (isSubsequence(q, prep.keywordsN[k].normalizedText)) return true
  if (prep.bundleN && isSubsequence(q, prep.bundleN.normalizedText)) return true
  return false
}

// iXi: the ranking record for one candidate against a query.
function buildRecord(candidate, query, options) {
  var opts = options || {}
  var sensitivity = opts.sensitivity || "medium"
  var nowMs = typeof opts.nowMs === "number" ? opts.nowMs : Date.now()
  var literalDots = !!opts.literalQueryDots
  var c = candidate || {}
  var q = String(query || "").trim().toLowerCase()
  var tq = transliterate(q)
  var frecency = typeof c.frecency === "number" && isFinite(c.frecency) ? c.frecency : 1

  var prep = prepared(c)
  var titleN = prep.titleN
  // JYi: a query starting with "/" matches the title's first "/" as a space.
  if (tq.charAt(0) === "/") titleN = normalize(prep.titleT.replace("/", " "))

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

  // Plain loops below rather than map/some callbacks: closures are costly
  // in Qt's JS engine, and this runs per candidate per keystroke.
  var i
  if (Array.isArray(c.boostedTerms)) {
    for (i = 0; i < c.boostedTerms.length; i++) {
      if (String(c.boostedTerms[i] || "").toLowerCase() === q) { record.isBoostedSearchTerm = true; break }
    }
  }

  var matchOpts = { literalQueryDots: literalDots }
  record.title = matchNormalized(titleN, tq, matchOpts)
  if (record.title === "exact") record.titleMatch = "exact"
  else if (titleN.normalizedText.indexOf(q) === 0) record.titleMatch = "prefix"
  else {
    for (i = 0; i < prep.alternatesLower.length; i++) {
      if (prep.alternatesLower[i].indexOf(q) === 0) { record.titleMatch = "prefix"; break }
    }
  }
  record.titleScore = matchScore(record.title)

  var alternates = new Array(prep.alternatesN.length)
  for (i = 0; i < alternates.length; i++) alternates[i] = matchNormalized(prep.alternatesN[i], q, matchOpts)
  record.alternates = alternates

  if (prep.subtitleN) {
    record.subtitle = matchNormalized(prep.subtitleN, q, matchOpts)
    record.subtitleExact = record.subtitle === "exact"
    record.subtitleScore = matchScore(record.subtitle)
  }

  // Keywords: the candidate's own, then "title subtitle" and "subtitle
  // title" when there is a subtitle, then the bundle id for queries with ".".
  var keywordsN = prep.keywordsN
  if (prep.bundleN && q.indexOf(".") !== -1) keywordsN = keywordsN.concat([prep.bundleN])
  var keywords = new Array(keywordsN.length)
  for (i = 0; i < keywords.length; i++) keywords[i] = matchNormalized(keywordsN[i], q, matchOpts)
  record.keywords = keywords

  record.searchTerm = searchTermMatch(c.searchTerms, q, frecency, c.openedAt, nowMs)

  // Title boost ($Yi/eXi): queries of 3+ chars without whitespace.
  if (q.length >= 3 && !/\s/.test(q)) {
    if (record.title !== "exact" && wholeWordInNormalized(titleN, tq)) {
      var floor = 4 + (q.length - 1) * 2 + 0.5
      if (record.titleScore < floor) record.titleScore = floor
    }
    if (alternates.indexOf("exact") >= 0) {
      record.titleMatch = "exact"
    } else {
      // [I] Literal reading: the alternate-title max is part of the boost step.
      for (i = 0; i < alternates.length; i++) {
        var s = matchScore(alternates[i])
        if (s > record.titleScore) record.titleScore = s
      }
    }
  }

  var len = q.length
  var matched = record.alias !== "unmatched" || passesThreshold(record.title, len, sensitivity)
  for (i = 0; !matched && i < alternates.length; i++) matched = passesThreshold(alternates[i], len, sensitivity)
  if (!matched) matched = passesThreshold(record.subtitle, len, sensitivity)
  for (i = 0; !matched && i < keywords.length; i++) matched = passesThreshold(keywords[i], len, sensitivity)
  record.textMatched = matched
  record.isMatching = !!c.alwaysMatching || record.textMatched
  return record
}

// rank() drops a candidate whose text cannot match `query` unless its alias
// matches or it is alwaysMatching. Exposed so callers can skip building
// such candidates at all; `alias` is the alias the candidate will carry.
function canSkip(candidate, alias, query) {
  var q = String(query || "").trim().toLowerCase()
  if (!q) return false
  var req = requirements(q)
  if (!req || candidate.alwaysMatching || aliasMatch(alias, q) !== "unmatched") return false
  return !mayTextMatch(prepared(candidate), req)
}

// ------------------------------------------------------------- ordering

// One collator instead of building one per localeCompare call (same
// options, same order). Engines without Intl use localeCompare.
var COLLATOR = typeof Intl !== "undefined" && Intl.Collator
  ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }) : null

function collate(a, b) {
  if (COLLATOR) return COLLATOR.compare(String(a || ""), String(b || ""))
  return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" })
}

function heuristic(record) {
  var h = record.candidate.sortHeuristic
  return typeof h === "number" && isFinite(h) ? h : 0
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
  var qLower = q.toLowerCase()
  var req = q ? requirements(qLower) : null
  var records = []
  for (var n = 0; n < list.length; n++) {
    var c = list[n] || {}
    // Would be dropped below as not matching; skip building its record.
    if (req && !c.alwaysMatching && aliasMatch(c.alias, qLower) === "unmatched"
        && !mayTextMatch(prepared(c), req)) continue
    records.push(buildRecord(c, q, options))
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
    rank: rank,
    canSkip: canSkip
  }
}
