const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync, spawnSync } = require("node:child_process")
const SC = require("../plugin/core/ScriptCommands.js")

function file(lines, p, shebang) {
  return { path: p || "/home/u/.config/oma-cast/script-commands/hello.sh", shebang: shebang || "#!/bin/bash", lines }
}

const BASIC = [
  "# @raycast.schemaVersion 1",
  "# @raycast.title Say Hello",
  "# @raycast.mode compact"
]

test("parses the required keys and defaults the package name to the folder", () => {
  const r = SC.parse(file(BASIC))
  assert.equal(r.ok, true)
  assert.equal(r.script.id, "script:/home/u/.config/oma-cast/script-commands/hello.sh")
  assert.equal(r.script.title, "Say Hello")
  assert.equal(r.script.mode, "compact")
  assert.equal(r.script.packageName, "Script Commands")
  assert.equal(r.script.cwd, "/home/u/.config/oma-cast/script-commands")
  assert.equal(r.script.interpreter, "bash")
  assert.deepEqual(r.script.arguments, [])
})

test("accepts every comment style and case-insensitive keys", () => {
  const r = SC.parse(file([
    "// @raycast.schemaVersion 1",
    "REM @raycast.TITLE Rem Title",
    ":: @Raycast.Mode full-output",
    "  # @raycast.packagename Tools"
  ]))
  assert.equal(r.ok, true)
  assert.equal(r.script.title, "Rem Title")
  assert.equal(r.script.mode, "fullOutput")
  assert.equal(r.script.packageName, "Tools")
})

test("rejects a missing or wrong schemaVersion, title or mode", () => {
  assert.match(SC.parse(file(BASIC.slice(1))).error, /schemaVersion/)
  assert.match(SC.parse(file(["# @raycast.schemaVersion 2"].concat(BASIC.slice(1)))).error, /must be 1/)
  assert.match(SC.parse(file([BASIC[0], BASIC[2]])).error, /title/)
  assert.match(SC.parse(file(BASIC.slice(0, 2))).error, /mode/)
  assert.match(SC.parse(file(BASIC.slice(0, 2).concat(["# @raycast.mode loud"]))).error, /Unknown/)
})

test("inline needs a refreshTime of at least 10 s, else it is compact", () => {
  const head = BASIC.slice(0, 2).concat(["# @raycast.mode inline"])
  assert.equal(SC.parse(file(head)).script.mode, "compact")
  const fast = SC.parse(file(head.concat(["# @raycast.refreshTime 3s", "# @raycast.argument1 {\"placeholder\":\"x\"}"]))).script
  assert.equal(fast.mode, "inline")
  assert.equal(fast.refreshSeconds, 10)
  assert.deepEqual(fast.arguments, [], "arguments are ignored for inline")
  assert.equal(SC.refreshSeconds("5m"), 300)
  assert.equal(SC.refreshSeconds("1d"), 86400)
  assert.equal(SC.refreshSeconds("10 minutes"), 0)
})

test("parses text, password and dropdown arguments", () => {
  const r = SC.parse(file(BASIC.concat([
    '# @raycast.argument1 { "type": "text", "placeholder": "Query", "percentEncoded": true }',
    '# @raycast.argument3 { "type": "dropdown", "placeholder": "Size", "optional": true, "data": [{"title":"Small","value":"s"},{"title":"Large","value":"l"}] }',
    '# @raycast.argument2 { "type": "password", "placeholder": "Token" }'
  ])))
  assert.equal(r.ok, true)
  const [q, token, size] = r.script.arguments
  assert.deepEqual([q.name, q.required, q.percentEncoded, q.secure], ["argument1", true, true, false])
  assert.deepEqual([token.name, token.secure], ["argument2", true])
  assert.deepEqual([size.name, size.required, size.options], ["argument3", false, [{ title: "Small", value: "s" }, { title: "Large", value: "l" }]])
  assert.match(SC.parse(file(BASIC.concat(["# @raycast.argument1 {nope"]))).error, /not valid JSON/)
  assert.match(SC.parse(file(BASIC.concat(['# @raycast.argument1 {"type":"dropdown","placeholder":"x"}']))).error, /data/)
})

test("argument values become positional, encoded and validated", () => {
  const defs = SC.parse(file(BASIC.concat([
    '# @raycast.argument1 { "placeholder": "Query", "percentEncoded": true }',
    '# @raycast.argument3 { "type": "dropdown", "placeholder": "Size", "data": [{"title":"Small","value":"s"}] }'
  ]))).script.arguments
  assert.deepEqual(SC.argumentValues(defs, { argument1: "a b", argument3: "small" }), ["a%20b", "", "s"])
  assert.throws(() => SC.argumentValues(defs, { argument3: "s" }), /Type a query first/)
  assert.throws(() => SC.argumentValues(defs, { argument1: "x", argument3: "huge" }), /Size must be one of Small/)
})

