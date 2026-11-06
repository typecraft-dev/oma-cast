// Feature tests: unduck quicklink, file search (match + index), the
// Settings view, and the Kill Process flow — the three root-search
// additions plus the icon-critical pieces they depend on.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const RS = require("../../plugin/core/RootSearch.js")
const FileSearch = require("../../plugin/core/FileSearch.js")
const SettingsView = require("../../plugin/core/SettingsView.js")
const { createFileIndex } = require("./file-index")
const { createBackend } = require("./backend")

// ---------------------------------------------------------------- unduck
test("unduck is a fallback row and a pushed search view with the {query} contract", () => {
  const unduck = RS.FALLBACKS.find(f => f.id === "fallback:unduck")
  assert.ok(unduck, "fallback present")
  assert.equal(RS.fallbackUrl(unduck, "hello world"), "https://unduck.link?q=hello%20world")
  assert.equal(unduck.icon.codePointAt(0), 0xf0ac)          // nf-fa-globe
  const cmd = RS.BUILTINS.find(b => b.id === "builtin:unduck-search")
  assert.ok(cmd, "quicklink present")
  assert.equal(cmd.run.push.kind, "web-search")
  assert.equal(cmd.run.push.engine, "fallback:unduck")
  assert.deepEqual(cmd.arguments || [], [], "no inline pill arguments")
  assert.ok(cmd.keywords.includes("unduck"))
  const sections = RS.webSearchSections("fallback:unduck", "hello world")
  assert.equal(sections[0].rows[0].candidate.id, "web-search:unduck")
  assert.equal(RS.fallbackUrl(RS.engineFallback("fallback:unduck"), "hello world"), "https://unduck.link?q=hello%20world")
})

test("Settings and Kill Process exist as always-on root commands", () => {
  const settings = RS.BUILTINS.find(b => b.id === "builtin:settings")
  assert.equal(settings.run.push.kind, "settings")
  assert.equal(settings.glyph.codePointAt(0), 0xf113)       // nf-fa-gears
  const kill = RS.BUILTINS.find(b => b.id === "builtin:kill-process")
  assert.equal(kill.run.push.kind, "processes")
  assert.equal(kill.glyph.codePointAt(0), 0xf111)           // nf-fa-power-off
})

test("power commands: shutdown/restart confirm, sleep does not", () => {
  const sd = RS.confirmationFor("builtin:shutdown", "open")
  assert.equal(sd.destructive, true)
  assert.equal(sd.primary, "Shut Down")
  const rs = RS.confirmationFor("builtin:restart", "open")
  assert.equal(rs.destructive, true)
  assert.equal(rs.primary, "Restart")
  assert.equal(RS.confirmationFor("builtin:sleep", "open"), null)
  assert.equal(RS.confirmationFor("builtin:shutdown", "copy-path"), null)

  const builtins = Object.fromEntries(RS.BUILTINS.filter(b => b.run && b.run.power).map(b => [b.id, b.run]))
  assert.deepEqual(builtins["builtin:shutdown"], { power: "shutdown" })
  assert.deepEqual(builtins["builtin:restart"], { power: "restart" })
  assert.deepEqual(builtins["builtin:sleep"], { power: "sleep" })
  assert.equal(RS.BUILTINS.find(b => b.id === "builtin:sleep").glyph.codePointAt(0), 0xf186)
  assert.equal(RS.BUILTINS.find(b => b.id === "builtin:restart").glyph.codePointAt(0), 0xf021)
})

// ------------------------------------------------------------- file match
function ent(p, d, m) { return { p, n: path.basename(p), d, m } }

test("file matching orders name hits before path hits, then by recency", () => {
  const entries = [
    ent("C:/z/notes-report.txt", false, 1000),
    ent("C:/reporting/a.txt", false, 9000),
    ent("C:/b/report.txt", false, 5000),
    ent("C:/elsewhere/readme.md", false, 99999)
  ]
  const top = FileSearch.match(entries, "report", { limit: 10 })
  // All-in-name matches first…
  assert.equal(top[0].entry.n, "report.txt")
  assert.equal(top[0].tier, 0)
  const tiers = top.map(r => r.tier)
  assert.deepEqual(tiers, tiers.slice().sort((a, b) => a - b))  // 0 → 1 → 2
  // The path-only hit (C:/reporting/) is last among matches.
  assert.equal(top[top.length - 1].entry.n, "a.txt")
  assert.equal(top[top.length - 1].tier, 2)
})

test("nameOnly keeps single-token queries on the file name", () => {
  const entries = [
    ent("C:/z/notes-report.txt", false, 1000),
    ent("C:/reporting/a.txt", false, 9000),
    ent("C:/b/report.txt", false, 5000)
  ]
  // Default keeps the old tiers (a path-only bag for "report").
  assert.equal(FileSearch.match(entries, "report", { limit: 10 }).length, 3)
  // A name query (the root-search app-query guard) drops the path-only hit.
  const named = FileSearch.match(entries, "report", { limit: 10, nameOnly: true })
  assert.deepEqual(named.map(r => r.entry.n).sort(), ["notes-report.txt", "report.txt"])
  assert.ok(named.every(r => r.tier === 0))
  // …but a bare name with no name hits finds nothing instead of path junk.
  assert.deepEqual(FileSearch.match([ent("C:/Files/data.db", false, 1)], "files", { limit: 10, nameOnly: true }), [])
})

