
var SUGGESTIONS_LIMIT = 6

var FALLBACKS = [
  { id: "fallback:google", title: "Search Google", icon: "", url: "https://www.google.com/search?q={query}" },
  { id: "fallback:duckduckgo", title: "Search DuckDuckGo", icon: "", url: "https://duckduckgo.com/?q={query}" },
  // unduck.link: the DDG frontend with the tracking stripped (added at the
  // user's request; same {query} contract as the others). [D]
  { id: "fallback:unduck", title: "Search unduck", icon: "", url: "https://unduck.link?q={query}" },
  { id: "fallback:agent", title: "Ask default agent", icon: "󰚩", subtitle: "New terminal session · Ctrl+Alt+Enter" }
]

// A typed web address opens in the default browser (Raycast does the same
// with a typed URL); it is never sent to a search engine. The row is not a
// stored command — the backend re-parses the current query — so its id is
// constant and lives outside the candidate/frecency namespace. [D]
var URL_ID = "url:open"

// TLDs that carry real web sites. Bare tokens need a listed TLD, which
// keeps file names out: "notes.md", "main.rs", "app.js" and "deploy.sh"
// are searches, not web sites (all four are real country TLDs). An
// explicit https:// bypasses the list, so any address still opens. Numeric
// endings (1.5, 12.3.4) are rejected by the host check, so calculator
// input never grows a URL row. [D]
var URL_TLDS = {
  com: 1, org: 1, net: 1, edu: 1, gov: 1, mil: 1, int: 1, info: 1, biz: 1,
  name: 1, pro: 1, mobi: 1, asia: 1, aero: 1, coop: 1, museum: 1, travel: 1,
  jobs: 1, cat: 1, tel: 1, xxx: 1, app: 1, dev: 1, page: 1, blog: 1,
  shop: 1, store: 1, site: 1, online: 1, tech: 1, xyz: 1, club: 1, live: 1,
  news: 1, world: 1, today: 1, life: 1, space: 1, website: 1, fun: 1,
  cloud: 1, digital: 1, design: 1, studio: 1, software: 1, systems: 1,
  codes: 1, tools: 1, run: 1, build: 1, works: 1, art: 1, email: 1,
  group: 1, network: 1, agency: 1, media: 1, social: 1, video: 1,
  music: 1, photo: 1, pics: 1, gallery: 1, wiki: 1, zone: 1, city: 1,
  town: 1, house: 1, home: 1, estate: 1, rentals: 1, farm: 1, garden: 1,
  kitchen: 1, recipes: 1, coffee: 1, beer: 1, wine: 1, food: 1, menu: 1,
  pizza: 1, restaurant: 1, bar: 1, pub: 1, cafe: 1, hotel: 1, holidays: 1,
  flights: 1, taxi: 1, cars: 1, auto: 1, bike: 1, boat: 1, yachts: 1,
  land: 1, local: 1, test: 1, onion: 1, lan: 1,
  // Country TLDs the launcher is likely to see. Deliberately not every
  // ccTLD: the ones that double as code file extensions (js, md, py, rs,
  // sh, ml, pm, mk, cc, ts…) stay out of the bare-token path.
  eu: 1, uk: 1, de: 1, fr: 1, nl: 1, be: 1, at: 1, ch: 1, it: 1, es: 1,
  pt: 1, se: 1, no: 1, fi: 1, dk: 1, ie: 1, is: 1, pl: 1, cz: 1, gr: 1,
  tr: 1, ru: 1, ua: 1, br: 1, ar: 1, cl: 1, co: 1, mx: 1, ca: 1, us: 1,
  au: 1, nz: 1, jp: 1, cn: 1, kr: 1, tw: 1, hk: 1, sg: 1, my: 1, th: 1,
  vn: 1, id: 1, ph: 1, in: 1, io: 1, ai: 1, tv: 1, me: 1, to: 1, gg: 1,
  je: 1, ly: 1
}

function webHost(host, explicit) {
  var h = String(host || "").toLowerCase()
  if (h === "localhost") return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    var parts = h.split(".")
    for (var i = 0; i < 4; i++) if (Number(parts[i]) > 255) return false
    return true
  }
  var labels = h.split(".")
  if (labels.length < 2) return false
  for (var j = 0; j < labels.length; j++) {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(labels[j])) return false
  }
  var tld = labels[labels.length - 1]
  if (!/^[a-z]{2,}$/.test(tld)) return false
  // An explicit scheme is the user saying "this is an address": take it.
  if (explicit) return true
  return Object.prototype.hasOwnProperty.call(URL_TLDS, tld)
}

