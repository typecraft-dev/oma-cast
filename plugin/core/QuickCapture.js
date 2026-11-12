// Quick Capture (notes): type a note, save it as markdown in a chosen
// folder — either appended to the same file or to a new file per capture.
// Pure: no Qt, no fs, no Intl; the backends (QML bash, Electron fs) do the
// I/O. Shared by plugin/Backend.qml and electron/src/backend.js. [D]
//
//   directory  general.quickCaptureDir: "" = the default Notes folder
//              (data/notes); "~" and relative paths resolve against $HOME.
//   mode       general.quickCaptureMode: "inbox" (same inbox.md),
//              "daily" (same YYYY-MM-DD.md per day) or "new" (a new
//              timestamped file per capture).

var MODES = ["inbox", "daily", "new"]

var MODE_TITLES = {
  inbox: "Same file (inbox)",
  daily: "Same file per day",
  "new": "New file each time"
}

var MODE_SHORT = {
  inbox: "Same file",
  daily: "Daily file",
  "new": "New file"
}

var MAX_TEXT = 10000
var MAX_DIR = 4096

function pad(n, width) {
  var s = String(n)
  while (s.length < (width || 2)) s = "0" + s
  return s
}

function validMode(mode) {
  return MODES.indexOf(String(mode)) >= 0 ? String(mode) : "daily"
}

// "2026-11-11", local time (Date methods, so QML without Intl works).
function fmtDate(nowMs) {
  var d = new Date(Number(nowMs))
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
}

function fmtTime(nowMs) {
  var d = new Date(Number(nowMs))
  return pad(d.getHours()) + ":" + pad(d.getMinutes())
}

function fmtStamp(nowMs) {
  var d = new Date(Number(nowMs))
  return fmtDate(nowMs) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes())
}

function fmtFileStamp(nowMs) {
  var d = new Date(Number(nowMs))
  return fmtDate(nowMs) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
}

// The note text, or an error string when it cannot be captured.
function validateText(text) {
  var s = String(text === undefined || text === null ? "" : text)
  if (!s.trim()) return "Type a note first"
  if (s.indexOf("\u0000") >= 0) return "Notes cannot contain a NUL character"
  if (s.length > MAX_TEXT) return "Keep the note under " + (MAX_TEXT + 1) + " characters"
  return null
}

// The directory setting, or an error string. Empty is valid (the default).
function validateDir(raw) {
  var s = String(raw === undefined || raw === null ? "" : raw)
  if (!s.trim()) return null
  if (s.indexOf("\u0000") >= 0) return "The folder cannot contain a NUL character"
  if (s.length > MAX_DIR) return "Keep the folder under " + (MAX_DIR + 1) + " characters"
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s)) return "The folder cannot contain control characters"
  return null
}

function isAbsolute(raw) {
  var s = String(raw || "")
  return s.charAt(0) === "/" || /^[A-Za-z]:[\\/]/.test(s) || s.indexOf("\\\\") === 0
}

// Absolute capture folder for a raw setting value. opts: {home, data, sep}.
// "" → <data>/notes (the default Notes folder next to the DB).
function resolveDir(raw, opts) {
  opts = opts || {}
  var home = String(opts.home || "").replace(/[\\/]+$/, "")
  var data = String(opts.data || "").replace(/[\\/]+$/, "")
  var sep = opts.sep || (data.indexOf("\\") >= 0 ? "\\" : "/")
  var s = String(raw === undefined || raw === null ? "" : raw).trim()
  if (!s) return data + sep + "notes"
  if (s === "~") return home
  if (s.indexOf("~/") === 0) return home + sep + s.slice(2).replace(/\//g, sep)
  if (s.indexOf("~\\") === 0) return home + sep + s.slice(2).replace(/\\/g, sep)
  if (isAbsolute(s)) return s.replace(/[\\/]+$/, "")
  return (home + sep + s).replace(/[\\/]+$/, "")
}

function fileNameFor(mode, nowMs) {
  var m = validMode(mode)
  if (m === "inbox") return "inbox.md"
  if (m === "daily") return fmtDate(nowMs) + ".md"
  return fmtFileStamp(nowMs) + ".md"
}

// {file, append}: append modes add one line; "new" writes a whole file.
function targetFor(mode, nowMs) {
  var m = validMode(mode)
  return { file: fileNameFor(m, nowMs), append: m !== "new", mode: m }
}

function joinDir(dir, file, sep) {
  var s = sep || (String(dir).indexOf("\\") >= 0 ? "\\" : "/")
  return String(dir).replace(/[\\/]+$/, "") + s + file
}

// One markdown line for the append modes. Single-line by construction (the
// launcher's query bar strips newlines on paste); embedded newlines become
// spaces so one capture is always one line.
function formatEntry(text, nowMs) {
  var s = String(text).replace(/\s*\r?\n\s*/g, " ").trim()
  return "- [" + fmtStamp(nowMs) + "] " + s + "\n"
}

// Whole file for "new" mode.
function newFileContent(text, nowMs) {
  return "# " + fmtStamp(nowMs) + "\n\n" + String(text).trim() + "\n"
}

// Heading for a freshly created append file, so inbox.md never starts with
// a bare bullet.
function appendFileHeading(mode, nowMs) {
  return validMode(mode) === "daily" ? "# " + fmtDate(nowMs) + "\n\n" : "# Inbox\n\n"
}

// Row title: the note truncated to one preview line.
function previewTitle(text, width) {
  var s = String(text).replace(/\s+/g, " ").trim()
  var w = width || 60
  return s.length > w ? s.slice(0, w - 1).trim() + "…" : s
}

if (typeof module !== "undefined") {
  module.exports = {
    MODES: MODES,
    MODE_TITLES: MODE_TITLES,
    MODE_SHORT: MODE_SHORT,
    MAX_TEXT: MAX_TEXT,
    validMode: validMode,
    fmtDate: fmtDate,
    fmtTime: fmtTime,
    fmtStamp: fmtStamp,
    validateText: validateText,
    validateDir: validateDir,
    resolveDir: resolveDir,
    fileNameFor: fileNameFor,
    targetFor: targetFor,
    joinDir: joinDir,
    formatEntry: formatEntry,
    newFileContent: newFileContent,
    appendFileHeading: appendFileHeading,
    previewTitle: previewTitle
  }
}
