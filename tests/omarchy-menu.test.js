const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const M = require("../plugin/core/OmarchyMenu.js")

const sample = `{
  // comment line
  "system": {"icon":"x","label":"System","aliases":["power-menu"]},
  "system.lock": {"icon":"l","label":"Lock","action":"omarchy-system-lock"},
  "system.suspend": {"label":"Suspend","when":"false","action":"systemctl suspend"},
  "style": {"label":"Style"},
  "style.font": {"label":"Font","provider":"fonts"},
  "link.to-style": {"label":"Go Style","target":"style"},
  "trigger.clip": {"label":"Clipboard","action":"omarchy-shell shell summon omarchy.clipboard"},
}`

test("parses JSONC with comments and trailing commas, inferring kinds and parents", () => {
  const { items, error } = M.parse(sample)
  assert.equal(error, "")
  const byId = Object.fromEntries(items.map((i) => [i.id, i]))
  assert.equal(byId["system"].kind, "menu")
  assert.equal(byId["system.lock"].kind, "action")
  assert.equal(byId["system.lock"].parent, "system")
  assert.equal(byId["link.to-style"].kind, "link")
  assert.deepEqual(byId["system"].aliases, ["power-menu"])
})

test("an unreadable file yields no items and an error", () => {
  const r = M.parse("{nope")
  assert.deepEqual(r.items, [])
  assert.ok(r.error)
})

test("user items override fields of built-in ones and append new ids", () => {
  const def = M.parse(sample).items
  const user = M.parse(`{"system.lock":{"label":"Lock Screen"},"personal":{"label":"Personal"},"personal.notes":{"label":"Notes","action":"obsidian"}}`).items
  const tree = M.buildTree(def, user)
  assert.equal(tree.items["system.lock"].label, "Lock Screen")
  assert.equal(tree.items["system.lock"].action, "omarchy-system-lock")
  assert.equal(tree.items["system.lock"].kind, "action")
  assert.deepEqual(tree.children.root, ["system", "style", "link.to-style", "trigger.clip", "personal"])
  assert.deepEqual(tree.children["personal"], ["personal.notes"])
})

test("breadcrumbs and visibility follow the parent chain", () => {
  const tree = M.buildTree(M.parse(sample).items, [])
  assert.deepEqual(M.breadcrumb(tree, "system.lock"), ["System"])
  assert.deepEqual(M.breadcrumb(tree, "system"), [])
  const guards = { when: { "system": false }, checked: {}, disabled: {} }
  assert.equal(M.isVisible(tree, guards, "system.lock"), false)
  assert.equal(M.isVisible(tree, { when: {} }, "system.lock"), true)
})

test("the guard script runs in bash and reports each guard", () => {
  const tree = M.buildTree(M.parse(sample).items, [])
  const script = M.guardScript(tree)
  const out = execFileSync("bash", ["-c", script], { encoding: "utf8" })
  assert.deepEqual(M.parseGuardOutput(out).when, { "system.suspend": false })
})

test("provider output becomes action rows with quoted commands", () => {
  const rows = M.providerItems("style.font", "fonts", "JetBrains Mono\tJetBrains Mono\tJetBrains Mono\nIt's Font\tIt's Font\tother\n")
  assert.equal(rows.length, 2)
  assert.equal(rows[0].id, "style.font.jetbrains-mono")
  assert.equal(rows[0].isCurrent, true)
  assert.equal(rows[1].action, "omarchy-font-set 'It'\\''s Font'")
  assert.equal(rows[1].parent, "style.font")
})

