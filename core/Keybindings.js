// Hyprland keybindings shown on the app rows they launch, the way Raycast
// shows a command's hotkey as keycaps on its row [D]. omacast doesn't own
// these binds: they come from Omarchy's keybindings menu, which already turns
// the Lua config's binds into "<chord> → <description>\t<dispatcher>\t<arg>"
// records (omarchy-menu-keybindings, ~/.cache/omarchy/keybindings-*.records).
// This module parses those records, works out which desktop entry each exec
// bind opens, and formats the chord as keycaps. Pure logic, no Qt.

// "SUPER SHIFT + RETURN                → Browser\texec\tomarchy-launch-browser"
function parseRecords(text) {
  var out = []
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var fields = lines[i].split("\t")
    if (fields.length < 3) continue
    var head = fields[0]
    var arrow = head.indexOf(" → ")
    if (arrow < 0) continue
    // "SUPER + W / SUPER + Q" lists two chords for one action; the first is enough.
    var chord = head.slice(0, arrow).trim().split(" / ")[0].trim()
    if (!chord) continue
    out.push({
      chord: chord,
      description: head.slice(arrow + 3).trim(),
      dispatcher: fields[1].trim(),
      arg: fields.slice(2).join("\t").trim()
    })
  }
  return out
}

// Words of a command line, honouring the single and double quotes Omarchy's
// shell_quote and desktop Exec lines use. null for anything a word list can't
// stand for (pipes, ||, &&, ;, redirections, substitutions): those binds run
// a script, not an app.
function splitCommand(command) {
  var s = String(command || "")
  var words = []
  var word = ""
  var inWord = false
  for (var i = 0; i < s.length; i++) {
    var ch = s[i]
    if (ch === "'") {
      var end = s.indexOf("'", i + 1)
      if (end < 0) return null
      word += s.slice(i + 1, end); inWord = true; i = end
    } else if (ch === '"') {
      var j = i + 1
      var buf = ""
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\" && j + 1 < s.length) { buf += s[j + 1]; j += 2 } else { if (s[j] === "$" || s[j] === "`") return null; buf += s[j]; j++ }
      }
      if (j >= s.length) return null
      word += buf; inWord = true; i = j
    } else if (ch === "\\" && i + 1 < s.length) {
      word += s[i + 1]; inWord = true; i++
    } else if (/\s/.test(ch)) {
      if (inWord) { words.push(word); word = ""; inWord = false }
    } else if ("|&;<>$`()".indexOf(ch) >= 0) {
      return null
    } else {
      word += ch; inWord = true
    }
  }
  if (inWord) words.push(word)
  return words
}

function basename(path) {
  var s = String(path || "")
  return s.slice(s.lastIndexOf("/") + 1)
}

// The part of a web app URL both a bind and a desktop entry reduce to.
function urlKey(url) {
  return "url:" + String(url).replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "").toLowerCase()
}

// Drops what only wraps the launch: setsid, env assignments, uwsm-app --.
function unwrap(words) {
  var w = words.slice()
  while (w.length) {
    var first = basename(w[0])
    if (first === "setsid" || first === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) { w.shift(); continue }
    if (first === "uwsm-app" || first === "uwsm") {
      var dash = w.indexOf("--")
      w = dash >= 0 ? w.slice(dash + 1) : w.slice(first === "uwsm" ? 2 : 1)
      continue
    }
    break
  }
  return w
}

