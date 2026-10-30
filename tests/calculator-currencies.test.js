const test = require("node:test")
const assert = require("node:assert/strict")
const C = require("../plugin/core/Calculator.js")

const rates = { base: "EUR", date: "2026-10-29", rates: { USD: 2, GBP: 0.5, JPY: 100 } }
const complete = { base: "EUR", date: rates.date, rates: Object.fromEntries(Object.keys(C.CURRENCIES).map(code => [code, 2])) }
const value = (query, table = null) => C.evaluate(query, { rates: table })

test("all currencies keep arithmetic independent of absent, complete or unrelated rates", () => {
  for (const code of Object.keys(C.CURRENCIES)) {
    for (const table of [null, complete, rates]) {
      for (const [formula, expected] of [
        [`20 ${code}+5 ${code}`, 25], [`5 ${code}-20 ${code}`, -15],
        [`20 ${code}*3`, 60], [`3*20 ${code}`, 60], [`20 ${code}/4`, 5],
        [`100 ${code}/25 ${code}`, 4], [`0 ${code}/25 ${code}`, 0],
        [`100 ${code}+20%`, 120], [`100 ${code}-20%`, 80],
        [`20% of 100 ${code}`, 20], [`100 ${code}/20%`, 500],
        [`25 ${code} as a % of 100 ${code}`, 0.25], [`10 ${code} mod 3 ${code}`, 1],
        [`abs(-5 ${code})`, 5], [`floor(1.9 ${code})`, 1], [`ceil(1.1 ${code})`, 2],
        [`trunc(-1.9 ${code})`, -1], [`round(1.234 ${code},2)`, 1.23],
        [`min(20 ${code},5 ${code})`, 5], [`max(20 ${code},5 ${code})`, 20],
        [`30 ${code}/h*8 h`, 240], [`240 ${code}/8 h`, 30],
        [`30 ${code}/h+15 ${code}/h`, 45], [`30 ${code}/h/15 ${code}/h`, 2],
        [`60 ${code}/h to ${code}/min`, 1],
      ]) {
        assert.equal(value(formula, table)?.value, expected, formula)
      }
      for (const formula of [`25 ${code}/0 ${code}`, `1 ${code}/0`, `1 ${code} mod 0 ${code}`, `1 ${code} as a % of 0 ${code}`]) {
        assert.equal(value(formula, table), null, formula)
      }
    }
  }
})

test("mixed currencies and unsupported money dimensions are rejected even with rates", () => {
  for (const table of [null, rates]) {
    for (const formula of [
      "10 USD+5 EUR", "10 USD-5 EUR", "10 USD/5 EUR", "10 USD*5 EUR",
      "10 USD mod 3 EUR", "min(10 USD,5 EUR)", "max(5 EUR,10 USD)",
      "10 USD as a % of 20 EUR", "10 USD/h/5 EUR/h", "10 USD/h+5 EUR/h",
      "10 GBP*5 GBP", "(10 GBP)^2", "(10 GBP)^0", "(10 GBP)^-1",
      "1/(10 GBP)", "20%/(10 GBP)", "5 h/(10 GBP)", "10 GBP/h*5 GBP",
      "round(1 GBP,2 EUR)", "asin(1 GBP)",
    ]) assert.equal(value(formula, table), null, formula)
  }
  assert.equal(value("(10 GBP)^1")?.value, 10)
})

test("only explicit conversions consult exchange rates, including compound currencies", () => {
  for (const [formula, expected, copy] of [
    ["10 USD to EUR", 5, "€5.00"], ["10 EUR to USD", 20, "$20.00"],
    ["10 USD to GBP", 2.5, "£2.50"], ["100 JPY to EUR", 1, "€1.00"],
    ["10 USD/h to GBP/h", 2.5, "2.5 GBP/h"],
  ]) {
    const result = value(formula, rates)
    assert.equal(result?.value, expected, formula)
    assert.equal(result?.copy, copy, formula)
    assert.equal(value(formula), null, formula)
  }
  assert.equal(value("10 USD to USD")?.copy, "$10.00")
  assert.equal(value("10 INR to GBP", rates), null)
  assert.equal(value("10 USD to GBP", { base: "USD", date: rates.date, rates: { GBP: 0.25 } })?.value, 2.5)
  assert.equal(value("2.5 GBP to USD", rates)?.value, 10)
  for (const bad of [0, -1, Infinity, NaN, "2"]) {
    assert.equal(value("10 USD to EUR", { base: "EUR", rates: { USD: bad } }), null)
  }
  assert.equal(value("1 GBP/3*3")?.value, 1, "round only when presenting")
})

test("currency syntax, output and quote provenance remain explicit", () => {
  for (const name of ["GBP", "gbp", "Gbp", "quid", "british pounds"]) {
    assert.equal(value(`20 ${name}+5 GBP`)?.copy, "£25.00", name)
  }
  for (const [symbol, code] of Object.entries({ $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR", "₩": "KRW", "₺": "TRY", "₪": "ILS" })) {
    assert.equal(value(`${symbol}10 / 5 ${code}`)?.value, 2, symbol)
    assert.equal(value(`${symbol}10`), null)
    for (const postfix of ["²", "³", "!", "^2"]) assert.equal(value(`${symbol}10${postfix}`), null)
    assert.equal(value(`${symbol}(2+3)`)?.value, 5)
    assert.equal(value(`${symbol}(10²)`)?.value, 100)
    assert.equal(value(`${symbol}30/h*8 h`)?.value, 240)
  }
  assert.equal(value("1234 GBP+0 GBP")?.result, "£1,234.00")
  assert.equal(value("1234 GBP+0 GBP")?.copy, "£1234.00")
  assert.equal(value("-0.001 GBP+0 GBP")?.copy, "£0.00")
  assert.equal(value("1 GBP/8")?.copy, "£0.13")
  assert.equal(value("-1 GBP/8")?.copy, "-£0.13")
  assert.equal(value("1.005 GBP+0 GBP")?.copy, "£1.01")
  assert.equal(value("-1.005 GBP+0 GBP")?.copy, "-£1.01")
  assert.equal(value("9007199254740991 GBP+0 GBP")?.value, 9007199254740991)
  assert.ok(!value("1e308 GBP+0 GBP")?.copy.includes("Infinity"))
  for (const code of ["JPY", "KRW", "HUF", "ISK", "IDR"]) {
    assert.ok(!value(`1 ${code}/2`)?.copy.includes("."), code)
  }
  const converted = value("10 USD to GBP", rates)
  assert.match(converted?.resultCaption || "", /^Frankfurter 2026-10-29 · /)
  assert.equal(converted?.rateDate, rates.date)
  assert.ok(!value("10 GBP+5 GBP", rates)?.resultCaption.includes("Frankfurter"))
})
