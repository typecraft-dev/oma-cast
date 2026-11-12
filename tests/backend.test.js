const test = require("node:test")
const assert = require("node:assert/strict")
const Rpc = require("../core/Rpc.js")
const Schema = require("../core/Schema.js")
const Migrate = require("../core/Migrate.js")
const Ranker = require("../core/Ranker.js")
const Frecency = require("../core/Frecency.js")
const RootSearch = require("../core/RootSearch.js")
const Calculator = require("../core/Calculator.js")
const OmarchyMenu = require("../core/OmarchyMenu.js")
const Backend = require("../core/Backend.js")

const deps = { Rpc, Schema, Ranker, Frecency, RootSearch, Calculator, OmarchyMenu }

function store(migrations) {
  const s = { loaded: true, readOnly: false, lastError: "", doc: Migrate.migrate(null, migrations, 0).doc, writes: 0 }
  s.update = (mutator) => {
    const next = JSON.parse(JSON.stringify(s.doc))
    const result = mutator(next)
    s.doc = result === undefined ? next : result
    s.writes++
    return true
  }
  return s
}

function fakeHost(extra) {
  const calls = []
  const host = {
    version: "test",
    paths: { db: "/tmp/db" },
    startedAt: Date.now(),
    stores: {
      settings: store(Schema.settingsMigrations),
      frecency: store(Schema.frecencyMigrations),
      calculator: store(Schema.calculatorMigrations)
    },
    calculatorData: { rates: null, zones: {}, ratesFetchedAt: 0, fetchRates: () => calls.push(["fetchRates"]) },
    config: () => Schema.withConfigDefaults(null),
    hour12: () => false,
    ready: () => true,
    notify: (method, data) => calls.push(["notify", method, data]),
    info: () => ({ desktop: "test" }),
    copy: (text) => calls.push(["copy", text]),
    paste: (text) => calls.push(["paste", text]),
    openUrl: (url) => calls.push(["openUrl", url]),
    openApp: (c) => calls.push(["openApp", c.id]),
    launchApp: (c) => calls.push(["launchApp", c.id]),
    runSystem: (name) => { calls.push(["runSystem", name]) },
    summonPlugin: (id, payload) => calls.push(["summon", id, payload]),
    runShell: (command) => calls.push(["shell", command]),
    menuTree: () => null,
    calls
  }
  return Object.assign(host, extra || {})
}

function setup(extra) {
  const host = fakeHost(extra)
  const backend = Backend.create(host, deps)
  const apps = [{ id: "firefox", name: "Firefox" }, { id: "org.gnome.Nautilus", name: "Files" }]
  backend.setCandidates(apps.map(RootSearch.appCandidate).concat(RootSearch.BUILTINS.map(RootSearch.builtinCandidate), [
    RootSearch.builtinCandidate({ id: "builtin:lock", title: "Lock Screen", run: { system: "lock" } }),
    RootSearch.builtinCandidate({ id: "builtin:restart", title: "Restart", run: { system: "restart" },
      confirm: { title: "Restart", message: "Sure?", primary: "Restart" } })
  ]))
  return { host, backend }
}

const ok = (r) => { assert.equal(r.ok, true, r.error); return r.data }

test("system.info merges host fields and lists methods", () => {
  const { backend } = setup()
  const info = ok(backend.callSync("system.info", null))
  assert.equal(info.desktop, "test")
  assert.equal(info.candidates, 8)
  assert.ok(info.methods.includes("rootSearch.performAction"))
})

test("search finds an app and opening it records a visit", () => {
  const { host, backend } = setup()
  const sections = ok(backend.callSync("rootSearch.search", { query: "fir" }))
  assert.equal(sections[0].rows[0].id, "app:firefox")
  assert.deepEqual(ok(backend.callSync("rootSearch.performAction", { id: "app:firefox", action: "open", query: "fir" })), { close: true })
  assert.deepEqual(host.calls.at(-1), ["openApp", "app:firefox"])
  assert.ok(host.stores.frecency.doc.items["app:firefox"].anchor > 0)
  assert.deepEqual(host.stores.frecency.doc.searchHistory, ["fir"])
})