test("every token must match, name or path, and limits apply", () => {
  const entries = [
    ent("/home/u/Desktop/quarterly report.docx", false, 1),
    ent("/home/u/nope.txt", false, 2)
  ]
  assert.equal(FileSearch.match(entries, "quarterly report", { limit: 5 }).length, 1)
  assert.equal(FileSearch.match(entries, "quarterly zebra", { limit: 5 }).length, 0)
  assert.equal(FileSearch.match(entries, "", { limit: 5 }).length, 0)
  const many = Array.from({ length: 50 }, (_, i) => ent("/d/file" + i + ".txt", false, i))
  assert.equal(FileSearch.match(many, "file", { limit: 10 }).length, 10)
})

test("file candidates carry the row shape and the three actions", () => {
  const c = FileSearch.candidate(ent("C:/Users/a/Documents/budget.xlsx", false, 1))
  assert.equal(c.id, "file:C:/Users/a/Documents/budget.xlsx")
  assert.equal(c.title, "budget.xlsx")
  assert.equal(c.subtitle, "C:/Users/a/Documents")
  assert.equal(c.typeLabel, "File")
  assert.equal(c.glyph.codePointAt(0), 0xf15b)              // nf-fa-file
  const d = FileSearch.candidate(ent("/home/u/Pics", true, 1))
  assert.equal(d.typeLabel, "Folder")
  assert.equal(d.glyph.codePointAt(0), 0xf07b)              // nf-fa-folder
  const acts = FileSearch.actionsForFile(c).map(a => a.id)
  assert.deepEqual(acts, ["open", "reveal", "copy-path"])
})

// ------------------------------------------------------------ file index
test("the index walks, excludes, hides, and round-trips its cache", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oma-cast-idx-"))
  fs.mkdirSync(path.join(root, "Documents"))
  fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true })
  fs.mkdirSync(path.join(root, ".hidden"))
  fs.writeFileSync(path.join(root, "Documents", "notes.txt"), "hi")
  fs.writeFileSync(path.join(root, "Documents", ".secret"), "s")
  fs.writeFileSync(path.join(root, "node_modules", "x", "junk.js"), "x")
  fs.writeFileSync(path.join(root, ".hidden", "deep.txt"), "x")
  const cachePath = path.join(root, "cache", "file-index.json")

  const idx = createFileIndex({ roots: [root], home: root, cachePath })
  idx.start()
  await new Promise(r => setTimeout(r, 200))
  assert.equal(idx.ready, true)
  const names = idx.entries.map(e => e.n)
  assert.ok(names.includes("notes.txt"), "file indexed")
  assert.ok(names.includes("Documents"), "folder indexed")
  assert.ok(!names.includes("junk.js"), "node_modules excluded")
  assert.ok(!names.includes(".secret"), "hidden excluded by default")
  assert.ok(!names.includes(".hidden"), "hidden dir excluded by default")
  assert.ok(fs.existsSync(cachePath), "cache written")

  // Second instance: cache loads in the background (launch never parses
  // it synchronously), then serves without a re-walk.
  const idx2 = createFileIndex({ roots: [root], home: root, cachePath })
  idx2.start()
  await new Promise(r => setTimeout(r, 200))
  assert.equal(idx2.ready, true, "cache is ready after background load")
  assert.equal(idx2.entries.length, idx.entries.length)

  // includeHidden pulls dotfiles in on the next walk.
  const idx3 = createFileIndex({ roots: [root], home: root, cachePath: "", includeHidden: true })
  idx3.start()
  await new Promise(r => setTimeout(r, 200))
  assert.ok(idx3.entries.map(e => e.n).includes(".secret"))
})

// ------------------------------------------------------------- settings
test("settings rows format, filter and cycle", () => {
  const general = { windowMode: "expanded", escapeKeyBehavior: "pop-back-or-close", navigationBindings: "emacs", rootSearchSensitivity: "medium", popToRootTimeout: 90, uiZoom: 1 }
  const config = { hotkey: "Alt+Space", keepVisibleOnFocusLoss: false, currencyRates: true, clockFormat: "auto", remToPxRate: 16, workHoursPerDay: 8, fileSearchIncludeHidden: false }

  const all = SettingsView.rowsFor(general, config, "")
  assert.ok(all.length >= 12, "every def is a row")
  const mode = all.find(r => r.id === "setting:general:windowMode")
  assert.equal(mode.typeLabel, "Expanded")
  const hot = all.find(r => r.id === "setting:config:hotkey")
  assert.equal(hot.typeLabel, "Alt+Space")

  const filtered = SettingsView.rowsFor(general, config, "hotkey")
  assert.deepEqual(filtered.map(r => r.id), ["setting:config:hotkey"])

  const modeDef = SettingsView.find("setting:general:windowMode")
  assert.equal(SettingsView.cycle(modeDef, "expanded"), "compact")
  assert.equal(SettingsView.cycle(modeDef, "compact"), "expanded")
  const boolDef = SettingsView.find("setting:config:keepVisibleOnFocusLoss")
  assert.equal(SettingsView.cycle(boolDef, false), true)
  const zoomDef = SettingsView.find("setting:general:uiZoom")
  assert.equal(SettingsView.cycle(zoomDef, 1.5), 0.8)        // presets wrap
  assert.equal(SettingsView.format(SettingsView.find("setting:general:popToRootTimeout"), 0), "Off")
  const escDef = SettingsView.find("setting:general:escapeKeyBehavior")
  assert.equal(SettingsView.format(escDef, "close-and-pop-to-root"), "Close and Pop to Root")
  assert.equal(SettingsView.find("setting:general:windowMode").scope, "general")
  assert.equal(SettingsView.find("setting:config:hotkey").scope, "config")
  assert.equal(SettingsView.find("setting:nope:nope"), null)
})

