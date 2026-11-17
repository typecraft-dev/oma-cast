// The root-search calculator (SPEC §8 Calculator, ref 02 §3.3): the inline
// "Calculator" section. Raycast's engines (SoulverCore, calculator-rs) are
// closed, so this is our own Soulver-flavoured evaluator [D]:
//
//   arithmetic      2+2, 3(4+5), 2^10, 5!, 10 mod 3, sqrt 16, sin(30°), 2pi
//   percentages     20% of 50, 20% off 50, 20% on 50, $30 + 20%, 50 as a % of 200
//   units           5 ft to cm, 60 mph in km/h, 1 GiB to MB, 100 °F to °C, 16px to rem
//   currencies      10 usd to eur, €30 in £, $5k + 10%   (env.rates, ECB via frankfurter)
//   dates           3 days from now, christmas - today, days until dec 25, 2 weeks ago
//   time zones      time in tokyo, tokyo time, 3pm london to new york   (env.zones)
//   bases           255 to hex, 0xff + 1, 10 in binary
//   mixed units     5 ft 3 in to cm, 1 h 30 min + 45 min
//   work time       40 hours in work days, 2 work weeks to hours   (env.workHoursPerDay)
//   unix time       unix 1700000000, 1700000000 to date, now to unix, unix time
//
// evaluate(query, env) returns null unless the query clearly is a
// calculation: the Calculator section sits above Results and takes ↵, so a
// bare number, a word or "5 kg" must never produce a row.
//
// env: { nowMs, localOffset (minutes east of UTC), hour12,
//        rates: {base, date, rates: {CODE: perBase}}, zones: {IANA: minutes east},
//        remToPxRate, workHoursPerDay }

// ------------------------------------------------------------------ units

// Dimension vector keys: length, mass, time, temperature, current, data
// (bits), angle, money, CSS pixels.
var DIM_KEYS = ["L", "M", "T", "K", "I", "D", "A", "C", "P"]

var UNITS = {}        // exact symbol -> unit (case-sensitive)
var UNIT_NAMES = {}   // lowercased long name or plural -> unit

function dims(spec) {
  var out = {}
  for (var k in spec) if (spec[k]) out[k] = spec[k]
  return out
}

function dimsKey(d) {
  var parts = []
  for (var i = 0; i < DIM_KEYS.length; i++) if (d[DIM_KEYS[i]]) parts.push(DIM_KEYS[i] + d[DIM_KEYS[i]])
  return parts.join(" ")
}

function dimsCombine(a, b, sign) {
  var out = {}
  for (var i = 0; i < DIM_KEYS.length; i++) {
    var k = DIM_KEYS[i]
    var v = (a[k] || 0) + sign * (b[k] || 0)
    if (v) out[k] = v
  }
  return out
}

function dimsScale(a, n) {
  var out = {}
  for (var k in a) if (a[k] * n) out[k] = a[k] * n
  return out
}

function sameDims(a, b) { return dimsKey(a) === dimsKey(b) }
function isEmptyDims(d) { return dimsKey(d) === "" }

// def(symbols, names, dims, factor, opts): symbols match case-sensitively,
// names (singular, plural) case-insensitively. factor converts to SI base.
function def(symbols, names, d, factor, opts) {
  opts = opts || {}
  var unit = {
    sym: opts.display || symbols[0] || names[0],
    name: names[0] || symbols[0],
    plural: names[1] || (names[0] ? names[0] + "s" : symbols[0]),
    dims: dims(d),
    factor: factor,
    offset: opts.offset || 0,
    long: !!opts.long,          // display "1.5 hours", not "1.5 h"
    currency: opts.currency || "",
    hint: opts.hint || "",      // preferred family when a product simplifies
    atoms: null                 // the named units a compound is made of
  }
  unit.atoms = [unit]
  for (var i = 0; i < symbols.length; i++) if (!UNITS[symbols[i]]) UNITS[symbols[i]] = unit
  for (var j = 0; j < names.length; j++) {
    var key = names[j].toLowerCase()
    if (!UNIT_NAMES[key]) UNIT_NAMES[key] = unit
  }
  for (var a = 0; opts.aliases && a < opts.aliases.length; a++) {
    var alias = opts.aliases[a].toLowerCase()
    if (!UNIT_NAMES[alias]) UNIT_NAMES[alias] = unit
  }
  return unit
}

// SI prefixes for a base unit: def("m", ...) plus km, cm, mm, ….
var PREFIXES = [
  ["P", "peta", 1e15], ["T", "tera", 1e12], ["G", "giga", 1e9], ["M", "mega", 1e6], ["k", "kilo", 1e3],
  ["h", "hecto", 1e2], ["d", "deci", 1e-1], ["c", "centi", 1e-2], ["m", "milli", 1e-3],
  ["µ", "micro", 1e-6], ["n", "nano", 1e-9]
]

function defPrefixed(sym, name, d, factor, which, opts) {
  def([sym], [name, name + "s"], d, factor, opts)
  for (var i = 0; i < PREFIXES.length; i++) {
    var p = PREFIXES[i]
    if (which.indexOf(p[0]) < 0) continue
    var syms = [p[0] + sym]
    if (p[0] === "µ") syms.push("u" + sym, "μ" + sym)
    def(syms, [p[1] + name, p[1] + name + "s"], d, factor * p[2], opts)
  }
}

var L = { L: 1 }, M = { M: 1 }, T = { T: 1 }
var L2 = { L: 2 }, L3 = { L: 3 }

// Length
defPrefixed("m", "meter", L, 1, ["k", "c", "m", "µ", "n", "d"])
for (var _i = 0; _i < PREFIXES.length; _i++) {
  var _p = PREFIXES[_i]
  if ("kcmµnd".indexOf(_p[0]) >= 0) UNIT_NAMES[_p[1] + "metre"] = UNIT_NAMES[_p[1] + "metres"] = UNITS[_p[0] + "m"]
}
UNIT_NAMES.metre = UNIT_NAMES.metres = UNITS.m
def(["in", "\""], ["inch", "inches"], L, 0.0254)
def(["ft", "'"], ["foot", "feet"], L, 0.3048)
def(["yd"], ["yard", "yards"], L, 0.9144)
def(["mi"], ["mile", "miles"], L, 1609.344)
def(["nmi"], ["nautical mile", "nautical miles"], L, 1852)
def(["ly"], ["light year", "light years"], L, 9.4607304725808e15, { aliases: ["lightyear", "lightyears"] })
def(["au", "AU"], ["astronomical unit", "astronomical units"], L, 1.495978707e11)

// Mass
def(["g"], ["gram", "grams"], M, 1e-3, { aliases: ["gramme", "grammes"] })
def(["kg"], ["kilogram", "kilograms"], M, 1, { aliases: ["kilo", "kilos"] })
def(["mg"], ["milligram", "milligrams"], M, 1e-6)
def(["µg", "ug", "μg", "mcg"], ["microgram", "micrograms"], M, 1e-9)
def(["t"], ["tonne", "tonnes"], M, 1000, { aliases: ["metric ton", "metric tons"] })
def(["lb", "lbs"], ["pound", "pounds"], M, 0.45359237)
def(["oz"], ["ounce", "ounces"], M, 0.028349523125)
def(["st"], ["stone", "stones"], M, 6.35029318)
def([], ["ton", "tons"], M, 907.18474, { display: "tons", long: true, aliases: ["short ton", "short tons"] })
def(["ct"], ["carat", "carats"], M, 0.0002)

// Time
def(["s", "sec", "secs"], ["second", "seconds"], T, 1, { long: true })
def(["ms"], ["millisecond", "milliseconds"], T, 1e-3)
def(["µs", "us", "μs"], ["microsecond", "microseconds"], T, 1e-6)
def(["ns"], ["nanosecond", "nanoseconds"], T, 1e-9)
def(["min", "mins"], ["minute", "minutes"], T, 60, { long: true })
def(["h", "hr", "hrs"], ["hour", "hours"], T, 3600, { long: true })
def(["d"], ["day", "days"], T, 86400, { long: true })
def(["wk", "wks"], ["week", "weeks"], T, 604800, { long: true })
def(["mo"], ["month", "months"], T, 2629746, { long: true })
def(["yr", "yrs", "y"], ["year", "years"], T, 31556952, { long: true })
def([], ["decade", "decades"], T, 315569520, { long: true })
def([], ["century", "centuries"], T, 3155695200, { long: true })
// Work time uses Raycast's workHoursPerDay (default 8) [O pref]; a work
// week is five work days [I].
var WORKDAY = def([], ["work day", "work days"], T, 8 * 3600, { long: true, aliases: ["workday", "workdays"] })
var WORKWEEK = def([], ["work week", "work weeks"], T, 40 * 3600, { long: true, aliases: ["workweek", "workweeks"] })

// Temperature (affine: kelvin = (x + offset) * factor)
def(["K"], ["kelvin", "kelvins"], { K: 1 }, 1)
def(["°C", "C", "degC"], ["celsius", "celsius"], { K: 1 }, 1, { offset: 273.15, aliases: ["degrees celsius", "centigrade"] })
def(["°F", "F", "degF"], ["fahrenheit", "fahrenheit"], { K: 1 }, 5 / 9, { offset: 459.67, aliases: ["degrees fahrenheit"] })

// Area
def(["m²", "m2", "sqm"], ["square meter", "square meters"], L2, 1, { aliases: ["square metre", "square metres", "sq m"] })
def(["km²", "km2"], ["square kilometer", "square kilometers"], L2, 1e6, { aliases: ["square kilometre", "square kilometres", "sq km"] })
def(["cm²", "cm2"], ["square centimeter", "square centimeters"], L2, 1e-4, { aliases: ["sq cm"] })
def(["mm²", "mm2"], ["square millimeter", "square millimeters"], L2, 1e-6, { aliases: ["sq mm"] })
def(["ft²", "ft2", "sqft"], ["square foot", "square feet"], L2, 0.09290304, { aliases: ["sq ft"] })
def(["in²", "in2"], ["square inch", "square inches"], L2, 0.00064516, { aliases: ["sq in"] })
def(["yd²", "yd2"], ["square yard", "square yards"], L2, 0.83612736, { aliases: ["sq yd"] })
def(["mi²", "mi2"], ["square mile", "square miles"], L2, 2589988.110336, { aliases: ["sq mi"] })
def(["ha"], ["hectare", "hectares"], L2, 1e4)
def(["ac"], ["acre", "acres"], L2, 4046.8564224)

