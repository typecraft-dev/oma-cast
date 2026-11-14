const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const TextCursor = require("../core/TextCursor.js")

const source = fs.readFileSync(path.join(__dirname, "../ui/LauncherWindow.qml"), "utf8")

function body(signature) {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, signature)
  const open = source.indexOf("{", start) + 1
  const end = source.indexOf("\n  }", open)
  return "(function() {\n" + source.slice(open, end) + "\n})()"
}

function harness(text) {
  let next = 16
  const Qt = new Proxy({ NoModifier: 0, ControlModifier: 1, ShiftModifier: 2, AltModifier: 4, MetaModifier: 8 }, {
    get(target, key) { if (!(key in target)) target[key] = next++; return target[key] }
  })
  const changes = []
  const window = {
    query: "prefix ", actionPanelOpen: false, view: { kind: "root" }, historyIndex: 0, argFocus: -1, argDefs: [],
    queryInputSyncing: false,
    rebuild: reset => changes.push(reset), isTyping: () => false,
    isActionPanelKey: () => false, direction: () => 0
  }
  // The subset of TextInput the launcher touches, with the same caret and
  // selection rules the widget has (selectionStart === selectionEnd === caret
  // when nothing is selected).
  const queryInput = {
    text: window.query,
    selectionStart: window.query.length,
    selectionEnd: window.query.length,
    cursorPosition: window.query.length,
    deselect() { this.selectionStart = this.selectionEnd = this.cursorPosition },
    remove(start, end) {
      this.text = this.text.slice(0, start) + this.text.slice(end)
      this.onTextChanged()
    },
    insert(position, value) {
      this.text = this.text.slice(0, position) + value + this.text.slice(position)
      this.onTextChanged()
    },
    onTextChanged() { window.queryEdited(this.text) }
  }
  const actionPanel = { item: { filter: "" } }
  const clipboardInput = { text: "", clear() { this.text = "" }, paste() { this.text = text } }
  const context = vm.createContext({ Qt, window, queryInput, actionPanel, clipboardInput, TextCursor, Util: { editsFilter: () => false } })
  window.queryEdited = value => {
    context.value = value
    vm.runInContext(body("function queryEdited(value)"), context)
  }
  window.syncQueryInput = () => vm.runInContext(body("function syncQueryInput()"), context)
  window.setQuery = next => {
    context.next = next
    vm.runInContext(body("function setQuery(next)"), context)
    window.syncQueryInput()
  }
  window.deleteQueryWord = forward => {
    context.forward = forward
    vm.runInContext(body("function deleteQueryWord(forward)"), context)
  }
  window.insertQueryText = text => {
    context.text = text
    vm.runInContext(body("function insertQueryText(text)"), context)
  }
  window.pasteClipboard = () => vm.runInContext(body("function pasteClipboard()"), context)
  return {
    Qt, window, queryInput, actionPanel, clipboardInput, changes,
    press(key, modifiers) {
      context.event = { key: Qt["Key_" + key], modifiers }
      return vm.runInContext(body("function handleKey(event)"), context)
    }
  }
}

test("both Omarchy paste shortcuts insert text once without activating a result", () => {
  for (const [key, modifier] of [["V", "ControlModifier"], ["Insert", "ShiftModifier"]]) {
    const h = harness("12+34")
    assert.equal(h.press(key, h.Qt[modifier]), true)
    assert.equal(h.window.query, "prefix 12+34")
    assert.equal(h.window.historyIndex, -1)
    assert.deepEqual(h.changes, [true])
    assert.equal(h.clipboardInput.text, "")
  }
})

test("Ctrl+Shift+V pastes like Ctrl+V", () => {
  const h = harness("12+34")
  assert.equal(h.press("V", h.Qt.ControlModifier | h.Qt.ShiftModifier), true)
  assert.equal(h.window.query, "prefix 12+34")
})