test("file search provider is a config setting with two values", () => {
  const Schema = require("../../plugin/core/Schema.js")
  assert.equal(Schema.validConfigValue("fileSearchProvider", "built-in"), true)
  assert.equal(Schema.validConfigValue("fileSearchProvider", "everything"), true)
  assert.equal(Schema.validConfigValue("fileSearchProvider", "locator"), false)
  assert.equal(Schema.withConfigDefaults({}).fileSearchProvider, "built-in")
  assert.equal(Schema.withConfigDefaults({ fileSearchProvider: "everything" }).fileSearchProvider, "everything")
  const def = SettingsView.find("setting:config:fileSearchProvider")
  assert.ok(def, "row exists")
  assert.equal(def.scope, "config")
  assert.equal(SettingsView.cycle(def, "built-in"), "everything")
  assert.equal(SettingsView.cycle(def, "everything"), "built-in")
  assert.equal(SettingsView.format(def, "built-in"), "Built-in Index")
  assert.equal(SettingsView.format(def, "everything"), "Everything")
  const rows = SettingsView.rowsFor({}, { fileSearchProvider: "everything" }, "provider")
  assert.ok(rows.some(r => r.id === "setting:config:fileSearchProvider"), "searchable by label")
})

// ------------------------------------------------- backend integration
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oma-cast-feat-"))
  const paths = {
    home: root, config: path.join(root, "config"), configFile: path.join(root, "config", "config.json"),
    scriptCommands: "", data: path.join(root, "data"), db: path.join(root, "data", "db"),
    extensions: "", extensionSupport: "", clipboard: "", notesAttachments: "",
    cache: path.join(root, "cache"), state: path.join(root, "state"), logs: "", backups: "", runtime: ""
  }
  const calls = { copy: [], openPath: [], reveal: [], openExternal: [], configChanged: 0, power: [], cancelPower: 0 }
  const host = {
    copy: t => calls.copy.push(t),
    openPath: p => calls.openPath.push(p),
    reveal: p => calls.reveal.push(p),
    openExternal: u => calls.openExternal.push(u),
    pasteText: () => {},
    checkCommand: (e, cb) => cb(true),
    configChanged: () => { calls.configChanged++ },
    power: (kind, delay) => calls.power.push([kind, delay]),
    cancelPower: () => { calls.cancelPower++ }
  }
  const fileIndex = {
    entries: [
      { p: path.join(root, "Documents", "report.txt"), n: "report.txt", d: false, m: 5000 },
      { p: path.join(root, "Documents"), n: "Documents", d: true, m: 1 }
    ],
    ready: true, loading: false, lastIndexedAt: Date.now(),
    start() {}, refreshIfStale() {}, setIncludeHidden() {},
    on(ev, cb) { (this._l || (this._l = {}))[ev] = cb }
  }
  const procs = {
    rows: [
      { pid: 4242, name: "chrome", ws: 512 * 1048576, path: "C:/chrome.exe" },
      { pid: 555, name: "slack", ws: 128 * 1048576, path: "" },
      { pid: 9999, name: "oma-cast", ws: 1, path: "" }
    ],
    loading: false, at: Date.now(), killed: [], refreshed: 0,
    refresh(force) { this.refreshed++; if (force) this.at = Date.now(); return Promise.resolve(this.rows) },
    remove(pid) { this.rows = this.rows.filter(r => r.pid !== Number(pid)) },
    kill(pid) { this.killed.push(pid); return { ok: pid !== 1, message: "" } },
    on() {}
  }
  const backend = createBackend({ paths, host, fileIndex, processes: procs, apps: null }).start()
  return { backend, paths, calls, fileIndex, procs, root }
}

test("backend: Files section lands after Results and file actions dispatch", () => {
  const { backend, calls, root } = setup()
  const r = backend.callSync("rootSearch.search", { query: "report", view: null, filter: "all" })
  assert.equal(r.ok, true)
  const ids = r.data.map(s => s.id)
  assert.ok(ids.includes("files"), "Files section present: " + ids.join(","))
  if (ids.includes("results")) assert.ok(ids.indexOf("files") > ids.indexOf("results"))
  const file = r.data.find(s => s.id === "files").rows[0]
  assert.equal(file.id, "file:" + path.join(root, "Documents", "report.txt"))

  // One-character queries stay a commands/apps search (noise guard).
  const short = backend.callSync("rootSearch.search", { query: "r", view: null, filter: "all" })
  assert.ok(!short.data.some(s => s.id === "files"))

  const actions = backend.callSync("rootSearch.getActions", { id: file.id })
  assert.deepEqual(actions.data.map(a => a.id), ["open", "reveal", "copy-path"])
  const open = backend.callSync("rootSearch.performAction", { id: file.id, action: "open", query: "report", confirmed: true })
  assert.equal(open.data.close, true)
  assert.deepEqual(calls.openPath, [path.join(root, "Documents", "report.txt")])
  const copy = backend.callSync("rootSearch.performAction", { id: file.id, action: "copy-path", query: "report", confirmed: true })
  assert.deepEqual(calls.copy, [path.join(root, "Documents", "report.txt")])
  const info = backend.callSync("rootSearch.getItemInfo", { id: file.id, query: "" })
  assert.equal(info.data[0].label, "Path")
  backend.dispose()
})

