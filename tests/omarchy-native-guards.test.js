const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { spawnSync } = require("node:child_process")
const { fileURLToPath, pathToFileURL } = require("node:url")
const OmarchyMenu = require("../plugin/core/OmarchyMenu.js")

const sourcePath = path.join(__dirname, "../plugin/services/OmarchyMenuSource.qml")
const text = fs.readFileSync(sourcePath, "utf8")
const methods = ["createGuardCompiler", "guardItems", "compileGuards", "guardKeys", "finishGuards", "refresh"]

// QML block sample: "  function refresh() {\n  }".
function block(signature, indentation) {
  const start = text.indexOf(signature)
  assert.ok(start >= 0, signature)
  const open = text.indexOf("{", start)
  const end = text.indexOf("\n" + " ".repeat(indentation) + "}", open) + indentation + 2
  assert.ok(end > open, signature)
  return text.slice(start, end)
}

function method(name) {
  return block("function " + name + "(", 2)
}

function sampleTree() {
  return OmarchyMenu.buildTree(OmarchyMenu.parse(JSON.stringify({
    probe: { when: "true", checked: "false", disabled: "custom-check --literal '*'" },
    other: { when: "false" }
  })).items, [])
}

function harness(factory = () => ({ compile: () => "stock-script", destroy() {} })) {
  const imports = []
  const messages = []
  const source = {
    omarchyPath: '/opt/omarchy space "double" \'single\' #percent%',
    guardCompiler: null, tree: sampleTree(), guards: { previous: true }, revision: 7,
    message: (...args) => messages.push(args), providerMenus: () => [], startNextProvider() {}
  }
  const guardProc = { running: false, collected: "", requestTree: null, expectedGuards: [] }
  const context = vm.createContext({
    source, guardProc, providerProc: { running: true }, OmarchyMenu,
    Qt: { createQmlObject: (...args) => { imports.push(args); return factory(...args) } }
  })
  for (const name of methods) {
    vm.runInContext(method(name), context)
    source[name] = context[name]
  }
  return {
    source, guardProc, imports, messages,
    start() {
      vm.runInContext(text.match(/Component.onCompleted: (\{[^\n]+\})/)[1], context)
    },
    exit(code, status = 0, output = "probe:w:1\nprobe:c:0\nprobe:d:1\nother:w:0\n") {
      guardProc.running = false
      guardProc.collected = output
      Object.assign(context, { exitCode: code, exitStatus: status })
      const handler = block("onExited: function(exitCode, exitStatus)", 4)
      vm.runInContext("(" + handler.slice(handler.indexOf("function")) + ")(exitCode, exitStatus)", context)
    },
    destroy() {
      vm.runInContext(text.match(/Component.onDestruction: ([^\n]+)/)[1], context)
    }
  }
}

test("startup can use the legacy fallback, then imports OEM once and compiles every refresh", () => {
  const calls = []
  const h = harness(() => ({ compile: items => { calls.push(items); return "stock-" + calls.length }, destroy() {} }))
  const { source, guardProc } = h
  assert.equal(source.compileGuards(source.tree, source.guardItems(source.tree)), OmarchyMenu.guardScript(source.tree))
  assert.equal(h.imports.length, 0)
  h.start()
  assert.equal(h.imports.length, 1)
  const [code, parent, name] = h.imports[0]
  const url = JSON.parse(code.match(/^import QtQml\nimport ("[^\n]+") as Stock\n/)[1])
  assert.equal(fileURLToPath(url), source.omarchyPath + "/shell/plugins/menu/MenuModel.js")
  assert.equal(parent, source)
  assert.equal(name, "OmarchyGuardCompiler")
  assert.deepEqual(Array.from(guardProc.command), ["bash", "-lc", "stock-1"])
  assert.equal(guardProc.requestTree, source.tree)
  assert.deepEqual(Array.from(guardProc.expectedGuards), ["probe:w", "probe:c", "probe:d", "other:w"])
  h.exit(0)
  source.tree = sampleTree()
  source.tree.items.probe.when = "fresh-custom-check"
  source.refresh()
  assert.equal(h.imports.length, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].probe.when, "fresh-custom-check")
  assert.equal(guardProc.command[2], "stock-2")
})