// Keys for what a command opens:
//   "id:<desktop id>"  Omarchy's terminal and browser launchers, resolved
//                      against the user's default terminal and browser
//   "url:<host/path>"  a web app
//   "bin:<program>"    anything else, by program name
// `strict` is for binds: a plain command with arguments ("alacritty -e ssh
// box") is a task, not the app, so only a bare program counts. A desktop
// entry's Exec always has its arguments, so entries pass strict = false.
function commandKeys(words, defaults, strict) {
  var w = unwrap(words || [])
  if (!w.length) return []
  var d = defaults || {}
  var prog = basename(w[0])
  var rest = w.slice(1)
  var urls = rest.filter(function(x) { return /^https?:\/\//i.test(x) })

  switch (prog) {
    case "omarchy-launch-terminal":
    case "xdg-terminal-exec":
      return rest.length === 0 && d.terminal ? ["id:" + stripDesktop(d.terminal)] : []
    case "omarchy-launch-browser":
      // --private opens a private window, not the browser as you left it.
      return rest.length === 0 && d.browser ? ["id:" + stripDesktop(d.browser)] : []
    case "omarchy-launch-editor":
      return rest.length === 0 && d.editor ? ["bin:" + basename(d.editor)] : []
    case "omarchy-launch-webapp":
    case "omarchy-launch-or-focus-webapp":
      return urls.length ? [urlKey(urls[urls.length - 1])] : []
    case "omarchy-launch-or-focus":
      // omarchy-launch-or-focus '<window regex>' '<command>'
      return rest.length >= 2 ? commandKeys(splitCommand(rest[1]) || [], d, strict) : []
    case "omarchy-launch-tui":
    case "omarchy-launch-or-focus-tui":
      return rest.length ? ["bin:" + basename(rest[0])] : []
  }

  // A browser Exec with --app=<url> is a Chromium web app.
  for (var i = 0; i < rest.length; i++) {
    var m = /^--app=(https?:\/\/.+)$/i.exec(rest[i])
    if (m) return [urlKey(m[1])]
  }

  // omarchy-launch-<app> scripts focus or start that app: omarchy-launch-
  // nautilus, -spotify, -signal (signal-desktop), -1password.
  var launcher = /^omarchy-launch-(.+)$/.exec(prog)
  if (launcher) return rest.length === 0 ? ["bin:" + launcher[1], "bin:" + launcher[1] + "-desktop"] : []
  // Every other omarchy-* script is an Omarchy action, not an app.
  if (/^omarchy-/.test(prog)) return []

  if (strict && rest.length > 0) return []
  return ["bin:" + prog]
}

function stripDesktop(id) {
  return String(id || "").replace(/\.desktop$/, "")
}

// Keys a desktop entry answers to: its id and what its Exec runs.
function entryKeys(entry, defaults) {
  var id = String(entry && entry.id || "")
  var keys = id ? ["id:" + stripDesktop(id)] : []
  var words = null
  if (entry && entry.command && entry.command.length) words = Array.prototype.slice.call(entry.command).map(String)
  else if (entry && entry.execString) words = splitCommand(entry.execString)
  words = (words || []).filter(function(word) { return !/^%[a-zA-Z]$/.test(word) })
  commandKeys(words, defaults, false).forEach(function(k) { if (keys.indexOf(k) < 0) keys.push(k) })
  // The program itself, even when Exec wraps it in a launcher with arguments.
  var w = unwrap(words)
  if (w.length) {
    var bin = "bin:" + basename(w[0])
    if (keys.indexOf(bin) < 0 && !/^bin:omarchy-/.test(bin)) keys.push(bin)
  }
  return keys
}

// desktop id -> chord, for every entry an exec bind opens. Records come in
// the order Omarchy's menu lists them (most important first), so the first
// bind for an app wins: Super+Shift+Return over Super+Shift+B for the browser.
function appHotkeys(records, entries, defaults) {
  var byKey = {}
  for (var i = 0; i < (records || []).length; i++) {
    var r = records[i]
    if (r.dispatcher !== "exec" || !r.arg) continue
    var words = splitCommand(r.arg)
    if (!words) continue
    var keys = commandKeys(words, defaults, true)
    for (var k = 0; k < keys.length; k++) if (!(keys[k] in byKey)) byKey[keys[k]] = r.chord
  }
  var out = {}
  for (var e = 0; e < (entries || []).length; e++) {
    var entry = entries[e]
    if (!entry || !entry.id) continue
    var ek = entryKeys(entry, defaults)
    // The id beats the program: a terminal bind names Ghostty's desktop id.
    for (var j = 0; j < ek.length; j++) if (ek[j] in byKey) { out[String(entry.id)] = byKey[ek[j]]; break }
  }
  return out
}

var KEY_NAMES = {
  RETURN: "↵", ENTER: "↵", KP_ENTER: "↵", SPACE: "Space", TAB: "Tab", ESCAPE: "Esc", BACKSPACE: "⌫",
  DELETE: "Del", INSERT: "Ins", HOME: "Home", END: "End", PRINT: "PrtSc",
  LEFT: "←", RIGHT: "→", UP: "↑", DOWN: "↓", PAGE_UP: "PgUp", PRIOR: "PgUp", PAGE_DOWN: "PgDn", NEXT: "PgDn",
  SLASH: "/", BACKSLASH: "\\", COMMA: ",", PERIOD: ".", SEMICOLON: ";", APOSTROPHE: "'", GRAVE: "`",
  MINUS: "-", EQUAL: "=", BRACKETLEFT: "[", BRACKETRIGHT: "]", "~": "~"
}
var MOD_NAMES = { SUPER: "Super", SHIFT: "Shift", CTRL: "Ctrl", CONTROL: "Ctrl", ALT: "Alt" }
var MOD_ORDER = ["Super", "Ctrl", "Alt", "Shift"]

// "SUPER SHIFT + RETURN" -> "Super Shift ↵", the space-separated keycaps the
// launcher's KeyHint draws. Modifiers follow one order whichever way the bind
// spelled them. "" for chords that aren't a key press (mouse buttons).
function formatChord(chord) {
  var s = String(chord || "").trim()
  if (!s || /MOUSE|mouse:/.test(s)) return ""
  var plus = s.lastIndexOf(" + ")
  var mods = plus >= 0 ? s.slice(0, plus).split(/\s+/) : []
  var key = (plus >= 0 ? s.slice(plus + 3) : s).trim()
  if (!key || /\s/.test(key)) return ""
  var names = []
  for (var i = 0; i < mods.length; i++) {
    var m = MOD_NAMES[mods[i].toUpperCase()]
    if (!m) return ""
    if (names.indexOf(m) < 0) names.push(m)
  }
  names.sort(function(a, b) { return MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b) })
  var upper = key.toUpperCase()
  var label = KEY_NAMES[upper] || (key.length === 1 ? upper : /^F\d+$/.test(upper) ? upper : key.charAt(0).toUpperCase() + key.slice(1))
  names.push(label)
  return names.join(" ")
}

// Output of the service's scan: "<name>\t<value>" default lines, a \x1e line,
// then the records.
function parseScan(text) {
  var s = String(text || "")
  var split = s.indexOf("\x1e\n")
  var head = split >= 0 ? s.slice(0, split) : ""
  var body = split >= 0 ? s.slice(split + 2) : s
  var defaults = {}
  head.split("\n").forEach(function(line) {
    var tab = line.indexOf("\t")
    if (tab > 0) defaults[line.slice(0, tab)] = line.slice(tab + 1).trim()
  })
  return { defaults: defaults, records: parseRecords(body) }
}

if (typeof module !== "undefined") {
  module.exports = {
    parseRecords: parseRecords,
    splitCommand: splitCommand,
    commandKeys: commandKeys,
    entryKeys: entryKeys,
    appHotkeys: appHotkeys,
    formatChord: formatChord,
    parseScan: parseScan
  }
}