test("backend: the Settings view lists, cycles and persists values", () => {
  const { backend, paths, calls } = setup()
  const r = backend.callSync("rootSearch.search", { query: "", view: { kind: "settings", title: "Settings" }, filter: "all" })
  assert.equal(r.ok, true)
  const rows = r.data[0].rows
  assert.ok(rows.some(x => x.id === "setting:general:windowMode"))
  assert.ok(rows.some(x => x.id === "setting:config:hotkey"))

  // ↵ cycles windowMode through the validated store path.
  const cycle = backend.callSync("rootSearch.performAction", { id: "setting:general:windowMode", action: "open", query: "", confirmed: true })
  assert.match(cycle.data.toast.title, /Window Mode: Compact/)
  const general = backend.callSync("settings.getGeneralSettings", null)
  assert.equal(general.data.windowMode, "compact")

  // Hotkey writes config.json and pokes main to re-register.
  const hot = backend.callSync("rootSearch.performAction", { id: "setting:config:hotkey", action: "open", query: "", confirmed: true })
  assert.match(hot.data.toast.title, /Global Hotkey: Alt\+K/)
  const written = JSON.parse(fs.readFileSync(paths.configFile, "utf8"))
  assert.equal(written.hotkey, "Alt+K")
  assert.equal(calls.configChanged, 1)

  const actions = backend.callSync("rootSearch.getActions", { id: "setting:config:hotkey" })
  assert.deepEqual(actions.data.map(a => a.id), ["open"])
  const info = backend.callSync("rootSearch.getItemInfo", { id: "setting:general:uiZoom", query: "" })
  assert.equal(info.data[2].value, "settings.json")
  backend.dispose()
})

test("backend: Kill Process confirms, kills, removes and toasts", () => {
  const { backend, procs } = setup()
  const r = backend.callSync("rootSearch.search", { query: "", view: { kind: "processes", title: "Kill Process" }, filter: "all" })
  assert.equal(r.ok, true)
  const rows = r.data[0].rows
  assert.equal(rows[0].id, "process:4242")                 // biggest working set first
  assert.equal(rows[0].typeLabel, "512 MB")
  assert.equal(rows[0].subtitle, "PID 4242")

  // Actions come first, while the rows are still live: kill, reveal only
  // when a path exists, copy pid.
  const actsChrome = backend.callSync("rootSearch.getActions", { id: "process:4242" })
  assert.deepEqual(actsChrome.data.map(a => a.id), ["open", "reveal", "copy-pid"])
  const actsSlack = backend.callSync("rootSearch.getActions", { id: "process:555" })
  assert.deepEqual(actsSlack.data.map(a => a.id), ["open", "copy-pid"])

  // Enter asks first (destructive alert).
  const confirm = backend.callSync("rootSearch.performAction", { id: "process:4242", action: "open", query: "", confirmed: false })
  assert.equal(confirm.ok, true)
  assert.equal(confirm.data.confirm.destructive, true)
  assert.match(confirm.data.confirm.title, /Kill chrome\?/)
  assert.equal(procs.killed.length, 0, "nothing killed before confirmation")

  const killed = backend.callSync("rootSearch.performAction", { id: "process:4242", action: "open", query: "", confirmed: true })
  assert.match(killed.data.toast.title, /chrome \(4242\) killed/)
  assert.deepEqual(procs.killed, [4242])
  assert.ok(!procs.rows.some(x => x.pid === 4242), "row removed optimistically")

  const pidCopy = backend.callSync("rootSearch.performAction", { id: "process:555", action: "copy-pid", query: "", confirmed: true })
  assert.match(pidCopy.data.toast.title, /PID 555 copied/)

  // Filtering by name and by pid.
  const filtered = backend.callSync("rootSearch.search", { query: "sla", view: { kind: "processes" }, filter: "all" })
  assert.deepEqual(filtered.data[0].rows.map(x => x.pid), [555])
  const byPid = backend.callSync("rootSearch.search", { query: "9999", view: { kind: "processes" }, filter: "all" })
  assert.deepEqual(byPid.data[0].rows.map(x => x.pid), [9999])
  backend.dispose()
})

// ------------------------------------------------------ windows settings
test("Windows Settings: builtin, page table and category sections", () => {
  const WS = require("./windows-settings")
  const cmd = RS.BUILTINS.find(b => b.id === "builtin:windows-settings")
  assert.equal(cmd.run.push.kind, "windows-settings")
  assert.equal(cmd.glyph.codePointAt(0), 0xf17a)           // nf-fa-windows
  assert.equal(cmd.platform, "windows")
  assert.equal(RS.BUILTINS.find(b => b.id === "builtin:kill-process").platform, "windows")
  assert.equal(RS.BUILTINS.find(b => b.id === "builtin:settings").platform, undefined)

  const uris = WS.rows("").map(r => r.id)
  assert.equal(new Set(uris).size, uris.length, "no duplicate pages")
  assert.ok(WS.rows("windows update").some(r => r.id === "winset:ms-settings:windowsupdate"))
  assert.ok(WS.rows("theme").some(r => r.id === "winset:ms-settings:personalization-themes"))
  assert.deepEqual(WS.rows("no-such-page"), [])
  assert.equal(WS.find("ms-settings:personalization-themes").category, "Personalization")
  assert.equal(WS.find("ms-settings:nope"), null)
  assert.deepEqual(WS.actionsFor().map(a => a.id), ["open"])

  const secs = WS.sections("")
  assert.ok(secs.length >= 10, "one section per category")
  assert.ok(secs.every(s => s.rows.length > 0 && s.title))
  const flat = secs.flatMap(s => s.rows.map(r => r.id))
  assert.equal(flat.length, uris.length, "sections cover every page")
  assert.equal(WS.sections("bluetooth").length, 1, "a query narrows the sections too")
})