// Volume
defPrefixed("L", "liter", L3, 1e-3, ["m", "c", "d"])
UNITS.l = UNITS.L; UNITS.ml = UNITS.mL; UNITS.cl = UNITS.cL; UNITS.dl = UNITS.dL
UNIT_NAMES.litre = UNIT_NAMES.litres = UNITS.L
UNIT_NAMES.millilitre = UNIT_NAMES.millilitres = UNITS.mL
def(["m³", "m3"], ["cubic meter", "cubic meters"], L3, 1, { aliases: ["cubic metre", "cubic metres"] })
def(["cm³", "cm3", "cc"], ["cubic centimeter", "cubic centimeters"], L3, 1e-6)
def(["ft³", "ft3"], ["cubic foot", "cubic feet"], L3, 0.028316846592)
def(["in³", "in3"], ["cubic inch", "cubic inches"], L3, 1.6387064e-5)
def(["gal"], ["gallon", "gallons"], L3, 3.785411784e-3, { aliases: ["us gallon", "us gallons"] })
def([], ["imperial gallon", "imperial gallons"], L3, 4.54609e-3, { display: "imp gal" })
def(["qt"], ["quart", "quarts"], L3, 9.46352946e-4)
def([], ["pint", "pints"], L3, 4.73176473e-4, { display: "pints", long: true })
def(["cup"], ["cup", "cups"], L3, 2.365882365e-4, { long: true })
def(["floz", "fl oz"], ["fluid ounce", "fluid ounces"], L3, 2.95735295625e-5, { display: "fl oz" })
def(["tbsp"], ["tablespoon", "tablespoons"], L3, 1.478676478125e-5)
def(["tsp"], ["teaspoon", "teaspoons"], L3, 4.92892159375e-6)

// Speed
def(["km/h", "kph", "kmh"], ["kilometer per hour", "kilometers per hour"], { L: 1, T: -1 }, 1000 / 3600, { aliases: ["kilometres per hour"], hint: "km" })
def(["m/s"], ["meter per second", "meters per second"], { L: 1, T: -1 }, 1, { aliases: ["metres per second"], hint: "m" })
def(["mph"], ["mile per hour", "miles per hour"], { L: 1, T: -1 }, 0.44704, { hint: "mi" })
def(["kn", "kt"], ["knot", "knots"], { L: 1, T: -1 }, 1852 / 3600, { hint: "nmi" })
def(["ft/s", "fps"], ["foot per second", "feet per second"], { L: 1, T: -1 }, 0.3048, { hint: "ft" })

// Data (bits)
var D = { D: 1 }
def(["b", "bit"], ["bit", "bits"], D, 1)
def(["B"], ["byte", "bytes"], D, 8)
// [SI prefix, decimal name, binary symbol, binary name, power]
var DATA = [["k", "kilo", "Ki", "kibi", 1], ["M", "mega", "Mi", "mebi", 2], ["G", "giga", "Gi", "gibi", 3],
  ["T", "tera", "Ti", "tebi", 4], ["P", "peta", "Pi", "pebi", 5]]
for (var _d = 0; _d < DATA.length; _d++) {
  var _x = DATA[_d], _dec = Math.pow(1000, _x[4]), _bin = Math.pow(1024, _x[4])
  var _k = _x[0] === "k" ? ["K"] : []
  def([_x[0] + "B"].concat(_k.map(function(k) { return k + "B" })), [_x[1] + "byte", _x[1] + "bytes"], D, 8 * _dec)
  def([_x[2] + "B"], [_x[3] + "byte", _x[3] + "bytes"], D, 8 * _bin)
  def([_x[0] + "b", _x[0] + "bit"].concat(_k.map(function(k) { return k + "b" })), [_x[1] + "bit", _x[1] + "bits"], D, _dec)
  def([_x[0] + "bps"].concat(_k.map(function(k) { return k + "bps" })), [_x[1] + "bit per second", _x[1] + "bits per second"], { D: 1, T: -1 }, _dec)
}

// Angles
var A = { A: 1 }
def(["rad"], ["radian", "radians"], A, 1)
def(["°", "deg"], ["degree", "degrees"], A, Math.PI / 180)
def(["grad"], ["gradian", "gradians"], A, Math.PI / 200)
def(["arcmin"], ["arcminute", "arcminutes"], A, Math.PI / 10800)
def(["arcsec"], ["arcsecond", "arcseconds"], A, Math.PI / 648000)
def(["rev"], ["turn", "turns"], A, 2 * Math.PI, { aliases: ["revolution", "revolutions"] })

// Energy, power, pressure, force, frequency, electricity
var ENERGY = { M: 1, L: 2, T: -2 }, POWER = { M: 1, L: 2, T: -3 }, PRESSURE = { M: 1, L: -1, T: -2 }
defPrefixed("J", "joule", ENERGY, 1, ["k", "M"])
def(["cal"], ["calorie", "calories"], ENERGY, 4.184)
def(["kcal", "Cal"], ["kilocalorie", "kilocalories"], ENERGY, 4184)
defPrefixed("Wh", "watt hour", ENERGY, 3600, ["k", "M", "G"])
def(["eV"], ["electronvolt", "electronvolts"], ENERGY, 1.602176634e-19)
def(["BTU", "btu"], ["british thermal unit", "british thermal units"], ENERGY, 1055.05585262)
defPrefixed("W", "watt", POWER, 1, ["m", "k", "M", "G"])
def(["hp"], ["horsepower", "horsepower"], POWER, 745.69987158227022)
defPrefixed("Pa", "pascal", PRESSURE, 1, ["h", "k", "M"])
def(["bar"], ["bar", "bars"], PRESSURE, 1e5)
def(["mbar"], ["millibar", "millibars"], PRESSURE, 100)
def(["atm"], ["atmosphere", "atmospheres"], PRESSURE, 101325)
def(["psi"], ["psi", "psi"], PRESSURE, 6894.757293168)
def(["mmHg"], ["millimeter of mercury"], PRESSURE, 133.322387415)
def(["torr", "Torr"], ["torr", "torr"], PRESSURE, 133.322368)
defPrefixed("N", "newton", { M: 1, L: 1, T: -2 }, 1, ["k"])
def(["lbf"], ["pound force", "pounds force"], { M: 1, L: 1, T: -2 }, 4.4482216152605)
defPrefixed("Hz", "hertz", { T: -1 }, 1, ["k", "M", "G"])
UNIT_NAMES.hertz = UNITS.Hz
defPrefixed("V", "volt", { M: 1, L: 2, T: -3, I: -1 }, 1, ["m", "k"])
defPrefixed("A", "ampere", { I: 1 }, 1, ["m"])
UNIT_NAMES.amp = UNIT_NAMES.amps = UNITS.A

// CSS lengths; rem/em use Raycast's remToPxRate (default 16) [O pref].
def(["px"], ["pixel", "pixels"], { P: 1 }, 1)
def(["pt"], ["point", "points"], { P: 1 }, 4 / 3)
var REM = def(["rem"], ["rem", "rems"], { P: 1 }, 16)
var EM = def(["em"], ["em", "ems"], { P: 1 }, 16)

// Currencies: ECB reference rates (frankfurter.app). factor is resolved per
// call from env.rates, so it is 0 here.
var CURRENCIES = {
  USD: { symbol: "$", names: ["dollar", "dollars", "us dollar", "us dollars", "buck", "bucks", "usd"] },
  EUR: { symbol: "€", names: ["euro", "euros", "eur"] },
  GBP: { symbol: "£", names: ["british pound", "british pounds", "pound sterling", "pounds sterling", "quid", "gbp"] },
  JPY: { symbol: "¥", names: ["yen", "japanese yen", "jpy"], decimals: 0 },
  CNY: { symbol: "", names: ["yuan", "renminbi", "rmb", "cny"] },
  INR: { symbol: "₹", names: ["rupee", "rupees", "indian rupee", "indian rupees", "inr"] },
  KRW: { symbol: "₩", names: ["won", "korean won", "krw"], decimals: 0 },
  TRY: { symbol: "₺", names: ["lira", "turkish lira", "try"] },
  CHF: { symbol: "", names: ["franc", "francs", "swiss franc", "swiss francs", "chf"] },
  CAD: { symbol: "", names: ["canadian dollar", "canadian dollars", "cad"] },
  AUD: { symbol: "", names: ["australian dollar", "australian dollars", "aud"] },
  NZD: { symbol: "", names: ["new zealand dollar", "new zealand dollars", "nzd"] },
  HKD: { symbol: "", names: ["hong kong dollar", "hong kong dollars", "hkd"] },
  SGD: { symbol: "", names: ["singapore dollar", "singapore dollars", "sgd"] },
  MXN: { symbol: "", names: ["mexican peso", "mexican pesos", "mxn"] },
  BRL: { symbol: "", names: ["real", "reais", "brazilian real", "brl"] },
  SEK: { symbol: "", names: ["swedish krona", "swedish kronor", "sek"] },
  NOK: { symbol: "", names: ["norwegian krone", "norwegian kroner", "nok"] },
  DKK: { symbol: "", names: ["danish krone", "danish kroner", "dkk"] },
  PLN: { symbol: "", names: ["zloty", "zlotys", "polish zloty", "pln"] },
  CZK: { symbol: "", names: ["koruna", "czech koruna", "czk"] },
  HUF: { symbol: "", names: ["forint", "forints", "huf"], decimals: 0 },
  RON: { symbol: "", names: ["leu", "lei", "romanian leu", "ron"] },
  ISK: { symbol: "", names: ["icelandic krona", "isk"], decimals: 0 },
  ILS: { symbol: "₪", names: ["shekel", "shekels", "ils"] },
  ZAR: { symbol: "", names: ["rand", "south african rand", "zar"] },
  THB: { symbol: "", names: ["baht", "thai baht", "thb"] },
  MYR: { symbol: "", names: ["ringgit", "myr"] },
  PHP: { symbol: "", names: ["philippine peso", "philippine pesos", "php"] },
  IDR: { symbol: "", names: ["rupiah", "indonesian rupiah", "idr"], decimals: 0 }
}
var CURRENCY_SYMBOLS = { "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR", "₩": "KRW", "₺": "TRY", "₪": "ILS" }
for (var _code in CURRENCIES) {
  var _c = CURRENCIES[_code]
  var _cu = def([_code], [], { C: 1 }, 0, { currency: _code })
  _cu.name = _code; _cu.plural = _code
  for (var _n = 0; _n < _c.names.length; _n++) UNIT_NAMES[_c.names[_n]] = _cu
}

