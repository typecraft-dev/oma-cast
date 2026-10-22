// File-search row helpers (docs/file-search.md). Pure module: no Qt
// imports, shared by the QML service and node --test.

var ROOT_FILE_LIMIT = 3
var VIEW_FILE_LIMIT = 50
var MIN_ROOT_QUERY = 3

var TEXT_EXTENSIONS = {
  "c": 1, "cc": 1, "cpp": 1, "h": 1, "hpp": 1, "rs": 1, "go": 1, "py": 1,
  "js": 1, "jsx": 1, "ts": 1, "tsx": 1, "mjs": 1, "cjs": 1, "vue": 1, "svelte": 1,
  "json": 1, "jsonc": 1, "yaml": 1, "yml": 1, "toml": 1, "ini": 1, "conf": 1,
  "lua": 1, "sh": 1, "bash": 1, "zsh": 1, "fish": 1, "css": 1, "scss": 1, "html": 1,
  "md": 1, "markdown": 1, "txt": 1, "rst": 1, "tex": 1, "sql": 1, "xml": 1,
  "java": 1, "kt": 1, "kts": 1, "swift": 1, "rb": 1, "php": 1, "pl": 1, "r": 1,
  "nix": 1, "zig": 1, "cs": 1, "fs": 1, "ex": 1, "exs": 1, "erl": 1, "hrl": 1
}

var ICONS = {
  "pdf": "application-pdf",
  "png": "image-x-generic", "jpg": "image-x-generic", "jpeg": "image-x-generic",
  "gif": "image-x-generic", "webp": "image-x-generic", "svg": "image-x-generic",
  "avif": "image-x-generic", "bmp": "image-x-generic", "ico": "image-x-generic",
  "mp4": "video-x-generic", "mkv": "video-x-generic", "webm": "video-x-generic",
  "mov": "video-x-generic", "avi": "video-x-generic",
  "mp3": "audio-x-generic", "flac": "audio-x-generic", "ogg": "audio-x-generic",
  "wav": "audio-x-generic", "m4a": "audio-x-generic",
  "zip": "package-x-generic", "tar": "package-x-generic", "gz": "package-x-generic",
  "xz": "package-x-generic", "zst": "package-x-generic", "7z": "package-x-generic",
  "rar": "package-x-generic"
}

function extensionOf(name) {
  var base = String(name || "").split("/").pop()
  var dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ""
}

function isTextLike(name) {
  if (TEXT_EXTENSIONS[extensionOf(name)]) return true
  if (/^(makefile|dockerfile|readme|license|changelog|justfile|cmakelists\.txt)$/i.test(String(name || ""))) return true
  return false
}

function iconFor(name) {
  return ICONS[extensionOf(name)] || "text-x-generic"
}

// File names are untrusted text. Strip C0/C1 controls, bidi overrides and
// zero-width characters for display; keep the path untouched.
function sanitizeName(name) {
  var text = String(name || "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return text || "Unnamed file"
}

function shortenHome(path, home) {
  var value = String(path || "")
  var root = String(home || "").replace(/\/+$/, "")
  if (!root) return value
  if (value === root) return "~"
  if (value.indexOf(root + "/") === 0) return "~" + value.slice(root.length)
  return value
}

function parentDir(path) {
  var value = String(path || "")
  var slash = value.lastIndexOf("/")
  if (slash <= 0) return "/"
  return value.slice(0, slash)
}

function rowFromItem(item, home) {
  if (!item || typeof item.path !== "string" || item.path.charAt(0) !== "/") return null
  var name = sanitizeName(item.name || item.path.split("/").pop())
  if (!name) return null
  return {
    id: "file:" + item.path,
    type: "file",
    kind: "file",
    title: name,
    subtitle: shortenHome(parentDir(item.path), home),
    path: item.path,
    relativePath: String(item.relativePath || ""),
    fileName: name,
    isText: isTextLike(name),
    iconName: iconFor(name),
    typeLabel: ""
  }
}

function rowsFromResponse(result, home) {
  var items = result && Array.isArray(result.items) ? result.items : []
  var rows = []
  for (var i = 0; i < items.length && rows.length < VIEW_FILE_LIMIT; i++) {
    var row = rowFromItem(items[i], home)
    if (row) rows.push(row)
  }
  return rows
}

function rootRows(rows) {
  return (rows || []).slice(0, ROOT_FILE_LIMIT)
}

function isFileId(id) {
  return String(id || "").indexOf("file:") === 0
}

function isShowAllId(id) {
  return String(id || "") === "files:more"
}

function showAllRow() {
  return {
    id: "files:more",
    type: "file",
    kind: "files-more",
    title: "Show All Files",
    subtitle: "",
    glyph: "",
    glyphFont: "",
    iconName: "go-next",
    typeLabel: ""
  }
}

function isCurrent(sentQuery, responseQuery, desiredQuery) {
  return sentQuery === responseQuery && responseQuery === desiredQuery
}

if (typeof module !== "undefined") {
  module.exports = {
    ROOT_FILE_LIMIT: ROOT_FILE_LIMIT,
    VIEW_FILE_LIMIT: VIEW_FILE_LIMIT,
    MIN_ROOT_QUERY: MIN_ROOT_QUERY,
    sanitizeName: sanitizeName,
    shortenHome: shortenHome,
    parentDir: parentDir,
    isTextLike: isTextLike,
    iconFor: iconFor,
    rowFromItem: rowFromItem,
    rowsFromResponse: rowsFromResponse,
    rootRows: rootRows,
    isFileId: isFileId,
    isShowAllId: isShowAllId,
    showAllRow: showAllRow,
    isCurrent: isCurrent
  }
}
