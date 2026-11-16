#!/usr/bin/env node
// Refreshes the Omarchy data the in-browser launcher searches. Run on an Omarchy machine:
//   node site/snapshot.mjs
// Writes, under site/public/demo/ (all committed):
//   snapshot.json        Omarchy's menu (default/omarchy/omarchy-menu.jsonc), which rows are hidden or
//                        checked, and the day's ECB exchange rates
//   emoji-keywords.json  Omarchy's emoji search keywords (shell/plugins/emojis/emojis.json)
//   symbols.woff2        the icon glyphs the launcher draws, subset from JetBrainsMono Nerd Font
//                        (needs `uvx`, which fetches fonttools)
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { MODULES } from "./build.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, "..")
const out = path.join(here, "public/demo")
const omarchy = process.env.OMARCHY_PATH || "/usr/share/omarchy"
const require = createRequire(import.meta.url)
const OmarchyMenu = require(path.join(root, "core/OmarchyMenu.js"))

// ---------------------------------------------------------------- menu

const parsed = OmarchyMenu.parse(fs.readFileSync(path.join(omarchy, "default/omarchy/omarchy-menu.jsonc"), "utf8"))
if (parsed.error || !parsed.items.length) throw new Error("could not read Omarchy's menu: " + parsed.error)
const tree = OmarchyMenu.buildTree(parsed.items, [])

// The real guards, run the way the plugin runs them, so on/off pairs come out coherent.
const guards = OmarchyMenu.parseGuardOutput(execFileSync("bash", ["-c", OmarchyMenu.guardScript(tree)], { encoding: "utf8" }))

// Then take this machine out of it. Which optional software is installed and which defaults were
// picked are nobody's business: Remove rows are hidden, nothing reads as installed, and the default
// apps are Omarchy's own.
const DEFAULTS = ["setup.default.browser.chromium", "setup.default.terminal.ghostty", "setup.default.editor.neovim"]
const when = {}, checked = {}
for (const item of parsed.items) {
  if (item.when && (guards.when[item.id] === false || item.id.startsWith("remove."))) when[item.id] = false
  if (item.checked && guards.checked[item.id] && !item.id.startsWith("setup.default.")) checked[item.id] = true
}
for (const id of DEFAULTS) if (tree.items[id]) checked[id] = true

// Raw fields only; the browser runs them through OmarchyMenu.parse again.
const menu = {}
for (const item of parsed.items) {
  const row = {}
  for (const key of ["icon", "iconFont", "label", "title", "description", "action", "target", "provider"]) if (item[key]) row[key] = item[key]
  if (item.aliases.length) row.aliases = item.aliases
  menu[item.id] = row
}

// ---------------------------------------------------------------- exchange rates

let rates = null
try {
  const cached = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".cache/omacast/currencies.json"), "utf8"))
  rates = { base: cached.base, date: cached.date, rates: cached.rates }
} catch (e) {
  console.warn("no cached exchange rates (open omacast once); keeping the old ones")
  try { rates = JSON.parse(fs.readFileSync(path.join(out, "snapshot.json"), "utf8")).rates } catch (e2) {}
}

fs.mkdirSync(out, { recursive: true })
const version = fs.readFileSync(path.join(omarchy, "version"), "utf8").trim()
fs.writeFileSync(path.join(out, "snapshot.json"), JSON.stringify({
  omarchyVersion: version, takenAt: new Date().toISOString().slice(0, 10), menu, guards: { when, checked, disabled: {} }, rates
}) + "\n")

// ---------------------------------------------------------------- emoji keywords

const keywords = JSON.parse(fs.readFileSync(path.join(omarchy, "shell/plugins/emojis/emojis.json"), "utf8"))
  .filter((row) => row && row.e && row.k).map((row) => ({ e: row.e, k: row.k }))
fs.writeFileSync(path.join(out, "emoji-keywords.json"), JSON.stringify(keywords) + "\n")

// ---------------------------------------------------------------- icon font

// Every private-use glyph the launcher can draw: the menu's icons, plus the ones written into the
// core modules and launcher.js, as literal characters or \uXXXX escapes.
const points = new Set()
function isIcon(cp) { return (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd) }
function scan(text) {
  for (const ch of text) if (isIcon(ch.codePointAt(0))) points.add(ch.codePointAt(0))
  for (const m of text.matchAll(/\\u([0-9a-fA-F]{4})/g)) if (isIcon(parseInt(m[1], 16))) points.add(parseInt(m[1], 16))
  for (const m of text.matchAll(/\\u\{([0-9a-fA-F]{4,6})\}/g)) if (isIcon(parseInt(m[1], 16))) points.add(parseInt(m[1], 16))
}
for (const item of parsed.items) if (item.iconFont !== "omarchy") scan(item.icon)
for (const name of MODULES) scan(fs.readFileSync(path.join(root, "core", name + ".js"), "utf8"))
scan(fs.readFileSync(path.join(here, "public/launcher.js"), "utf8"))

const font = process.env.SYMBOLS_FONT || "/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf"
const unicodes = [...points].sort((a, b) => a - b).map((cp) => "U+" + cp.toString(16).toUpperCase()).join(",")
execFileSync("uvx", ["--from", "fonttools", "--with", "brotli", "pyftsubset", font, "--unicodes=" + unicodes,
  "--flavor=woff2", "--no-hinting", "--desubroutinize", "--output-file=" + path.join(out, "symbols.woff2")], { stdio: ["ignore", "ignore", "ignore"] })

console.log(`Omarchy ${version}: ${parsed.items.length} menu items (${Object.keys(when).length} hidden, ${Object.keys(checked).length} checked), `
  + `${keywords.length} emoji keyword rows, ${points.size} glyphs, rates ${rates ? rates.date : "missing"}`)
