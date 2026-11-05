const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const Paths = require("../core/Paths.js")

// Marketplace review: histories must stay private under a normal umask 022,
// with every ancestor traversable, and no private text may reach any argv.
const root = path.join(__dirname, "..")
const mode = (p) => fs.statSync(p).mode & 0o777

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omacast-privacy-"))
  fs.chmodSync(home, 0o755)
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

function runSetup(home) {
  const p = Paths.resolve((name) => ({ HOME: home, XDG_RUNTIME_DIR: home + "/run" })[name] || "")
  fs.mkdirSync(home + "/run", { mode: 0o755 })
  const files = ["settings.json", "frecency.json", "calculator.json"].map((f) => p.db + "/" + f)
  const [cmd, ...args] = Paths.setupArgv(p, files)
  const r = spawnSync("bash", ["-c", "umask 022; exec \"$@\"", "umask-022", cmd, ...args], { encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  return p
}

test("first start under umask 022 creates owner-only dirs and 0600 store files", (t) => {
  const p = runSetup(tempHome(t))
  for (const dir of Paths.privateRoots(p)) assert.equal(mode(dir), 0o700, dir)
  for (const dir of Paths.directoriesToCreate(p)) assert.equal(mode(dir), 0o700, dir)
  for (const f of ["settings.json", "frecency.json", "calculator.json"]) assert.equal(mode(p.db + "/" + f), 0o600, f)
})

test("an atomic save into a pre-created file keeps it private", (t) => {
  const p = runSetup(tempHome(t))
  // QSaveFile copies the target's permissions onto its temp file before the rename.
  const target = p.db + "/frecency.json"
  const temp = target + ".tmp"
  fs.writeFileSync(temp, '{"searchHistory":["secret"]}', { mode: 0o644 })
  fs.chmodSync(temp, mode(target))
  fs.renameSync(temp, target)
  assert.equal(mode(target), 0o600)
})

test("readable histories from older builds are repaired; stricter modes are kept", (t) => {
  const home = tempHome(t)
  const db = home + "/.local/share/omacast/db"
  fs.mkdirSync(db, { recursive: true, mode: 0o755 })
  fs.chmodSync(home + "/.local/share/omacast", 0o755)
  fs.writeFileSync(db + "/frecency.json", "{}", { mode: 0o644 })
  fs.writeFileSync(db + "/calculator.json", "{}", { mode: 0o644 })
  fs.writeFileSync(db + "/settings.json", "{}")
  fs.chmodSync(db + "/frecency.json", 0o644)
  fs.chmodSync(db + "/calculator.json", 0o664)
  fs.chmodSync(db + "/settings.json", 0o400)
  const p = runSetup(home)
  assert.equal(mode(p.data), 0o700)
  assert.equal(mode(p.db), 0o700)
  assert.equal(mode(db + "/frecency.json"), 0o600)
  assert.equal(mode(db + "/calculator.json"), 0o600)
  assert.equal(mode(db + "/settings.json"), 0o400)
  assert.equal(fs.readFileSync(db + "/frecency.json", "utf8"), "{}", "repair never rewrites contents")
})

test("legacy oma-cast data moves and comes out private", (t) => {
  const home = tempHome(t)
  const old = home + "/.local/share/oma-cast/db"
  fs.mkdirSync(old, { recursive: true })
  fs.chmodSync(home + "/.local/share/oma-cast", 0o755)
  fs.writeFileSync(old + "/calculator.json", '{"history":[]}', { mode: 0o644 })
  fs.chmodSync(old + "/calculator.json", 0o644)
  const p = runSetup(home)
  assert.ok(!fs.existsSync(home + "/.local/share/oma-cast"))
  assert.equal(mode(p.data), 0o700)
  assert.equal(mode(p.db + "/calculator.json"), 0o600)
})

test("setup hyprland keeps a private legacy oma-cast.lua private", (t) => {
  const home = tempHome(t)
  const hypr = home + "/.config/hypr"
  const bin = home + "/bin"
  fs.mkdirSync(hypr, { recursive: true })
  fs.mkdirSync(bin)
  fs.mkdirSync(home + "/omarchy")
  fs.writeFileSync(hypr + "/hyprland.lua", 'require("hypr.oma-cast")\n')
  fs.writeFileSync(hypr + "/oma-cast.lua", 'o.bind("ALT + SPACE", "oma-cast launcher", hl.dsp.global("oma-cast:toggle"))\n-- token = "private"\n')
  fs.chmodSync(hypr + "/oma-cast.lua", 0o600)
  fs.writeFileSync(bin + "/hyprctl", "#!/bin/bash\nexit 0\n", { mode: 0o755 })
  const r = spawnSync("bash", ["-c", 'umask 022; exec "$@"', "umask-022", path.join(root, "bin/omacast"), "setup", "hyprland", "--yes"], {
    env: { HOME: home, XDG_CONFIG_HOME: home + "/.config", OMARCHY_PATH: home + "/omarchy", PATH: bin + ":" + process.env.PATH },
    encoding: "utf8"
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(!fs.existsSync(hypr + "/oma-cast.lua"))
  assert.equal(mode(hypr + "/omacast.lua"), 0o600)
  assert.match(fs.readFileSync(hypr + "/omacast.lua", "utf8"), /omacast:toggle/)
})

// The clipboard scripts run with the text on stdin. A fake wl-copy/wtype on
// PATH records each process's /proc cmdline while the text is in flight.
function clipboardScripts() {
  const source = fs.readFileSync(path.join(root, "services/ClipboardWriter.qml"), "utf8")
  const grab = (name) => source.match(new RegExp("property string " + name + ": '([^']*)'"))[1]
  return { copy: grab("copyScript"), paste: grab("pasteScript") }
}

for (const kind of ["copy", "paste"]) {
  test(`calculator ${kind} keeps the text out of every command line`, (t) => {
    const home = tempHome(t)
    const log = home + "/cmdlines"
    const fake = '#!/bin/bash\ntr "\\0" " " </proc/$$/cmdline >>"$LOG"; echo >>"$LOG"\n'
    fs.writeFileSync(home + "/wl-copy", fake + 'cat >"$LOG.clipboard"\n', { mode: 0o755 })
    fs.writeFileSync(home + "/wtype", fake, { mode: 0o755 })
    fs.writeFileSync(home + "/sleep", "#!/bin/bash\nexit 0\n", { mode: 0o755 })
    // Paste picks its key from the focused window; pretend it isn't a terminal.
    fs.writeFileSync(home + "/hyprctl", '#!/bin/bash\necho \'{"class":"firefox"}\'\n', { mode: 0o755 })
    const secret = "1234 * 5678 = 7006652 my private question"
    const script = clipboardScripts()[kind]
    const r = spawnSync("bash", ["-c", script], {
      input: secret, encoding: "utf8",
      env: { ...process.env, LOG: log, PATH: home + ":" + process.env.PATH }
    })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(fs.readFileSync(log + ".clipboard", "utf8"), secret)
    const cmdlines = fs.readFileSync(log, "utf8")
    assert.ok(!cmdlines.includes("private"), cmdlines)
    assert.ok(!/\$[0-9@*]/.test(script), "the script takes no arguments")
    if (kind === "paste") assert.match(cmdlines, /wtype -M shift -k Insert -m shift/)
  })
}

test("no QML hands clipboard text or prompts to a process's argv", () => {
  const files = ["Backend.qml", "Launcher.qml", ...["ui", "services"].flatMap((d) =>
    fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith(".qml")).map((f) => d + "/" + f))]
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8")
    assert.doesNotMatch(source, /\["wl-copy"|omarchy-clipboard-paste-text"|omarchy-agent/, file)
  }
})
