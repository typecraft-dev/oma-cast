// Script Commands (SPEC §9.9, ref 03 §5) [O]: executables in the script
// commands folder whose comment headers (`# @raycast.title …`) make them
// root-search commands. Pure logic; services/ScriptCommandSource.qml scans
// the folder and Backend.qml runs them.

var HEADER = /^(?:#|REM|::|\/{2})\s*@raycast\.(\w+)\s+(.*)$/i
var KEYS = ["schemaVersion", "title", "mode", "packageName", "icon", "iconDark", "description", "author",
  "authorURL", "currentDirectoryPath", "needsConfirmation", "refreshTime", "argument1", "argument2", "argument3"]
var MODES = { fullOutput: "fullOutput", "full-output": "fullOutput", compact: "compact", silent: "silent", inline: "inline" }
var TERMINAL_GLYPH = ""   // nf-fa-terminal

// One file per record: "\x1e<path>\n<first lines>" (the scan script's output).
function splitScan(output) {
  return String(output || "").split("\x1e").slice(1).map(function(chunk) {
    var nl = chunk.indexOf("\n")
    return nl < 0 ? { path: chunk, text: "" } : { path: chunk.slice(0, nl), text: chunk.slice(nl + 1) }
  })
}

function titleCase(name) {
  return String(name).replace(/[-_]+/g, " ").replace(/\b\w/g, function(c) { return c.toUpperCase() })
}

function dirname(path) { return String(path).replace(/\/[^\/]*$/, "") || "/" }

// {command} or {error} for one script's text.
function parse(text, path) {
  var h = {}
  var lower = {}
  KEYS.forEach(function(k) { lower[k.toLowerCase()] = k })
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].trim().match(HEADER)
    if (m && lower[m[1].toLowerCase()]) h[lower[m[1].toLowerCase()]] = m[2].trim()
  }
  if (h.schemaVersion !== "1") return { error: "needs @raycast.schemaVersion 1" }
  if (!h.title) return { error: "needs @raycast.title" }
  var mode = MODES[h.mode]
  if (!mode) return { error: "needs @raycast.mode (fullOutput, compact, silent or inline)" }
  if (mode === "inline" && !h.refreshTime) mode = "compact"

  var args = []
  if (mode !== "inline") {
    for (var n = 1; n <= 3; n++) {
      var raw = h["argument" + n]
      if (!raw) continue
      var a
      try { a = JSON.parse(raw) } catch (e) { return { error: "argument" + n + " is not JSON" } }
      var type = a.type || "text"
      if (["text", "password", "dropdown"].indexOf(type) < 0) return { error: "argument" + n + " has unknown type " + type }
      var options = []
      if (type === "dropdown") {
        options = (Array.isArray(a.data) ? a.data : []).filter(function(o) { return o && o.value !== undefined })
          .map(function(o) { return { title: String(o.title || o.value), value: String(o.value) } })
        if (!options.length) return { error: "argument" + n + " dropdown has no data" }
      }
      args.push({
        name: "argument" + n, type: type, placeholder: String(a.placeholder || "Argument " + n),
        required: a.optional !== true, percentEncoded: a.percentEncoded === true, options: options
      })
    }
  }

  var dir = dirname(path)
  return {
    command: {
      path: path,
      title: h.title,
      mode: mode,
      packageName: h.packageName || titleCase(dir.replace(/^.*\//, "")),
      description: h.description || "",
      icon: h.icon || "",
      // Relative to the script's folder; the runner's `cd` resolves "..".
      cwd: (h.currentDirectoryPath || "").charAt(0) === "/" ? h.currentDirectoryPath : dir + "/" + (h.currentDirectoryPath || "."),
      needsConfirmation: h.needsConfirmation === "true" && mode !== "inline",
      arguments: args
    }
  }
}

// Emoji and other short text icons render as a glyph; image paths and URLs
// fall back to the terminal glyph. shortcut: no image icons, add them when
// someone ships scripts with .png icons.
function glyphFor(icon) {
  var s = String(icon || "")
  return s && s.length <= 8 && !/[\/.]/.test(s) ? s : TERMINAL_GLYPH
}

function candidate(cmd) {
  return {
    id: "script:" + cmd.path,
    type: "command",
    kind: "script",
    title: cmd.title,
    subtitle: cmd.packageName,
    keywords: [cmd.packageName].concat(cmd.description ? [cmd.description] : []),
    typeLabel: "Script Command",
    glyph: glyphFor(cmd.icon),
    glyphFont: "",
    arguments: cmd.arguments,
    script: cmd,
    rootSearch: { when: "always" }
  }
}

// Positional $1..$3 for the run, or {error, index} for the first bad one.
// Empty optional arguments still hold their place as "".
function argv(cmd, values) {
  var out = []
  for (var i = 0; i < cmd.arguments.length; i++) {
    var def = cmd.arguments[i]
    var v = String((values && values[def.name]) || "")
    if (def.type !== "password") v = v.trim()
    if (!v && def.required) return { error: "Type a " + def.placeholder.toLowerCase() + " first", index: i }
    if (v && def.type === "dropdown" && !def.options.some(function(o) { return o.value === v }))
      return { error: v + " is not a " + def.placeholder.toLowerCase() + " option", index: i }
    out.push(def.percentEncoded ? encodeURIComponent(v) : v)
  }
  return { argv: out }
}

function lastLine(output) {
  var lines = String(output || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n")
  for (var i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return lines[i].trim()
  return ""
}

// The toast or HUD a finished run shows: the last line of its combined
// stdout and stderr (ref 03 §5).
function outcome(cmd, exitCode, output) {
  var line = lastLine(output)
  if (exitCode === 0) return { style: "success", title: line || cmd.title + " finished" }
  return { style: "failure", title: line || cmd.title + " failed (exit " + exitCode + ")" }
}

// The dropdown option after `value`, `step` places on, wrapping.
function cycleOption(def, value, step) {
  var opts = def.options || []
  if (!opts.length) return ""
  var at = -1
  for (var i = 0; i < opts.length; i++) if (opts[i].value === value) at = i
  if (at < 0) return opts[step > 0 ? 0 : opts.length - 1].value
  return opts[(at + step + opts.length) % opts.length].value
}

function optionTitle(def, value) {
  var opts = def.options || []
  for (var i = 0; i < opts.length; i++) if (opts[i].value === value) return opts[i].title
  return value
}

if (typeof module !== "undefined") {
  module.exports = {
    splitScan: splitScan, parse: parse, candidate: candidate, argv: argv, lastLine: lastLine,
    outcome: outcome, cycleOption: cycleOption, optionTitle: optionTitle
  }
}