test("system built-ins go to host.runSystem, after a confirmation when they declare one", () => {
  const { host, backend } = setup()
  ok(backend.callSync("rootSearch.performAction", { id: "builtin:lock", action: "open" }))
  assert.deepEqual(host.calls.at(-1), ["runSystem", "lock"])
  const first = ok(backend.callSync("rootSearch.performAction", { id: "builtin:restart", action: "open" }))
  assert.equal(first.confirm.title, "Restart")
  assert.equal(first.confirm.destructive, true)
  ok(backend.callSync("rootSearch.performAction", { id: "builtin:restart", action: "open", confirmed: true }))
  assert.deepEqual(host.calls.at(-1), ["runSystem", "restart"])
})

test("web search built-ins need their argument, then open the URL", () => {
  const { host, backend } = setup()
  const missing = backend.callSync("rootSearch.performAction", { id: "builtin:google-search", action: "open", arguments: {} })
  assert.equal(missing.ok, false)
  ok(backend.callSync("rootSearch.performAction", { id: "builtin:google-search", action: "open", arguments: { query: "a b" } }))
  assert.deepEqual(host.calls.at(-1), ["openUrl", "https://www.google.com/search?q=a%20b"])
})

test("the calculator copies its answer and saves it to history", () => {
  const { host, backend } = setup()
  const sections = ok(backend.callSync("rootSearch.search", { query: "2+3" }))
  assert.equal(sections[0].id, "calculator")
  const outcome = ok(backend.callSync("rootSearch.performAction", { id: RootSearch.CALCULATOR_ID, action: "open", query: "2+3" }))
  assert.deepEqual(outcome, { close: true, hud: "Copied to Clipboard" })
  assert.deepEqual(host.calls.find((c) => c[0] === "copy"), ["copy", "5"])
  assert.equal(host.stores.calculator.doc.history.length, 1)
  assert.ok(host.calls.some((c) => c[0] === "notify" && c[1] === "calculator.historyStateChanged"))
})

test("favourites, aliases and disable round-trip through settings", () => {
  const { backend, host } = setup()
  ok(backend.callSync("rootSearch.performAction", { id: "app:firefox", action: "favorite-add" }))
  assert.equal(host.stores.settings.doc.commands["app:firefox"].favoriteOrder, 0)
  ok(backend.callSync("settings.updateCommandSettings", { commandId: "app:firefox", alias: "ff" }))
  const dup = backend.callSync("settings.updateCommandSettings", { commandId: "org.gnome.Nautilus", alias: "ff" })
  assert.equal(dup.ok, false)
  const disabled = ok(backend.callSync("rootSearch.performAction", { id: "app:firefox", action: "disable" }))
  assert.equal(disabled.toast.actions[0].call.method, "settings.updateCommandSettings")
  const all = ok(backend.callSync("rootSearch.search", { query: "" })).flatMap((s) => s.rows.map((r) => r.id))
  assert.ok(!all.includes("app:firefox"))
})

test("host hooks relabel actions and the copied id", () => {
  const { backend, host } = setup({
    adjustActions: (c, list) => list.map((a) => a.id === "copy-id" ? Object.assign({}, a, { title: "Copy Bundle Identifier" }) : a),
    copyId: (c) => c.appId
  })
  const actions = ok(backend.callSync("rootSearch.getActions", { id: "app:firefox" }))
  assert.equal(actions.find((a) => a.id === "copy-id").title, "Copy Bundle Identifier")
  ok(backend.callSync("rootSearch.performAction", { id: "app:firefox", action: "copy-id" }))
  assert.deepEqual(host.calls.at(-1), ["copy", "firefox"])
})

test("general settings are validated", () => {
  const { backend } = setup()
  assert.equal(backend.callSync("settings.updateGeneralSettings", { windowMode: "tiny" }).ok, false)
  assert.equal(ok(backend.callSync("settings.updateGeneralSettings", { windowMode: "compact" })).windowMode, "compact")
})
