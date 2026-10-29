
var SUGGESTIONS_LIMIT = 6

var FALLBACKS = [
  { id: "fallback:google", title: "Search Google", icon: "", url: "https://www.google.com/search?q={query}" },
  { id: "fallback:duckduckgo", title: "Search DuckDuckGo", icon: "", url: "https://duckduckgo.com/?q={query}" },
  { id: "fallback:agent", title: "Ask default agent", icon: "󰚩", subtitle: "New terminal session · Ctrl+Alt+Enter" }
]

// Web searches as root commands with an inline argument pill (ref 04 §2.2
// "inline argument inputs"; Raycast ships these as quicklinks) [D].
function webSearch(fallback, keywords) {
  return {
    id: "builtin:" + fallback.id.slice("fallback:".length) + "-search",
    title: fallback.title,
    subtitle: "Quicklink",
    glyph: fallback.icon,
    keywords: keywords,
    arguments: [{ name: "query", placeholder: "Query", required: true }],
    run: { url: fallback.url }
  }
}

var BUILTINS = [
  webSearch(FALLBACKS[0], []),
  webSearch(FALLBACKS[1], ["ddg"]),
  {
    id: "builtin:omarchy-menu",
    title: "Omarchy Menu",
    subtitle: "Open the original Omarchy menu",
    keywords: ["menu", "omarchy"],
    run: { summon: "omarchy.menu", payload: "{\"menu\":\"root\"}" },
    rootSearch: { when: "always" }
  },
  {
    id: "builtin:translate",
    title: "Translate",
    subtitle: "Text between languages",
    glyph: "󰗊",                     // nf-md-translate
    keywords: ["translate", "translation", "translator", "language", "languages"],
    sortHeuristic: -1,              // ahead of Omarchy's "Transcode" for a "trans" query
    run: { translate: true },
    rootSearch: { when: "always" }
  },
  {
    id: "builtin:calculator-history",
    title: "Calculator History",
    subtitle: "Calculator",
    glyph: "\uf1da",                     // nf-fa-history
    keywords: ["calculator", "calc", "math", "history", "conversions"],
    run: { push: { kind: "calculator-history", title: "Calculator History" } },
    rootSearch: { when: "always" }
  }
]

function words(value) {
  return String(value || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._:/\\-]+/g, " ").trim()
}

function appCandidate(entry) {
  var desktopId = String(entry.id || "")
  var keywords = []
  if (entry.genericName) keywords.push(String(entry.genericName))
  try {
    if (entry.keywords && entry.keywords.length) for (var i = 0; i < entry.keywords.length; i++) if (entry.keywords[i]) keywords.push(String(entry.keywords[i]))
  } catch (e) {}
  return {
    id: "app:" + desktopId,
    type: "application",
    kind: "app",
    title: String(entry.name || desktopId),
    subtitle: "",
    keywords: keywords,
    bundleId: desktopId,
    typeLabel: "Application",
    appId: desktopId,
    windowKeys: appWindowKeys(entry),
    iconName: String(entry.icon || ""),
    rootSearch: { when: "always" }
  }
}

// host+path of a web app URL, the shape both sides of the match reduce to.
// The trailing slash is dropped rather than forced: web apps disagree on it.
function webappKey(url) {
  return "webapp:" + String(url).replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "").toLowerCase()
}

