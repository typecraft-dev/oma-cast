// macOS root-search content (MACOS.md "What maps to what"): system commands
// in place of the Omarchy menu, and platform labels for shared actions.
// Pure data and functions; the Swift host runs `run.system` names.
// [D, 2026-11-12]

// Raycast's System commands (ref 04 §1) [O names]; the confirmation copy
// matches RootSearch's Omarchy ones.
var SYSTEM = [
  { name: "lock", title: "Lock Screen", keywords: ["lock"], symbol: "lock" },
  { name: "sleep", title: "Sleep", keywords: ["suspend"], symbol: "moon" },
  { name: "sleep-displays", title: "Sleep Displays", keywords: ["screen", "monitor", "off"], symbol: "display" },
  { name: "screensaver", title: "Start Screen Saver", keywords: ["screen saver"], symbol: "sparkles.tv" },
  { name: "toggle-appearance", title: "Toggle System Appearance", keywords: ["dark mode", "light mode", "theme"], symbol: "circle.lefthalf.filled" },
  { name: "empty-trash", title: "Empty Trash", keywords: ["bin", "delete"], symbol: "trash",
    confirm: { title: "Empty Trash", message: "Are you sure you want to permanently erase the items in the Trash?", primary: "Empty Trash" } },
  { name: "restart", title: "Restart", keywords: ["reboot"], symbol: "arrow.clockwise",
    confirm: { title: "Restart", message: "Are you sure you want to restart?", primary: "Restart" } },
  { name: "shutdown", title: "Shut Down", keywords: ["power off", "poweroff", "halt"], symbol: "power",
    confirm: { title: "Shut Down", message: "Are you sure you want to shut down?", primary: "Shut Down" } },
  { name: "logout", title: "Log Out", keywords: ["sign out", "logout"], symbol: "rectangle.portrait.and.arrow.right",
    confirm: { title: "Log Out", message: "Are you sure you want to log out?", primary: "Log Out" } },
  { name: "settings", title: "omacast Settings", keywords: ["preferences", "configure", "hotkey"], symbol: "gearshape" },
  { name: "quit-omacast", title: "Quit omacast", keywords: ["exit"], symbol: "xmark.circle" }
]

// System Settings panes, opened with x-apple.systempreferences:<id>. The
// ids are the macOS 13+ extension ids [I]; an unknown one still opens
// System Settings.
var SETTINGS_PANES = [
  { id: "com.apple.wifi-settings-extension", title: "Wi-Fi", symbol: "wifi" },
  { id: "com.apple.BluetoothSettings", title: "Bluetooth", symbol: "dot.radiowaves.left.and.right" },
  { id: "com.apple.Network-Settings.extension", title: "Network", symbol: "network" },
  { id: "com.apple.Battery-Settings.extension", title: "Battery", symbol: "battery.75percent" },
  { id: "com.apple.systempreferences.GeneralSettings", title: "General", symbol: "gearshape" },
  { id: "com.apple.Appearance-Settings.extension", title: "Appearance", symbol: "paintpalette" },
  { id: "com.apple.Accessibility-Settings.extension", title: "Accessibility", symbol: "accessibility" },
  { id: "com.apple.Desktop-Settings.extension", title: "Desktop & Dock", symbol: "dock.rectangle" },
  { id: "com.apple.Displays-Settings.extension", title: "Displays", symbol: "display" },
  { id: "com.apple.Notifications-Settings.extension", title: "Notifications", symbol: "bell.badge" },
  { id: "com.apple.Sound-Settings.extension", title: "Sound", symbol: "speaker.wave.2" },
  { id: "com.apple.Focus-Settings.extension", title: "Focus", symbol: "moon.circle" },
  { id: "com.apple.settings.PrivacySecurity.extension", title: "Privacy & Security", symbol: "hand.raised" },
  { id: "com.apple.Keyboard-Settings.extension", title: "Keyboard", symbol: "keyboard" },
  { id: "com.apple.Trackpad-Settings.extension", title: "Trackpad", symbol: "rectangle.and.hand.point.up.left" },
  { id: "com.apple.Mouse-Settings.extension", title: "Mouse", symbol: "computermouse" },
  { id: "com.apple.Users-Groups-Settings.extension", title: "Users & Groups", symbol: "person.2" },
  { id: "com.apple.LoginItems-Settings.extension", title: "Login Items", symbol: "person.crop.circle.badge.checkmark" },
  { id: "com.apple.Software-Update-Settings.extension", title: "Software Update", symbol: "arrow.triangle.2.circlepath" },
  { id: "com.apple.Storage-Settings.extension", title: "Storage", symbol: "internaldrive" }
]

