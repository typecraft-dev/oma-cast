const test = require("node:test")
const assert = require("node:assert/strict")
const Rpc = require("../core/Rpc.js")

function registryWithSystem() {
  const reg = Rpc.createRegistry()
  Rpc.register(reg, "system", {
    healthPing: () => null,
    echo: (data) => data,
    fail: () => { throw new Error("boom") },
    later: (data) => Promise.resolve({ got: data }),
    notAFunction: 42
  })
  return reg
}

test("registers dotted method names and lists them sorted", () => {
  const reg = registryWithSystem()
  assert.deepEqual(Rpc.methods(reg), ["system.echo", "system.fail", "system.healthPing", "system.later"])
})

test("rejects duplicate registrations and bad namespaces", () => {
  const reg = registryWithSystem()
  assert.throws(() => Rpc.register(reg, "system", { echo: () => 1 }), /already registered system.echo/)
  assert.throws(() => Rpc.register(reg, "bad ns", { x: () => 1 }), /Invalid namespace/)
})

test("callSync returns data, nulls undefined, and reports errors", () => {
  const reg = registryWithSystem()
  assert.deepEqual(Rpc.callSync(reg, "system.healthPing", {}), { ok: true, data: null })
  assert.deepEqual(Rpc.callSync(reg, "system.echo", { a: 1 }), { ok: true, data: { a: 1 } })
  assert.deepEqual(Rpc.callSync(reg, "system.fail", null), { ok: false, error: "boom" })
  assert.deepEqual(Rpc.callSync(reg, "foo.bar", null), { ok: false, error: "Unknown method foo.bar" })
})

test("callSync marks promise-returning handlers as pending", () => {
  const reg = registryWithSystem()
  assert.deepEqual(Rpc.callSync(reg, "system.later", 1), { ok: true, pending: true })
})

test("call resolves sync and async handlers and rejects failures", async () => {
  const reg = registryWithSystem()
  assert.equal(await Rpc.call(reg, "system.healthPing"), null)
  assert.deepEqual(await Rpc.call(reg, "system.later", 2), { got: 2 })
  await assert.rejects(Rpc.call(reg, "system.fail"), /boom/)
  await assert.rejects(Rpc.call(reg, "nope.nope"), /Unknown method nope.nope/)
})

test("unregister removes a whole namespace only", () => {
  const reg = registryWithSystem()
  Rpc.register(reg, "systemx", { a: () => 1 })
  Rpc.unregister(reg, "system")
  assert.deepEqual(Rpc.methods(reg), ["systemx.a"])
})

test("notifications reach subscribers, survive a throwing one, and unsubscribe", () => {
  const reg = Rpc.createRegistry()
  const seen = []
  const errors = []
  const off = Rpc.subscribe(reg, "window.visibilityChanged", (d) => seen.push(d))
  Rpc.subscribe(reg, "window.visibilityChanged", () => { throw new Error("bad subscriber") })
  assert.equal(Rpc.emit(reg, "window.visibilityChanged", { visible: true }, (m, e) => errors.push([m, e.message])), 2)
  assert.deepEqual(seen, [{ visible: true }])
  assert.deepEqual(errors, [["window.visibilityChanged", "bad subscriber"]])
  off()
  Rpc.emit(reg, "window.visibilityChanged", { visible: false }, () => {})
  assert.deepEqual(seen, [{ visible: true }])
})

test("isMethodName accepts namespace.method only", () => {
  assert.ok(Rpc.isMethodName("rootSearch.search"))
  assert.ok(!Rpc.isMethodName("rootSearch"))
  assert.ok(!Rpc.isMethodName("a..b"))
})
