const test = require("node:test")
const assert = require("node:assert/strict")
const Q = require("../plugin/core/Quicklinks.js")
const Migrate = require("../plugin/core/Migrate.js")
const Schema = require("../plugin/core/Schema.js")

const NOW = new Date(2026, 9, 20, 9, 5, 7).getTime()   // Tue 20 Oct 2026 09:05:07, local time
const apps = Q.installedApps([
  { id: "firefox", name: "Firefox", icon: "firefox" },
  { id: "chromium.desktop", name: "Chromium", icon: "chromium" },
  { id: "org.gnome.Nautilus", name: "Files", icon: "nautilus" }
])
const ctx = { apps, now: NOW }

function saved(input) {
  const r = Q.save({ items: [] }, input, ctx)
  assert.equal(r.error, "")
  return r
}

function expand(link, values, extra) {
  const parsed = Q.parseLink(link)
  assert.equal(parsed.error, "", parsed.error)
  const args = Q.argumentValues(parsed, values || {})
  assert.equal(args.error, "", args.error)
  return Q.expand(link, Object.assign({ now: NOW, values: args.values }, extra || {}))
}

test("a new quicklinks document migrates to an empty library", () => {
  const r = Migrate.migrate(null, Schema.documents.quicklinks.migrations, 1)
  assert.deepEqual(r.doc.items, [])
})

test("save, update and remove keep names unique ignoring case", () => {
  const first = saved({ name: " GitHub ", link: "github.com" })
  assert.equal(first.item.name, "GitHub")
  assert.match(Q.save(first.doc, { name: "github", link: "x.com" }, ctx).error, /already exists/)
  const second = Q.save(first.doc, { name: "Docs", link: "https://docs.example.com" }, { apps, now: NOW + 1 })
  assert.match(Q.update(second.doc, second.item.id, { name: "GITHUB", link: "y.com" }, ctx).error, /already exists/)
  const renamed = Q.update(second.doc, first.item.id, { name: "GitHub Home", link: "github.com" }, { apps, now: NOW + 2 })
  assert.equal(renamed.item.createdAt, NOW)
  assert.equal(renamed.item.updatedAt, NOW + 2)
  assert.deepEqual(Q.list(Q.remove(renamed.doc, first.item.id).doc).map((i) => i.name), ["Docs"])
})

test("save refuses empty fields, javascript:, a leading dash and bad placeholders", () => {
  assert.match(Q.save({}, { name: "", link: "x.com" }, ctx).error, /name/)
  assert.match(Q.save({}, { name: "a", link: " " }, ctx).error, /link/)
  assert.match(Q.save({}, { name: "a", link: "javascript:alert(1)" }, ctx).error, /javascript/)
  assert.match(Q.save({}, { name: "a", link: "--help" }, ctx).error, /cannot start with -/)
  assert.match(Q.save({}, { name: "a", link: "https://x.com/{browser-tab.url}" }, ctx).error, /cannot use \{browser-tab.url\}/)
  assert.match(Q.save({}, { name: "a", link: "https://x.com/{cursor}" }, ctx).error, /cannot use/)
  assert.match(Q.save({}, { name: "a", link: "https://x.com/{clipboard offset=1}" }, ctx).error, /clipboard history/)
  assert.match(Q.save({}, { name: "a", link: "https://x.com/{a}{b}{c}{d}" }, ctx).error, /at most 3/)
  assert.match(Q.save({}, { name: "a", link: "https://x.com/{argument | shout}" }, ctx).error, /Unknown modifier/)
})

test("Open With takes an installed desktop id, and keeps a saved one that is gone", () => {
  assert.equal(saved({ name: "a", link: "x.com", openWith: "FIREFOX.desktop" }).item.openWith, "firefox.desktop")
  assert.match(Q.save({}, { name: "a", link: "x.com", openWith: "vlc.desktop" }, ctx).error, /not installed/)
  assert.match(Q.save({}, { name: "a", link: "x.com", openWith: "rm -rf" }, ctx).error, /desktop id/)
  // Before the app catalog loads, any well-formed id is accepted.
  assert.equal(Q.save({}, { name: "a", link: "x.com", openWith: "vlc.desktop" }, { apps: [], now: NOW }).error, "")
  const old = Q.save({}, { name: "a", link: "x.com", openWith: "vlc.desktop" }, { apps: [], now: NOW })
  assert.equal(Q.update(old.doc, old.item.id, { name: "b", link: "x.com", openWith: "vlc.desktop" }, ctx).error, "")
  assert.equal(Q.openWithLabel(apps, "vlc.desktop"), "vlc.desktop (not installed)")
  assert.equal(Q.openWithLabel(apps, ""), "Default")
  assert.deepEqual(Q.openWithChoices(apps, "", "vlc.desktop").map((r) => r.title), ["Default", "vlc.desktop (not installed)", "Chromium", "Files", "Firefox"])
  assert.deepEqual(Q.openWithChoices(apps, "fire", "").map((r) => r.id), ["firefox.desktop"])
})