test("backend: Windows Settings leads the Settings view and opens a page", () => {
  const { backend, calls } = setup()

  // The launcher's own Settings view opens with "Windows Settings".
  const s = backend.callSync("rootSearch.search", { query: "", view: { kind: "settings" }, filter: "all" })
  assert.equal(s.data[0].rows[0].id, "builtin:windows-settings")
  const filtered = backend.callSync("rootSearch.search", { query: "hotkey", view: { kind: "settings" }, filter: "all" })
  assert.ok(!filtered.data[0].rows.some(r => r.id === "builtin:windows-settings"))
  assert.ok(filtered.data[0].rows.some(r => r.id === "setting:config:hotkey"))

  // The pushed view: searchable, grouped, row actions and info.
  const w = backend.callSync("rootSearch.search", { query: "theme", view: { kind: "windows-settings" }, filter: "all" })
  const wids = w.data.flatMap(sec => sec.rows.map(r => r.id))
  assert.ok(wids.includes("winset:ms-settings:personalization-themes"))
  const acts = backend.callSync("rootSearch.getActions", { id: "winset:ms-settings:personalization-themes" })
  assert.deepEqual(acts.data.map(a => a.id), ["open"])
  const info = backend.callSync("rootSearch.getItemInfo", { id: "winset:ms-settings:windowsupdate", query: "" })
  assert.equal(info.data[0].value, "Windows Update")
  assert.equal(info.data[2].value, "ms-settings:windowsupdate")

  // ↵ hands the URI to the shell, no confirmation (not destructive).
  const open = backend.callSync("rootSearch.performAction", { id: "winset:ms-settings:personalization-themes", action: "open", query: "", confirmed: false })
  assert.equal(open.data.close, true)
  assert.match(open.data.hud, /Themes/)
  assert.deepEqual(calls.openExternal, ["ms-settings:personalization-themes"])

  // The builtin row pushes the list like any other command.
  const push = backend.callSync("rootSearch.performAction", { id: "builtin:windows-settings", action: "open", query: "", confirmed: false })
  assert.equal(push.data.push.kind, "windows-settings")
  backend.dispose()
})

test("backend: power actions fire immediately and close", () => {
  const { backend, calls } = setup()

  // Unconfirmed → the destructive alert.
  const confirm = backend.callSync("rootSearch.performAction", { id: "builtin:shutdown", action: "open", query: "", confirmed: false })
  assert.equal(confirm.data.confirm.destructive, true)
  assert.deepEqual(calls.power, [])

  // Confirmed → shutdown.exe /s /t 0, window closes with a HUD line.
  const sd = backend.callSync("rootSearch.performAction", { id: "builtin:shutdown", action: "open", query: "", confirmed: true })
  assert.equal(sd.data.close, true)
  assert.equal(sd.data.hud, "Shutting down…")
  assert.deepEqual(calls.power, [["shutdown", 0]])

  // Restart uses /r, same immediate close.
  const rs = backend.callSync("rootSearch.performAction", { id: "builtin:restart", action: "open", query: "", confirmed: true })
  assert.equal(rs.data.close, true)
  assert.equal(rs.data.hud, "Restarting…")
  assert.deepEqual(calls.power[1], ["restart", 0])

  // Legacy Cancel entrypoint still answers (old toasts call it).
  const cancelled = backend.callSync("system.cancelPowerShutdown", null)
  assert.equal(cancelled.ok, true)
  assert.equal(calls.cancelPower, 1)

  // Sleep: no confirmation, closes the window with a HUD line.
  const sl = backend.callSync("rootSearch.performAction", { id: "builtin:sleep", action: "open", query: "", confirmed: false })
  assert.equal(sl.data.close, true)
  assert.equal(sl.data.hud, "Sleeping…")
  assert.deepEqual(calls.power[2], ["sleep", 0])

  // Power actions never record frecency (they stay out of Suggestions).
  const freq = backend.callSync("frecency.get", { id: "builtin:shutdown" })
  assert.equal(freq.data, null)
  backend.dispose()
})

