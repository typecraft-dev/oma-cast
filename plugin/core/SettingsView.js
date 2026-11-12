// Settings rows for the in-app Settings view (the Phase-2 stub made
// usable on Windows, where there is no other way to reach the hotkey).
// Pure: definitions + cycling + formatting; the backend persists. [D]

// scope "general" → settings.json general (validated by Schema.generalChoices);
// scope "config"   → config.json (validated by Schema.validConfigValue).
var DEFS = [
  { scope: "general", key: "windowMode", label: "Window Mode", hint: "Expanded shows the footer; compact keeps only the search bar",
    type: "enum", choices: ["expanded", "compact"] },
  { scope: "general", key: "escapeKeyBehavior", label: "Escape Behavior", hint: "What Esc does on an empty query at the root",
    type: "enum", choices: ["pop-back-or-close", "close-and-pop-to-root"],
    titles: { "pop-back-or-close": "Pop Back or Close", "close-and-pop-to-root": "Close and Pop to Root" } },
  { scope: "general", key: "navigationBindings", label: "Navigation Bindings", hint: "Ctrl+N emacs style, Ctrl+J/K vim-motions (action panel on Alt+K)",
    type: "enum", choices: ["emacs", "vim-motions"], titles: { emacs: "Emacs", "vim-motions": "Vim Motions" } },
  { scope: "general", key: "rootSearchSensitivity", label: "Search Sensitivity", hint: "How aggressively ranking rewards matches",
    type: "enum", choices: ["low", "medium", "high"], titles: { low: "Low", medium: "Medium", high: "High" } },
  { scope: "general", key: "popToRootTimeout", label: "Pop to Root After", hint: "Idle seconds before a pushed view returns to the root",
    type: "number", presets: [0, 15, 30, 60, 90, 300] },
  { scope: "general", key: "uiZoom", label: "Interface Zoom", hint: "Same as Ctrl + / − / 0",
    type: "number", presets: [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5] },
  { scope: "general", key: "quickCaptureMode", label: "Quick Capture Mode", hint: "Where a capture lands — same inbox file, same daily file, or a new file each time",
    type: "enum", choices: ["inbox", "daily", "new"],
    titles: { inbox: "Same file (inbox)", daily: "Same file per day", "new": "New file each time" } },
  { scope: "general", key: "quickCaptureDir", label: "Quick Capture Directory", hint: "Folder for captured notes — empty uses the default Notes folder",
    type: "text" },

  // choices come from disk at render time (dyn.themes); "choices" is only
  // the fallback when the backend supplies none.
  { scope: "config", key: "theme", label: "Theme", hint: "Launcher colours — add your own as %APPDATA%\\oma-cast\\themes\\<name>\\colors.toml",
    type: "enum", dynamic: "themes", choices: ["tokyo-night"], slug: true },
  { scope: "config", key: "hotkey", label: "Global Hotkey", hint: "Electron accelerator; applied immediately",
    type: "enum", choices: ["Alt+Space", "Alt+K", "Alt+F", "Ctrl+Space", "Ctrl+Alt+Space", "Alt+Q"] },
  { scope: "config", key: "openAtLogin", label: "Open at Login", hint: "Launch the launcher when you sign in (starts hidden in the background)",
    type: "bool" },
  { scope: "config", key: "keepVisibleOnFocusLoss", label: "Keep Visible on Focus Loss", hint: "Off: clicking away or blurring dismisses the launcher",
    type: "bool" },
  { scope: "config", key: "currencyRates", label: "Currency Rates", hint: "Daily ECB rates from frankfurter.dev — the only network request",
    type: "bool" },
  { scope: "config", key: "clockFormat", label: "Clock Format", hint: "\"auto\" follows the Windows locale",
    type: "enum", choices: ["auto", "12h", "24h"], titles: { auto: "Auto", "12h": "12-hour", "24h": "24-hour" } },
  { scope: "config", key: "remToPxRate", label: "REM to px", hint: "Calculator: px per rem",
    type: "number", presets: [8, 12, 16, 24, 32] },
  { scope: "config", key: "workHoursPerDay", label: "Work Hours per Day", hint: "Calculator: work-day conversions",
    type: "number", presets: [4, 6, 8, 10] },
  { scope: "config", key: "fileSearchIncludeHidden", label: "File Search: Include Hidden", hint: "Dotfiles and hidden files in the index",
    type: "bool" },
  { scope: "config", key: "fileSearchProvider", label: "File Search Provider", hint: "Built-in walks your folders; Everything queries voidtools Everything (install it, keep it running) across all drives instantly",
    type: "enum", choices: ["built-in", "everything"], titles: { "built-in": "Built-in Index", "everything": "Everything" } }
]

