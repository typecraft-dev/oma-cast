// File search over a listing of the home directory (SPEC §8.6) [D]:
// services/FileIndex.qml lists files and folders with `fd` (it honours
// .gitignore and skips hidden paths) and their modification times. This
// module parses that listing and matches the query in-process, so the query
// never reaches another process's argv (CLAUDE.md ground rule 6).
// The SPEC plans a Rust indexer with inotify. fd lists ~50k paths in ~25 ms,
// so a fresh listing per launcher open replaces the index and the watcher.

var DEFAULT_LIMIT = 5
var MIN_QUERY_LENGTH = 2
var MAX_ENTRIES = 200000

// stat --printf '%F|%Y|%s|%n\0' output: type, mtime in seconds, size in
// bytes, absolute path. The path is last, so a "|" in it is harmless.
function parseListing(text, home, maxEntries) {
  var out = []
  var limit = maxEntries || MAX_ENTRIES
  var prefix = String(home || "").replace(/\/+$/, "") + "/"
  var records = String(text || "").split("\0")
  for (var i = 0; i < records.length && out.length < limit; i++) {
    var rec = records[i]
    var a = rec.indexOf("|")
    var b = a < 0 ? -1 : rec.indexOf("|", a + 1)
    var c = b < 0 ? -1 : rec.indexOf("|", b + 1)
    if (c < 0) continue
    var path = rec.slice(c + 1)
    if (path.indexOf(prefix) !== 0 || path.length === prefix.length) continue
    var rel = path.slice(prefix.length).replace(/\/+$/, "")
    var slash = rel.lastIndexOf("/")
    var name = rel.slice(slash + 1)
    out.push({
      path: prefix + rel,
      rel: rel,
      name: name,
      dir: slash < 0 ? "" : rel.slice(0, slash),
      folder: rec.slice(0, a) === "directory",
      mtime: Number(rec.slice(a + 1, b)) || 0,
      size: Number(rec.slice(b + 1, c)) || 0,
      lowerName: name.toLowerCase(),
      lowerRel: rel.toLowerCase()
    })
  }
  return out
}

function stem(lowerName) {
  var dot = lowerName.lastIndexOf(".")
  return dot > 0 ? lowerName.slice(0, dot) : lowerName
}

// Start of a word in a file name: after a separator or a lower→upper or
// letter→digit change ("MyReport_v2" has words my, report, v, 2).
function isWordStart(name, at) {
  if (at === 0) return true
  var prev = name.charAt(at - 1), cur = name.charAt(at)
  if (/[\s._\-()[\]+,]/.test(prev)) return true
  if (/[a-z]/.test(prev) && /[A-Z]/.test(cur)) return true
  return (/[A-Za-z]/.test(prev) && /[0-9]/.test(cur)) || (/[0-9]/.test(prev) && /[A-Za-z]/.test(cur))
}

// Score of one query token against one entry; 0 = no match.
function tokenScore(entry, token) {
  var s = stem(entry.lowerName)
  if (s === token || entry.lowerName === token) return 100
  if (entry.lowerName.indexOf(token) === 0) return 80
  var at = entry.lowerName.indexOf(token)
  while (at > 0) {
    if (isWordStart(entry.name, at)) return 60
    at = entry.lowerName.indexOf(token, at + 1)
  }
  if (entry.lowerName.indexOf(token) > 0) return 40
  return entry.lowerRel.indexOf(token) >= 0 ? 10 : 0
}

// Newer files rank higher between equal name matches.
function recencyBonus(mtime, nowMs) {
  var days = (nowMs / 1000 - mtime) / 86400
  if (days < 1) return 12
  if (days < 7) return 8
  if (days < 30) return 4
  return 0
}

// Bonus for files the user opened from omacast, from their frecency score
// (core/Frecency.js: ~100 after one open, halving every 10 days). One
// recent open lifts a prefix match (80) above an unopened exact name (100).
var MAX_VISIT_BONUS = 40

function visitBonus(frecencyScore) {
  if (!(frecencyScore > 1)) return 0
  return Math.min(MAX_VISIT_BONUS, 15 * Math.log10(frecencyScore))
}

// Entries whose name or path holds every query token, best first. Each
// token must match; at least one must match the name, so a query that
// matches only folder names returns those folders, not their contents.
// bonus(entry), when given, adds a number to an entry's score.
function search(entries, query, nowMs, limit, bonus) {
  var q = String(query || "").trim().toLowerCase()
  if (q.length < MIN_QUERY_LENGTH) return []
  var tokens = q.split(/\s+/)
  var max = limit || DEFAULT_LIMIT
  var hits = []
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i]
    if (e.lowerRel.indexOf(tokens[0]) < 0) continue
    var total = 0, inName = false, ok = true
    for (var t = 0; t < tokens.length; t++) {
      var s = tokenScore(e, tokens[t])
      if (!s) { ok = false; break }
      if (s > 10) inName = true
      total += s
    }
    if (!ok || !inName) continue
    hits.push({ entry: e, score: total + recencyBonus(e.mtime, nowMs) + (bonus ? bonus(e) : 0) })
  }
  hits.sort(function(a, b) {
    return b.score - a.score || a.entry.rel.length - b.entry.rel.length || b.entry.mtime - a.entry.mtime
  })
  return hits.slice(0, max).map(function(h) { return h.entry })
}

