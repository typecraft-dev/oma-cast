const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const OmarchyMenu = require("../core/OmarchyMenu.js")
const RootSearch = require("../core/RootSearch.js")
const Ranker = require("../core/Ranker.js")
const Frecency = require("../core/Frecency.js")

const deps = { OmarchyMenu, Ranker, Frecency }
const Rpc = require("../core/Rpc.js")
const Schema = require("../core/Schema.js")
const Migrate = require("../core/Migrate.js")
const Calculator = require("../core/Calculator.js")
const Backend = require("../core/Backend.js")

function store(migrations) {
  const s = { loaded: true, readOnly: false, lastError: "", doc: Migrate.migrate(null, migrations, 0).doc }
  s.update = (mutator) => { const next = JSON.parse(JSON.stringify(s.doc)); const r = mutator(next); s.doc = r === undefined ? next : r }
  return s
}

// core/Backend.js with a host that records summons; visits land in the
// frecency store.
function harness(tree) {
  const summons = []
  const host = {
    stores: { settings: store(Schema.settingsMigrations), frecency: store(Schema.frecencyMigrations), calculator: store(Schema.calculatorMigrations) },
    calculatorData: { rates: null, zones: {} },
    config: () => Schema.withConfigDefaults(null),
    hour12: () => false,
    summonPlugin: (id, payload) => summons.push({ id, payload: JSON.parse(payload) }),
    menuTree: () => tree
  }
  const backend = Backend.create(host, { Rpc, Schema, Ranker, Frecency, RootSearch, Calculator, OmarchyMenu })
  backend.setCandidates(RootSearch.menuCandidates(tree, {}, {}, deps))
  const visits = []
  return {
    summons,
    visits,
    open: id => {
      const r = backend.callSync("rootSearch.performAction", { id, action: "open" })
      assert.equal(r.ok, true, r.error)
      for (const key of Object.keys(host.stores.frecency.doc.items)) if (!visits.some(v => v.id === key)) visits.push({ id: key })
      return JSON.parse(JSON.stringify(r.data))
    }
  }
}

for (const [version, appearance] of [["4.0.0", "style"], ["4.5.0-rc2", "appearance"]]) {
  const parsed = OmarchyMenu.parse(fs.readFileSync(path.join(__dirname, "fixtures/omarchy-menu-v" + version + ".jsonc"), "utf8"))
  const tree = OmarchyMenu.buildTree(parsed.items, [])

  test("Omarchy v" + version + " menu keeps navigation and populates its supported providers", () => {
    assert.equal(parsed.error, "")
    for (const id of ["apps", "system", appearance, "setup", "install", "remove", "update"]) {
      assert.ok(tree.children.root.includes(id), id)
    }
    const providers = {}
    for (const item of parsed.items.filter(i => OmarchyMenu.PROVIDERS[i.provider])) {
      providers[item.id] = OmarchyMenu.providerItems(item.id, item.provider, "First\tfirst\tfirst\nSecond\tsecond\tfirst\n")
    }
    assert.ok(providers[appearance + ".font"])
    if (version === "4.5.0-rc2") assert.ok(providers["update.kernel"])
    const candidates = RootSearch.menuCandidates(tree, {}, providers, deps)
    for (const [id, rows] of Object.entries(providers)) {
      const sections = RootSearch.submenuSections(candidates, id, "", { commands: {}, frecency: {}, nowMs: Date.now() }, deps)
      assert.deepEqual(sections.flatMap(s => s.rows.map(r => r.candidate.id)), rows.map(r => "omarchy:" + r.id))
      assert.equal(candidates.find(c => c.id === "omarchy:" + rows[0].id).checked, true)
      assert.equal(candidates.find(c => c.id === "omarchy:" + rows[1].id).checked, false)
    }
    assert.ok(candidates.some(c => c.title.startsWith("Nightlight")))
  })

  test("Omarchy v" + version + " unsupported submenus open in the stock menu, including links", () => {
    for (const item of parsed.items.filter(i => i.kind === "menu" && i.provider && !OmarchyMenu.PROVIDERS[i.provider])) {
      const linked = OmarchyMenu.buildTree(parsed.items, OmarchyMenu.parse(JSON.stringify({ shortcut: { label: "Shortcut", target: item.id } })).items)
      for (const id of ["omarchy:" + item.id, "omarchy:shortcut"]) {
        const h = harness(linked)
        assert.deepEqual(h.open(id), { close: true })
        assert.deepEqual(h.summons, [{ id: "omarchy.menu", payload: { menu: item.id } }])
        assert.equal(h.visits[0].id, id)
      }
    }
    const h = harness(tree)
    assert.deepEqual(h.open("omarchy:" + appearance), { push: { kind: "menu", menuId: appearance, title: tree.items[appearance].label } })
    assert.deepEqual(h.open("omarchy:" + appearance + ".font"), { push: { kind: "menu", menuId: appearance + ".font", title: tree.items[appearance + ".font"].label } })
    assert.deepEqual(h.summons, [])
  })
}

