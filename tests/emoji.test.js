const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const path = require("path")
const Emoji = require("../core/Emoji.js")

const raw = fs.readFileSync(path.join(__dirname, "..", "data", "emoji.json"), "utf8")
const keywords = JSON.stringify([{ e: "😂", k: "face with tears of joy lol haha" }, { e: "❤", k: "red heart love" }])
const { groups, list } = Emoji.parse(raw, keywords)
const state = { pinned: [], recent: [], tone: "none", filter: "all" }
const symbols = (sections) => sections.flatMap((s) => s.rows.map((r) => r.symbol))

test("parses the bundled data into groups without components or toned variants", () => {
  assert.equal(groups[0], "Smileys & Emotion")
  assert.ok(!groups.includes("Component"))
  assert.ok(list.length > 1800)
  assert.ok(!list.some((e) => /[\u{1F3FB}-\u{1F3FF}]/u.test(e.symbol)))
  assert.equal(list[0].title, "Grinning Face")
})

test("search ranks name matches over keyword matches and merges Omarchy keywords", () => {
  assert.equal(symbols(Emoji.sections(list, "lol", state))[0], "😂")
  assert.equal(symbols(Emoji.sections(list, "love", state)).includes("❤️"), true)   // keyword without FE0F still merges
  const hearts = symbols(Emoji.sections(list, "red heart", state))
  assert.equal(hearts[0], "❤️")
  assert.deepEqual(Emoji.sections(list, "zzqqxx", state), [])
})

test("empty query shows pinned, recent, then categories; filter narrows", () => {
  const s = Emoji.sections(list, "", { ...state, pinned: ["🔥"], recent: ["🔥", "👍"] })
  assert.deepEqual(s.slice(0, 3).map((x) => x.title), ["Pinned", "Recently Used", "Smileys & Emotion"])
  assert.deepEqual(s[1].rows.map((r) => r.symbol), ["👍"])
  const flags = Emoji.sections(list, "", { ...state, filter: "Flags" })
  assert.deepEqual(flags.map((x) => x.title), ["Flags"])
})

test("skin tone applies to toneable emoji only", () => {
  assert.equal(Emoji.applyTone("👋", "medium"), "👋🏽")
  assert.equal(Emoji.applyTone("🖐️", "dark"), "🖐🏿")
  assert.equal(Emoji.applyTone("🏃‍♂️", "light"), "🏃🏻‍♂️")
  const wave = Emoji.sections(list, "waving hand", { ...state, tone: "dark" })[0].rows[0]
  assert.equal(wave.symbol, "👋🏿")
  assert.equal(wave.id, "emoji:👋")
  const smile = Emoji.sections(list, "grinning face", { ...state, tone: "dark" })[0].rows[0]
  assert.equal(smile.symbol, "😀")
})

test("gridLines packs sections into lines of columns", () => {
  const lines = Emoji.gridLines([{ id: "a", title: "A", rows: [1, 2, 3, 4, 5] }], 2)
  assert.deepEqual(lines.map((l) => (l.section ? "S" : l.cells.length)), ["S", 2, 2, 1])
})

test("flea hits rank by best field, then name, then recently used", () => {
  const T = 4000000
  const hits = { "🔥": { title: 5000000, keyword: null }, "🚒": { title: T, keyword: 5000000 }, "🧯": { title: T, keyword: 5000000 } }
  const s = Emoji.sections(list, "fire", { ...state, recent: ["🧯"], fleaHits: hits })
  assert.deepEqual(symbols(s), ["🔥", "🧯", "🚒"])
  assert.deepEqual(Emoji.searchEntries([{ name: "fire", words: "fire flame hot" }]), [{ title: "fire", keywords: ["flame", "hot"] }])
})