test("import reads Raycast's export, skips duplicates and reports bad rows", () => {
  const start = saved({ name: "GitHub", link: "github.com" }).doc
  const text = JSON.stringify([
    { name: "GitHub", link: "github.com" },
    { name: "Maps", link: "https://maps.google.com/?q={query}", openWith: "com.google.Chrome" },
    { name: "Files", link: "~/Notes", openWith: "org.gnome.Nautilus.desktop" },
    { name: "Broken", link: "" },
    "nope"
  ])
  const r = Q.importText(start, text, ctx)
  assert.equal(r.added, 2)
  assert.equal(r.duplicates, 1)
  assert.equal(r.withoutApp, 1)
  assert.deepEqual(r.failed, ["Broken", "row 5"])
  assert.deepEqual(Q.exportList(r.doc), [
    { name: "GitHub", link: "github.com" },
    { name: "Maps", link: "https://maps.google.com/?q={query}" },
    { name: "Files", link: "~/Notes", openWith: "org.gnome.Nautilus.desktop" }
  ])
  assert.match(Q.importText(start, "{", ctx).error, /valid JSON/)
  assert.match(Q.importText(start, "{}", ctx).error, /array/)
})

test("arguments merge by name, take defaults, and match options", () => {
  const link = "https://x.com/{argument name=lang options=\"English: en, French: fr\"}/{argument name=\"search term\" default=\"hello world\"}/{lang}"
  const parsed = Q.parseLink(link)
  assert.deepEqual(parsed.arguments.map((a) => a.name), ["lang", "search term"])
  assert.match(Q.argumentValues(parsed, {}).error, /lang is required/)
  assert.match(Q.argumentValues(parsed, { lang: "de" }).error, /not one of English, French/)
  assert.equal(expand(link, { lang: "french" }).url, "https://x.com/fr/hello%20world/fr")
})

test("values are percent-encoded in URLs, raw on request, and raw in file paths", () => {
  assert.equal(expand("https://x.com/?q={query}", { query: "a&b c" }).url, "https://x.com/?q=a%26b%20c")
  assert.equal(expand("https://x.com/{path | raw}", { path: "a/b" }).url, "https://x.com/a/b")
  assert.equal(expand("~/Notes/{argument}", { argument: "todo list.md" }).url, "~/Notes/todo list.md")
  assert.equal(expand("{q | uppercase}.com", { q: "Hi" }).url, "HI.com")
  assert.equal(expand("https://x.com/{q:fallback}").url, "https://x.com/fallback")
  assert.equal(expand("https://x.com/{\"literal").url, "https://x.com/{\"literal")
})

test("an expansion that leaves nothing or a leading dash is refused with its reason", () => {
  assert.match(expand("{clipboard}", {}, { clipboard: "" }).error, /empty after/)
  assert.match(expand("{clipboard | raw}", {}, { clipboard: "-rf" }).error, /cannot start with -/)
  assert.equal(expand("https://x.com/?q={selection}", {}, { selection: "hi" }).url, "https://x.com/?q=hi")
  assert.equal(Q.parseLink("{selection}{clipboard}").needsSelection, true)
})

test("dates use ICU patterns, offsets and localized names", () => {
  assert.equal(expand("{date}").url, "20%20Oct%202026")
  assert.equal(expand("{time | raw}").url, "09:05")
  assert.equal(expand("{date format=\"EEE, d MMMM yy\" | raw}").url, "Tue, 20 October 26")
  assert.equal(expand("{date format=\"EEEE 'at' h a\" | raw}").url, "Tuesday at 9 AM")
  assert.equal(expand("{date \"yyyy-MM-dd\" +1D | raw}").url, "2026-10-21")
  assert.equal(expand("{date format=\"yyyy-MM-dd HH:mm\" offset=\"-1M +2h -5m\" | raw}").url, "2026-09-20 11:00")
  assert.equal(expand("{day | raw}").url, "Tuesday")
  const names = (locale) => ({ month: () => locale + "-month", day: () => locale + "-day" })
  assert.equal(expand("{date format=\"EEEE MMMM\" locale=fr | raw}", {}, { names }).url, "fr-day fr-month")
  assert.match(Q.parseLink("{date +1w}").error, /Bad date offset/)
})

