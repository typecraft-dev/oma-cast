// Root search assembly (SPEC §7): candidates from each provider, metadata
// (alias, favourites, frecency), sections, and the actions each row offers.
// Ranking itself is Ranker.js; frecency maths is Frecency.js. Both are passed
// in as `deps` because a core module never imports another (QML + node).

var SUGGESTIONS_LIMIT = 6            // [I] SPEC §7.2 "N≈6"

// Fallback commands, in default fallback order [O names, D URLs].
var FALLBACKS = [
  { id: "fallback:google", title: "Search Google", icon: "", url: "https://www.google.com/search?q={query}" },
  { id: "fallback:duckduckgo", title: "Search DuckDuckGo", icon: "", url: "https://duckduckgo.com/?q={query}" }
]

// Built-in commands of our own (the declarative catalog; grows per phase).
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
    subtitle: "Find files and folders in your home folder",
    keywords: ["files", "folders", "find", "spotlight", "arquivos", "pastas"],
    glyph: "\uf002",                 // Nerd Font magnifier, drawn in the menu font
    run: { push: { kind: "files", title: "Search Files" } },
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
    bundleId: desktopId,               // matched only for queries with "." [O]
    typeLabel: "Application",
    appId: desktopId,
    iconName: String(entry.icon || ""),
    rootSearch: { when: "always" }
  }
}

// One Omarchy menu item. Top-level menus show on the empty root ("Commands");
// deeper items only while searching, or the root would list ~400 rows.
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
    rootSearch: def.rootSearch || { when: "always" }
  }
}

// All Omarchy rows that are visible under the current guard answers, plus
// rows from runtime providers (fonts, power profiles).
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

// Attach per-user metadata. Returns new objects; inputs stay untouched.
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
        id: f.id, type: "command", kind: "fallback", title: f.title, subtitle: query,
        typeLabel: "Fallback", glyph: f.icon, url: f.url, rootSearch: { when: "searching" }
      },
      record: null
    }
  })
}

// Sections for the root view (SPEC §7.2):
//   empty query: Favorites, Suggestions, Commands, Applications
//   query:       Results, Files [D], Use "<q>" with…
// ctx.files holds the file rows for the query (core/FileSearch.js), already ranked.
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
    if (results.length > 0) sections.push({ id: "results", title: "Results", rows: results })
    var files = ctx.files || []
    if (files.length > 0) sections.push({ id: "files", title: "Files", rows: files.map(function(c) { return { candidate: c, record: null } }) })
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

// A pushed Omarchy submenu: its visible children in menu order, or, while
// searching, every descendant ranked (the Omarchy menu searches the same way).
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
  // Unfiltered children all share the breadcrumb of the open menu; drop it.
  if (!q) return inside.length ? [{ id: "menu", title: "", rows: inside.map(function(c) { c.subtitle = ""; return { candidate: c, record: null } }) }] : []
  var ranked = deps.Ranker.rank(inside, q, rankOptions(ctx))
  return ranked.length ? [{ id: "results", title: "Results", rows: ranked }] : []
}

// Actions for a row (SPEC §10.2 action panel, §10.3 shortcuts). The first is
// primary (↵), the second secondary (Ctrl ↵).
function actionsFor(candidate) {
  if (candidate.kind === "file" || candidate.kind === "folder") return fileActions(candidate)
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

// Files and folders [D]: no favourites, aliases or disabling, since a row
// lives only as long as the query that found it.
function fileActions(candidate) {
  var folder = candidate.kind === "folder"
  return [
    { id: "open", title: folder ? "Open Folder" : "Open File", shortcut: "↵", section: "primary", icon: "" },
    { id: "reveal", title: "Show in Files", shortcut: "Ctrl ↵", section: "primary", icon: "" },
    { id: "open-terminal", title: folder ? "Open in Terminal" : "Open Folder in Terminal", shortcut: "Ctrl Shift ↵", section: "primary", icon: "" },
    { id: "copy-path", title: "Copy Path", shortcut: "Ctrl Shift C", section: "copy", icon: "" }
  ]
}

// Favourite ordering: returns the new {id: order} map for an action.
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
    decorate: decorate,
    rootSections: rootSections,
    submenuSections: submenuSections,
    actionsFor: actionsFor,
    fileActions: fileActions,
    reorderFavorites: reorderFavorites,
    fallbackUrl: fallbackUrl
  }
}
