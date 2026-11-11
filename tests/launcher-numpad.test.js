const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const source = fs.readFileSync(path.join(__dirname, "../ui/LauncherWindow.qml"), "utf8")

function body(signature) {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, signature)
  const open = source.indexOf("{", start) + 1
  const end = source.indexOf("\n  }", open)
  return "(function() {\n" + source.slice(open, end) + "\n})()"
}

const Qt = {
  NoModifier: 0,
  ShiftModifier: 0x02000000,
  ControlModifier: 0x04000000,
  AltModifier: 0x08000000,
  MetaModifier: 0x10000000,
  KeypadModifier: 0x20000000,
  GroupSwitchModifier: 0x40000000,
  Key_Escape: 0x01000000,
  Key_Tab: 0x01000001,
  Key_Backtab: 0x01000002,
  Key_Backspace: 0x01000003,
  Key_Return: 0x01000004,
  Key_Enter: 0x01000005,
  Key_Insert: 0x01000006,
  Key_Delete: 0x01000007,
  Key_Clear: 0x0100000b,
  Key_Home: 0x01000010,
  Key_End: 0x01000011,
  Key_Left: 0x01000012,
  Key_Up: 0x01000013,
  Key_Right: 0x01000014,
  Key_Down: 0x01000015,
  Key_PageUp: 0x01000016,
  Key_PageDown: 0x01000017,
  Key_CapsLock: 0x01000024,
  Key_NumLock: 0x01000025,
  Key_ScrollLock: 0x01000026,
  Key_Space: 0x20,
  Key_Asterisk: 0x2a,
  Key_Plus: 0x2b,
  Key_Comma: 0x2c,
  Key_Minus: 0x2d,
  Key_Period: 0x2e,
  Key_Slash: 0x2f,
  Key_0: 0x30,
  Key_1: 0x31,
  Key_9: 0x39,
  Key_Equal: 0x3d,
  Key_C: 0x43,
  Key_D: 0x44,
  Key_F: 0x46,
  Key_K: 0x4b,
  Key_N: 0x4e,
  Key_P: 0x50,
  Key_T: 0x54,
  Key_V: 0x56,
  Key_BracketLeft: 0x5b
}

function harness(kind = "root") {
  const actions = []
  const zooms = []
  const moves = []
  const recalls = []
  const actionPanel = { item: { filter: "", move(d) { moves.push(["panel", d]) }, activateSelected() { actions.push("panel-enter") } } }
  const dropdown = { item: { filter: "", move() {}, activateSelected() {} } }
  const toastPanel = { item: { filter: "", move() {}, activateSelected() {} } }
  const window = {
    query: "",
    view: { kind },
    atRoot: true,
    selectedIndex: 0,
    historyIndex: -1,
    actionPanelOpen: false,
    dropdownOpen: false,
    toastPanelOpen: false,
    aboutOpen: false,
    alert: null,
    argFocus: -1,
    argDefs: [],
    argValues: {},
    zoom: 1,
    vim: false,
    setQuery(next) { this.query = next },
    setZoom(z) { this.zoom = z; zooms.push(z) },
    isActionPanelKey() { return false },
    nextSelectable() { return 0 },
    recallHistory(d) { recalls.push(d); return true },
    move(d) { moves.push(d) },
    performNth(n) { actions.push(["nth", n]) },
    nthItem(n) { return n - 1 },
    perform(action, idx) { actions.push([action, idx]) },
    performIfOffered() { return false }
  }
  const context = vm.createContext({
    Qt, window, actionPanel, dropdown, toastPanel,
    Util: { editsFilter: () => false }
  })
  window.typedText = event => {
    context.event = event
    return vm.runInContext(body("function typedText(event)"), context)
  }
  window.isTyping = event => {
    context.event = event
    return vm.runInContext(body("function isTyping(event)"), context)
  }
  window.direction = (event, ctrl, alt, inPopup) => {
    context.event = event
    context.ctrl = ctrl
    context.alt = alt
    context.inPopup = inPopup
    return vm.runInContext(body("function direction(event, ctrl, alt, inPopup)"), context)
  }
  window.handleArgumentKey = (event, shift) => {
    context.event = event
    context.shift = shift
    return vm.runInContext(body("function handleArgumentKey(event, shift)"), context)
  }
  window.handlePopupKey = (event, panel, ctrl, alt) => {
    context.event = event
    context.panel = panel
    context.ctrl = ctrl
    context.alt = alt
    return vm.runInContext(body("function handlePopupKey(event, panel, ctrl, alt)"), context)
  }
  return {
    Qt, window, actionPanel, actions, zooms, moves, recalls,
    press(event) {
      context.event = event
      return vm.runInContext(body("function handleKey(event)"), context)
    }
  }
}

function numpadKey(text, extraModifiers = 0) {
  return {
    key: text.toUpperCase().charCodeAt(0),
    text,
    modifiers: Qt.KeypadModifier | extraModifiers
  }
}