// Keys a Hyprland window class can match for one desktop entry. No single
// one covers everything: StartupWMClass is the declared answer but often
// wrong or absent, the desktop id covers files named after their class, and
// web apps declare no class at all, so their URL is rebuilt from Exec.
function appWindowKeys(entry) {
  var keys = []
  function add(key) { if (key && keys.indexOf(key) < 0) keys.push(key) }
  add(String(entry.id || "").toLowerCase())
  add(String(entry.startupClass || "").toLowerCase())
  var exec = String(entry.execString || "")
  if (!exec && entry.command && entry.command.length) exec = Array.prototype.join.call(entry.command, " ")
  if (/--app=|webapp/.test(exec)) {
    var url = exec.match(/https?:\/\/[^\s"']+/)
    if (url) add(webappKey(url[0]))
  }
  return keys
}

// Keys for one window class. Chromium-based browsers build a web app's class
// off its URL and the profile directory: chrome-web.whatsapp.com__-Default ->
// web.whatsapp.com. The profile is whatever the user launched with ("Default",
// "Profile 1" -> Profile_1), so the last dash segment is dropped, not matched.
function windowClassKeys(windowClass) {
  var cls = String(windowClass || "").toLowerCase()
  var keys = [cls]
  var url = cls.replace(/^(brave|chrome|chromium)-/, "")
  if (url !== cls) keys.push(webappKey(url.replace(/-[^-]*$/, "").replace(/__/g, "/").replace(/_/g, "/")))
  return keys
}

// Address of the most recently focused window of an app, or "" when none is
// open. focusHistoryID 0 is the focused window, higher is older.
function findAppWindow(clients, keys) {
  if (!keys || !keys.length) return ""
  var best = null
  for (var i = 0; i < (clients || []).length; i++) {
    var c = clients[i]
    if (!c || !c.class || c.mapped === false) continue
    var matches = windowClassKeys(c.class).some(function(k) { return keys.indexOf(k) >= 0 })
    if (matches && (!best || c.focusHistoryID < best.focusHistoryID)) best = c
  }
  return best ? String(best.address) : ""
}

function menuCandidate(tree, item, guards, deps) {
  var crumbs = deps.OmarchyMenu.breadcrumb(tree, item.id)
  var keywords = item.aliases.map(words).filter(function(k) { return k })
  if (item.title && item.title !== item.label) keywords.push(item.title)
  if (item.description) keywords.push(item.description)
  return {
    id: "omarchy:" + item.id,
    type: "command",
    kind: item.kind === "action" ? "omarchy-action" : (item.kind === "link" ? "omarchy-link" : "omarchy-menu"),
    title: item.label,
    subtitle: crumbs.length > 0 ? crumbs.join(" › ") : "Omarchy",
    keywords: keywords,
    typeLabel: item.kind === "action" ? "Command" : "Menu",
    menuId: item.id,
    action: item.action,
    target: item.target,
    provider: item.provider,
    glyph: item.icon,
    glyphFont: item.iconFont,
    checked: !!(item.isCurrent || (guards && guards.checked && guards.checked[item.id])),
    disabled: !!(guards && guards.disabled && guards.disabled[item.id]),
    rootSearch: { when: crumbs.length === 0 ? "always" : "searching" }
  }
}

function builtinCandidate(def) {
  return {
    id: def.id,
    type: "command",
    kind: "builtin",
    title: def.title,
    subtitle: def.subtitle || "",
    keywords: def.keywords || [],
    typeLabel: "Command",
    glyph: def.glyph || "",
    glyphFont: def.glyph ? "" : "omarchy",
    run: def.run,
    arguments: def.arguments || [],
    sortHeuristic: def.sortHeuristic,
    rootSearch: def.rootSearch || { when: "always" }
  }
}

function menuCandidates(tree, guards, providerItems, deps) {
  var out = []
  for (var i = 0; i < tree.order.length; i++) {
    var item = tree.items[tree.order[i]]
    if (!deps.OmarchyMenu.isVisible(tree, guards, item.id)) continue
    out.push(menuCandidate(tree, item, guards, deps))
  }
  var extra = providerItems || {}
  for (var menuId in extra) {
    if (!tree.items[menuId] || !deps.OmarchyMenu.isVisible(tree, guards, menuId)) continue
    for (var j = 0; j < extra[menuId].length; j++) {
      var row = extra[menuId][j]
      var withTree = { items: tree.items, order: tree.order, children: tree.children }
      withTree.items = Object.create(tree.items)
      withTree.items[row.id] = row
      out.push(menuCandidate(withTree, row, guards, deps))
    }
  }
  return out
}

function decorate(candidate, ctx, deps) {
  var out = {}
  for (var k in candidate) out[k] = candidate[k]
  var settings = (ctx.commands && ctx.commands[candidate.id]) || {}
  var visits = (ctx.frecency && ctx.frecency[candidate.id]) || null
  out.alias = settings.alias ? String(settings.alias).toLowerCase() : ""
  out.favoriteOrder = typeof settings.favoriteOrder === "number" ? settings.favoriteOrder : null
  out.frecency = visits ? deps.Frecency.score(visits.anchor, ctx.nowMs / 1000) : 1
  out.openedAt = visits ? visits.openedAt : null
  out.searchTerms = visits && visits.searchTerms ? visits.searchTerms : []
  return out
}

function isEnabled(candidate, ctx) {
  var settings = ctx.commands && ctx.commands[candidate.id]
  return !(settings && settings.enabled === false)
}

function rankOptions(ctx) {
  return { sensitivity: ctx.sensitivity || "medium", nowMs: ctx.nowMs, fleaHits: ctx.fleaHits || null }
}

function fallbackRows(query) {
  return FALLBACKS.map(function(f) {
    return {
      candidate: {
        id: f.id, type: "command", kind: "fallback", title: f.title, subtitle: f.subtitle || query,
        typeLabel: "Fallback", glyph: f.icon, url: f.url, rootSearch: { when: "searching" }
      },
      record: null
    }
  })
}

// The inline Calculator row (SPEC §7.2 "Calculator" section) for a
// Calculator.evaluate() result. Not a stored candidate: its actions re-run
// the query.
var CALCULATOR_ID = "calculator:result"

function calculatorCandidate(calc) {
  return {
    id: CALCULATOR_ID, type: "command", kind: "calculator",
    title: calc.result, subtitle: calc.input, typeLabel: "Calculator",
    calcKind: calc.kind, calcInput: calc.input, calcResult: calc.result,
    calcInputCaption: calc.inputCaption || "", calcResultCaption: calc.resultCaption || "",
    rootSearch: { when: "searching" }
  }
}

// One saved calculation in Calculator History.
function historyCandidate(entry, nowMs) {
  return {
    id: "calculator-history:" + entry.id, type: "command", kind: "calculator-history",
    title: entry.result, subtitle: entry.query, typeLabel: relativeTime(entry.createdAt, nowMs),
    glyph: "\uf1ec", historyId: entry.id, rootSearch: { when: "always" }   // nf-fa-calculator
  }
}

function relativeTime(ms, nowMs) {
  var s = Math.max(0, Math.round((nowMs - ms) / 1000))
  if (s < 60) return "Just now"
  if (s < 3600) return Math.floor(s / 60) + " min ago"
  if (s < 86400) return Math.floor(s / 3600) + " h ago"
  var d = Math.floor(s / 86400)
  return d === 1 ? "Yesterday" : d + " days ago"
}

// Calculator History (ref 04 App. A calculator.history): newest first,
// filtered by the query, split into Today and Earlier. [I]
function historySections(history, query, nowMs, filter) {
  var list = filter(history, query)
  if (list.length === 0) return []
  var midnight = new Date(nowMs); midnight.setHours(0, 0, 0, 0)
  var todays = [], older = []
  for (var i = 0; i < list.length; i++) (list[i].createdAt >= midnight.getTime() ? todays : older).push({ candidate: historyCandidate(list[i], nowMs), record: null })
  var out = []
  if (todays.length) out.push({ id: "history-today", title: "Today", rows: todays })
  if (older.length) out.push({ id: "history-older", title: "Earlier", rows: older })
  return out
}

// The root dropdown (Ctrl+P, ref 04 §2.2 toggleFilter). Raycast's root has
// no dropdown; this one narrows root search by type. [D]
var FILTERS = [
  { id: "all", title: "All" },
  { id: "applications", title: "Applications" },
  { id: "commands", title: "Commands" }
]

function passesFilter(candidate, filter) {
  if (!filter || filter === "all") return true
  return (candidate.type === "application") === (filter === "applications")
}

function rootSections(candidates, query, ctx, deps) {
  var q = String(query || "").trim()
  var filtered = ctx.filter && ctx.filter !== "all"
  var decorated = []
  for (var i = 0; i < candidates.length; i++) {
    if (!isEnabled(candidates[i], ctx) || !passesFilter(candidates[i], ctx.filter)) continue
    decorated.push(decorate(candidates[i], ctx, deps))
  }
  var opts = rankOptions(ctx)

  if (q) {
    var searchable = decorated.filter(function(c) { return c.rootSearch.when !== "empty" })
    var results = deps.Ranker.rank(searchable, q, opts)
    var sections = []
    if (ctx.calculation && !filtered) sections.push({ id: "calculator", title: "Calculator", rows: [{ candidate: calculatorCandidate(ctx.calculation), record: null }] })
    if (results.length > 0) sections.push({ id: "results", title: "Results", rows: results })
    if (!filtered) sections.push({ id: "fallback-commands", title: "Use “" + q + "” with…", rows: fallbackRows(q) })
    return sections
  }

  var shown = decorated.filter(function(c) { return c.rootSearch.when !== "searching" || c.favoriteOrder !== null })
  var taken = {}
  var favorites = shown.filter(function(c) { return c.favoriteOrder !== null })
    .sort(function(a, b) { return a.favoriteOrder - b.favoriteOrder })
  favorites.forEach(function(c) { taken[c.id] = true })

  var suggestions = deps.Ranker.rank(decorated.filter(function(c) { return !taken[c.id] && c.frecency > 1 }), "", opts)
    .slice(0, SUGGESTIONS_LIMIT)
  suggestions.forEach(function(r) { taken[r.candidate.id] = true })

  var rest = shown.filter(function(c) { return !taken[c.id] })
  var commands = deps.Ranker.rank(rest.filter(function(c) { return c.type !== "application" }), "", opts)
  var apps = deps.Ranker.rank(rest.filter(function(c) { return c.type === "application" }), "", opts)

  var out = []
  if (favorites.length) out.push({ id: "favorites", title: "Favorites", rows: favorites.map(function(c) { return { candidate: c, record: null } }) })
  if (suggestions.length) out.push({ id: "suggestions", title: "Suggestions", rows: suggestions })
  if (commands.length) out.push({ id: "commands", title: "Commands", rows: commands })
  if (apps.length) out.push({ id: "apps", title: "Applications", rows: apps })
  return out
}

function submenuSections(candidates, menuId, query, ctx, deps) {
  var prefix = "omarchy:" + menuId + "."
  var q = String(query || "").trim()
  var inside = []
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i]
    if (c.id.indexOf(prefix) !== 0 || !isEnabled(c, ctx)) continue
    var rest = c.id.slice(prefix.length)
    if (!q && rest.indexOf(".") >= 0) continue
    inside.push(decorate(c, ctx, deps))
  }
  if (!q) return inside.length ? [{ id: "menu", title: "", rows: inside.map(function(c) { c.subtitle = ""; return { candidate: c, record: null } }) }] : []
  var ranked = deps.Ranker.rank(inside, q, rankOptions(ctx))
  return ranked.length ? [{ id: "results", title: "Results", rows: ranked }] : []
}

