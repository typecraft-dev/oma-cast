// Clipboard History (SPEC §8.2, ref 02 §5.1): categories, dedup by content
// hash, retention, sections, the detail pane and actions. Pure logic; the
// watcher (services/ClipboardWatcher.qml) and the store live in QML.

// Text of this many bytes or more lives in a file under clipboard/ [O].
var INLINE_TEXT_LIMIT = 30720
// Search and the list read only this much of each entry. shortcut: a match
// past 8 KB of a long paste is missed; index the full text if anyone notices.
var SEARCH_LIMIT = 8192
// Unpinned entries kept regardless of age, so a busy week can't grow the
// JSON store without bound. Raycast has no count cap. [D]
var MAX_ENTRIES = 1000

var FILTERS = [
  { id: "all", title: "All Types" },
  { id: "text", title: "Text" },
  { id: "image", title: "Images" },
  { id: "file", title: "Files" },
  { id: "link", title: "Links" },
  { id: "color", title: "Colors" }
]

var DURATIONS = {
  P1D: 1, P1W: 7, P1M: 30, P3M: 91, P6M: 182, P1Y: 365, unlimited: 0
}

var GLYPHS = {
  text: "",     // nf-fa-file_text
  link: "",     // nf-fa-link
  email: "",    // nf-fa-envelope
  image: "",    // nf-fa-picture_o
  file: "",     // nf-fa-file
  color: ""     // nf-fa-paint_brush
}

var TYPE_LABELS = { text: "Text", link: "Link", email: "Email", image: "Image", file: "File", color: "Color" }

function filePaths(text) {
  var lines = String(text || "").split(/\r?\n/).filter(function(l) { return l.trim() })
  if (!lines.length) return []
  var paths = []
  for (var i = 0; i < lines.length; i++) {
    var m = /^file:\/\/(?:localhost)?(\/.*)$/.exec(lines[i].trim())
    if (!m) return []
    try { paths.push(decodeURIComponent(m[1])) } catch (e) { paths.push(m[1]) }
  }
  return paths
}

function isImagePath(path) { return /\.(png|jpe?g|webp|gif|bmp|tiff?|svg)$/i.test(path) }

// "#abc", "#a1b2c3", "#a1b2c3d4", "rgb(1, 2, 3)" and "rgba(…)" → "#rrggbb[aa]",
// else "". hsl() and named colours stay text. [I]
function colorHex(text) {
  var s = String(text || "").trim()
  var m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s)
  if (m) {
    var h = m[1]
    if (h.length <= 4) h = h.split("").map(function(c) { return c + c }).join("")
    return "#" + h.toLowerCase()
  }
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+%?)\s*)?\)$/i.exec(s)
  if (!m) return ""
  var parts = [m[1], m[2], m[3]].map(Number)
  if (parts.some(function(n) { return n > 255 })) return ""
  var out = "#" + parts.map(function(n) { return (n < 16 ? "0" : "") + n.toString(16) }).join("")
  if (m[4] !== undefined) {
    var a = m[4].slice(-1) === "%" ? parseFloat(m[4]) / 100 : parseFloat(m[4])
    if (!(a >= 0 && a <= 1)) return ""
    var byte = Math.round(a * 255)
    out += (byte < 16 ? "0" : "") + byte.toString(16)
  }
  return out
}

// ref 02 §5.1 categories: file (+ image), image, link (+ email), color, text.
function categorize(obs) {
  if (obs.type === "image") return ["image"]
  var text = String(obs.text || "")
  var files = filePaths(text)
  if (files.length) return files.length === 1 && isImagePath(files[0]) ? ["file", "image"] : ["file"]
  var t = text.trim()
  if (/^mailto:\S+$/i.test(t)) return ["link", "email"]
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(t)) return ["link"]
  if (colorHex(t)) return ["color"]
  return ["text"]
}

// The category a row is shown as: the most specific one.
function primaryCategory(entry) {
  var cats = entry.categories || []
  var order = ["email", "color", "image", "file", "link", "text"]
  for (var i = 0; i < order.length; i++) if (cats.indexOf(order[i]) >= 0) return order[i]
  return "text"
}

