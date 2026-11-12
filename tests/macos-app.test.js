const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const M = {}
for (const name of ["Rpc", "Paths", "Log", "Schema", "Migrate", "Ranker", "Frecency", "OmarchyMenu", "RootSearch", "Calculator", "Backend", "Store", "CalculatorData", "LauncherState"]) {
  M[name] = require("../core/" + name + ".js")
}
for (const name of ["MacCommands", "Themes"]) M[name] = require("../macos/js/" + name + ".js")
const App = require("../macos/js/App.js")

// A native layer backed by a temp HOME, with manual timers.
function fakeNative(home) {
  const calls = []
  const timers = new Map()
  let nextTimer = 1
  const native = {
    calls,
    timers,
    clipboard: "",
    env: (name) => (name === "HOME" ? home : ""),
    readFile: (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null),
    writeFile: (p, text) => { fs.writeFileSync(p, text, { mode: 0o600 }); return "" },
    mtime: (p) => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0),
    listDir: (p) => (fs.existsSync(p) ? fs.readdirSync(p) : []),
    ensurePrivateDirs: (dirs) => { for (const d of dirs) fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return "" },
    log: (line) => calls.push(["log", line]),
    copy: (text) => { native.clipboard = text; calls.push(["copy", text]) },
    paste: (text) => calls.push(["paste", text]),
    readClipboard: () => native.clipboard,
    openUrl: (url) => { calls.push(["openUrl", url]); return "" },
    openApp: (p) => { calls.push(["openApp", p]); return "" },
    launchNew: (p) => { calls.push(["launchNew", p]); return "" },
    runSystem: (name) => { calls.push(["runSystem", name]); return "" },
    later: (ms, fn) => { const id = nextTimer++; timers.set(id, { ms, fn }); return id },
    cancel: (id) => timers.delete(id),
    fetch: (url, fn) => calls.push(["fetch", url]),
    zoneOffsets: (names) => Object.fromEntries(names.map((n) => [n, 0])),
    hour12: () => false,
    changed: () => {},
    dismiss: () => calls.push(["dismiss"]),
    show: () => calls.push(["show"]),
    hud: (text) => calls.push(["hud", text]),
    quit: () => calls.push(["quit"]),
    runTimers: () => { for (const [id, t] of [...timers]) { timers.delete(id); t.fn() } }
  }
  return native
}

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omacast-mac-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const native = fakeNative(home)
  const app = App.create(native, M)
  app.setApps(JSON.stringify([
    { id: "org.mozilla.firefox", name: "Firefox", path: "/Applications/Firefox.app" },
    { id: "com.apple.finder", name: "Finder", path: "/System/Library/CoreServices/Finder.app" },
    { id: "com.apple.Safari", name: "Safari", path: "/Applications/Safari.app" }
  ]))
  app.shown("{}")
  return { app, native, home }
}

const state = (app) => JSON.parse(app.state())
const key = (app, k, mods) => app.key(JSON.stringify(Object.assign({ key: k, text: "", primary: false, control: false, alt: false, shift: false }, mods || {})))
const type = (app, text) => { for (const ch of text) key(app, ch === " " ? "Space" : ch.toLowerCase(), { text: ch }) }
const selected = (app) => { const s = state(app); return s.rows[s.selectedIndex] }

test("paths live under ~/Library and the stores are created private", (t) => {
  const { app, home, native } = setup(t)
  assert.equal(app.paths.db, home + "/Library/Application Support/omacast/db")
  assert.equal(app.paths.cache, home + "/Library/Caches/omacast")
  key(app, "Return")
  native.runTimers()
  const settings = path.join(app.paths.db, "settings.json")
  assert.ok(fs.existsSync(settings))
  assert.equal(fs.statSync(settings).mode & 0o777, 0o600)
})

test("empty root shows commands and applications without Omarchy items", (t) => {
  const { app } = setup(t)
  const s = state(app)
  const titles = s.rows.map((r) => r.title)
  assert.ok(titles.includes("Applications"))
  assert.ok(titles.includes("Lock Screen"))
  assert.ok(!titles.includes("Omarchy Menu"))
  assert.ok(!titles.includes("Wi-Fi Settings"), "settings panes only appear while searching")
})

test("typing finds an app; Enter opens it, records frecency and dismisses", (t) => {
  const { app, native } = setup(t)
  type(app, "fir")
  assert.equal(state(app).query, "fir")
  assert.equal(selected(app).title, "Firefox")
  key(app, "Return")
  assert.deepEqual(native.calls.filter((c) => c[0] === "openApp").at(-1), ["openApp", "/Applications/Firefox.app"])
  assert.ok(native.calls.some((c) => c[0] === "dismiss"))
  assert.equal(state(app).query, "", "a launch from root clears the query")
  native.runTimers()
  const frecency = JSON.parse(fs.readFileSync(path.join(app.paths.db, "frecency.json"), "utf8"))
  assert.ok(frecency.items["app:org.mozilla.firefox"])
})

