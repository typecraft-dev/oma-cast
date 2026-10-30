const test = require("node:test")
const assert = require("node:assert/strict")
const C = require("../plugin/core/Calculator.js")

process.env.TZ = "UTC"
const env = { nowMs: Date.UTC(2026, 9, 30, 12), localOffset: 0, hour12: false, zones: { "Asia/Tokyo": 540 } }

function value(query, expected, options = env, tolerance = 1e-12) {
  const r = C.evaluate(query, options)
  assert.ok(r, query)
  assert.ok(Number.isFinite(r.value), query)
  assert.ok(Math.abs(r.value - expected) <= tolerance * Math.max(Math.abs(expected), (expected === 0 ? 1 : Number.MIN_VALUE)), `${query}: ${r.value} != ${expected}`)
  return r
}

function reject(queries) {
  for (const query of queries) assert.equal(C.evaluate(query, env), null, query)
}

test("formula precedence, aliases and constants", () => {
  for (const [q, n] of [
    ["2+3*4", 14], ["(2+3)*4", 20], ["-2^2", -4], ["(-2)^2", 4],
    ["2^3^2", 512], ["2^-3", 0.125], ["3(4+5)", 27], ["2**3", 8],
    ["2×3÷4", 1.5], ["3·4", 12], ["3⋅4", 12], ["3−4", -1], ["3–4", -1],
    ["2pi", 2 * Math.PI], ["π+0", Math.PI], ["tau+0", 2 * Math.PI],
    ["τ+0", 2 * Math.PI], ["e+0", Math.E], ["phi+0", (1 + Math.sqrt(5)) / 2],
    ["φ+0", (1 + Math.sqrt(5)) / 2], ["√16", 4], ["3²", 9], ["2³", 8]
  ]) value(q, n)
})

test("numeric syntax and double precision boundaries", () => {
  for (const [q, n] of [
    ["0.1+0.2", 0.3], ["1e3+2", 1002], ["5k+1", 5001], ["(1,000+2)*3", 3006],
    ["max(100,200)", 200], ["max((1,000+2),200)", 1002], ["0*5", 0], ["-2+1", -1],
    ["1e-300*2", 2e-300], ["1e300*2", 2e300], ["1e-300*1e-300", 0],
    ["9007199254740990+1", Number.MAX_SAFE_INTEGER],
    ["9007199254740992+1", 9007199254740992]
  ]) value(q, n)
  reject(["1e309+1", "1e308*2", "(1/0)^0", "sqrt(-1)^0", "1e308 as percent"])
})

test("factorial and modulo boundaries", () => {
  for (const [q, n] of [
    ["0!", 1], ["5!", 120], ["170!", 7.257415615307994e306],
    ["10 mod 3", 1], ["-10 mod 3", 2], ["10 mod -3", -2], ["-10 mod -3", -1],
    ["10 % 3", 1], ["10 mod 2.5", 0]
  ]) value(q, n)
  reject(["171!", "(-1)!", "2.5!", "(1 m)!", "(20%)!", "10 mod 0", "0 mod 0", "10 % 0"])
})

test("percentages retain or cancel percent identity", () => {
  for (const [q, n] of [
    ["20% of 50", 10], ["20% off 50", 40], ["20% on 50", 60],
    ["100+10%+10%", 121], ["50 as a % of 200", 0.25],
    ["50%*25%", 0.125], ["50%/25%", 2], ["50%/2", 0.25], ["100/20%", 500]
  ]) value(q, n)
  assert.equal(C.evaluate("50%*25%", env).copy, "12.5%")
  assert.equal(C.evaluate("50%/25%", env).copy, "2")
  reject(["50 as a % of 0", "50%/0%", "1/0%", "20%%", "5%+1"])
})

const functions = {
  sqrt: [[16], 4], cbrt: [[27], 3], abs: [[-2], 2], exp: [[1], Math.E], ln: [[Math.E], 1],
  log: [[8, 2], 3], log10: [[100], 2], log2: [[8], 3], floor: [[-1.2], -2],
  ceil: [[-1.2], -1], trunc: [[-1.2], -1], sign: [[-5], -1], round: [[1.234, 2], 1.23],
  sin: [[0], 0], cos: [[0], 1], tan: [[0], 0], asin: [[1], Math.PI / 2],
  acos: [[1], 0], atan: [[1], Math.PI / 4], arcsin: [[1], Math.PI / 2],
  arccos: [[1], 0], arctan: [[1], Math.PI / 4], sinh: [[0], 0], cosh: [[0], 1], tanh: [[0], 0],
  min: [[2, -1, 3], -1], max: [[2, -1, 3], 3], pow: [[2, 3], 8], hypot: [[3, 4], 5]
}