// Words that read as units only right after a number ("5 in", "3 d").
var NUMBER_ONLY_UNITS = { "in": true, "d": true, "t": true, "y": true, "s": true, "h": true, "m": true, "g": true, "b": true, "B": true, "C": true, "F": true, "K": true, "A": true, "V": true, "N": true, "J": true, "W": true, "L": true, "l": true, "cup": true, "st": true, "ct": true, "pt": true, "em": true, "mo": true, "kn": true, "kt": true, "ac": true, "ha": true, "bar": true }

// ------------------------------------------------------------- vocabulary

var CONSTANTS = { pi: Math.PI, "π": Math.PI, tau: 2 * Math.PI, "τ": 2 * Math.PI, e: Math.E, phi: (1 + Math.sqrt(5)) / 2, "φ": (1 + Math.sqrt(5)) / 2 }

var FUNCTIONS = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp, ln: Math.log,
  log: function(x, b) { return b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b) },
  log10: Math.log10, log2: Math.log2,
  floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc, sign: Math.sign,
  round: function(x, places) { var f = Math.pow(10, places || 0); return Math.round(x * f) / f },
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  min: Math.min, max: Math.max, pow: Math.pow,
  hypot: Math.hypot
}
var TRIG = { sin: true, cos: true, tan: true }
var INVERSE_TRIG = { asin: true, acos: true, atan: true }
var UNIT_PRESERVING = { abs: true, floor: true, ceil: true, round: true, trunc: true, min: true, max: true }
FUNCTIONS.arcsin = FUNCTIONS.asin; FUNCTIONS.arccos = FUNCTIONS.acos; FUNCTIONS.arctan = FUNCTIONS.atan
INVERSE_TRIG.arcsin = INVERSE_TRIG.arccos = INVERSE_TRIG.arctan = true

var CONVERT_WORDS = { to: true, "in": true, as: true, into: true }
var BASES = {
  hex: 16, hexadecimal: 16, bin: 2, binary: 2, oct: 8, octal: 8, dec: 10, decimal: 10,
  sci: "sci", scientific: "sci"
}

var MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
var MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
var WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
var WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

function monthIndex(word) {
  var w = word.toLowerCase()
  if (w === "sept") return 8
  for (var i = 0; i < 12; i++) if (w === MONTHS[i] || w === MONTH_NAMES[i].toLowerCase()) return i
  return -1
}

function weekdayIndex(word) {
  var w = word.toLowerCase()
  for (var i = 0; i < 7; i++) if (w === WEEKDAYS[i] || w === WEEKDAY_NAMES[i].toLowerCase()) return i
  return -1
}

// Fixed-date holidays, as the next occurrence. [D]
var HOLIDAYS = {
  "christmas": [11, 25], "xmas": [11, 25], "christmas eve": [11, 24], "christmas day": [11, 25],
  "new year": [0, 1], "new years": [0, 1], "new year's": [0, 1], "new years day": [0, 1], "new year's day": [0, 1],
  "new years eve": [11, 31], "new year's eve": [11, 31],
  "halloween": [9, 31], "valentines": [1, 14], "valentine's": [1, 14], "valentines day": [1, 14], "valentine's day": [1, 14]
}

// Places for time zones: lowercased name -> [IANA zone, label]. [D]
var PLACES = {
  "utc": ["UTC", "UTC"], "gmt": ["UTC", "GMT"], "z": ["UTC", "UTC"],
  "est": ["America/New_York", "Eastern Time"], "edt": ["America/New_York", "Eastern Time"], "et": ["America/New_York", "Eastern Time"], "eastern": ["America/New_York", "Eastern Time"],
  "cst": ["America/Chicago", "Central Time"], "cdt": ["America/Chicago", "Central Time"], "central": ["America/Chicago", "Central Time"],
  "mst": ["America/Denver", "Mountain Time"], "mdt": ["America/Denver", "Mountain Time"], "mountain": ["America/Denver", "Mountain Time"],
  "pst": ["America/Los_Angeles", "Pacific Time"], "pdt": ["America/Los_Angeles", "Pacific Time"], "pt": ["America/Los_Angeles", "Pacific Time"], "pacific": ["America/Los_Angeles", "Pacific Time"],
  "cet": ["Europe/Berlin", "Central European Time"], "cest": ["Europe/Berlin", "Central European Time"],
  "bst": ["Europe/London", "British Time"], "ist": ["Asia/Kolkata", "India"], "jst": ["Asia/Tokyo", "Japan"],
  "aest": ["Australia/Sydney", "Sydney"], "hst": ["Pacific/Honolulu", "Hawaii"], "akst": ["America/Anchorage", "Alaska"],
  "new york": ["America/New_York", "New York"], "nyc": ["America/New_York", "New York"], "ny": ["America/New_York", "New York"],
  "boston": ["America/New_York", "Boston"], "washington": ["America/New_York", "Washington"], "miami": ["America/New_York", "Miami"],
  "atlanta": ["America/New_York", "Atlanta"], "toronto": ["America/Toronto", "Toronto"], "montreal": ["America/Toronto", "Montreal"],
  "chicago": ["America/Chicago", "Chicago"], "dallas": ["America/Chicago", "Dallas"], "houston": ["America/Chicago", "Houston"],
  "austin": ["America/Chicago", "Austin"], "mexico city": ["America/Mexico_City", "Mexico City"],
  "denver": ["America/Denver", "Denver"], "phoenix": ["America/Phoenix", "Phoenix"], "calgary": ["America/Edmonton", "Calgary"],
  "los angeles": ["America/Los_Angeles", "Los Angeles"], "la": ["America/Los_Angeles", "Los Angeles"],
  "san francisco": ["America/Los_Angeles", "San Francisco"], "sf": ["America/Los_Angeles", "San Francisco"],
  "seattle": ["America/Los_Angeles", "Seattle"], "vancouver": ["America/Vancouver", "Vancouver"], "portland": ["America/Los_Angeles", "Portland"],
  "anchorage": ["America/Anchorage", "Anchorage"], "honolulu": ["Pacific/Honolulu", "Honolulu"], "hawaii": ["Pacific/Honolulu", "Hawaii"],
  "sao paulo": ["America/Sao_Paulo", "São Paulo"], "são paulo": ["America/Sao_Paulo", "São Paulo"], "rio": ["America/Sao_Paulo", "Rio de Janeiro"],
  "rio de janeiro": ["America/Sao_Paulo", "Rio de Janeiro"], "buenos aires": ["America/Argentina/Buenos_Aires", "Buenos Aires"],
  "santiago": ["America/Santiago", "Santiago"], "bogota": ["America/Bogota", "Bogotá"], "lima": ["America/Lima", "Lima"],
  "london": ["Europe/London", "London"], "uk": ["Europe/London", "United Kingdom"], "dublin": ["Europe/Dublin", "Dublin"],
  "lisbon": ["Europe/Lisbon", "Lisbon"], "paris": ["Europe/Paris", "Paris"], "berlin": ["Europe/Berlin", "Berlin"],
  "madrid": ["Europe/Madrid", "Madrid"], "barcelona": ["Europe/Madrid", "Barcelona"], "rome": ["Europe/Rome", "Rome"],
  "milan": ["Europe/Rome", "Milan"], "amsterdam": ["Europe/Amsterdam", "Amsterdam"], "brussels": ["Europe/Brussels", "Brussels"],
  "zurich": ["Europe/Zurich", "Zurich"], "vienna": ["Europe/Vienna", "Vienna"], "prague": ["Europe/Prague", "Prague"],
  "copenhagen": ["Europe/Copenhagen", "Copenhagen"], "stockholm": ["Europe/Stockholm", "Stockholm"], "oslo": ["Europe/Oslo", "Oslo"],
  "helsinki": ["Europe/Helsinki", "Helsinki"], "warsaw": ["Europe/Warsaw", "Warsaw"], "athens": ["Europe/Athens", "Athens"],
  "istanbul": ["Europe/Istanbul", "Istanbul"], "kyiv": ["Europe/Kyiv", "Kyiv"], "kiev": ["Europe/Kyiv", "Kyiv"],
  "moscow": ["Europe/Moscow", "Moscow"], "cairo": ["Africa/Cairo", "Cairo"], "lagos": ["Africa/Lagos", "Lagos"],
  "nairobi": ["Africa/Nairobi", "Nairobi"], "johannesburg": ["Africa/Johannesburg", "Johannesburg"], "cape town": ["Africa/Johannesburg", "Cape Town"],
  "dubai": ["Asia/Dubai", "Dubai"], "tel aviv": ["Asia/Jerusalem", "Tel Aviv"], "jerusalem": ["Asia/Jerusalem", "Jerusalem"],
  "riyadh": ["Asia/Riyadh", "Riyadh"], "tehran": ["Asia/Tehran", "Tehran"], "karachi": ["Asia/Karachi", "Karachi"],
  "india": ["Asia/Kolkata", "India"], "mumbai": ["Asia/Kolkata", "Mumbai"], "delhi": ["Asia/Kolkata", "Delhi"], "new delhi": ["Asia/Kolkata", "New Delhi"],
  "bangalore": ["Asia/Kolkata", "Bangalore"], "bengaluru": ["Asia/Kolkata", "Bengaluru"], "kathmandu": ["Asia/Kathmandu", "Kathmandu"],
  "dhaka": ["Asia/Dhaka", "Dhaka"], "bangkok": ["Asia/Bangkok", "Bangkok"], "jakarta": ["Asia/Jakarta", "Jakarta"],
  "hanoi": ["Asia/Bangkok", "Hanoi"], "singapore": ["Asia/Singapore", "Singapore"], "kuala lumpur": ["Asia/Kuala_Lumpur", "Kuala Lumpur"],
  "manila": ["Asia/Manila", "Manila"], "hong kong": ["Asia/Hong_Kong", "Hong Kong"], "shanghai": ["Asia/Shanghai", "Shanghai"],
  "beijing": ["Asia/Shanghai", "Beijing"], "china": ["Asia/Shanghai", "China"], "taipei": ["Asia/Taipei", "Taipei"],
  "seoul": ["Asia/Seoul", "Seoul"], "tokyo": ["Asia/Tokyo", "Tokyo"], "japan": ["Asia/Tokyo", "Japan"], "osaka": ["Asia/Tokyo", "Osaka"],
  "perth": ["Australia/Perth", "Perth"], "adelaide": ["Australia/Adelaide", "Adelaide"], "brisbane": ["Australia/Brisbane", "Brisbane"],
  "sydney": ["Australia/Sydney", "Sydney"], "melbourne": ["Australia/Melbourne", "Melbourne"], "auckland": ["Pacific/Auckland", "Auckland"],
  "new zealand": ["Pacific/Auckland", "New Zealand"], "reykjavik": ["Atlantic/Reykjavik", "Reykjavík"]
}

