const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const LauncherState = require("../core/LauncherState.js")
const RootSearch = require("../core/RootSearch.js")

// ui/LauncherWindow.qml's Qt key event -> LauncherState event, run as-is.
const source = fs.readFileSync(path.join(__dirname, "../ui/LauncherWindow.qml"), "utf8")
const Qt = {
  Key_Escape: 0x01000000, Key_Tab: 0x01000001, Key_Backtab: 0x01000002, Key_Backspace: 0x01000003,
  Key_Return: 0x01000004, Key_Enter: 0x01000005, Key_Insert: 0x01000006, Key_Up: 0x01000013,
  Key_Down: 0x01000015, Key_PageUp: 0x01000016, Key_PageDown: 0x01000017, Key_Space: 0x20, Key_V: 0x56, Key_K: 0x4b,
  NoModifier: 0, ShiftModifier: 0x02000000, ControlModifier: 0x04000000, AltModifier: 0x08000000, MetaModifier: 0x10000000
}
const keyEvent = (() => {
  const start = source.indexOf("  function keyEvent(event)")
  assert.ok(start >= 0, "LauncherWindow.qml has keyEvent()")
  const end = source.indexOf("\n  }", start) + 4
  return vm.runInNewContext("(" + source.slice(start + 2, end) + ")", { Qt })
})()

// The Omarchy model with a fake backend: one app, rows counted per search.
function harness(clipboard, opts) {
  const searches = []
  let history = (opts && opts.history) || []
  const backend = {
    callSync(method, data) {
      if (method === "settings.getGeneralSettings") return { ok: true, data: { uiZoom: 1, windowMode: "expanded", escapeKeyBehavior: "pop-back-or-close", popToRootTimeout: 90, navigationBindings: "emacs" } }
      if (method === "rootSearch.search") {
        searches.push(data)
        if (opts && opts.failSearch) return { ok: false, error: "Search unavailable" }
        return { ok: true, data: [{ id: "results", title: "Results", rows: (opts && opts.rows) || [{ id: "app:firefox", kind: "app", title: "Firefox" }] }] }
      }
      if (method === "rootSearch.getActions") return { ok: true, data: [{ id: "open", title: "Open Application", shortcut: "↵", section: "primary" }, { id: "copy-id", title: "Copy Desktop ID", shortcut: "Ctrl Shift C", section: "copy" }] }
      if (method === "rootSearch.getSearchHistory") return { ok: true, data: history }
      if (method === "rootSearch.performAction") return { ok: true, data: { close: true } }
      return { ok: true, data: null }
    }
  }
  let reads = 0
  const core = LauncherState.create({
    platform: "omarchy", backend, filters: RootSearch.FILTERS, missingArgument: RootSearch.missingArgument,
    editText: () => null,     // Omarchy's Util.editsFilter, stubbed as in its menus' tests
    host: { dismiss() {}, show() {}, hud() {}, copy() {}, readClipboard: () => { reads++; return clipboard }, later: () => 0, cancel() {}, changed() {} }
  })
  core.prepare({})
  const press = (key, modifiers, text) => core.key(keyEvent({ key: Qt["Key_" + key], modifiers: modifiers || 0, text: text || "" }))
  const type = (text) => { for (const ch of text) press(ch === " " ? "Space" : "V", 0, ch) }
  return { core, press, type, searches, get reads() { return reads }, state: () => core.state() }
}

test("the Qt key mapping gives LauncherState one Ctrl key for both roles", () => {
  const e = keyEvent({ key: Qt.Key_K, modifiers: Qt.ControlModifier, text: "\u000b" })
  assert.equal(e.key, "k")
  assert.equal(e.primary, true)
  assert.equal(e.control, true)
  assert.equal(keyEvent({ key: Qt.Key_Backtab, modifiers: Qt.ShiftModifier, text: "" }).key, "Tab")
  assert.equal(keyEvent({ key: Qt.Key_Enter, modifiers: 0, text: "\r" }).key, "Return")
  assert.equal(keyEvent({ key: Qt.Key_V, modifiers: Qt.MetaModifier, text: "v" }).meta, true)
})

test("both Omarchy paste shortcuts insert text once without activating a result", () => {
  for (const [key, modifier] of [["V", Qt.ControlModifier], ["Insert", Qt.ShiftModifier]]) {
    const h = harness("12+34")
    h.type("prefix ")
    const before = h.searches.length
    assert.equal(h.press(key, modifier), true)
    assert.equal(h.state().query, "prefix 12+34")
    assert.equal(h.searches.length, before + 1, "one search for the pasted text")
  }
})

test("Ctrl+Shift+V pastes like Ctrl+V", () => {
  const h = harness("12+34")
  h.press("V", Qt.ControlModifier | Qt.ShiftModifier)
  assert.equal(h.state().query, "12+34")
})

