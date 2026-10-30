const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const os = require("node:os")
const { spawnSync } = require("node:child_process")
const C = require("../plugin/core/Calculator.js")
const Schema = require("../plugin/core/Schema.js")

const source = fs.readFileSync(path.join(__dirname, "../plugin/services/CalculatorData.qml"), "utf8")
const backendSource = fs.readFileSync(path.join(__dirname, "../plugin/Backend.qml"), "utf8")
const NOW = Date.UTC(2026, 9, 30, 12)
const quote = { base: "EUR", date: "2026-10-29", rates: { USD: 2, GBP: 0.5 } }

function block(signature, indentation, text = source) {
  const start = text.indexOf(signature)
  assert.ok(start >= 0, signature)
  const open = text.indexOf("{", start)
  const end = text.indexOf("\n" + " ".repeat(indentation) + "}", open)
  assert.ok(end > open, signature)
  return text.slice(open, end + indentation + 2)
}

function harness() {
  let now = NOW
  const requests = [], writes = [], messages = []
  class Clock extends Date { static now() { return now } }
  class Request {
    static DONE = 4
    constructor() { requests.push(this) }
    open(method, url) { this.method = method; this.url = url }
    send() { if (this.failSend) throw new Error("offline") }
    abort() { this.aborted = true; this.respond(0, "") }
    respond(status, text) {
      this.status = status
      this.responseText = text
      this.readyState = Request.DONE
      this.onreadystatechange()
    }
  }
  const data = {
    cacheDir: "/fake-cache", ratesEnabled: true, rates: null, ratesFetchedAt: 0,
    ratesTriedAt: 0, ratesRevision: 0, zonesAt: NOW, cacheRead: false, request: null,
    message: (...args) => messages.push(args),
  }
  const requestTimeout = { running: false, restart() { this.running = true }, stop() { this.running = false } }
  const zoneProcess = { running: false }
  const context = vm.createContext({ data, requestTimeout, zoneProcess, Date: Clock, XMLHttpRequest: Request, cache: { setText: text => writes.push(text) } })
  for (const name of ["ratesUrl", "ratesMaxAgeMs", "retryAfterMs", "zonesMaxAgeMs"]) {
    const declaration = source.match(new RegExp("readonly property (?:string|double) " + name + ": ([^\\n]+)"))
    assert.ok(declaration, name)
    data[name] = vm.runInContext("(" + declaration[1] + "\n)", context)
  }
  for (const match of source.matchAll(/^  function (\w+)\([^\n]+/gm)) {
    const start = match.index
    const end = source.indexOf("\n  }", start)
    vm.runInContext(source.slice(start, end + 4), context)
    data[match[1]] = context[match[1]]
  }
  return {
    data, requests, writes, messages, requestTimeout, zoneProcess, Request,
    advance(ms) { now += ms },
    missing() { vm.runInContext(source.match(/onLoadFailed: (\{[^\n]+\})/)[1], context) },
    load(doc) { data.loadCache(typeof doc === "string" ? doc : JSON.stringify(doc)) },
    respond(doc = quote, status = 200, index = requests.length - 1) { requests[index].respond(status, typeof doc === "string" ? doc : JSON.stringify(doc)) },
    timeout() { vm.runInContext("(function() " + block("    onTriggered: {", 4) + ")()", context) },
    enable(enabled) {
      data.ratesEnabled = enabled
      vm.runInContext(block("  onRatesEnabledChanged: {", 2), context)
    },
    destroy() { vm.runInContext(source.match(/Component.onDestruction: ([^\n]+)/)[1], context) },
  }
}

test("missing cache fetches once and persists validated quotes with a separate fetch time", () => {
  const h = harness()
  h.missing()
  h.data.refresh()
  h.data.fetchRates()
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].method, "GET")
  assert.equal(h.requests[0].url, "https://api.frankfurter.dev/v1/latest")
  assert.equal(h.requestTimeout.running, true)
  h.respond()
  assert.equal(h.data.request, null)
  assert.equal(h.requestTimeout.running, false)
  assert.deepEqual(JSON.parse(h.writes[0]), { fetchedAt: NOW, ...quote })
  assert.equal(h.data.ratesRevision, 1)
  h.data.refresh()
  assert.equal(h.requests.length, 1)
})