test("web addresses: real hosts are detected, abbreviations and files are not", () => {
  assert.equal(Q.webAddress("github.com/x"), "https://github.com/x")
  assert.equal(Q.webAddress("localhost:3000"), "http://localhost:3000")
  assert.equal(Q.webAddress("1.2.3.4"), "https://1.2.3.4")
  assert.equal(Q.webAddress("bbc.co.uk"), "https://bbc.co.uk")
  assert.equal(Q.webAddress("https://example.museum"), "https://example.museum")
  assert.equal(Q.webAddress("spotify://track/1"), "spotify://track/1")
  for (const q of ["e.g", "a.m", "vs.code", "node.js", "notes.md", "github", "1.2.3.999", "two words.com", "x.com:99999", "goo​gle.com"]) {
    assert.equal(Q.webAddress(q), "", q)
  }
})

test("web links and bare hosts open in the browser, others with xdg-open or the chosen app", () => {
  assert.deepEqual(Q.openArgv("github.com", "", "/home/u"), ["omarchy-launch-browser", "https://github.com"])
  assert.deepEqual(Q.openArgv("https://github.com", "", "/home/u"), ["omarchy-launch-browser", "https://github.com"])
  assert.deepEqual(Q.openArgv("~/Notes/a b.md", "", "/home/u"), ["xdg-open", "/home/u/Notes/a b.md"])
  assert.deepEqual(Q.openArgv("mailto:a@b.co", "", "/home/u"), ["xdg-open", "mailto:a@b.co"])
  assert.deepEqual(Q.openArgv("github.com", "chromium.desktop", "/home/u"), ["uwsm-app", "--", "gtk-launch", "chromium.desktop", "https://github.com"])
  assert.equal(Q.openArgv("-x", "", "/home/u"), null)
  assert.equal(Q.openArgv("x.com", "bad id", "/home/u"), null)
})

test("a quicklink becomes a root-search candidate", () => {
  const c = Q.toCandidate(saved({ name: "GitHub", link: "github.com" }).item)
  assert.equal(c.type, "quicklink")
  assert.equal(c.title, "GitHub")
  assert.match(c.id, /^quicklink:ql-/)
  assert.deepEqual(c.arguments, [])
  const withArgs = Q.toCandidate(saved({ name: "DDG", link: "https://duckduckgo.com/?q={query}&kl={argument name=region default=wt-wt}" }).item)
  assert.deepEqual(withArgs.arguments.map((a) => [a.name, a.defaultValue]), [["query", ""], ["region", "wt-wt"]])
})

test("local addresses open as http, javascript:// is not an address, keywords ignore case", () => {
  assert.equal(Q.webAddress("127.0.0.1:3000"), "http://127.0.0.1:3000")
  assert.equal(Q.webAddress("192.168.1.1"), "http://192.168.1.1")
  assert.equal(Q.webAddress("172.20.0.5/admin"), "http://172.20.0.5/admin")
  assert.equal(Q.webAddress("8.8.8.8"), "https://8.8.8.8")
  assert.equal(Q.webAddress("10.tv"), "https://10.tv")
  assert.equal(Q.webAddress("127.example.com"), "https://127.example.com")
  assert.equal(Q.webAddress("javascript://x"), "")
  assert.equal(Q.parseLink("https://x.com/{UUID}").arguments.length, 0)
})

test("Create Quicklink suggests a name and link from a URL or path, nothing else", () => {
  assert.deepEqual(Q.suggestion("https://www.github.com/x?y=1"), { name: "github.com", link: "https://www.github.com/x?y=1" })
  assert.deepEqual(Q.suggestion(" github.com "), { name: "github.com", link: "https://github.com" })
  assert.deepEqual(Q.suggestion("~/Notes/a b.md"), { name: "a b.md", link: "~/Notes/a b.md" })
  assert.deepEqual(Q.suggestion("mailto:a@b.co"), { name: "a@b.co", link: "mailto:a@b.co" })
  for (const t of ["", "hello world", "e.g", "javascript:alert(1)", "two\nlines.com"]) assert.equal(Q.suggestion(t), null, t)
})

test("quicklink arguments use the argument-pill shape", () => {
  const RS = require("../plugin/core/RootSearch.js")
  const c = Q.toCandidate({ id: "a", name: "Repo", link: "https://github.com/{argument name=owner}/{argument name=repo default=oma-cast}?tab={argument name=tab options=\"Code,Issues\"}" })
  assert.deepEqual(c.arguments.map((a) => [a.name, a.required, a.placeholder]), [["owner", true, "owner"], ["repo", false, "oma-cast"], ["tab", true, "tab ▾"]])
  assert.equal(RS.missingArgument(c.arguments, { repo: "x" }), 0)
  assert.equal(RS.missingArgument(c.arguments, { owner: "basecamp" }), 2)
  assert.equal(RS.missingArgument(c.arguments, { owner: "basecamp", tab: "Issues" }), -1)
})
