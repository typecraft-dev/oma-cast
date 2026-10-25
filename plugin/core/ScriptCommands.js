
// Script Commands (SPEC §9.9, ref 03 §5) [O]: discovery output, header
// parsing, arguments, the run command line and output handling. Processes
// live in services/ScriptCommandsSource.qml.

var HEADER = /^(?:#|REM|::|\/{2})\s*@raycast\.(\w+)\s+(.*)/i
var MAX_BYTES = 2 * 1024 * 1024
var MIN_REFRESH_SECONDS = 10
var ID_PREFIX = "script:"
var ERROR_PREFIX = "script-error:"
var GLYPH = "\uf120"                     // nf-fa-terminal

// Header keys are case-insensitive (ref 03 §5); this maps them back.
var KEYS = ["schemaVersion", "title", "mode", "packageName", "icon", "iconDark", "description", "author", "authorURL",
  "currentDirectoryPath", "needsConfirmation", "refreshTime", "argument1", "argument2", "argument3"]
var KEY_BY_LOWER = {}
for (var k = 0; k < KEYS.length; k++) KEY_BY_LOWER[KEYS[k].toLowerCase()] = KEYS[k]

var MODES = { fulloutput: "fullOutput", "full-output": "fullOutput", compact: "compact", silent: "silent", inline: "inline" }
var MODE_TITLES = { fullOutput: "Full Output", compact: "Compact", silent: "Silent", inline: "Inline" }

// Non-recursive scan of each directory (positional args). Skips dirs, empty
// files, non-executables, `.template.` files and files over 2 MB, as Raycast
// does; hidden files too [I]. Prints a record per file: \x1eF<TAB>path, the
// shebang as \x1eS<TAB>line, then every header line. grep -I skips binaries.
var SCAN_SCRIPT = [
  'for dir in "$@"; do',
  '  [[ -d $dir ]] || continue',
  '  for f in "$dir"/*; do',
  '    [[ -f $f && -x $f && -s $f ]] || continue',
  '    name=${f##*/}',
  '    [[ $name == *.template.* || $f == *$\'\\n\'* ]] && continue',
  '    size=$(stat -L -c %s -- "$f" 2>/dev/null) || continue',
  '    (( size <= ' + MAX_BYTES + ' )) || continue',
  '    grep -qI -m 1 "@raycast\\." -- "$f" 2>/dev/null || continue',
  '    printf "\\x1eF\\t%s\\n" "$f"',
  '    IFS= read -r first < "$f" || true',
  '    [[ $first == "#!"* ]] && printf "\\x1eS\\t%s\\n" "$first"',
  '    grep -I -m 64 -E "@raycast\\.[A-Za-z0-9_]+" -- "$f" 2>/dev/null',
  '  done',
  'done',
  'exit 0'
].join("\n")

// The run wrapper: cwd, then exec the file itself (needs +x and a shebang).
// $1 is the directory, $2 the script, the rest its arguments. Raycast drops
// LC_ALL and sets LANG (ref 03 §5) [O].
var RUN_SCRIPT = [
  'cd -- "$1" || exit 126',
  'shift',
  'unset LC_ALL',
  'export LANG="${LANG:-C.UTF-8}"',
  'exec "$@"'
].join("\n")

// Creates a script from the template: $1 directory, $2 file, $3 contents.
var CREATE_SCRIPT = [
  'mkdir -p -- "$1" || exit 1',
  '[[ -e $2 ]] && { printf "%s already exists\\n" "${2##*/}"; exit 3; }',
  'set -o noclobber',
  'printf "%s" "$3" > "$2" || exit 1',
  'chmod +x -- "$2"'
].join("\n")

function basename(path) {
  var s = String(path || "").replace(/\/+$/, "")
  return s.slice(s.lastIndexOf("/") + 1)
}

function dirname(path) {
  var s = String(path || "")
  var i = s.lastIndexOf("/")
  return i <= 0 ? "/" : s.slice(0, i)
}

// "script-commands" → "Script Commands": the default packageName [O].
function titleCase(name) {
  return String(name || "").replace(/[-_.]+/g, " ").trim().split(/\s+/)
    .map(function(w) { return w ? w.charAt(0).toUpperCase() + w.slice(1) : w }).join(" ")
}

// "a/../b" style paths resolved against base, without touching the disk.
function resolvePath(base, path) {
  var p = String(path || "")
  var full = p.charAt(0) === "/" ? p : String(base || "/") + "/" + p
  var out = []
  var parts = full.split("/")
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i] || parts[i] === ".") continue
    if (parts[i] === "..") out.pop()
    else out.push(parts[i])
  }
  return "/" + out.join("/")
}