test("Shift+Enter opens a new window; Cmd+Shift+C copies the bundle id", (t) => {
  const { app, native } = setup(t)
  type(app, "safari")
  key(app, "Return", { shift: true })
  assert.deepEqual(native.calls.filter((c) => c[0] === "launchNew").at(-1), ["launchNew", "/Applications/Safari.app"])
  type(app, "safari")
  key(app, "c", { primary: true, shift: true })
  assert.equal(native.clipboard, "com.apple.Safari")
})

test("Cmd+K opens the action panel with macOS labels and no Omarchy actions", (t) => {
  const { app } = setup(t)
  type(app, "firefox")
  key(app, "k", { primary: true })
  const popup = state(app).popup
  assert.equal(popup.kind, "actions")
  const titles = popup.actions.map((a) => a.title)
  assert.ok(titles.includes("Copy Bundle Identifier"))
  assert.ok(!titles.some((t) => /Omarchy/.test(t)))
  type(app, "fav")
  assert.equal(state(app).popup.actions[0].id, "favorite-add")
  key(app, "Return")
  assert.equal(state(app).popup, null)
  assert.equal(state(app).toast.title, "Added to Favorites")
})

test("Control+N/P navigate on macOS, and Cmd+K stays the action panel with vim motions", (t) => {
  const { app } = setup(t)
  const first = state(app).selectedIndex
  key(app, "n", { control: true })
  assert.ok(state(app).selectedIndex > first)
  key(app, "p", { control: true })
  assert.equal(state(app).selectedIndex, first)
  assert.equal(state(app).popup, null, "Control+P moves; it does not open the dropdown")
  key(app, "p", { primary: true })
  assert.equal(state(app).popup.kind, "dropdown")
  key(app, "Escape")
  JSON.parse(app.call("settings.updateGeneralSettings", JSON.stringify({ navigationBindings: "vim-motions" })))
  key(app, "j", { control: true })
  assert.ok(state(app).selectedIndex > first)
  key(app, "k", { primary: true })
  assert.equal(state(app).popup.kind, "actions")
  assert.equal(state(app).actionPanelKeys, "Ctrl K")
})

test("Restart asks first; Enter confirms and runs it", (t) => {
  const { app, native } = setup(t)
  type(app, "restart")
  assert.equal(selected(app).title, "Restart")
  key(app, "Return")
  assert.equal(state(app).alert.title, "Restart")
  assert.ok(!native.calls.some((c) => c[0] === "runSystem"))
  key(app, "Return")
  assert.deepEqual(native.calls.filter((c) => c[0] === "runSystem").at(-1), ["runSystem", "restart"])
})

test("omacast run skips the alert", (t) => {
  const { app, native } = setup(t)
  const r = JSON.parse(app.run("builtin:mac-lock"))
  assert.equal(r.ok, true)
  assert.deepEqual(native.calls.filter((c) => c[0] === "runSystem").at(-1), ["runSystem", "lock"])
})

test("the calculator row copies on Enter and pastes on Cmd+Enter", (t) => {
  const { app, native } = setup(t)
  type(app, "2+2")
  const s = state(app)
  assert.equal(s.rows[s.selectedIndex].rowKind, "calculator")
  assert.equal(s.rows[s.selectedIndex].calcResult, "4")
  key(app, "Return")
  assert.equal(native.clipboard, "4")
  assert.deepEqual(native.calls.filter((c) => c[0] === "hud").at(-1), ["hud", "Copied to Clipboard"])
  type(app, "3*3")
  key(app, "Return", { primary: true })
  assert.deepEqual(native.calls.filter((c) => c[0] === "paste").at(-1), ["paste", "9"])
  const history = JSON.parse(app.call("calculator.historyGetAll", "")).data
  assert.equal(history.length, 2)
})

test("Escape clears the query, then pops, then closes", (t) => {
  const { app, native } = setup(t)
  type(app, "calc")
  const row = state(app).rows.findIndex((r) => r.title === "Calculator History")
  app.click(row)
  assert.equal(state(app).view.kind, "calculator-history")
  key(app, "Escape")
  assert.equal(state(app).atRoot, true)
  assert.equal(state(app).query, "calc")
  key(app, "Escape")
  assert.equal(state(app).query, "")
  key(app, "Escape")
  assert.ok(native.calls.some((c) => c[0] === "dismiss"))
})

test("web searches take an argument pill", (t) => {
  const { app, native } = setup(t)
  type(app, "search google")
  assert.equal(selected(app).itemId, "builtin:google-search")
  key(app, "Return")
  assert.equal(state(app).argFocus, 0, "Enter focuses the empty required pill")
  type(app, "cats")
  assert.equal(state(app).arguments[0].value, "cats")
  key(app, "Return")
  assert.deepEqual(native.calls.filter((c) => c[0] === "openUrl").at(-1), ["openUrl", "https://www.google.com/search?q=cats"])
})

test("backspace edits; Cmd+Backspace clears; Option+Backspace deletes a word", (t) => {
  const { app } = setup(t)
  type(app, "foo bar")
  key(app, "Backspace")
  assert.equal(state(app).query, "foo ba")
  key(app, "Backspace", { alt: true })
  assert.equal(state(app).query, "foo ")
  key(app, "Backspace", { primary: true })
  assert.equal(state(app).query, "")
  app.hidden()
  assert.equal(state(app).shown, false)
})

