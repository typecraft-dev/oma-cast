// GIF Library: a curated, searchable set of GIFs. New GIFs land in the Inbox
// and only reach search once they have a title and MIN_TAGS tags. [D]
// Pure JS, shared by QML and node tests.

var COLUMNS = 4
var RECENT_LIMIT = 8      // two grid rows [D]
var MIN_TAGS = 2
var UNUSED_DAYS = 90
var DUPLICATE_BITS = 6    // dHash Hamming distance at or under this is the same GIF [D]

// Quality gate at import [D]: small, huge or still images never get in.
var LIMITS = { minSide: 240, maxBytes: 8 * 1024 * 1024, minFrames: 2 }

var FILTERS = [
  { id: "all", title: "All GIFs" },
  { id: "inbox", title: "Inbox" },
  { id: "unused", title: "Unused for " + UNUSED_DAYS + " Days" }
]

function inLibrary(g) { return !!(g && g.title && (g.tags || []).length >= MIN_TAGS) }

// meta: the probe's output. Returns the reasons it fails, or [].
function check(meta) {
  var out = []
  if (!meta || meta.codec !== "gif") return ["Not a GIF"]
  if (Math.min(meta.width, meta.height) < LIMITS.minSide) out.push("Too small: " + meta.width + "×" + meta.height + ", needs " + LIMITS.minSide + "px on the short side")
  if (meta.bytes > LIMITS.maxBytes) out.push("Too large: " + formatBytes(meta.bytes) + ", the limit is " + formatBytes(LIMITS.maxBytes))
  if (meta.frames < LIMITS.minFrames) out.push("Not animated")
  return out
}

function formatBytes(n) {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"
}

// Hamming distance between two 16-hex-digit dHashes.
function distance(a, b) {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return 64
  var d = 0
  for (var i = 0; i < 16; i++) {
    var x = parseInt(a.charAt(i), 16) ^ parseInt(b.charAt(i), 16)
    while (x) { d += x & 1; x >>= 1 }
  }
  return d
}

// Adds a probed GIF. A near-duplicate keeps the existing title, tags and
// usage, and takes the larger file. Returns {gifs, status, gif, reasons,
// removeFiles}: status added | replaced | duplicate | rejected; removeFiles
// are files no entry uses any more.
function importGif(gifs, meta, nowMs) {
  var list = Array.isArray(gifs) ? gifs.slice() : []
  var mine = [meta.file, meta.thumb].filter(Boolean)
  var reasons = check(meta)
  if (reasons.length) return { gifs: list, status: "rejected", gif: null, reasons: reasons, removeFiles: mine }
  for (var i = 0; i < list.length; i++) {
    var g = list[i]
    if (g.id !== meta.id && distance(g.phash, meta.phash) > DUPLICATE_BITS) continue
    if (g.id === meta.id || meta.width * meta.height <= g.width * g.height)
      return { gifs: list, status: "duplicate", gif: g, reasons: [], removeFiles: g.id === meta.id ? [] : mine }
    var better = Object.assign({}, g, pick(meta), { source: meta.source || g.source || "" })
    list[i] = better
    return { gifs: list, status: "replaced", gif: better, reasons: [], removeFiles: [g.file, g.thumb] }
  }
  var added = Object.assign({ title: "", tags: [], addedAt: nowMs }, pick(meta), { id: meta.id, source: meta.source || "" })
  list.unshift(added)
  return { gifs: list, status: "added", gif: added, reasons: [], removeFiles: [] }
}

function pick(meta) {
  return { file: meta.file, thumb: meta.thumb, width: meta.width, height: meta.height, frames: meta.frames, bytes: meta.bytes, phash: meta.phash }
}

// The edit field: "Title, tag, tag". Tags are lowercase and unique.
function parseEdit(text) {
  var parts = String(text || "").split(",").map(function(s) { return s.trim().replace(/\s+/g, " ") })
  var title = parts.shift() || ""
  var tags = []
  parts.forEach(function(t) { t = t.toLowerCase(); if (t && tags.indexOf(t) < 0) tags.push(t) })
  return { title: title, tags: tags }
}

function editValue(g) { return [g.title || ""].concat(g.tags || []).join(", ") }