// The typed query as a web address, or null. Accepts a bare domain
// (apple.com, www.example.co.uk), an optional :port and path/query/fragment,
// an IPv4 host, localhost, or an explicit http(s):// URL. Anything with
// whitespace is a search, not an address.
function typedUrl(query) {
  var s = String(query === undefined || query === null ? "" : query).trim()
  if (!s || /\s/.test(s)) return null
  var scheme = ""
  var m = /^(https?):\/\//i.exec(s)
  if (m) { scheme = m[1].toLowerCase(); s = s.slice(m[0].length) }
  else if (s.indexOf("://") >= 0) return null          // ftp://, oma-cast://, …
  var cut = s.search(/[\/?#]/)
  var authority = cut < 0 ? s : s.slice(0, cut)
  var tail = cut < 0 ? "" : s.slice(cut)
  if (!authority || authority.indexOf("@") >= 0) return null
  var host = authority
  var port = ""
  var pm = /^([^:]+)(:\d{1,5})$/.exec(authority)
  if (pm) {
    host = pm[1]
    port = pm[2]
    if (Number(port.slice(1)) > 65535) return null
  }
  if (!webHost(host, !!scheme)) return null
  return { url: (scheme || "https") + "://" + host + port + tail, display: host + port + tail }
}

// The "open this address" row shown above Results while the query is a URL.
function urlCandidate(info) {
  return {
    id: URL_ID, type: "command", kind: "url",
    title: info.display || info.url, subtitle: info.url, typeLabel: "Web",
    glyph: "\uf0ac",                     // nf-fa-globe
    url: info.url, rootSearch: { when: "searching" }
  }
}

// Web searches as root commands that push a dedicated search view with a
// full-width query bar (like Settings), instead of an inline argument pill.
// The pill forced the query into a ~200 px box after the root text; the
// pushed view gives the query the whole header. [D]
function webSearch(fallback, keywords) {
  return {
    id: "builtin:" + fallback.id.slice("fallback:".length) + "-search",
    title: fallback.title,
    subtitle: "Quicklink",
    glyph: fallback.icon,
    keywords: keywords,
    run: { push: { kind: "web-search", engine: fallback.id, title: fallback.title } }
  }
}

// The fallback behind a web-search engine id ("fallback:google", …).
function engineFallback(engine) {
  for (var i = 0; i < FALLBACKS.length; i++) if (FALLBACKS[i].id === engine) return FALLBACKS[i]
  return null
}

// The builtin command id that pushes a given engine (for frecency).
function builtinIdForEngine(engine) {
  return "builtin:" + String(engine || "").slice("fallback:".length) + "-search"
}

// One live row for a pushed web-search view: the engine as the title, the
// typed query as the subtitle. The id namespace ("web-search:*") is
// separate from the root fallback rows ("fallback:*") so the two never
// share selection or frecency. [D]
function webSearchCandidate(engine, query) {
  var f = engineFallback(engine)
  if (!f) return null
  var q = String(query === undefined || query === null ? "" : query).trim()
  return {
    id: "web-search:" + String(engine).slice("fallback:".length),
    type: "command",
    kind: "web-search",
    title: f.title,
    subtitle: q,
    typeLabel: "Search",
    glyph: f.icon,
    engine: engine,
    url: f.url,
    rootSearch: { when: "always" }
  }
}

// Sections for a pushed web-search view: a single row while the query is
// non-empty, nothing while it is empty (the empty state invites typing).
function webSearchSections(engine, query) {
  var q = String(query === undefined || query === null ? "" : query).trim()
  if (!q) return []
  var c = webSearchCandidate(engine, query)
  if (!c) return []
  return [{ id: "results", title: "", rows: [{ candidate: c, record: null }] }]
}

var BUILTINS = [
  webSearch(FALLBACKS[0], []),
  webSearch(FALLBACKS[1], ["ddg"]),
  webSearch(FALLBACKS[2], ["unduck"]),
  {
    id: "builtin:omarchy-menu",
    title: "Omarchy Menu",
    subtitle: "Open the original Omarchy menu",
    keywords: ["menu", "omarchy"],
    run: { summon: "omarchy.menu", payload: "{\"menu\":\"root\"}" },
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
  },
  {
    id: "builtin:settings",
    title: "Settings",
    subtitle: "Window, hotkey, search and calculator preferences",
    glyph: "",                     // nf-fa-cog
    keywords: ["settings", "preferences", "config", "options", "hotkey", "setup"],
    run: { push: { kind: "settings", title: "Settings" } },
    rootSearch: { when: "always" }
  },
  {
    id: "builtin:kill-process",
    title: "Kill Process",
    subtitle: "End a running program",
    glyph: "",                     // nf-fa-power-off
    keywords: ["kill", "process", "end", "terminate", "task manager", "taskkill"],
    run: { push: { kind: "processes", title: "Kill Process" } },
    platform: "windows",             // no process list on the shell side
    rootSearch: { when: "always" }
  },
  // The Settings app's own deep links (ms-settings:), one pushed view per
  // category. The launcher's preferences are `builtin:settings`; this one
  // hands over to Windows — themes, display, updates, privacy. [D]
  {
    id: "builtin:windows-settings",
    title: "Windows Settings",
    subtitle: "Open a Windows settings page",
    glyph: "",                     // nf-fa-windows
    keywords: ["windows settings", "system settings", "settings app", "windows", "personalization", "theme", "display", "bluetooth", "windows update"],
    run: { push: { kind: "windows-settings", title: "Windows Settings" } },
    platform: "windows",
    rootSearch: { when: "always" }
  },
  // Windows power actions (the Omarchy system actions' equivalent).
  // All three fire immediately once the destructive confirm (shutdown/
  // restart) or the row action (sleep) passes; the window closes first.
  // [D]
  {
    id: "builtin:shutdown",
    title: "Shut Down",
    subtitle: "Turn off this PC",
    glyph: "",                     // nf-fa-power-off
    keywords: ["shutdown", "power off", "turn off", "switch off"],
    run: { power: "shutdown" },
    rootSearch: { when: "always" }
  },
  {
    id: "builtin:restart",
    title: "Restart",
    subtitle: "Reboot this PC",
    glyph: "",                     // nf-fa-refresh
    keywords: ["restart", "reboot", "reboot pc"],
    run: { power: "restart" },
    rootSearch: { when: "always" }
  },
  {
    id: "builtin:sleep",
    title: "Sleep",
    subtitle: "Suspend this PC",
    glyph: "",                     // nf-fa-moon
    keywords: ["sleep", "suspend", "standby", "nap"],
    run: { power: "sleep" },
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
    glyph: def.glyph || "",
    glyphFont: def.glyph ? "" : "omarchy",
    run: def.run,
    arguments: def.arguments || [],
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

// Single-entry rank memo: the same query re-runs constantly without new
// typing — Ctrl+P filter toggles, view push/pop, action-panel open/close
// all re-search the current text. Hit = no DP at all. Keyed on the exact
// decorated-list reference, so any data/revision change misses safely.
// The backend's decorated memo keeps that reference stable for a full
// minute bucket, which is what makes repeats hit. [D]
var _rankMemo = { key: null, src: null, results: null, tail: null }
function rootSections(candidates, query, ctx, deps) {
  var q = String(query || "").trim()
  var filtered = ctx.filter && ctx.filter !== "all"
  var opts = rankOptions(ctx)

  // Repeat-query fast path FIRST (before the decorated/filter loops):
  // the backend memo keeps ctx.decorated reference-stable, so an exact
  // key+reference hit skips every loop and all DP. [D]
  var memoKey = (q && ctx.decorated) ? q + "\n" + String(ctx.filter || "all") : null
  if (memoKey && _rankMemo.key === memoKey && _rankMemo.src === ctx.decorated) {
    var sectionsHit = []
    if (ctx.calculation && !filtered) sectionsHit.push({ id: "calculator", title: "Calculator", rows: [{ candidate: calculatorCandidate(ctx.calculation), record: null }] })
    return sectionsHit.concat(_rankMemo.tail)
  }
  // A typed address is a command, so the Applications filter drops it; a
  // URL row depends only on the query, never on the clock. [D]
  var typed = q && ctx.filter !== "applications" ? typedUrl(q) : null
  // Memoized decorated list (the backend caches it per data revision +
  // time bucket): decorating clones every candidate and runs Math.exp per
  // row, so redoing it per keystroke dominates app search. [D]
  var decorated = []
  if (ctx.decorated) {
    // Backend memo (isEnabled pre-applied); the type filter still varies
    // per call, so apply it here. [D]
    for (var j = 0; j < ctx.decorated.length; j++) {
      if (passesFilter(ctx.decorated[j], ctx.filter)) decorated.push(ctx.decorated[j])
    }
  } else {
    for (var i = 0; i < candidates.length; i++) {
      if (!isEnabled(candidates[i], ctx) || !passesFilter(candidates[i], ctx.filter)) continue
      decorated.push(decorate(candidates[i], ctx, deps))
    }
  }
  var opts = rankOptions(ctx)

  if (q) {
    var searchable = decorated.filter(function(c) { return c.rootSearch.when !== "empty" })
    var results = deps.Ranker.rank(searchable, q, opts)
    var sections2 = []
    if (ctx.calculation && !filtered) sections2.push({ id: "calculator", title: "Calculator", rows: [{ candidate: calculatorCandidate(ctx.calculation), record: null }] })
    if (typed) sections2.push({ id: "url", title: "", rows: [{ candidate: urlCandidate(typed), record: null }] })
    if (results.length > 0) sections2.push({ id: "results", title: "Results", rows: results })
    if (!filtered) sections2.push({ id: "fallback-commands", title: "Use “" + q + "” with…", rows: fallbackRows(q) })
    // Only memoize the calc-free tail: a calculator row depends on the
    // clock and exchange-rate arrivals, never on the rank input. [D]
    if (memoKey) _rankMemo = { key: memoKey, src: ctx.decorated, results: results,
      tail: sections2.filter(function(s) { return s.id !== "calculator" }) }
    return sections2
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
  if (candidate.kind === "url") {
    return [
      { id: "open", title: "Open in Default Browser", shortcut: "↵", section: "primary", icon: "" },
      { id: "copy-url", title: "Copy URL", shortcut: "Ctrl Shift C", section: "copy", icon: "" }
    ]
  }
  var primary
  var list = []
  switch (candidate.kind) {
    case "app": primary = { id: "open", title: "Open Application", icon: "" }; break
    case "omarchy-action": primary = { id: "open", title: "Run", icon: "" }; break
    case "omarchy-menu":
    case "omarchy-link": primary = { id: "open", title: "Open Menu", icon: "" }; break
    case "fallback":
    case "web-search": primary = { id: "open", title: candidate.title, icon: "" }; break
    default: primary = { id: "open", title: "Open Command", icon: "" }
  }
  primary.shortcut = "↵"
  primary.section = "primary"
  list.push(primary)

  if (candidate.kind && candidate.kind.indexOf("omarchy-") === 0)
    list.push({ id: "open-in-omarchy-menu", title: "Open in Omarchy Menu", shortcut: "Ctrl ↵", section: "primary", icon: "" })
  if (candidate.kind === "fallback" || candidate.kind === "web-search") return list

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
  "omarchy:system.logout": { title: "Log Out", message: "Are you sure you want to log out?", primary: "Log Out" },
  // Windows equivalents; sleep needs no confirmation. [D]
  "builtin:shutdown": { title: "Shut Down", message: "Are you sure you want to shut down?", primary: "Shut Down" },
  "builtin:restart": { title: "Restart", message: "Are you sure you want to restart?", primary: "Restart" }
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
  if (c.kind === "web-search") {
    add("Query", c.subtitle)
    add("URL", c.url)
    add("ID", c.id)
    return rows
  }
  if (c.kind === "url") {
    add("URL", c.url)
    add("Type", "Web")
    add("ID", c.id)
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
    menuCandidate: menuCandidate,
    menuCandidates: menuCandidates,
    builtinCandidate: builtinCandidate,
    CALCULATOR_ID: CALCULATOR_ID,
    URL_ID: URL_ID,
    typedUrl: typedUrl,
    urlCandidate: urlCandidate,
    calculatorCandidate: calculatorCandidate,
    historyCandidate: historyCandidate,
    historySections: historySections,
    engineFallback: engineFallback,
    builtinIdForEngine: builtinIdForEngine,
    webSearchCandidate: webSearchCandidate,
    webSearchSections: webSearchSections,
    decorate: decorate,
    rootSections: rootSections,
    submenuSections: submenuSections,
    actionsFor: actionsFor,
    reorderFavorites: reorderFavorites,
    fallbackUrl: fallbackUrl
  }
}