// Every IANA zone above: the host resolves their current UTC offsets.
function zoneList() {
  var seen = {}, out = []
  for (var k in PLACES) if (!seen[PLACES[k][0]] && PLACES[k][0] !== "UTC") { seen[PLACES[k][0]] = true; out.push(PLACES[k][0]) }
  return out.sort()
}

// ------------------------------------------------------------------ lexer

function CalcError(message) { this.message = message }

function lex(input) {
  var s = input
  var tokens = []
  var i = 0
  var depth = 0
  var m
  while (i < s.length) {
    var rest = s.slice(i)
    var ch = s.charAt(i)
    if (/\s/.test(ch)) { i++; continue }

    if ((m = /^(\d{4})-(\d{2})-(\d{2})(?![\d])/.exec(rest))) {
      tokens.push({ t: "date", y: +m[1], mo: +m[2] - 1, d: +m[3] })
      i += m[0].length; continue
    }
    if ((m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])/i.exec(rest))) {
      var hr = +m[1], mn = m[2] ? +m[2] : 0, pm = m[3].charAt(0).toLowerCase() === "p"
      if (hr < 1 || hr > 12 || mn > 59) throw new CalcError("bad time")
      tokens.push({ t: "time", h: (hr % 12) + (pm ? 12 : 0), m: mn })
      i += m[0].length; continue
    }
    if ((m = /^(\d{1,2}):(\d{2})(?![\d:])/.exec(rest))) {
      if (+m[1] > 23 || +m[2] > 59) throw new CalcError("bad time")
      tokens.push({ t: "time", h: +m[1], m: +m[2] })
      i += m[0].length; continue
    }
    if ((m = /^0x([0-9a-f]+)(?![0-9a-z])/i.exec(rest))) { tokens.push({ t: "num", v: parseInt(m[1], 16), base: 16 }); i += m[0].length; continue }
    if ((m = /^0b([01]+)(?![0-9a-z])/i.exec(rest))) { tokens.push({ t: "num", v: parseInt(m[1], 2), base: 2 }); i += m[0].length; continue }
    if ((m = /^0o([0-7]+)(?![0-9a-z])/i.exec(rest))) { tokens.push({ t: "num", v: parseInt(m[1], 8), base: 8 }); i += m[0].length; continue }
    // 1,000,000 groups digits, except inside a call: max(100,200).
    if ((m = (depth > 0 ? /^\d+(?:\.\d+)?(?:e[+-]?\d+)?|^\.\d+(?:e[+-]?\d+)?/i : /^(?:\d{1,3}(?:,\d{3})+(?![\d])|\d+)(?:\.\d+)?(?:e[+-]?\d+)?|^\.\d+(?:e[+-]?\d+)?/i).exec(rest))) {
      var v = parseFloat(m[0].replace(/,/g, ""))
      var len = m[0].length
      // 5k = 5000 (Soulver). [I]
      if (/^k(?![a-zA-Z])/.test(s.slice(i + len))) { v *= 1000; len++ }
      tokens.push({ t: "num", v: v })
      i += len; continue
    }
    if (CURRENCY_SYMBOLS[ch]) { tokens.push({ t: "cur", v: CURRENCY_SYMBOLS[ch] }); i++; continue }
    if ((m = /^°\s*([CF])(?![a-zA-Z])/.exec(rest))) { tokens.push({ t: "id", v: "°" + m[1] }); i += m[0].length; continue }
    if (ch === "°") { tokens.push({ t: "id", v: "°" }); i++; continue }
    if (rest.indexOf("**") === 0) { tokens.push({ t: "op", v: "^" }); i += 2; continue }
    if (rest.indexOf("->") === 0 || ch === "→") { tokens.push({ t: "id", v: "to" }); i += ch === "→" ? 1 : 2; continue }
    if ("+-*/^%!(),".indexOf(ch) >= 0) {
      if (ch === "(") depth++
      if (ch === ")") depth--
      tokens.push({ t: "op", v: ch }); i++; continue
    }
    if (ch === "×" || ch === "·" || ch === "⋅") { tokens.push({ t: "op", v: "*" }); i++; continue }
    if (ch === "÷") { tokens.push({ t: "op", v: "/" }); i++; continue }
    if (ch === "−" || ch === "–") { tokens.push({ t: "op", v: "-" }); i++; continue }
    if (ch === "²" || ch === "³") { tokens.push({ t: "op", v: ch }); i++; continue }
    if (ch === "√") { tokens.push({ t: "id", v: "sqrt" }); i++; continue }
    if ((m = /^[A-Za-zµμπτφΩÀ-ÖØ-öø-ÿ_][A-Za-z0-9µμÀ-ÖØ-öø-ÿ_]*(?:'s)?/.exec(rest))) { tokens.push({ t: "id", v: m[0] }); i += m[0].length; continue }
    throw new CalcError("unexpected " + ch)
  }
  return tokens
}

// ------------------------------------------------------------------ values

var ENV = null

function num(n, unit) { return { type: "num", n: n, unit: unit || null, pct: false } }
function pct(fraction) { return { type: "num", n: fraction, unit: null, pct: true } }
function date(ms, hasTime) { return { type: "date", ms: ms, hasTime: !!hasTime } }

// Unix time: seconds, or milliseconds from 13 digits up. [D]
function fromUnix(n) {
  if (Math.floor(n) !== n) throw new CalcError("not a timestamp")
  return date(Math.abs(n) >= 1e11 ? n : n * 1000, true)
}
function unixValue(ms) { var v = num(Math.floor(ms / 1000)); v.unix = true; return v }

// Without rates a currency still works on its own ("$30 + 20%", "$30/h ×
// 8 h"): the factor cancels. Converting between two needs rates (convert()).
function currencyFactor(unit) {
  var rates = ENV && ENV.rates
  if (!rates || !rates.rates) return 1
  if (unit.currency === rates.base) return 1
  var r = rates.rates[unit.currency]
  if (!r) throw new CalcError("no rate for " + unit.currency)
  return 1 / r
}

function unitFactor(unit) {
  if (unit.currency) return currencyFactor(unit)
  if (unit === REM || unit === EM) return (ENV && ENV.remToPxRate) || 16
  if (unit === WORKDAY || unit === WORKWEEK) return ((ENV && ENV.workHoursPerDay) || 8) * 3600 * (unit === WORKWEEK ? 5 : 1)
  return unit.factor
}

function toBase(n, unit) { return (n + unit.offset) * unitFactor(unit) }
function fromBase(n, unit) { return n / unitFactor(unit) - unit.offset }

function convert(value, unit) {
  if (!value.unit) throw new CalcError("nothing to convert")
  if (value.unit === unit || (value.unit.currency && value.unit.currency === unit.currency)) return num(value.n, unit)
  if (!sameDims(value.unit.dims, unit.dims)) throw new CalcError("incompatible units")
  if (unit.dims.C && !(ENV && ENV.rates && ENV.rates.rates)) throw new CalcError("no exchange rates")
  return num(fromBase(toBase(value.n, value.unit), unit), unit)
}

// A product or quotient of units, simplified to a named unit when one fits.
function compound(a, b, sign) {
  var d = dimsCombine(a.dims, b.dims, sign)
  var factor = sign > 0 ? unitFactor(a) * unitFactor(b) : unitFactor(a) / unitFactor(b)
  if (isEmptyDims(d)) return { scalar: factor }
  var sym = a.sym + (sign > 0 ? "·" : "/") + b.sym
  var named = UNITS[sym] || UNITS[sym.replace("·", "")]
  if (named && sameDims(named.dims, d)) return { unit: named, scale: factor / unitFactor(named) }
  var atoms = (a.atoms || []).concat(b.atoms || [])
  var preferred = preferredUnit(d, atoms)
  if (preferred) return { unit: preferred, scale: factor / unitFactor(preferred) }
  return { unit: { sym: sym, name: sym, plural: sym, dims: d, factor: factor, offset: 0, long: false, currency: "", hint: "", atoms: atoms }, scale: 1 }
}

function unitPow(u, p) {
  var d = dimsScale(u.dims, p)
  var preferred = preferredUnit(d, u.atoms || [u])
  var factor = Math.pow(unitFactor(u), p)
  if (preferred) return { unit: preferred, scale: factor / unitFactor(preferred) }
  var sup = p === 2 ? "²" : (p === 3 ? "³" : "^" + p)
  return { unit: { sym: u.sym + sup, name: u.sym + sup, plural: u.sym + sup, dims: d, factor: factor, offset: 0, long: false, currency: "", hint: "", atoms: u.atoms }, scale: 1 }
}

// Pick a named unit for dims d, from the families of the operands: "60 mph
// × 2 h" is miles, "3 m × 4 m" is m². [D]
function preferredUnit(d, from) {
  var key = dimsKey(d)
  var families = []
  for (var i = 0; i < from.length; i++) {
    if (from[i].hint) families.push(from[i].hint)
    var base = from[i].sym.replace(/[²³23]$/, "")
    families.push(base)
  }
  for (var f = 0; f < families.length; f++) {
    var fam = families[f]
    var candidates = [fam, fam + "²", fam + "³"]
    for (var c = 0; c < candidates.length; c++) {
      var u = UNITS[candidates[c]]
      if (u && dimsKey(u.dims) === key) return u
    }
  }
  var SI = { "L1": "m", "M1": "kg", "T1": "s", "L2": "m²", "L3": "m³", "L1 T-1": "m/s", "D1": "B" }
  return SI[key] ? UNITS[SI[key]] : null
}

function isDuration(v) { return v.type === "num" && v.unit && dimsKey(v.unit.dims) === "T1" }

function addDuration(d, v, sign) {
  var unit = v.unit
  // "3 work days from now" would mean business days, which we don't model. [D]
  if (unit === WORKDAY || unit === WORKWEEK) throw new CalcError("work days are not calendar days")
  var n = v.n * sign
  var t = new Date(d.ms)
  // Calendar units move the calendar; the rest are exact seconds.
  if (unit === UNITS.d || unit === UNITS.wk || unit === UNITS.mo || unit === UNITS.yr) {
    if (Math.floor(n) === n) {
      if (unit === UNITS.d) t.setDate(t.getDate() + n)
      else if (unit === UNITS.wk) t.setDate(t.getDate() + 7 * n)
      else if (unit === UNITS.mo) t.setMonth(t.getMonth() + n)
      else t.setFullYear(t.getFullYear() + n)
      return date(t.getTime(), d.hasTime)
    }
  }
  var seconds = toBase(n, unit)
  return date(d.ms + seconds * 1000, d.hasTime || seconds % 86400 !== 0)
}

function add(a, b, sign, state) {
  state.ops++
  if (a.type === "date" && isDuration(b)) { state.kind = "date"; return addDuration(a, b, sign) }
  if (sign > 0 && isDuration(a) && b.type === "date") { state.kind = "date"; return addDuration(b, a, 1) }
  if (a.type === "date" && b.type === "date" && sign < 0) {
    state.kind = "date"
    var days = (startOfDay(a.ms) - startOfDay(b.ms)) / 864e5
    if (!a.hasTime && !b.hasTime) return num(Math.round(days), UNITS.d)
    return autoDuration((a.ms - b.ms) / 1000)
  }
  if (a.type !== "num" || b.type !== "num") throw new CalcError("cannot add")
  if (b.pct && !a.pct) { state.kind = "percentage"; return num(a.n * (1 + sign * b.n), a.unit) }
  if (a.pct && b.pct) return pct(a.n + sign * b.n)
  if (a.pct || b.pct) throw new CalcError("cannot add")
  if (a.unit && b.unit) {
    if (!sameDims(a.unit.dims, b.unit.dims)) throw new CalcError("incompatible units")
    var bn = convert(b, a.unit).n
    return num(a.n + sign * bn, a.unit)
  }
  return num(a.n + sign * b.n, a.unit || b.unit)
}

function multiply(a, b, divide, state) {
  state.ops++
  if (a.type !== "num" || b.type !== "num") throw new CalcError("cannot multiply dates")
  if (b.pct && !a.pct) { state.kind = "percentage"; return num(divide ? a.n / b.n : a.n * b.n, a.unit) }
  if (a.pct && !b.pct && !divide) { state.kind = "percentage"; return num(a.n * b.n, b.unit) }
  var n = divide ? a.n / b.n : a.n * b.n
  if (a.pct && b.pct) return pct(n)
  if (a.unit && b.unit) {
    if (a.unit.offset || b.unit.offset) throw new CalcError("affine unit")
    var c = compound(a.unit, b.unit, divide ? -1 : 1)
    if (c.scalar !== undefined) return num(n * c.scalar)
    return num(n * c.scale, c.unit)
  }
  if (b.unit && divide) {
    var inv = compound({ sym: "1", dims: {}, factor: 1, offset: 0, atoms: [] }, b.unit, -1)
    return num(n * inv.scale, inv.unit)
  }
  return num(n, a.unit || b.unit)
}

function power(a, b, state) {
  state.ops++
  if (a.type !== "num" || b.type !== "num" || b.unit || b.pct) throw new CalcError("bad power")
  if (a.unit) {
    if (Math.floor(b.n) !== b.n || a.unit.offset) throw new CalcError("bad unit power")
    var p = unitPow(a.unit, b.n)
    return num(Math.pow(a.n, b.n) * p.scale, p.unit)
  }
  return num(Math.pow(a.n, b.n))
}

function factorial(v, state) {
  state.ops++
  if (v.type !== "num" || v.unit || v.pct || v.n < 0 || Math.floor(v.n) !== v.n || v.n > 170) throw new CalcError("bad factorial")
  var r = 1
  for (var i = 2; i <= v.n; i++) r *= i
  return num(r)
}

function plainNumber(v) {
  if (v.type !== "num") throw new CalcError("expected a number")
  if (v.pct) return v.n
  return v.n
}

function callFunction(name, args, state) {
  state.ops++
  var fn = FUNCTIONS[name]
  if (TRIG[name]) {
    var a = args[0]
    var rad = a.unit ? (dimsKey(a.unit.dims) === "A1" ? toBase(a.n, a.unit) : NaN) : a.n
    return num(fn(rad))
  }
  if (INVERSE_TRIG[name]) return num(fn(plainNumber(args[0])), UNITS.rad)
  if (UNIT_PRESERVING[name] && args[0].unit) {
    var unit = args[0].unit
    var ns = args.map(function(x, i) { return i > 0 && name === "round" ? x.n : (x.unit ? convert(x, unit).n : x.n) })
    return num(fn.apply(null, ns), unit)
  }
  for (var i = 0; i < args.length; i++) if (args[i].type !== "num" || args[i].unit) throw new CalcError(name + " takes plain numbers")
  return num(fn.apply(null, args.map(plainNumber)))
}

// Seconds as the largest whole-ish unit: "3 days", "2.5 hours".
function autoDuration(seconds) {
  var units = [UNITS.yr, UNITS.wk, UNITS.d, UNITS.h, UNITS.min, UNITS.s]
  for (var i = 0; i < units.length; i++) {
    if (Math.abs(seconds) >= units[i].factor && units[i] !== UNITS.wk) return num(seconds / units[i].factor, units[i])
  }
  return num(seconds, UNITS.s)
}

// ----------------------------------------------------------------- dates

function nowMs() { return ENV && ENV.nowMs ? ENV.nowMs : Date.now() }
function startOfDay(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }
function today() { return startOfDay(nowMs()) }

function makeDate(y, mo, d) {
  var t = new Date(y, mo, d)
  if (t.getMonth() !== mo || t.getDate() !== d) throw new CalcError("no such date")
  return t.getTime()
}

function nextOccurrence(mo, d) {
  var y = new Date(today()).getFullYear()
  var t = makeDate(y, mo, d)
  return t < today() ? makeDate(y + 1, mo, d) : t
}

// ----------------------------------------------------------------- parser

function Parser(tokens) {
  this.tokens = tokens
  this.i = 0
  this.state = { ops: 0, kind: "math", fromUnit: null, toUnit: null, fromUnix: false }
}

Parser.prototype.peek = function(k) { return this.tokens[this.i + (k || 0)] || null }
Parser.prototype.next = function() { return this.tokens[this.i++] || null }
Parser.prototype.atEnd = function() { return this.i >= this.tokens.length }
Parser.prototype.isOp = function(v, k) { var t = this.peek(k); return !!t && t.t === "op" && t.v === v }
Parser.prototype.isWord = function(w, k) { var t = this.peek(k); return !!t && t.t === "id" && t.v.toLowerCase() === w }
Parser.prototype.expectOp = function(v) { if (!this.isOp(v)) throw new CalcError("expected " + v); this.i++ }

// "unix", "unix time", "unix timestamp", "timestamp", "epoch" at the cursor:
// how many tokens it spans, or 0.
Parser.prototype.unixWords = function() {
  if (this.isWord("unix")) return this.isWord("time", 1) || this.isWord("timestamp", 1) ? 2 : 1
  return this.isWord("timestamp") || this.isWord("epoch") ? 1 : 0
}

// Longest unit at the cursor: multiword names, "sq ft", "km/h", "m^2".
Parser.prototype.matchUnit = function(afterNumber) {
  var t = this.peek()
  if (!t) return null
  if (t.t === "cur") return { unit: UNITS[t.v], len: 1 }
  if (t.t !== "id") return null
  for (var n = 3; n >= 1; n--) {
    var words = []
    for (var k = 0; k < n; k++) {
      var w = this.peek(k)
      if (!w || w.t !== "id") break
      words.push(w.v)
    }
    if (words.length < n) continue
    var phrase = words.join(" ")
    var lower = phrase.toLowerCase()
    var unit = null
    if (n === 1) {
      unit = UNITS[phrase] || UNIT_NAMES[lower] || null
      // Lowercase c/f only read as temperatures right after a number.
      if (!unit && afterNumber && (phrase === "c" || phrase === "f")) unit = UNITS[phrase.toUpperCase()]
      if (!unit && /^[a-z]{3}$/.test(phrase) && UNITS[phrase.toUpperCase()] && UNITS[phrase.toUpperCase()].currency) unit = UNITS[phrase.toUpperCase()]
      if (unit && !afterNumber && NUMBER_ONLY_UNITS[phrase]) unit = null
    } else {
      unit = UNIT_NAMES[lower] || UNITS[phrase] || null
      var sq = /^(sq|square|cubic)\s+(.+)$/.exec(lower)
      if (!unit && sq) {
        var baseUnit = UNITS[words.slice(1).join(" ")] || UNIT_NAMES[sq[2]]
        if (baseUnit && dimsKey(baseUnit.dims) === "L1") unit = unitPow(baseUnit, sq[1] === "cubic" ? 3 : 2).unit
      }
    }
    if (unit) return { unit: unit, len: n }
  }
  return null
}

// A unit expression: atom ( / atom | per atom | ^int | ² )*
Parser.prototype.parseUnit = function(afterNumber) {
  var m = this.matchUnit(afterNumber)
  if (!m) return null
  this.i += m.len
  return this.continueUnit(m.unit, 1)
}

Parser.prototype.continueUnit = function(unit, scale) {
  for (;;) {
    if ((this.isOp("/") || this.isWord("per")) && this.peek(1) && this.peek(1).t === "id") {
      var save = this.i
      this.i++
      var den = this.matchUnit(true)
      if (!den) { this.i = save; break }
      this.i += den.len
      var c = compound(unit, den.unit, -1)
      if (c.scalar !== undefined) throw new CalcError("unit cancels")
      unit = c.unit; scale *= c.scale
    } else if (this.isOp("^") && this.peek(1) && this.peek(1).t === "num") {
      this.i++
      var p = unitPow(unit, this.next().v)
      unit = p.unit; scale *= p.scale
    } else if (this.isOp("²") || this.isOp("³")) {
      var q = unitPow(unit, this.next().v === "²" ? 2 : 3)
      unit = q.unit; scale *= q.scale
    } else break
  }
  return { unit: unit, scale: scale }
}

Parser.prototype.parseStatement = function() {
  var special = this.parseDurationBetween()
  if (special) return special
  var value = this.parseExpr()
  // "50 as a % of 200", "50 is what % of 200"
  if ((this.isWord("as") || this.isWord("is")) && value.type === "num") {
    var save = this.i
    this.i++
    if (this.isWord("a") || this.isWord("what")) this.i++
    if ((this.isOp("%") || this.isWord("percent")) && this.isWord("of", 1)) {
      this.i += 2
      var whole = this.parseExpr()
      if (whole.type !== "num" || whole.pct) throw new CalcError("bad percentage")
      var part = value.unit && whole.unit ? convert(value, whole.unit).n : value.n
      this.state.ops++
      this.state.kind = "percentage"
      value = pct(part / whole.n)
    } else this.i = save
  }
  if (!this.atEnd() && this.peek().t === "id" && CONVERT_WORDS[this.peek().v.toLowerCase()]) {
    this.i++
    value = this.parseTarget(value)
  }
  if (!this.atEnd()) throw new CalcError("trailing input")
  return value
}

// "days until christmas", "how many weeks since 2020-01-01"
Parser.prototype.parseDurationBetween = function() {
  var start = this.i
  if (this.isWord("how") && this.isWord("many", 1)) this.i += 2
  var m = this.matchUnit(false)
  if (!m || dimsKey(m.unit.dims) !== "T1") { this.i = start; return null }
  var dir = this.peek(m.len)
  var word = dir && dir.t === "id" ? dir.v.toLowerCase() : ""
  if (word !== "until" && word !== "till" && word !== "since" && word !== "to" && word !== "before" && word !== "from") { this.i = start; return null }
  if (word === "to" || word === "from") { this.i = start; return null }
  this.i += m.len + 1
  var target = this.parseExpr()
  if (target.type !== "date") throw new CalcError("expected a date")
  var unit = m.unit
  var calendar = !target.hasTime && unit.factor >= 86400
  var from = calendar ? today() : nowMs()
  var seconds = (word === "since" ? from - target.ms : target.ms - from) / 1000
  if (calendar) seconds = Math.round(seconds / 86400) * 86400     // DST days are 23 or 25 h
  this.state.ops++
  this.state.kind = "date"
  if (!this.atEnd()) throw new CalcError("trailing input")
  return num(seconds / unit.factor, unit)
}

Parser.prototype.parseTarget = function(value) {
  this.state.ops++
  var t = this.peek()
  if (!t) throw new CalcError("missing target")
  if (t.t === "id" && BASES[t.v.toLowerCase()] && this.tokens.length === this.i + 1) {
    this.i++
    if (value.type !== "num" || value.unit || value.pct) throw new CalcError("bases take plain numbers")
    value = num(value.n)
    value.base = BASES[t.v.toLowerCase()]
    this.state.kind = "base"
    return value
  }
  var unixLen = this.unixWords()
  if (unixLen && this.tokens.length === this.i + unixLen) {
    this.i += unixLen
    if (value.type !== "date") throw new CalcError("expected a date")
    this.state.kind = "unix"
    return unixValue(value.ms)
  }
  if (t.t === "id" && t.v.toLowerCase() === "date" && this.tokens.length === this.i + 1) {
    this.i++
    if (value.type !== "num" || value.unit || value.pct) throw new CalcError("expected a timestamp")
    this.state.fromUnix = true
    return fromUnix(value.n)
  }
  if ((t.t === "op" && t.v === "%") || (t.t === "id" && t.v.toLowerCase() === "percent")) {
    this.i++
    if (value.type !== "num" || value.unit) throw new CalcError("bad percent")
    this.state.kind = "percentage"
    return pct(value.n)
  }
  var u = this.parseUnit(true)
  if (!u) throw new CalcError("unknown target")
  if (value.type !== "num") throw new CalcError("cannot convert")
  this.state.kind = u.unit.currency ? "currency" : "conversion"
  this.state.fromUnit = value.unit
  this.state.toUnit = u.unit
  return convert(value, u.unit)
}

Parser.prototype.parseExpr = function() {
  var left = this.parseMul()
  for (;;) {
    if (this.isOp("+") || this.isOp("-")) {
      var sign = this.next().v === "+" ? 1 : -1
      left = add(left, this.parseMul(), sign, this.state)
    } else if (this.isWord("ago") && isDuration(left)) {
      this.i++
      this.state.kind = "date"
      left = addDuration(date(nowMs(), true), left, -1); this.state.ops++
    } else if (this.isWord("from") && this.isWord("now", 1) && isDuration(left)) {
      this.i += 2
      this.state.kind = "date"
      left = addDuration(date(nowMs(), true), left, 1); this.state.ops++
    } else if ((this.isWord("after") || this.isWord("before") || this.isWord("from")) && isDuration(left)) {
      var dir = this.next().v.toLowerCase() === "before" ? -1 : 1
      var base = this.parseMul()
      if (base.type !== "date") throw new CalcError("expected a date")
      this.state.kind = "date"
      left = addDuration(base, left, dir); this.state.ops++
    } else return left
  }
}

Parser.prototype.parseMul = function() {
  var left = this.parseUnary()
  for (;;) {
    var t = this.peek()
    if (!t) return left
    if (t.t === "op" && (t.v === "*" || t.v === "/")) {
      this.i++
      left = multiply(left, this.parseUnary(), t.v === "/", this.state)
    } else if ((t.t === "op" && t.v === "%") || (t.t === "id" && t.v.toLowerCase() === "mod")) {
      this.i++
      var r = this.parseUnary()
      if (left.type !== "num" || r.type !== "num") throw new CalcError("bad modulo")
      this.state.ops++
      var rn = left.unit && r.unit ? convert(r, left.unit).n : r.n
      left = num(((left.n % rn) + rn) % rn, left.unit)
    } else if (t.t === "id" && left.type === "num" && left.pct && /^(of|off|on)$/i.test(t.v)) {
      this.i++
      var whole = this.parseUnary()
      if (whole.type !== "num") throw new CalcError("bad percentage")
      var w = t.v.toLowerCase()
      this.state.ops++
      this.state.kind = "percentage"
      left = num(w === "of" ? whole.n * left.n : whole.n * (w === "off" ? 1 - left.n : 1 + left.n), whole.unit)
    } else if (left.type === "num" && !left.unit && !left.pct && (
      (t.t === "op" && t.v === "(") || (t.t === "id" && (CONSTANTS[t.v.toLowerCase()] !== undefined || FUNCTIONS[t.v.toLowerCase()])))) {
      left = multiply(left, this.parseUnary(), false, this.state)   // 2pi, 3(4+5), 2 sqrt 9
    } else return left
  }
}

Parser.prototype.parseUnary = function() {
  if (this.isOp("-")) { this.i++; var v = this.parseUnary(); if (v.type !== "num") throw new CalcError("cannot negate"); var out = num(-v.n, v.unit); out.pct = v.pct; return out }
  if (this.isOp("+")) { this.i++; return this.parseUnary() }
  return this.parsePower()
}

Parser.prototype.parsePower = function() {
  var base = this.parsePostfix()
  if (this.isOp("^")) {
    this.i++
    return power(base, this.parseUnary(), this.state)
  }
  return base
}

Parser.prototype.parsePostfix = function() {
  var v = this.parsePrimary()
  for (;;) {
    if (this.isOp("!")) { this.i++; v = factorial(v, this.state) }
    else if (this.isOp("²") || this.isOp("³")) { v = power(v, num(this.next().v === "²" ? 2 : 3), this.state) }
    else if (this.isOp("%") && !this.startsOperand(1)) {
      this.i++
      if (v.type !== "num" || v.unit || v.pct) throw new CalcError("bad percent")
      v = pct(v.n / 100)
    } else return v
  }
}

// Whether the token at offset k can start an operand ("10 % 3" is modulo).
Parser.prototype.startsOperand = function(k) {
  var t = this.peek(k)
  if (!t) return false
  if (t.t === "num" || t.t === "cur") return true
  if (t.t === "op") return t.v === "("
  var w = t.v.toLowerCase()
  return CONSTANTS[w] !== undefined || !!FUNCTIONS[w]
}

Parser.prototype.parsePrimary = function() {
  var t = this.next()
  if (!t) throw new CalcError("unexpected end")

  if (t.t === "num") {
    if (t.base && t.base !== 10) this.state.ops++     // 0xff reads as 255
    // "25 dec", "25 december 2026"
    var mi = this.peek() && this.peek().t === "id" ? monthIndex(this.peek().v) : -1
    if (mi >= 0 && Math.floor(t.v) === t.v && t.v >= 1 && t.v <= 31) {
      this.i++
      var y = this.peek() && this.peek().t === "num" && this.peek().v >= 1000 ? this.next().v : null
      return date(y === null ? makeDate(new Date(today()).getFullYear(), mi, t.v) : makeDate(y, mi, t.v), false)
    }
    // "in" after a number is inches unless a conversion target follows.
    if (this.isWord("in") && this.peek(1) && (this.peek(1).t === "id" || this.peek(1).t === "cur") && !this.isWord("in", 1) && !this.isWord("to", 1)) return num(t.v)
    var u = this.parseUnit(true)
    if (!u) return num(t.v)
    var quantity = num(t.v * u.scale, u.unit)
    // "5 ft 3 in", "1 h 30 min": adjacent quantities of one dimension add up. [D]
    while (this.peek() && this.peek().t === "num" && !this.peek().base && !quantity.unit.offset && !quantity.unit.currency) {
      var save = this.i
      var part = this.next()
      var pu = this.parseUnit(true)
      if (!pu || pu.unit.offset || pu.unit.currency || !sameDims(pu.unit.dims, quantity.unit.dims)) { this.i = save; break }
      quantity = add(quantity, num(part.v * pu.scale, pu.unit), 1, this.state)
    }
    return quantity
  }

  if (t.t === "cur") {
    var amount = this.parsePostfix()
    if (amount.type !== "num" || amount.unit || amount.pct) throw new CalcError("bad amount")
    var per = this.continueUnit(UNITS[t.v], 1)     // "$30/h"
    return num(amount.n * per.scale, per.unit)
  }

  if (t.t === "op" && t.v === "(") {
    var inner = this.parseExpr()
    this.expectOp(")")
    // "(2 + 3) kg"
    var pu = this.parseUnit(true)
    if (pu && inner.type === "num" && !inner.unit) return num(inner.n * pu.scale, pu.unit)
    if (pu) throw new CalcError("unit after unit")
    return inner
  }

  if (t.t === "date") return date(makeDate(t.y, t.mo, t.d), false)
  if (t.t === "time") { var d = new Date(today()); d.setHours(t.h, t.m, 0, 0); return date(d.getTime(), true) }

  if (t.t === "id") {
    var w = t.v.toLowerCase()
    if (FUNCTIONS[w]) {
      var args = []
      if (this.isOp("(")) {
        this.i++
        args.push(this.parseExpr())
        while (this.isOp(",")) { this.i++; args.push(this.parseExpr()) }
        this.expectOp(")")
      } else args.push(this.parsePower())
      return callFunction(w, args, this.state)
    }
    if (CONSTANTS[t.v] !== undefined || (CONSTANTS[w] !== undefined && w !== "e")) {
      if (w !== "e") this.state.ops++
      return num(CONSTANTS[t.v] !== undefined ? CONSTANTS[t.v] : CONSTANTS[w])
    }
    // "unix 1700000000", "timestamp 1700000000"; "unix time" / "unix now"
    // is the current one. A bare "unix" or "epoch" is a word, not a row.
    this.i--
    var unixLen = this.unixWords()
    this.i++
    if (unixLen) {
      this.i += unixLen - 1
      if (this.peek() && this.peek().t === "num" && !this.peek().base) {
        this.state.ops++
        this.state.fromUnix = true
        return fromUnix(this.next().v)
      }
      if (w === "unix" && (unixLen === 2 || this.isWord("now"))) {
        if (this.isWord("now")) this.i++
        this.state.ops++
        this.state.kind = "unix"
        return unixValue(nowMs())
      }
      this.i -= unixLen - 1
    }
    if (w === "now") return date(nowMs(), true)
    if (w === "today") return date(today(), false)
    if (w === "tomorrow") return date(addDuration(date(today()), num(1, UNITS.d), 1).ms, false)
    if (w === "yesterday") return date(addDuration(date(today()), num(1, UNITS.d), -1).ms, false)
    if (w === "noon" || w === "midnight") { var dd = new Date(today()); dd.setHours(w === "noon" ? 12 : 0); return date(dd.getTime(), true) }
    // Holidays, longest name first.
    for (var n = 3; n >= 1; n--) {
      var words = [t.v]
      for (var k = 0; k < n - 1; k++) { var x = this.peek(k); if (x && x.t === "id") words.push(x.v) }
      var hol = HOLIDAYS[words.join(" ").toLowerCase()]
      if (words.length === n && hol) { this.i += n - 1; return date(nextOccurrence(hol[0], hol[1]), false) }
    }
    // "dec 25", "december 25 2026", "dec 25, 2026"
    var month = monthIndex(t.v)
    if (month >= 0 && this.peek() && this.peek().t === "num") {
      var day = this.next().v
      if (this.isOp(",") && this.peek(1) && this.peek(1).t === "num") this.i++
      var year = this.peek() && this.peek().t === "num" && this.peek().v >= 1000 ? this.next().v : null
      return date(year === null ? makeDate(new Date(today()).getFullYear(), month, day) : makeDate(year, month, day), false)
    }
    // "friday", "next friday", "last friday"
    var rel = w === "next" || w === "last" || w === "this" ? w : ""
    var wd = weekdayIndex(rel ? (this.peek() && this.peek().t === "id" ? this.peek().v : "") : t.v)
    if (wd >= 0) {
      if (rel) this.i++
      var base = new Date(today())
      var delta = (wd - base.getDay() + 7) % 7
      if (rel === "next" && delta === 0) delta = 7
      if (rel === "last") delta = delta === 0 ? -7 : delta - 7
      base.setDate(base.getDate() + delta)
      return date(base.getTime(), false)
    }
    // A unit alone is one of it: "kg to lb", "mile in km". [D]
    this.i--
    var lone = this.parseUnit(false)
    if (lone) return num(lone.scale, lone.unit)
    this.i++
  }
  throw new CalcError("unexpected " + (t.v === undefined ? t.t : t.v))
}

// ----------------------------------------------------------- time zones

function placeAt(tokens, i) {
  for (var n = 3; n >= 1; n--) {
    if (i + n > tokens.length) continue
    var words = []
    for (var k = 0; k < n; k++) { if (tokens[i + k].t !== "id") break; words.push(tokens[i + k].v.toLowerCase()) }
    if (words.length < n) continue
    var p = PLACES[words.join(" ")]
    if (p) return { zone: p[0], label: p[1], len: n }
  }
  return null
}

function zoneOffset(zone) {
  if (zone === "UTC") return 0
  var zones = ENV && ENV.zones
  if (!zones || typeof zones[zone] !== "number") throw new CalcError("unknown offset for " + zone)
  return zones[zone]
}

function localOffset() {
  return ENV && typeof ENV.localOffset === "number" ? ENV.localOffset : -new Date(nowMs()).getTimezoneOffset()
}

// "time in tokyo", "tokyo time", "now in london", "3pm in tokyo",
// "3pm london", "3pm london to new york", "15:00 utc in nyc"
function parseTimeZone(tokens) {
  var i = 0
  var words = function(k) { return tokens[k] && tokens[k].t === "id" ? tokens[k].v.toLowerCase() : "" }
  var time = null
  var explicitNow = false
  if (words(0) === "what" && words(1) === "time" && words(2) === "is" && words(3) === "it") { i = 4; explicitNow = true }
  else if (words(0) === "current" && words(1) === "time") { i = 2; explicitNow = true }
  else if (words(0) === "time" || words(0) === "now") { i = 1; explicitNow = true }
  else if (tokens[0] && tokens[0].t === "time") { time = tokens[0]; i = 1 }
  else if (words(0) === "noon" || words(0) === "midnight") { time = { h: words(0) === "noon" ? 12 : 0, m: 0 }; i = 1 }

  var from = null, to = null
  if (time) {
    var src = placeAt(tokens, i)
    if (src) { from = src; i += src.len }
    if (CONVERT_WORDS[words(i)] || words(i) === "at") {
      i++
      to = placeAt(tokens, i)
      if (!to) return null
      i += to.len
    }
    if (!from && !to) return null
  } else {
    if (words(i) === "in" || words(i) === "at") i++
    to = placeAt(tokens, i)
    if (!to) return null
    i += to.len
    if (words(i) === "time" || words(i) === "now") { i++; explicitNow = true }
    if (!explicitNow) return null
  }
  if (i !== tokens.length) return null

  var fromOffset = from ? zoneOffset(from.zone) : localOffset()
  var toOffset = to ? zoneOffset(to.zone) : localOffset()
  var instant
  if (time) {
    // That wall-clock time today, in the source zone.
    var wall = new Date(nowMs() + fromOffset * 60000)
    instant = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), time.h, time.m) - fromOffset * 60000
  } else instant = nowMs()
  return {
    kind: "time",
    instant: instant,
    fromLabel: from ? from.label : (time ? "Local Time" : ""),
    fromOffset: fromOffset,
    toLabel: to ? to.label : "Local Time",
    toOffset: toOffset,
    time: time
  }
}

