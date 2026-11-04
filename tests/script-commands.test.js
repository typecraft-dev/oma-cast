const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const SC = require("../core/ScriptCommands.js")

const root = path.join(__dirname, "..")

const DISPLAY = [
  "#!/bin/bash",
  "# @raycast.schemaVersion 1",
  "# @raycast.title Switch Display",
  "# @raycast.mode silent",
  "# @raycast.icon 🖥️",
  '# @raycast.argument1 { "type": "dropdown", "placeholder": "Input", "data": [{"title": "Mac mini", "value": "x0091"}, {"title": "MacBook Pro", "value": "x00d0"}] }',
  '# @raycast.argument2 { "type": "text", "placeholder": "Note", "optional": true, "percentEncoded": true }',
  'echo "$1"'
].join("\n")

test("headers parse into a command with its arguments", () => {
  const { command } = SC.parse(DISPLAY, "/home/u/.config/omacast/script-commands/display.sh")
  assert.equal(command.title, "Switch Display")
  assert.equal(command.mode, "silent")
  assert.equal(command.packageName, "Script Commands", "defaults to the folder name, title-cased")
  assert.equal(command.cwd, "/home/u/.config/omacast/script-commands/.")
  assert.deepEqual(command.arguments.map((a) => [a.name, a.type, a.required]), [["argument1", "dropdown", true], ["argument2", "text", false]])
  assert.deepEqual(command.arguments[0].options[0], { title: "Mac mini", value: "x0091" })
  const c = SC.candidate(command)
  assert.equal(c.kind, "script")
  assert.equal(c.glyph, "🖥️")
})

test("other comment styles, key case and modes", () => {
  const js = "// @raycast.schemaVersion 1\n// @raycast.Title Hi\n// @raycast.mode full-output\n// @raycast.currentDirectoryPath ../x\n// @raycast.needsConfirmation true"
  const { command } = SC.parse(js, "/a/b/hi.js")
  assert.equal(command.title, "Hi")
  assert.equal(command.mode, "fullOutput")
  assert.equal(command.cwd, "/a/b/../x")
  assert.equal(command.needsConfirmation, true)
  assert.equal(SC.parse("# @raycast.schemaVersion 1\n# @raycast.title T\n# @raycast.mode inline", "/a/t").command.mode, "compact", "inline without refreshTime")
})

test("invalid headers are reported", () => {
  assert.match(SC.parse("# @raycast.title T\n# @raycast.mode silent", "/a").error, /schemaVersion/)
  assert.match(SC.parse("# @raycast.schemaVersion 1\n# @raycast.mode silent", "/a").error, /title/)
  assert.match(SC.parse("# @raycast.schemaVersion 1\n# @raycast.title T\n# @raycast.mode loud", "/a").error, /mode/)
  assert.match(SC.parse("# @raycast.schemaVersion 1\n# @raycast.title T\n# @raycast.mode silent\n# @raycast.argument1 {nope", "/a").error, /JSON/)
})

test("argv validates required arguments and dropdown values, and percent-encodes", () => {
  const { command } = SC.parse(DISPLAY, "/s/display.sh")
  assert.equal(SC.argv(command, {}).index, 0)
  assert.match(SC.argv(command, { argument1: "x9999" }).error, /not a input option/)
  assert.deepEqual(SC.argv(command, { argument1: "x00d0" }).argv, ["x00d0", ""])
  assert.deepEqual(SC.argv(command, { argument1: "x00d0", argument2: "a b" }).argv, ["x00d0", "a%20b"])
})

test("dropdown cycling wraps both ways", () => {
  const def = SC.parse(DISPLAY, "/s/d").command.arguments[0]
  assert.equal(SC.cycleOption(def, "", 1), "x0091")
  assert.equal(SC.cycleOption(def, "", -1), "x00d0")
  assert.equal(SC.cycleOption(def, "x00d0", 1), "x0091")
  assert.equal(SC.optionTitle(def, "x00d0"), "MacBook Pro")
})

test("the result is the last non-empty line, ANSI stripped", () => {
  const cmd = { title: "T" }
  assert.deepEqual(SC.outcome(cmd, 0, "one\n\x1b[32mDone\x1b[0m\n\n"), { style: "success", title: "Done" })
  assert.deepEqual(SC.outcome(cmd, 2, "oops\n"), { style: "failure", title: "oops" })
  assert.deepEqual(SC.outcome(cmd, 1, ""), { style: "failure", title: "T failed (exit 1)" })
})

test("the scan finds executable scripts only and keeps their headers", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omacast-scripts-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(dir + "/display.sh", DISPLAY, { mode: 0o755 })
  fs.writeFileSync(dir + "/plain.sh", DISPLAY, { mode: 0o644 })
  fs.writeFileSync(dir + "/x.template.sh", DISPLAY, { mode: 0o755 })
  fs.writeFileSync(dir + "/empty.sh", "", { mode: 0o755 })
  fs.mkdirSync(dir + "/sub")
  const qml = fs.readFileSync(path.join(root, "services/ScriptCommandSource.qml"), "utf8")
  const script = eval(qml.match(/scanScript: ('[\s\S]*?')\n\n/)[1])
  const r = spawnSync("bash", ["-c", script, "scan", dir], { encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  const files = SC.splitScan(r.stdout)
  assert.deepEqual(files.map((f) => path.basename(f.path)), ["display.sh"])
  assert.equal(SC.parse(files[0].text, files[0].path).command.title, "Switch Display")
})

test("the runner runs the script from its folder with $1..$3", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omacast-run-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(dir + "/bin")
  fs.writeFileSync(dir + "/bin/s.sh", '#!/bin/bash\necho "$PWD|$1|$2|$#"; echo err >&2\n', { mode: 0o755 })
  const qml = fs.readFileSync(path.join(root, "services/ScriptRunner.qml"), "utf8")
  const wrapper = qml.match(/"bash", "-lc", '([^']*)'/)[1]
  const cwd = SC.parse("# @raycast.schemaVersion 1\n# @raycast.title T\n# @raycast.mode silent\n# @raycast.currentDirectoryPath ..", dir + "/bin/s.sh").command.cwd
  const r = spawnSync("bash", ["-c", wrapper, "script", cwd, dir + "/bin/s.sh", "x00d0", ""], { encoding: "utf8" })
  assert.equal(r.stdout, dir + "|x00d0||2\nerr\n", "runs from the resolved folder; stderr joins stdout")
})
