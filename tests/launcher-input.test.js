const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { spawnSync } = require("node:child_process")

const source = fs.readFileSync(path.join(__dirname, "../plugin/ui/LauncherWindow.qml"), "utf8")

function body(signature) {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, signature)
  const open = source.indexOf("{", start) + 1
  const end = source.indexOf("\n  }", open)
  assert.ok(end > open, signature)
  return "(function() {\n" + source.slice(open, end) + "\n})()"
}

function harness() {
  let next = 100
  const Qt = new Proxy({ NoModifier: 0, ControlModifier: 1, ShiftModifier: 2, AltModifier: 4, MetaModifier: 8 }, {
    get(target, key) { if (!(key in target)) target[key] = next++; return target[key] }
  })
  const events = []
  const window = {
    query: "12+34", atRoot: true, view: { kind: "root" }, actionPanelOpen: false,
    historyIndex: -1, selectedIndex: 0, argFocus: -1, argDefs: [], vim: false,
    setQuery(query) { this.query = query },
    pop: () => events.push("pop"), move: n => events.push(["move", n]),
    nextSelectable: () => 0, rebuild: reset => events.push(["rebuild", reset]),
    toggleActionPanel: () => events.push("actions"),
    toggleDropdown: () => events.push("dropdown"),
    backend: { callSync: () => ({ ok: true, data: ["firefox", "12+34"] }) }
  }
  const context = vm.createContext({ Qt, window, event: null })
  for (const name of ["direction", "isActionPanelKey"]) {
    const start = source.indexOf("function " + name + "(")
    const end = source.indexOf("\n  }", start) + 4
    window[name] = vm.runInContext("(" + source.slice(start, end) + ")", context)
  }
  window.recallHistory = direction => {
    context.direction = direction
    return vm.runInContext(body("function recallHistory(direction)"), context)
  }
  return {
    Qt, window, events,
    press(key, modifiers = Qt.NoModifier, text = "") {
      context.event = { key: Qt["Key_" + key], modifiers, text }
      return vm.runInContext(body("function handleKey(event)"), context)
    }
  }
}

test("query editing is delegated to TextInput without changing the query", () => {
  const h = harness()
  for (const key of ["Left", "Right", "Home", "End", "Backspace", "Delete"]) {
    assert.equal(h.press(key), false, key)
  }
  assert.equal(h.press("5", 0, "5"), false)
  assert.equal(h.press("Backspace", h.Qt.ControlModifier), false)
  assert.equal(h.press("Left", h.Qt.ShiftModifier), false)
  assert.equal(h.window.query, "12+34")
})

test("Ctrl+U clears the query and empty Backspace still goes back", () => {
  const h = harness()
  assert.equal(h.press("U", h.Qt.ControlModifier), true)
  assert.equal(h.window.query, "")
  assert.equal(h.press("U", h.Qt.ControlModifier | h.Qt.ShiftModifier), false)
  assert.equal(h.press("Backspace"), false)
  h.window.atRoot = false
  assert.equal(h.press("Backspace"), true)
  assert.deepEqual(h.events, ["pop"])
})

test("list navigation and action shortcuts retain priority over text editing", () => {
  const h = harness()
  assert.equal(h.press("Up"), true)
  assert.equal(h.press("Down"), true)
  assert.equal(h.press("K", h.Qt.ControlModifier), true)
  assert.equal(h.press("P", h.Qt.ControlModifier), true)
  assert.deepEqual(h.events, [["move", -1], ["move", 1], "actions", "dropdown"])
  assert.equal(h.window.query, "12+34")
})

test("vim navigation keeps Alt+K for actions while query arrows remain native", () => {
  const h = harness()
  h.window.vim = true
  assert.equal(h.press("J", h.Qt.ControlModifier), true)
  assert.equal(h.press("K", h.Qt.ControlModifier), true)
  assert.equal(h.press("K", h.Qt.AltModifier), true)
  assert.equal(h.press("Left"), false)
  assert.deepEqual(h.events, [["move", 1], ["move", -1], "actions"])
})

test("popups and arguments transfer focus away from the query and back", () => {
  const calls = []
  const window = { argFocus: -1 }
  const context = vm.createContext({
    window,
    queryText: { forceActiveFocus: () => calls.push("query") },
    keyCatcher: { forceActiveFocus: () => calls.push("keys") }
  })
  const expression = source.match(/readonly property bool queryInputActive: ([^\n]*(?:\n    &&[^\n]*)*)/)[1]
  function focus() {
    window.queryInputActive = vm.runInContext(expression, context)
    vm.runInContext(body("function focusInput()"), context)
  }
  for (const [key, active, inactive] of [
    ["actionPanelOpen", true, false], ["dropdownOpen", true, false],
    ["toastPanelOpen", true, false], ["aboutOpen", true, false],
    ["alert", {}, null], ["argFocus", 0, -1]
  ]) {
    window[key] = active
    focus()
    window[key] = inactive
    focus()
  }
  assert.deepEqual(calls, Array(6).fill(["keys", "query"]).flat())
})

test("history recall survives cursor movement and editing exits history browsing", () => {
  const h = harness()
  h.window.query = ""
  assert.equal(h.press("Up"), true)
  assert.equal(h.window.query, "firefox")
  assert.equal(h.window.historyIndex, 0)
  assert.equal(h.press("Left"), false)
  assert.equal(h.window.historyIndex, 0)
  assert.equal(h.press("Up"), true)
  assert.equal(h.window.query, "12+34")
  assert.equal(h.window.historyIndex, 1)
  assert.equal(h.press("Down"), true)
  assert.equal(h.window.query, "firefox")
  h.window.query = "12+34"
  const context = vm.createContext({ window: h.window, next: "12+534" })
  vm.runInContext(body("function setQuery(next)"), context)
  assert.equal(h.window.query, "12+534")
  assert.equal(h.window.historyIndex, -1)
})

test("aliases keep native editing while rejecting spaces", () => {
  const h = harness()
  h.window.view.kind = "alias"
  assert.equal(h.press("Left"), false)
  assert.equal(h.press("5", 0, "5"), false)
  assert.equal(h.press("Space", 0, " "), true)
})

test("native query input regression tests", t => {
  const runner = process.env.QMLTESTRUNNER || "/usr/lib/qt6/bin/qmltestrunner"
  const result = spawnSync(runner, ["-input", path.join(__dirname, "qml")], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, QT_QPA_PLATFORM: "offscreen", QT_QPA_PLATFORMTHEME: "", QT_IM_MODULE: "", QSG_RHI_BACKEND: "software", DBUS_SESSION_BUS_ADDRESS: "" }
  })
  if (result.error && result.error.code === "ENOENT") {
    t.skip("Qt 6 qmltestrunner is not installed; set QMLTESTRUNNER for a custom path")
    return
  }
  assert.ifError(result.error)
  assert.ok(result.status === 0, result.stdout + result.stderr)
  assert.match(result.stdout, /QueryInput::test_issue25_insertAtCursor\(\)/)
})