// ------------------------------------------------------------- formatting

function trimNumber(x) {
  if (x === 0) return "0"
  if (Math.floor(x) === x && Math.abs(x) < 1e15) return String(x)
  var r = Number(x.toPrecision(12))
  var abs = Math.abs(r)
  if (abs >= 1e15 || abs < 1e-9) return r.toExponential().replace(/\.?0+e/, "e").replace("e+", "e")
  var s = r.toString()
  if (s.indexOf("e") >= 0) s = r.toFixed(12).replace(/\.?0+$/, "")
  return s
}

// A measured quantity: 4 decimals, or 4 significant digits below 1. [D]
function trimMeasure(x) {
  if (Math.abs(x) >= 1 || x === 0) return trimNumber(Math.round(x * 1e4) / 1e4)
  return trimNumber(Number(x.toPrecision(4)))
}

function group(s) {
  var neg = s.charAt(0) === "-"
  if (neg) s = s.slice(1)
  if (s.indexOf("e") >= 0) return (neg ? "-" : "") + s
  var parts = s.split(".")
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return (neg ? "-" : "") + parts.join(".")
}

function fixed(x, decimals) {
  var s = (Math.round(x * Math.pow(10, decimals)) / Math.pow(10, decimals)).toFixed(decimals)
  return s === "-0" || /^-0\.0+$/.test(s) ? s.slice(1) : s
}