// Script directories: the default one, then config.json's
// scriptCommandDirectories (absolute or ~/), without duplicates. [D]
function directories(defaultDir, extra, home) {
  var out = []
  var list = [defaultDir].concat(Array.isArray(extra) ? extra : [])
  for (var i = 0; i < list.length; i++) {
    var d = String(list[i] || "").trim()
    if (d === "~" || d.indexOf("~/") === 0) d = String(home || "") + d.slice(1)
    if (d.charAt(0) !== "/") continue
    d = resolvePath("/", d)
    if (out.indexOf(d) < 0) out.push(d)
  }
  return out
}

// SCAN_SCRIPT output → [{path, shebang, lines}].
function parseScan(text) {
  var files = []
  var current = null
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.charAt(0) === "\x1e") {
      var tag = line.charAt(1)
      var value = line.slice(3)
      if (tag === "F") { current = { path: value, shebang: "", lines: [] }; files.push(current) }
      else if (tag === "S" && current) current.shebang = value
      continue
    }
    if (current && line) current.lines.push(line)
  }
  return files
}

// `#!/usr/bin/env -S python3 -u` → "python3 -u" (metadata only [O]).
function interpreter(shebang) {
  var s = String(shebang || "").replace(/^#!\s*/, "").trim()
  if (!s) return ""
  var parts = s.split(/\s+/)
  if (basename(parts[0]) === "env") {
    parts = parts.slice(1)
    if (parts[0] === "-S") parts = parts.slice(1)
    return parts.join(" ")
  }
  parts[0] = basename(parts[0])
  return parts.join(" ")
}

// "10s", "5m", "1h", "1d" → seconds, at least 10; 0 when malformed [O].
function refreshSeconds(value) {
  var m = /^(\d+)(s|m|h|d)$/.exec(String(value || "").trim())
  if (!m) return 0
  var n = Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]]
  return Math.max(MIN_REFRESH_SECONDS, n)
}

// argumentN JSON → a pill definition, or an error string.
function parseArgument(position, raw) {
  var spec
  try { spec = JSON.parse(raw) } catch (e) { return "argument" + position + " is not valid JSON" }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return "argument" + position + " must be a JSON object"
  var type = spec.type === undefined ? "text" : String(spec.type)
  if (["text", "password", "dropdown"].indexOf(type) < 0) return "argument" + position + " has an unknown type " + type
  var def = {
    name: "argument" + position,
    position: position,
    type: type,
    placeholder: String(spec.placeholder || "Argument " + position),
    required: spec.optional !== true,
    secure: type === "password" || spec.secure === true,
    percentEncoded: spec.percentEncoded === true
  }
  if (type === "dropdown") {
    if (!Array.isArray(spec.data) || spec.data.length === 0) return "argument" + position + " needs a data list of options"
    def.options = []
    for (var i = 0; i < spec.data.length; i++) {
      var o = spec.data[i] || {}
      if (o.value === undefined) return "argument" + position + " option " + (i + 1) + " has no value"
      def.options.push({ title: String(o.title === undefined ? o.value : o.title), value: String(o.value) })
    }
  }
  return def
}

