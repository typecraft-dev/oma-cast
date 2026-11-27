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

// Keycodes (evdev + 8, what Hyprland's code:N means) of the keys whose
// keysym depends on Shift or the layout. Recorded hotkeys bind these by code,
// as Omarchy does for its workspace digits, and show them by the US label.
var CODE_LABELS = {
  10: "1", 11: "2", 12: "3", 13: "4", 14: "5", 15: "6", 16: "7", 17: "8", 18: "9", 19: "0",
  20: "-", 21: "=", 34: "[", 35: "]", 47: ";", 48: "'", 49: "`", 51: "\\", 59: ",", 60: ".", 61: "/", 94: "<"
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
  var parts = splitChord(chord)
  if (!parts) return ""
  var mods = parts.mods
  var key = parts.key
  var names = []
  for (var i = 0; i < mods.length; i++) {
    var m = MOD_NAMES[mods[i].toUpperCase()]
    if (!m) return ""
    if (names.indexOf(m) < 0) names.push(m)
  }
  names.sort(function(a, b) { return MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b) })
  var upper = key.toUpperCase()
  var code = /^code:(\d+)$/i.exec(key)
  if (code) { if (!CODE_LABELS[code[1]]) return ""; names.push(CODE_LABELS[code[1]]); return names.join(" ") }
  var label = KEY_NAMES[upper] || (key.length === 1 ? upper : /^F\d+$/.test(upper) ? upper : key.charAt(0).toUpperCase() + key.slice(1))
  names.push(label)
  return names.join(" ")
}

// "SUPER SHIFT + RETURN" (Omarchy's records) or "SUPER + SHIFT + RETURN"
// (Hyprland's own spelling) -> { mods, key }; null for mouse binds.
function splitChord(chord) {
  var s = String(chord || "").trim()
  if (!s || /MOUSE|mouse:/.test(s)) return null
  var plus = s.lastIndexOf(" + ")
  var mods = plus >= 0 ? s.slice(0, plus).split(/[\s+]+/).filter(function(m) { return m }) : []
  var key = (plus >= 0 ? s.slice(plus + 3) : s).trim()
  if (!key || /\s/.test(key)) return null
  return { mods: mods, key: key }
}

var BIND_MODS = { SUPER: "SUPER", CTRL: "CTRL", CONTROL: "CTRL", ALT: "ALT", SHIFT: "SHIFT" }
var BIND_ORDER = ["SUPER", "CTRL", "ALT", "SHIFT"]

// Any chord in Hyprland's bind spelling, "SUPER + SHIFT + RETURN", the form
// hl.bind and hl.unbind take. "" when it can't be one.
function bindString(chord) {
  var parts = splitChord(chord)
  if (!parts) return ""
  var mods = []
  for (var i = 0; i < parts.mods.length; i++) {
    var m = BIND_MODS[parts.mods[i].toUpperCase()]
    if (!m) return ""
    if (mods.indexOf(m) < 0) mods.push(m)
  }
  mods.sort(function(a, b) { return BIND_ORDER.indexOf(a) - BIND_ORDER.indexOf(b) })
  return mods.concat([parts.key]).join(" + ")
}

// Two chords for the same keys, however each was spelled.
function sameChord(a, b) {
  var fa = formatChord(a)
  return fa !== "" && fa === formatChord(b)
}

// Qt's key and modifier values (Qt::Key, Qt::KeyboardModifier), so the
// recorder logic stays testable outside QML.
var QT = {
  ShiftModifier: 0x02000000, ControlModifier: 0x04000000, AltModifier: 0x08000000, MetaModifier: 0x10000000,
  Key_Escape: 0x01000000, Key_Tab: 0x01000001, Key_Backtab: 0x01000002, Key_Backspace: 0x01000003,
  Key_Return: 0x01000004, Key_Enter: 0x01000005, Key_Insert: 0x01000006, Key_Delete: 0x01000007,
  Key_Print: 0x01000009, Key_Home: 0x01000010, Key_End: 0x01000011, Key_Left: 0x01000012, Key_Up: 0x01000013,
  Key_Right: 0x01000014, Key_Down: 0x01000015, Key_PageUp: 0x01000016, Key_PageDown: 0x01000017,
  Key_F1: 0x01000030, Key_F24: 0x01000047, Key_Space: 0x20
}
var QT_NAMED = {}
QT_NAMED[QT.Key_Escape] = "ESCAPE"; QT_NAMED[QT.Key_Tab] = "TAB"; QT_NAMED[QT.Key_Backtab] = "TAB"
QT_NAMED[QT.Key_Backspace] = "BACKSPACE"; QT_NAMED[QT.Key_Return] = "RETURN"; QT_NAMED[QT.Key_Enter] = "RETURN"
QT_NAMED[QT.Key_Insert] = "INSERT"; QT_NAMED[QT.Key_Delete] = "DELETE"; QT_NAMED[QT.Key_Print] = "PRINT"
QT_NAMED[QT.Key_Home] = "HOME"; QT_NAMED[QT.Key_End] = "END"; QT_NAMED[QT.Key_Left] = "LEFT"; QT_NAMED[QT.Key_Up] = "UP"
QT_NAMED[QT.Key_Right] = "RIGHT"; QT_NAMED[QT.Key_Down] = "DOWN"; QT_NAMED[QT.Key_PageUp] = "PRIOR"
QT_NAMED[QT.Key_PageDown] = "NEXT"; QT_NAMED[QT.Key_Space] = "SPACE"

// Qt keys that are only a modifier (Shift, Ctrl, Meta, Alt, CapsLock,
// NumLock, ScrollLock, Super_L/R, Menu, Hyper_L/R, AltGr): pressed alone
// they don't finish a hotkey.
function isModifierKey(key) {
  return (key >= 0x01000020 && key <= 0x01000026) || (key >= 0x01000053 && key <= 0x01000057) || key === 0x01001103
}

