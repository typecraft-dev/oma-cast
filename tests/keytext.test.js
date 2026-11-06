const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const KeyText = require("../core/KeyText.js")
const KEYPAD = KeyText.KEYPAD
const SHIFT = 0x02000000
const CTRL = 0x04000000

const UP = 0x01000013
const DOWN = 0x01000015
const PAGEUP = 0x01000016
const PAGEDOWN = 0x01000017
const HOME = 0x01000010
const END = 0x01000011
const LEFT = 0x01000012
const RIGHT = 0x01000014
const INSERT = 0x01000006
const DELETE = 0x01000007
const CLEAR = 0x0100000b

test("number-row digits and letters stay plain text", () => {
  assert.equal(KeyText.character({ key: 0x35, text: "5", modifiers: 0 }), "5")
  assert.equal(KeyText.character({ key: 0x41, text: "a", modifiers: 0 }), "a")
  assert.equal(KeyText.character({ key: 0x35, text: "%", modifiers: SHIFT }), "%")
  assert.equal(KeyText.isKeypad({ key: 0x35, text: "5", modifiers: 0 }), false)
})

test("numlock-on numpad digits keep their text despite KeypadModifier", () => {
  const event = { key: 0x38, text: "8", modifiers: KEYPAD }
  assert.equal(KeyText.character(event), "8")
  assert.equal(KeyText.isKeypad(event), true)
})

test("locked numpad types digits when Qt still reports arrows", () => {
  const cases = [
    [INSERT, "0"],
    [END, "1"],
    [DOWN, "2"],
    [PAGEDOWN, "3"],
    [LEFT, "4"],
    [CLEAR, "5"],
    [RIGHT, "6"],
    [HOME, "7"],
    [UP, "8"],
    [PAGEUP, "9"],
    [DELETE, "."],
  ]
  for (const [key, digit] of cases) {
    const event = { key, text: "", modifiers: KEYPAD }
    assert.equal(KeyText.character(event, true), digit, "key " + key.toString(16))
    assert.equal(KeyText.isKeypad(event), true)
    assert.equal(KeyText.character(event, false), "")
  }
})

test("real arrows are not numpad and insert nothing", () => {
  for (const key of [UP, DOWN, LEFT, RIGHT, PAGEUP, PAGEDOWN, HOME, END]) {
    const event = { key, text: "", modifiers: 0, nativeScanCode: 0 }
    assert.equal(KeyText.character(event), "")
    assert.equal(KeyText.isKeypad(event), false)
  }
  // xkb keycodes for the arrow cluster (evdev + 8): Up 111, Down 116.
  assert.equal(KeyText.isKeypad({ key: UP, text: "", modifiers: 0, nativeScanCode: 111 }), false)
})

test("wayland scan codes still type when KeypadModifier is missing", () => {
  // KP8 xkb keycode is 80. Raw evdev 80 is KP2, so this mapping is Wayland's.
  const event = { key: UP, text: "", modifiers: 0, nativeScanCode: 80 }
  assert.equal(KeyText.character(event), "8")
  assert.equal(KeyText.isKeypad(event), true)
  // KP6 xkb keycode is 85. 77 is NumLock, not KP6.
  assert.equal(KeyText.character({ key: 0x36, text: "", modifiers: 0, nativeScanCode: 85 }), "6")
  assert.equal(KeyText.character(event, false), "")
})

test("NumLock is not numpad 6", () => {
  const numLock = 0x01000025
  const event = { key: numLock, text: "", modifiers: 0, nativeScanCode: 77 }
  assert.equal(KeyText.character(event), "")
  assert.equal(KeyText.isKeypad(event), false)
  assert.equal(KeyText.character({ key: numLock, text: "6", modifiers: 0, nativeScanCode: 77 }), "")
  // F6's xkb code is 72, which used to be raw KP8.
  assert.equal(KeyText.character({ key: 0x01000035, text: "", modifiers: 0, nativeScanCode: 72 }), "")
  assert.equal(KeyText.isKeypad({ key: 0x01000024, text: "", modifiers: KEYPAD, nativeScanCode: 0 }), false)
})

test("ctrl and alt chords are not typed, including numpad", () => {
  assert.equal(KeyText.character({ key: UP, text: "", modifiers: KEYPAD | CTRL }), "")
  assert.equal(KeyText.character({ key: 0x41, text: "a", modifiers: CTRL }), "")
  assert.equal(KeyText.character({ key: 0x35, text: "5", modifiers: KEYPAD | 0x08000000 }), "")
})

test("numpad enter does not insert a character", () => {
  assert.equal(KeyText.character({ key: 0x01000005, text: "", modifiers: KEYPAD, nativeScanCode: 104 }), "")
  assert.equal(KeyText.isKeypad({ key: 0x01000005, text: "", modifiers: 0, nativeScanCode: 104 }), true)
})

const source = fs.readFileSync(path.join(__dirname, "../ui/LauncherWindow.qml"), "utf8")

function body(signature) {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, signature)
  const open = source.indexOf("{", start) + 1
  const end = source.indexOf("\n  }", open)
  return "(function() {\n" + source.slice(open, end) + "\n})()"
}

