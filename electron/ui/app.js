// oma-cast Windows UI — a px-for-px port of plugin/ui/LauncherWindow.qml
// and its children (ResultRow, ActionPanel, InfoPanel, Alert, KeyHint).
// Same state machine, same key handling, same geometry formulas; Qt Quick
// types map to DOM/CSS one-to-one. Backend and services run in-process via
// nodeIntegration, mirroring the single QML engine. [D]
"use strict"

var electron = require("electron")
var ipcRenderer = electron.ipcRenderer
var host = require("../src/host.js")
var surface = require("../src/theme/surface.js")
var themesLib = require("../src/themes.js")
var elideLeft = require("../src/text.js").elideLeft
var appsLib = require("../src/apps.js")
var fileIndexLib = require("../src/file-index.js")
var processesLib = require("../src/processes.js")
var backendLib = require("../src/backend.js")
var gateLib = require("../src/pointer-gate.js")
var Paths = require("../../plugin/core/Paths.js")
var Schema = require("../../plugin/core/Schema.js")
var RootSearch = require("../../plugin/core/RootSearch.js")
var fs = require("fs")
var path = require("path")

// Glyphs, identical literals to the QML (verified codepoint-for-codepoint).
var GLYPH_LOGO = ""        // omarchy font
var GLYPH_BACK = ""        // nf-fa-arrow_left, menu font
var GLYPH_TAG = ""        // nf-fa-tag
var GLYPH_HISTORY = ""        // nf-fa-history (builtin)
var GLYPH_FAIL = ""        // nf-fa-warning
var GLYPH_OK = ""        // nf-fa-check
var GLYPH_FAV = ""        // nf-fa-star

var GLYPH_APP = "\uf2d0"       // nf-fa-window-maximize (icon column fallback)

var DEFAULT_GENERAL = {
  uiZoom: 1, windowMode: "expanded", escapeKeyBehavior: "pop-back-or-close",
  popToRootTimeout: 90, navigationBindings: "emacs", rootSearchSensitivity: "medium"
}

// ---------------------------------------------------------------- wiring
var paths = Paths.resolveWindows(function(name) { return process.env[name] })
// Two theme roots: the bundled copy, and the user's place for themes
// (%APPDATA%\oma-cast\themes\<name>\colors.toml — drop one there and it
// shows up in the Theme setting row). [D]
var themeDir = path.join(__dirname, "..", "themes")
var themeRoots = { bundledDir: themeDir, userDir: path.join(paths.config, "themes") }

var config = Schema.withConfigDefaults(null)
try { config = Schema.withConfigDefaults(JSON.parse(fs.readFileSync(paths.configFile, "utf8"))) } catch (e) {}

var theme = null
function buildTheme() {
  var t = themesLib.resolve(config.theme, themeRoots)
  theme = surface.createTheme({
    colorsRaw: t.colorsRaw,
    shellRaw: t.shellRaw,
    gapsOut: config.gapsOut,
    cornerRadius: config.cornerRadius,
    fontFamily: config.fontFamily || "'JetBrainsMono Nerd Font', 'Cascadia Mono NF', 'CaskaydiaCove Nerd Font', Consolas, 'Segoe UI Symbol', monospace"
  })
}
buildTheme()

// The two snapshot services the pushed views read: the Kill Process list
// and the file index behind the Files section. The backend only uses them
// if they are handed over — without them Kill Process pushes an empty view
// and Files never appears. The tests inject them, which is why this was
// never caught off-Windows. [D]
var fileRoots = (config.fileSearchScopes && config.fileSearchScopes.length) ? config.fileSearchScopes : [paths.home]

var backend = backendLib.createBackend({
  paths: paths,
  apps: appsLib.createApps({ iconDir: path.join(paths.cache, "icons"), cachePath: path.join(paths.cache, "apps.json") }),
  fileIndex: fileIndexLib.createFileIndex({
    roots: fileRoots,
    home: paths.home,
    includeHidden: !!config.fileSearchIncludeHidden,
    provider: config.fileSearchProvider,
    cachePath: path.join(paths.cache, "file-index.json")
  }),
  // Everything launched from our own exe (main, GPU, renderer) stays out
  // of the list, as does this process.
  processes: processesLib.createProcesses({ ownPid: process.pid, excludePaths: [process.execPath] }),
  host: host,
  log: function(level, line) { console.log(line) }
})
backend.start()
config = backend.config

// A config.json change — the Theme row ↵, or an edit on disk — repaints
// without a reload: colours, font and the two geometry tokens all come
// from config. [D]
function themeSignature() {
  return [config.theme, config.fontFamily, config.gapsOut, config.cornerRadius].join("|")
}
var lastThemeSignature = themeSignature()
function retheme() {
  config = backend.config
  var sig = themeSignature()
  if (sig === lastThemeSignature) return
  lastThemeSignature = sig
  buildTheme()
  applyThemeVars()
  layout()
  renderAll()
}

