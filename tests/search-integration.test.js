const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { spawn } = require("node:child_process")
const readline = require("node:readline")
const R = require("../plugin/core/Ranker.js")
const F = require("../plugin/core/FleaSearch.js")
const Root = require("../plugin/core/RootSearch.js")
const Frecency = require("../plugin/core/Frecency.js")
const binary = path.join(__dirname, "../plugin/bin/oma-cast-search")

test("built helper feeds the actual root ranker and sections", { skip: !fs.existsSync(binary), timeout: 10000 }, async t => {
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"] })
  t.after(() => child.kill())
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const ask = async obj => { child.stdin.write(JSON.stringify(obj) + "\n"); return JSON.parse((await lines.next()).value) }
  const candidates = [
    { id: "chrome", title: "Chromium", type: "application", keywords: ["browser"] },
    { id: "cafe", title: "Café", type: "application", alternateTitles: ["Coffee"], subtitle: "Drinks" },
    { id: "lock", title: "Lock", type: "command" }
  ].map(c => ({ ...c, rootSearch: { when: "always" } }))
  const ids = candidates.map(c => c.id)
  assert.equal((await ask({ id: 1, entries: F.entries(candidates, R.transliterate) })).loaded, 3)
  for (const [query, expected] of [["chormium", "chrome"], ["cafe", "cafe"], ["coffee", "cafe"], ["drinks", "cafe"], ["browser", "chrome"], ["lcok", "lock"]]) {
    const reply = await ask({ id: 2, query: R.transliterate(query), sensitivity: "medium" })
    const fleaHits = F.hits(F.reply(JSON.stringify(reply)), ids)
    const ctx = { commands: {}, frecency: {}, nowMs: 1000, filter: "all", fleaHits }
    const sections = Root.rootSections(candidates, query, ctx, { Ranker: R, Frecency })
    assert.equal(sections[0].rows[0].candidate.id, expected, query)
    assert.equal(sections.at(-1).id, "fallback-commands")
    ctx.commands[expected] = { enabled: false }
    const filtered = Root.rootSections(candidates, query, ctx, { Ranker: R, Frecency })
    assert.ok(!filtered.flatMap(s => s.rows).some(r => r.candidate.id === expected))
  }
  assert.deepEqual((await ask({ id: 3, query: "lcok", sensitivity: "high" })).hits, [])
  assert.deepEqual((await ask({ id: 4, query: "" })).hits, [])
  child.stdin.end()
})