// One scanned file → {ok: true, script} or {ok: false, error}.
function parse(file) {
  var meta = {}
  for (var i = 0; i < file.lines.length; i++) {
    var m = HEADER.exec(String(file.lines[i]).replace(/^\s+/, ""))
    if (!m) continue
    var key = KEY_BY_LOWER[m[1].toLowerCase()]
    if (key && meta[key] === undefined) meta[key] = m[2].trim()
  }
  if (meta.schemaVersion === undefined) return { ok: false, error: "Missing @raycast.schemaVersion" }
  if (meta.schemaVersion !== "1") return { ok: false, error: "@raycast.schemaVersion must be 1" }
  if (!meta.title) return { ok: false, error: "Missing @raycast.title" }
  if (!meta.mode) return { ok: false, error: "Missing @raycast.mode" }
  var mode = MODES[meta.mode.toLowerCase()]
  if (!mode) return { ok: false, error: "Unknown @raycast.mode " + meta.mode }

  var refresh = mode === "inline" ? refreshSeconds(meta.refreshTime) : 0
  if (mode === "inline" && !refresh) mode = "compact"          // [O]

  var args = []
  if (mode !== "inline") {                                     // ignored for inline [O]
    for (var n = 1; n <= 3; n++) {
      if (meta["argument" + n] === undefined) continue
      var def = parseArgument(n, meta["argument" + n])
      if (typeof def === "string") return { ok: false, error: def }
      args.push(def)
    }
  }

  var dir = dirname(file.path)
  return {
    ok: true,
    script: {
      id: ID_PREFIX + file.path,
      path: file.path,
      file: basename(file.path),
      dir: dir,
      title: meta.title,
      mode: mode,
      packageName: meta.packageName || titleCase(basename(dir)),
      description: meta.description || "",
      author: meta.author || "",
      authorURL: meta.authorURL || "",
      icon: iconFor(meta.icon, dir),
      cwd: resolvePath(dir, meta.currentDirectoryPath || "."),
      needsConfirmation: mode !== "inline" && String(meta.needsConfirmation).toLowerCase() === "true",
      refreshSeconds: refresh,
      arguments: args,
      interpreter: interpreter(file.shebang)
    }
  }
}

// A scan's files → {scripts, errors}, scripts sorted by title.
function load(files) {
  var scripts = []
  var errors = []
  for (var i = 0; i < files.length; i++) {
    var r = parse(files[i])
    if (r.ok) scripts.push(r.script)
    else errors.push({ id: ERROR_PREFIX + files[i].path, path: files[i].path, file: basename(files[i].path), error: r.error })
  }
  scripts.sort(function(a, b) { return a.title.localeCompare(b.title) || a.path.localeCompare(b.path) })
  return { scripts: scripts, errors: errors }
}

// @raycast.icon: an emoji or short text becomes the row glyph, an image path
// (relative to the script) its icon. Icon URLs are not fetched. [D]
function iconFor(value, dir) {
  var v = String(value || "").trim()
  if (!v || /^https?:\/\//i.test(v)) return { glyph: GLYPH, path: "" }
  if (/\.(png|svg|jpe?g|gif|webp|ico)$/i.test(v) || v.indexOf("/") >= 0) return { glyph: "", path: resolvePath(dir, v) }
  return { glyph: v.length <= 16 ? v : Array.from(v).slice(0, 2).join(""), path: "" }
}

// A script as a root-search candidate. inline: {text, error} for inline mode.
function candidate(script, inline) {
  var subtitle = script.packageName
  if (script.mode === "inline" && inline) subtitle = inline.error ? "⚠ Error: " + inline.error : inline.text
  return {
    id: script.id,
    type: "command",
    kind: "script",
    title: script.title,
    subtitle: subtitle,
    keywords: [script.packageName],
    extensionTitle: script.packageName,
    typeLabel: "Script Command",
    glyph: script.icon.glyph,
    glyphFont: "",
    iconName: script.icon.path,
    arguments: script.arguments,
    scriptPath: script.path,
    scriptMode: script.mode,
    description: script.description,
    author: script.author,
    rootSearch: { when: "always" }
  }
}

// A script that failed to parse, for the Search Script Commands view.
function errorCandidate(err) {
  return {
    id: err.id, type: "command", kind: "script-error", title: err.file, subtitle: err.error,
    typeLabel: "Invalid", glyph: "\uf071", scriptPath: err.path, rootSearch: { when: "always" }   // nf-fa-warning
  }
}

// A dropdown value typed or stepped into a pill → its option's value,
// matched by title or value. Throws when it is not one of them.
function optionValue(def, raw) {
  var wanted = String(raw || "").trim().toLowerCase()
  var match = def.options.filter(function(o) { return o.title.toLowerCase() === wanted || o.value.toLowerCase() === wanted })[0]
  if (!match) throw new Error(def.placeholder + " must be one of " + def.options.map(function(o) { return o.title }).join(", "))
  return match.value
}

// Pill values → positional $1..$3. Required ones must be set; a dropdown
// value must be one of its options, matched by title or value. Throws.
function argumentValues(defs, values) {
  var out = []
  for (var i = 0; i < (defs || []).length; i++) {
    var def = defs[i]
    var raw = String((values && values[def.name]) || "")
    if (def.required && !raw.trim()) throw new Error("Type a " + def.placeholder.toLowerCase() + " first")
    var value = def.options && raw.trim() ? optionValue(def, raw) : raw
    if (def.percentEncoded) value = encodeURIComponent(value)
    while (out.length < def.position - 1) out.push("")
    out[def.position - 1] = value
  }
  return out
}

function runArgv(script, args) {
  return ["bash", "-lc", RUN_SCRIPT, "oma-cast-script", script.cwd, script.path].concat(args || [])
}

// CSI, OSC and other escape sequences out; a carriage return keeps only
// what was drawn last on that line.
function stripAnsi(text) {
  return String(text || "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .split("\n").map(function(line) {
      var parts = line.split("\r")
      for (var i = parts.length - 1; i >= 0; i--) if (parts[i]) return parts[i]
      return ""
    }).join("\n")
}