// Adds an observation, or bumps the entry with the same hash (count, time,
// source) [O]. selfCopy: the observation is our own write from the history,
// which moves the entry up without counting a copy or changing its source.
// Returns {entries, entry, added}; entries stay newest first.
function add(entries, obs, nowMs, id, selfCopy) {
  var list = Array.isArray(entries) ? entries.slice() : []
  if (obs.type === "text" && !String(obs.text || "").trim()) return { entries: list, entry: null, added: false }
  for (var i = 0; i < list.length; i++) {
    if (list[i].hash !== obs.hash) continue
    var e = Object.assign({}, list[i], { updatedAt: nowMs })
    if (!selfCopy) {
      e.copyCount = (e.copyCount || 1) + 1
      if (obs.source) e.source = obs.source
    }
    list.splice(i, 1)
    list.unshift(e)
    return { entries: list, entry: e, added: false }
  }
  var entry = {
    id: String(id), type: obs.type, hash: obs.hash, mime: obs.mime || (obs.type === "image" ? "image/png" : "text/plain"),
    bytes: obs.bytes || 0, categories: categorize(obs), source: obs.source || null,
    copyCount: 1, createdAt: nowMs, updatedAt: nowMs, pinned: null
  }
  if (obs.text !== undefined) entry.text = String(obs.text)
  if (obs.path) entry.path = String(obs.path)
  list.unshift(entry)
  return { entries: list, entry: entry, added: true }
}

// Drops unpinned entries older than the retention and past MAX_ENTRIES.
// Pinned entries are kept [O]. Returns {entries, removed}.
function prune(entries, nowMs, duration) {
  var days = DURATIONS[duration]
  if (days === undefined) days = DURATIONS.P1W
  var cutoff = days ? nowMs - days * 86400000 : -Infinity
  var kept = [], removed = [], unpinned = 0
  var list = Array.isArray(entries) ? entries : []
  for (var i = 0; i < list.length; i++) {
    var e = list[i]
    var keep = typeof e.pinned === "number" || (e.updatedAt >= cutoff && unpinned < MAX_ENTRIES)
    if (keep && typeof e.pinned !== "number") unpinned++
    ;(keep ? kept : removed).push(e)
  }
  return { entries: kept, removed: removed }
}

// Blob files no remaining entry points at, safe to delete.
function orphanedPaths(removed, kept) {
  var used = {}
  kept.forEach(function(e) { if (e.path) used[e.path] = true })
  var out = []
  removed.forEach(function(e) { if (e.path && !used[e.path] && out.indexOf(e.path) < 0) out.push(e.path) })
  return out
}

function title(entry) {
  if (entry.type === "image") return "Image"
  var text = String(entry.text || "")
  var files = filePaths(text)
  if (files.length === 1) return files[0].split("/").pop() || files[0]
  if (files.length > 1) return files.length + " Files"
  var line = text.slice(0, 400).replace(/\s+/g, " ").trim()
  return line.length > 200 ? line.slice(0, 200) + "…" : line
}

function relativeTime(ms, nowMs) {
  var s = Math.max(0, Math.round((nowMs - ms) / 1000))
  if (s < 60) return "Just now"
  if (s < 3600) return Math.floor(s / 60) + " min ago"
  if (s < 86400) return Math.floor(s / 3600) + " h ago"
  var d = Math.floor(s / 86400)
  return d === 1 ? "Yesterday" : d + " days ago"
}

function candidate(entry, nowMs) {
  var cat = primaryCategory(entry)
  return {
    id: "clipboard:" + entry.id, type: "command", kind: "clipboard",
    title: title(entry), subtitle: "", typeLabel: relativeTime(entry.updatedAt, nowMs),
    glyph: GLYPHS[cat], pinned: typeof entry.pinned === "number", rootSearch: { when: "always" }
  }
}

function matches(entry, needle, filter) {
  if (filter && filter !== "all" && (entry.categories || []).indexOf(filter) < 0) return false
  if (!needle) return true
  var hay = (entry.type === "image" ? "image " : String(entry.text || "").slice(0, SEARCH_LIMIT) + " ")
    + (entry.source ? entry.source.name || "" : "")
  return hay.toLowerCase().indexOf(needle) >= 0
}

// Pinned (in pin order), then Today, Yesterday and Earlier by last copy. [I]
function sections(entries, query, filter, nowMs) {
  var needle = String(query || "").trim().toLowerCase()
  var list = (Array.isArray(entries) ? entries : []).filter(function(e) { return matches(e, needle, filter) })
  var midnight = new Date(nowMs); midnight.setHours(0, 0, 0, 0)
  var today = midnight.getTime(), yesterday = today - 86400000
  var pinned = [], groups = { today: [], yesterday: [], earlier: [] }
  for (var i = 0; i < list.length; i++) {
    var e = list[i]
    var row = { candidate: candidate(e, nowMs) }
    if (typeof e.pinned === "number") pinned.push({ order: e.pinned, row: row })
    else groups[e.updatedAt >= today ? "today" : e.updatedAt >= yesterday ? "yesterday" : "earlier"].push(row)
  }
  pinned.sort(function(a, b) { return a.order - b.order })
  var out = []
  if (pinned.length) out.push({ id: "clipboard-pinned", title: "Pinned", rows: pinned.map(function(p) { return p.row }) })
  if (groups.today.length) out.push({ id: "clipboard-today", title: "Today", rows: groups.today })
  if (groups.yesterday.length) out.push({ id: "clipboard-yesterday", title: "Yesterday", rows: groups.yesterday })
  if (groups.earlier.length) out.push({ id: "clipboard-earlier", title: "Earlier", rows: groups.earlier })
  return out
}

