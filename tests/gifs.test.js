const test = require("node:test")
const assert = require("node:assert/strict")
const Gifs = require("../core/Gifs.js")

const meta = (over) => Object.assign({ id: "a1", file: "/l/a1.gif", thumb: "/l/a1.png", codec: "gif", width: 480, height: 270, frames: 20, bytes: 200000, phash: "db99999999994ddb", source: "" }, over)
const ids = (sections) => sections.flatMap((s) => s.rows.map((r) => r.id))
const tagged = (id, title, tags, over) => Object.assign(meta({ id: id, phash: "0000000000000000" }), { title: title, tags: tags, addedAt: 0 }, over)

test("the quality gate rejects small, huge, still and non-GIF files", () => {
  assert.deepEqual(Gifs.check(meta()), [])
  assert.match(Gifs.check(meta({ width: 160, height: 120 }))[0], /Too small/)
  assert.match(Gifs.check(meta({ bytes: 9 * 1024 * 1024 }))[0], /Too large/)
  assert.deepEqual(Gifs.check(meta({ frames: 1 })), ["Not animated"])
  assert.deepEqual(Gifs.check(meta({ codec: "png" })), ["Not a GIF"])
})

test("import adds to the Inbox, rejects bad files and merges near-duplicates into the larger copy", () => {
  let r = Gifs.importGif([], meta(), 5)
  assert.equal(r.status, "added")
  assert.equal(Gifs.inLibrary(r.gif), false)
  const tagged1 = Object.assign({}, r.gif, { title: "Nope", tags: ["nope", "no"] })

  r = Gifs.importGif([tagged1], meta({ id: "small", width: 100, height: 80, file: "/l/s.gif", thumb: "/l/s.png" }), 6)
  assert.equal(r.status, "rejected")
  assert.deepEqual(r.removeFiles, ["/l/s.gif", "/l/s.png"])

  // Same picture, one bit off, bigger: takes the new file, keeps title and tags.
  r = Gifs.importGif([tagged1], meta({ id: "big", width: 640, height: 360, phash: "db99999999994dda", file: "/l/big.gif", thumb: "/l/big.png" }), 7)
  assert.equal(r.status, "replaced")
  assert.equal(r.gifs.length, 1)
  assert.equal(r.gif.id, "a1")
  assert.equal(r.gif.title, "Nope")
  assert.equal(r.gif.file, "/l/big.gif")
  assert.deepEqual(r.removeFiles, ["/l/a1.gif", "/l/a1.png"])

  // Same picture, smaller: rejected as a duplicate, its files removed.
  r = Gifs.importGif([tagged1], meta({ id: "dup", width: 400, height: 250, file: "/l/d.gif", thumb: "/l/d.png" }), 8)
  assert.equal(r.status, "duplicate")
  assert.deepEqual(r.removeFiles, ["/l/d.gif", "/l/d.png"])

  // The very same file: nothing to remove, it is the stored file.
  r = Gifs.importGif([tagged1], meta(), 9)
  assert.equal(r.status, "duplicate")
  assert.deepEqual(r.removeFiles, [])

  // A different picture is a new entry.
  assert.equal(Gifs.importGif([tagged1], meta({ id: "m", phash: "f0e6c6868ececee4" }), 9).status, "added")
})

test("dHash distance counts differing bits", () => {
  assert.equal(Gifs.distance("db99999999994ddb", "db99999999994ddb"), 0)
  assert.equal(Gifs.distance("db99999999994ddb", "db99999999994dda"), 1)
  assert.equal(Gifs.distance("0000000000000000", "ffffffffffffffff"), 64)
  assert.equal(Gifs.distance("bad", "0000000000000000"), 64)
})

test("the edit field is a title then comma-separated tags; a title and two tags reach the Library", () => {
  assert.deepEqual(Gifs.parseEdit(" Office  Nope , nope, No Thanks,nope, "), { title: "Office Nope", tags: ["nope", "no thanks"] })
  assert.equal(Gifs.editValue({ title: "Nope", tags: ["nope", "no"] }), "Nope, nope, no")
  assert.match(Gifs.editHint(""), /title/)
  assert.match(Gifs.editHint("Nope, nope"), /1 more tag/)
  assert.match(Gifs.editHint("Nope, nope, no"), /separated by commas/)
  assert.equal(Gifs.inLibrary({ title: "Nope", tags: ["nope"] }), false)
  assert.equal(Gifs.inLibrary({ title: "Nope", tags: ["nope", "no"] }), true)
})