test("fresh cache survives restart and refreshes at the age boundary without changing the quote date", () => {
  const h = harness()
  h.load({ ...quote, fetchedAt: NOW })
  assert.equal(h.requests.length, 0)
  assert.equal(h.data.rates.date, quote.date)
  h.advance(h.data.ratesMaxAgeMs - 1)
  h.data.refresh()
  assert.equal(h.requests.length, 0)
  h.advance(1)
  h.data.refresh()
  assert.equal(h.requests.length, 1)
  h.respond()
  assert.equal(h.data.rates.date, quote.date)
  assert.equal(h.data.ratesFetchedAt, NOW + h.data.ratesMaxAgeMs)
  const restarted = harness()
  restarted.advance(h.data.ratesMaxAgeMs)
  restarted.load(h.writes[0])
  assert.equal(restarted.requests.length, 0)
  assert.equal(restarted.data.rates.date, quote.date)
})

test("offline, HTTP and malformed responses preserve cached rates and bound ordinary retries", () => {
  for (const [response, status] of [["offline", 0], ["server error", 500], ["{", 200], [{ ...quote, rates: {} }, 200]]) {
    const h = harness()
    h.load({ ...quote, fetchedAt: NOW })
    const previous = h.data.rates
    h.advance(h.data.ratesMaxAgeMs)
    h.data.refresh()
    h.respond(response, status)
    assert.equal(h.data.rates, previous)
    assert.equal(h.data.ratesFetchedAt, NOW)
    assert.equal(h.writes.length, 0)
    h.advance(h.data.retryAfterMs - 1)
    h.data.refresh()
    assert.equal(h.requests.length, 1)
    h.advance(1)
    h.data.refresh()
    assert.equal(h.requests.length, 2)
  }
})

test("timeout, disabling and destruction cancel requests and ignore late callbacks", () => {
  for (const cancel of [h => h.timeout(), h => h.enable(false), h => h.destroy()]) {
    const h = harness()
    h.missing()
    cancel(h)
    assert.equal(h.requests[0].aborted, true)
    assert.equal(h.data.request, null)
    assert.equal(h.requestTimeout.running, false)
    h.respond()
    assert.equal(h.data.rates, null)
    assert.equal(h.writes.length, 0)
  }
  const h = harness()
  h.missing()
  h.timeout()
  h.advance(h.data.retryAfterMs)
  h.data.refresh()
  h.respond({ ...quote, date: "2026-10-30" })
  h.respond(quote, 200, 0)
  assert.equal(h.data.rates.date, "2026-10-30")
  assert.equal(h.writes.length, 1)
})

test("disabled or uninitialised services make no requests; enabling honours cache freshness", () => {
  const h = harness()
  h.data.fetchRates()
  assert.equal(h.requests.length, 0)
  h.enable(false)
  h.missing()
  h.data.fetchRates()
  assert.equal(h.requests.length, 0)
  h.enable(true)
  assert.equal(h.requests.length, 1)
  h.enable(false)
  h.enable(true)
  assert.equal(h.requests.length, 2, "re-enabling can retry a cancelled first request")
  h.respond(quote, 200, 0)
  assert.equal(h.data.rates, null)
  h.respond()
  h.enable(false)
  h.enable(true)
  assert.equal(h.requests.length, 2)
})

