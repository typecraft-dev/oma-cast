
var SUGGESTIONS_LIMIT = 6

var FALLBACKS = [
  { id: "fallback:google", title: "Search Google", icon: "", url: "https://www.google.com/search?q={query}" },
  { id: "fallback:duckduckgo", title: "Search DuckDuckGo", icon: "", url: "https://duckduckgo.com/?q={query}" },
  { id: "fallback:agent", title: "Ask default agent", icon: "󰚩", subtitle: "New terminal session · Ctrl+Alt+Enter" }
]

var BUILTINS = [
  {
    id: "builtin:omarchy-menu",
    title: "Omarchy Menu",
    subtitle: "Open the original Omarchy menu",
    keywords: ["menu", "omarchy"],
    run: { summon: "omarchy.menu", payload: "{\"menu\":\"root\"}" },
    rootSearch: { when: "always" }
  },
  {
    id: "builtin:search-files",
    title: "Search Files",
    subtitle: "Find files by name",
    keywords: ["file", "files", "find", "search"],
    iconName: "text-x-generic",
    run: { push: { kind: "files", title: "Search Files" } },
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
    iconName: String(entry.icon || ""),
    rootSearch: { when: "always" }
  }
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
    glyph: def.iconName ? "" : (def.glyph || ""),
    glyphFont: def.iconName ? "" : (def.glyph ? "" : "omarchy"),
    iconName: def.iconName || "",
    run: def.run,
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
  return { sensitivity: ctx.sensitivity || "medium", nowMs: ctx.nowMs }
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

// Sections for the root view (SPEC §7.2):
//   empty query: Favorites, Suggestions, Commands, Applications
//   query:       Results, Use "<q>" with…
// A root Files row is only shown when the query plausibly names the file:
// path-like queries pass; otherwise the query's characters must appear in
// order in the file name. This suppresses FFF's very permissive typo matches
// in the small root section (the files view still shows them).
function confidentFileMatch(candidate, query) {
  var q = String(query || "").toLowerCase()
  if (!q) return false
  if (q.indexOf("/") >= 0 || q.indexOf(".") >= 0 || q.indexOf("~") >= 0) return true
  var relative = String((candidate && (candidate.relativePath || candidate.path)) || "").toLowerCase()
  if (relative.indexOf(q) >= 0) return true
  var name = String((candidate && (candidate.fileName || candidate.title)) || "").toLowerCase()
  if (!name) return false
  var at = 0
  for (var i = 0; i < q.length; i++) {
    at = name.indexOf(q.charAt(i), at)
    if (at < 0) return false
    at++
  }
  return true
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

function rootSections(candidates, query, ctx, deps) {
  var q = String(query || "").trim()
  var decorated = []
  for (var i = 0; i < candidates.length; i++) {
    if (!isEnabled(candidates[i], ctx)) continue
    decorated.push(decorate(candidates[i], ctx, deps))
  }
  var opts = rankOptions(ctx)

  if (q) {
    var searchable = decorated.filter(function(c) { return c.rootSearch.when !== "empty" })
    var results = deps.Ranker.rank(searchable, q, opts)
    var sections = []
    if (ctx.calculation) sections.push({ id: "calculator", title: "Calculator", rows: [{ candidate: calculatorCandidate(ctx.calculation), record: null }] })
    if (results.length > 0) sections.push({ id: "results", title: "Results", rows: results })

    var fileRows = (ctx.fileRows || []).filter(function(c) { return c && c.kind && (c.kind === "file" || c.kind === "files-more") })
    var showFiles = !!ctx.includeFiles && q.length >= 3 && fileRows.length > 0
    if (showFiles && results.length > 0) {
      // If the user is clearly looking for an app/command, files are noise.
      var top = results[0].record
      if (top && (top.titleMatch === "exact" || top.titleMatch === "prefix")) showFiles = false
    }
    if (showFiles && !confidentFileMatch(fileRows[0], q)) showFiles = false
    if (showFiles)
      sections.push({ id: "files", title: "Files", rows: fileRows.map(function(c) { return { candidate: c, record: null } }) })

    sections.push({ id: "fallback-commands", title: "Use “" + q + "” with…", rows: fallbackRows(q) })
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

// The pushed "Search Files" view: the cached FFF rows, nothing else.
function filesSections(rows, query) {
  var list = (rows || []).filter(function(c) { return c && c.kind === "file" })
  if (list.length === 0) return []
  return [{
    id: "files",
    title: String(query || "").trim() ? "Files" : "",
    rows: list.map(function(c) { return { candidate: c, record: null } })
  }]
}

// Actions for a row (SPEC §10.2 action panel, §10.3 shortcuts). The first is
// primary (↵), the second secondary (Ctrl ↵).
function actionsFor(candidate) {
  if (candidate.kind === "files-more") {
    return [{ id: "show-all-files", title: "Show All Files", shortcut: "↵", section: "primary", icon: "\uf054" }]
  }
  if (candidate.kind === "file") {
    var fileList = [{ id: "open", title: "Open File", shortcut: "↵", section: "primary", icon: "\uf15b" }]
    if (candidate.isText) fileList.push({ id: "open-in-editor", title: "Open in Editor", shortcut: "Ctrl ↵", section: "primary", icon: "\uf044" })
    fileList.push({ id: "reveal", title: "Reveal in Files", shortcut: "", section: "primary", icon: "\uf07c" })
    fileList.push({ id: "copy-path", title: "Copy Path", shortcut: "Ctrl Shift C", section: "copy", icon: "\uf0c5" })
    fileList.push({ id: "copy-name", title: "Copy Name", shortcut: "", section: "copy", icon: "\uf0c5" })
    return fileList
  }
  if (candidate.kind === "calculator" || candidate.kind === "calculator-history") {
    // ↵ copies, Ctrl ↵ pastes (SPEC §8 Calculator) [O]; delete keys are
    // the Windows `clear` shortcuts (ref 04 §2.8).
    var calc = [
      { id: "copy-answer", title: "Copy Answer", shortcut: "↵", section: "primary", icon: "" },
      { id: "paste-answer", title: "Paste Answer", shortcut: "Ctrl ↵", section: "primary", icon: "" },
      { id: "copy-question-answer", title: "Copy Question and Answer", shortcut: "Ctrl Shift C", section: "copy", icon: "" }
    ]
    if (candidate.kind === "calculator") {
      calc.push({ id: "open-history", title: "Open Calculator History", shortcut: "", section: "configure", icon: "" })
    } else {
      calc.push({ id: "delete-entry", title: "Delete Entry", shortcut: "Ctrl D", section: "delete", icon: "" })
      calc.push({ id: "delete-all-entries", title: "Delete All Entries", shortcut: "Ctrl Shift D", section: "delete", icon: "" })
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
    list.push({ id: "open-in-omarchy-menu", title: "Open in Omarchy Menu", shortcut: "Ctrl ↵", section: "primary", icon: "" })
  if (candidate.kind === "fallback") return list

  if (candidate.kind === "app") list.push({ id: "copy-id", title: "Copy Desktop ID", shortcut: "Ctrl Shift C", section: "copy", icon: "" })
  if (candidate.kind === "omarchy-action") list.push({ id: "copy-command", title: "Copy Command", shortcut: "Ctrl Shift C", section: "copy", icon: "" })

  if (candidate.favoriteOrder === null || candidate.favoriteOrder === undefined) {
    list.push({ id: "favorite-add", title: "Add to Favorites", shortcut: "Ctrl Shift F", section: "favorites", icon: "" })
  } else {
    list.push({ id: "favorite-remove", title: "Remove from Favorites", shortcut: "Ctrl Shift F", section: "favorites", icon: "" })
    list.push({ id: "favorite-up", title: "Move Up in Favorites", shortcut: "Ctrl Alt ↑", section: "favorites", icon: "" })
    list.push({ id: "favorite-down", title: "Move Down in Favorites", shortcut: "Ctrl Alt ↓", section: "favorites", icon: "" })
  }
  list.push({ id: "set-alias", title: candidate.alias ? "Change Alias" : "Set Alias", shortcut: "", section: "configure", icon: "" })
  if (candidate.alias) list.push({ id: "remove-alias", title: "Remove Alias", shortcut: "", section: "configure", icon: "" })
  if (candidate.frecency > 1) list.push({ id: "reset-ranking", title: "Reset Ranking", shortcut: "", section: "configure", icon: "" })
  list.push({ id: "disable", title: "Disable Command", shortcut: "Alt Shift D", section: "delete", icon: "" })
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

if (typeof module !== "undefined") {
  module.exports = {
    SUGGESTIONS_LIMIT: SUGGESTIONS_LIMIT,
    FALLBACKS: FALLBACKS,
    BUILTINS: BUILTINS,
    appCandidate: appCandidate,
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
    filesSections: filesSections,
    actionsFor: actionsFor,
    reorderFavorites: reorderFavorites,
    fallbackUrl: fallbackUrl
  }
}