test("paste goes into a focused argument pill, not the query", () => {
  const h = harness("oma cast")
  h.window.argFocus = 0
  h.window.argDefs = [{ name: "query" }]
  h.window.argValues = { query: "about " }
  h.press("V", h.Qt.ControlModifier)
  assert.equal(h.window.argValues.query, "about oma cast")
  assert.equal(h.window.query, "prefix ")
})

test("paste keeps Unicode and markup literal and flattens line breaks", () => {
  const h = harness("<b>你好</b> $(id)\r\nsecond\nthird\u2028fourth\u2029fifth")
  h.press("V", h.Qt.ControlModifier)
  assert.equal(h.window.query, "prefix <b>你好</b> $(id) second third fourth fifth")
})

test("empty or non-text clipboard leaves the query and history unchanged", () => {
  const h = harness("")
  assert.equal(h.press("Insert", h.Qt.ShiftModifier), true)
  assert.equal(h.window.query, "prefix ")
  assert.equal(h.window.historyIndex, 0)
  assert.deepEqual(h.changes, [])
})

test("clipboard paste also works in submenu queries and alias editing", () => {
  const h = harness("some text\nwith\tspaces")
  h.window.view.kind = "menu"
  h.press("V", h.Qt.ControlModifier)
  assert.equal(h.window.query, "prefix some text with\tspaces")
  h.window.view.kind = "alias"
  h.window.setQuery("")
  h.press("Insert", h.Qt.ShiftModifier)
  assert.equal(h.window.query, "sometextwithspaces")
})

test("paste replaces the selection at the caret instead of appending", () => {
  const h = harness("12+34")
  h.queryInput.text = "alpha beta"
  h.window.query = "alpha beta"
  h.queryInput.cursorPosition = 11
  h.queryInput.deselect()
  h.queryInput.selectionStart = 6
  h.queryInput.selectionEnd = 10
  h.queryInput.cursorPosition = 10
  h.press("V", h.Qt.ControlModifier)
  assert.equal(h.window.query, "alpha 12+34")
  assert.equal(h.queryInput.cursorPosition, 11)
  assert.equal(h.queryInput.selectionStart, 11)
  assert.equal(h.queryInput.selectionEnd, 11)
})

test("Ctrl+Backspace deletes the word before the caret, Ctrl+Delete the next one", () => {
  const back = harness("x")
  back.queryInput.text = "alpha beta"
  back.window.query = "alpha beta"
  back.queryInput.cursorPosition = 10
  back.queryInput.deselect()
  back.press("Backspace", back.Qt.ControlModifier)
  assert.equal(back.window.query, "alpha ")
  assert.equal(back.queryInput.text, "alpha ")
  assert.equal(back.queryInput.cursorPosition, 6)

  const forward = harness("x")
  forward.queryInput.text = "alpha beta"
  forward.window.query = "alpha beta"
  forward.queryInput.cursorPosition = 6
  forward.queryInput.deselect()
  forward.press("Delete", forward.Qt.ControlModifier)
  assert.equal(forward.window.query, "alpha ")
  assert.equal(forward.queryInput.cursorPosition, 6)
})

test("action-panel paste edits its filter without changing the query", () => {
  const h = harness("Copy\nResult")
  h.window.actionPanelOpen = true
  h.actionPanel.item.filter = "Find "
  h.press("V", h.Qt.ControlModifier)
  assert.equal(h.actionPanel.item.filter, "Find Copy Result")
  assert.equal(h.window.query, "prefix ")
  assert.deepEqual(h.changes, [])
})

test("unrelated V and Insert shortcuts never read the clipboard", () => {
  for (const [key, modifier] of [["V", "NoModifier"], ["V", "AltModifier"], ["V", "MetaModifier"], ["Insert", "ControlModifier"]]) {
    const h = harness("must not paste")
    h.press(key, h.Qt[modifier])
    assert.equal(h.window.query, "prefix ")
    assert.deepEqual(h.changes, [])
  }
})