test("isTyping accepts numpad digits, operators, and decimal separators with KeypadModifier", () => {
  const h = harness()
  for (const ch of "0123456789+-*/.=,") {
    assert.equal(Boolean(h.window.isTyping(numpadKey(ch))), true, `expected ${ch} to be accepted`)
    assert.equal(Boolean(h.window.isTyping(numpadKey(ch, Qt.ShiftModifier))), true, `expected Shift+${ch} to be accepted`)
  }
})

test("isTyping rejects Ctrl, Alt, Meta, and GroupSwitch chords on the numpad", () => {
  const h = harness()
  for (const mod of [Qt.ControlModifier, Qt.AltModifier, Qt.MetaModifier, Qt.GroupSwitchModifier]) {
    assert.equal(Boolean(h.window.isTyping(numpadKey("5", mod))), false)
  }
})

test("numpad keys without event.text map from keypad navigation keysyms and Wayland scan codes without hijacking list movement", () => {
  const h = harness()
  const navPad = [
    [Qt.Key_Insert, "0"],
    [Qt.Key_End, "1"],
    [Qt.Key_Down, "2"],
    [Qt.Key_PageDown, "3"],
    [Qt.Key_Left, "4"],
    [Qt.Key_Clear, "5"],
    [Qt.Key_Right, "6"],
    [Qt.Key_Home, "7"],
    [Qt.Key_Up, "8"],
    [Qt.Key_PageUp, "9"],
    [Qt.Key_Delete, "."],
    [Qt.Key_Plus, "+"],
    [Qt.Key_Minus, "-"],
    [Qt.Key_Asterisk, "*"],
    [Qt.Key_Slash, "/"],
    [Qt.Key_Equal, "="]
  ]
  for (const [key, expected] of navPad) {
    assert.equal(h.press({ key, text: "", modifiers: Qt.KeypadModifier }), true)
  }
  assert.equal(h.window.query, "0123456789.+-*/=")
  assert.deepEqual(h.moves, [])
  assert.deepEqual(h.recalls, [])

  // Wayland XKB scan codes when KeypadModifier is absent; NumLock (77) must not insert 6.
  const h2 = harness()
  assert.equal(h2.press({ key: Qt.Key_NumLock, text: "", modifiers: 0, nativeScanCode: 77 }), false)
  assert.equal(h2.press({ key: Qt.Key_Up, text: "", modifiers: 0, nativeScanCode: 80 }), true)
  assert.equal(h2.press({ key: Qt.Key_Down, text: "", modifiers: 0, nativeScanCode: 88 }), true)
  assert.equal(h2.window.query, "82")
  assert.deepEqual(h2.moves, [])
  assert.deepEqual(h2.recalls, [])

  // Dedicated arrow and PageDown keys still navigate.
  assert.equal(h2.press({ key: Qt.Key_Down, text: "", modifiers: 0, nativeScanCode: 116 }), true)
  assert.equal(h2.press({ key: Qt.Key_PageDown, text: "", modifiers: 0, nativeScanCode: 117 }), true)
  assert.deepEqual(h2.moves, [1, 8])
})

test("numpad digits and operators append to root query and alias query", () => {
  for (const [kind, expr] of [["root", "123+45.6*7-8/9"], ["alias", "42"]]) {
    const h = harness(kind)
    for (const ch of expr) {
      assert.equal(h.press(numpadKey(ch)), true)
    }
    assert.equal(h.window.query, expr)
    assert.deepEqual(h.actions, [])
  }
})

test("numpad input types into focused command argument pills", () => {
  const h = harness()
  h.window.argDefs = [{ name: "port" }]
  h.window.argFocus = 0
  for (const ch of "8080") {
    assert.equal(h.press(numpadKey(ch)), true)
  }
  assert.equal(h.window.argValues.port, "8080")
  assert.equal(h.window.query, "")
})

test("numpad input filters open popup panels without mutating root query", () => {
  const h = harness()
  h.window.query = "calc"
  h.window.actionPanelOpen = true
  for (const ch of "12") {
    assert.equal(h.press(numpadKey(ch)), true)
  }
  assert.equal(h.actionPanel.item.filter, "12")
  assert.equal(h.window.query, "calc")
})

test("numpad Enter and Ctrl+numpad shortcuts retain their actions", () => {
  const h = harness()
  assert.equal(h.press({ key: Qt.Key_Enter, text: "\r", modifiers: Qt.KeypadModifier }), true)
  assert.equal(h.press({ key: Qt.Key_Enter, text: "\r", modifiers: Qt.KeypadModifier | Qt.ControlModifier }), true)
  assert.equal(h.press({ key: Qt.Key_1, text: "1", modifiers: Qt.KeypadModifier | Qt.ControlModifier }), true)
  assert.deepEqual(h.actions, [["nth", 0], ["nth", 1], ["open", 0]])

  assert.equal(h.press({ key: Qt.Key_Plus, text: "+", modifiers: Qt.KeypadModifier | Qt.ControlModifier }), true)
  assert.equal(h.press({ key: Qt.Key_Minus, text: "-", modifiers: Qt.KeypadModifier | Qt.ControlModifier }), true)
  assert.equal(h.press({ key: Qt.Key_0, text: "0", modifiers: Qt.KeypadModifier | Qt.ControlModifier }), true)
  assert.deepEqual(h.zooms, [1.1, 1, 1])
})
