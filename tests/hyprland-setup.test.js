const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const cli = path.join(__dirname, "../bin/omacast")

function fixture(t, bindings = [], { output, status = 0 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omacast-hotkey-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const hypr = path.join(home, ".config/hypr")
  const defaults = path.join(home, "omarchy/default/hypr")
  const bin = path.join(home, "bin")
  for (const dir of [hypr, defaults, bin]) fs.mkdirSync(dir, { recursive: true })
  const main = 'require("hypr.bindings")\n'
  fs.writeFileSync(path.join(hypr, "hyprland.lua"), main)
  fs.writeFileSync(path.join(home, "bindings.json"), output ?? JSON.stringify(bindings))
  fs.writeFileSync(path.join(bin, "hyprctl"), `#!/bin/bash
if [[ $1 == -j && $2 == binds ]]; then
  cat "$HOME/bindings.json"
  exit ${status}
fi
if [[ $1 == reload ]]; then touch "$HOME/reloaded"; exit 0; fi
exit 1
`, { mode: 0o755 })
  return {
    home, hypr, defaults, main,
    run: () => spawnSync("bash", [cli, "setup", "hyprland", "--yes"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
        OMARCHY_PATH: path.join(home, "omarchy"), PATH: bin + ":" + process.env.PATH }
    })
  }
}

function unchanged(f) {
  assert.equal(fs.readFileSync(path.join(f.hypr, "hyprland.lua"), "utf8"), f.main)
  assert.ok(!fs.existsSync(path.join(f.hypr, "omacast.lua")))
  assert.ok(!fs.existsSync(path.join(f.home, "reloaded")))
}

test("setup ignores a default binding removed by a user override", (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.defaults, "dictation.lua"),
    'o.bind("ALT + SPACE", "Toggle dictation", "omarchy-dictation toggle")\n')
  fs.writeFileSync(path.join(f.hypr, "bindings.lua"), 'hl.unbind("ALT + SPACE")\n')
  const r = f.run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(fs.readFileSync(path.join(f.hypr, "omacast.lua"), "utf8"), /omacast:toggle/)
  assert.match(fs.readFileSync(path.join(f.hypr, "hyprland.lua"), "utf8"), /require\("hypr.omacast"\)/)
  assert.ok(fs.existsSync(path.join(f.home, "reloaded")))
})

for (const key of [{ key: "space" }, { key: "SPACE" }, { key: "", keycode: 65 }]) {
  test(`setup rejects an active Alt+Space binding ${JSON.stringify(key)}`, (t) => {
    const f = fixture(t, [{ modmask: 8, submap: "", description: "Toggle dictation", ...key }])
    const r = f.run()
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /Alt\+Space is already bound/)
    assert.match(r.stderr, /Toggle dictation/)
    unchanged(f)
  })
}

test("setup ignores other modifier combinations and bindings in other submaps", (t) => {
  const f = fixture(t, [
    { modmask: 64, key: "space", submap: "" },
    { modmask: 72, key: "space", submap: "" },
    { modmask: 8, key: "space", submap: "resize" }
  ])
  const r = f.run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test("setup rejects a universal binding from another submap", (t) => {
  const f = fixture(t, [{ modmask: 8, key: "space", submap: "resize",
    submap_universal: "true", description: "Universal shortcut" }])
  const r = f.run()
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /Universal shortcut/)
  unchanged(f)
})

test("setup does not trust an omacast description without an installed hotkey file", (t) => {
  const f = fixture(t, [{ modmask: 8, key: "space", submap: "", dispatcher: "__lua",
    description: "omacast launcher" }])
  assert.notEqual(f.run().status, 0)
  unchanged(f)
})

test("an existing omacast shortcut does not hide a second active binding", (t) => {
  const f = fixture(t, [
    { modmask: 8, key: "space", submap: "", dispatcher: "__lua", description: "omacast launcher" },
    { modmask: 8, key: "space", submap: "", dispatcher: "__lua", description: "Toggle dictation" }
  ])
  const content = 'o.bind("ALT + SPACE", "omacast launcher", hl.dsp.global("omacast:toggle"))\n'
  fs.writeFileSync(path.join(f.hypr, "omacast.lua"), content)
  const r = f.run()
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /Toggle dictation/)
  assert.equal(fs.readFileSync(path.join(f.hypr, "omacast.lua"), "utf8"), content)
  assert.equal(fs.readFileSync(path.join(f.hypr, "hyprland.lua"), "utf8"), f.main)
  assert.ok(!fs.existsSync(path.join(f.home, "reloaded")))
})

for (const name of ["omacast", "oma-cast"]) {
  test(`setup can rerun with the existing ${name} shortcut active`, (t) => {
    const f = fixture(t, [{ modmask: 8, key: "SPACE", submap: "", dispatcher: "__lua",
      description: `${name} launcher`, arg: "104" }])
    const file = path.join(f.hypr, `${name}.lua`)
    fs.writeFileSync(file, `o.bind("ALT + SPACE", "${name} launcher", hl.dsp.global("${name}:toggle"))\n`)
    fs.writeFileSync(path.join(f.hypr, "hyprland.lua"), `require("hypr.${name}")\n`)
    const r = f.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    fs.writeFileSync(path.join(f.home, "bindings.json"), JSON.stringify([
      { modmask: 8, key: "SPACE", submap: "", dispatcher: "__lua",
        description: "omacast launcher", arg: "104" }
    ]))
    const again = f.run()
    assert.equal(again.status, 0, again.stdout + again.stderr)
    const main = fs.readFileSync(path.join(f.hypr, "hyprland.lua"), "utf8")
    assert.equal(main.split('require("hypr.omacast")').length - 1, 1)
  })
}

for (const options of [{ status: 1 }, { output: "not json" }, { output: "{}" }, { output: "" }]) {
  test(`setup leaves config untouched when bindings cannot be read ${JSON.stringify(options)}`, (t) => {
    const f = fixture(t, [], options)
    const r = f.run()
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /could not read active Hyprland bindings/)
    unchanged(f)
  })
}