test("needsConfirmation, currentDirectoryPath and icons", () => {
  const s = SC.parse(file(BASIC.concat([
    "# @raycast.needsConfirmation true",
    "# @raycast.currentDirectoryPath ../projects",
    "# @raycast.icon images/logo.png"
  ]))).script
  assert.equal(s.needsConfirmation, true)
  assert.equal(s.cwd, "/home/u/.config/oma-cast/projects")
  assert.deepEqual(s.icon, { glyph: "", path: "/home/u/.config/oma-cast/script-commands/images/logo.png" })
  assert.deepEqual(SC.iconFor("🤖", "/x"), { glyph: "🤖", path: "" })
  assert.equal(SC.iconFor("https://example.com/i.png", "/x").path, "", "icon URLs are not fetched")
})

test("shebang interpreters", () => {
  assert.equal(SC.interpreter("#!/usr/bin/env python3"), "python3")
  assert.equal(SC.interpreter("#!/usr/bin/env -S node --no-warnings"), "node --no-warnings")
  assert.equal(SC.interpreter("#!/bin/zsh -f"), "zsh -f")
  assert.equal(SC.interpreter(""), "")
})

test("candidates show the package, or the inline output", () => {
  const s = SC.parse(file(BASIC.concat(["# @raycast.packageName Dev"]))).script
  const c = SC.candidate(s, null)
  assert.equal(c.kind, "script")
  assert.equal(c.subtitle, "Dev")
  assert.equal(c.typeLabel, "Script Command")
  const inline = SC.parse(file(["# @raycast.schemaVersion 1", "# @raycast.title VPN", "# @raycast.mode inline", "# @raycast.refreshTime 1m"])).script
  assert.equal(SC.candidate(inline, { text: "Connected" }).subtitle, "Connected")
  assert.equal(SC.candidate(inline, { error: "boom" }).subtitle, "⚠ Error: boom")
})

test("directories: default first, ~ expanded, relative and duplicate ones dropped", () => {
  assert.deepEqual(
    SC.directories("/home/u/.config/oma-cast/script-commands", ["~/bin/raycast", "relative", "/home/u/.config/oma-cast/script-commands/", "/opt/s/../scripts"], "/home/u"),
    ["/home/u/.config/oma-cast/script-commands", "/home/u/bin/raycast", "/opt/scripts"])
})

test("output: ANSI stripped, last line for compact, first line for inline", () => {
  assert.equal(SC.stripAnsi("\x1b[31mred\x1b[0m \x1b]0;title\x07ok"), "red ok")
  assert.equal(SC.stripAnsi("10%\r50%\r100%"), "100%")
  assert.equal(SC.lastLine("one\ntwo\n\n  \n"), "two")
  assert.deepEqual(SC.outcome("compact", 0, false, "a\nb\n"), { ok: true, message: "b" })
  assert.deepEqual(SC.outcome("inline", 0, false, "first\nsecond"), { ok: true, message: "first" })
  assert.deepEqual(SC.outcome("compact", 2, false, ""), { ok: false, message: "Exited with code 2" })
  assert.deepEqual(SC.outcome("silent", 0, true, ""), { ok: false, message: "The script was stopped" })
})

test("template parses back as the script it describes", () => {
  const text = SC.template('Say "Hi" $now', "inline")
  const r = SC.parse({ path: "/s/" + SC.slug('Say "Hi" $now') + ".sh", shebang: text.split("\n")[0], lines: text.split("\n") })
  assert.equal(r.ok, true)
  assert.equal(r.script.file, "say-hi-now.sh")
  assert.equal(r.script.title, 'Say "Hi" $now')
  assert.equal(r.script.mode, "inline")
  assert.throws(() => SC.template("  ", "compact"), /title/)
})