test("OEM input preserves legacy ID filtering and uses own keys even for prototype names", () => {
  let received
  const h = harness(() => ({ compile: items => { received = items; return "stock" }, destroy() {} }))
  const items = Object.create({ inherited: { id: "inherited", when: "true" } })
  for (const [key, id] of [["probe", "probe"], ["alias", "actual.id"], ["constructor", "constructor"], ["__proto__", "__proto__"], ["hasOwnProperty", "hasOwnProperty"], ["bad", "bad'; echo injected"], ["newline", "bad\nline"], ["empty", ""]]) {
    Object.defineProperty(items, key, { value: { id, when: "true" }, enumerable: true })
  }
  h.source.tree = { items, order: [...Object.keys(items), "inherited", "toString"] }
  h.start()
  assert.equal(Object.getPrototypeOf(received), null)
  assert.deepEqual(Object.keys(received), ["probe", "actual.id", "constructor", "__proto__", "hasOwnProperty"])
  assert.equal(received.__proto__, items.__proto__)
  assert.equal(received.constructor, items.constructor)
  assert.equal(Object.getPrototypeOf(items).inherited.id, "inherited")
})

test("missing OEM import falls back without retrying each refresh", () => {
  const h = harness(() => { throw new Error("No MenuModel.js on this Omarchy") })
  h.start()
  assert.equal(h.source.guardCompiler, null)
  assert.equal(h.guardProc.command[2], OmarchyMenu.guardScript(h.source.tree))
  h.exit(0)
  h.source.refresh()
  assert.equal(h.imports.length, 1)
  assert.equal(h.guardProc.command[2], OmarchyMenu.guardScript(h.source.tree))
  h.destroy()
})

test("throwing or non-string OEM compilers are destroyed once and use unchanged fallback", () => {
  for (const result of [new Error("incompatible compiler"), undefined, null, 17, {}, new String("boxed")]) {
    let destroyed = 0
    let compiled = 0
    const h = harness(() => ({
      compile() { compiled++; if (result instanceof Error) throw result; return result },
      destroy() { destroyed++ }
    }))
    h.start()
    assert.equal(h.guardProc.command[2], OmarchyMenu.guardScript(h.source.tree))
    assert.equal(h.source.guardCompiler, null)
    h.exit(0)
    h.source.refresh()
    h.destroy()
    assert.equal(compiled, 1)
    assert.equal(destroyed, 1)
    assert.equal(h.imports.length, 1)
  }
})

test("component destruction releases a working optional compiler", () => {
  let destroyed = 0
  const h = harness(() => ({ compile: () => "stock", destroy() { destroyed++ } }))
  h.start()
  h.destroy()
  assert.equal(destroyed, 1)
})

test("only successful complete guard responses publish once", () => {
  const h = harness()
  h.start()
  h.exit(0)
  assert.deepEqual(h.source.guards, { when: { probe: true, other: false }, checked: { probe: false }, disabled: { probe: true } })
  assert.equal(h.source.revision, 8)
  assert.deepEqual(h.messages, [])
  h.exit(0)
  assert.equal(h.source.revision, 8)
})

test("nonzero exit or abnormal termination retains previous guards and warns once", () => {
  for (const [code, status] of [[1, 0], [0, 1], [9, 1]]) {
    const h = harness()
    const previous = h.source.guards
    h.start()
    h.exit(code, status)
    assert.equal(h.source.guards, previous)
    assert.equal(h.source.revision, 7)
    assert.equal(h.messages.length, 1)
    assert.equal(h.messages[0][0], "warning")
    assert.match(h.messages[0][1], /refresh failed/)
  }
})