function actionsFor(candidate) {
  if (candidate.kind === "calculator" || candidate.kind === "calculator-history") {
    // ↵ copies, Ctrl ↵ pastes (SPEC §8 Calculator) [O]; delete keys are
    // the Windows `clear` shortcuts (ref 04 §2.8).
    var calc = [
      { id: "copy-answer", title: "Copy Answer", shortcut: "↵", section: "primary", icon: "" },
      { id: "paste-answer", title: "Paste Answer", shortcut: "Ctrl+↵", section: "primary", icon: "" },
      { id: "copy-question-answer", title: "Copy Question and Answer", shortcut: "Ctrl+Shift+C", section: "copy", icon: "" }
    ]
    if (candidate.kind === "calculator") {
      calc.push({ id: "open-history", title: "Open Calculator History", shortcut: "", section: "configure", icon: "" })
    } else {
      calc.push({ id: "delete-entry", title: "Delete Entry", shortcut: "Ctrl+D", section: "delete", icon: "" })
      calc.push({ id: "delete-all-entries", title: "Delete All Entries", shortcut: "Ctrl+Shift+D", section: "delete", icon: "" })
    }
    return calc
  }
  var primary
  var list = []
  switch (candidate.kind) {
    case "app": primary = { id: "open", title: "Open Application", icon: "" }; break
    case "omarchy-action": primary = { id: "open", title: "Run", icon: "" }; break
    case "omarchy-menu":
    case "omarchy-link": primary = { id: "open", title: "Open Menu", icon: "" }; break
    case "fallback": primary = { id: "open", title: candidate.title, icon: "" }; break
    default: primary = { id: "open", title: "Open Command", icon: "" }
  }
  primary.shortcut = "↵"
  primary.section = "primary"
  list.push(primary)

  if (candidate.kind && candidate.kind.indexOf("omarchy-") === 0)
    list.push({ id: "open-in-omarchy-menu", title: "Open in Omarchy Menu", shortcut: "Ctrl+↵", section: "primary", icon: "" })
  if (candidate.kind === "fallback") return list

  if (candidate.kind === "app") list.push({ id: "open-new", title: "Open New Window", shortcut: "Shift+↵", section: "primary", icon: "" })
  if (candidate.kind === "app") list.push({ id: "copy-id", title: "Copy Desktop ID", shortcut: "Ctrl+Shift+C", section: "copy", icon: "" })
  if (candidate.kind === "omarchy-action") list.push({ id: "copy-command", title: "Copy Command", shortcut: "Ctrl+Shift+C", section: "copy", icon: "" })

  if (candidate.favoriteOrder === null || candidate.favoriteOrder === undefined) {
    list.push({ id: "favorite-add", title: "Add to Favorites", shortcut: "Ctrl+Shift+F", section: "favorites", icon: "" })
  } else {
    list.push({ id: "favorite-remove", title: "Remove from Favorites", shortcut: "Ctrl+Shift+F", section: "favorites", icon: "" })
    list.push({ id: "favorite-up", title: "Move Up in Favorites", shortcut: "Ctrl+Alt+↑", section: "favorites", icon: "" })
    list.push({ id: "favorite-down", title: "Move Down in Favorites", shortcut: "Ctrl+Alt+↓", section: "favorites", icon: "" })
  }
  list.push({ id: "set-alias", title: candidate.alias ? "Change Alias" : "Set Alias", shortcut: "", section: "configure", icon: "" })
  if (candidate.alias) list.push({ id: "remove-alias", title: "Remove Alias", shortcut: "", section: "configure", icon: "" })
  if (candidate.frecency > 1) list.push({ id: "reset-ranking", title: "Reset Ranking", shortcut: "", section: "configure", icon: "" })
  list.push({ id: "disable", title: "Disable Command", shortcut: "Alt+Shift+D", section: "delete", icon: "" })
  return list
}