test("every registered function and alias has valid, arity and unit checks", () => {
  for (const [name, [args, expected]] of Object.entries(functions)) {
    value(`${name}(${args.join(",")})`, expected)
    reject([`${name}()`, `${name}(today)`, `${name}(1 m,2 s)`])
    if (!["min", "max", "hypot", "round", "log", "pow"].includes(name)) reject([`${name}(1,2)`])
    if (["round", "log", "pow"].includes(name)) reject([`${name}(1,2,3)`])
    if (!["abs", "floor", "ceil", "trunc", "round", "min", "max"].includes(name)) reject([`${name}(1 kg)`])
  }
  for (const q of ["min(3)", "max(3)", "hypot(3)"]) value(q, 3)
  value("log(100)", 2)
  value("round(-1.5)", -1)
  value("round(-1.25,1)", -1.2)
  value("round(123,-1)", 120)
  value("sin(30 deg)", 0.5)
  value("cos(180 deg)", -1)
  value("asin(1) to deg", 90)
  value("cbrt(-27)", -3)
  value("sqrt(0)", 0)
  value("abs(0)", 0)
  value("sign(0)", 0)
  value("asin(-1)", -Math.PI / 2)
  value("acos(-1)", Math.PI)
  reject(["sqrt(16,25)", "pow(2)", "sqrt(-1)", "ln(0)", "log(0)", "log(8,1)",
    "log(8,0)", "log(8,-2)", "asin(2)", "acos(-2)", "asin(1 m)", "sin(1 kg)",
    "round(1.2,2 m)", "round(1.2,20%)", "round(1.2,1.5)", "round(1.2,309)", "exp(1000)"])
})

test("units keep dimensions through powers, products and explicit targets", () => {
  for (const [q, n, unit] of [
    ["5 ft+6 in", 5.5, "ft"], ["1 h 30 min+45 min", 2.25, "hours"],
    ["3 m*4 m", 12, "m²"], ["10 m/5 m", 2, ""], ["10 km/2 h", 5, "km/h"],
    ["5 kW*3 h", 15, "kWh"], ["10 m/s^2*2 s", 20, "m/s"],
    ["10 m/s²*2 s to m/s", 20, "m/s"], ["1 kg/m^3*1 m3", 1, "kg"],
    ["10 m/s to cm/s", 1000, "cm/s"], ["10 m/s to m/min", 600, "m/min"],
    ["2 m^2^2 to m^4", 2, "m^4"], ["2m²² to m^4", 2, "m^4"],
    ["(2 m)^0", 1, ""], ["min(1 m,2 cm)", 0.02, "m"], ["round(1.234 m,2)", 1.23, "m"],
    ["32 °F to °C", 0, "°C"], ["0 °C to K", 273.15, "K"],
    ["1 GiB to MB", 1073.741824, "MB"], ["(2 cm)^-2 to m^-2", 2500, "m^-2"], ["1e305 m+1e305 m", 2e305, "m"]
  ]) {
    const r = value(q, n, env, 1e-12)
    assert.equal(r.copy.split(" ").slice(1).join(" "), unit, q)
  }
  reject(["5 m+2 s", "5 kg to cm", "5 m to kg", "(2 m)^0.5", "1 m^1.5+0 m", "20 °C*2 m", "2 °C^-1 to K^-1", "2 °C^-1*2 K", "2 °C^2 to K^2", "2 °F^-1*2 K", "1 cm^1000+1 m", "1 km^1000+1 m"])
})

test("existing mixed plain/unit and absolute-temperature rules", () => {
  value("5 m+2", 7)
  value("2+5 m", 7)
  value("min(5 m,2)", 2)
  value("max(5 m,6)", 6)
  reject(["min(2,5 m)", "max(2,5 m)"])
  value("20 °C+32 °F", 20)
  value("20 °C-32 °F", 20)
})

test("configuration and integer bases", () => {
  value("16 px to rem", 1.6, { ...env, remToPxRate: 10 })
  value("15 hours in workdays", 2, { ...env, workHoursPerDay: 7.5 })
  value("2 work weeks to hours", 75, { ...env, workHoursPerDay: 7.5 })
  for (const [q, expected] of [["255 to hex", "0xFF"], ["0xff+1", "256"],
    ["0b11+1", "4"], ["0o7+1", "8"], ["-255 to hex", "-0xFF"],
    ["9007199254740991 to hex", "0x1FFFFFFFFFFFFF"]]) assert.equal(C.evaluate(q, env).copy, expected)
  reject(["1.5 to hex", "9007199254740992 to hex", "-9007199254740992 to bin", "0xg+1", "0b12+1"])
})