function lastLine(text) {
  var lines = stripAnsi(text).split("\n")
  for (var i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return lines[i].trim()
  return ""
}

function firstLine(text) {
  var lines = stripAnsi(text).split("\n")
  for (var i = 0; i < lines.length; i++) if (lines[i].trim()) return lines[i].trim()
  return ""
}

// A finished run → {ok, message}. Success is exit 0 [O]; the message is the
// last non-empty line of output (first for inline).
function outcome(mode, exitCode, crashed, output) {
  var ok = !crashed && exitCode === 0
  var line = mode === "inline" ? firstLine(output) : lastLine(output)
  if (!ok && !line) line = crashed ? "The script was stopped" : "Exited with code " + exitCode
  return { ok: ok, message: line }
}

// Create Script Command's file name and contents. [D]
function slug(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "script"
}

function template(title, mode) {
  var t = String(title || "").replace(/\s+/g, " ").trim()
  if (!t) throw new Error("Type a title first")
  var m = MODES[String(mode || "compact").toLowerCase()] || "compact"
  var lines = [
    "#!/bin/bash",
    "",
    "# @raycast.schemaVersion 1",
    "# @raycast.title " + t,
    "# @raycast.mode " + m
  ]
  if (m === "inline") lines.push("# @raycast.refreshTime 1m")
  lines.push(
    "",
    "# Optional: icon, packageName, description, needsConfirmation and up to",
    "# three argumentN lines. Format: https://github.com/raycast/script-commands",
    "",
    'echo "Hello from ' + t.replace(/["\\$`]/g, "\\$&") + '"',
    ""
  )
  return lines.join("\n")
}

if (typeof module !== "undefined") {
  module.exports = {
    HEADER: HEADER,
    MAX_BYTES: MAX_BYTES,
    MIN_REFRESH_SECONDS: MIN_REFRESH_SECONDS,
    ID_PREFIX: ID_PREFIX,
    ERROR_PREFIX: ERROR_PREFIX,
    MODE_TITLES: MODE_TITLES,
    SCAN_SCRIPT: SCAN_SCRIPT,
    RUN_SCRIPT: RUN_SCRIPT,
    CREATE_SCRIPT: CREATE_SCRIPT,
    titleCase: titleCase,
    resolvePath: resolvePath,
    directories: directories,
    parseScan: parseScan,
    interpreter: interpreter,
    refreshSeconds: refreshSeconds,
    parseArgument: parseArgument,
    parse: parse,
    load: load,
    iconFor: iconFor,
    candidate: candidate,
    errorCandidate: errorCandidate,
    optionValue: optionValue,
    argumentValues: argumentValues,
    runArgv: runArgv,
    stripAnsi: stripAnsi,
    lastLine: lastLine,
    firstLine: firstLine,
    outcome: outcome,
    slug: slug,
    template: template
  }
}