function reorderFavorites(commands, id, action) {
  var favs = []
  for (var key in commands) if (typeof commands[key].favoriteOrder === "number") favs.push({ id: key, order: commands[key].favoriteOrder })
  favs.sort(function(a, b) { return a.order - b.order })
  var ids = favs.map(function(f) { return f.id })
  var at = ids.indexOf(id)
  if (action === "favorite-add" && at < 0) ids.push(id)
  else if (action === "favorite-remove" && at >= 0) ids.splice(at, 1)
  else if (action === "favorite-up" && at > 0) { ids.splice(at, 1); ids.splice(at - 1, 0, id) }
  else if (action === "favorite-down" && at >= 0 && at < ids.length - 1) { ids.splice(at, 1); ids.splice(at + 1, 0, id) }
  var out = {}
  for (var i = 0; i < favs.length; i++) out[favs[i].id] = null
  for (var j = 0; j < ids.length; j++) out[ids[j]] = j
  return out
}

function fallbackUrl(candidate, query) {
  return String(candidate.url || "").replace("{query}", encodeURIComponent(String(query || "").trim()))
}

// {name} placeholders filled from argument values, URL-encoded.
function fillArguments(template, values) {
  return String(template || "").replace(/\{(\w+)\}/g, function(_, name) {
    return encodeURIComponent(String((values && values[name]) || "").trim())
  })
}