test("paste goes into a focused argument pill, not the query", () => {
  const h = harness("oma cast", { rows: [{ id: "builtin:google-search", kind: "builtin", title: "Search Google",
    arguments: [{ name: "query", placeholder: "Query", required: true }] }] })
  h.type("goo")
  h.press("Tab")
  assert.equal(h.state().argFocus, 0)
  h.type("about ")
  h.press("V", Qt.ControlModifier)
  assert.equal(h.state().arguments[0].value, "about oma cast")
  assert.equal(h.state().query, "goo")
})

test("paste keeps Unicode and markup literal and flattens line breaks", () => {
  const h = harness("<b>你好</b> $(id)\r\nsecond\nthird fourth fifth")
  h.type("prefix ")
  h.press("V", Qt.ControlModifier)
  assert.equal(h.state().query, "prefix <b>你好</b> $(id) second third fourth fifth")
})

test("empty or non-text clipboard leaves the query and history unchanged", () => {
  const h = harness("", { history: ["prefix "] })
  h.press("Up")
  assert.equal(h.state().query, "prefix ")
  const before = h.searches.length
  assert.equal(h.press("Insert", Qt.ShiftModifier), true)
  assert.equal(h.state().query, "prefix ")
  assert.equal(h.searches.length, before)
})

test("paste in the alias editor drops whitespace", () => {
  const h = harness("some text\nwith\tspaces")
  h.core.push({ kind: "alias", commandId: "app:firefox", title: "Alias for Firefox", value: "" })
  h.press("Insert", Qt.ShiftModifier)
  assert.equal(h.state().query, "sometextwithspaces")
})

test("action-panel paste edits its filter without changing the query", () => {
  const h = harness("Copy\nResult")
  h.type("fire")
  h.press("K", Qt.ControlModifier)
  assert.equal(h.state().popup.kind, "actions")
  const before = h.searches.length
  h.press("V", Qt.ControlModifier)
  assert.equal(h.state().popup.filter, "Copy Result")
  assert.equal(h.state().query, "fire")
  assert.equal(h.searches.length, before)
})

test("unrelated V and Insert shortcuts never read the clipboard", () => {
  for (const modifier of [Qt.NoModifier, Qt.AltModifier, Qt.MetaModifier, Qt.ControlModifier | Qt.MetaModifier]) {
    const h = harness("must not paste")
    h.press("V", modifier)
    assert.equal(h.reads, 0)
  }
  const h = harness("must not paste")
  h.press("Insert", Qt.ControlModifier)
  assert.equal(h.reads, 0)
})

test("a failed search removes retained rows before they can be clicked", () => {
  const h = harness("", { failSearch: true })
  const s = h.state()
  assert.deepEqual(s.rows, [])
  assert.equal(s.selectedIndex, -1)
  assert.equal(s.toast.style, "failure")
  assert.equal(s.toast.title, "Search unavailable")
})

test("nothing activates while an asynchronous search is pending", () => {
  let pending = null
  const performed = []
  const backend = {
    callSync(method, data) {
      if (method === "rootSearch.performAction") { performed.push(data.id); return { ok: true, data: { close: true } } }
      if (method === "rootSearch.getActions") return { ok: true, data: [{ id: "open", title: "Open", shortcut: "↵", section: "primary" }] }
      return { ok: true, data: method === "settings.getGeneralSettings" ? {} : [] }
    }
  }
  const core = LauncherState.create({
    platform: "omarchy", backend, filters: RootSearch.FILTERS,
    search: (request, done) => { pending = done },
    host: { dismiss() {}, show() {}, hud() {}, copy() {}, readClipboard: () => "", later: () => 0, cancel() {}, changed() {} }
  })
  core.prepare({})
  pending({ ok: true, data: [{ id: "results", title: "Results", rows: [{ id: "app:a", kind: "app", title: "A" }] }] })
  core.key({ key: "f", text: "f" })
  assert.equal(core.state().searchPending, true)
  core.key({ key: "Return", text: "" })
  assert.deepEqual(performed, [], "Enter waits for the search")
  pending({ ok: true, data: [{ id: "results", title: "Results", rows: [{ id: "app:f", kind: "app", title: "F" }] }] })
  core.key({ key: "Return", text: "" })
  assert.deepEqual(performed, ["app:f"])
})

test("the Omarchy window keeps Omarchy's theme; colour themes stay macOS-only", () => {
  assert.match(source, /Commons\.Color\.menu\.background/)
  assert.doesNotMatch(source, /theme/i, "LauncherWindow.qml must not read a colour theme")
  assert.equal(fs.existsSync(path.join(__dirname, "../core/Themes.js")), false, "themes live in macos/js/")
  assert.equal("theme" in LauncherState.create({ backend: { callSync: () => ({ ok: false }) }, host: { changed() {} } }).state(), false)
})