function valueOf(def, general, config) {
  var src = def.scope === "general" ? general : config
  var v = src ? src[def.key] : undefined
  if (def.type === "number" && typeof v !== "number") return def.presets[0]
  return v
}

// Enum choices a def resolves to right now: the backend's dynamic list
// (themes found on disk) or the static table. [D]
function choicesFor(def, dyn) {
  var dynChoices = def.dynamic && dyn ? dyn[def.dynamic] : null
  if (Array.isArray(dynChoices) && dynChoices.length) return dynChoices
  return def.choices || []
}

function format(def, value) {
  // Freeform text (the capture folder): empty reads as the default.
  if (def.type === "text") return value && String(value).trim() ? String(value) : "Default"
  if (def.type === "bool") return value ? "On" : "Off"
  if (def.type === "number") {
    if (def.key === "popToRootTimeout") return value ? value + " s" : "Off"
    if (def.key === "uiZoom") return (Math.round(value * 10) / 10).toFixed(1) + "×"
    return String(value)
  }
  var title = def.titles && def.titles[value]
  if (title) return title
  // "slug" values (theme names) read better verbatim: tokyo-night.
  if (def.slug) return String(value)
  return String(value).replace(/-/g, " ").replace(/^./, function(c) { return c.toUpperCase() })
}

// ↵ on a settings row cycles to the next value. Freeform text has no next
// value — ↵ pushes the editor view instead (the backends branch on type).
function cycle(def, value, dyn) {
  if (def.type === "text") return value
  if (def.type === "bool") return !value
  if (def.type === "number") {
    var presets = def.presets
    for (var i = 0; i < presets.length; i++) if (presets[i] === value) return presets[(i + 1) % presets.length]
    return presets[0]
  }
  var choices = choicesFor(def, dyn)
  if (!choices.length) return value
  var at = choices.indexOf(value)
  return choices[(at + 1) % choices.length]
}

function rowsFor(general, config, query, dyn) {
  var q = String(query || "").trim().toLowerCase()
  var out = []
  for (var i = 0; i < DEFS.length; i++) {
    var def = DEFS[i]
    if (q && def.label.toLowerCase().indexOf(q) < 0 && def.key.toLowerCase().indexOf(q) < 0 && def.hint.toLowerCase().indexOf(q) < 0) continue
    var value = valueOf(def, general, config)
    out.push({
      id: "setting:" + def.scope + ":" + def.key,
      type: "setting",
      kind: "setting",
      title: def.label,
      subtitle: def.hint,
      typeLabel: format(def, value),
      keyword: def.key,
      rootSearch: { when: "always" }
    })
  }
  return out
}

function find(id) {
  var parts = String(id || "").split(":")
  if (parts.length !== 3 || parts[0] !== "setting") return null
  for (var i = 0; i < DEFS.length; i++) {
    if (DEFS[i].scope === parts[1] && DEFS[i].key === parts[2]) return DEFS[i]
  }
  return null
}

if (typeof module !== "undefined") {
  module.exports = { DEFS: DEFS, valueOf: valueOf, format: format, cycle: cycle, rowsFor: rowsFor, find: find }
}