// ---------------------------------------------------------------- themes
test("themes: the bundled copy, the user's place for themes, and fallback", () => {
  const themes = require("./themes")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oma-themes-"))
  const bundled = path.join(root, "bundled")
  const user = path.join(root, "user")
  fs.mkdirSync(path.join(bundled, "tokyo-night"), { recursive: true })
  fs.mkdirSync(path.join(user, "my-theme"), { recursive: true })
  fs.mkdirSync(path.join(user, "not-a-theme"), { recursive: true })   // no colors.toml
  fs.writeFileSync(path.join(bundled, "tokyo-night", "colors.toml"), 'background = "#1a1b26"\n')
  fs.writeFileSync(path.join(bundled, "shell.toml.tpl"), "menu_bg = {{ background }}")
  fs.writeFileSync(path.join(user, "my-theme", "colors.toml"), 'background = "#282828"\n')
  const opts = { bundledDir: bundled, userDir: user }

  assert.deepEqual(themes.listThemes(opts).map(t => [t.name, t.source]),
    [["tokyo-night", "bundled"], ["my-theme", "user"]])
  const mine = themes.resolve("my-theme", opts)
  assert.equal(mine.source, "user")
  assert.match(mine.shellRaw, /#282828/, "template rendered against the theme")
  assert.equal(themes.resolve("does-not-exist", opts).name, "tokyo-night")
  assert.deepEqual(themes.listThemes({ bundledDir: "", userDir: path.join(root, "nope") }), [])
})

test("backend: the Theme row cycles the themes on disk and announces the change", () => {
  const { backend, paths } = setup()
  // Dropping a theme into the user's place for themes is enough: no rebuild.
  const userTheme = path.join(paths.config, "themes", "gruvbox")
  fs.mkdirSync(userTheme, { recursive: true })
  fs.writeFileSync(path.join(userTheme, "colors.toml"), 'background = "#282828"\n')

  const rows = backend.callSync("rootSearch.search", { query: "theme", view: { kind: "settings" }, filter: "all" })
  const row = rows.data[0].rows.find(r => r.id === "setting:config:theme")
  assert.ok(row, "theme row present")
  assert.equal(row.typeLabel, "tokyo-night")
  assert.match(row.subtitle, /oma-cast\\themes/)

  const seen = []
  const off = backend.onNotification((m, d) => seen.push([m, d]))
  const cycle = backend.callSync("rootSearch.performAction", { id: "setting:config:theme", action: "open", query: "", confirmed: true })
  assert.match(cycle.data.toast.title, /Theme: gruvbox/)
  const written = JSON.parse(fs.readFileSync(paths.configFile, "utf8"))
  assert.equal(written.theme, "gruvbox")
  assert.ok(seen.some(([m, d]) => m === "settings.configChanged" && d.key === "theme"), "renderer is told to repaint")

  const list = backend.callSync("themes.list", null)
  assert.deepEqual(list.data.map(t => t.name).sort(), ["gruvbox", "tokyo-night"])
  const res = backend.callSync("themes.resolve", { name: "gruvbox" })
  assert.deepEqual(res.data, { name: "gruvbox", source: "user" })
  if (typeof off === "function") off()
  backend.dispose()
})

// ------------------------------------------------------- icons and caret
test("icons: paths are interpolated into the script, never trailing -Command args", () => {
  const apps = require("./apps")
  assert.ok(!apps.ICON_SCRIPT.includes("$args"), "powershell.exe joins -Command args into the script text")
  const script = apps.ICON_SCRIPT
    .replace("{{src}}", apps.psQuote("C:\\Users\\Jemo O'Brien\\Launcher.lnk"))
    .replace("{{out}}", apps.psQuote("C:\\cache\\icons\\a.png"))
  assert.match(script, /'C:\\Users\\Jemo O''Brien\\Launcher\.lnk'/)
  assert.match(script, /\.lnk/, "resolves a Start Menu link to its target first")
  assert.equal(apps.fileUrl("C:\\Users\\J D\\cache\\icons\\a.png"),
    "file:///C:/Users/J%20D/cache/icons/a.png")
})

test("the caret blinks on the QML's 530 ms half-periods", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "ui", "style.css"), "utf8")
  assert.match(css, /@keyframes caret-blink/)
  assert.match(css, /animation: caret-blink 1060ms step-end infinite/)
  assert.match(css, /\.pill \.pill-caret \{ animation: caret-blink/)
  // LauncherWindow.qml: NumberAnimation to 1, pause 530, to 0, pause 530.
  const qml = fs.readFileSync(path.join(__dirname, "..", "..", "plugin", "ui", "LauncherWindow.qml"), "utf8")
  const pauses = [...qml.matchAll(/PauseAnimation \{ duration: (\d+) \}/g)].map(m => Number(m[1]))
  assert.ok(pauses.includes(530), "the QML caret's half-period is still 530")
})

