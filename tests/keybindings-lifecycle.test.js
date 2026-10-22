const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const Keybindings = require("../plugin/core/Keybindings.js")

function body(text, signature, indentation) {
  const start = text.indexOf(signature)
  assert.ok(start >= 0, signature)
  const open = text.indexOf("{", start) + 1
  const end = text.indexOf("\n" + " ".repeat(indentation) + "}", open)
  assert.ok(end > open, signature)
  return "(function() {\n" + text.slice(open, end) + "\n})()"
}
const sourceText = fs.readFileSync(path.join(__dirname, "../plugin/services/KeybindingsSource.qml"), "utf8")
function sourceHarness() {
  const source = { rows: [], error: "", lastOutput: "", revision: 0 }
  const process = { running: false, collected: "" }
  const context = vm.createContext({ source, process, Keybindings })
  return {
    source, process,
    refresh() { vm.runInContext(body(sourceText, "function refresh()", 2), context) },
    exit(output, exitCode = 0, exitStatus = 0) {
      process.running = false
      process.collected = output
      Object.assign(context, { exitCode, exitStatus })
      vm.runInContext(body(sourceText, "onExited: function(exitCode, exitStatus)", 4), context)
    }
  }
}
const output = "SUPER SHIFT + F → File manager\n"

test("refresh preserves in-flight output and only rebuilds changed results", () => {
  const h = sourceHarness()
  h.refresh()
  assert.equal(h.process.running, true)
  h.process.collected = "partial"
  h.refresh()
  assert.equal(h.process.collected, "partial")
  h.exit(output)
  assert.equal(h.source.rows[0].title, "File manager")
  assert.equal(h.source.revision, 1)
  h.exit(output)
  assert.equal(h.source.revision, 1)
  h.exit("SUPER SHIFT + H → Notion\n")
  assert.equal(h.source.rows[0].title, "Notion")
  assert.equal(h.source.revision, 2)
})

test("failed or timed-out refresh retains last bindings and recovery clears the error", () => {
  for (const [code, status] of [[1, 0], [124, 0], [0, 1]]) {
    const h = sourceHarness()
    h.exit(output)
    h.exit("partial", code, status)
    assert.equal(h.source.rows[0].title, "File manager")
    assert.ok(h.source.error)
    h.exit(output)
    assert.equal(h.source.error, "")
    assert.equal(h.source.revision, 3)
    h.exit("")
    assert.deepEqual(h.source.rows, [])
  }
})

test("opening a shortcut only copies its literal chord and leaves the view open", () => {
  const backendText = fs.readFileSync(path.join(__dirname, "../plugin/Backend.qml"), "utf8")
  const calls = []
  const row = Keybindings.parse(output)[0]
  const context = vm.createContext({
    data: { id: row.id, action: "open" },
    backend: { decorated: () => row, keybindingText: key => key },
    Util: { execArgv: argv => calls.push(Array.from(argv)) }
  })
  const result = vm.runInContext(body(backendText, "function performAction(data)", 2), context)
  assert.deepEqual(calls, [["wl-copy", "--", "SUPER SHIFT + F"]])
  assert.equal(result.toast.style, "success")
  assert.equal(result.close, undefined)
})