// The bash pieces, run for real against a temp directory.
test("scan, run and create scripts on disk", { skip: spawnSync("bash", ["-c", "true"]).status !== 0 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oma-cast-scripts-"))
  try {
    const write = (name, text, mode) => fs.writeFileSync(path.join(dir, name), text, { mode: mode === undefined ? 0o755 : mode })
    write("hello.sh", "#!/bin/bash\n# @raycast.schemaVersion 1\n# @raycast.title Hello\n# @raycast.mode compact\necho \"$1|$2|$PWD\"\n")
    write("plain.sh", "#!/bin/bash\necho no header\n")
    write("noexec.sh", "#!/bin/bash\n# @raycast.schemaVersion 1\n", 0o644)
    write("x.template.sh", "#!/bin/bash\n# @raycast.schemaVersion 1\n")
    write("broken.py", "#!/usr/bin/env python3\n# @raycast.schemaVersion 1\n# @raycast.title Broken\n")
    fs.mkdirSync(path.join(dir, "images"))

    const out = execFileSync("bash", ["-c", SC.SCAN_SCRIPT, "scan", dir, path.join(dir, "missing")], { encoding: "utf8" })
    const loaded = SC.load(SC.parseScan(out))
    assert.deepEqual(loaded.scripts.map((s) => s.file), ["hello.sh"])
    assert.deepEqual(loaded.errors.map((e) => [e.file, e.error]), [["broken.py", "Missing @raycast.mode"]])
    assert.equal(loaded.errors[0].id, "script-error:" + path.join(dir, "broken.py"))

    const argv = SC.runArgv(loaded.scripts[0], ["a b", "$(id)"])
    const ran = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" })
    assert.equal(ran.status, 0)
    assert.equal(ran.stdout.trim().split("\n").pop(), "a b|$(id)|" + dir)

    const target = path.join(dir, "new", "say-hi.sh")
    const create = () => spawnSync("bash", ["-c", SC.CREATE_SCRIPT, "create", path.dirname(target), target, SC.template("Say Hi", "silent")], { encoding: "utf8" })
    assert.equal(create().status, 0)
    assert.equal(fs.statSync(target).mode & 0o111, 0o111)
    const again = create()
    assert.equal(again.status, 3)
    assert.match(again.stdout, /say-hi.sh already exists/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const Ranker = require("../plugin/core/Ranker.js")
const Frecency = require("../plugin/core/Frecency.js")
const OmarchyMenu = require("../plugin/core/OmarchyMenu.js")
const RS = require("../plugin/core/RootSearch.js")

function scriptCandidate(title, pkg, extra) {
  const lines = ["# @raycast.schemaVersion 1", "# @raycast.title " + title, "# @raycast.mode compact", "# @raycast.packageName " + pkg].concat(extra || [])
  return SC.candidate(SC.parse(file(lines, "/s/" + SC.slug(title) + ".sh")).script, null)
}

test("Search Script Commands groups by package, ranks a query and lists invalid files", () => {
  const deps = { Ranker, Frecency, OmarchyMenu }
  const ctx = { commands: {}, frecency: {}, nowMs: Date.UTC(2026, 9, 25), sensitivity: "medium" }
  const candidates = [scriptCandidate("Deploy", "Work"), scriptCandidate("Brew Coffee", "Home"), scriptCandidate("Backup", "Home")]
    .concat(RS.BUILTINS.map(RS.builtinCandidate))
  const errors = [SC.errorCandidate({ id: "script-error:/s/bad.sh", path: "/s/bad.sh", file: "bad.sh", error: "Missing @raycast.mode" })]
  const empty = RS.scriptSections(candidates, errors, "", ctx, deps)
  assert.deepEqual(empty.map((s) => [s.title, s.rows.map((r) => r.candidate.title)]),
    [["Home", ["Brew Coffee", "Backup"]], ["Work", ["Deploy"]], ["Invalid Scripts", ["bad.sh"]]])
  const searched = RS.scriptSections(candidates, errors, "dep", ctx, deps)
  assert.deepEqual(searched.map((s) => s.title), ["Results"])
  assert.equal(searched[0].rows[0].candidate.title, "Deploy")
  ctx.commands = { [candidates[0].id]: { enabled: false } }
  assert.equal(RS.scriptSections(candidates, [], "dep", ctx, deps).length, 0, "disabled scripts stay hidden")
})

test("script actions: run, edit, copy path; output and invalid-file actions", () => {
  const ids = (list) => list.map((a) => a.id)
  const c = Object.assign(scriptCandidate("Deploy", "Work"), { favoriteOrder: null, frecency: 1, alias: "" })
  assert.deepEqual(ids(RS.actionsFor(c)).slice(0, 3), ["open", "edit-script", "copy-path"])
  assert.equal(RS.actionsFor(c)[0].title, "Run Script")
  assert.deepEqual(ids(RS.actionsFor({ kind: "script-run", running: true })), ["copy-output", "run-again", "stop-script", "edit-script"])
  assert.deepEqual(ids(RS.actionsFor({ kind: "script-run", running: false })), ["copy-output", "run-again", "edit-script"])
  assert.deepEqual(ids(RS.actionsFor({ kind: "script-error" })), ["edit-script", "copy-path"])
  const about = RS.aboutFor(scriptCandidate("Greet", "Fun", ['# @raycast.argument1 {"placeholder":"Name","optional":true}']), 0)
  assert.deepEqual(about.filter((r) => ["Package", "File", "Mode", "Arguments"].includes(r.label)).map((r) => r.value),
    ["Fun", "/s/greet.sh", "compact", "Name (optional)"])
})

test("Create Script Command takes a title and one of four modes", () => {
  const create = RS.BUILTINS.find((b) => b.id === "builtin:create-script-command")
  assert.deepEqual(create.arguments.map((a) => a.name), ["title", "mode"])
  assert.equal(SC.optionValue(create.arguments[1], "full output"), "fullOutput")
  assert.throws(() => SC.optionValue(create.arguments[1], "loud"), /Mode must be one of Compact, Full Output, Silent, Inline/)
})