function words(text) {
  var m = String(text || "").match(/\S+/g)
  return m ? m.length : 0
}

function formatBytes(n) {
  if (n < 1024) return n + " B"
  if (n < 1048576) return (Math.round(n / 102.4) / 10) + " KB"
  return (Math.round(n / 104857.6) / 10) + " MB"
}

function formatDate(ms) {
  var d = new Date(ms)
  return d.toDateString() + " " + d.toTimeString().slice(0, 5)
}

// The detail pane: what to preview, then Information rows (SPEC §8.2) [O].
function detail(entry) {
  var cat = primaryCategory(entry)
  var info = []
  function add(label, value) { if (value !== undefined && value !== null && value !== "") info.push({ label: label, value: String(value) }) }
  add("Source", entry.source ? entry.source.name || entry.source.appId : "")
  add("Content type", TYPE_LABELS[cat])
  if (entry.type === "text") {
    var text = String(entry.text || "")
    var truncated = entry.bytes >= INLINE_TEXT_LIMIT
    add("Characters", truncated ? formatBytes(entry.bytes) : text.length)
    if (!truncated) add("Words", words(text))
  } else {
    add("Image size", formatBytes(entry.bytes || 0))
  }
  add("Times copied", entry.copyCount || 1)
  add("Last copied", formatDate(entry.updatedAt))
  add("First copied", formatDate(entry.createdAt))
  var files = entry.type === "text" ? filePaths(entry.text) : []
  return {
    category: cat,
    text: entry.type === "text" ? (files.length ? files.join("\n") : String(entry.text || "").slice(0, SEARCH_LIMIT)) : "",
    image: entry.type === "image" ? entry.path : (files.length === 1 && isImagePath(files[0]) ? files[0] : ""),
    color: cat === "color" ? colorHex(entry.text) : "",
    info: info
  }
}

// Keys follow the rest of omacast: Ctrl+Shift+P pins, Ctrl+D / Ctrl+Shift+D
// delete, as in Emoji and Calculator History. [D]
function actionsFor(entry, appName) {
  var cat = primaryCategory(entry)
  var list = [
    { id: "paste", title: "Paste to " + (appName || "Active App"), shortcut: "↵", section: "primary", icon: "" },
    { id: "copy", title: "Copy to Clipboard", shortcut: "Ctrl ↵", section: "primary", icon: "" }
  ]
  if (cat === "link" || cat === "email") list.push({ id: "open-link", title: cat === "email" ? "Compose Email" : "Open in Browser", shortcut: "Ctrl O", section: "primary", icon: "" })
  if (cat === "file" || (cat === "image" && entry.type === "text")) list.push({ id: "open-link", title: "Open File", shortcut: "Ctrl O", section: "primary", icon: "" })
  var pinned = typeof entry.pinned === "number"
  list.push({ id: pinned ? "unpin" : "pin", title: pinned ? "Unpin Entry" : "Pin Entry", shortcut: "Ctrl Shift P", section: "pin", icon: "" })
  list.push({ id: "delete-entry", title: "Delete Entry", shortcut: "Ctrl D", section: "delete", icon: "" })
  list.push({ id: "delete-all-entries", title: "Delete All Entries", shortcut: "Ctrl Shift D", section: "delete", icon: "" })
  return list
}

function setPinned(entries, id, pin) {
  var max = -1
  entries.forEach(function(e) { if (typeof e.pinned === "number" && e.pinned > max) max = e.pinned })
  return entries.map(function(e) {
    if (e.id !== id) return e
    return Object.assign({}, e, { pinned: pin ? max + 1 : null })
  })
}

// Clipboard changes from these apps are not recorded [O]; matched against
// the Wayland app id, case-insensitively.
function isDisabledSource(source, disabled) {
  if (!source || !source.appId) return false
  var id = String(source.appId).toLowerCase()
  return (disabled || []).some(function(d) { return String(d).toLowerCase() === id })
}

if (typeof module !== "undefined") {
  module.exports = {
    INLINE_TEXT_LIMIT: INLINE_TEXT_LIMIT, SEARCH_LIMIT: SEARCH_LIMIT, MAX_ENTRIES: MAX_ENTRIES,
    FILTERS: FILTERS, DURATIONS: DURATIONS,
    filePaths: filePaths, colorHex: colorHex, categorize: categorize, primaryCategory: primaryCategory,
    add: add, prune: prune, orphanedPaths: orphanedPaths, title: title, candidate: candidate,
    sections: sections, detail: detail, actionsFor: actionsFor, setPinned: setPinned, isDisabledSource: isDisabledSource
  }
}