var gate = gateLib.createPointerGate()

// ------------------------------------------------------------------ state
var W = {
  stack: [{ kind: "root", title: "oma-cast", query: "" }],
  query: "",
  selectedIndex: -1,
  selectedRow: null,
  rows: [],
  actions: [],
  actionPanelOpen: false,
  dropdownOpen: false,
  toastPanelOpen: false,
  aboutOpen: false,
  aboutRows: [],
  alert: null,
  toast: null,
  historyIndex: -1,
  rootFilter: "all",
  argDefs: [],
  argValues: {},
  argFocus: -1,
  argsForId: "",
  shown: false
}
var general = Object.assign({}, DEFAULT_GENERAL)
var popTimer = null
var toastTimer = null
var actionPanel = { filter: "", selectedIndex: 0 }
var dropdown = { filter: "", selectedIndex: 0 }
var toastPanel = { filter: "", selectedIndex: 0 }

function view() { return W.stack[W.stack.length - 1] }
function atRoot() { return W.stack.length === 1 }
function compact() { return general.windowMode === "compact" && atRoot() && !W.query }
function zoom() { return general.uiZoom > 0 ? general.uiZoom : 1 }
function vim() { return general.navigationBindings === "vim-motions" }
function actionPanelKeys() { return vim() ? "Alt K" : "Ctrl K" }
function px(v) { return Math.round(theme.space(v) * zoom()) }
function fontPx(key) { return Math.round(theme.font(key) * zoom()) }
function look() { return theme.look() }

var el = {}
;["window", "card", "header", "lead", "lead-glyph", "query", "caret", "pills", "filterbutton",
  "filter-title", "filter-caret", "header-hair", "loader", "body", "list", "empty", "empty-glyph",
  "empty-title", "empty-hint", "footer", "footer-left", "toast-icon", "toast-text", "toast-hint",
  "footer-right", "primary-title", "primary-hint", "footer-divider", "actions-title", "actions-hint",
  "actionpanel", "dropdown", "toastpanel", "infopanel", "info-title", "info-rows", "alert", "alert-box",
  "alert-title", "alert-message", "alert-ok", "alert-ok-title", "alert-cancel", "mirror"].forEach(function(id) {
  el[id.replace(/-([a-z])/g, function(m, c) { return c.toUpperCase() })] = document.getElementById(id)
})

// ------------------------------------------------------------ theme paint
function applyThemeVars() {
  if (typeof clearMeasureCache === "function") clearMeasureCache()
  var L = look()
  var root = document.documentElement.style
  root.setProperty("--bg", L.background)
  root.setProperty("--fg", L.foreground)
  root.setProperty("--accent", L.accent)
  root.setProperty("--sel-bg", L.selectedBackground)
  root.setProperty("--font-menu", L.fontFamily)
  root.setProperty("--radius-6", Math.max(theme.style.cornerRadius, px(6)) + "px")
  root.setProperty("--radius-8", Math.max(theme.style.cornerRadius, px(8)) + "px")
  root.setProperty("--radius-10", Math.max(theme.style.cornerRadius, px(10)) + "px")
  root.setProperty("--pill-bg", surface.alpha(L.foreground, 0.06))
  root.setProperty("--pill-bg-focused", surface.alpha(L.foreground, 0.12))
  root.setProperty("--pill-border", surface.alpha(L.foreground, 0.15))
  root.setProperty("--filter-bg", surface.alpha(L.foreground, 0.06))
  root.setProperty("--filter-bg-open", surface.alpha(L.foreground, 0.12))

  // BorderSurface card border: Border.surfaceSpec("menu", …). Solid → a CSS
  // border; gradient → the BorderOverlay ring (padding-box/border-box).
  var spec = theme.borderSpec
  var card = el.card
  card.classList.remove("gradient-border")
  if (surface.canUseNative(spec)) {
    card.style.borderWidth = [spec.widths.top, spec.widths.right, spec.widths.bottom, spec.widths.left].map(function(w) { return Math.round(w) + "px" }).join(" ")
    card.style.setProperty("--card-border-color", spec.color)
  } else {
    card.classList.add("gradient-border")
    card.style.borderWidth = [spec.widths.top, spec.widths.right, spec.widths.bottom, spec.widths.left].map(function(w) { return Math.round(w) + "px" }).join(" ")
    var g = spec.gradient
    var deg = g.angle ? g.angle : 180
    card.style.setProperty("--card-gradient", "linear-gradient(" + deg + "deg, " + g.colors.join(", ") + ")")
  }
}

