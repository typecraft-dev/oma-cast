// Colour themes for the launcher (macOS for now; Omarchy follows its own
// theme). Built-in palettes plus user files in <config>/themes/<id>.json:
//
//   {
//     "name": "Tokyo Night",
//     "appearance": "dark",            // or "light": system controls follow it
//     "colors": {
//       "background": "#1a1b26",       // required: the card
//       "text": "#c0caf5",             // required: titles, the query
//       "accent": "#7aa2f7",           // required: caret, icons, the answer
//       "subtext": "#a9b1d6",          // optional: subtitles, section titles
//       "faint": "#565f89",            // optional: placeholder, type labels
//       "selection": "#292e42",        // optional: the selected row
//       "border": "#3b4261",           // optional: card and popup outlines
//       "failure": "#f7768e"           // optional: failure toasts
//     }
//   }
//
// Colours are #rrggbb or #rrggbbaa. A missing optional colour is derived
// from text and background. [D, 2026-11-12]

var SYSTEM_IDS = ["system", "omarchy"]

// Catppuccin (MIT, github.com/catppuccin/palette): base, text, subtext0,
// overlay1, mauve, surface0, surface1, red.
function catppuccin(name, appearance, c) {
  return {
    name: "Catppuccin " + name, appearance: appearance,
    colors: { background: c[0], text: c[1], subtext: c[2], faint: c[3], accent: c[4], selection: c[5], border: c[6], failure: c[7] }
  }
}

var BUILTIN = {
  "catppuccin-mocha": catppuccin("Mocha", "dark", ["#1e1e2e", "#cdd6f4", "#a6adc8", "#7f849c", "#cba6f7", "#313244", "#45475a", "#f38ba8"]),
  "catppuccin-macchiato": catppuccin("Macchiato", "dark", ["#24273a", "#cad3f5", "#a5adcb", "#8087a2", "#c6a0f6", "#363a4f", "#494d64", "#ed8796"]),
  "catppuccin-frappe": catppuccin("Frappé", "dark", ["#303446", "#c6d0f5", "#a5adce", "#838ba7", "#ca9ee6", "#414559", "#51576d", "#e78284"]),
  "catppuccin-latte": catppuccin("Latte", "light", ["#eff1f5", "#4c4f69", "#6c6f85", "#8c8fa1", "#8839ef", "#ccd0da", "#bcc0cc", "#d20f39"])
}

var REQUIRED = ["background", "text", "accent"]
var OPTIONAL = ["subtext", "faint", "selection", "border", "failure"]

function isColor(value) {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)
}

// "#rrggbb" + alpha 0..1 -> "#rrggbbaa".
function withAlpha(hex, alpha) {
  var a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16)
  return hex.slice(0, 7) + (a.length < 2 ? "0" + a : a)
}

// A theme with every colour filled in, or throws with what is wrong.
function normalize(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not a JSON object")
  var colors = doc.colors
  if (!colors || typeof colors !== "object") throw new Error("needs a \"colors\" object")
  for (var i = 0; i < REQUIRED.length; i++) {
    if (!isColor(colors[REQUIRED[i]])) throw new Error("colors." + REQUIRED[i] + " must be #rrggbb")
  }
  for (var j = 0; j < OPTIONAL.length; j++) {
    var v = colors[OPTIONAL[j]]
    if (v !== undefined && !isColor(v)) throw new Error("colors." + OPTIONAL[j] + " must be #rrggbb")
  }
  var appearance = doc.appearance === "light" ? "light" : "dark"
  var text = colors.text
  return {
    name: String(doc.name || "Untitled").slice(0, 60),
    appearance: appearance,
    background: colors.background,
    text: text,
    accent: colors.accent,
    subtext: colors.subtext || withAlpha(text, 0.7),
    faint: colors.faint || withAlpha(text, 0.45),
    selection: colors.selection || withAlpha(text, 0.1),
    border: colors.border || withAlpha(text, 0.15),
    failure: colors.failure || (appearance === "light" ? "#d20f39" : "#f38ba8")
  }
}

// One user file: { id, theme } or { id, error }. The id is the file name
// without .json, lower-case letters, digits and dashes.
function parseFile(fileName, text) {
  var id = String(fileName).replace(/\.json$/i, "").toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return { id: id, error: fileName + ": name it like my-theme.json" }
  if (BUILTIN[id]) return { id: id, error: fileName + ": " + id + " is a built-in theme" }
  try {
    return { id: id, theme: normalize(JSON.parse(text)) }
  } catch (e) {
    return { id: id, error: fileName + ": " + (e && e.message || e) }
  }
}

// Every theme by id: built-ins, then valid user files.
function catalog(userFiles) {
  var out = {}
  for (var id in BUILTIN) out[id] = { id: id, builtin: true, theme: normalize(BUILTIN[id]) }
  for (var i = 0; i < (userFiles || []).length; i++) {
    var f = userFiles[i]
    if (f.theme) out[f.id] = { id: f.id, builtin: false, theme: f.theme }
  }
  return out
}

// The palette for a theme id, or null for the system look.
function resolve(id, cat) {
  if (!id || SYSTEM_IDS.indexOf(id) >= 0) return null
  var entry = cat[id]
  return entry ? entry.theme : null
}

if (typeof module !== "undefined") {
  module.exports = { BUILTIN: BUILTIN, SYSTEM_IDS: SYSTEM_IDS, isColor: isColor, normalize: normalize, parseFile: parseFile, catalog: catalog, resolve: resolve }
}
