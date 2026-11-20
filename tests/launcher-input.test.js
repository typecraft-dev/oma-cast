const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { spawnSync } = require("node:child_process")

const source = fs.readFileSync(path.join(__dirname, "../ui/LauncherWindow.qml"), "utf8")

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
  const Qt = new Proxy({ NoModifier: 0, ControlModifier: 1, ShiftModifier: 2, AltModifier: 4, MetaModifier: 8, KeypadModifier: 16 }, {
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
  for (const name of ["direction", "isActionPanelKey", "superOnly"]) {
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

test("Super navigation and query clearing keep their upstream bindings", () => {
  const h = harness()
  assert.equal(h.press("J", h.Qt.MetaModifier), true)
  assert.equal(h.press("K", h.Qt.MetaModifier), true)
  assert.equal(h.press("Backspace", h.Qt.MetaModifier), true)
  assert.equal(h.window.query, "")
  assert.deepEqual(h.events, [["move", 1], ["move", -1]])
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

test("clicking script dropdown arguments preserves cycling and query focus restoration", () => {
  const events = []
  const window = { query: "unchanged", argFocus: -1, argValues: { mode: "one" } }
  Object.defineProperty(window, "queryInputActive", { get: () => window.argFocus < 0 })
  const pill = {
    index: 0, focused: false, value: "one",
    modelData: { name: "mode", type: "dropdown", options: [{ value: "one" }, { value: "two" }] }
  }
  const context = vm.createContext({
    window, pill, ScriptCommands: require("../core/ScriptCommands.js"),
    queryText: { forceActiveFocus: () => events.push("query") },
    keyCatcher: { forceActiveFocus: () => events.push("argument") }
  })
  window.focusInput = () => vm.runInContext(body("function focusInput()"), context)
  const at = source.indexOf('if (pill.modelData.type === "dropdown" && pill.focused)')
  const start = source.lastIndexOf("onClicked: {", at) + "onClicked: {".length
  const end = source.indexOf("\n              }", at)
  assert.ok(at >= 0 && start > 0 && end > start)
  const click = "(function() {" + source.slice(start, end) + "})()"
  vm.runInContext(click, context)
  assert.equal(window.argValues.mode, "one")
  pill.focused = true
  vm.runInContext(click, context)
  assert.equal(window.argValues.mode, "two")
  assert.equal(window.query, "unchanged")
  window.argFocus = -1
  window.focusInput()
  assert.deepEqual(events, ["argument", "argument", "query"])
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

test("hiding resets input composition and cancels pending search results", () => {
  const events = []
  const window = {
    shown: false, mapped: true, searchSerial: 5, searchPending: true,
    backend: { cancelSearch: () => events.push("cancel") },
    closePopups: () => events.push("close-popups"),
    general: { popToRootTimeout: 90 }
  }
  const popTimer = { restart: () => events.push("timer") }
  const Qt = { inputMethod: { reset: () => events.push("reset-input") } }
  const Hyprland = { dispatch: command => events.push(command) }
  vm.runInNewContext(body("onShownChanged:"), { window, Qt, popTimer, Hyprland })
  assert.equal(window.searchSerial, 6)
  assert.equal(window.searchPending, false)
  assert.equal(window.mapped, true)
  assert.deepEqual(events, ['hl.dsp.submap("reset")', "reset-input", "cancel", "close-popups", "timer"])
})

test("showing keeps the mapped-surface path without cancelling search or composition", () => {
  const events = []
  const screen = {}
  const window = { shown: true, mapped: false, pinnedScreen: null, focusedScreen: () => screen }
  const Hyprland = { dispatch: command => events.push(command) }
  const glassToggle = { reload: () => events.push("glassy") }
  vm.runInNewContext(body("onShownChanged:"), { window, Hyprland, glassToggle })
  assert.equal(window.mapped, true)
  assert.equal(window.pinnedScreen, screen)
  assert.deepEqual(events, ['hl.dsp.submap("omacast")', "glassy"])
})

test("prepare reuses cached root results while restoring query input focus", () => {
  for (const [payload, builtRootKey, rebuild] of [[{}, "cached", false], [{ query: "12+34" }, "cached", true], [{}, "old", true]]) {
    const events = []
    const window = {
      builtRootKey, historyIndex: 0, rootKey: () => "cached",
      closePopups() {}, rebuild: () => events.push("rebuild"),
      nextSelectable: () => 1, select: () => events.push("restore"),
      focusInput: () => events.push("focus")
    }
    const Qt = { callLater: callback => callback() }
    const popTimer = { stop() {} }
    vm.runInNewContext(body("function prepare(payload)"), { window, Qt, popTimer, payload })
    assert.equal(window.historyIndex, -1)
    assert.deepEqual(events, [rebuild ? "rebuild" : "restore", "focus"])
  }
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