test("exit zero with missing or malformed rows retains previous guards", () => {
  const rows = ["probe:w:1", "probe:c:0", "probe:d:1", "other:w:0"]
  for (let missing = 0; missing < rows.length; missing++) {
    const h = harness()
    const previous = h.source.guards
    h.start()
    h.exit(0, 0, [...rows.filter((row, i) => i !== missing), rows[(missing + 1) % rows.length], "probe:d:2", "bad id:w:1"].join("\n"))
    assert.equal(h.source.guards, previous)
    assert.equal(h.source.revision, 7)
    assert.equal(h.messages.length, 1)
    assert.match(h.messages[0][1], /incomplete/)
  }
  const empty = harness()
  const previous = empty.source.guards
  empty.start()
  empty.exit(0, 0, "")
  assert.equal(empty.source.guards, previous)
})

test("expected tags are captured per request rather than read from changed guard fields", () => {
  const h = harness()
  const previous = h.source.guards
  h.start()
  h.source.tree.items.probe.disabled = ""
  h.exit(0, 0, "probe:w:1\nprobe:c:0\nother:w:0\n")
  assert.equal(h.source.guards, previous)
  assert.match(h.messages[0][1], /incomplete/)
})

test("a response for an old tree is discarded and the current tree is refreshed", () => {
  const h = harness()
  const previous = h.source.guards
  h.start()
  const requested = h.guardProc.requestTree
  h.source.tree = OmarchyMenu.buildTree(OmarchyMenu.parse('{"latest":{"checked":"true"}}').items, [])
  h.source.refresh()
  assert.equal(h.guardProc.requestTree, requested)
  h.exit(0)
  assert.equal(h.source.guards, previous)
  assert.equal(h.source.revision, 7)
  assert.equal(h.guardProc.requestTree, h.source.tree)
  assert.deepEqual(Array.from(h.guardProc.expectedGuards), ["latest:c"])
  assert.equal(h.guardProc.running, true)
  h.exit(0, 0, "latest:c:1\n")
  assert.deepEqual(h.source.guards, { when: {}, checked: { latest: true }, disabled: {} })
  assert.equal(h.source.revision, 8)
})

test("empty guard scripts do not launch a process", () => {
  const h = harness(() => ({ compile: () => "", destroy() {} }))
  h.source.tree = OmarchyMenu.buildTree([], [])
  h.start()
  assert.equal(h.guardProc.running, false)
  assert.equal(h.guardProc.requestTree, null)
})