test("an unknown extension provider opens in the stock menu", () => {
  const tree = OmarchyMenu.buildTree(OmarchyMenu.parse('{"custom":{"label":"Custom","provider":"future-provider"}}').items, [])
  const h = harness(tree)
  assert.deepEqual(h.open("omarchy:custom"), { close: true })
  assert.deepEqual(h.summons, [{ id: "omarchy.menu", payload: { menu: "custom" } }])
})

test("kernel rows obey the menu visibility guard and remain searchable when visible", () => {
  const parsed = OmarchyMenu.parse(fs.readFileSync(path.join(__dirname, "fixtures/omarchy-menu-v4.5.0-rc2.jsonc"), "utf8"))
  const tree = OmarchyMenu.buildTree(parsed.items, [])
  assert.ok(tree.items["update.kernel"].when)
  const providers = { "update.kernel": OmarchyMenu.providerItems("update.kernel", "kernels", "linux-lts\tlinux-lts\tlinux-lts\n") }
  const visible = RootSearch.menuCandidates(tree, { when: { "update.kernel": true } }, providers, deps)
  assert.ok(visible.some(c => c.id === "omarchy:update.kernel.linux-lts" && c.checked))
  const hidden = RootSearch.menuCandidates(tree, { when: { "update.kernel": false } }, providers, deps)
  assert.ok(!hidden.some(c => c.menuId.startsWith("update.kernel")))
})

test("kernel enumeration reads list/get and set receives the selected value literally", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omacast-kernels-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, "omarchy-kernel"), '#!/bin/bash\ncase "$1" in\nget) echo linux-lts ;;\nlist) printf "linux\\nlinux-lts\\n" ;;\nset) printf "%s\\0" "$@" ;;\n*) exit 1 ;;\nesac\n', { mode: 0o755 })
  const env = { ...process.env, PATH: dir + ":" + process.env.PATH }
  const output = execFileSync("bash", ["-c", OmarchyMenu.PROVIDERS.kernels.script], { env, encoding: "utf8" })
  const rows = OmarchyMenu.providerItems("update.kernel", "kernels", output)
  assert.deepEqual(rows.map(r => [r.label, r.isCurrent, r.action]), [["linux", false, "omarchy-kernel set 'linux'"], ["linux-lts", true, "omarchy-kernel set 'linux-lts'"]])
  const value = "it's $(touch " + path.join(dir, "injected") + ") `id`"
  const action = OmarchyMenu.PROVIDERS.kernels.actionFor(value)
  assert.equal(execFileSync("bash", ["-c", action], { env, encoding: "utf8" }), "set\0" + value + "\0")
  assert.equal(fs.existsSync(path.join(dir, "injected")), false)
  assert.deepEqual(OmarchyMenu.providerItems("update.kernel", "kernels", ""), [])
})
