const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")

// Run the actual QML handlers without a desktop or Qt dependency in CI.
const source = fs.readFileSync(require.resolve("../plugin/ui/LauncherWindow.qml"), "utf8")
const handlers = ["isTyping", "handleKey"].map((name) => {
  const match = source.match(new RegExp(`^  function ${name}\\(event\\) \\{[\\s\\S]*?^  \\}`, "m"))
  assert.ok(match, `missing QML handler ${name}`)
  return match[0]
}).join("\n")

// Qt::KeyboardModifier and Qt::Key values from qnamespace.h.
const Qt = {
  NoModifier: 0, ShiftModifier: 0x02000000, ControlModifier: 0x04000000,
  AltModifier: 0x08000000, MetaModifier: 0x10000000,
  KeypadModifier: 0x20000000, GroupSwitchModifier: 0x40000000,
  Key_Escape: 0x01000000, Key_Backspace: 0x01000003,
  Key_Return: 0x01000004, Key_Enter: 0x01000005,
  Key_Up: 0x01000013, Key_Down: 0x01000015,
  Key_PageUp: 0x01000016, Key_PageDown: 0x01000017,
  Key_Space: 32, Key_Plus: 43, Key_Minus: 45, Key_Equal: 61,
  Key_0: 48, Key_1: 49, Key_9: 57, Key_BracketLeft: 91,
  Key_C: 67, Key_D: 68, Key_F: 70, Key_K: 75, Key_N: 78, Key_P: 80
}

function input(kind = "root") {
  const actions = []
  const panel = { filter: "", activateSelected() { actions.push("panel") } }
  const window = {
    view: { kind }, query: "", actionPanelOpen: false,
    setQuery(text) { this.query = text },
    performNth(n) { actions.push(n) },
    nthItem(n) { return n - 1 },
    perform(action, index) { actions.push([action, index]) }
  }
  const api = vm.runInNewContext(`${handlers}\n({ isTyping, handleKey })`, {
    Qt, window, actionPanel: panel, Util: { editsFilter() { return false } }
  })
  window.isTyping = api.isTyping
  return { ...api, window, panel, actions }
}

function key(text, modifiers = Qt.KeypadModifier) {
  return { text, key: text.toUpperCase().charCodeAt(0), modifiers }
}

test("numpad digits, operators and decimal separators are printable", () => {
  const { isTyping } = input()
  for (const text of "0123456789+-/*.,")
    for (const modifiers of [Qt.KeypadModifier, Qt.KeypadModifier | Qt.ShiftModifier])
      assert.equal(isTyping(key(text, modifiers)), true, text)
})

test("normal typing still accepts plain and Shift-modified text", () => {
  const { isTyping } = input()
  for (const text of "aA5+-/*., ")
    for (const modifiers of [Qt.NoModifier, Qt.ShiftModifier])
      assert.equal(isTyping(key(text, modifiers)), true, text)
})

test("keypad flags do not turn shortcut modifiers into text", () => {
  const { isTyping } = input()
  for (const modifier of [Qt.ControlModifier, Qt.AltModifier, Qt.MetaModifier, Qt.GroupSwitchModifier])
    for (const extra of [0, Qt.KeypadModifier, Qt.KeypadModifier | Qt.ShiftModifier])
      assert.equal(isTyping(key("5", modifier | extra)), false)
})

test("empty text, control characters and multi-character text are not typing", () => {
  const { isTyping } = input()
  for (const text of ["", "\r", "\n", "\t", "\x1b", "\x7f", "12"])
    assert.equal(Boolean(isTyping(key(text))), false, JSON.stringify(text))
})

test("numpad text reaches the root query and alias editor", () => {
  for (const kind of ["root", "alias"]) {
    const { handleKey, window, actions } = input(kind)
    const text = kind === "root" ? "2+3*4-6/2+0.5" : "56"
    for (const character of text) assert.equal(handleKey(key(character)), true)
    assert.equal(window.query, text)
    assert.deepEqual(actions, [])
  }
})

test("numpad text filters actions without changing the root query", () => {
  const { handleKey, window, panel, actions } = input()
  window.query = "2+2"
  window.actionPanelOpen = true
  for (const text of "+5") assert.equal(handleKey(key(text)), true)
  assert.equal(panel.filter, "+5")
  assert.equal(window.query, "2+2")
  assert.deepEqual(actions, [])
})

test("keypad Enter and Ctrl-number shortcuts keep their actions", () => {
  for (const [modifiers, expected] of [
    [Qt.KeypadModifier, 0],
    [Qt.KeypadModifier | Qt.ControlModifier, 1],
    [Qt.KeypadModifier | Qt.ControlModifier | Qt.ShiftModifier, 2]
  ]) {
    const { handleKey, window, actions } = input()
    assert.equal(handleKey({ key: Qt.Key_Enter, text: "\r", modifiers }), true)
    assert.deepEqual(actions, [expected])
    assert.equal(window.query, "")
  }
  const { handleKey, actions } = input()
  assert.equal(handleKey(key("1", Qt.ControlModifier | Qt.KeypadModifier)), true)
  assert.deepEqual(actions, [["open", 0]])
})