test("an extension can declare its own provider object", () => {
  const { items } = M.parse(`{
    "tabs": {"label":"Tabs","provider":{"command":"list-tabs","action":"focus-tab {value}","icon":"T","volatile":true,"extra":1}},
    "a": {"provider":{"action":"run {value}"}},
    "b": {"provider":{"command":"ls","action":"run"}},
    "c": {"provider":7},
    "d": {"provider":{"command":"ls","action":"run {value}","volatile":"yes"}}
  }`)
  const byId = Object.fromEntries(items.map((i) => [i.id, i]))
  assert.deepEqual(byId["tabs"].provider, { command: "list-tabs", action: "focus-tab {value}", icon: "T", volatile: true })
  assert.equal(byId["tabs"].kind, "menu")
  assert.equal(byId["a"].provider, "", "a provider without a command is dropped")
  assert.equal(byId["b"].provider, "", "a provider whose action ignores the value is dropped")
  assert.equal(byId["c"].provider, "", "a provider that is neither a name nor an object is dropped")
  assert.equal(byId["d"].provider.volatile, false, "only true is volatile")
  assert.equal(M.providerSpec("fonts"), M.PROVIDERS.fonts)
  assert.equal(M.providerSpec("nope"), null)
})

test("an extension provider object survives the merge with the default menu", () => {
  const user = M.parse(`{"style.font": {"provider":{"command":"ls","action":"set {value}"}}}`).items
  const tree = M.buildTree(M.parse(sample).items, user)
  assert.equal(tree.items["style.font"].provider.command, "ls")
  assert.equal(tree.items["style.font"].label, "Font")
})

test("extension provider rows run the chosen value as one literal word", () => {
  const provider = { command: "list-tabs", action: "printf '%s' {value}", icon: "T" }
  const hostile = "it's $(touch /tmp/oma-cast-pwned) `id` \\ \"q\""
  const rows = M.providerItems("tabs", provider, `Inbox\ttab-1\ttab-2\tWork · mail.example\nHostile\t${hostile}\n\nCurrent\ttab-2\ttab-2\n`)
  assert.deepEqual(rows.map((r) => r.label), ["Inbox", "Hostile", "Current"])
  assert.equal(rows[0].description, "Work · mail.example")
  assert.equal(rows[1].description, "")
  assert.equal(rows[0].icon, "T")
  assert.equal(rows[2].isCurrent, true)
  assert.equal(rows[0].parent, "tabs")
  for (const [row, value] of [[rows[0], "tab-1"], [rows[1], hostile]]) {
    assert.equal(execFileSync("bash", ["-c", row.action], { encoding: "utf8" }), value)
  }
})

test("an extension provider's command runs and feeds its rows", () => {
  const spec = M.providerSpec({ command: "printf 'A\\ta\\n'", action: "echo {value}" })
  const out = execFileSync("bash", ["-c", spec.script], { encoding: "utf8" })
  assert.deepEqual(M.providerItems("x", { command: spec.script, action: "echo {value}" }, out).map((r) => r.action), ["echo 'a'"])
})

test("only a bare summon is run in-process", () => {
  assert.deepEqual(M.summonAction("omarchy-shell shell summon omarchy.clipboard"), { id: "omarchy.clipboard", payload: "{}" })
  assert.deepEqual(M.summonAction(`omarchy-shell shell summon omarchy.image-picker '{"source":"themes"}'`), { id: "omarchy.image-picker", payload: '{"source":"themes"}' })
  assert.equal(M.summonAction("omarchy-shell shell summon x; rm -rf ~"), null)
})

const shipped = path.join(process.env.OMARCHY_PATH || "/usr/share/omarchy", "default/omarchy/omarchy-menu.jsonc")
test("the installed Omarchy menu parses completely", { skip: !fs.existsSync(shipped) }, () => {
  const r = M.parse(fs.readFileSync(shipped, "utf8"))
  assert.equal(r.error, "")
  assert.ok(r.items.length > 300, "expected the full menu, got " + r.items.length)
  const tree = M.buildTree(r.items, [])
  for (const id of ["apps", "system", "setup", "install", "remove", "update"]) assert.ok(tree.children.root.includes(id), id)
  assert.ok(tree.children.root.includes("style") || tree.children.root.includes("appearance"))
})