test("dates, Unix timestamps, rollover and timezone presentation", () => {
  value("3 days from now", Date.UTC(2026, 10, 2, 12))
  value("days until christmas", 56)
  value("2026-12-25+1 week", Date.UTC(2027, 0, 1))
  value("2024-02-29+1 day", Date.UTC(2024, 2, 1))
  value("2026-01-31+1 month", Date.UTC(2026, 2, 3))
  value("2024-02-29+1 year", Date.UTC(2025, 2, 1))
  value("unix 1700000000", 1700000000000)
  value("1700000000000 to date", 1700000000000)
  value("unix -1", -1000)
  value("-1700000000000 to date", -1700000000000)
  value("unix time", 0, { ...env, nowMs: 0 })
  reject(["2027-02-29+1 day", "2026-13-01+1 day", "2026-04-31+1 day", "unix 1.5", "unix 1e20"])
  const r = C.evaluate("23:00 utc to tokyo", env)
  assert.equal(r.result, "08:00 (+1 day)")
  assert.equal(r.copy, "08:00")
  assert.match(r.resultCaption, /Saturday, 31 October/)
  assert.equal(C.evaluate("23:00 utc to tokyo", { ...env, hour12: true }).result, "8:00 AM (+1 day)")
  assert.equal(C.evaluate("time in tokyo", { ...env, zones: {} }), null)
})

test("calendar days and elapsed hours differ at both DST transitions", () => {
  process.env.TZ = "America/New_York"
  try {
    for (const [nowMs, day, hours] of [
      [Date.UTC(2026, 2, 7, 17), Date.UTC(2026, 2, 8, 16), 23],
      [Date.UTC(2026, 9, 31, 16), Date.UTC(2026, 10, 1, 17), 25]
    ]) {
      value("1 day from now", day, { ...env, nowMs })
      value("24 hours from now", nowMs + 864e5, { ...env, nowMs })
      assert.equal((day - nowMs) / 36e5, hours)
    }
  } finally { process.env.TZ = "UTC" }
})

test("invalid and search input never throws or acquires calculator rows", () => {
  reject(["", "firefox", "42", "5 kg", "unknown(2)", "constructor(2)", "toString(2)",
    "sqrt(", "((2+3)", "2+3)", "2+", "2+2 trailing", "2//3", "2..3+1", "1/0", "0/0",
    "1+" + "1".repeat(199)])
  assert.ok(C.evaluate("1+" + "1".repeat(198), env), "200 characters are permitted")
})

test("conversions round trip and equivalent units agree before display rounding", () => {
  for (const [from, to, n] of [["ft", "cm", 5], ["GiB", "MB", 1], ["°F", "°C", 32],
    ["m/s", "m/min", 10], ["m²", "ft²", 3], ["hours", "min", 1.5]]) {
    const converted = C.evaluate(`${n} ${from} to ${to}`, env)
    assert.ok(converted)
    const roundTrip = C.evaluate(`${converted.value} ${to} to ${from}`, env)
    assert.ok(roundTrip)
    assert.ok(Math.abs(roundTrip.value - n) < 1e-10, from)
  }
  value("1 m/100 cm", 1)
  value("1 h/60 min", 1)
  value("1 kg/m^3*1000000 cm3", 1)
})

test("display rounding, captions and copied text are separate contracts", () => {
  const decimal = C.evaluate("0.1+0.2", env)
  assert.equal(decimal.result, "0.3")
  assert.equal(decimal.copy, "0.3")
  assert.equal(decimal.value, 0.1 + 0.2)
  const large = C.evaluate("1.23456789012e300 m+0 m", env)
  assert.equal(large.result, "1.23456789012e300 m")
  assert.equal(large.copy, "1.23456789012e300 m")
  const measured = C.evaluate("1 GiB to MB", env)
  assert.equal(measured.result, "1,073.7418 MB")
  assert.equal(measured.copy, "1073.7418 MB")
  assert.equal(measured.inputCaption, "Gibibytes")
  assert.equal(measured.resultCaption, "Megabytes")
  assert.equal(C.evaluate("round(1.234 m,2)", env).copy, "1.23 m")
  assert.equal(C.evaluate("1000+234", env).copy, "1234")
})