test("numpad 8 types into the query and does not read search history", () => {
  let next = 16
  const Qt = new Proxy({
    NoModifier: 0,
    ControlModifier: 0x04000000,
    ShiftModifier: 0x02000000,
    AltModifier: 0x08000000,
    MetaModifier: 0x10000000,
    Key_Up: UP,
    Key_Down: DOWN,
    Key_PageUp: PAGEUP,
    Key_PageDown: PAGEDOWN,
    Key_Left: LEFT,
    Key_Right: RIGHT,
    Key_Home: HOME,
    Key_End: END,
    Key_Insert: INSERT,
    Key_Delete: DELETE,
    Key_Clear: CLEAR,
  }, {
    get(target, key) {
      if (!(key in target)) target[key] = next++
      return target[key]
    },
  })
  const recalled = []
  const moved = []
  const window = {
    query: "",
    atRoot: true,
    selectedIndex: 0,
    historyIndex: -1,
    actionPanelOpen: false,
    argFocus: -1,
    argDefs: [],
    view: { kind: "root" },
    numLock: true,
    vim: false,
    isActionPanelKey() { return false },
    nextSelectable() { return 0 },
    recallHistory(step) { recalled.push(step); return true },
    move(step) { moved.push(step) },
    setQuery(value) { window.query = value },
  }
  const context = vm.createContext({ Qt, window, KeyText, Util: { editsFilter: () => false } })
  window.direction = (event, ctrl, alt, inPopup) => {
    context.event = event
    context.ctrl = ctrl
    context.alt = alt
    context.inPopup = inPopup
    return vm.runInContext(body("function direction(event, ctrl, alt, inPopup)"), context)
  }
  context.event = { key: UP, text: "", modifiers: KEYPAD, nativeScanCode: 80 }
  assert.equal(vm.runInContext(body("function handleKey(event)"), context), true)
  assert.equal(window.query, "8")
  assert.deepEqual(recalled, [])
  assert.deepEqual(moved, [])
})

test("arrow up still walks history when it is not the numpad", () => {
  let next = 16
  const Qt = new Proxy({
    NoModifier: 0,
    ControlModifier: 0x04000000,
    ShiftModifier: 0x02000000,
    AltModifier: 0x08000000,
    MetaModifier: 0x10000000,
    Key_Up: UP,
    Key_Down: DOWN,
    Key_PageUp: PAGEUP,
    Key_PageDown: PAGEDOWN,
  }, {
    get(target, key) {
      if (!(key in target)) target[key] = next++
      return target[key]
    },
  })
  const recalled = []
  const window = {
    query: "",
    atRoot: true,
    selectedIndex: 0,
    historyIndex: -1,
    actionPanelOpen: false,
    argFocus: -1,
    argDefs: [],
    view: { kind: "root" },
    numLock: true,
    vim: false,
    isActionPanelKey() { return false },
    nextSelectable() { return 0 },
    recallHistory(step) { recalled.push(step); return true },
    move() {},
    setQuery(value) { window.query = value },
  }
  const context = vm.createContext({ Qt, window, KeyText, Util: { editsFilter: () => false } })
  window.direction = (event, ctrl, alt, inPopup) => {
    context.event = event
    context.ctrl = ctrl
    context.alt = alt
    context.inPopup = inPopup
    return vm.runInContext(body("function direction(event, ctrl, alt, inPopup)"), context)
  }
  context.event = { key: UP, text: "", modifiers: 0, nativeScanCode: 111 }
  assert.equal(vm.runInContext(body("function handleKey(event)"), context), true)
  assert.equal(window.query, "")
  assert.deepEqual(recalled, [1])
})

test("NumLock unlocks the keypad so 8 moves the list", () => {
  const NUMLOCK = 0x01000025
  let next = 16
  const Qt = new Proxy({
    NoModifier: 0,
    ControlModifier: 0x04000000,
    ShiftModifier: 0x02000000,
    AltModifier: 0x08000000,
    MetaModifier: 0x10000000,
    Key_NumLock: NUMLOCK,
    Key_Up: UP,
    Key_Down: DOWN,
    Key_PageUp: PAGEUP,
    Key_PageDown: PAGEDOWN,
  }, {
    get(target, key) {
      if (!(key in target)) target[key] = next++
      return target[key]
    },
  })
  const recalled = []
  const window = {
    query: "",
    numLock: true,
    numLockTouched: false,
    atRoot: true,
    selectedIndex: 0,
    historyIndex: -1,
    actionPanelOpen: false,
    argFocus: -1,
    argDefs: [],
    view: { kind: "root" },
    vim: false,
    isActionPanelKey() { return false },
    nextSelectable() { return 0 },
    recallHistory(step) { recalled.push(step); return true },
    move() {},
    setQuery(value) { window.query = value },
  }
  const context = vm.createContext({ Qt, window, KeyText, Util: { editsFilter: () => false } })
  window.direction = (event, ctrl, alt, inPopup) => {
    context.event = event
    context.ctrl = ctrl
    context.alt = alt
    context.inPopup = inPopup
    return vm.runInContext(body("function direction(event, ctrl, alt, inPopup)"), context)
  }
  context.event = { key: NUMLOCK, text: "6", modifiers: 0, nativeScanCode: 77, isAutoRepeat: false }
  assert.equal(vm.runInContext(body("function handleKey(event)"), context), true)
  assert.equal(window.numLock, false)
  assert.equal(window.query, "")
  context.event = { key: UP, text: "8", modifiers: KEYPAD, nativeScanCode: 80 }
  assert.equal(vm.runInContext(body("function handleKey(event)"), context), true)
  assert.equal(window.query, "")
  assert.deepEqual(recalled, [1])
})