// Nerd Font glyphs (Font Awesome set), as other omacast rows use.
var GLYPHS = {
  folder: "", pdf: "", image: "", code: "", text: "",
  archive: "", audio: "", video: "", word: "", sheet: "",
  slides: "", file: ""
}
var KINDS = {
  pdf: "pdf",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", heic: "image", avif: "image", bmp: "image",
  js: "code", ts: "code", jsx: "code", tsx: "code", py: "code", ipynb: "code", java: "code", c: "code", h: "code", cpp: "code",
  rs: "code", go: "code", rb: "code", sh: "code", lua: "code", qml: "code", json: "code", html: "code", css: "code", sql: "code",
  yml: "code", yaml: "code", toml: "code", r: "code",
  txt: "text", md: "text", log: "text", csv: "sheet", tex: "text", org: "text",
  zip: "archive", tar: "archive", gz: "archive", xz: "archive", zst: "archive", "7z": "archive", rar: "archive",
  mp3: "audio", flac: "audio", wav: "audio", ogg: "audio", m4a: "audio", opus: "audio",
  mp4: "video", mkv: "video", webm: "video", mov: "video", avi: "video",
  doc: "word", docx: "word", odt: "word", rtf: "word",
  xls: "sheet", xlsx: "sheet", ods: "sheet",
  ppt: "slides", pptx: "slides", odp: "slides", key: "slides"
}

function kindOf(entry) {
  if (entry.folder) return "folder"
  var dot = entry.lowerName.lastIndexOf(".")
  return KINDS[dot > 0 ? entry.lowerName.slice(dot + 1) : ""] || "file"
}

function glyphFor(entry) { return GLYPHS[kindOf(entry)] }

var KIND_NAMES = {
  folder: "Folder", pdf: "PDF document", image: "Image", code: "Source code", text: "Text",
  archive: "Archive", audio: "Audio", video: "Video", word: "Document", sheet: "Spreadsheet",
  slides: "Presentation", file: "File"
}

// "12 KB", "3.4 MB": decimal units, as file managers on Linux show them.
function sizeLabel(bytes) {
  if (!(bytes >= 0)) return ""
  if (bytes < 1000) return bytes + (bytes === 1 ? " byte" : " bytes")
  var units = ["KB", "MB", "GB", "TB"], v = bytes / 1000, i = 0
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++ }
  return (v < 10 ? Math.round(v * 10) / 10 : Math.round(v)) + " " + units[i]
}

// Files changed most recently, for Search Files before the user types.
function recent(entries, limit) {
  var files = []
  for (var i = 0; i < entries.length; i++) if (!entries[i].folder) files.push(entries[i])
  files.sort(function(a, b) { return b.mtime - a.mtime })
  return files.slice(0, limit || 20)
}

// What the preview pane shows: an image, the head of a text file, or the
// type glyph. Text over 1 MB is not read [D].
var TEXT_PREVIEW_MAX_BYTES = 1000000
var IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]

function previewKind(entry) {
  var kind = kindOf(entry)
  var dot = entry.lowerName.lastIndexOf(".")
  var ext = dot > 0 ? entry.lowerName.slice(dot + 1) : ""
  if (kind === "image" && IMAGE_EXTENSIONS.indexOf(ext) >= 0) return "image"
  if ((kind === "text" || kind === "code" || ext === "csv") && entry.size <= TEXT_PREVIEW_MAX_BYTES) return "text"
  return "glyph"
}

// Everything the Search Files detail pane shows for one entry.
function details(entry, nowMs, relativeTime) {
  return {
    path: entry.path,
    name: entry.name,
    where: entry.dir ? "~/" + entry.dir : "~",
    type: KIND_NAMES[kindOf(entry)],
    size: entry.folder ? "" : sizeLabel(entry.size),
    modified: modifiedLabel(entry.mtime * 1000, nowMs, relativeTime),
    glyph: glyphFor(entry),
    preview: previewKind(entry)
  }
}

// The parent folders that tell same-named files apart: the last two, or
// the whole path from ~ when it is that short ("~ › Personal").
function breadcrumb(dir) {
  if (!dir) return "~"
  var parts = dir.split("/")
  if (parts.length > 2) return parts.slice(-2).join(" › ")
  return "~ › " + parts.join(" › ")
}

var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// Last change: relative within a week ("Yesterday"), then a date ("24 Aug",
// or "Aug 2025" from an earlier year), which scans faster than "77 days ago".
function modifiedLabel(ms, nowMs, relativeTime) {
  if (nowMs - ms < 7 * 86400000) return relativeTime(ms, nowMs)
  var d = new Date(ms), now = new Date(nowMs)
  if (d.getFullYear() === now.getFullYear()) return d.getDate() + " " + MONTHS[d.getMonth()]
  return MONTHS[d.getMonth()] + " " + d.getFullYear()
}

function candidate(entry, nowMs, relativeTime) {
  return {
    id: "file:" + entry.path,
    type: "file",
    kind: entry.folder ? "folder" : "file",
    title: entry.name,
    subtitle: breadcrumb(entry.dir),
    typeLabel: modifiedLabel(entry.mtime * 1000, nowMs, relativeTime),
    glyph: glyphFor(entry),
    path: entry.path,
    rootSearch: { when: "searching" }
  }
}

if (typeof module !== "undefined") {
  module.exports = {
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    MIN_QUERY_LENGTH: MIN_QUERY_LENGTH,
    parseListing: parseListing,
    search: search,
    glyphFor: glyphFor,
    kindOf: kindOf,
    sizeLabel: sizeLabel,
    recent: recent,
    previewKind: previewKind,
    details: details,
    breadcrumb: breadcrumb,
    modifiedLabel: modifiedLabel,
    visitBonus: visitBonus,
    candidate: candidate
  }
}