test("invalid quote fields cannot replace valid rates", () => {
  for (const doc of [
    null, [], { ...quote, base: "eur" }, { ...quote, base: "EUR!" }, { ...quote, base: ["EUR"] },
    { ...quote, date: "2026-02-30" }, { ...quote, date: "2026-10-31" },
    { ...quote, date: "yesterday" }, { ...quote, rates: [] }, { ...quote, rates: {} },
    ...[0, -1, "2", null, Infinity, NaN].map(rate => ({ ...quote, rates: { USD: rate } })),
    { ...quote, rates: { usd: 2 } }, { ...quote, rates: { EUR: 2 } },
  ]) {
    const h = harness()
    assert.equal(h.data.validRates(doc), null, JSON.stringify(doc))
    h.load({ ...quote, fetchedAt: NOW })
    const previous = h.data.rates
    h.data.fetchRates()
    h.respond(doc)
    assert.equal(h.data.rates, previous)
    assert.equal(h.writes.length, 0)
  }
  const h = harness()
  h.missing()
  h.respond('{"base":"EUR","date":"2026-10-29","rates":{"USD":1e400}}')
  assert.equal(h.data.rates, null)
})

test("invalid cache timestamps are rejected and old quotes never overwrite newer data", () => {
  for (const fetchedAt of [undefined, null, "123", 0, -1, Infinity, NOW + 1, Date.UTC(2026, 9, 28)]) {
    const h = harness()
    h.enable(false)
    h.load({ ...quote, fetchedAt })
    assert.equal(h.data.rates, null, String(fetchedAt))
    assert.equal(h.data.cacheRead, true)
  }
  const h = harness()
  h.load({ ...quote, fetchedAt: NOW })
  h.data.fetchRates()
  h.respond({ ...quote, date: "2026-10-28" })
  assert.equal(h.data.rates.date, quote.date)
  assert.equal(h.writes.length, 0)
  h.data.fetchRates()
  h.respond({ ...quote, date: "2026-10-30" })
  h.load({ ...quote, fetchedAt: NOW })
  assert.equal(h.data.rates.date, "2026-10-30")
})

test("synchronous request failures release the in-flight guard and keep retries bounded", () => {
  const h = harness()
  h.Request.prototype.failSend = true
  h.missing()
  assert.equal(h.requests[0].aborted, true)
  assert.equal(h.data.request, null)
  assert.equal(h.requestTimeout.running, false)
  h.data.refresh()
  assert.equal(h.requests.length, 1)
  h.advance(h.data.retryAfterMs)
  h.data.refresh()
  assert.equal(h.requests.length, 2)
})

test("backend disabling hides cached exchange data but leaves same-currency maths available", () => {
  const start = backendSource.indexOf("  function calculatorEnv()")
  const end = backendSource.indexOf("\n  }", start)
  const backend = { config: { currencyRates: true }, configLoaded: true, hour12: false }
  const calculatorData = { rates: quote, zones: {}, ratesRevision: 1, zonesAt: NOW }
  const context = vm.createContext({ backend, calculatorData })
  vm.runInContext(backendSource.slice(start, end + 4), context)
  assert.equal(C.evaluate("10 USD to GBP", context.calculatorEnv())?.value, 2.5)
  backend.config.currencyRates = false
  assert.equal(C.evaluate("10 USD to GBP", context.calculatorEnv()), null)
  assert.equal(C.evaluate("10 USD/5 USD", context.calculatorEnv())?.value, 2)
  const binding = backendSource.match(/readonly property double calculatorRevision: ([^\n]+)/)[1]
  const disabledRevision = vm.runInContext(binding, context)
  backend.config.currencyRates = true
  assert.notEqual(vm.runInContext(binding, context), disabledRevision)
  backend.configLoaded = false
  assert.equal(C.evaluate("10 USD to GBP", context.calculatorEnv()), null)
  assert.equal(vm.runInContext(binding, context), disabledRevision)
})

