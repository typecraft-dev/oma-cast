const test = require("node:test")
const assert = require("node:assert/strict")
const C = require("../core/ClipboardHistory.js")

const DAY = 86400000
const now = new Date(2026, 10, 4, 15, 0).getTime()
const text = (t, hash) => ({ type: "text", text: t, hash: hash || t, bytes: t.length, source: { name: "Ghostty", appId: "com.mitchellh.ghostty" } })

test("categorizes like Raycast", () => {
  assert.deepEqual(C.categorize(text("hello world")), ["text"])
  assert.deepEqual(C.categorize(text("https://omarchy.org/x?y=1")), ["link"])
  assert.deepEqual(C.categorize(text("mailto:a@b.co")), ["link", "email"])
  assert.deepEqual(C.categorize(text("#1e1e2e")), ["color"])
  assert.deepEqual(C.categorize(text("rgb(255, 0, 10)")), ["color"])
  assert.deepEqual(C.categorize(text("file:///home/u/a%20b.png")), ["file", "image"])
  assert.deepEqual(C.categorize(text("file:///a\nfile:///b")), ["file"])
  assert.deepEqual(C.categorize(text("see https://x.org")), ["text"])
  assert.deepEqual(C.categorize({ type: "image", hash: "h" }), ["image"])
  assert.equal(C.colorHex("#abc"), "#aabbcc")
  assert.equal(C.colorHex("rgba(0,0,0,0.5)"), "#00000080")
  assert.equal(C.colorHex("rgb(300,0,0)"), "")
  assert.deepEqual(C.filePaths("file:///home/u/a%20b.png"), ["/home/u/a b.png"])
})

test("dedups by hash: bumps count and moves up; self copies don't count", () => {
  let r = C.add([], text("a"), now - 2000, "1")
  r = C.add(r.entries, text("b"), now - 1000, "2")
  r = C.add(r.entries, text("a"), now, "3")
  assert.equal(r.added, false)
  assert.equal(r.entries.length, 2)
  assert.equal(r.entries[0].id, "1")
  assert.equal(r.entries[0].copyCount, 2)
  assert.equal(r.entries[0].createdAt, now - 2000)
  r = C.add(r.entries, Object.assign(text("b"), { source: { name: "Firefox", appId: "firefox" } }), now + 1, "4", true)
  assert.equal(r.entries[0].id, "2")
  assert.equal(r.entries[0].copyCount, 1)
  assert.equal(r.entries[0].source.name, "Ghostty")
  assert.equal(C.add(r.entries, text("  \n"), now, "5").entry, null)
})

test("prune keeps pinned entries and honours retention and the cap", () => {
  const old = Object.assign(C.add([], text("old"), now - 8 * DAY, "o").entry, { path: "/c/old.txt" })
  const pinned = Object.assign({}, old, { id: "p", hash: "p", pinned: 0, path: "/c/shared.png" })
  const fresh = Object.assign(C.add([], text("new"), now, "n").entry, { path: "/c/shared.png" })
  const r = C.prune([fresh, old, pinned], now, "P1W")
  assert.deepEqual(r.entries.map((e) => e.id), ["n", "p"])
  assert.deepEqual(C.orphanedPaths(r.removed, r.entries), ["/c/old.txt"])
  assert.equal(C.prune([old], now, "unlimited").entries.length, 1)
  const many = Array.from({ length: C.MAX_ENTRIES + 5 }, (_, i) => Object.assign({}, fresh, { id: String(i) }))
  assert.equal(C.prune(many, now, "unlimited").entries.length, C.MAX_ENTRIES)
})

test("sections: pinned in pin order, then by day; filter and search", () => {
  let list = []
  list = C.add(list, text("yesterday note"), now - DAY, "y").entries
  list = C.add(list, text("https://a.org"), now - 60000, "l").entries
  list = C.add(list, text("today note"), now, "t").entries
  list = C.setPinned(list, "l", true)
  list = C.setPinned(list, "y", true)
  const s = C.sections(list, "", "all", now)
  assert.deepEqual(s.map((x) => x.title), ["Pinned", "Today"])
  assert.deepEqual(s[0].rows.map((r) => r.candidate.id), ["clipboard:l", "clipboard:y"])
  assert.deepEqual(C.sections(list, "", "link", now).map((x) => x.rows.length), [1])
  assert.deepEqual(C.sections(list, "NOTE", "all", now).flatMap((x) => x.rows.map((r) => r.candidate.id)), ["clipboard:y", "clipboard:t"])
  assert.deepEqual(C.sections(list, "ghostty", "all", now).flatMap((x) => x.rows).length, 3)
  list = C.setPinned(list, "y", false)
  assert.deepEqual(C.sections(list, "", "all", now).map((x) => x.title), ["Pinned", "Today", "Yesterday"])
})

test("detail and actions", () => {
  const e = C.add([], text("two words"), now, "1").entry
  const d = C.detail(e)
  assert.equal(d.text, "two words")
  assert.deepEqual(d.info.slice(0, 4).map((r) => [r.label, r.value]), [["Source", "Ghostty"], ["Content type", "Text"], ["Characters", "9"], ["Words", "2"]])
  assert.deepEqual(C.actionsFor(e, "Firefox").map((a) => a.id), ["paste", "copy", "pin", "delete-entry", "delete-all-entries"])
  assert.equal(C.actionsFor(e, "Firefox")[0].title, "Paste to Firefox")
  const link = C.add([], text("https://a.org"), now, "2").entry
  assert.ok(C.actionsFor(link).some((a) => a.id === "open-link"))
  assert.equal(C.detail(C.add([], text("#ff0000"), now, "3").entry).color, "#ff0000")
  assert.equal(C.title(C.add([], text("file:///x/y.txt"), now, "4").entry), "y.txt")
  assert.ok(C.isDisabledSource({ appId: "org.keepassxc.KeePassXC" }, ["org.keepassxc.keepassxc"]))
  assert.ok(!C.isDisabledSource(null, ["x"]))
})

test("GIFs, .gif files and .gif links offer Save to GIF Library", () => {
  const saves = (e) => C.actionsFor(Object.assign({ categories: [] }, e), "").some((a) => a.id === "save-gif")
  assert.equal(saves({ type: "image", mime: "image/gif", path: "/c/x" }), true)
  assert.equal(saves({ type: "text", text: "file:///home/me/nope.gif" }), true)
  assert.equal(saves({ type: "text", text: "https://media.example.com/a/nope.gif?cid=1" }), true)
  assert.equal(saves({ type: "image", mime: "image/png", path: "/c/x" }), false)
  assert.equal(saves({ type: "text", text: "a gif of a cat" }), false)
})
