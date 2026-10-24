const test = require("node:test")
const assert = require("node:assert/strict")
const C = require("../plugin/core/Calculator.js")
const RS = require("../plugin/core/RootSearch.js")

// Monday 19 Oct 2026, 16:06 in New York (UTC-4). Dates use the process
// zone, so pin it.
process.env.TZ = "America/New_York"
const NOW = Date.UTC(2026, 9, 19, 20, 6)
const env = {
  nowMs: NOW, localOffset: -240, hour12: true,
  rates: { base: "EUR", date: "2026-10-19", rates: { USD: 1.1225, GBP: 0.84205, JPY: 177.63 } },
  zones: { "Asia/Tokyo": 540, "Europe/London": 60, "America/New_York": -240 }
}
const result = (q, e) => { const r = C.evaluate(q, e || env); return r && r.result }

test("arithmetic, precedence, functions and constants", () => {
  assert.equal(result("2+2"), "4")
  assert.equal(result("2 + 3 * 4"), "14")
  assert.equal(result("3(4+5)"), "27")
  assert.equal(result("-2^2"), "-4")
  assert.equal(result("2^10"), "1,024")
  assert.equal(result("2^40"), "1,099,511,627,776", "integers stay exact")
  assert.equal(result("5!"), "120")
  assert.equal(result("10 mod 3"), "1")
  assert.equal(result("10 % 3"), "1", "% before an operand is modulo")
  assert.equal(result("sqrt 16"), "4")
  assert.equal(result("sin(30°)"), "0.5")
  assert.equal(result("0.1+0.2"), "0.3")
  assert.equal(result("1/3"), "0.333333333333")
  assert.equal(result("max(100,200)"), "200", "commas inside calls separate arguments")
  assert.equal(result("1,000,000 * 3"), "3,000,000")
  assert.equal(result("2 × 3 ÷ 4"), "1.5")
  assert.equal(result("pi"), "3.14159265359")
})

test("anything that is not a calculation yields no row", () => {
  for (const q of ["", "firefox", "42", "-5", "5 kg", "e", "1password", "7zip", "now", "time", "may", "20%", "to do", "kg", "x"]) {
    assert.equal(C.evaluate(q, env), null, q)
  }
})

test("Soulver-style percentages", () => {
  assert.equal(result("20% of 50"), "10")
  assert.equal(result("20% off 50"), "40")
  assert.equal(result("20% on 50"), "60")
  assert.equal(result("$30 + 20%"), "$36.00")
  assert.equal(result("100 - 15%"), "85")
  assert.equal(result("50 as a % of 200"), "25%")
  assert.equal(result("$5k + 10%"), "$5,500.00")
})

test("unit conversions", () => {
  assert.equal(result("5 ft to cm"), "152.4 cm")
  assert.equal(result("5 ft in cm"), "152.4 cm", "in after a unit is the conversion word")
  assert.equal(result("12 in to cm"), "30.48 cm", "in after a number is inches")
  assert.equal(result("100 °F to °C"), "37.7778 °C")
  assert.equal(result("100f to c"), "37.7778 °C")
  assert.equal(result("1 GiB to MB"), "1,073.7418 MB")
  assert.equal(result("16px to rem"), "1 rem")
  assert.equal(result("90 min to hours"), "1.5 hours")
  assert.equal(result("5 m^2 to ft^2"), "53.8196 ft²")
  assert.equal(result("1 sq mi to acres"), "640 ac")
  assert.equal(result("kg to lb"), "2.2046 lb")
  assert.equal(C.evaluate("5 kg to cm", env), null, "incompatible units")
})

test("units combine through arithmetic", () => {
  assert.equal(result("3 m * 4 m"), "12 m²")
  assert.equal(result("10 km / 2 h"), "5 km/h")
  assert.equal(result("60 mph * 2 h"), "120 mi")
  assert.equal(result("5 kW * 3 h"), "15 kWh")
  assert.equal(result("5 ft + 6 in"), "5.5 ft")
  assert.equal(result("$30/h * 8 h"), "$240.00")
})

test("currencies use the rates and need them only to convert", () => {
  assert.equal(result("10 usd to eur"), "€8.91")
  assert.equal(result("€30 in £"), "£25.26")
  assert.equal(result("1000 yen to usd"), "$6.32")
  assert.equal(C.evaluate("10 usd to eur", Object.assign({}, env, { rates: null })), null)
  assert.equal(result("$30 + 20%", Object.assign({}, env, { rates: null })), "$36.00")
})

test("dates and durations", () => {
  assert.equal(result("3 days from now"), "Thursday, 22 October 2026 at 4:06 PM")
  assert.equal(result("2 weeks ago"), "Monday, 5 October 2026 at 4:06 PM")
  assert.equal(result("days until christmas"), "67 days", "whole days across the DST switch")
  assert.equal(result("christmas - today"), "67 days")
  assert.equal(result("2026-12-25 + 1 week"), "Friday, 1 January 2027")
  assert.equal(result("next friday + 1 day"), "Saturday, 24 October 2026")
  assert.equal(C.evaluate("christmas - today", env).kind, "date")
})

test("time zones", () => {
  assert.equal(result("time in tokyo"), "5:06 AM (+1 day)")
  assert.equal(result("tokyo time"), "5:06 AM (+1 day)")
  assert.equal(result("3pm london to new york"), "10:00 AM")
  assert.equal(result("3pm in tokyo"), "4:00 AM (+1 day)")
  assert.equal(result("15:00 utc in nyc", Object.assign({}, env, { hour12: false })), "11:00")
  assert.equal(C.evaluate("time in tokyo", Object.assign({}, env, { zones: {} })), null, "no offsets yet")
})