// --------------------------------------- services the window must hand over
test("the window wires the services the pushed views read", () => {
  const appSrc = fs.readFileSync(path.join(__dirname, "..", "ui", "app.js"), "utf8")
  assert.match(appSrc, /processes:\s*processesLib\.createProcesses\(/, "Kill Process gets its snapshot service")
  assert.match(appSrc, /fileIndex:\s*fileIndexLib\.createFileIndex\(/, "Files gets its index")
  assert.match(appSrc, /excludePaths:\s*\[process\.execPath\]/, "the launcher's own processes stay out of the list")
  const keysSrc = fs.readFileSync(path.join(__dirname, "..", "ui", "keys.js"), "utf8")
  assert.match(keysSrc, /backend\.visibility\(visible\)/, "show refreshes rates, apps and files")
  // The backend only fills these views when it holds the service; without
  // them the pushed view is empty and the tests still pass, because they
  // inject one. Guard the wiring, not just the service.
  const procs = require("./processes")
  const apps = require("./apps")
  assert.match(procs.LIST_SCRIPT, /OutputEncoding.*UTF8/, "the snapshot decodes as UTF-8")
  assert.match(apps.SCAN_SCRIPT, /OutputEncoding.*UTF8/, "…and so does the Start Menu scan")
  assert.ok(!apps.SCAN_SCRIPT.includes("$args"), "no trailing -Command arguments")
})

// ------------------------------------- Open at Login and the focus hand-back
test("Open at Login: a config row wired to main's login item", () => {
  const Schema = require("../../plugin/core/Schema.js")
  assert.equal(Schema.configDefaults.openAtLogin, false, "off by default")
  assert.equal(Schema.validConfigValue("openAtLogin", true), true)
  assert.equal(Schema.validConfigValue("openAtLogin", "true"), false)

  const def = SettingsView.find("setting:config:openAtLogin")
  assert.ok(def, "settings row present")
  assert.equal(def.scope, "config")
  assert.equal(def.type, "bool")
  assert.equal(SettingsView.cycle(def, undefined), true)
  assert.equal(SettingsView.format(def, false), "Off")
  // The hint must not steal the "hotkey" filter from the hotkey row.
  assert.deepEqual(SettingsView.rowsFor({}, {}, "hotkey").map(r => r.id), ["setting:config:hotkey"])

  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8")
  assert.match(mainSrc, /setLoginItemSettings\(/, "main registers the exe with Windows")
  assert.match(mainSrc, /applyOpenAtLogin\(\)/, "…at start and on every config change")
})

test("toggling Open at Login writes config.json and tells main", () => {
  const { backend, paths, calls } = setup()
  const before = calls.configChanged
  const r = backend.callSync("rootSearch.performAction", { id: "setting:config:openAtLogin", action: "open", query: "", confirmed: true })
  assert.equal(r.ok, true)
  assert.equal(r.data.toast.title, "Open at Login: On")
  const written = JSON.parse(fs.readFileSync(paths.configFile, "utf8"))
  assert.equal(written.openAtLogin, true)
  assert.ok(calls.configChanged > before, "main is told to register the login item")
  backend.dispose()
})

test("an edit of config.json on disk also reaches main", async () => {
  const { backend, paths, calls } = setup()
  const before = calls.configChanged
  fs.mkdirSync(paths.config, { recursive: true })
  fs.writeFileSync(paths.configFile, JSON.stringify({ hotkey: "Ctrl+Space" }))
  await new Promise(r => setTimeout(r, 400))
  assert.ok(calls.configChanged > before, "the config watch tells main to re-apply hotkey + login item")
  backend.dispose()
})

test("closing hands the foreground back to the window we took it from", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8")
  assert.match(mainSrc, /win\.showInactive\(\)/, "we map without activating, so the capture samples them")
  assert.match(mainSrc, /FOCUS_HELPER_SCRIPT/, "one resident PowerShell helper answers ping/getfg/focus")
  assert.match(mainSrc, /function hide\(afterFocus\)/, "hide waits for the hand-back before Ctrl+V")
  // Blur: the clicked window already holds focus, so it must not be stolen back.
  // (\r?\n: Windows runners check the repo out with CRLF.)
  assert.match(mainSrc, /prevFh = null\r?\n    if \(!readConfig\(\)\.keepVisibleOnFocusLoss\)/,
    "blur clears the restore target before the dismiss")
})

test("the app library also covers Desktop and Store/MSIX apps", () => {
  const apps = require("./apps")
  assert.match(apps.SCAN_SCRIPT, /shell:AppsFolder/, "Store rows enumerate the AppsFolder")
  assert.match(apps.SCAN_SCRIPT, /Get-StartApps/)
  assert.match(apps.SCAN_SCRIPT, /GetFolderPath\('Desktop'\)/, "Desktop shortcuts count too")
  assert.match(apps.SCAN_SCRIPT, /\$env:PUBLIC/, "…including the public Desktop")
  assert.ok(!apps.SCAN_SCRIPT.includes("$args"), "no trailing -Command arguments")
  assert.equal(apps.launchArg("C:\\links\\Notion.lnk"), "C:\\links\\Notion.lnk")
  assert.equal(apps.launchArg("uwp:Notion_abc123!App"), "shell:AppsFolder\\Notion_abc123!App")
})

test("the app library also covers App Paths registrations", () => {
  const apps = require("./apps")
  assert.match(apps.SCAN_SCRIPT, /App Paths/, "registered exes without shortcuts resolve too")
  assert.match(apps.SCAN_SCRIPT, /HKCU:[^']*App Paths/, "…in both registry hives")
  assert.ok(!/Start Menu\\Programs/.test(apps.SCAN_SCRIPT), "the Start Menu roots are walked, not just Programs")
  assert.ok(!apps.SCAN_SCRIPT.includes("$args"), "no trailing -Command arguments")
  assert.equal(apps.launchArg("C:\\Tools\\app.exe"), "C:\\Tools\\app.exe")
})

// ------------------------------------------------------- take me there
test("opening an app switches to its existing window instead of a second instance", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oma-cast-switch-"))
  const paths = {
    home: root, config: path.join(root, "config"), configFile: path.join(root, "config", "config.json"),
    scriptCommands: "", data: path.join(root, "data"), db: path.join(root, "data", "db"),
    extensions: "", extensionSupport: "", clipboard: "", notesAttachments: "",
    cache: path.join(root, "cache"), state: path.join(root, "state"), logs: "", backups: "", runtime: ""
  }
  const notionId = "C:\\links\\Notion.lnk"
  const uwpId = "uwp:Notion_abc!App"
  const wrapperId = "C:\\links\\Tools.lnk"
  const apps = {
    entries: [
      { id: notionId, name: "Notion", icon: "", target: "C:\\Users\\x\\AppData\\Local\\Programs\\Notion\\Notion.exe", keywords: [] },
      { id: uwpId, name: "Notion Store", icon: "", target: "", keywords: [] },
      { id: wrapperId, name: "Tools", icon: "", target: "C:\\Windows\\System32\\cmd.exe", keywords: [] }
    ],
    loading: false, launched: [], focusRequested: null,
    on() {}, refresh() { return Promise.resolve(this.entries) },
    launch(id) { this.launched.push(id) }, iconSource() { return Promise.resolve("") }
  }
  const host = { focusAppWindow: (name, cb) => { apps.focusRequested = name; cb(host.taken) }, taken: true }
  const backend = createBackend({ paths, host, apps }).start()

  // An instance with a window wins: looked up by the shortcut target's
  // exe name, never launched again.
  const r = backend.callSync("rootSearch.performAction", { id: "app:" + notionId, action: "open", query: "", confirmed: true })
  assert.equal(r.ok, true)
  assert.equal(r.data.close, true)
  assert.equal(apps.focusRequested, "Notion", "asked main for the running process")
  assert.deepEqual(apps.launched, [], "the existing window wins")

  // Nothing running (or no window) → the normal launch.
  host.taken = false
  backend.callSync("rootSearch.performAction", { id: "app:" + notionId, action: "open", query: "", confirmed: true })
  assert.deepEqual(apps.launched, [notionId])

  // Store rows carry no path: the package family prefix is the guess at
  // the process name — taken → switch with no launch; the not-running
  // half falls through to the normal AppsFolder launch.
  host.taken = true
  apps.focusRequested = null
  backend.callSync("rootSearch.performAction", { id: "app:" + uwpId, action: "open", query: "", confirmed: true })
  assert.equal(apps.focusRequested, "Notion", "asked with the family prefix")
  assert.deepEqual(apps.launched, [notionId], "a running Store app switches, not launches")

  host.taken = false
  backend.callSync("rootSearch.performAction", { id: "app:" + uwpId, action: "open", query: "", confirmed: true })
  assert.deepEqual(apps.launched, [notionId, uwpId], "…and not running, it launches")

  // Wrapper shortcuts (target = cmd/explorer, the real app lives in the
  // arguments we do not parse) never ask: they would "find" the desktop.
  apps.focusRequested = null
  backend.callSync("rootSearch.performAction", { id: "app:" + wrapperId, action: "open", query: "", confirmed: true })
  assert.equal(apps.focusRequested, null, "wrapper targets are not switch candidates")
  assert.deepEqual(apps.launched, [notionId, uwpId, wrapperId])

  backend.dispose()
})

test("the switch routes through main and suppresses the close hand-back", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8")
  const at = mainSrc.indexOf('ipcMain.on("host-focus-app"')
  assert.ok(at >= 0, "main owns the request")
  const handler = mainSrc.slice(at)
  // The close arrives right after the switch request: without this the
  // hand-back would steal focus back from the app we just switched to.
  assert.match(handler, /prevFh = null/, "the close that follows hands nothing back")
  assert.match(handler, /focusHelperAsk\("app "/, "the warm helper does the lookup")
  assert.match(handler, /app switch answer/, "the decision lands in main.log for live diagnosis")
  assert.match(mainSrc, /IsIconic\(IntPtr/, "a minimized window is restored before focusing")
  assert.match(mainSrc, /\^app \.[+]/, "the helper understands the app command")
  const hostSrc = fs.readFileSync(path.join(__dirname, "..", "src", "host.js"), "utf8")
  assert.match(hostSrc, /focusAppWindow/, "the renderer adapter exists")
  assert.match(hostSrc, /2500/, "…and answers false rather than swallowing a launch")
})

// The live machine caught this one: Add-Type got ONE [DllImport] for six
// extern methods, so the type never compiled, every helper command threw
// and answered "err", and main read that as "not running" — every ↵
// launched a duplicate (0.2.0/0.2.1). [D]
test("every extern carries its own DllImport — one attribute fails Add-Type entirely", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8")
  // Strip // comments first — the fix is explained in them, bracket and all.
  const code = mainSrc.replace(/^\s*\/\/.*$/gm, "")
  const externs = (code.match(/static extern/g) || []).length
  const imports = (code.match(/\[DllImport/g) || []).length
  assert.ok(externs >= 8, "paste + steal + the helper's imports: " + externs)
  assert.equal(imports, externs,
    "a C# attribute covers only the next declaration; Add-Type refuses to compile the rest, " +
    "the helper's catch prints err, and every app switch falls back to a duplicate instance")
  // The steal interpolates a validated integer handle: powershell.exe
  // joins trailing -Command arguments into the script text, so $args
  // never binds (the apps.js lesson — it broke this path twice).
  assert.ok(!code.includes("$args"), "no $args in main.js code")
  assert.match(mainSrc, /function focusScript\(/)
})

test("Kill Process: the snapshot drops the launcher's own processes", async () => {
  const { createProcesses, LIST_SCRIPT } = require("./processes")
  const rows = [
    { pid: 777, name: "oma-cast", ws: 9999, path: "" },
    { pid: 9001, name: "oma-cast", ws: 9, path: "C:\\Apps\\oma-cast\\oma-cast.exe" },
    { pid: 9002, name: "oma-cast", ws: 8, path: "c:/apps/oma-cast/OMA-CAST.EXE" },
    { pid: 4242, name: "chrome", ws: 500, path: "C:\\Program Files\\chrome.exe" },
    { pid: 10, name: "system", ws: 1, path: "" }
  ]
  const svc = createProcesses({
    ownPid: 777,
    excludePaths: ["C:\\Apps\\oma-cast\\oma-cast.exe"],
    execFile: (bin, args, opts, cb) => cb(null, JSON.stringify(rows))
  })
  await svc.refresh(true)
  assert.deepEqual(svc.rows.map(r => r.pid), [4242, 10], "biggest first, own pid and own exe gone")
  assert.ok(!LIST_SCRIPT.includes("$args"), "powershell.exe joins -Command args into the script text")
})

// --------------------------------------------------------------- text elide
test("Text.ElideLeft keeps the tail and never reorders the query", () => {
  const { elideLeft } = require("./text")
  const m = t => t.length * 8                       // 8 px per character

  // The bug: `direction: rtl` (the left-ellipsis CSS trick) flipped any
  // query whose first strong character is not LTR — "1 rem to px" read
  // back as "rem to px 1".
  assert.equal(elideLeft("1 rem to px", 1000, m), "1 rem to px")
  assert.equal(elideLeft("16 px to rem", 1000, m), "16 px to rem")
  assert.equal(elideLeft("1 rem to px", 11 * 8, m), "1 rem to px")   // exactly fits

  // Out of room: the front is cut, the tail stays, "…" marks the cut.
  assert.equal(elideLeft("1 rem to px", 56, m), "… to px")
  assert.equal(elideLeft("hello", 4, m), "…", "only room for the mark")
  assert.equal(elideLeft("hello", 0, m), "", "no room at all")
  assert.equal(elideLeft("", 56, m), "")
})

test("the query, pills and panel filter are LTR (the rtl trick reordered them)", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "ui", "style.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")                       // ignore comments
  assert.ok(!/direction:\s*rtl/.test(css), "no direction: rtl left in the UI")
  const appSrc = fs.readFileSync(path.join(__dirname, "..", "ui", "app.js"), "utf8")
  assert.match(appSrc, /elideLeft\(full, queryW/, "the query elides through src/text.js")
  const viewSrc = fs.readFileSync(path.join(__dirname, "..", "ui", "view.js"), "utf8")
  assert.match(viewSrc, /elideLeft\(filterText/, "so does the action-panel filter")
})