function editHint(text) {
  var e = parseEdit(text)
  if (!e.title) return "Type a title, then tags separated by commas"
  var need = MIN_TAGS - e.tags.length
  return need > 0 ? "Add " + need + " more tag" + (need > 1 ? "s" : "") + " to move it to the Library" : "Title first, then tags, separated by commas"
}

// The pasted file's name, from the title: Slack and others show it.
function fileName(g) {
  return String(g.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60).replace(/^-+|-+$/g, "") || "gif"
}

// A copied X/Twitter post link, saved automatically when the post has a GIF.
// Same pattern as bin/omacast-gif-probe.
function isXPost(text) {
  return /^https:\/\/(www\.|mobile\.)?(x|twitter)\.com\/[A-Za-z0-9_]+\/status\/[0-9]+(\/\S*)?([?#]\S*)?$/.test(String(text || "").trim())
}

// What an automatic import reports: nothing for a post or file with no GIF.
function quietOutcome(r) {
  return !r || r.status === "added" || r.status === "replaced" || r.status === "duplicate" ? r
    : (r.reasons || []).some(function(x) { return x === "No GIF in this post" || x === "Not a GIF" }) ? null : r
}

function words(g) { return ((g.title || "") + " " + (g.tags || []).join(" ")).toLowerCase() }

// Fallback scorer when the flea helper is unavailable; same rules as
// Emoji.matchScore: every query word starts a word of the title or tags.
function matchScore(g, queryWords) {
  var title = String(g.title || "").toLowerCase(), all = words(g)
  var score = 0
  for (var i = 0; i < queryWords.length; i++) {
    var w = queryWords[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    var start = "(^|[\\s,_-])" + w, whole = start + "($|[\\s,_-])"
    if (new RegExp(whole).test(title)) score += 4
    else if (new RegExp(whole).test(all)) score += 3
    else if (new RegExp(start).test(title)) score += 2
    else if (new RegExp(start).test(all)) score += 1
    else return 0
  }
  if (title === queryWords.join(" ")) score += 10
  return score
}

function lastUsed(g, items) {
  var e = items && items[g.id]
  return e && e.openedAt ? e.openedAt * 1000 : 0
}

// state: { pinned: [id], recent: [id by frecency], items: {id: frecency}, filter, fleaHits, nowMs }
function sections(list, query, state) {
  var queryWords = String(query || "").toLowerCase().split(/\s+/).filter(Boolean)
  var filter = state.filter || "all"
  var pinned = state.pinned || []
  var nowMs = state.nowMs || Date.now()
  var library = list.filter(inLibrary)
  var inbox = list.filter(function(g) { return !inLibrary(g) })
  function rows(items) { return items.map(function(g) { return candidate(g, pinned) }) }

  var pool = filter === "inbox" ? inbox : library
  if (filter === "unused") {
    var cutoff = nowMs - UNUSED_DAYS * 86400000
    pool = library.filter(function(g) { return Math.max(lastUsed(g, state.items), g.addedAt || 0) < cutoff })
      .sort(function(a, b) { return Math.max(lastUsed(a, state.items), a.addedAt || 0) - Math.max(lastUsed(b, state.items), b.addedAt || 0) })
  }

  if (queryWords.length) {
    var recentAt = {}, hits = []
    ;(state.recent || []).forEach(function(id, n) { recentAt[id] = n })
    for (var j = 0; j < pool.length; j++) {
      var g = pool[j], r = recentAt[g.id] === undefined ? Infinity : recentAt[g.id]
      // Flea's index holds Library GIFs only, so other filters score in JS.
      if (state.fleaHits && filter === "all") {
        var h = state.fleaHits[g.id]
        if (h) hits.push({ g: g, s: Math.max(h.title || 0, h.keyword || 0), t: h.title || 0, r: r, i: j })
      } else {
        var s = matchScore(g, queryWords)
        if (s) hits.push({ g: g, s: s, t: 0, r: r, i: j })
      }
    }
    hits.sort(function(a, b) { return b.s - a.s || b.t - a.t || (a.r === b.r ? 0 : a.r < b.r ? -1 : 1) || a.i - b.i })
    return hits.length ? [{ id: "results", title: "Results", rows: rows(hits.map(function(h) { return h.g })) }] : []
  }

  if (filter === "inbox") return inbox.length ? [{ id: "inbox", title: inboxTitle(inbox.length), rows: rows(inbox) }] : []
  if (filter === "unused") return pool.length ? [{ id: "unused", title: "Unused for " + UNUSED_DAYS + " Days", rows: rows(pool) }] : []

  var out = [], byId = {}
  library.forEach(function(g) { byId[g.id] = g })
  var pins = pinned.map(function(id) { return byId[id] }).filter(Boolean)
  var recent = (state.recent || []).filter(function(id) { return pinned.indexOf(id) < 0 })
    .map(function(id) { return byId[id] }).filter(Boolean).slice(0, RECENT_LIMIT)
  if (inbox.length) out.push({ id: "inbox", title: inboxTitle(inbox.length), rows: rows(inbox) })
  if (pins.length) out.push({ id: "pinned", title: "Pinned", rows: rows(pins) })
  if (recent.length) out.push({ id: "recent", title: "Recently Used", rows: rows(recent) })
  if (library.length) out.push({ id: "library", title: "Library", rows: rows(library) })
  return out
}

function inboxTitle(n) { return "Inbox · " + n + " to tag" }

function candidate(g, pinned) {
  return {
    id: "gif:" + g.id, type: "gif", kind: "gif", title: g.title || "Untitled GIF", subtitle: (g.tags || []).join(", "),
    thumb: g.thumb, file: g.file, inbox: !inLibrary(g), pinned: (pinned || []).indexOf(g.id) >= 0
  }
}

function actionsFor(c, g, appName) {
  var edit = { id: "edit", title: "Edit Title and Tags", shortcut: c.inbox ? "↵" : "Ctrl E", section: c.inbox ? "primary" : "edit", icon: "" }
  // ↵ and Ctrl+↵ (Ctrl+Shift+↵ too) run the first actions, so the labels follow the order.
  var list = c.inbox ? [edit] : []
  list.push({ id: "paste", title: "Paste to " + (appName || "Active App"), shortcut: c.inbox ? "Ctrl ↵" : "↵", section: "primary", icon: "" })
  list.push({ id: "copy", title: "Copy GIF", shortcut: c.inbox ? "Ctrl Shift ↵" : "Ctrl ↵", section: "primary", icon: "" })
  if (g && g.source) list.push({ id: "copy-source", title: "Copy Source URL", shortcut: "Ctrl Shift C", section: "copy", icon: "" })
  if (!c.inbox) {
    list.push(edit)
    list.push({ id: c.pinned ? "unpin" : "pin", title: c.pinned ? "Unpin GIF" : "Pin GIF", shortcut: "Ctrl Shift P", section: "pin", icon: "" })
  }
  list.push({ id: "delete", title: "Delete GIF", shortcut: "Ctrl D", section: "delete", icon: "" })
  return list
}

function aboutFor(g, usage) {
  return [
    { label: "Title", value: g.title || "Untitled" },
    { label: "Tags", value: (g.tags || []).join(", ") },
    { label: "Size", value: g.width + "×" + g.height + ", " + g.frames + " frames, " + formatBytes(g.bytes) },
    { label: "Used", value: usage ? usage + " times" : "" },
    { label: "Source", value: g.source || "" },
    { label: "File", value: g.file }
  ].filter(function(r) { return r.value })
}

// Flea search entries for Library GIFs: the title, and each tag as a keyword.
function searchEntries(library) {
  return library.map(function(g) { return { title: g.title, keywords: g.tags.slice() } })
}

if (typeof module !== "undefined") {
  module.exports = {
    COLUMNS: COLUMNS, RECENT_LIMIT: RECENT_LIMIT, MIN_TAGS: MIN_TAGS, UNUSED_DAYS: UNUSED_DAYS, LIMITS: LIMITS, FILTERS: FILTERS,
    inLibrary: inLibrary, check: check, distance: distance, importGif: importGif, parseEdit: parseEdit, editValue: editValue, editHint: editHint, fileName: fileName, isXPost: isXPost, quietOutcome: quietOutcome,
    matchScore: matchScore, sections: sections, candidate: candidate, actionsFor: actionsFor, aboutFor: aboutFor, searchEntries: searchEntries
  }
}