test("settings edited on disk are picked up on the next show", (t) => {
  const { app, native } = setup(t)
  type(app, "fir")
  key(app, "d", { alt: true, shift: true })
  native.runTimers()
  const file = path.join(app.paths.db, "settings.json")
  const doc = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(doc.commands["app:org.mozilla.firefox"].enabled, false)
  delete doc.commands["app:org.mozilla.firefox"]
  fs.writeFileSync(file, JSON.stringify(doc))
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(file, later, later)
  app.hidden()
  app.shown("{}")
  key(app, "Backspace", { primary: true })
  type(app, "fir")
  assert.equal(selected(app).title, "Firefox")
})

test("db files written by the Omarchy build load unchanged on macOS (MACOS.md M5)", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omacast-copy-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  // What the Linux JsonStore writes: migrated docs via Migrate.serialize.
  const linux = M.Paths.resolve((k) => (k === "HOME" ? home : ""))
  const mac = M.Paths.resolve((k) => (k === "HOME" ? home : ""), "darwin")
  assert.equal(linux.db, home + "/.local/share/omacast/db")
  const settings = M.Migrate.migrate(null, M.Schema.settingsMigrations, 0).doc
  settings.commands["app:org.mozilla.firefox"] = { alias: "ff", favoriteOrder: 0 }
  settings.general.navigationBindings = "vim-motions"
  const frecency = M.Migrate.migrate(null, M.Schema.frecencyMigrations, 0).doc
  frecency.items["app:org.mozilla.firefox"] = M.Frecency.recordVisit(null, Date.now(), "web")
  fs.mkdirSync(mac.db, { recursive: true })
  fs.writeFileSync(mac.db + "/settings.json", M.Migrate.serialize(settings))
  fs.writeFileSync(mac.db + "/frecency.json", M.Migrate.serialize(frecency))
  const native = fakeNative(home)
  const app = App.create(native, M)
  app.setApps(JSON.stringify([{ id: "org.mozilla.firefox", name: "Firefox", path: "/Applications/Firefox.app" }, { id: "com.apple.Safari", name: "Safari", path: "/Applications/Safari.app" }]))
  app.shown("{}")
  const s = state(app)
  assert.equal(s.rows[0].title, "Favorites")
  assert.equal(s.rows[1].title, "Firefox")
  type(app, "ff")
  assert.equal(selected(app).alias, "ff")
  assert.equal(JSON.parse(app.general()).navigationBindings, "vim-motions")
})

test("themes: Catppuccin built-ins, user files, and the system default", (t) => {
  const { app } = setup(t)
  assert.equal(state(app).theme, null, "the default follows the system")
  JSON.parse(app.call("settings.updateGeneralSettings", JSON.stringify({ theme: "catppuccin-mocha" })))
  assert.equal(state(app).theme.background, "#1e1e2e")
  assert.equal(state(app).theme.accent, "#cba6f7")
  const dir = app.paths.config + "/themes"
  fs.writeFileSync(dir + "/tokyo-night.json", JSON.stringify({ name: "Tokyo Night", appearance: "dark", colors: { background: "#1a1b26", text: "#c0caf5", accent: "#7aa2f7" } }))
  fs.writeFileSync(dir + "/broken.json", "{ nope")
  fs.writeFileSync(dir + "/Bad Name.json", "{}")
  const list = JSON.parse(app.themes())
  assert.ok(list.themes.some((x) => x.id === "tokyo-night" && !x.builtin))
  assert.ok(list.themes.some((x) => x.id === "catppuccin-latte" && x.builtin))
  assert.equal(list.errors.length, 2)
  JSON.parse(app.call("settings.updateGeneralSettings", JSON.stringify({ theme: "tokyo-night" })))
  const theme = state(app).theme
  assert.equal(theme.name, "Tokyo Night")
  assert.equal(theme.subtext, "#c0caf5b3", "missing colours are derived from text")
  JSON.parse(app.call("settings.updateGeneralSettings", JSON.stringify({ theme: "gone" })))
  assert.equal(state(app).theme, null, "an unknown theme falls back to the system look")
})

test("two apps with one bundle id both show, and copy their real bundle id", (t) => {
  const { app, native } = setup(t)
  app.setApps(JSON.stringify([
    { id: "com.mitchellh.ghostty@/Applications/Ghostty.app", bundleId: "com.mitchellh.ghostty", name: "Ghostty", path: "/Applications/Ghostty.app" },
    { id: "com.mitchellh.ghostty@/Applications/Ghostty Dev.app", bundleId: "com.mitchellh.ghostty", name: "Ghostty Dev", path: "/Applications/Ghostty Dev.app" }
  ]))
  key(app, "Backspace", { primary: true })
  type(app, "ghostty")
  const titles = state(app).rows.filter((r) => r.kind === "app").map((r) => r.title)
  assert.deepEqual(titles.sort(), ["Ghostty", "Ghostty Dev"])
  key(app, "c", { primary: true, shift: true })
  assert.equal(native.clipboard, "com.mitchellh.ghostty")
})
