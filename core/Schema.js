
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
        theme: "omarchy"
      }
      doc.commands = {}
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

// Emoji & Symbols: frecency per base emoji (Frecency.recordVisit entries,
// ref 02 §4.6 "emoji recents use the same formula"), pins and skin tone.
var emojiMigrations = [
  {
    version: 1,
    name: "emoji",
    up: function(doc) {
      doc.items = {}            // symbol -> frecency entry
      doc.pinned = []           // symbols, in pin order
      doc.skinTone = "none"     // Emoji.TONES id
      return doc
    }
  }
]

// Clipboard History (SPEC §8.2): ClipboardHistory.add entries, newest first.
var clipboardMigrations = [
  {
    version: 1,
    name: "clipboard-history",
    up: function(doc) {
      doc.entries = []          // {id, type, text?, path?, mime, hash, bytes, categories, source, copyCount, createdAt, updatedAt, pinned}
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
  calculator: { file: "calculator.json", migrations: calculatorMigrations },
  emoji: { file: "emoji.json", migrations: emojiMigrations },
  clipboard: { file: "clipboard.json", migrations: clipboardMigrations }
}

var configDefaults = {
  logLevel: "info",
  keepVisibleOnFocusLoss: false,
  // Daily ECB reference rates from frankfurter.dev for currency conversion
  // (SPEC §8 Calculator). The only network request omacast makes. [D]
  currencyRates: true,
  // Calculator preferences named after Raycast's (ref 04 App. B) [O].
  remToPxRate: 16,
  workHoursPerDay: 8,
  // "auto" follows the Qt locale; "12h" or "24h" forces a clock. [D]
  clockFormat: "auto",
  // The All / Applications / Commands filter button (Ctrl+P) beside the root
  // search; false hides it and leaves every result in one list. [D]
  rootFilter: true,
  // Clipboard History preferences named after Raycast's (ref 04 App. B) [O].
  // clipboardHistory false stops recording; the history stays. [D]
  clipboardHistory: true,
  clipboardHistoryDuration: "P1W",
  // Wayland app ids whose copies are never recorded (SPEC §5.3 defaults).
  clipboardDisabledApplications: ["org.keepassxc.KeePassXC", "Bitwarden", "1Password", "seahorse", "org.gnome.seahorse.Application"]
}

// Values a config key or general setting may take, beyond its type.
var configChoices = {
  clockFormat: ["auto", "12h", "24h"],
  clipboardHistoryDuration: ["P1D", "P1W", "P1M", "P3M", "P6M", "P1Y", "unlimited"]
}

var generalChoices = {
  windowMode: ["expanded", "compact"],
  escapeKeyBehavior: ["pop-back-or-close", "close-and-pop-to-root"],
  navigationBindings: ["emacs", "vim-motions"],
  rootSearchSensitivity: ["low", "medium", "high"]
}

function validConfigValue(key, value) {
  if (typeof value !== typeof configDefaults[key]) return false
  if (Array.isArray(configDefaults[key])) return Array.isArray(value) && value.every(function(v) { return typeof v === "string" })
  if (configChoices[key]) return configChoices[key].indexOf(value) >= 0
  if (typeof value === "number") return isFinite(value) && value > 0
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
    emojiMigrations: emojiMigrations,
    clipboardMigrations: clipboardMigrations,
    pushSearchHistory: pushSearchHistory,
    SEARCH_HISTORY_LIMIT: SEARCH_HISTORY_LIMIT,
    documents: documents,
    configDefaults: configDefaults,
    generalChoices: generalChoices,
    withConfigDefaults: withConfigDefaults
  }
}