// A recorded key press -> { bind } in Hyprland's spelling, or { error }.
// Letters, named keys and F-keys bind by name; digits and punctuation bind
// by keycode, since Shift and the layout change their keysym. Super, Ctrl or
// Alt is required, except on F-keys, so a hotkey never eats plain typing. [D]
function hotkeyFromKey(key, modifiers, scanCode) {
  var mods = []
  if (modifiers & QT.MetaModifier) mods.push("SUPER")
  if (modifiers & QT.ControlModifier) mods.push("CTRL")
  if (modifiers & QT.AltModifier) mods.push("ALT")
  if (modifiers & QT.ShiftModifier || key === QT.Key_Backtab) mods.push("SHIFT")
  if (isModifierKey(key)) return { pending: true }
  var name = ""
  var fkey = key >= QT.Key_F1 && key <= QT.Key_F24
  if (key >= 0x41 && key <= 0x5a) name = String.fromCharCode(key)
  else if (fkey) name = "F" + (key - QT.Key_F1 + 1)
  else if (QT_NAMED[key]) name = QT_NAMED[key]
  else if (CODE_LABELS[scanCode]) name = "code:" + scanCode
  if (!name) return { error: "That key can't be a hotkey" }
  var strong = mods.some(function(m) { return m !== "SHIFT" })
  if (!strong && !fkey) return { error: "Use Super, Ctrl or Alt with it" }
  return { bind: mods.concat([name]).join(" + ") }
}

// The global shortcut a command's hotkey fires: omacast:hk-<FNV-1a of the
// id>. Command ids hold ":" and ".", which a shortcut name can't. [D]
function shortcutName(commandId) {
  var h = 0x811c9dc5
  var s = String(commandId)
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return "hk-" + ("0000000" + h.toString(16)).slice(-8)
}

var SAFE_BIND = /^[A-Za-z0-9_:+ ]+$/

// What settings.json asks of Hyprland: a bind per command hotkey, and the
// outside binds removed from rows. Malformed entries are skipped.
function hotkeyPlan(commands) {
  var binds = []
  var unbinds = []
  var ids = Object.keys(commands || {}).sort()
  for (var i = 0; i < ids.length; i++) {
    var s = commands[ids[i]] || {}
    if (s.hotkey && SAFE_BIND.test(s.hotkey) && bindString(s.hotkey)) {
      binds.push({ commandId: ids[i], bind: bindString(s.hotkey), name: shortcutName(ids[i]) })
    }
    var removed = s.removedBinds || []
    for (var r = 0; r < removed.length; r++) {
      var b = bindString(removed[r])
      if (b && SAFE_BIND.test(b) && unbinds.indexOf(b) < 0) unbinds.push(b)
    }
  }
  return { binds: binds, unbinds: unbinds }
}

function luaString(value) {
  return '"' + String(value).replace(/[\\"]/g, "\\$&").replace(/[\x00-\x1f\x7f]/g, " ") + '"'
}

// The Lua hyprctl eval runs for a plan. Every unbind is guarded, so a key
// already gone is fine; a hotkey first drops whatever had its keys, which is
// how it replaces an Omarchy bind. titles: commandId -> row title.
function hotkeyLua(plan, titles) {
  var lines = []
  plan.unbinds.forEach(function(b) { lines.push("pcall(hl.unbind, " + luaString(b) + ")") })
  plan.binds.forEach(function(h) {
    var title = (titles && titles[h.commandId]) || h.commandId
    lines.push("pcall(hl.unbind, " + luaString(h.bind) + ")")
    lines.push("hl.bind(" + luaString(h.bind) + ", hl.dsp.global(" + luaString("omacast:" + h.name) + "), { description = " + luaString(title + " (omacast)") + " })")
  })
  return lines.join("\n")
}

// Whether moving from one applied plan to the next takes binds away. Only a
// config reload brings back an Omarchy bind a hotkey or a removal replaced.
function needsReload(previous, next) {
  if (!previous) return false
  var nextBinds = {}
  next.binds.forEach(function(h) { nextBinds[h.bind] = h.name })
  var dropped = previous.binds.some(function(h) { return nextBinds[h.bind] !== h.name })
  var restored = previous.unbinds.some(function(b) { return next.unbinds.indexOf(b) < 0 })
  return dropped || restored
}

// What else has these keys: another command's hotkey, or a Hyprland bind
// (Omarchy's or the user's). Our own binds carry "(omacast)" and are
// skipped; the command's own hotkey isn't a conflict.
function hotkeyConflict(bind, commandId, commands, records, titles) {
  var ids = Object.keys(commands || {})
  for (var i = 0; i < ids.length; i++) {
    if (ids[i] === commandId) continue
    var other = commands[ids[i]] || {}
    if (other.hotkey && sameChord(other.hotkey, bind))
      return { kind: "omacast", commandId: ids[i], title: (titles && titles[ids[i]]) || ids[i] }
  }
  for (var r = 0; r < (records || []).length; r++) {
    var rec = records[r]
    if (/\(omacast\)$/.test(rec.description)) continue
    if (sameChord(rec.chord, bind)) return { kind: "hyprland", title: rec.description }
  }
  return null
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
    parseScan: parseScan,
    splitChord: splitChord,
    bindString: bindString,
    sameChord: sameChord,
    QT: QT,
    hotkeyFromKey: hotkeyFromKey,
    shortcutName: shortcutName,
    hotkeyPlan: hotkeyPlan,
    hotkeyLua: hotkeyLua,
    needsReload: needsReload,
    hotkeyConflict: hotkeyConflict
  }
}
