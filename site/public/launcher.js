// omacast in the browser. The search, ranking, calculator, emoji and history logic is omacast's own
// core/*.js (bundled by site/build.mjs as window.OmacastCore); this file is the part that is QML on the
// desktop: a backend over localStorage (after Backend.qml) and the window (after ui/LauncherWindow.qml).
// Nothing here launches anything: actions that need a desktop say what they would have done.
(function () {
  "use strict"
  var Core = window.OmacastCore
  if (!Core) return
  var Ranker = Core.Ranker, Frecency = Core.Frecency, OmarchyMenu = Core.OmarchyMenu, RootSearch = Core.RootSearch
  var Calculator = Core.Calculator, Emoji = Core.Emoji, Themes = Core.Themes, ClipboardHistory = Core.ClipboardHistory, Schema = Core.Schema
  var Keybindings = Core.Keybindings
  var deps = { Ranker: Ranker, Frecency: Frecency, OmarchyMenu: OmarchyMenu }

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] }) }
  function $(sel, root) { return (root || document).querySelector(sel) }

  // Icons are Nerd Font glyphs, as in the launcher (site/public/demo/symbols.woff2 holds the ones used).
  var GLYPH = { back: "\uf060", tag: "\uf02b", warn: "\uf071", ok: "\uf00c", star: "\uf005", generic: "\uf1b2" }
  var LOGO = '<svg viewBox="0 0 30 30" aria-hidden="true"><path d="M1 0H29V1H30V29H29V30H1V29H0V1H1Z" fill="#242936"/>' +
    '<path d="M3 3H27V27H18V24H24V6H6V24H16V27H3Z" fill="#1A9298"/><path d="M8 8H22V13H19V11H11V19H19V17H22V22H8Z" fill="#E08E1D"/>' +
    '<path d="M13 13H17V17H13Z" fill="#E74553"/></svg>'

  // ------------------------------------------------------------ sample desktop

  // Colours from Omarchy's own themes (themes/<name>/colors.toml).
  var THEMES = [
    { slug: "catppuccin", bg: "#1e1e2e", bg2: "#313244", fg: "#cdd6f4", dim: "#6c7086", accent: "#89b4fa", sel: "#45475a" },
    { slug: "tokyo-night", bg: "#1a1b26", bg2: "#24283b", fg: "#a9b1d6", dim: "#565f89", accent: "#7aa2f7", sel: "#292e42" },
    { slug: "gruvbox", bg: "#282828", bg2: "#3c3836", fg: "#d4be98", dim: "#7c6f64", accent: "#7daea3", sel: "#504945" },
    { slug: "rose-pine", bg: "#faf4ed", bg2: "#f2e9e1", fg: "#575279", dim: "#9893a5", accent: "#56949f", sel: "#dfdad9" },
    { slug: "everforest", bg: "#2d353b", bg2: "#343f44", fg: "#d3c6aa", dim: "#859289", accent: "#7fbbb3", sel: "#3d484d" },
    { slug: "kanagawa", bg: "#1f1f28", bg2: "#223249", fg: "#dcd7ba", dim: "#727169", accent: "#7e9cd8", sel: "#363646" },
    { slug: "nord", bg: "#2e3440", bg2: "#3b4252", fg: "#d8dee9", dim: "#667080", accent: "#81a1c1", sel: "#434c5e" },
    { slug: "retro-82", bg: "#05182e", bg2: "#0a2540", fg: "#f6dcac", dim: "#3f8f8a", accent: "#faa968", sel: "#134e5a" },
    { slug: "flexoki-light", bg: "#fffcf0", bg2: "#e6e4d9", fg: "#100f0f", dim: "#878580", accent: "#205ea6", sel: "#cecdc3" }
  ]
  THEMES.forEach(function (t) { t.name = Themes.displayName(t.slug); t.image = "" })
  THEMES.sort(function (a, b) { return a.name.localeCompare(b.name) })   // as Omarchy's picker lists them

  // Stand-ins for the desktop entries a real install reads from the system.
  var APPS = [
    { id: "firefox", name: "Firefox", generic: "Web Browser", keywords: ["Internet", "WWW"], glyph: "\uf269" },
    { id: "chromium", name: "Chromium", generic: "Web Browser", keywords: ["Internet", "Chrome"], glyph: "\uf268" },
    { id: "com.mitchellh.ghostty", name: "Ghostty", generic: "Terminal", keywords: ["shell", "prompt", "console"], glyph: "\uf120" },
    { id: "nvim", name: "Neovim", generic: "Text Editor", keywords: ["vim", "editor", "code"], glyph: "\uf121", execString: "nvim %F" },
    { id: "org.gnome.Nautilus", name: "Files", generic: "File Manager", keywords: ["folder", "nautilus", "explorer"], glyph: "\uf07b", execString: "nautilus --new-window %U" },
    { id: "obsidian", name: "Obsidian", generic: "Notes", keywords: ["markdown", "notes", "knowledge"], glyph: "\uf02d", execString: "/usr/bin/obsidian %U" },
    { id: "signal-desktop", name: "Signal", generic: "Messenger", keywords: ["chat", "messages"], glyph: "\uf086", execString: "signal-desktop -- %u" },
    { id: "spotify", name: "Spotify", generic: "Music Player", keywords: ["music", "audio", "podcasts"], glyph: "\uf1bc", execString: "spotify %U" },
    { id: "com.obsproject.Studio", name: "OBS Studio", generic: "Streaming and Recording", keywords: ["record", "stream", "screencast"], glyph: "\uf03d" },
    { id: "org.kde.kdenlive", name: "Kdenlive", generic: "Video Editor", keywords: ["video", "edit", "film"], glyph: "\uf008" },
    { id: "pinta", name: "Pinta", generic: "Image Editor", keywords: ["paint", "draw", "picture"], glyph: "\uf1fc" },
    { id: "libreoffice-writer", name: "LibreOffice Writer", generic: "Word Processor", keywords: ["document", "word", "office"], glyph: "\uf0f6" },
    { id: "libreoffice-calc", name: "LibreOffice Calc", generic: "Spreadsheet", keywords: ["sheet", "excel", "office"], glyph: "\uf0ce" },
    { id: "1password", name: "1Password", generic: "Password Manager", keywords: ["passwords", "secrets", "vault"], glyph: "\uf084", execString: "/opt/1Password/1password %U" },
    { id: "typora", name: "Typora", generic: "Markdown Editor", keywords: ["markdown", "writing"], glyph: "\uf040" },
    { id: "imv", name: "Image Viewer", generic: "Image Viewer", keywords: ["picture", "photo", "imv"], glyph: "\uf03e" },
    { id: "mpv", name: "Media Player", generic: "Multimedia Player", keywords: ["video", "movie", "mpv"], glyph: "\uf04b" },
    { id: "org.gnome.Evince", name: "Document Viewer", generic: "PDF Viewer", keywords: ["pdf", "evince", "reader"], glyph: "\uf1c1" },
    { id: "btop", name: "Activity", generic: "System Monitor", keywords: ["btop", "processes", "cpu", "memory"], glyph: "\uf080" },
    { id: "lazydocker", name: "Docker", generic: "Container Manager", keywords: ["lazydocker", "containers"], glyph: "\uf1b3", execString: "omarchy-launch-tui lazydocker" },
    { id: "org.gnome.Calculator", name: "Calculator", generic: "Calculator", keywords: ["math", "arithmetic"], glyph: "\uf1ec" },
    { id: "localsend", name: "LocalSend", generic: "File Sharing", keywords: ["share", "send", "airdrop"], glyph: "\uf1d8" },
    { id: "steam", name: "Steam", generic: "Game Store", keywords: ["games", "gaming"], glyph: "\uf1b6" },
    { id: "GitHub", name: "GitHub", generic: "Web App", keywords: ["git", "code", "repositories"], glyph: "\uf09b" },
    { id: "YouTube", name: "YouTube", generic: "Web App", keywords: ["video", "watch"], glyph: "\uf16a", execString: "omarchy-launch-webapp https://youtube.com/" },
    { id: "WhatsApp", name: "WhatsApp", generic: "Web App", keywords: ["chat", "messages"], glyph: "\uf232", execString: "omarchy-launch-webapp https://web.whatsapp.com/" },
    { id: "HEY", name: "HEY", generic: "Web App", keywords: ["email", "mail", "calendar"], glyph: "\uf0e0", execString: "omarchy-launch-webapp https://app.hey.com" },
    { id: "Basecamp", name: "Basecamp", generic: "Web App", keywords: ["projects", "team"], glyph: "\uf0c0" }
  ]

  // Omarchy's default app binds, as its keybindings menu caches them, and the
  // defaults its terminal and browser launchers resolve to on this pretend machine.
  var BIND_RECORDS = [
    "SUPER + RETURN → Terminal\texec\tomarchy-launch-terminal",
    "SUPER SHIFT + RETURN → Browser\texec\tomarchy-launch-browser",
    "SUPER SHIFT + F → File manager\texec\tomarchy-launch-nautilus",
    "SUPER SHIFT + N → Editor\texec\tomarchy-launch-editor",
    "SUPER SHIFT + M → Music\texec\tomarchy-launch-spotify",
    "SUPER SHIFT + G → Signal\texec\tomarchy-launch-signal",
    "SUPER SHIFT + O → Obsidian\texec\tomarchy-launch-or-focus '^obsidian$' 'uwsm-app -- obsidian'",
    "SUPER SHIFT + SLASH → Passwords\texec\tomarchy-launch-1password",
    "SUPER SHIFT + D → Docker\texec\tomarchy-launch-tui 'lazydocker'",
    "SUPER SHIFT + E → Email\texec\tomarchy-launch-webapp 'https://app.hey.com'",
    "SUPER SHIFT + Y → YouTube\texec\tomarchy-launch-webapp 'https://youtube.com/'",
    "SUPER SHIFT ALT + G → WhatsApp\texec\tomarchy-launch-or-focus-webapp 'WhatsApp' 'https://web.whatsapp.com/'"
  ].join("\n")
  var BIND_DEFAULTS = { terminal: "com.mitchellh.ghostty.desktop", browser: "firefox.desktop", editor: "nvim" }

  // What Omarchy's menu providers would print on a machine: "label\tvalue\tcurrent" per line.
  var PROVIDER_OUTPUT = {
    "fonts": ["JetBrainsMono Nerd Font", "CaskaydiaMono Nerd Font", "FiraCode Nerd Font", "Hack Nerd Font", "MesloLGS Nerd Font"]
      .map(function (f) { return f + "\t" + f + "\tJetBrainsMono Nerd Font" }).join("\n"),
    "kernels": ["linux", "linux-lts", "linux-zen"].map(function (k) { return k + "\t" + k + "\tlinux" }).join("\n")
  }

  function hash(text) {
    var h = 0x811c9dc5
    for (var i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
    return h.toString(16)
  }

  // A page cannot read what you copied elsewhere, so Clipboard History starts with a few copies.
  function seedClipboard(now) {
    var entries = []
    var seeds = [
      { text: "https://omarchy.org", app: "Chromium", ago: 26 * 3600e3 },
      { text: "hl.bind(\"SUPER + CTRL + SPACE\", hl.dsp.global(\"omacast:emoji\"), { description = \"Emoji picker\", submap_universal = true })", app: "Neovim", ago: 5 * 3600e3 },
      { path: "/img/themes.webp", bytes: 61234, app: "Screenshot", ago: 3 * 3600e3 },
      { text: "#e74553", app: "Neovim", ago: 95 * 60e3 },
      { text: "https://github.com/typecraft-dev/oma-cast", app: "Chromium", ago: 40 * 60e3 },
      { text: "omarchy plugin add https://github.com/typecraft-dev/oma-cast", app: "Ghostty", ago: 4 * 60e3 }
    ]
    seeds.forEach(function (s, i) {
      var obs = s.path
        ? { type: "image", path: s.path, mime: "image/webp", bytes: s.bytes, hash: hash(s.path) }
        : { type: "text", text: s.text, bytes: s.text.length, hash: hash(s.text) }
      obs.source = { name: s.app, appId: s.app.toLowerCase() }
      entries = ClipboardHistory.add(entries, obs, now - s.ago, "seed" + i, false).entries
    })
    return entries
  }

  // Minutes east of UTC for every zone the calculator knows (services/CalculatorData.qml asks bash).
  function zoneOffsets() {
    var out = {}, now = new Date()
    Calculator.zoneList().forEach(function (zone) {
      try {
        var name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(now)
          .filter(function (p) { return p.type === "timeZoneName" })[0].value
        var m = /GMT(?:([+-])(\d\d):?(\d\d)?)?/.exec(name)
        out[zone] = m && m[1] ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0
      } catch (e) {}
    })
    return out
  }

  // ------------------------------------------------------------ stores

  function safeStorage() {
    try { var s = window.localStorage; s.getItem("omacast-demo:probe"); return s } catch (e) { return null }
  }

  // One JSON document, as services/JsonStore.qml keeps one file. No storage: memory only.
  function Store(name, initial, storage) {
    this.key = "omacast-demo:" + name
    this.initial = initial
    this.storage = storage
    var doc = null
    if (storage) try { doc = JSON.parse(storage.getItem(this.key)) } catch (e) {}
    this.doc = initial()
    if (doc && typeof doc === "object") for (var k in this.doc) if (doc[k] !== undefined && typeof doc[k] === typeof this.doc[k]) this.doc[k] = doc[k]
  }
  Store.prototype.update = function (mutate) {
    mutate(this.doc)
    if (this.storage) try { this.storage.setItem(this.key, JSON.stringify(this.doc)) } catch (e) {}
  }
  Store.prototype.reset = function () {
    this.doc = this.initial()
    if (this.storage) try { this.storage.removeItem(this.key) } catch (e) {}
  }

  // ------------------------------------------------------------ backend (after Backend.qml)

  function Backend(data, options) {
    var storage = options && options.persist ? safeStorage() : null
    this.data = data
    this.stores = {
      settings: new Store("settings", function () { return { general: Schema.settingsMigrations[0].up({}).general, commands: {} } }, storage),
      frecency: new Store("frecency", function () { return { items: {}, searchHistory: [] } }, storage),
      calculator: new Store("calculator", function () { return { history: [] } }, storage),
      emoji: new Store("emoji", function () { return { items: {}, pinned: [], skinTone: "none" } }, storage),
      clipboard: new Store("clipboard", function () { return { entries: seedClipboard(Date.now()) } }, storage),
      theme: new Store("theme", function () { return { current: THEMES[0].slug } }, storage)
    }
    this.onTheme = null
    this.zones = zoneOffsets()
    var hour12 = false
    try { hour12 = !!new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 } catch (e) {}
    this.hour12 = hour12
    this.candidates = []
    this.byId = {}
    this.rebuildCandidates()
  }

  Backend.prototype.reset = function () {
    for (var name in this.stores) this.stores[name].reset()
    if (this.onTheme) this.onTheme(this.theme())
  }

  Backend.prototype.rebuildCandidates = function () {
    var hotkeys = Keybindings.appHotkeys(Keybindings.parseRecords(BIND_RECORDS), APPS, BIND_DEFAULTS)
    var next = APPS.map(function (app) {
      var c = RootSearch.appCandidate({ id: app.id, name: app.name, genericName: app.generic, keywords: app.keywords })
      c.glyph = app.glyph
      if (hotkeys[app.id]) c.hotkey = Keybindings.formatChord(hotkeys[app.id])
      return c
    })
    next = next.concat(RootSearch.menuCandidates(this.data.tree, this.data.guards, this.data.providerItems, deps))
    RootSearch.BUILTINS.forEach(function (def) { next.push(RootSearch.builtinCandidate(def)) })
    var superseded = {}
    RootSearch.BUILTINS.forEach(function (d) { (d.supersedes || []).forEach(function (id) { superseded[id] = true }) })
    next = next.filter(function (c) { return !superseded[c.id] })
    var byId = {}
    next.forEach(function (c) {
      // Omarchy's own icon font (its logo and brand marks) is not ours to ship.
      if (c.glyphFont === "omarchy") { c.glyph = GLYPH.generic; c.glyphFont = "" }
      byId[c.id] = c
    })
    this.candidates = next
    this.byId = byId
  }

  Backend.prototype.context = function () {
    return {
      commands: this.stores.settings.doc.commands, frecency: this.stores.frecency.doc.items,
      nowMs: Date.now(), sensitivity: this.stores.settings.doc.general.rootSearchSensitivity
    }
  }

  Backend.prototype.decorated = function (id) {
    var c = this.byId[id]
    return c ? RootSearch.decorate(c, this.context(), deps) : null
  }

  Backend.prototype.calculate = function (query) {
    try {
      return Calculator.evaluate(query, {
        nowMs: Date.now(), localOffset: -new Date().getTimezoneOffset(), hour12: this.hour12,
        rates: this.data.rates, zones: this.zones, remToPxRate: Schema.configDefaults.remToPxRate, workHoursPerDay: Schema.configDefaults.workHoursPerDay
      })
    } catch (e) { return null }
  }

  Backend.prototype.theme = function () {
    var slug = this.stores.theme.doc.current
    return THEMES.filter(function (t) { return t.slug === slug })[0] || THEMES[0]
  }
  Backend.prototype.themeEntry = function (id) {
    var slug = String(id).replace(/^theme:/, "")
    return THEMES.filter(function (t) { return t.slug === slug })[0] || null
  }

  Backend.prototype.emojiState = function () {
    var doc = this.stores.emoji.doc, nowSec = Date.now() / 1000
    var recent = Object.keys(doc.items).sort(function (a, b) { return Frecency.score(doc.items[b].anchor, nowSec) - Frecency.score(doc.items[a].anchor, nowSec) })
    return { pinned: doc.pinned, recent: recent, tone: doc.skinTone, filter: "all" }
  }
  Backend.prototype.emojiCandidate = function (id) {
    var symbol = String(id).slice("emoji:".length)
    var entry = this.data.emoji.list.filter(function (e) { return e.symbol === symbol })[0]
    if (!entry) throw new Error("Unknown emoji " + id)
    var state = this.emojiState()
    return { entry: entry, candidate: Emoji.candidate(entry, state.tone, state.pinned) }
  }

  Backend.prototype.clipboardEntry = function (id) {
    var key = String(id).replace(/^clipboard:/, "")
    return this.stores.clipboard.doc.entries.filter(function (e) { return e.id === key })[0] || null
  }
  Backend.prototype.updateClipboard = function (mutate) {
    this.stores.clipboard.update(function (doc) {
      doc.entries = ClipboardHistory.prune(mutate(doc.entries), Date.now(), Schema.configDefaults.clipboardHistoryDuration).entries
    })
  }

  // The browser's clipboard, and the watcher's job: every copy lands in Clipboard History.
  Backend.prototype.copyText = function (text, own) {
    text = String(text)
    try { navigator.clipboard.writeText(text).catch(function () {}) } catch (e) {}
    var now = Date.now(), h = hash(text)
    var obs = { type: "text", text: text, bytes: text.length, hash: h, source: { name: "omacast", appId: "omacast" } }
    var id = now.toString(36) + Math.floor(Math.random() * 1e6).toString(36)
    this.updateClipboard(function (entries) { return ClipboardHistory.add(entries, obs, now, id, !!own).entries })
  }

  Backend.prototype.recordVisit = function (id, query) {
    this.stores.frecency.update(function (doc) {
      doc.items[id] = Frecency.recordVisit(doc.items[id] || null, Date.now(), query || "")
      if (query) doc.searchHistory = Schema.pushSearchHistory(doc.searchHistory, query)
    })
  }

  Backend.prototype.updateCommand = function (id, mutator) {
    this.stores.settings.update(function (doc) {
      var next = mutator(JSON.parse(JSON.stringify(doc.commands[id] || {})))
      var empty = true
      for (var k in next) if (next[k] !== null && next[k] !== undefined && next[k] !== "") empty = false
      if (empty) delete doc.commands[id]
      else doc.commands[id] = next
    })
  }

  Backend.prototype.updateCommandSettings = function (data) {
    var id = String(data && data.commandId || "")
    if (!this.byId[id]) throw new Error("Unknown command " + id)
    var commands = this.stores.settings.doc.commands, self = this
    if (data.alias !== undefined && data.alias !== null) {
      var alias = String(data.alias).trim().toLowerCase()
      if (/\s/.test(alias)) throw new Error("An alias cannot contain spaces")
      for (var other in commands) {
        if (other !== id && commands[other].alias === alias && alias) throw new Error("Alias “" + alias + "” is already used by " + ((self.byId[other] || {}).title || other))
      }
    }
    this.updateCommand(id, function (s) {
      if (data.alias !== undefined) { if (data.alias) s.alias = String(data.alias).trim().toLowerCase(); else delete s.alias }
      if (data.enabled !== undefined) { if (data.enabled === false) s.enabled = false; else delete s.enabled }
      return s
    })
  }

  // rootSearch.search
  Backend.prototype.search = function (data) {
    var query = String(data.query || ""), view = data.view, ctx = this.context(), sections
    if (view.kind === "menu") sections = RootSearch.submenuSections(this.candidates, view.menuId, query, ctx, deps)
    else if (view.kind === "theme") sections = Themes.sections(THEMES, this.stores.theme.doc.current, query)
    else if (view.kind === "clipboard") sections = ClipboardHistory.sections(this.stores.clipboard.doc.entries, query, String(data.filter || "all"), ctx.nowMs)
    else if (view.kind === "emoji") return Emoji.sections(this.data.emoji.list, query, this.emojiState())
    else if (view.kind === "calculator-history") sections = RootSearch.historySections(this.stores.calculator.doc.history, query, ctx.nowMs, Calculator.filterHistory)
    else {
      ctx.filter = String(data.filter || "all")
      if (query.trim() && ctx.filter === "all") ctx.calculation = this.calculate(query)
      sections = RootSearch.rootSections(this.candidates, query, ctx, deps)
    }
    return sections.map(function (s) { return { id: s.id, title: s.title, rows: s.rows.map(function (r) { return r.candidate }) } })
  }

  // rootSearch.getActions
  Backend.prototype.getActions = function (id) {
    if (id === RootSearch.CALCULATOR_ID) return RootSearch.actionsFor({ kind: "calculator" })
    if (id.indexOf("calculator-history:") === 0) return RootSearch.actionsFor({ kind: "calculator-history" })
    if (id.indexOf("theme:") === 0) return Themes.actionsFor(this.themeEntry(id), this.stores.theme.doc.current)
    if (id.indexOf("clipboard:") === 0) return ClipboardHistory.actionsFor(this.clipboardEntry(id), "")
    if (id.indexOf("emoji:") === 0) return Emoji.actionsFor(this.emojiCandidate(id).candidate, this.emojiState().tone)
    var candidate = this.decorated(id)
    if (candidate) return RootSearch.actionsFor(candidate)
    var fallback = RootSearch.FALLBACKS.filter(function (f) { return f.id === id })[0]
    if (!fallback) throw new Error("Unknown command " + id)
    return RootSearch.actionsFor({ kind: "fallback", title: fallback.title })
  }

  // rootSearch.getItemInfo
  Backend.prototype.getItemInfo = function (id, query) {
    var nowMs = Date.now()
    if (id === RootSearch.CALCULATOR_ID) {
      var calc = this.calculate(query)
      return calc ? RootSearch.aboutFor(RootSearch.calculatorCandidate(calc), nowMs) : []
    }
    if (id.indexOf("calculator-history:") === 0) {
      var entry = this.historyEntry(id)
      return entry ? RootSearch.aboutFor(RootSearch.historyCandidate(entry, nowMs), nowMs) : []
    }
    if (id.indexOf("clipboard:") === 0) return ClipboardHistory.detail(this.clipboardEntry(id)).info
    if (id.indexOf("theme:") === 0) return Themes.detail(this.themeEntry(id), this.stores.theme.doc.current).info
    if (id.indexOf("emoji:") === 0) { var found = this.emojiCandidate(id); return Emoji.aboutFor(found.candidate, found.entry) }
    var candidate = this.decorated(id)
    if (candidate) return RootSearch.aboutFor(candidate, nowMs)
    var f = RootSearch.FALLBACKS.filter(function (x) { return x.id === id })[0]
    if (!f) throw new Error("Unknown command " + id)
    return RootSearch.aboutFor({ id: f.id, kind: "fallback", title: f.title, typeLabel: "Fallback", url: f.url }, nowMs)
  }

  Backend.prototype.historyEntry = function (id) {
    var key = String(id).slice("calculator-history:".length)
    return this.stores.calculator.doc.history.filter(function (h) { return h.id === key })[0] || null
  }

  // The split view's right-hand pane.
  Backend.prototype.getDetail = function (id) {
    if (id.indexOf("clipboard:") === 0) { var e = this.clipboardEntry(id); return e ? ClipboardHistory.detail(e) : null }
    if (id.indexOf("theme:") === 0) {
      var t = this.themeEntry(id)
      if (!t) return null
      var d = Themes.detail(t, this.stores.theme.doc.current)
      d.theme = t
      return d
    }
    return null
  }

  function openTab(url) { try { window.open(url, "_blank", "noopener") } catch (e) {} }

  // What a desktop would have done, said instead of done. `hud` is Omarchy's OSD on the desktop.
  function would(text) { return { close: true, hud: text } }

  Backend.prototype.calculatorAction = function (action, entry, historyId) {
    var self = this
    function save() {
      if (historyId) return
      self.stores.calculator.update(function (doc) {
        doc.history = Calculator.pushHistory(doc.history, { id: String(Date.now()), query: entry.query, result: entry.result, copy: entry.copy, kind: entry.kind }, Date.now())
      })
    }
    switch (action) {
      case "open": case "copy-answer": save(); this.copyText(entry.copy); return would("Copied to Clipboard")
      case "paste-answer": save(); this.copyText(entry.copy); return would("Copied. On a desktop this pastes into the app you were in")
      case "copy-question-answer": save(); this.copyText(entry.query + " = " + entry.result); return would("Copied to Clipboard")
      case "open-history": return { push: { kind: "calculator-history", title: "Calculator History" } }
      case "delete-entry":
        this.stores.calculator.update(function (doc) { doc.history = doc.history.filter(function (h) { return h.id !== historyId }) })
        return { toast: { style: "success", title: "Entry deleted" } }
      case "delete-all-entries":
        this.stores.calculator.update(function (doc) { doc.history = [] })
        return { toast: { style: "success", title: "History cleared" } }
    }
    throw new Error("Unknown action " + action)
  }

  Backend.prototype.emojiAction = function (action, id, query) {
    var found = this.emojiCandidate(id), e = found.entry, c = found.candidate, store = this.stores.emoji
    function uprank() { store.update(function (doc) { doc.items[e.symbol] = Frecency.recordVisit(doc.items[e.symbol] || null, Date.now(), query || "") }) }
    switch (action) {
      case "open": case "paste": uprank(); this.copyText(c.symbol); return would("Copied " + c.symbol + ". On a desktop this pastes into the app you were in")
      case "copy": uprank(); this.copyText(c.symbol); return would("Copied " + c.symbol + " to Clipboard")
      case "copy-name": this.copyText(c.title); return would("Copied to Clipboard")
      case "pin": case "unpin":
        store.update(function (doc) {
          doc.pinned = doc.pinned.filter(function (s) { return s !== e.symbol })
          if (action === "pin") doc.pinned.push(e.symbol)
        })
        return { toast: { style: "success", title: action === "pin" ? "Pinned" : "Unpinned" } }
      case "remove-recent":
        store.update(function (doc) { delete doc.items[e.symbol] })
        return { toast: { style: "success", title: "Removed from Recently Used" } }
      case "clear-recent":
        store.update(function (doc) { doc.items = {} })
        return { toast: { style: "success", title: "Recently Used cleared" } }
    }
    if (action.indexOf("tone:") === 0 && Emoji.TONES.some(function (t) { return t.id === action.slice(5) })) {
      store.update(function (doc) { doc.skinTone = action.slice(5) })
      return { toast: { style: "success", title: "Skin tone set" } }
    }
    throw new Error("Unknown action " + action)
  }

  Backend.prototype.clipboardAction = function (action, id, confirmed) {
    if (action === "delete-all-entries") {
      if (!confirmed) return { confirm: { title: "Delete All Entries", message: "This removes every unpinned entry from Clipboard History. Pinned entries are kept.", primary: "Delete All", destructive: true } }
      this.updateClipboard(function (entries) { return entries.filter(function (e) { return typeof e.pinned === "number" }) })
      return { toast: { style: "success", title: "History cleared" } }
    }
    var e = this.clipboardEntry(id)
    if (!e) throw new Error("No such clipboard entry")
    switch (action) {
      case "open": case "paste":
        if (e.type === "image") return would("On a desktop this pastes the image into the app you were in")
        this.copyText(e.text, true)
        return would("Copied. On a desktop this pastes into the app you were in")
      case "copy":
        if (e.type === "image") return would("On a desktop this copies the image")
        this.copyText(e.text, true)
        return would("Copied to Clipboard")
      case "open-link":
        var target = String(e.text || "").trim()
        if (!/^https?:\/\//i.test(target)) return would("On a desktop this opens " + target)
        openTab(target)
        return would("Opened in a new tab")
      case "pin": case "unpin":
        this.updateClipboard(function (entries) { return ClipboardHistory.setPinned(entries, e.id, action === "pin") })
        return { toast: { style: "success", title: action === "pin" ? "Pinned" : "Unpinned" } }
      case "delete-entry":
        this.updateClipboard(function (entries) { return entries.filter(function (x) { return x.id !== e.id }) })
        return { toast: { style: "success", title: "Entry deleted" } }
    }
    throw new Error("Unknown action " + action)
  }

  Backend.prototype.openMenu = function (item) {
    if (item.provider && !OmarchyMenu.PROVIDERS[item.provider]) return would("On Omarchy this opens the " + item.label + " menu")
    return { push: { kind: "menu", menuId: item.id, title: item.label } }
  }

  // rootSearch.performAction
  Backend.prototype.performAction = function (data) {
    var id = String(data.id || ""), action = String(data.action || "open"), query = String(data.query || "").trim()
    if (id.indexOf("theme:") === 0) {
      var theme = this.themeEntry(id)
      if (!theme) throw new Error("No such theme")
      this.stores.theme.update(function (doc) { doc.current = theme.slug })
      if (this.onTheme) this.onTheme(theme)
      return { toast: { style: "success", title: "Theme set to " + theme.name } }
    }
    if (id.indexOf("clipboard:") === 0) return this.clipboardAction(action, id, !!data.confirmed)
    if (!data.confirmed) {
      var confirm = RootSearch.confirmationFor(id, action)
      if (confirm) return { confirm: confirm }
    }
    var fallback = RootSearch.FALLBACKS.filter(function (f) { return f.id === id })[0]
    if (fallback) { openTab(RootSearch.fallbackUrl(fallback, query)); return would("Opened in a new tab") }
    if (id === RootSearch.CALCULATOR_ID) {
      var calc = this.calculate(query)
      if (!calc) throw new Error("Nothing to calculate")
      return this.calculatorAction(action, { query: calc.input, result: calc.result, copy: calc.copy, kind: calc.kind }, "")
    }
    if (id.indexOf("calculator-history:") === 0) {
      var entry = this.historyEntry(id)
      if (!entry) throw new Error("No such history entry")
      return this.calculatorAction(action, entry, entry.id)
    }
    if (id.indexOf("emoji:") === 0) {
      if (action === "clear-recent" && !data.confirmed) return { confirm: { title: "Clear Recently Used", message: "This forgets every emoji you have pasted or copied.", primary: "Clear", destructive: true } }
      return this.emojiAction(action, id, query)
    }

    var candidate = this.decorated(id), self = this
    if (!candidate) throw new Error("Unknown command " + id)
    if (action === "open") {
      switch (candidate.kind) {
        case "app":
          this.recordVisit(id, query)
          return would("On Omarchy this opens " + candidate.title)
        case "omarchy-action":
          if (candidate.disabled) return { toast: { style: "failure", title: candidate.title + " is already set up" } }
          this.recordVisit(id, query)
          return would("On Omarchy this runs " + candidate.action)
        case "omarchy-menu":
          this.recordVisit(id, query)
          return this.openMenu(this.data.tree.items[candidate.menuId] || { id: candidate.menuId, label: candidate.title, provider: candidate.provider })
        case "omarchy-link":
          this.recordVisit(id, query)
          var target = this.data.tree.items[candidate.target]
          if (!target) return { toast: { style: "failure", title: "Menu " + candidate.target + " not found" } }
          return this.openMenu(target)
        case "builtin":
          if (candidate.run.url) {
            var values = data.arguments || {}
            var missing = RootSearch.missingArgument(candidate.arguments, values)
            if (missing >= 0) throw new Error("Type a " + candidate.arguments[missing].placeholder.toLowerCase() + " first")
            this.recordVisit(id, query)
            openTab(RootSearch.fillArguments(candidate.run.url, values))
            return would("Opened in a new tab")
          }
          this.recordVisit(id, query)
          if (candidate.run.push) return { push: candidate.run.push }
          return would("On Omarchy this opens the Omarchy menu")
      }
      throw new Error("Cannot open " + id)
    }
    switch (action) {
      case "open-new":
        this.recordVisit(id, query)
        return would("On Omarchy this opens a new " + candidate.title + " window")
      case "open-in-omarchy-menu": return would("On Omarchy this opens the Omarchy menu here")
      case "copy-command": case "copy-id":
        this.copyText(action === "copy-id" ? candidate.appId + ".desktop" : candidate.action)
        return would("Copied to Clipboard")
      case "favorite-add": case "favorite-remove": case "favorite-up": case "favorite-down":
        var orders = RootSearch.reorderFavorites(this.stores.settings.doc.commands, id, action)
        this.stores.settings.update(function (doc) {
          for (var key in orders) {
            var e = doc.commands[key] || {}
            if (orders[key] === null) delete e.favoriteOrder
            else e.favoriteOrder = orders[key]
            if (Object.keys(e).length === 0) delete doc.commands[key]
            else doc.commands[key] = e
          }
        })
        return { toast: { style: "success", title: { "favorite-add": "Added to Favorites", "favorite-remove": "Removed from Favorites", "favorite-up": "Moved Up", "favorite-down": "Moved Down" }[action] } }
      case "set-alias": return { push: { kind: "alias", commandId: id, title: "Alias for " + candidate.title, value: candidate.alias } }
      case "remove-alias":
        this.updateCommand(id, function (s) { delete s.alias; return s })
        return { toast: { style: "success", title: "Alias removed" } }
      case "reset-ranking":
        this.stores.frecency.update(function (doc) { delete doc.items[id] })
        return { toast: { style: "success", title: "Ranking reset" } }
      case "disable":
        this.updateCommand(id, function (s) { s.enabled = false; return s })
        return { toast: { style: "success", title: candidate.title + " disabled", actions: [
          { id: "undo", title: "Undo", done: candidate.title + " enabled", run: function () { self.updateCommandSettings({ commandId: id, enabled: true }) } }
        ] } }
    }
    throw new Error("Unknown action " + action)
  }

  // ------------------------------------------------------------ the window (after ui/LauncherWindow.qml)

  var SHELL =
    '<div class="oc-head">' +
      '<button class="oc-lead" type="button" tabindex="-1" aria-label="Back"></button>' +
      '<div class="oc-field"></div>' +
      '<button class="oc-filter" type="button" tabindex="-1"></button>' +
    '</div>' +
    '<div class="oc-body"><div class="oc-list" role="listbox"></div><div class="oc-detail"></div><div class="oc-empty"></div></div>' +
    '<div class="oc-foot">' +
      '<button class="oc-status" type="button" tabindex="-1"><span class="oc-status-icon"></span><span class="oc-status-text"></span></button>' +
      '<span class="oc-hints"><button class="oc-primary" type="button" tabindex="-1"></button><i></i>' +
      '<button class="oc-more" type="button" tabindex="-1">Actions <kbd>Ctrl</kbd><kbd>K</kbd></button></span>' +
    '</div>' +
    '<div class="oc-layer"></div>'

  function Launcher(root, backend, options) {
    options = options || {}
    this.root = root
    this.backend = backend
    this.interactive = options.interactive !== false
    this.onDismiss = options.onDismiss || function () {}
    root.classList.add("oc")
    root.classList.toggle("oc-auto", !this.interactive)
    root.innerHTML = SHELL
    this.el = {
      lead: $(".oc-lead", root), field: $(".oc-field", root), filter: $(".oc-filter", root), body: $(".oc-body", root),
      list: $(".oc-list", root), detail: $(".oc-detail", root), empty: $(".oc-empty", root),
      status: $(".oc-status", root), statusIcon: $(".oc-status-icon", root), statusText: $(".oc-status-text", root),
      hints: $(".oc-hints", root), primary: $(".oc-primary", root), more: $(".oc-more", root), layer: $(".oc-layer", root)
    }
    // A real field when someone is typing; plain text while the demo types for itself.
    this.el.field.innerHTML = this.interactive
      ? '<input class="oc-input" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Search"><span class="oc-pills"></span>'
      : '<span class="oc-input"></span><span class="oc-caret"></span><span class="oc-pills"></span>'
    this.el.input = $(".oc-input", root)
    this.el.pills = $(".oc-pills", root)

    this.stack = [{ kind: "root", title: "omacast", query: "" }]
    this.query = ""
    this.rows = []
    this.selectedIndex = -1
    this.selectedColumn = 0
    this.selectedRow = null
    this.popup = null          // the action panel, the filter dropdown or a toast's actions
    this.toast = null
    this.toastTimer = 0
    this.aboutRows = null
    this.alert = null
    this.historyIndex = -1
    this.rootFilter = "all"
    this.clipboardFilter = "all"
    this.argDefs = []
    this.argValues = {}
    this.argFocus = -1
    this.argsForId = ""
    this.pointer = ""

    var self = this
    backend.onTheme = function (theme) { self.applyTheme(theme) }
    this.applyTheme(backend.theme())
    if (this.interactive) this.listen()
    this.rebuild(true)
  }

  Launcher.prototype.applyTheme = function (t) {
    var s = this.root.style
    s.setProperty("--m-bg", t.bg); s.setProperty("--m-bg2", t.bg2); s.setProperty("--m-fg", t.fg)
    s.setProperty("--m-dim", t.dim); s.setProperty("--m-accent", t.accent); s.setProperty("--m-sel", t.sel)
    if (this.root.parentNode && this.root.parentNode.style) this.root.parentNode.style.setProperty("--m-accent", t.accent)
  }

  Object.defineProperty(Launcher.prototype, "view", { get: function () { return this.stack[this.stack.length - 1] } })
  Object.defineProperty(Launcher.prototype, "atRoot", { get: function () { return this.stack.length === 1 } })
  Object.defineProperty(Launcher.prototype, "grid", { get: function () { return this.view.kind === "emoji" } })
  Object.defineProperty(Launcher.prototype, "clipboardView", { get: function () { return this.view.kind === "clipboard" } })
  Object.defineProperty(Launcher.prototype, "splitView", { get: function () { return this.clipboardView || this.view.kind === "theme" } })
  Object.defineProperty(Launcher.prototype, "hasFilter", { get: function () { return this.clipboardView || this.atRoot } })
  Object.defineProperty(Launcher.prototype, "filterOptions", { get: function () { return this.clipboardView ? ClipboardHistory.FILTERS : RootSearch.FILTERS } })
  Object.defineProperty(Launcher.prototype, "activeFilter", { get: function () { return this.clipboardView ? this.clipboardFilter : this.atRoot ? this.rootFilter : "all" } })

  Launcher.prototype.placeholder = function () {
    var v = this.view
    return v.kind === "alias" ? "Type an alias, then press ↵"
      : v.kind === "menu" ? "Search " + v.title + "…"
      : v.kind === "calculator-history" ? "Search calculations…"
      : this.clipboardView ? "Type to filter entries…"
      : v.kind === "theme" ? "Search themes…"
      : this.grid ? "Search Emoji & Symbols…"
      : "Search for apps and commands…"
  }

  // ---- stack

  Launcher.prototype.popToRoot = function () {
    this.stack = [{ kind: "root", title: "omacast", query: "" }]
    this.rootFilter = "all"
    this.clipboardFilter = "all"
    this.setInput("")
    this.query = ""
    this.rebuild(true)
  }

  Launcher.prototype.push = function (next) {
    var saved = this.stack.slice()
    saved[saved.length - 1] = Object.assign({}, this.view, { query: this.query, selectedIndex: this.selectedIndex })
    this.stack = saved.concat([next])
    if (next.kind === "clipboard") this.clipboardFilter = "all"
    this.query = next.kind === "alias" ? (next.value || "") : ""
    this.setInput(this.query)
    this.rebuild(true)
  }

  Launcher.prototype.pop = function () {
    if (this.atRoot) return
    var next = this.stack.slice(0, -1), top = next[next.length - 1]
    this.stack = next
    this.query = top.query || ""
    this.setInput(this.query)
    this.rebuild(false, top.selectedIndex)
  }

  // ---- search and rows

  Launcher.prototype.rebuild = function (resetSelection, restoreIndex) {
    var keepId = !resetSelection && this.selectedRow ? this.selectedRow.itemId : ""
    this.pointer = ""
    if (this.view.kind === "alias") { this.rows = []; this.renderRows(); this.select(-1); return }
    var sections
    try {
      sections = this.backend.search({ query: this.query, view: this.view, filter: this.activeFilter })
    } catch (e) {
      this.rows = []; this.renderRows(); this.select(-1)
      this.showToast("failure", e.message || String(e))
      return
    }
    var keepIndex = -1, keepColumn = 0, next = [], self = this
    if (this.grid) {
      Emoji.gridLines(sections, Emoji.COLUMNS).forEach(function (line, l) {
        if (line.section) { next.push({ rowKind: "section", itemId: "section:" + line.section.id, title: line.section.title }); return }
        line.cells.forEach(function (c, k) { if (keepIndex < 0 && c.id === keepId) { keepIndex = next.length; keepColumn = k } })
        next.push({ rowKind: "emoji-row", itemId: "line:" + l, cells: line.cells.map(function (c) { return { id: c.id, symbol: c.symbol, title: c.title } }) })
      })
    } else {
      sections.forEach(function (section, s) {
        if (section.title || s > 0) next.push({ rowKind: "section", itemId: "section:" + section.id, title: section.title })
        section.rows.forEach(function (c) {
          if (c.id === keepId) keepIndex = next.length
          next.push(self.rowData(c))
        })
      })
    }
    // Switch Theme opens on the current theme.
    if (keepIndex < 0 && this.view.kind === "theme") for (var n = 0; n < next.length; n++) if (next[n].checked) { keepIndex = n; break }
    this.rows = next
    this.renderRows()
    if (restoreIndex >= 0 && restoreIndex < next.length && this.isSelectable(restoreIndex)) this.select(restoreIndex)
    else this.select(keepIndex >= 0 ? keepIndex : this.nextSelectable(-1, 1), keepIndex >= 0 ? keepColumn : 0)
  }

  Launcher.prototype.rowData = function (c) {
    return {
      rowKind: c.kind === "calculator" ? "calculator" : "item", itemId: String(c.id || ""), title: String(c.title || ""), subtitle: String(c.subtitle || ""),
      glyph: String(c.glyph || ""), typeLabel: String(c.typeLabel || ""), alias: String(c.alias || ""), hotkey: String(c.hotkey || ""),
      checked: !!c.checked, disabled: !!c.disabled, favorite: typeof c.favoriteOrder === "number" || !!c.pinned,
      calcInput: String(c.calcInput || ""), calcResult: String(c.calcResult || ""),
      calcInputCaption: String(c.calcInputCaption || ""), calcResultCaption: String(c.calcResultCaption || ""),
      args: c.arguments || [], iconless: c.kind === "theme"
    }
  }

  Launcher.prototype.renderRows = function () {
    var html = ""
    this.rows.forEach(function (r, i) {
      if (r.rowKind === "section") { html += '<div class="oc-sec">' + esc(r.title) + "</div>"; return }
      if (r.rowKind === "emoji-row") {
        html += '<div class="oc-line" data-i="' + i + '">' + r.cells.map(function (c, k) {
          return '<span class="oc-cell" data-c="' + k + '" title="' + esc(c.title) + '">' + esc(c.symbol) + "</span>"
        }).join("") + "</div>"
        return
      }
      if (r.rowKind === "calculator") {
        html += '<div class="oc-calc" data-i="' + i + '"><div><strong>' + esc(r.calcInput) + "</strong><small>" + esc(r.calcInputCaption) + "</small></div>" +
          '<span class="oc-calc-arrow">→</span><div><strong>' + esc(r.calcResult) + "</strong><small>" + esc(r.calcResultCaption) + "</small></div></div>"
        return
      }
      html += '<div class="oc-row' + (r.disabled ? " oc-off" : "") + '" data-i="' + i + '" role="option">' +
        (r.iconless ? "" : '<span class="oc-ic">' + esc(r.glyph) + "</span>") +
        '<span class="oc-t"><b>' + esc(r.title) + "</b>" + (r.subtitle ? "<span>" + esc(r.subtitle) + "</span>" : "") + "</span>" +
        '<span class="oc-acc">' + (r.alias ? '<span class="oc-alias">' + esc(r.alias) + "</span>" : "") +
        (r.hotkey ? '<span class="oc-hotkey">' + r.hotkey.split(" ").map(function (k) { return "<kbd>" + esc(k) + "</kbd>" }).join("") + "</span>" : "") +
        (r.favorite ? '<span class="oc-fav">' + GLYPH.star + "</span>" : "") + (r.checked ? '<span class="oc-check">✓</span>' : "") +
        '<span class="oc-ty">' + esc(r.typeLabel) + "</span></span></div>"
    })
    this.el.list.innerHTML = html
    this.el.list.scrollTop = 0
  }

  Launcher.prototype.isSelectable = function (index) {
    var r = this.rows[index]
    return !!r && r.rowKind !== "section"
  }

  Launcher.prototype.nextSelectable = function (from, direction) {
    for (var i = from + direction; i >= 0 && i < this.rows.length; i += direction) if (this.isSelectable(i)) return i
    return -1
  }

  Launcher.prototype.rowEl = function (index) { return index >= 0 ? $('[data-i="' + index + '"]', this.el.list) : null }

  Launcher.prototype.select = function (index, column) {
    var previous = $(".oc-sel", this.el.list)
    if (previous) previous.classList.remove("oc-sel")
    var cellBefore = $(".oc-cell-sel", this.el.list)
    if (cellBefore) cellBefore.classList.remove("oc-cell-sel")
    this.selectedIndex = index
    var row = index >= 0 ? this.rows[index] : null
    var snap = row ? Object.assign({}, row) : null
    var el = this.rowEl(index)
    if (el) el.classList.add("oc-sel")
    // A grid line stands for its selected cell: actions, About and the footer all see that emoji.
    if (snap && snap.rowKind === "emoji-row") {
      var col = Math.max(0, Math.min(snap.cells.length - 1, column === undefined ? this.selectedColumn : column))
      this.selectedColumn = col
      snap.itemId = snap.cells[col].id
      snap.title = snap.cells[col].title
      if (el) el.children[col].classList.add("oc-cell-sel")
    }
    this.selectedRow = snap
    // Argument values belong to one command; a different row starts empty.
    var id = snap ? snap.itemId : ""
    if (id !== this.argsForId) { this.argsForId = id; this.argValues = {}; this.argFocus = -1 }
    this.argDefs = snap && snap.args ? snap.args : []
    if (el) {
      // Not scrollIntoView: that would scroll the page under a demo that is half off screen.
      var list = this.el.list
      if (index === this.nextSelectable(-1, 1)) list.scrollTop = 0
      else if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop - 4
      else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight + 4
    }
    this.renderChrome()
  }

  Launcher.prototype.move = function (delta) {
    this.pointer = ""
    if (this.selectedIndex < 0) { this.select(this.nextSelectable(-1, 1)); return }
    var step = delta > 0 ? 1 : -1, target = this.selectedIndex
    for (var n = 0; n < Math.abs(delta); n++) {
      var next = this.nextSelectable(target, step)
      if (next < 0) break
      target = next
    }
    this.select(target)
  }

  // ← → in the emoji grid, wrapping onto the neighbouring line.
  Launcher.prototype.moveColumn = function (delta) {
    if (!this.selectedRow || this.selectedRow.rowKind !== "emoji-row") return
    var col = this.selectedColumn + delta
    if (col >= 0 && col < this.selectedRow.cells.length) { this.select(this.selectedIndex, col); return }
    var line = this.nextSelectable(this.selectedIndex, delta)
    if (line >= 0) this.select(line, delta > 0 ? 0 : Emoji.COLUMNS - 1)
  }

  Launcher.prototype.jumpSection = function (direction) {
    var i = this.selectedIndex
    for (i += direction; i >= 0 && i < this.rows.length; i += direction) if (this.rows[i].rowKind === "section") break
    if (direction < 0) for (i -= 1; i >= 0; i--) if (this.rows[i].rowKind === "section") break
    var first = this.nextSelectable(Math.max(-1, i), 1)
    if (first >= 0) this.select(first)
  }

  Launcher.prototype.nthItem = function (n) {
    var seen = 0
    for (var i = 0; i < this.rows.length; i++) if (this.isSelectable(i) && ++seen === n) return i
    return -1
  }

  // ---- chrome: header, detail pane, empty state, footer, popups

  Launcher.prototype.setInput = function (value) {
    if (this.interactive) { if (this.el.input.value !== value) this.el.input.value = value }
    else this.el.input.textContent = value
  }

  Launcher.prototype.actionsForSelected = function () {
    if (!this.selectedRow) return []
    try { return this.backend.getActions(this.selectedRow.itemId) } catch (e) { return [] }
  }

  Launcher.prototype.renderChrome = function () {
    var el = this.el, v = this.view, self = this
    el.lead.innerHTML = this.atRoot ? LOGO : '<span class="oc-glyph">' + GLYPH.back + "</span>"
    el.lead.classList.toggle("oc-back", !this.atRoot)

    var pills = this.argDefs.length > 0 && v.kind !== "alias"
    var placeholder = pills ? "" : this.placeholder()
    if (this.interactive) el.input.placeholder = placeholder
    else el.input.setAttribute("data-placeholder", placeholder)
    this.root.classList.toggle("oc-has-pills", pills)
    if (this.interactive) el.input.style.width = pills ? Math.max(1, this.query.length + 1) + "ch" : ""
    var want = pills ? this.argDefs.map(function (d) { return d.name }).join(",") + ":" + this.argsForId : ""
    if (el.pills.getAttribute("data-for") !== want) {
      el.pills.setAttribute("data-for", want)
      el.pills.innerHTML = pills ? this.argDefs.map(function (d, i) {
        var label = esc(d.placeholder + (d.required ? "" : " (optional)"))
        return self.interactive
          ? '<input class="oc-pill" type="text" data-arg="' + i + '" tabindex="-1" placeholder="' + label + '" aria-label="' + label + '" autocomplete="off" autocapitalize="off" spellcheck="false">'
          : '<span class="oc-pill" data-arg="' + i + '" data-placeholder="' + label + '"></span>'
      }).join("") : ""
    }

    var filter = this.filterOptions.filter(function (f) { return f.id === self.activeFilter })[0] || this.filterOptions[0]
    el.filter.hidden = !this.hasFilter
    el.filter.textContent = filter.title + " ▾"
    el.filter.classList.toggle("oc-on", this.activeFilter !== "all")

    this.root.classList.toggle("oc-split", this.splitView && this.rows.length > 0)
    this.root.classList.toggle("oc-grid", this.grid)
    this.renderDetail()

    var empty = v.kind === "alias" || this.rows.length === 0
    el.empty.hidden = !empty
    if (empty) {
      var title = v.kind === "alias" ? v.title
        : v.kind === "calculator-history" && !this.query ? "No Calculations Yet"
        : this.clipboardView && !this.query && this.clipboardFilter === "all" ? "No Clipboard Entries" : "No results"
      var note = v.kind === "alias" ? "Typing the alias exactly in the root search puts this command on top. Leave it empty to remove it."
        : v.kind === "calculator-history" && !this.query ? "Type a calculation in the root search, then copy or paste the answer."
        : this.clipboardView && !this.query && this.clipboardFilter === "all" ? "Copy something and it shows up here." : ""
      el.empty.innerHTML = (v.kind === "alias" ? '<span class="oc-glyph oc-empty-icon">' + GLYPH.tag + "</span>" : '<span class="oc-empty-logo">' + LOGO + "</span>") +
        "<b>" + esc(title) + "</b>" + (note ? "<span>" + esc(note) + "</span>" : "")
    }

    var actions = this.actionsForSelected()
    el.statusIcon.innerHTML = this.toast
      ? '<span class="oc-glyph' + (this.toast.style === "failure" ? " oc-fail" : "") + '">' + (this.toast.style === "failure" ? GLYPH.warn : GLYPH.ok) + "</span>" : LOGO
    el.statusText.textContent = this.toast ? this.toast.title : this.grid && this.selectedRow ? this.selectedRow.title : v.title
    el.status.classList.toggle("oc-toast", !!this.toast)
    el.status.classList.toggle("oc-has-actions", !!(this.toast && this.toast.actions.length))
    el.primary.hidden = !actions.length && v.kind !== "alias"
    el.primary.innerHTML = esc(v.kind === "alias" ? "Save Alias" : actions.length ? actions[0].title : "") + " <kbd>↵</kbd>"
    el.more.hidden = v.kind === "alias"
    el.hints.classList.toggle("oc-solo", v.kind === "alias")
  }

  Launcher.prototype.renderDetail = function () {
    var el = this.el.detail
    if (!this.splitView || !this.selectedRow) { el.innerHTML = ""; return }
    var d = null
    try { d = this.backend.getDetail(this.selectedRow.itemId) } catch (e) {}
    if (!d) { el.innerHTML = ""; return }
    var preview
    if (d.theme) {
      var t = d.theme
      preview = '<div class="oc-theme" style="--t-bg:' + t.bg + ";--t-bg2:" + t.bg2 + ";--t-fg:" + t.fg + ";--t-dim:" + t.dim + ";--t-accent:" + t.accent + ";--t-sel:" + t.sel + '">' +
        '<div class="oc-theme-bar"><i></i><b></b></div><div class="oc-theme-win"><i></i><i class="s"></i><i></i><i></i></div>' +
        '<div class="oc-theme-dots"><i style="background:' + t.bg2 + '"></i><i style="background:' + t.sel + '"></i><i style="background:' + t.dim + '"></i><i style="background:' + t.fg + '"></i><i style="background:' + t.accent + '"></i></div></div>'
    } else if (d.image) preview = '<img class="oc-prev-img" src="' + esc(d.image) + '" alt="">'
    else if (d.color) preview = '<div class="oc-swatch" style="background:' + esc(d.color) + '"></div><div class="oc-prev-hex">' + esc(d.color) + "</div>"
    else preview = '<pre class="oc-prev-text">' + esc(d.text) + "</pre>"
    el.innerHTML = '<div class="oc-prev">' + preview + '</div><div class="oc-info"><div class="oc-info-title">Information</div>' +
      d.info.map(function (r) { return "<div><span>" + esc(r.label) + "</span><b>" + esc(r.value) + "</b></div>" }).join("") + "</div>"
  }

  Launcher.prototype.renderLayer = function () {
    var html = "", p = this.popup
    if (p) {
      var needle = p.filter.trim().toLowerCase()
      p.visible = p.items.filter(function (a) { return !needle || a.title.toLowerCase().indexOf(needle) >= 0 })
      p.selected = Math.max(0, Math.min(p.visible.length - 1, p.selected))
      html += '<div class="oc-panel oc-panel-' + p.kind + '"><div class="oc-panel-list">' + (p.visible.length ? p.visible.map(function (a, i) {
        var sep = i > 0 && p.visible[i - 1].section !== a.section ? " oc-sep" : ""
        return '<div class="oc-act' + sep + (i === p.selected ? " oc-sel" : "") + '" data-a="' + i + '"><span class="oc-act-ic">' + esc(a.mark || "") + "</span><span>" + esc(a.title) + "</span>" +
          '<span class="oc-keys">' + String(a.shortcut || "").split(" ").filter(Boolean).map(function (k) { return "<kbd>" + esc(k) + "</kbd>" }).join("") + "</span></div>"
      }).join("") : '<div class="oc-none">No actions</div>') + "</div>" +
        (this.interactive ? '<input class="oc-panel-filter" type="text" tabindex="-1" placeholder="' + esc(p.placeholder) + '" aria-label="' + esc(p.placeholder) + '" autocomplete="off" autocapitalize="off" spellcheck="false">'
          : '<div class="oc-panel-filter">' + esc(p.placeholder) + "</div>") + "</div>"
    }
    if (this.aboutRows) {
      html += '<div class="oc-about"><div class="oc-about-title">' + esc(this.selectedRow ? this.selectedRow.title : "About") + "</div>" +
        this.aboutRows.map(function (r) { return "<div><span>" + esc(r.label) + "</span><b>" + esc(r.value) + "</b></div>" }).join("") + "</div>"
    }
    if (this.alert) {
      var spec = this.alert.spec
      html += '<div class="oc-scrim"><div class="oc-alert" role="alertdialog"><b>' + esc(spec.title) + "</b><p>" + esc(spec.message) + "</p>" +
        '<div><button type="button" class="oc-alert-cancel" tabindex="-1">Cancel <kbd>Esc</kbd></button>' +
        '<button type="button" class="oc-alert-ok' + (spec.destructive ? " oc-danger" : "") + '" tabindex="-1">' + esc(spec.primary) + " <kbd>↵</kbd></button></div></div></div>"
    }
    this.el.layer.innerHTML = html
    if (p && this.interactive) $(".oc-panel-filter", this.el.layer).value = p.filter
    var sel = $(".oc-panel .oc-sel", this.el.layer)
    if (sel) { var list = sel.parentNode; if (sel.offsetTop + sel.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = sel.offsetTop + sel.offsetHeight - list.clientHeight }
    this.refocus()
  }

  // The field that has the keyboard: the panel's filter, an argument pill, or the search.
  Launcher.prototype.refocus = function () {
    if (!this.interactive || !this.root.isConnected) return
    var target = this.popup ? $(".oc-panel-filter", this.el.layer) : this.argFocus >= 0 ? $('.oc-pill[data-arg="' + this.argFocus + '"]', this.root) : this.el.input
    if (target && document.activeElement !== target) target.focus({ preventScroll: true })
  }

  Launcher.prototype.closePopups = function () {
    this.popup = null; this.aboutRows = null
    this.renderLayer()
  }

  Launcher.prototype.openPopup = function (kind, items, placeholder, selected, onPick) {
    this.popup = { kind: kind, items: items, placeholder: placeholder, filter: "", selected: selected || 0, onPick: onPick, visible: items }
    this.renderLayer()
  }

  Launcher.prototype.toggleActionPanel = function () {
    if (this.popup) { var was = this.popup.kind; this.closePopups(); if (was === "actions") return }
    var actions = this.actionsForSelected(), self = this
    if (!actions.length) return
    this.openPopup("actions", actions.map(function (a) { return { id: a.id, title: a.title, shortcut: a.shortcut, section: a.section, mark: a.icon === "✓" ? "✓" : "" } }),
      "Search for actions…", 0, function (id) { self.perform(id) })
  }

  Launcher.prototype.toggleDropdown = function () {
    if (this.popup) { var was = this.popup.kind; this.closePopups(); if (was === "dropdown") return }
    if (!this.hasFilter) return
    var self = this, active = this.activeFilter
    var at = this.filterOptions.map(function (f) { return f.id }).indexOf(active)
    this.openPopup("dropdown", this.filterOptions.map(function (f) { return { id: f.id, title: f.title, section: "", mark: f.id === active ? "✓" : "" } }),
      "Filter…", Math.max(0, at), function (id) {
        if (self.activeFilter === id) return
        if (self.clipboardView) self.clipboardFilter = id
        else self.rootFilter = id
        self.rebuild(true)
      })
  }

  Launcher.prototype.toggleToastPanel = function () {
    if (this.popup) { var was = this.popup.kind; this.closePopups(); if (was === "toast") return }
    if (!this.toast || !this.toast.actions.length) return
    var self = this, toast = this.toast
    clearTimeout(this.toastTimer)
    this.openPopup("toast", toast.actions.map(function (a) { return { id: a.id, title: a.title, section: "" } }), "Search for actions…", 0, function (id) {
      var action = toast.actions.filter(function (a) { return a.id === id })[0]
      if (!action) return
      if (action.copy !== undefined) { self.backend.copyText(action.copy); self.showToast("success", "Copied to Clipboard"); return }
      try { action.run() } catch (e) { self.showToast("failure", e.message || String(e)); return }
      self.toast = null
      self.rebuild(false)
      if (action.done) self.showToast("success", action.done)
    })
  }

  Launcher.prototype.toggleAbout = function () {
    if (this.aboutRows || !this.selectedRow) { this.aboutRows = null; this.renderLayer(); return }
    try {
      var rows = this.backend.getItemInfo(this.selectedRow.itemId, this.query)
      this.aboutRows = rows.length ? rows : null
    } catch (e) { this.showToast("failure", e.message || String(e)) }
    this.renderLayer()
  }

  // A failure toast always offers its message to copy.
  Launcher.prototype.showToast = function (style, title, actions) {
    var list = (actions || []).slice(), self = this
    if (style === "failure") list.push({ id: "copy-error", title: "Copy Error Message", copy: String(title || "") })
    var toast = { style: style, title: String(title || ""), actions: list }
    this.toast = toast
    clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(function () {
      if (self.toast !== toast || (self.popup && self.popup.kind === "toast")) return
      self.toast = null
      self.renderChrome()
    }, list.length ? 6000 : 3200)
    this.renderChrome()
  }

  // ---- actions

  Launcher.prototype.perform = function (actionId, index) {
    if (index !== undefined && index >= 0) this.select(index)
    if (!this.selectedRow) return
    this.popup = null
    // ↵ on a command with an empty required argument focuses that pill.
    if (actionId === "open" && this.argDefs.length) {
      var missing = RootSearch.missingArgument(this.argDefs, this.argValues)
      if (missing >= 0) { this.argFocus = missing; this.renderLayer(); return }
    }
    this.request({ id: this.selectedRow.itemId, action: actionId, query: this.query, arguments: this.argValues })
  }

  Launcher.prototype.request = function (payload) {
    var outcome
    try { outcome = this.backend.performAction(payload) || {} } catch (e) { this.renderLayer(); this.showToast("failure", e.message || String(e)); return }
    if (outcome.confirm) { this.alert = { spec: outcome.confirm, payload: payload }; this.renderLayer(); return }
    if (outcome.push) { this.push(outcome.push); this.renderLayer(); return }
    if (outcome.close) {
      // On the desktop the window closes here and the app takes over. In a browser it stays, says what
      // would have happened, and resets the way it does behind the closed window.
      this.argValues = {}; this.argFocus = -1; this.argsForId = ""
      if (this.atRoot) { this.setInput(""); this.query = ""; this.historyIndex = -1; this.rebuild(true) }
      else this.rebuild(false)
      this.renderLayer()
      this.showToast("success", outcome.hud || "Done")
      return
    }
    this.rebuild(false)
    this.renderLayer()
    if (outcome.toast) this.showToast(outcome.toast.style, outcome.toast.title, outcome.toast.actions)
  }

  Launcher.prototype.confirmAlert = function () {
    var payload = Object.assign({}, this.alert.payload, { confirmed: true })
    this.alert = null
    this.request(payload)
  }

  Launcher.prototype.performNth = function (n) {
    var list = this.actionsForSelected()
    if (list.length > n) this.perform(list[n].id)
  }

  Launcher.prototype.performIfOffered = function (ids) {
    var list = this.actionsForSelected()
    for (var i = 0; i < list.length; i++) if (ids.indexOf(list[i].id) >= 0) { this.perform(list[i].id); return true }
    return false
  }

  Launcher.prototype.saveAlias = function () {
    try { this.backend.updateCommandSettings({ commandId: this.view.commandId, alias: this.query }) } catch (e) { this.showToast("failure", e.message || String(e)); return }
    var saved = this.query.trim()
    this.pop()
    this.showToast("success", saved ? "Alias saved" : "Alias removed")
    this.rebuild(false)
  }

  Launcher.prototype.setQuery = function (next) {
    if (this.view.kind === "alias") next = next.replace(/\s/g, "")
    this.setInput(next)
    if (this.query === next) return
    this.query = next
    this.historyIndex = -1
    this.rebuild(true)
  }

  Launcher.prototype.recallHistory = function (direction) {
    var history = this.backend.stores.frecency.doc.searchHistory
    if (!history.length) return false
    var next = Math.max(-1, Math.min(history.length - 1, this.historyIndex + direction))
    if (next === this.historyIndex) return true
    this.query = next < 0 ? "" : history[next]
    this.setInput(this.query)
    this.rebuild(true)
    this.historyIndex = next
    return true
  }

  Launcher.prototype.handleEscape = function (shift) {
    if (this.alert) { this.alert = null; this.renderLayer(); return }
    if (this.aboutRows) { this.aboutRows = null; this.renderLayer(); return }
    if (this.popup) { this.closePopups(); return }
    if (this.argFocus >= 0 && !shift) { this.argFocus = -1; this.refocus(); return }
    if (shift) { this.popToRoot(); return }
    if (this.query && this.view.kind !== "alias") this.setQuery("")
    else if (!this.atRoot) this.pop()
    else this.onDismiss()
  }

  // ---- keys. `e` is a KeyboardEvent, or the demo's stand-in for one.

  Launcher.prototype.handleKey = function (e) {
    var ctrl = !!(e.ctrlKey || e.metaKey), shift = !!e.shiftKey, alt = !!e.altKey
    var key = e.key, k = key.length === 1 ? key.toLowerCase() : key
    var enter = key === "Enter"
    var down = !alt && ((!ctrl && key === "ArrowDown") || (ctrl && !shift && k === "n"))
    var up = !alt && !ctrl && key === "ArrowUp"

    if (this.alert) {
      if (key === "Escape") { this.alert = null; this.renderLayer() }
      else if (enter) this.confirmAlert()
      return true
    }
    if (key === "Escape") { this.handleEscape(shift); return true }
    if (ctrl && k === "[") { this.closePopups(); this.pop(); return true }
    if (this.aboutRows) {
      if (ctrl && shift && k === "k") { this.aboutRows = null; this.renderLayer() }
      return true
    }
    if (this.popup) {
      var p = this.popup
      if ((p.kind === "actions" && ctrl && !shift && k === "k") || (p.kind === "dropdown" && ctrl && !shift && k === "p") || (p.kind === "toast" && ctrl && k === "t")) { this.closePopups(); return true }
      if (down || up || (ctrl && !shift && k === "p")) { p.selected += down ? 1 : -1; this.renderLayer(); return true }
      if (enter) { var picked = p.visible[p.selected]; this.popup = null; this.renderLayer(); if (picked) p.onPick(picked.id); return true }
      return key === "Tab"
    }

    if (this.view.kind === "alias") {
      if (enter) { this.saveAlias(); return true }
      if (key === " ") return true
    } else {
      if (ctrl && shift && k === "k") { this.toggleAbout(); return true }
      if (ctrl && !shift && k === "k") { this.toggleActionPanel(); return true }
      if (ctrl && !shift && k === "p") { this.toggleDropdown(); return true }
      if (ctrl && !shift && k === "t") { this.toggleToastPanel(); return true }
      // Shift+Enter opens a new window for apps; Enter focuses an open one.
      if (enter && shift && !ctrl && !alt && this.performIfOffered(["open-new"])) return true
      if (enter && ctrl && shift) { this.performNth(2); return true }
      if (enter && ctrl) { this.performNth(1); return true }
      if (enter) { this.performNth(0); return true }
      if (this.argFocus >= 0) {
        var def = this.argDefs[this.argFocus]
        if (key === "Tab") { var step = this.argFocus + (shift ? -1 : 1); this.argFocus = step >= this.argDefs.length ? 0 : step; this.refocus(); return true }
        if (key === "Backspace" && !(this.argValues[def.name] || "")) { this.argFocus--; this.refocus(); return true }
        if (!down && !up && key !== "PageUp" && key !== "PageDown") return false
      }
      if (key === "Tab" && this.argDefs.length) { this.argFocus = 0; this.refocus(); return true }
      if (key === "Tab") return true
      if (ctrl && alt && key === "ArrowUp") { this.performIfOffered(["favorite-up"]); return true }
      if (ctrl && alt && key === "ArrowDown") { this.performIfOffered(["favorite-down"]); return true }
      if (ctrl && key === "ArrowUp") { this.jumpSection(-1); return true }
      if (ctrl && key === "ArrowDown") { this.jumpSection(1); return true }
      if (up) {
        if (this.atRoot && (this.query === "" || this.historyIndex >= 0) && this.selectedIndex === this.nextSelectable(-1, 1) && this.recallHistory(1)) return true
        this.move(-1); return true
      }
      if (down) {
        if (this.historyIndex >= 0) { this.recallHistory(-1); return true }
        this.move(1); return true
      }
      if (this.grid && !ctrl && !alt && (key === "ArrowLeft" || key === "ArrowRight")) { this.moveColumn(key === "ArrowLeft" ? -1 : 1); return true }
      if (ctrl && shift && k === "p") { this.performIfOffered(["pin", "unpin"]); return true }
      if (ctrl && !shift && k === "o") { this.performIfOffered(["open-link"]); return true }
      if (key === "PageUp") { this.move(-8); return true }
      if (key === "PageDown") { this.move(8); return true }
      if (ctrl && shift && k === "f") { this.performIfOffered(["favorite-add", "favorite-remove"]); return true }
      if (ctrl && shift && k === "c") { this.performIfOffered(["copy-command", "copy-id", "copy-question-answer", "copy-name"]); return true }
      if (ctrl && shift && k === "d") { this.performIfOffered(["delete-all-entries", "clear-recent"]); return true }
      if (ctrl && k === "d") { this.performIfOffered(["delete-entry", "remove-recent"]); return true }
      if (alt && shift && k === "d") { this.performIfOffered(["disable"]); return true }
      if (ctrl && !shift && !alt && k >= "1" && k <= "9") {
        var target = this.nthItem(Number(k))
        if (target >= 0) this.perform("open", target)
        return true
      }
    }
    if (ctrl && !shift && !alt && k === "u") { this.setQuery(""); return true }
    if (key === "Backspace" && !this.query && !this.atRoot) { this.pop(); return true }
    return false
  }

  Launcher.prototype.listen = function () {
    var self = this, root = this.root

    root.addEventListener("keydown", function (e) {
      if (e.isComposing) return
      if (self.handleKey(e)) { e.preventDefault(); e.stopPropagation() }
    })

    root.addEventListener("input", function (e) {
      var t = e.target
      if (t === self.el.input) self.setQuery(t.value)
      else if (t.classList.contains("oc-panel-filter") && self.popup) {
        self.popup.filter = t.value
        self.popup.selected = 0
        var at = t.selectionStart
        self.renderLayer()
        var again = $(".oc-panel-filter", self.el.layer)
        if (again) again.setSelectionRange(at, at)
      } else if (t.classList.contains("oc-pill")) {
        var def = self.argDefs[Number(t.getAttribute("data-arg"))]
        if (def) self.argValues[def.name] = t.value
      }
    })

    root.addEventListener("focusin", function (e) {
      if (e.target.classList.contains("oc-pill")) self.argFocus = Number(e.target.getAttribute("data-arg"))
      else if (e.target === self.el.input) self.argFocus = -1
    })

    // A row is selected on hover only after a real pointer move, as in the launcher: browsers also
    // send a move when the list scrolls under a still pointer.
    this.el.list.addEventListener("mousemove", function (e) {
      var at = e.clientX + ":" + e.clientY
      if (at === self.pointer) return
      var first = self.pointer === ""
      self.pointer = at
      if (first) return
      var row = e.target.closest("[data-i]")
      if (!row) return
      var cell = e.target.closest(".oc-cell")
      var index = Number(row.getAttribute("data-i")), col = cell ? Number(cell.getAttribute("data-c")) : undefined
      if (index !== self.selectedIndex || (cell && col !== self.selectedColumn)) self.select(index, col)
    })

    root.addEventListener("click", function (e) {
      var t = e.target
      var act = t.closest(".oc-act")
      if (act && self.popup) {
        var p = self.popup, picked = p.visible[Number(act.getAttribute("data-a"))]
        self.popup = null; self.renderLayer()
        if (picked) p.onPick(picked.id)
        return
      }
      if (t.closest(".oc-alert-ok")) { self.confirmAlert(); return }
      if (t.closest(".oc-alert-cancel") || (t.classList.contains("oc-scrim"))) { self.alert = null; self.renderLayer(); return }
      if (self.alert) return
      if (t.closest(".oc-panel") || t.closest(".oc-about")) { self.refocus(); return }
      if (t.closest(".oc-more")) { self.toggleActionPanel(); return }
      if (t.closest(".oc-filter")) { self.toggleDropdown(); return }
      if (self.popup || self.aboutRows) { self.closePopups(); return }
      if (t.closest(".oc-lead")) { if (!self.atRoot) self.pop(); self.refocus(); return }
      if (t.closest(".oc-primary")) { if (self.view.kind === "alias") self.saveAlias(); else self.performNth(0); self.refocus(); return }
      if (t.closest(".oc-status")) { self.toggleToastPanel(); self.refocus(); return }
      if (t.classList.contains("oc-pill")) return
      var row = t.closest("[data-i]")
      if (row) {
        var cell = t.closest(".oc-cell")
        self.select(Number(row.getAttribute("data-i")), cell ? Number(cell.getAttribute("data-c")) : undefined)
        self.performNth(0)
      }
      self.refocus()
    })
  }

  // ------------------------------------------------------------ data

  var loading = null
  function load() {
    if (loading) return loading
    function get(url, type) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + ": " + r.status); return r[type]() }) }
    loading = Promise.all([get("/demo/snapshot.json", "json"), get("/demo/emoji.json", "text"), get("/demo/emoji-keywords.json", "text")]).then(function (got) {
      var snapshot = got[0]
      var tree = OmarchyMenu.buildTree(OmarchyMenu.parse(JSON.stringify(snapshot.menu)).items, [])
      var providerItems = {}
      tree.order.forEach(function (id) {
        var item = tree.items[id]
        if (item.provider && PROVIDER_OUTPUT[item.provider]) providerItems[id] = OmarchyMenu.providerItems(id, item.provider, PROVIDER_OUTPUT[item.provider])
      })
      return { tree: tree, guards: snapshot.guards, providerItems: providerItems, rates: snapshot.rates, emoji: Emoji.parse(got[1], got[2]), snapshot: snapshot }
    })
    return loading
  }

  // ------------------------------------------------------------ the hero demo: the launcher, typing for itself

  var KEYS = { "↵": "Enter", "↓": "ArrowDown", "↑": "ArrowUp", "Esc": "Escape" }
  function keyEvent(spec) {
    var e = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, key: "" }
    spec.split(" ").forEach(function (part) {
      if (part === "Ctrl") e.ctrlKey = true
      else if (part === "Shift") e.shiftKey = true
      else if (part === "Alt") e.altKey = true
      else e.key = KEYS[part] || (part.length === 1 ? part.toLowerCase() : part)
    })
    return e
  }

  function Autoplay(stage, data) {
    this.stage = stage
    this.presses = $(".presses", stage)
    this.backend = new Backend(data, { persist: false })
    this.launcher = new Launcher($(".oc", stage), this.backend, { interactive: false })
    this.visible = true
    this.paused = false
    var self = this
    new IntersectionObserver(function (es) { self.visible = es[0].isIntersecting }).observe(stage)
  }

  Autoplay.prototype.wait = async function (ms) {
    await sleep(ms)
    while (!this.visible || this.paused || document.hidden) await sleep(400)
  }

  Autoplay.prototype.press = async function (spec, hold) {
    var caps = spec.split(" ").map(function (k) { return "<kbd>" + esc(k) + "</kbd>" }).join("")
    this.presses.innerHTML = caps
    Array.prototype.forEach.call(this.presses.children, function (c) { c.classList.add("pressed") })
    this.launcher.handleKey(keyEvent(spec))
    await this.wait(170)
    Array.prototype.forEach.call(this.presses.children, function (c) { c.classList.remove("pressed") })
    await this.wait(hold === undefined ? 520 : hold)
  }

  Autoplay.prototype.type = async function (text) {
    this.presses.innerHTML = ""
    for (var i = 0; i < text.length; i++) {
      this.launcher.setQuery(this.launcher.query + text[i])
      await this.wait(70 + Math.random() * 80)
    }
  }

  Autoplay.prototype.clear = async function () {
    if (this.launcher.query) await this.press("Ctrl U", 300)
  }

  Autoplay.prototype.loop = async function () {
    var l = this.launcher
    for (;;) {
      this.backend.reset()
      l.popToRoot()
      l.toast = null; l.renderChrome()
      await this.wait(1600)

      await this.type("screen")                       // every Omarchy action is a result
      await this.wait(900)
      await this.press("↓"); await this.press("↓", 1100)
      await this.clear()

      await this.type("5 ft 3 in to cm")              // the calculator answers above the results
      await this.wait(2200)
      await this.clear()

      await this.type("fir")                          // an app, its actions, and what opening it teaches
      await this.wait(700)
      await this.press("Ctrl K", 900)
      await this.press("↓"); await this.press("↓", 900)
      await this.press("Esc", 500)
      await this.press("↵", 2600)

      await this.type("switch")                       // a built-in command with its own view
      await this.wait(700)
      await this.press("↵", 900)
      for (var n = 0; n < THEMES.length - 1; n++) { await this.press("↓", 260); await this.press("↵", 1000) }
      await this.wait(600)
    }
  }

  // ------------------------------------------------------------ the page: hero demo, overlay, ways in

  function Page(data) {
    this.data = data
    this.overlay = null
    this.live = null
    this.autoplay = null
    var stage = $(".stage"), self = this
    if (stage && $(".oc", stage)) {
      this.autoplay = new Autoplay(stage, data)
      stage.classList.add("ready")
      $(".desk", stage).addEventListener("click", function () { self.open("") })
      if (!reduced) setTimeout(function () { self.autoplay.loop() }, 900)
    }
    Array.prototype.forEach.call(document.querySelectorAll("[data-try], [data-try-show]"), function (b) {
      b.hidden = false
      if (b.hasAttribute("data-try")) b.addEventListener("click", function (e) { e.preventDefault(); self.open("") })
    })
    // One shortcut, the web's usual key for "search", shown on the button. Nothing opens by surprise.
    document.addEventListener("keydown", function (e) {
      if (self.isOpen()) {
        // The keyboard belongs to the launcher while it is up, wherever the last click landed.
        if (!self.live.root.contains(e.target)) { if (e.key === "Escape") self.close(); else self.live.refocus() }
        return
      }
      if (e.key !== "/" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
      var t = e.target
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      e.preventDefault()
      self.open("")
    })
  }

  Page.prototype.isOpen = function () { return !!this.overlay && !this.overlay.hidden }

  Page.prototype.build = function () {
    var self = this, o = document.createElement("div")
    o.className = "oc-overlay"
    o.hidden = true
    o.innerHTML = '<div class="oc-window" role="dialog" aria-modal="true" aria-label="omacast, running in your browser"><div class="oc"></div>' +
      '<p class="oc-note">This is omacast\'s own search, ranking and calculator, running in your browser on a sample desktop. ' +
      'Nothing launches, and what it learns stays in this browser. <button type="button" class="oc-reset">Reset</button> ' +
      '<button type="button" class="oc-close">Close <kbd>Esc</kbd></button></p></div>'
    document.body.appendChild(o)
    this.overlay = o
    this.backend = new Backend(this.data, { persist: true })
    this.live = new Launcher($(".oc", o), this.backend, { interactive: true, onDismiss: function () { self.close() } })
    o.addEventListener("mousedown", function (e) { if (e.target === o) self.close() })
    $(".oc-close", o).addEventListener("click", function () { self.close() })
    $(".oc-reset", o).addEventListener("click", function () {
      self.backend.reset()
      self.live.popToRoot()
      self.live.showToast("success", "Back to a fresh install")
      self.live.refocus()
    })
  }

  Page.prototype.open = function (text) {
    if (!this.overlay) this.build()
    if (this.isOpen()) return
    this.returnFocus = document.activeElement
    this.overlay.hidden = false
    document.documentElement.classList.add("oc-open")
    if (this.autoplay) this.autoplay.paused = true
    // Zones can drift across a DST switch between visits to the page.
    this.live.rebuild(false)
    if (text) this.live.setQuery(this.live.query + text)
    this.live.refocus()
  }

  Page.prototype.close = function () {
    if (!this.isOpen()) return
    this.live.closePopups()
    this.overlay.hidden = true
    document.documentElement.classList.remove("oc-open")
    if (this.autoplay) this.autoplay.paused = false
    if (this.returnFocus && this.returnFocus.focus) this.returnFocus.focus({ preventScroll: true })
  }

  window.OmacastDemo = { Backend: Backend, Launcher: Launcher, load: load, THEMES: THEMES, APPS: APPS, page: null }

  function start() {
    load().then(function (data) { window.OmacastDemo.page = new Page(data) }).catch(function (e) {
      if (window.console) console.error("omacast demo: " + (e.message || e))
    })
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start)
  else start()
})()
