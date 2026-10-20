// Persisted documents and their migrations. Each entry is one JSON file
// under $XDG_DATA_HOME/oma-cast/db/. Add a migration to the end of a list;
// never edit or reorder one that has shipped.

// General settings, using Raycast's key names and defaults
// (reference/04 §3, App. C). [O] values unless marked.
var settingsMigrations = [
  {
    version: 1,
    name: "general-settings",
    up: function(doc) {
      doc.general = {
        windowMode: "expanded",                   // expanded | compact
        showFavoritesInCompactMode: true,
        windowPresentationMode: "mouse-screen",   // mouse-screen | active-screen | primary-screen
        popToRootTimeout: 90,                     // seconds: 0,5,15,30,60,90,120,180
        escapeKeyBehavior: "pop-back-or-close",   // pop-back-or-close | close-and-pop-to-root
        navigationBindings: "emacs",              // emacs | vim-motions
        rootSearchSensitivity: "medium",          // low | medium | high; backend default [O], SPEC §7.3
        uiZoom: 1,
        theme: "omarchy"                          // [D] follow the active Omarchy theme
      }
      doc.commands = {}                           // commandId -> {enabled, alias, hotkey, favoriteOrder, fallbackOrder, meta}
      return doc
    }
  }
]

// Root-search ranking state (SPEC §6.4 `frecency`): per item an anchor in
// Unix seconds (Frecency.js), when it was last opened, and the queries that
// launched it. `searchHistory` backs ↑ in an empty root (SPEC §7.5).
var frecencyMigrations = [
  {
    version: 1,
    name: "frecency",
    up: function(doc) {
      doc.items = {}            // itemId -> {anchor, openedAt, searchTerms: [{term, at}]}
      doc.searchHistory = []    // newest first, unique, capped
      return doc
    }
  }
]

var SEARCH_HISTORY_LIMIT = 20   // [I]

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
  frecency: { file: "frecency.json", migrations: frecencyMigrations }
}

// General settings added after the v1 migration. They are filled in on read
// (withGeneralDefaults), so an additive setting needs no migration and cannot
// collide with another branch's migration number. [D]
var generalAdditions = {
  windowWidth: 750,                           // launcher card at uiZoom 1, px [O 750×475, SPEC §5.1]
  windowHeight: 475
}

// Inclusive bounds for numeric general settings. The card is also clamped to
// the screen when drawn, so these only reject nonsense. [D]
var generalRanges = {
  windowWidth: [500, 3000],
  windowHeight: [300, 2000]
}

function withGeneralDefaults(general) {
  var out = {}
  if (general && typeof general === "object" && !Array.isArray(general)) {
    for (var k in general) out[k] = general[k]
  }
  for (var key in generalAdditions) {
    if (typeof out[key] !== typeof generalAdditions[key]) out[key] = generalAdditions[key]
  }
  return out
}

// null when `value` is acceptable for general setting `key`, else the reason.
function checkGeneralValue(key, value) {
  var range = generalRanges[key]
  if (!range) return null
  if (typeof value !== "number" || !isFinite(value) || Math.round(value) !== value)
    return "Setting " + key + " must be a whole number"
  if (value < range[0] || value > range[1])
    return "Setting " + key + " must be between " + range[0] + " and " + range[1]
  return null
}

// Host flags in $XDG_CONFIG_HOME/oma-cast/config.json: user-editable and
// non-secret (SPEC §6.3). Not migrated; unknown keys are kept and ignored,
// missing ones fall back to these defaults.
var configDefaults = {
  logLevel: "info",                    // trace | debug | info | warning | error | fatal
  keepVisibleOnFocusLoss: false        // dev aid (keepMainWindowVisibleOnResignKey)
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
    pushSearchHistory: pushSearchHistory,
    SEARCH_HISTORY_LIMIT: SEARCH_HISTORY_LIMIT,
    documents: documents,
    generalAdditions: generalAdditions,
    generalRanges: generalRanges,
    withGeneralDefaults: withGeneralDefaults,
    checkGeneralValue: checkGeneralValue,
    configDefaults: configDefaults,
    withConfigDefaults: withConfigDefaults
  }
}
