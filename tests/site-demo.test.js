const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

// The website runs these same core modules in a browser (site/build.mjs wraps them, site/public/launcher.js
// drives them). A module that grows a Qt or node dependency, or changes a signature the page relies on,
// breaks the site without breaking the launcher, so load the bundle the way a browser does and search it.
const root = path.join(__dirname, "..")
const demo = path.join(root, "site/public/demo")

async function core() {
  const { bundle, MODULES } = await import(path.join(root, "site/build.mjs"))
  const context = { window: {} }
  vm.createContext(context)
  vm.runInContext(bundle(), context)
  return { Core: context.window.OmacastCore, MODULES }
}

test("the site bundle loads every core module with no QML or node around", async () => {
  const { Core, MODULES } = await core()
  for (const name of MODULES) assert.equal(typeof Core[name], "object", name + " is missing from the bundle")
})

test("the bundled engine searches the site's Omarchy snapshot", async () => {
  const { Core } = await core()
  const snapshot = JSON.parse(fs.readFileSync(path.join(demo, "snapshot.json"), "utf8"))
  const tree = Core.OmarchyMenu.buildTree(Core.OmarchyMenu.parse(JSON.stringify(snapshot.menu)).items, [])
  assert.ok(tree.order.length > 300, "the snapshot holds Omarchy's whole menu")
  const candidates = Core.RootSearch.menuCandidates(tree, snapshot.guards, {}, Core)
    .concat(Core.RootSearch.BUILTINS.map(Core.RootSearch.builtinCandidate))
  const ctx = { commands: {}, frecency: {}, nowMs: Date.now(), sensitivity: "medium", filter: "all" }
  ctx.calculation = Core.Calculator.evaluate("100 usd to eur", { nowMs: ctx.nowMs, localOffset: 0, hour12: false, rates: snapshot.rates, zones: {}, remToPxRate: 16, workHoursPerDay: 8 })
  assert.ok(ctx.calculation && /€/.test(ctx.calculation.result), "the snapshot's exchange rates convert currencies")
  const sections = Core.RootSearch.rootSections(candidates, "switch", ctx, Core)
  // Joined: the arrays come from the bundle's own realm.
  assert.equal(sections.map((s) => s.id).join(" "), "calculator results fallback-commands")
  // The hero demo types this and presses Enter, expecting the built-in.
  assert.equal(sections[1].rows[0].candidate.id, "builtin:switch-theme")
})

test("the snapshot says nothing about the machine it was taken on", () => {
  const snapshot = JSON.parse(fs.readFileSync(path.join(demo, "snapshot.json"), "utf8"))
  assert.deepEqual(snapshot.guards.disabled, {}, "no row reads as already installed")
  for (const id of Object.keys(snapshot.menu)) if (id.startsWith("remove.") && snapshot.guards.when[id] !== false)
    assert.equal(snapshot.guards.when[id], undefined, id + " would show what is installed")
  for (const id of Object.keys(snapshot.guards.checked)) if (id.startsWith("setup.default."))
    assert.match(id, /\.(chromium|ghostty|neovim)$/, id + " is a personal default")
})

test("the page's own scripts parse", () => {
  for (const file of ["launcher.js", "app.js"]) new vm.Script(fs.readFileSync(path.join(root, "site/public", file), "utf8"), { filename: file })
})
