const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const source = fs.readFileSync(path.join(__dirname, "../plugin/ui/LauncherWindow.qml"), "utf8")

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
    rebuild: reset => changes.push(reset), isTyping: () => false,
    isActionPanelKey: () => false, direction: () => 0
  }
  const actionPanel = { item: { filter: "" } }
  const clipboardInput = { text: "", clear() { this.text = "" }, paste() { this.text = text } }
  const context = vm.createContext({ Qt, window, actionPanel, clipboardInput, Util: { editsFilter: () => false } })
  window.setQuery = next => {
    context.next = next
    vm.runInContext(body("function setQuery(next)"), context)
  }
  window.pasteClipboard = () => vm.runInContext(body("function pasteClipboard()"), context)
  return {
    Qt, window, actionPanel, clipboardInput, changes,
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
  h.window.query = ""
  h.press("Insert", h.Qt.ShiftModifier)
  assert.equal(h.window.query, "sometextwithspaces")
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