// Index of the first required argument left empty, or -1.
function missingArgument(defs, values) {
  for (var i = 0; i < (defs || []).length; i++) {
    if (defs[i].required && !String((values && values[defs[i].name]) || "").trim()) return i
  }
  return -1
}

// Destructive commands ask first, as Raycast's System commands do ("Are
// you sure you want to shut down?", ref 04 §1) [O]. Omarchy's own scripts
// don't confirm.
var CONFIRMATIONS = {
  "omarchy:system.shutdown": { title: "Shut Down", message: "Are you sure you want to shut down?", primary: "Shut Down" },
  "omarchy:system.reboot": { title: "Restart", message: "Are you sure you want to restart?", primary: "Restart" },
  "omarchy:system.logout": { title: "Log Out", message: "Are you sure you want to log out?", primary: "Log Out" }
}

function confirmationFor(id, action) {
  var c = action === "open" ? CONFIRMATIONS[id] : null
  if (action === "delete-all-entries") c = { title: "Delete All Entries", message: "This removes every calculation from Calculator History.", primary: "Delete All" }
  return c ? { title: c.title, message: c.message, primary: c.primary, destructive: true } : null
}

// The About panel (Ctrl+Shift+K, ref 04 §2.5 toggleAboutPanel): what a row
// is and where it comes from, as label/value pairs. [I]
function aboutFor(c, nowMs) {
  var rows = []
  function add(label, value) {
    if (value !== undefined && value !== null && String(value) !== "") rows.push({ label: label, value: String(value) })
  }
  if (c.kind === "calculator") {
    add("Question", c.calcInput)
    add("Answer", c.calcResult)
    add("Type", c.calcResultCaption)
    return rows
  }
  if (c.kind === "calculator-history") {
    add("Question", c.subtitle)
    add("Answer", c.title)
    add("Saved", c.typeLabel)
    return rows
  }
  add("Title", c.title)
  add("Type", c.typeLabel)
  if (c.kind !== "fallback") add("Location", c.subtitle)
  add("ID", c.id)
  if (c.kind === "app") add("Desktop Entry", c.appId + ".desktop")
  if (c.kind === "omarchy-action") add("Command", c.action)
  if (c.kind === "omarchy-link") add("Opens", c.target)
  add("URL", c.url || (c.run && c.run.url))
  add("Arguments", (c.arguments || []).map(function(a) { return a.name + (a.required ? "" : " (optional)") }).join(", "))
  add("Keywords", (c.keywords || []).join(", "))
  add("Alias", c.alias)
  if (typeof c.favoriteOrder === "number") add("Favorite", "#" + (c.favoriteOrder + 1))
  if (c.openedAt) add("Last Opened", relativeTime(c.openedAt, nowMs))
  if (c.frecency > 1) add("Frecency", Math.round(c.frecency * 10) / 10)
  return rows
}

if (typeof module !== "undefined") {
  module.exports = {
    SUGGESTIONS_LIMIT: SUGGESTIONS_LIMIT,
    FALLBACKS: FALLBACKS,
    BUILTINS: BUILTINS,
    FILTERS: FILTERS,
    fillArguments: fillArguments,
    missingArgument: missingArgument,
    confirmationFor: confirmationFor,
    aboutFor: aboutFor,
    appCandidate: appCandidate,
    appWindowKeys: appWindowKeys,
    windowClassKeys: windowClassKeys,
    findAppWindow: findAppWindow,
    menuCandidate: menuCandidate,
    menuCandidates: menuCandidates,
    builtinCandidate: builtinCandidate,
    CALCULATOR_ID: CALCULATOR_ID,
    calculatorCandidate: calculatorCandidate,
    historyCandidate: historyCandidate,
    historySections: historySections,
    decorate: decorate,
    rootSections: rootSections,
    submenuSections: submenuSections,
    actionsFor: actionsFor,
    reorderFavorites: reorderFavorites,
    fallbackUrl: fallbackUrl
  }
}
