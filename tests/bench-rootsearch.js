// Root-search cost per keystroke on this machine's real data: the Omarchy
// menu plus one candidate per installed .desktop file. Not a test (no
// .test.js suffix); run it by hand when touching core/Ranker.js:
//
//   node tests/bench-rootsearch.js              # V8 with its JIT
//   node --jitless tests/bench-rootsearch.js    # closer to QML's V4 engine
//
// V4 is slower still: inside Quickshell the same work measured about 3x the
// --jitless figures (2026-10-20: "f" took ~14 ms there, down from ~29 ms
// before normalize/transliterate were memoized). Keep it under a 16 ms frame.
const fs = require("fs")
const path = require("path")
const Ranker = require("../plugin/core/Ranker.js")
const Frecency = require("../plugin/core/Frecency.js")
const OmarchyMenu = require("../plugin/core/OmarchyMenu.js")
const RootSearch = require("../plugin/core/RootSearch.js")

const deps = { Ranker, Frecency, OmarchyMenu }
const omarchyPath = process.env.OMARCHY_PATH || "/usr/share/omarchy"
const menuFile = path.join(omarchyPath, "default/omarchy/omarchy-menu.jsonc")
const appsDir = "/usr/share/applications"

const menuText = fs.existsSync(menuFile) ? fs.readFileSync(menuFile, "utf8") : ""
if (!menuText) console.warn("no Omarchy menu at " + menuFile + "; benchmarking apps only")
const tree = OmarchyMenu.buildTree(OmarchyMenu.parse(menuText).items, [])
const candidates = RootSearch.menuCandidates(tree, null, {}, deps)
const menuCount = candidates.length
const desktopFiles = fs.existsSync(appsDir) ? fs.readdirSync(appsDir).filter((f) => f.endsWith(".desktop")) : []
for (const file of desktopFiles) {
  const id = file.replace(/\.desktop$/, "")
  candidates.push(RootSearch.appCandidate({ id, name: id.replace(/[.-]/g, " "), genericName: "Application" }))
}

const jitless = process.execArgv.includes("--jitless")
console.log(`${candidates.length} candidates (${menuCount} menu, ${candidates.length - menuCount} apps), ${jitless ? "--jitless" : "JIT"}`)

const ctx = { commands: {}, frecency: {}, nowMs: Date.now(), sensitivity: "medium" }
for (const query of ["", "f", "fir", "firefox", "theme", "set wallpaper", "omarchy update system"]) {
  for (let i = 0; i < 5; i++) RootSearch.rootSections(candidates, query, ctx, deps)
  const runs = 30
  const start = process.hrtime.bigint()
  for (let i = 0; i < runs; i++) RootSearch.rootSections(candidates, query, ctx, deps)
  const ms = Number(process.hrtime.bigint() - start) / 1e6 / runs
  console.log(`  ${JSON.stringify(query).padEnd(24)} ${ms.toFixed(2).padStart(6)} ms`)
}
