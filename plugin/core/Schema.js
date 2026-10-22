
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
  },
  {
    version: 2,
    name: "file-search",
    // New installs (from === 0) get file search on by default; an existing
    // v1 settings file stays opt-in. An explicit files block is preserved.
    up: function(doc, ctx) {
      var fresh = !!ctx && ctx.from === 0
      doc.files = Object.assign({
        enabled: fresh,
        root: "~",
        includeInRootSearch: true,
        followSymlinks: false
      }, doc.files && typeof doc.files === "object" && !Array.isArray(doc.files) ? doc.files : {})
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
  currencyRates: true
}

// File-search settings live in settings.json under `files`. New installs get
// enabled:true from migration 2; the fallback here is off until the store
// loads, so a missing/broken settings file never starts an index.
var filesDefaults = {
  enabled: false,
  root: "~",
  includeInRootSearch: true,
  followSymlinks: false
}

function withFilesDefaults(value) {
  var out = {}
  for (var key in filesDefaults) out[key] = filesDefaults[key]
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (var k in value) {
      if (filesDefaults[k] !== undefined && typeof value[k] === typeof filesDefaults[k]) out[k] = value[k]
    }
  }
  return out
}

function withConfigDefaults(value) {
  var out = {}
  for (var key in configDefaults) out[key] = configDefaults[key]
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (var k in value) {
      if (configDefaults[k] !== undefined && typeof value[k] === typeof configDefaults[k]) out[k] = value[k]
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
    withConfigDefaults: withConfigDefaults,
    filesDefaults: filesDefaults,
    withFilesDefaults: withFilesDefaults
  }
}
