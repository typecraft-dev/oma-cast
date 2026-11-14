// Emoji & Symbols (ref 04 §1 emoji-picker): data parsing, search, sections,
// skin tones and grid navigation. Pure JS, shared by QML and node tests.

var COLUMNS = 8          // ref 04 §1 columnCount = 8 [O]
var RECENT_LIMIT = 16    // two grid rows [I]

// Raycast's skin tone setting (ref 04 App. B emojiSkinTone) [O]; ids [D].
var TONES = [
  { id: "none", title: "Default", modifier: "" },
  { id: "light", title: "Light", modifier: "🏻" },
  { id: "medium-light", title: "Medium-Light", modifier: "🏼" },
  { id: "medium", title: "Medium", modifier: "🏽" },
  { id: "medium-dark", title: "Medium-Dark", modifier: "🏾" },
  { id: "dark", title: "Dark", modifier: "🏿" }
]

// data: data/emoji.json; keywordsRaw: Omarchy's emojis.json ([{e, k}]),
// whose keywords are merged in when it is present.
function parse(dataRaw, keywordsRaw) {
  var data
  try { data = JSON.parse(String(dataRaw || "")) } catch (e) { return { groups: [], list: [] } }
  var extra = {}
  try {
    var omarchy = JSON.parse(String(keywordsRaw || "[]"))
    for (var i = 0; i < omarchy.length; i++) if (omarchy[i] && omarchy[i].e) extra[omarchy[i].e] = String(omarchy[i].k || "")
  } catch (e) {}
  var groups = data.groups || []
  var list = (data.emoji || []).map(function(r) {
    var name = String(r[1])
    return {
      symbol: r[0], name: name, title: titleCase(name), group: groups[r[2]] || "", toneable: r[3] === 1,
      // Omarchy's keywords lack the emoji-variation selector on some symbols.
      words: (name + " " + (extra[r[0]] || extra[r[0].replace(/\uFE0F/g, "")] || "")).toLowerCase()
    }
  })
  return { groups: groups, list: list }
}

function titleCase(name) {
  return name.replace(/(^|[\s:(-])([a-z])/g, function(_, pre, ch) { return pre + ch.toUpperCase() })
}

function applyTone(symbol, tone) {
  var t = TONES.filter(function(x) { return x.id === tone })[0]
  if (!t || !t.modifier) return symbol
  // Not Array.from: QML's engine splits strings into UTF-16 units there.
  var first = codePoints(symbol)[0] || ""
  var rest = symbol.slice(first.length)
  return first + t.modifier + (rest.charAt(0) === "\uFE0F" ? rest.slice(1) : rest)
}

function codePoints(s) {
  var out = []
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i)
    var pair = c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length
    out.push(pair ? s.slice(i, i + 2) : s.charAt(i))
    if (pair) i++
  }
  return out
}

// 0 no match; higher is better. Every query word must start a word of the
// name or keywords. Whole words beat prefixes ("lol" finds 😂 before 🍭),
// the name beats keywords, and the exact name wins. [I]
function matchScore(item, words) {
  var name = item.name.toLowerCase()
  var score = 0
  for (var i = 0; i < words.length; i++) {
    var w = words[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    var start = "(^|[\\s:_-])" + w, whole = start + "($|[\\s:_-])"
    if (new RegExp(whole).test(name)) score += 4
    else if (new RegExp(whole).test(item.words)) score += 3
    else if (new RegExp(start).test(name)) score += 2
    else if (new RegExp(start).test(item.words)) score += 1
    else return 0
  }
  if (name === words.join(" ")) score += 10
  return score
}

// state: { pinned: [symbol], recent: [symbol by frecency], tone, filter }
function sections(list, query, state) {
  var words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean)
  var filter = state.filter && state.filter !== "all" ? state.filter : ""
  var bySymbol = {}
  for (var i = 0; i < list.length; i++) bySymbol[list[i].symbol] = list[i]
  function rows(items) { return items.map(function(e) { return candidate(e, state.tone, state.pinned) }) }

  if (words.length) {
    var hits = [], recentAt = {}
    ;(state.recent || []).forEach(function(sym, n) { recentAt[sym] = n })
    for (var j = 0; j < list.length; j++) {
      if (filter && list[j].group !== filter) continue
      var e = list[j], r = recentAt[e.symbol] === undefined ? Infinity : recentAt[e.symbol]
      if (state.fleaHits) {
        // Flea's engine (bin/omacast-search, SPEC §2.0): the best field wins,
        // then the name match, then recently used, then Unicode order.
        var h = state.fleaHits[e.symbol]
        if (h) hits.push({ e: e, s: Math.max(h.title || 0, h.keyword || 0), r: r, t: h.title || 0, i: j })
      } else {
        var s = matchScore(e, words)
        if (s) hits.push({ e: e, s: s, r: r, t: 0, i: j })
      }
    }
    hits.sort(function(a, b) { return b.s - a.s || b.t - a.t || (a.r === b.r ? 0 : a.r < b.r ? -1 : 1) || a.i - b.i })
    return hits.length ? [{ id: "results", title: "Results", rows: rows(hits.map(function(h) { return h.e })) }] : []
  }

  var out = []
  if (!filter) {
    var pinned = (state.pinned || []).map(function(s) { return bySymbol[s] }).filter(Boolean)
    var recent = (state.recent || []).filter(function(s) { return (state.pinned || []).indexOf(s) < 0 })
      .map(function(s) { return bySymbol[s] }).filter(Boolean).slice(0, RECENT_LIMIT)
    if (pinned.length) out.push({ id: "pinned", title: "Pinned", rows: rows(pinned) })
    if (recent.length) out.push({ id: "recent", title: "Recently Used", rows: rows(recent) })
  }
  var byGroup = {}, order = []
  for (var k = 0; k < list.length; k++) {
    var g = list[k].group
    if (filter && g !== filter) continue
    if (!byGroup[g]) { byGroup[g] = []; order.push(g) }
    byGroup[g].push(list[k])
  }
  for (var n = 0; n < order.length; n++) out.push({ id: "group-" + n, title: order[n], rows: rows(byGroup[order[n]]) })
  return out
}

