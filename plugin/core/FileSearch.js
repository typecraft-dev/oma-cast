// File and folder search over the home directory [D]. Raycast uses its own
// native indexer ("minidex", ref 05 §1); here `fd` walks $HOME live on each
// query instead (about 30 ms on a typical home, always current, honours
// .gitignore, skips hidden paths). Rows rank with the scorer below, not
// Ranker.js: files are not root commands and never carry aliases or frecency.

var MIN_QUERY = 2          // [D] one letter would list half the disk
var ROOT_LIMIT = 5         // [D] file rows under the root's Results
var VIEW_LIMIT = 60        // [D] rows in the pushed "Search Files" view
var SCAN_LIMIT = 3000      // [D] fd stops after this many matches

var EXCLUDES = ["node_modules", "__pycache__"]

var ICONS = {
  pdf: "application-pdf",
  png: "image-x-generic", jpg: "image-x-generic", jpeg: "image-x-generic", gif: "image-x-generic",
  webp: "image-x-generic", svg: "image-x-generic", heic: "image-x-generic", bmp: "image-x-generic",
  mp4: "video-x-generic", mkv: "video-x-generic", mov: "video-x-generic", webm: "video-x-generic", avi: "video-x-generic",
  mp3: "audio-x-generic", wav: "audio-x-generic", flac: "audio-x-generic", ogg: "audio-x-generic", m4a: "audio-x-generic",
  doc: "x-office-document", docx: "x-office-document", odt: "x-office-document", rtf: "x-office-document",
  xls: "x-office-spreadsheet", xlsx: "x-office-spreadsheet", ods: "x-office-spreadsheet", csv: "x-office-spreadsheet",
  ppt: "x-office-presentation", pptx: "x-office-presentation", odp: "x-office-presentation", key: "x-office-presentation",
  zip: "package-x-generic", tar: "package-x-generic", gz: "package-x-generic", xz: "package-x-generic",
  zst: "package-x-generic", "7z": "package-x-generic", rar: "package-x-generic",
  sh: "text-x-script", py: "text-x-script", js: "text-x-script", ts: "text-x-script", lua: "text-x-script",
  rb: "text-x-script", go: "text-x-script", rs: "text-x-script"
}

function terms(query) {
  return String(query || "").toLowerCase().split(/\s+/).filter(function(t) { return t.length > 0 })
}

function searchable(query) {
  return String(query || "").trim().length >= MIN_QUERY
}

// fd matches the last term (the one being typed) against basenames; the
// other terms filter the path afterwards, so "work invoice" finds
// ~/Work/…/invoice.pdf and "oma cast spec" finds ~/Projects/oma-cast/SPEC.md.
function fdArgv(query, home) {
  var list = terms(query)
  var last = list.length ? list[list.length - 1] : ""
  var argv = ["fd", "--ignore-case", "--fixed-strings", "--print0", "--max-results", String(SCAN_LIMIT)]
  for (var i = 0; i < EXCLUDES.length; i++) argv.push("--exclude", EXCLUDES[i])
  return argv.concat(["--", last, home])
}

function extension(name) {
  var dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

function iconFor(name, isDir) {
  if (isDir) return "folder"
  return ICONS[extension(name)] || "text-x-generic"
}

function isBoundary(text, at) {
  return at === 0 || !/[a-z0-9]/.test(text.charAt(at - 1))
}

// Higher is better. The name tier dominates; depth and length break ties.
function score(name, rel, isDir, list) {
  var lower = name.toLowerCase()
  var stem = lower.indexOf(".") > 0 ? lower.slice(0, lower.lastIndexOf(".")) : lower
  var q = list.join(" ")
  var at = lower.indexOf(q)
  var tier
  if (lower === q || stem === q) tier = 1000
  else if (at === 0) tier = 800
  else if (at > 0 && isBoundary(lower, at)) tier = 600
  else if (at > 0) tier = 400
  else if (list.every(function(t) { return lower.indexOf(t) >= 0 })) tier = 300
  else tier = 100
  var depth = rel.split("/").length - 1
  return tier - depth * 12 - Math.min(name.length, 60) * 0.5 + (isDir ? 6 : 0)
}

function candidate(path, isDir, home) {
  var slash = path.lastIndexOf("/")
  var name = path.slice(slash + 1)
  var parent = path.slice(0, slash) || "/"
  var shown = parent === home ? "~" : (parent.indexOf(home + "/") === 0 ? "~" + parent.slice(home.length) : parent)
  return {
    id: "file:" + path,
    type: "file",
    kind: isDir ? "folder" : "file",
    title: name,
    subtitle: shown,
    typeLabel: isDir ? "Folder" : "File",
    iconName: iconFor(name, isDir),
    path: path,
    rootSearch: { when: "searching" }
  }
}

// Rank already-built candidates for a query: used for fresh fd output and to
// re-filter the previous results while the next fd run is still going.
function rank(cands, query, home, limit) {
  var list = terms(query)
  if (list.length === 0) return []
  var scored = []
  for (var i = 0; i < cands.length; i++) {
    var c = cands[i]
    var rel = c.path.indexOf(home + "/") === 0 ? c.path.slice(home.length + 1) : c.path
    var lowerRel = rel.toLowerCase()
    if (!list.every(function(t) { return lowerRel.indexOf(t) >= 0 })) continue
    scored.push({ c: c, s: score(c.title, rel, c.kind === "folder", list) })
  }
  scored.sort(function(a, b) { return b.s - a.s || (a.c.path < b.c.path ? -1 : 1) })
  return scored.slice(0, limit || VIEW_LIMIT).map(function(x) { return x.c })
}

// fd --print0 output: NUL-separated paths, directories end in "/".
function parse(output, query, home, limit) {
  var parts = String(output || "").split("\0")
  var cands = []
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i]
    if (!p) continue
    var isDir = p.charAt(p.length - 1) === "/"
    if (isDir) p = p.replace(/\/+$/, "")
    if (!p || p === home) continue
    cands.push(candidate(p, isDir, home))
  }
  return rank(cands, query, home, limit)
}

function fileUri(path) {
  return "file://" + String(path).split("/").map(encodeURIComponent).join("/")
}

if (typeof module !== "undefined") {
  module.exports = {
    MIN_QUERY: MIN_QUERY,
    ROOT_LIMIT: ROOT_LIMIT,
    VIEW_LIMIT: VIEW_LIMIT,
    SCAN_LIMIT: SCAN_LIMIT,
    terms: terms,
    searchable: searchable,
    fdArgv: fdArgv,
    iconFor: iconFor,
    score: score,
    candidate: candidate,
    rank: rank,
    parse: parse,
    fileUri: fileUri
  }
}