test("bases", () => {
  assert.equal(result("255 to hex"), "0xFF")
  assert.equal(result("10 in binary"), "0b1010")
  assert.equal(result("0xff + 1"), "256")
})

test("captions and copy text", () => {
  const r = C.evaluate("5 ft to cm", env)
  assert.equal(r.inputCaption, "Feet")
  assert.equal(r.resultCaption, "Centimeters")
  assert.equal(r.copy, "152.4 cm")
  assert.equal(C.evaluate("1000 + 234", env).resultCaption, "One Thousand Two Hundred Thirty-four")
  assert.equal(C.evaluate("1000 + 234", env).copy, "1234", "copy has no grouping")
  assert.equal(C.words(-21), "Minus Twenty-one")
})

test("mixed units add up", () => {
  assert.equal(result("5 ft 3 in"), "5.25 ft")
  assert.equal(result("5 ft 3 in to cm"), "160.02 cm")
  assert.equal(result("1 m 50 cm"), "1.5 m")
  assert.equal(result("1 h 30 min + 45 min"), "2.25 hours")
  assert.match(result("3 days 4 hours from now"), /^Thursday, 22 October 2026 at 8:06 PM$/)
  for (const q of ["2 kg 3", "10 usd 5 usd", "100 °F 3 °C"]) assert.equal(C.evaluate(q, env), null, q)
})

test("work time follows workHoursPerDay and remToPxRate is configurable", () => {
  assert.equal(result("40 hours in work days"), "5 work days")
  assert.equal(result("2 work weeks to hours"), "80 hours")
  assert.equal(result("15 hours in workdays", { ...env, workHoursPerDay: 7.5 }), "2 work days")
  assert.equal(result("16px to rem", { ...env, remToPxRate: 10 }), "1.6 rem")
  assert.equal(C.evaluate("3 workdays from now", env), null, "work days are not calendar days")
})

test("unix timestamps", () => {
  const stamp = C.evaluate("unix 1700000000", env)
  assert.equal(stamp.result, "Tuesday, 14 November 2023 at 5:13 PM")
  assert.equal(stamp.inputCaption, "Unix Timestamp")
  assert.equal(result("1700000000 to date"), stamp.result)
  assert.equal(result("1700000000000 to date"), stamp.result, "13 digits are milliseconds")
  assert.equal(result("timestamp 1700000000"), stamp.result)
  const now = C.evaluate("now to unix", env)
  assert.deepEqual([now.result, now.copy, now.resultCaption], [String(NOW / 1000), String(NOW / 1000), "Unix Timestamp"])
  assert.equal(result("unix time"), String(NOW / 1000))
  assert.equal(result("unix now"), String(NOW / 1000))
  assert.equal(result("2023-11-14 to unix"), "1699938000")
  for (const q of ["unix", "epoch", "timestamp", "date"]) assert.equal(C.evaluate(q, env), null, q)
})

test("history is newest first, unique, pruned after 90 days and capped", () => {
  let h = []
  h = C.pushHistory(h, { id: "1", query: "2+2", result: "4", copy: "4", kind: "math" }, NOW - 100 * 864e5)
  h = C.pushHistory(h, { id: "2", query: "5 ft to cm", result: "152.4 cm", copy: "152.4 cm", kind: "conversion" }, NOW)
  assert.deepEqual(h.map((e) => e.id), ["2"], "the 100-day-old entry is gone")
  h = C.pushHistory(h, { id: "3", query: "3*3", result: "9", copy: "9", kind: "math" }, NOW)
  h = C.pushHistory(h, { id: "4", query: "5 ft to cm", result: "152.4 cm", copy: "152.4 cm", kind: "conversion" }, NOW)
  assert.deepEqual(h.map((e) => e.id), ["4", "3"])
  assert.deepEqual(C.filterHistory(h, "cm").map((e) => e.id), ["4"])
  let big = []
  for (let i = 0; i < C.HISTORY_LIMIT + 5; i++) big = C.pushHistory(big, { id: String(i), query: "q" + i, result: "", copy: "", kind: "math" }, NOW)
  assert.equal(big.length, C.HISTORY_LIMIT)
})

test("root search puts the Calculator section first; ↵ copies, Ctrl ↵ pastes", () => {
  const deps = { Ranker: require("../plugin/core/Ranker.js"), Frecency: require("../plugin/core/Frecency.js"), OmarchyMenu: require("../plugin/core/OmarchyMenu.js") }
  const ctx = { commands: {}, frecency: {}, nowMs: NOW, sensitivity: "medium", calculation: C.evaluate("2+2", env) }
  const sections = RS.rootSections(RS.BUILTINS.map(RS.builtinCandidate), "2+2", ctx, deps)
  assert.equal(sections[0].id, "calculator")
  assert.equal(sections[0].rows[0].candidate.calcResult, "4")
  assert.equal(sections.at(-1).id, "fallback-commands")
  assert.deepEqual(sections.at(-1).rows.map((r) => r.candidate.id), ["fallback:google", "fallback:duckduckgo", "fallback:agent"])
  const actions = RS.actionsFor({ kind: "calculator" }).map((a) => a.id)
  assert.deepEqual(actions.slice(0, 2), ["copy-answer", "paste-answer"])
  const calcHistory = RS.rootSections(RS.BUILTINS.map(RS.builtinCandidate), "calc hist", { commands: {}, frecency: {}, nowMs: NOW }, deps)
  assert.equal(calcHistory[0].rows[0].candidate.title, "Calculator History")
})
