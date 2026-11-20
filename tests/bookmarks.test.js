const test = require("node:test")
const assert = require("node:assert/strict")
const Bookmarks = require("../core/Bookmarks.js")
const RootSearch = require("../core/RootSearch.js")
const Ranker = require("../core/Ranker.js")
const Frecency = require("../core/Frecency.js")

const sampleJson = JSON.stringify({
  checksum: "abc123",
  roots: {
    bookmark_bar: {
      type: "folder",
      name: "Bookmarks bar",
      children: [
        {
          type: "url",
          name: "GitHub",
          url: "https://github.com/"
        },
        {
          type: "folder",
          name: "Development",
          children: [
            {
              type: "url",
              name: "LeetCode",
              url: "https://leetcode.com/u/wsjishan/"
            },
            {
              type: "url",
              name: "YouTube Music",
              url: "https://music.youtube.com/"
            }
          ]
        }
      ]
    },
    other: {
      type: "folder",
      name: "Other bookmarks",
      children: [
        {
          type: "url",
          name: "Grok",
          url: "https://grok.com/"
        }
      ]
    }
  },
  version: 1
})

test("cleanUrl removes protocol, www, and trailing slashes", () => {
  assert.equal(Bookmarks.cleanUrl("https://www.youtube.com/"), "youtube.com")
  assert.equal(Bookmarks.cleanUrl("http://github.com/wahidsadik/"), "github.com/wahidsadik")
  assert.equal(Bookmarks.cleanUrl("https://leetcode.com"), "leetcode.com")
})

test("extractDomain extracts domain names from various URLs", () => {
  assert.equal(Bookmarks.extractDomain("https://www.youtube.com/"), "youtube")
  assert.equal(Bookmarks.extractDomain("https://music.youtube.com/"), "youtube")
  assert.equal(Bookmarks.extractDomain("https://github.com/foo/bar"), "github")
  assert.equal(Bookmarks.extractDomain("https://sub.domain.co.uk/"), "domain")
  assert.equal(Bookmarks.extractDomain(""), "")
})

test("parseBookmarks parses nested Chromium bookmark JSON", () => {
  const items = Bookmarks.parseBookmarks(sampleJson, "Brave")
  assert.equal(items.length, 4)
  assert.equal(items[0].title, "GitHub")
  assert.equal(items[0].url, "https://github.com/")
  assert.equal(items[1].title, "LeetCode")
  assert.equal(items[1].folder, "Bookmarks bar › Development")
  assert.equal(items[1].browser, "Brave")
})

test("parseBookmarks handles invalid and empty JSON safely", () => {
  assert.deepEqual(Bookmarks.parseBookmarks("", "Brave"), [])
  assert.deepEqual(Bookmarks.parseBookmarks("invalid json", "Brave"), [])
  assert.deepEqual(Bookmarks.parseBookmarks("{}", "Brave"), [])
})

test("candidates creates properly formatted search candidates with deduplication", () => {
  const duplicatedJson = JSON.stringify({
    roots: {
      bar: {
        children: [
          { type: "url", name: "GitHub 1", url: "https://github.com/" },
          { type: "url", name: "GitHub 2", url: "https://github.com/" }
        ]
      }
    }
  })
  const candidates = Bookmarks.candidates(duplicatedJson, "Brave")
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].id, "bookmark:https://github.com/")
  assert.equal(candidates[0].type, "quicklink")
  assert.equal(candidates[0].kind, "bookmark")
  assert.equal(candidates[0].typeLabel, "Bookmark")
  assert.equal(candidates[0].glyph, "\uf02e")
  assert.ok(candidates[0].alternateTitles.includes("github"))
  assert.equal(candidates[0].keywords.length, 0)
})

test("knownPaths returns paths for major Linux browsers", () => {
  const paths = Bookmarks.knownPaths("/home/user/.config")
  assert.ok(paths.some((p) => p.browser === "Brave" && p.path.includes("Brave-Browser")))
  assert.ok(paths.some((p) => p.browser === "Chrome" && p.path.includes("google-chrome")))
  assert.ok(paths.some((p) => p.browser === "Chromium" && p.path.includes("chromium")))
})

test("rootSections isolates bookmarks to 'b ' prefix only", () => {
  const bookmarks = Bookmarks.candidates(sampleJson, "Brave")
  const deps = { Ranker, Frecency }
  const ctx = { nowMs: 1_800_000_000_000, commands: {}, frecency: {} }

  // Normal query without "b " prefix must NEVER return bookmarks
  const normalSections = RootSearch.rootSections(bookmarks, "git", ctx, deps)
  const hasBookmark = normalSections.some((s) => s.rows && s.rows.some((r) => r.candidate && r.candidate.kind === "bookmark"))
  assert.equal(hasBookmark, false)

  // Query "b " shows all bookmarks in dedicated section
  const emptySections = RootSearch.rootSections(bookmarks, "b ", ctx, deps)
  assert.equal(emptySections.length, 1)
  assert.equal(emptySections[0].id, "bookmarks")
  assert.equal(emptySections[0].title, "Browser Bookmarks")
  assert.equal(emptySections[0].rows.length, 4)

  // Query "b leet" filters and ranks bookmarks
  const leetSections = RootSearch.rootSections(bookmarks, "b leet", ctx, deps)
  assert.equal(leetSections.length, 2) // bookmarks + fallback
  assert.equal(leetSections[0].id, "bookmarks")
  assert.ok(leetSections[0].title.includes("leet"))
  assert.equal(leetSections[0].rows[0].candidate.title, "LeetCode")

  // Query "B git" case insensitive prefix
  const gitSections = RootSearch.rootSections(bookmarks, "B git", ctx, deps)
  assert.equal(gitSections[0].rows[0].candidate.title, "GitHub")

  // Bookmarks supplied via ctx.bookmarks (when candidates list does not have bookmarks)
  const ctxWithBookmarks = Object.assign({}, ctx, { bookmarks: bookmarks })
  const separatedSections = RootSearch.rootSections([], "b leet", ctxWithBookmarks, deps)
  assert.equal(separatedSections[0].id, "bookmarks")
  assert.equal(separatedSections[0].rows[0].candidate.title, "LeetCode")
})

test("actionsFor offers Open in Browser and Copy URL for bookmarks", () => {
  const candidate = Bookmarks.candidate({ title: "GitHub", url: "https://github.com/" })
  const actions = RootSearch.actionsFor(candidate)
  assert.equal(actions[0].id, "open")
  assert.equal(actions[0].title, "Open in Browser")
  assert.ok(actions.some((a) => a.id === "copy-url" && a.shortcut === "Ctrl Shift C"))
})
