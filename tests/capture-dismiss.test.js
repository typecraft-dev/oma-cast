const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const OmarchyMenu = require("../core/OmarchyMenu.js")

const backendText = fs.readFileSync(path.join(__dirname, "../Backend.qml"), "utf8")
const windowText = fs.readFileSync(path.join(__dirname, "../ui/LauncherWindow.qml"), "utf8")
const launcherText = fs.readFileSync(path.join(__dirname, "../Launcher.qml"), "utf8")

function method(source, name, context) {
  const start = source.indexOf("  function " + name + "(")
  assert.ok(start >= 0, name)
  const end = source.indexOf("\n  }", start) + 4
  return vm.runInNewContext("(" + source.slice(start, end) + ")", context)
}

function harness() {
  const events = []
  let visible = true
  const backend = {
    dismiss() { visible = false; events.push("hide") },
    summonPlugin(id, payload) { assert.equal(visible, false); events.push([id, payload]) }
  }
  const context = {
    backend, OmarchyMenu,
    Util: { execDetached(command) { assert.equal(visible, false); events.push(command) } }
  }
  return { events, backend, run: method(backendText, "runShell", context) }
}

for (const command of ["omarchy-capture-text", "omarchy-capture-screenshot", "custom-command --literal '*' "]) {
  test("dismiss before executing " + command, () => {
    const h = harness()
    h.run(command)
    assert.deepEqual(h.events, ["hide", command])
  })
}

test("shell summon actions still route natively, after dismissal", () => {
  const h = harness()
  h.run("omarchy-shell shell summon omarchy.clipboard")
  assert.deepEqual(h.events, ["hide", ["omarchy.clipboard", "{}"]])
})

test("headless backends can still execute without a dismissal hook", () => {
  const commands = []
  const run = method(backendText, "runShell", {
    backend: { dismiss: null }, OmarchyMenu,
    Util: { execDetached: command => commands.push(command) }
  })
  run("omarchy-capture-text")
  assert.deepEqual(commands, ["omarchy-capture-text"])
})

test("UI and IPC actions share the backend dismissal hook", () => {
  assert.match(launcherText, /dismiss: function\(\) \{ root\.hide\(\) \}/)
  assert.match(backendText, /case "omarchy-action":[\s\S]*?backend\.runShell\(candidate\.action\)/)
})

test("capture layer rule uses the current namespace and is reapplied on config reload", () => {
  const commands = []
  const window = {}
  window.applyLayerRule = method(windowText, "applyLayerRule", {
    Quickshell: { execDetached: args => commands.push(Array.from(args)) }
  })
  const startup = windowText.match(/Component\.onCompleted: (window\.applyLayerRule\(\))/)
  assert.ok(startup)
  vm.runInNewContext(startup[1], { window })
  const handler = windowText.match(/function onRawEvent\(event\) \{([\s\S]*?)\n    \}/)
  assert.ok(handler)
  const onRawEvent = vm.runInNewContext("(function(event) {" + handler[1] + "})", { window })
  onRawEvent(null)
  onRawEvent({ name: "focusedmon" })
  assert.equal(commands.length, 1)
  onRawEvent({ name: "configreloaded" })
  assert.equal(commands.length, 2)
  assert.deepEqual(commands[0], commands[1])
  assert.deepEqual(commands[0].slice(0, 2), ["hyprctl", "eval"])
  assert.match(commands[0][2], /namespace = "\^omacast\$"/)
  assert.match(commands[0][2], /no_anim = true/)
  assert.match(commands[0][2], /animation = "none"/)
})