function candidate(e, tone, pinned) {
  var symbol = e.toneable ? applyTone(e.symbol, tone) : e.symbol
  return {
    id: "emoji:" + e.symbol, type: "emoji", kind: "emoji", title: e.title, subtitle: e.group,
    glyph: symbol, symbol: symbol, pinned: (pinned || []).indexOf(e.symbol) >= 0
  }
}

// tone: the current skin tone, offered as "Skin Tone: …" actions.
function actionsFor(c, tone) {
  return [
    { id: "paste", title: "Paste to Active App", shortcut: "↵", section: "primary", icon: "" },
    { id: "copy", title: "Copy to Clipboard", shortcut: "Ctrl ↵", section: "primary", icon: "" },
    { id: "copy-name", title: "Copy Name", shortcut: "Ctrl Shift C", section: "copy", icon: "" },
    { id: c.pinned ? "unpin" : "pin", title: c.pinned ? "Unpin Emoji" : "Pin Emoji", shortcut: "Ctrl Shift P", section: "pin", icon: "" },
    { id: "remove-recent", title: "Remove from Recently Used", shortcut: "Ctrl D", section: "delete", icon: "" },
    { id: "clear-recent", title: "Clear Recently Used", shortcut: "Ctrl Shift D", section: "delete", icon: "" }
  ].concat(TONES.map(function(t) {
    return { id: "tone:" + t.id, title: "Skin Tone: " + t.title, shortcut: "", section: "tone", icon: t.id === tone ? "✓" : "" }
  }))
}

function aboutFor(c, e) {
  return [
    { label: "Emoji", value: c.symbol },
    { label: "Name", value: c.title },
    { label: "Category", value: c.subtitle },
    { label: "Code Points", value: codePoints(c.symbol).map(function(ch) { return "U+" + ch.codePointAt(0).toString(16).toUpperCase() }).join(" ") },
    { label: "Keywords", value: e ? e.words.slice(e.name.length).trim().split(/\s+/).filter(Boolean).join(", ") : "" }
  ].filter(function(r) { return r.value })
}

// Flea search entries (FleaSearch.entries input): the name as title and
// the extra keywords; ids are the symbols.
function searchEntries(list) {
  return list.map(function(e) {
    return { title: e.name, keywords: e.words.slice(e.name.length).split(/\s+/).filter(Boolean) }
  })
}

// Packs sections into grid lines: [{section}, {cells: [candidate…]}].
function gridLines(sectionList, columns) {
  var out = []
  for (var s = 0; s < sectionList.length; s++) {
    out.push({ section: sectionList[s] })
    var rows = sectionList[s].rows
    for (var i = 0; i < rows.length; i += columns) out.push({ cells: rows.slice(i, i + columns) })
  }
  return out
}

if (typeof module !== "undefined") {
  module.exports = {
    COLUMNS: COLUMNS, RECENT_LIMIT: RECENT_LIMIT, TONES: TONES,
    parse: parse, titleCase: titleCase, applyTone: applyTone, codePoints: codePoints, matchScore: matchScore,
    sections: sections, searchEntries: searchEntries, candidate: candidate, actionsFor: actionsFor, aboutFor: aboutFor, gridLines: gridLines
  }
}