function unitLabel(unit, n) {
  if (unit.long) return Math.abs(n) === 1 ? unit.name : unit.plural
  return unit.sym
}

function titleCase(s) { return s.replace(/(^|\s)([a-z])/g, function(_, a, b) { return a + b.toUpperCase() }) }

// { display, copy, caption } for a value.
function present(v, state) {
  if (v.type === "date") {
    var d = new Date(v.ms)
    var text = WEEKDAY_NAMES[d.getDay()] + ", " + d.getDate() + " " + MONTH_NAMES[d.getMonth()] + " " + d.getFullYear()
    if (v.hasTime) text += " at " + clock(d.getHours(), d.getMinutes())
    return { display: text, copy: text, caption: relativeDays(v.ms) }
  }
  if (v.unix) {
    var stamp = String(v.n)
    return { display: stamp, copy: stamp, caption: "Unix Timestamp" }
  }
  if (v.base === "sci") {
    var e = v.n.toExponential().replace("e+", "e")
    return { display: e, copy: e, caption: "Scientific Notation" }
  }
  if (v.base) {
    if (Math.floor(v.n) !== v.n || Math.abs(v.n) > Number.MAX_SAFE_INTEGER) throw new CalcError("not an integer")
    var prefix = { 16: "0x", 2: "0b", 8: "0o", 10: "" }[v.base]
    var digits = Math.abs(v.n).toString(v.base).toUpperCase()
    var out = (v.n < 0 ? "-" : "") + prefix + digits
    return { display: out, copy: out, caption: { 16: "Hexadecimal", 2: "Binary", 8: "Octal", 10: "Decimal" }[v.base] }
  }
  if (v.pct) {
    var p = trimNumber(v.n * 100)
    return { display: group(p) + "%", copy: p + "%", caption: "Percent" }
  }
  if (v.unit && v.unit.currency) {
    var c = CURRENCIES[v.unit.currency]
    var places = c.decimals === undefined ? 2 : c.decimals
    var amount = fixed(v.n, places)
    var shown = c.symbol ? (amount.charAt(0) === "-" ? "-" + c.symbol + group(amount.slice(1)) : c.symbol + group(amount)) : group(amount) + " " + v.unit.currency
    return { display: shown, copy: shown.replace(/,/g, ""), caption: currencyName(v.unit.currency) }
  }
  var n = v.unit ? trimMeasure(v.n) : trimNumber(v.n)
  if (v.unit) {
    var label = unitLabel(v.unit, v.n)
    return { display: group(n) + " " + label, copy: n + " " + label, caption: titleCase(Math.abs(v.n) === 1 ? v.unit.name : v.unit.plural) }
  }
  return { display: group(n), copy: n, caption: numberWords(v.n) }
}