test("initial config/cache ordering cannot send requests before the saved preference is known", () => {
  const configSource = backendSource.slice(backendSource.lastIndexOf("  FileView {"))
  const ratesEnabled = backendSource.match(/    ratesEnabled: ([^\n]+)/)[1]
  for (const cacheFirst of [false, true]) {
    for (const saved of [{ currencyRates: false }, { currencyRates: true }, null, "malformed"]) {
      const h = harness()
      const backend = { config: Schema.withConfigDefaults(null), configLoaded: false, directoriesReady: true, log() {} }
      const context = vm.createContext({ backend, Schema, text: () => saved === "malformed" ? "{" : JSON.stringify(saved), path: "/fake/config.json" })
      const sync = () => h.enable(vm.runInContext(ratesEnabled, context))
      sync()
      assert.equal(h.data.ratesEnabled, false)
      if (cacheFirst) {
        h.missing()
        assert.equal(h.requests.length, 0)
      }
      const handler = saved === null ? "    onLoadFailed: {" : "    onLoaded: {"
      vm.runInContext("(function() " + block(handler, 4, configSource) + ")()", context)
      sync()
      if (!cacheFirst) h.missing()
      assert.equal(backend.configLoaded, true)
      assert.equal(h.requests.length, saved?.currencyRates === false ? 0 : 1)
    }
  }
})

test("real QML imports the rate service, reads a cache and runs currency calculations offline", { skip: !process.env.OMA_CAST_QML_RUNNER }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oma-cast-currency-qml-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const dir of ["services", "core", "cache", "runtime"]) fs.mkdirSync(path.join(root, dir), { mode: 0o700 })
  fs.copyFileSync(path.join(__dirname, "../plugin/services/CalculatorData.qml"), path.join(root, "services/CalculatorData.qml"))
  fs.copyFileSync(path.join(__dirname, "../plugin/core/Calculator.js"), path.join(root, "core/Calculator.js"))
  fs.writeFileSync(path.join(root, "cache/currencies.json"), JSON.stringify({ ...quote, date: "2000-01-03", fetchedAt: Date.now() }))
  fs.writeFileSync(path.join(root, "shell.qml"), `import QtQuick
import Quickshell
import "services"
import "core/Calculator.js" as Calculator
ShellRoot {
  CalculatorData {
    id: data
    ratesEnabled: false
    cacheDir: Qt.resolvedUrl("cache").toString().replace(/^file:\\/\\//, "")
  }
  Timer {
    interval: 100
    running: true
    repeat: true
    property int attempts: 0
    onTriggered: {
      attempts++
      if (!data.cacheRead && attempts < 20) return
      try {
        if (!data.rates || data.rates.base !== "EUR") throw new Error("cache not loaded")
        data.fetchRates()
        if (data.request) throw new Error("disabled service made a request")
        if (Calculator.evaluate("10 INR/5 INR", {rates: data.rates}).value !== 2) throw new Error("partial rates changed arithmetic")
        var answer = Calculator.evaluate("10 USD/h to GBP/h", {rates: data.rates})
        if (answer.value !== 2.5 || answer.rateDate !== "2000-01-03") throw new Error("compound conversion failed")
        if (answer.resultCaption.indexOf("Frankfurter 2000-01-03") < 0) throw new Error("missing quote date")
        if (Calculator.evaluate("10 USD/5 EUR", {rates: data.rates}) !== null) throw new Error("mixed arithmetic accepted")
        if (Calculator.evaluate("-1 GBP/8", {}).copy !== "-£0.13") throw new Error("negative monetary tie")
        if (data.validRates({base:"EUR", date:"2026-02-30", rates:{USD:2}})) throw new Error("invalid date accepted")
        console.log("OMA_CAST_CURRENCY_QML:OK")
      } catch (error) { console.error("OMA_CAST_CURRENCY_QML:FAIL " + error) }
      Qt.quit()
    }
  }
}
`)
  const result = spawnSync(process.env.OMA_CAST_QML_RUNNER, ["-p", path.join(root, "shell.qml")], {
    cwd: root,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: path.join(root, "cache"), XDG_RUNTIME_DIR: path.join(root, "runtime"), QT_QPA_PLATFORM: "offscreen", QML_DISABLE_DISK_CACHE: "1" },
    encoding: "utf8", timeout: 10000, killSignal: "SIGKILL",
  })
  assert.ifError(result.error)
  const output = result.stdout + result.stderr
  assert.equal(result.status, 0, output)
  assert.match(output, /OMA_CAST_CURRENCY_QML:OK/)
  assert.doesNotMatch(output, /OMA_CAST_CURRENCY_QML:FAIL|TypeError|ReferenceError/)
})
