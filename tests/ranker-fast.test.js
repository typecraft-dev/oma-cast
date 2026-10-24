// The ranker's fast paths (sparse DP, one-character shortcut, candidate
// prefilter, per-candidate cache) must rank exactly like the plain
// description in ref 02 §4.3. These tests hold them to a dense reference.
const test = require("node:test")
const assert = require("node:assert/strict")
const R = require("../plugin/core/Ranker.js")

// Dense reference: the cell-by-cell DP over the whole table.
function referenceMatch(target, query, literalDots) {
  const sep = (ch) => ch !== "" && "\t\n -./()[]".indexOf(ch) !== -1
  const text = String(target)
  const bounds = [...text].map((_, i) => i > 0 && /[a-z0-9]/.test(text[i - 1]) && /[A-Z]/.test(text[i]))
  const t = text.toLowerCase()
  const q = String(query).toLowerCase()
  const qSep = (ch) => !(literalDots && ch === ".") && sep(ch)
  if (!q) return "unmatched"
  if (t === q) return "exact"
  const u = [...q].filter((ch) => !qSep(ch)).length
  if (u > t.length) return "unmatched"
  if (u > 2) {
    let ti = 0
    for (const ch of q) {
      if (qSep(ch)) {
        for (let s = ti; s < t.length; s++) if (sep(t[s])) { ti = s + 1; break }
        continue
      }
      const found = t.indexOf(ch, ti)
      if (found < 0) return "unmatched"
      ti = found + 1
    }
  }
  const n = t.length
  let prev = null, d = -1, p = 0, skipped = 0
  for (const ch of q) {
    const chSep = qSep(ch)
    const cur = new Array(n).fill(-Infinity)
    let firstCol = -1
    const end = Math.min(n, n - (u - 1 - p))
    for (let e = d + 1; e < end; e++) {
      const tc = t[e]
      const sepMatch = chSep && sep(tc)
      if (!(tc === ch || sepMatch)) continue
      let score
      if (sepMatch) score = 1
      else if (p === 0 && e === 0) score = 4
      else score = ((bounds[e] || (e > 0 && sep(t[e - 1]))) && !sep(tc)) ? 3 : 2
      let cell = -Infinity
      if (p === 0) cell = score
      else for (let r = d; r < e; r++) if (prev[r] !== -Infinity) cell = Math.max(cell, prev[r] + score - (r === e - 1 ? 0 : 1))
      if (cell === -Infinity) continue
      cur[e] = cell
      if (firstCol < 0) firstCol = e
    }
    if (firstCol >= 0) { d = firstCol; p++; prev = cur }
    else if (chSep) skipped++
    else return "unmatched"
  }
  if (!prev) return "unmatched"
  const best = Math.max(...prev)
  return best === -Infinity ? "unmatched" : { score: best, skipped }
}

function random(seed) {
  return (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n) }
}

test("fuzzyMatch equals the dense reference on random input", () => {
  const rnd = random(7)
  const targetChars = "aabbcdeefgsSAFx -./()[]Lo"
  const queryChars = "aabcdefgsx -./("
  for (let i = 0; i < 20000; i++) {
    let target = ""
    for (let k = rnd(24); k > 0; k--) target += targetChars[rnd(targetChars.length)]
    let query = ""
    for (let k = 1 + rnd(5); k > 0; k--) query += queryChars[rnd(queryChars.length)]
    for (const literalQueryDots of [false, true]) {
      assert.deepEqual(R.fuzzyMatch(target, query, { literalQueryDots }), referenceMatch(target, query, literalQueryDots),
        JSON.stringify({ target, query, literalQueryDots }))
    }
  }
})

test("one-character queries score 4 at the start, 3 at a word start, else 2", () => {
  assert.deepEqual(R.fuzzyMatch("Apps", "a"), { score: 4, skipped: 0 })
  assert.deepEqual(R.fuzzyMatch("my app", "a"), { score: 3, skipped: 0 })
  assert.deepEqual(R.fuzzyMatch("LibreOffice", "o"), { score: 3, skipped: 0 })
  assert.deepEqual(R.fuzzyMatch("bad", "a"), { score: 2, skipped: 0 })
  assert.equal(R.fuzzyMatch("bbb", "a"), "unmatched")
  // a literal "." is a separator character in the target: never a word start
  assert.deepEqual(R.fuzzyMatch("a b.c", ".", { literalQueryDots: true }), { score: 2, skipped: 0 })
})

test("canSkip only skips candidates rank would drop", () => {
  const rnd = random(11)
  const word = () => { let s = ""; for (let k = 1 + rnd(10); k > 0; k--) s += "abcdeFgs -."[rnd(11)]; return s }
  for (let i = 0; i < 5000; i++) {
    const c = {
      id: "c" + i, type: "command", title: word(), subtitle: rnd(2) ? word() : "",
      keywords: rnd(2) ? [word()] : [], alternateTitles: rnd(4) ? undefined : [word()],
      alias: rnd(4) ? "" : word().toLowerCase(), bundleId: rnd(2) ? "org." + word() : undefined,
      alwaysMatching: rnd(10) === 0
    }
    let query = ""
    for (let k = 1 + rnd(4); k > 0; k--) query += "abcdefgs .x"[rnd(11)]
    if (R.canSkip(c, c.alias, query)) {
      assert.equal(R.buildRecord(c, query, { nowMs: 0 }).isMatching, false, JSON.stringify({ c, query }))
    }
  }
  assert.equal(R.canSkip({ id: "x", title: "Firefox" }, "", "zq"), true)
  assert.equal(R.canSkip({ id: "x", title: "Firefox" }, "zq", "zq"), false) // alias match
  assert.equal(R.canSkip({ id: "x", title: "Firefox", alwaysMatching: true }, "", "zq"), false)
  assert.equal(R.canSkip({ id: "x", title: "Firefox" }, "", ""), false)
})

test("a candidate's cached text follows changes under the same id", () => {
  assert.notEqual(R.buildRecord({ id: "same", type: "command", title: "Alpha" }, "alpha").title, "unmatched")
  assert.equal(R.buildRecord({ id: "same", type: "command", title: "Beta" }, "alpha").title, "unmatched")
  assert.equal(R.buildRecord({ id: "same", type: "command", title: "Beta" }, "beta").title, "exact")
})