// Card geometry: QML card width/height formulas with Style.gapsOut.
// Small-window mode: the OS window IS the card (only rounding needs
// alpha), so clamp to the display's available size — not the window —
// and pin the card at 0,0. The window starts at main's 760×500 estimate
// and is resized to fit via host.resizeWindow (guarded: the resize event
// that triggers re-enters layout with the same size). [D]
function layout() {
  if (typeof clearMeasureCache === "function") clearMeasureCache()
  var L = look()
  var gaps = theme.style.gapsOut
  var availW = (window.screen && window.screen.availWidth) || window.innerWidth
  var availH = (window.screen && window.screen.availHeight) || window.innerHeight
  var headerH = px(66)
  var footerH = px(42)
  var cardW = Math.min(px(750), availW - gaps * 2)
  var fullH = Math.min(px(475), availH - gaps * 2)
  var isCompact = compact()
  var cardH = isCompact ? headerH + theme.borderSpec.widths.top + theme.borderSpec.widths.bottom : fullH

  var c = el.card
  c.style.width = cardW + "px"
  c.style.height = cardH + "px"
  c.style.left = "0px"
  c.style.top = "0px"

  var bt = Math.round(theme.borderSpec.widths.top)
  var bb = Math.round(theme.borderSpec.widths.bottom)
  el.header.style.height = headerH + "px"
  el.header.style.top = bt + "px"
  el.footer.style.height = footerH + "px"
  el.footer.style.bottom = bb + "px"
  el.body.style.top = (bt + headerH) + "px"
  el.body.style.bottom = (bb + footerH) + "px"
  el.body.style.left = (Math.round(theme.borderSpec.widths.left) + px(8)) + "px"
  el.body.style.right = (Math.round(theme.borderSpec.widths.right) + px(8)) + "px"
  el.body.style.display = isCompact ? "none" : "block"
  el.footer.style.display = isCompact ? "none" : "block"
  el.headerHair.style.display = isCompact ? "none" : "block"
  el.loader.style.setProperty("--header-w", cardW + "px")
  el.loader.style.width = Math.round(cardW / 4) + "px"
  if (host && host.resizeWindow) {
    if (cardW !== layout.lastW || cardH !== layout.lastH) {
      layout.lastW = cardW
      layout.lastH = cardH
      try { host.resizeWindow(cardW, cardH) } catch (e) {}
    }
  }
}

// ------------------------------------------------------------------ header
// offsetWidth forces a synchronous layout: a full list rebuild used to pay
// one per row (accessories) plus several for the header, per keystroke.
// Cache by font+text (cleared on theme/zoom change) so repeated labels
// like "Application" measure once. [D]
var measureCache = {}
var measureCacheSize = 0
function measure(text, fontCss) {
  var key = fontCss + "\u0001" + text
  var hit = measureCache[key]
  if (hit !== undefined) return hit
  el.mirror.style.font = fontCss
  el.mirror.textContent = String(text || "")
  var w = el.mirror.offsetWidth
  if (measureCacheSize > 3000) { measureCache = {}; measureCacheSize = 0 }
  measureCache[key] = w
  measureCacheSize++
  return w
}
function clearMeasureCache() { measureCache = {}; measureCacheSize = 0 }

function placeholderText() {
  var v = view()
  if (v.kind === "alias") return "Type an alias, then press ↵"
  if (v.kind === "menu") return "Search " + v.title + "…"
  if (v.kind === "calculator-history") return "Search calculations…"
  if (v.kind === "settings") return "Search settings…"
  if (v.kind === "processes") return "Search processes…"
  if (v.kind === "windows-settings") return "Search settings pages…"
  if (v.kind === "web-search") return v.title + "…"
  if (v.kind === "quick-capture") return "Type a note, then press ↵ to capture…"
  if (v.kind === "todoist") return "Search tasks…"
  if (v.kind === "todoist-add") return "Type a task, then press ↵ to add…"
  if (v.kind === "setting-edit") return "Type a folder path, then press ↵"
  return "Search for apps and commands…"
}