function sandbox(t) {
  const parent = fs.realpathSync("/tmp")
  const root = fs.mkdtempSync(path.join(parent, "oma-cast-guard-probe-"))
  const marker = path.join(root, ".oma-cast-guard-probe")
  fs.writeFileSync(marker, "guard import fixtures\n")
  t.after(() => {
    assert.ok(path.isAbsolute(root))
    assert.equal(path.dirname(root), parent)
    assert.ok(path.basename(root).startsWith("oma-cast-guard-probe-"))
    assert.equal(fs.readFileSync(marker, "utf8"), "guard import fixtures\n")
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

// Opt in on Omarchy: OMA_CAST_QML_RUNNER=/usr/bin/qs node --test tests/omarchy-native-guards.test.js
test("real QML imports present, missing, broken, throwing and quoted-path OEM fixtures", { skip: !process.env.OMA_CAST_QML_RUNNER }, t => {
  const root = sandbox(t)
  const paths = {}
  const fixtures = {
    present: 'function guardScript(items) { return "stock:" + Object.keys(items).sort().join(",") }\n',
    missing: null,
    broken: 'function guardScript( {\n',
    throws: 'function guardScript(items) { throw new Error("compiler failed") }\n',
    invalid: 'function guardScript(items) { return 7 }\n',
    'space "double" \'single\' #percent%': 'function guardScript(items) { return "stock:" + Object.keys(items).sort().join(",") }\n'
  }
  for (const [name, script] of Object.entries(fixtures)) {
    paths[name] = path.join(root, name)
    const dir = path.join(paths[name], "shell/plugins/menu")
    fs.mkdirSync(dir, { recursive: true })
    if (script !== null) fs.writeFileSync(path.join(dir, "MenuModel.js"), script)
  }
  const env = { ...process.env, HOME: root, TMPDIR: root, QT_QPA_PLATFORM: "offscreen", QML_DISABLE_DISK_CACHE: "1" }
  for (const key of ["XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) {
    env[key] = path.join(root, key)
    fs.mkdirSync(env[key], { mode: 0o700 })
  }
  const coreUrl = pathToFileURL(path.join(__dirname, "../plugin/core/OmarchyMenu.js")).href
  const config = path.join(root, "shell.qml")
  fs.writeFileSync(config, `import QtQml
import Quickshell
import ${JSON.stringify(coreUrl)} as OmarchyMenu
ShellRoot {
  id: source
  property string omarchyPath: ""
  property var guardCompiler: null
  property var tree: ({ items: ({}), order: [] })
  property var guards: ({})
  property int revision: 0
  property var providerQueue: []
  signal message(string level, string text, var metadata)
  property QtObject guardProcess: QtObject {
    id: guardProc
    property bool running: false
    property string collected: ""
    property var requestTree: null
    property var expectedGuards: []
    property var command: []
  }
  property QtObject providerProcess: QtObject { id: providerProc; property bool running: true }
  function providerMenus() { return [] }
  function startNextProvider() {}
  ${methods.map(method).join("\n  ")}
  ${text.match(/Component.onDestruction: [^\n]+/)[0]}
  function check(ok, detail) { if (!ok) throw new Error(detail) }
  Component.onCompleted: Qt.callLater(function() {
    try {
      var paths = ${JSON.stringify(paths)}
      source.tree = { order: ["probe", "bad", "__proto__", "constructor", "toString"], items: JSON.parse(${JSON.stringify(JSON.stringify({
        probe: { id: "probe", when: "true" }, bad: { id: "bad'; echo injected", when: "true" },
        ["__proto__"]: { id: "__proto__", checked: "false" }, constructor: { id: "constructor", disabled: "true" }
      }))}) }
      var items = source.guardItems(source.tree)
      check(Object.getPrototypeOf(items) === null, "input map has a prototype")
      check(Object.keys(items).sort().join(",") === "__proto__,constructor,probe", "unsafe input IDs")
      var fallback = OmarchyMenu.guardScript(source.tree)
      check(source.compileGuards(source.tree, items) === fallback, "startup fallback")
      for (var name in paths) {
        source.omarchyPath = paths[name]
        source.createGuardCompiler()
        var available = name === "present" || name.indexOf("space ") === 0
        if (name !== "missing" && name !== "broken") check(source.guardCompiler !== null, "import failed: " + name)
        var script = source.compileGuards(source.tree, items)
        check(script === (available ? "stock:__proto__,constructor,probe" : fallback), "wrong compiler: " + name)
        if (source.guardCompiler) { source.guardCompiler.destroy(); source.guardCompiler = null }
      }
      console.log("OMA_CAST_GUARD_PROBE:OK")
    } catch (error) { console.error("OMA_CAST_GUARD_PROBE:FAIL " + error) }
    Qt.quit()
  })
}
`)
  const result = spawnSync(process.env.OMA_CAST_QML_RUNNER, ["-p", config], { cwd: root, env, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL" })
  assert.ifError(result.error)
  const output = result.stdout + result.stderr
  assert.equal(result.status, 0, output)
  assert.match(output, /OMA_CAST_GUARD_PROBE:OK/)
  assert.doesNotMatch(output, /OMA_CAST_GUARD_PROBE:FAIL/)
})
