const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const Agent = require("../plugin/core/Agent.js")

const source = fs.readFileSync(path.join(__dirname, "../plugin/services/AgentLauncher.qml"), "utf8")
function body(text, signature, indentation) {
  const start = text.indexOf(signature)
  assert.ok(start >= 0, signature)
  const open = text.indexOf("{", start) + 1
  const end = text.indexOf("\n" + " ".repeat(indentation) + "}", open)
  assert.ok(end > open, signature)
  return "(function() {\n" + text.slice(open, end) + "\n})()"
}

function harness() {
  const events = []
  const service = {
    checking: false, pendingArgv: null, output: "",
    prepared: argv => events.push({ argv }), failed: message => events.push({ message })
  }
  const check = { running: false }
  const timeout = { restart() {}, stop() {} }
  const context = vm.createContext({ service, check, timeout, Agent })
  service.cancel = () => vm.runInContext(body(source, "function cancel()", 2), context)
  return {
    service, check, events,
    start(query) { context.query = query; vm.runInContext(body(source, "function start(query)", 2), context) },
    exit(exitCode, exitStatus = 0) { Object.assign(context, { exitCode, exitStatus }); vm.runInContext(body(source, "onExited: function(exitCode, exitStatus)", 4), context) },
    timeout() { vm.runInContext(body(source, "onTriggered:", 4), context) }
  }
}

test("successful preflight hands off exactly once and prevents overlapping submissions", () => {
  const h = harness()
  h.start("First question?")
  assert.throws(() => h.start("Second question?"), /already being checked/)
  assert.deepEqual(h.service.pendingArgv, Agent.launchArgv("First question?"))
  h.exit(0)
  h.exit(0)
  assert.deepEqual(h.events, [{ argv: Agent.launchArgv("First question?") }])
  assert.equal(h.service.checking, false)
})

test("closing during preflight suppresses stale success and allows retry after exit", () => {
  const h = harness()
  h.start("Do not launch")
  h.service.cancel()
  assert.equal(h.check.running, false)
  assert.throws(() => h.start("Wait for teardown"), /already being checked/)
  h.exit(0)
  assert.deepEqual(h.events, [])
  h.start("New question")
  h.exit(0)
  assert.deepEqual(h.events, [{ argv: Agent.launchArgv("New question") }])
})

test("failure, crash and timeout never prepare a terminal launch", () => {
  for (const [code, status] of [[1, 0], [0, 1]]) {
    const h = harness()
    h.start("Question")
    h.service.output = "Choose a default agent first\n"
    h.exit(code, status)
    assert.deepEqual(h.events, [{ message: "Choose a default agent first" }])
    h.start("Retry")
  }
  const h = harness()
  h.start("Timed out")
  h.timeout()
  h.exit(0)
  assert.deepEqual(h.events, [{ message: "Agent launch check timed out. Try again." }])
})

test("showing refreshes calculator data and hiding cancels an agent hand-off", () => {
  const text = fs.readFileSync(path.join(__dirname, "../plugin/Backend.qml"), "utf8")
  const events = []
  const context = vm.createContext({
    method: "window.visibilityChanged", data: { visible: true },
    menuSource: { refresh: () => events.push("menu") },
    calculatorData: { refresh: () => events.push("calculator") },
    agentLauncher: { cancel: () => events.push("cancel") },
    translateService: { cancel: () => events.push("translate-cancel") }
  })
  const notify = body(text, "onNotification: function(method, data)", 2)
  vm.runInContext(notify, context)
  assert.deepEqual(events, ["menu", "calculator"])
  context.data = { visible: false }
  vm.runInContext(notify, context)
  assert.deepEqual(events, ["menu", "calculator", "cancel", "translate-cancel"])
  context.data = null
  vm.runInContext(notify, context)
  context.method = "calculator.historyStateChanged"
  context.data = { visible: true }
  vm.runInContext(notify, context)
  assert.equal(events.length, 4)
})

test("entry point dismisses and clears the launcher before starting the terminal", () => {
  const text = fs.readFileSync(path.join(__dirname, "../plugin/Launcher.qml"), "utf8")
  const events = []
  const argv = Agent.launchArgv("Question")
  const context = vm.createContext({
    method: "agent.launchReady", data: { argv },
    root: { hide: () => events.push("hide") },
    launcher: { popToRoot: () => events.push("clear") },
    Util: { execArgv: value => events.push(value) }
  })
  vm.runInContext(body(text, "function onNotification(method, data)", 4), context)
  assert.deepEqual(events, ["hide", "clear", argv])
  context.method = "agent.launchFailed"
  vm.runInContext(body(text, "function onNotification(method, data)", 4), context)
  assert.equal(events.length, 3)
})

test("agent shortcut is limited to root search and preserves normal Enter actions", () => {
  const text = fs.readFileSync(path.join(__dirname, "../plugin/ui/LauncherWindow.qml"), "utf8")
  const events = []
  let next = 16
  const Qt = new Proxy({ ControlModifier: 1, ShiftModifier: 2, AltModifier: 4 }, {
    get(target, key) { if (!(key in target)) target[key] = next++; return target[key] }
  })
  const window = {
    atRoot: true, actionPanelOpen: false, view: { kind: "root" },
    askAgent: () => events.push("agent"), performNth: n => events.push(n),
    saveAlias: () => events.push("save-alias"),
    argFocus: -1, argDefs: [],
    isActionPanelKey: () => false,
    direction: () => 0
  }
  const context = vm.createContext({ Qt, window, event: null })
  function press(modifiers) {
    context.event = { key: Qt.Key_Return, modifiers }
    vm.runInContext(body(text, "function handleKey(event)", 2), context)
  }
  press(Qt.ControlModifier | Qt.AltModifier)
  press(0)
  press(Qt.ControlModifier)
  window.atRoot = false
  window.view.kind = "menu"
  press(Qt.ControlModifier | Qt.AltModifier)
  window.view.kind = "alias"
  press(Qt.ControlModifier | Qt.AltModifier)
  assert.deepEqual(events, ["agent", 0, 1, 1, "save-alias"])
})