test("search only finds Library GIFs, by title or tag, with flea hits or the JS fallback", () => {
  const list = [
    tagged("inbox", "Nope draft", []),
    tagged("nope", "Office Nope", ["nope", "no thanks"]),
    tagged("yes", "Thumbs Up", ["yes", "approve"])
  ]
  const state = { pinned: [], recent: [], items: {}, filter: "all", nowMs: 0 }
  assert.deepEqual(ids(Gifs.sections(list, "nope", state)), ["gif:nope"])
  assert.deepEqual(ids(Gifs.sections(list, "thanks", state)), ["gif:nope"])
  assert.deepEqual(ids(Gifs.sections(list, "appr", state)), ["gif:yes"])
  assert.deepEqual(Gifs.sections(list, "zzz", state), [])
  // Flea hits decide the match; recency breaks ties.
  const flea = { yes: { title: 100 }, nope: { title: 100 } }
  assert.deepEqual(ids(Gifs.sections(list, "o", Object.assign({}, state, { fleaHits: flea, recent: ["yes"] }))), ["gif:yes", "gif:nope"])
  // The Inbox filter searches the Inbox.
  assert.deepEqual(ids(Gifs.sections(list, "draft", Object.assign({}, state, { filter: "inbox" }))), ["gif:inbox"])
  assert.deepEqual(Gifs.searchEntries(list.filter(Gifs.inLibrary))[0], { title: "Office Nope", keywords: ["nope", "no thanks"] })
})

test("browsing shows Inbox, Pinned, Recently Used and Library; Unused lists stale GIFs oldest first", () => {
  const day = 86400000
  const list = [
    tagged("new", "New", ["a", "b"], { addedAt: 100 * day }),
    tagged("old", "Old", ["a", "b"], { addedAt: 1 * day }),
    tagged("older", "Older", ["a", "b"], { addedAt: 0 }),
    tagged("todo", "", [])
  ]
  const state = { pinned: ["old"], recent: ["new", "old"], items: { new: { openedAt: 100 * 86400 } }, filter: "all", nowMs: 120 * day }
  const s = Gifs.sections(list, "", state)
  assert.deepEqual(s.map((x) => x.id), ["inbox", "pinned", "recent", "library"])
  assert.deepEqual(s[2].rows.map((r) => r.id), ["gif:new"])
  assert.equal(s[0].rows[0].inbox, true)
  const unused = Gifs.sections(list, "", Object.assign({}, state, { filter: "unused" }))
  assert.deepEqual(ids(unused), ["gif:older", "gif:old"])
})

test("Inbox GIFs open the editor; Library GIFs paste", () => {
  const inbox = Gifs.candidate(tagged("t", "", []), [])
  const lib = Gifs.candidate(tagged("n", "Nope", ["a", "b"]), [])
  assert.equal(Gifs.actionsFor(inbox, {})[0].id, "edit")
  assert.equal(Gifs.actionsFor(lib, {})[0].id, "paste")
  assert.ok(Gifs.actionsFor(lib, { source: "https://x" }).some((a) => a.id === "copy-source"))
})

test("names the pasted file after the title", () => {
  assert.equal(Gifs.fileName({ title: "Achoo! Bless you" }), "achoo-bless-you")
  assert.equal(Gifs.fileName({ title: "日本" }), "gif")
  assert.equal(Gifs.fileName({ title: "../x" }), "x")
  assert.equal(Gifs.fileName({ title: "a".repeat(59) + " b" }), "a".repeat(59))
})

test("a copied X post link is recognised, other links are not", () => {
  assert.ok(Gifs.isXPost("https://x.com/i/status/2120350754926129386"))
  assert.ok(Gifs.isXPost(" https://twitter.com/some_user/status/123?s=20\n"))
  assert.ok(Gifs.isXPost("https://mobile.x.com/a/status/1/photo/1"))
  assert.ok(!Gifs.isXPost("http://x.com/i/status/1"))
  assert.ok(!Gifs.isXPost("https://x.com/home"))
  assert.ok(!Gifs.isXPost("https://evilx.com/a/status/1"))
  assert.ok(!Gifs.isXPost("look https://x.com/a/status/1"))
})

test("automatic imports report GIFs but stay quiet about posts and files without one", () => {
  assert.equal(Gifs.quietOutcome({ status: "rejected", reasons: ["No GIF in this post"] }), null)
  assert.equal(Gifs.quietOutcome({ status: "rejected", reasons: ["Not a GIF"] }), null)
  assert.equal(Gifs.quietOutcome({ status: "added" }).status, "added")
  assert.equal(Gifs.quietOutcome({ status: "duplicate" }).status, "duplicate")
  assert.equal(Gifs.quietOutcome({ status: "rejected", reasons: ["Too large: 9.0 MB, the limit is 8.0 MB"] }).status, "rejected")
})
