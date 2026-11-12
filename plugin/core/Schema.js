
var settingsMigrations = [
  {
    version: 1,
    name: "general-settings",
    up: function(doc) {
      doc.general = {
        windowMode: "expanded",
        showFavoritesInCompactMode: true,
        windowPresentationMode: "mouse-screen",
        popToRootTimeout: 90,
        escapeKeyBehavior: "pop-back-or-close",
        navigationBindings: "emacs",
        rootSearchSensitivity: "medium",
        uiZoom: 1,
        theme: "omarchy",
        // Quick Capture (notes): "" = the default Notes folder.
        quickCaptureDir: "",
        quickCaptureMode: "daily"
      }
      doc.commands = {}
      return doc
    }
  },
  {
    version: 2,
    name: "quick-capture",
    up: function(doc) {
      if (!doc.general || typeof doc.general !== "object") doc.general = {}
      if (typeof doc.general.quickCaptureDir !== "string") doc.general.quickCaptureDir = ""
      if (["inbox", "daily", "new"].indexOf(doc.general.quickCaptureMode) < 0) doc.general.quickCaptureMode = "daily"
      return doc
    }
  }
]

var frecencyMigrations = [
  {
    version: 1,
    name: "frecency",
    up: function(doc) {
      doc.items = {}
      doc.searchHistory = []
      return doc
    }
  }
]

// Calculator History (SPEC §6.4 calculator_history), capped and pruned by
// Calculator.pushHistory.
var calculatorMigrations = [
  {
    version: 1,
    name: "calculator-history",
    up: function(doc) {
      doc.history = []          // newest first: {id, query, result, copy, kind, createdAt}
      return doc
    }
  }
]

var SEARCH_HISTORY_LIMIT = 20

function pushSearchHistory(history, query) {
  var q = String(query || "").trim()
  var list = Array.isArray(history) ? history.slice() : []
  if (!q) return list
  list = list.filter(function(item) { return item !== q })
  list.unshift(q)
  return list.slice(0, SEARCH_HISTORY_LIMIT)
}

var documents = {
  settings: { file: "settings.json", migrations: settingsMigrations },
  frecency: { file: "frecency.json", migrations: frecencyMigrations },
  calculator: { file: "calculator.json", migrations: calculatorMigrations }
}

var configDefaults = {
  logLevel: "info",
  keepVisibleOnFocusLoss: false,
  // Daily ECB reference rates from frankfurter.dev for currency conversion
  // (SPEC §8 Calculator). The only network request oma-cast makes. [D]
  currencyRates: true,
  // Calculator preferences named after Raycast's (ref 04 App. B) [O].
  remToPxRate: 16,
  workHoursPerDay: 8,
  // "auto" follows the Qt locale; "12h" or "24h" forces a clock. [D]
  clockFormat: "auto",
  // Windows port additions [D]: global hotkey (Electron accelerator), the
  // UI font stack (empty = the bundled JetBrainsMono Nerd Font), the
  // "Ask default agent" command template ({prompt} substitution, empty =
  // the fallback row explains how to enable it), and the two window tokens
  // Style reads from Hyprland on Omarchy (same fallbacks, 5 / 0).
  hotkey: "Alt+Space",
  // "Open at Login" (ref 04 §3): on Windows main.js turns this into an
  // HKCU Run entry with app.setLoginItemSettings — applied at launch and
  // on every config change. Off by default. [D]
  openAtLogin: false,
  // Launcher colours: a theme name resolved against themes/ (bundled) and
  // %APPDATA%\oma-cast\themes (the user's place for themes). [D]
  theme: "tokyo-night",
  fontFamily: "",
  agentCommand: "",
  gapsOut: 5,
  cornerRadius: 0,
  // File search scopes (SPEC §8.6): empty → the user's home directory.
  // [D] includeHidden defaults off, matching Raycast's default.
  fileSearchScopes: [],
  fileSearchIncludeHidden: false,
  // File search provider (SPEC §8.6): the built-in chunked walk, or
  // voidtools Everything via es.exe — system-wide and instant, needs
  // Everything installed and running. A dead Everything falls back to
  // the walk pool for that query. [D]
  fileSearchProvider: "built-in",
  // Todoist personal API token (https://app.todoist.com/app/settings/integrations).
  // Empty = Todoist is off; TODOIST_TOKEN env var wins over this key.
  // No Settings row on purpose — the Windows list renders the value and
  // would put the token on screen. [D]
  todoistToken: ""
}

// Values a config key or general setting may take, beyond its type.
var configChoices = {
  clockFormat: ["auto", "12h", "24h"],
  fileSearchProvider: ["built-in", "everything"]
}

// Number keys allowed to be zero (gapsOut/cornerRadius mirror Hyprland
// options where 0 is meaningful). [D]
var configZeroable = { gapsOut: true, cornerRadius: true }

var generalChoices = {
  windowMode: ["expanded", "compact"],
  escapeKeyBehavior: ["pop-back-or-close", "close-and-pop-to-root"],
  navigationBindings: ["emacs", "vim-motions"],
  rootSearchSensitivity: ["low", "medium", "high"],
  // Quick Capture: same inbox file, same daily file, or a new file each time.
  quickCaptureMode: ["inbox", "daily", "new"]
}

function validConfigValue(key, value) {
  if (typeof value !== typeof configDefaults[key]) return false
  if (configChoices[key]) return configChoices[key].indexOf(value) >= 0
  if (typeof value === "number") return isFinite(value) && (configZeroable[key] ? value >= 0 : value > 0)
  return true
}

function withConfigDefaults(value) {
  var out = {}
  for (var key in configDefaults) out[key] = configDefaults[key]
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (var k in value) {
      if (configDefaults[k] !== undefined && validConfigValue(k, value[k])) out[k] = value[k]
    }
  }
  return out
}

if (typeof module !== "undefined") {
  module.exports = {
    settingsMigrations: settingsMigrations,
    frecencyMigrations: frecencyMigrations,
    calculatorMigrations: calculatorMigrations,
    pushSearchHistory: pushSearchHistory,
    SEARCH_HISTORY_LIMIT: SEARCH_HISTORY_LIMIT,
    documents: documents,
    configDefaults: configDefaults,
    generalChoices: generalChoices,
    validConfigValue: validConfigValue,
    withConfigDefaults: withConfigDefaults
  }
}