function renderHeader() {
  var L = look()
  var isRoot = atRoot()

  // Lead: omarchy logo at root, fa-arrow_left inside a pushed view.
  el.leadGlyph.textContent = isRoot ? GLYPH_LOGO : GLYPH_BACK
  el.leadGlyph.style.fontFamily = isRoot ? "'omarchy'" : L.fontFamily
  el.leadGlyph.style.fontSize = px(isRoot ? 18 : 15) + "px"
  el.leadGlyph.style.color = isRoot ? L.accent : L.foreground
  el.leadGlyph.style.opacity = isRoot ? 1 : 0.7
  el.lead.style.width = px(28) + "px"
  el.lead.style.height = px(28) + "px"
  el.lead.style.top = "50%"
  el.lead.style.transform = "translateY(-50%)"

  // Pills first: the query width shrinks around them (WidthSizer).
  renderPills()

  var queryFontPx = Math.round(theme.font("heading") * 1.15 * zoom())
  var filterVisible = isRoot && !compact()
  el.filterbutton.style.display = filterVisible ? "flex" : "none"

  var queryX = px(18) + px(28) + px(12)
  var headerW = el.card.clientWidth
  var room = (filterVisible ? el.filterbutton.offsetLeft - px(12) : headerW - px(20)) - queryX
  var pillsVisible = el.pills.childElementCount > 0
  var pillsW = pillsVisible ? el.pills.offsetWidth : 0
  var queryFont = queryFontPx + "px " + L.fontFamily
  var full = W.query || (pillsVisible ? "" : placeholderText())
  var implicitW = measure(full, queryFont)
  var queryW = Math.min(implicitW, room - (pillsVisible ? pillsW + px(10) : 0))

  el.query.style.left = queryX + "px"
  el.query.style.width = Math.max(0, queryW) + "px"
  el.query.style.top = "50%"
  el.query.style.transform = "translateY(-50%)"
  el.query.style.fontSize = queryFontPx + "px"
  // Text.ElideLeft: when the query outgrows the room, cut the front and
  // keep the tail — on the logical string, so the order never flips.
  el.query.textContent = implicitW > queryW
    ? elideLeft(full, queryW, function(t) { return measure(t, queryFont) })
    : full
  el.query.style.opacity = W.query ? 1 : 0.45
  el.pills.style.left = (queryX + (W.query ? queryW : 0) + px(10)) + "px"

  // Caret: blinks on the 530 ms half-periods of the QML SequentialAnimation.
  var caretVisible = W.shown && !W.actionPanelOpen && W.argFocus < 0
  el.caret.style.display = caretVisible ? "block" : "none"
  el.caret.style.height = (queryFontPx + theme.space(4)) + "px"
  var contentW = W.query ? Math.min(measure(W.query, queryFont), queryW) : 0
  el.caret.style.left = (queryX + (W.query ? contentW + theme.space(1) : 0)) + "px"
  el.caret.style.top = "50%"
  el.caret.style.transform = "translateY(-50%)"

  // Filter button contents.
  var filters = RootSearch.FILTERS.filter(function(f) { return f.id === W.rootFilter })
  el.filterTitle.textContent = (filters[0] || RootSearch.FILTERS[0]).title
  el.filterTitle.className = W.rootFilter === "all" ? "all" : ""
  el.filterbutton.classList.toggle("open", W.dropdownOpen)

  // Loader: only while guards/providers refresh.
  el.loader.classList.toggle("visible", backend.loading && W.shown)
}

function renderPills() {
  var L = look()
  el.pills.innerHTML = ""
  if (!W.argDefs.length || view().kind === "alias" || view().kind === "setting-edit") return
  W.argDefs.forEach(function(def, index) {
    var value = W.argValues[def.name] || ""
    var focused = W.argFocus === index
    var pill = document.createElement("div")
    pill.className = "pill" + (focused ? " focused" : "")
    pill.style.height = px(28) + "px"
    var label = document.createElement("span")
    var pillFont = fontPx("body") + "px " + L.fontFamily
    var text = value || (def.placeholder + (def.required ? "" : " (optional)"))
    var textW = measure(text, pillFont)
    var pillW = Math.min(px(220), textW + px(20))
    pill.style.width = pillW + "px"
    // The text area: clientWidth (border-box) minus the 10 px side padding.
    var areaW = Math.max(0, pillW - px(20) - 2)
    label.textContent = textW > areaW ? elideLeft(text, areaW, function(t) { return measure(t, pillFont) }) : text
    label.style.opacity = value ? 1 : 0.5
    pill.appendChild(label)
    if (focused) {
      var caret = document.createElement("div")
      caret.className = "pill-caret"
      caret.style.height = (fontPx("body") + theme.space(2)) + "px"
      caret.style.top = "50%"
      caret.style.transform = "translateY(-50%)"
      // clientWidth is 0 while the pill is detached — use the width just set.
      var lw = value ? Math.min(measure(label.textContent, pillFont), areaW) : 0
      caret.style.left = (px(10) + lw + theme.space(1)) + "px"
      pill.appendChild(caret)
    }
    pill.addEventListener("mousedown", function(e) {
      e.preventDefault()
      W.argFocus = index
      renderAll()
    })
    el.pills.appendChild(pill)
  })
  // exact x set in renderHeader once queryW is known
}