function currencyName(code) {
  var c = CURRENCIES[code]
  var name = c.names.filter(function(n) { return n.indexOf(" ") > 0 })[0] || c.names[0]
  return titleCase(name).replace(/^Us /, "US ") + " (" + code + ")"
}

function clock(h, m) {
  var mm = (m < 10 ? "0" : "") + m
  if (ENV && ENV.hour12 === false) return (h < 10 ? "0" : "") + h + ":" + mm
  return ((h % 12) || 12) + ":" + mm + " " + (h < 12 ? "AM" : "PM")
}

function relativeDays(ms) {
  var days = Math.round((startOfDay(ms) - today()) / 864e5)
  if (days === 0) return "Today"
  if (days === 1) return "Tomorrow"
  if (days === -1) return "Yesterday"
  return days > 0 ? "In " + group(String(days)) + " days" : group(String(-days)) + " days ago"
}

function utcLabel(offset) {
  if (offset === 0) return "UTC"
  var sign = offset > 0 ? "+" : "-"
  var a = Math.abs(offset)
  return "UTC" + sign + Math.floor(a / 60) + (a % 60 ? ":" + (a % 60 < 10 ? "0" : "") + (a % 60) : "")
}

function presentTime(tz) {
  var at = function(offset) {
    var w = new Date(tz.instant + offset * 60000)
    return {
      clock: clock(w.getUTCHours(), w.getUTCMinutes()),
      day: WEEKDAY_NAMES[w.getUTCDay()] + ", " + w.getUTCDate() + " " + MONTH_NAMES[w.getUTCMonth()],
      dayIndex: Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate())
    }
  }
  var dst = at(tz.toOffset)
  var src = at(tz.fromOffset)
  var dayShift = (dst.dayIndex - src.dayIndex) / 864e5
  var shift = dayShift > 0 ? " (+" + dayShift + " day)" : (dayShift < 0 ? " (" + dayShift + " day)" : "")
  return {
    display: dst.clock + shift,
    copy: dst.clock,
    caption: dst.day + " · " + tz.toLabel + " (" + utcLabel(tz.toOffset) + ")",
    inputCaption: tz.time ? src.day + " · " + tz.fromLabel + " (" + utcLabel(tz.fromOffset) + ")" : "Current Time"
  }
}

var ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
var TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
var SCALES = ["", "thousand", "million", "billion", "trillion"]

function wordsBelow1000(n) {
  var out = []
  if (n >= 100) { out.push(ONES[Math.floor(n / 100)] + " hundred"); n %= 100 }
  if (n >= 20) { out.push(TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "")) }
  else if (n > 0) out.push(ONES[n])
  return out.join(" ")
}

// The answer in words, Raycast's caption under a plain number. Integers
// below a quadrillion; otherwise empty.
function numberWords(n) {
  if (!isFinite(n) || Math.floor(n) !== n || Math.abs(n) >= 1e15) return ""
  if (n === 0) return "Zero"
  var parts = []
  var a = Math.abs(n)
  for (var s = 0; a > 0; s++) {
    var chunk = a % 1000
    if (chunk) parts.unshift(wordsBelow1000(chunk) + (SCALES[s] ? " " + SCALES[s] : ""))
    a = Math.floor(a / 1000)
  }
  return titleCase((n < 0 ? "minus " : "") + parts.join(" "))
}

// ------------------------------------------------------------------- API

var KIND_CAPTIONS = { math: "Expression", percentage: "Percentage", date: "Date", base: "Number", unix: "Date" }

function evaluate(query, env) {
  var q = String(query || "").trim()
  if (!q || q.length > 200) return null
  ENV = env || {}
  try {
    var tokens = lex(q)
    if (tokens.length === 0) return null
    var tz = parseTimeZone(tokens)
    if (tz) {
      var t = presentTime(tz)
      return { kind: "time", input: q, result: t.display, copy: t.copy, inputCaption: t.inputCaption, resultCaption: t.caption }
    }
    var parser = new Parser(tokens)
    var value = parser.parseStatement()
    var state = parser.state
    if (state.ops === 0) return null
    if (value.type === "num" && !isFinite(value.n)) return null
    if (value.type === "date" && !isFinite(value.ms)) return null
    var shown = present(value, state)
    var kind = value.type === "date" ? "date" : state.kind
    var inputCaption = state.fromUnix ? "Unix Timestamp" : (KIND_CAPTIONS[kind] || "")
    if ((kind === "conversion" || kind === "currency") && state.fromUnit) {
      inputCaption = state.fromUnit.currency
        ? present(num(1, state.fromUnit), state).caption
        : titleCase(state.fromUnit.plural)
    }
    return {
      kind: kind,
      input: q,
      result: shown.display,
      copy: shown.copy,
      value: value.type === "num" ? value.n : value.ms,
      inputCaption: inputCaption,
      resultCaption: shown.caption
    }
  } catch (e) {
    if (e instanceof CalcError) return null
    throw e
  } finally {
    ENV = null
  }
}

// History (SPEC §6.4 calculator_history): newest first, unique by query,
// capped at Raycast's 4096 rows and its "last 3 months" window. [O]
var HISTORY_LIMIT = 4096
var HISTORY_MAX_AGE_MS = 90 * 864e5

function pushHistory(history, entry, nowMs) {
  var list = (Array.isArray(history) ? history : []).filter(function(h) {
    return h.query !== entry.query && (h.pinned || nowMs - h.createdAt < HISTORY_MAX_AGE_MS)
  })
  list.unshift({ id: entry.id, query: entry.query, result: entry.result, copy: entry.copy, kind: entry.kind, createdAt: nowMs })
  return list.slice(0, HISTORY_LIMIT)
}

function filterHistory(history, query) {
  var q = String(query || "").trim().toLowerCase()
  var list = Array.isArray(history) ? history : []
  if (!q) return list
  return list.filter(function(h) { return (h.query + " " + h.result).toLowerCase().indexOf(q) >= 0 })
}

if (typeof module !== "undefined") {
  module.exports = {
    evaluate: evaluate,
    lex: lex,
    words: numberWords,
    zoneList: zoneList,
    pushHistory: pushHistory,
    filterHistory: filterHistory,
    HISTORY_LIMIT: HISTORY_LIMIT,
    HISTORY_MAX_AGE_MS: HISTORY_MAX_AGE_MS,
    CURRENCIES: CURRENCIES,
    UNITS: UNITS
  }
}