// SF Symbols for the shared built-ins, whose Nerd Font glyphs macOS lacks.
var BUILTIN_SYMBOLS = {
  "builtin:google-search": "magnifyingglass",
  "builtin:duckduckgo-search": "magnifyingglass",
  "builtin:calculator-history": "clock.arrow.circlepath",
  "fallback:google": "magnifyingglass",
  "fallback:duckduckgo": "magnifyingglass",
  "calculator:result": "plus.forwardslash.minus"
}

function systemDefs() {
  var out = SYSTEM.map(function(c) {
    return {
      id: "builtin:mac-" + c.name, title: c.title, subtitle: "System", keywords: c.keywords,
      run: { system: c.name }, confirm: c.confirm || null, symbol: c.symbol, rootSearch: { when: "always" }
    }
  })
  return out.concat(SETTINGS_PANES.map(function(p) {
    return {
      id: "builtin:mac-settings-" + p.id, title: p.title + " Settings", subtitle: "System Settings",
      keywords: ["system settings", "preferences", p.title.toLowerCase()],
      run: { system: "settings:" + p.id }, symbol: p.symbol, rootSearch: { when: "searching" }
    }
  }))
}

// Every non-app candidate on macOS: the shared built-ins minus the Omarchy
// menu, plus the system commands.
function commandCandidates(RootSearch) {
  var defs = RootSearch.BUILTINS.filter(function(d) { return d.id !== "builtin:omarchy-menu" }).concat(systemDefs())
  return defs.map(function(def) {
    var c = RootSearch.builtinCandidate(def)
    c.glyph = ""
    c.glyphFont = ""
    c.symbol = def.symbol || BUILTIN_SYMBOLS[def.id] || "command"
    return c
  })
}

// entry: { id (unique), bundleId (may repeat across apps), name, path, keywords }
function appCandidate(RootSearch, entry) {
  var c = RootSearch.appCandidate({ id: entry.id, name: entry.name, keywords: entry.keywords || [], icon: entry.path })
  c.appId = String(entry.bundleId || entry.id)
  c.appPath = String(entry.path || "")
  c.windowKeys = []
  return c
}

function adjustActions(candidate, list) {
  return list.filter(function(a) { return a.id !== "open-in-omarchy-menu" }).map(function(a) {
    if (a.id === "copy-id") return Object.assign({}, a, { title: "Copy Bundle Identifier" })
    return a
  })
}

function adjustAbout(candidate, rows) {
  var out = []
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].label === "Desktop Entry") {
      out.push({ label: "Bundle Identifier", value: String(candidate.appId) })
      if (candidate.appPath) out.push({ label: "Path", value: candidate.appPath })
    } else out.push(rows[i])
  }
  return out
}

// Symbol for a search row: the candidate's own, else by id or kind.
function symbolFor(candidate) {
  if (candidate.symbol) return candidate.symbol
  if (BUILTIN_SYMBOLS[candidate.id]) return BUILTIN_SYMBOLS[candidate.id]
  if (candidate.kind === "calculator-history") return "equal.square"
  if (candidate.kind === "fallback") return "magnifyingglass"
  return ""
}

if (typeof module !== "undefined") {
  module.exports = {
    SYSTEM: SYSTEM, SETTINGS_PANES: SETTINGS_PANES, systemDefs: systemDefs, commandCandidates: commandCandidates,
    appCandidate: appCandidate, adjustActions: adjustActions, adjustAbout: adjustAbout, symbolFor: symbolFor
  }
}
