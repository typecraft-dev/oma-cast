const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

// `omacast doctor` reads the shell log for QML errors from the plugin as it is
// loaded now. Stand-ins on PATH replace the shell, Hyprland and `qs log`.
const root = path.join(__dirname, "..")
const esc = "\x1b"

// log(plugin) builds the shell log for the plugin's loaded path.
function doctor(t, log) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omacast-doctor-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const bin = home + "/bin"
  const plugins = home + "/.config/omarchy/plugins"
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(plugins, { recursive: true })
  fs.symlinkSync(root, plugins + "/typecraft.omacast.dev-2")
  for (const name of ["omarchy-shell", "omarchy", "hyprctl"]) {
    fs.writeFileSync(bin + "/" + name, "#!/bin/bash\nexit 1\n", { mode: 0o755 })
  }
  const plugin = plugins + "/typecraft.omacast.dev-2"
  fs.writeFileSync(home + "/shell.log", log(plugin))
  fs.writeFileSync(bin + "/qs", '#!/bin/bash\n[[ $1 == log ]] && cat "$LOG_FILE"\n', { mode: 0o755 })
  const r = spawnSync(path.join(root, "bin/omacast"), ["doctor"], {
    encoding: "utf8",
    env: { HOME: home, XDG_CONFIG_HOME: home + "/.config", OMARCHY_PATH: home, LOG_FILE: home + "/shell.log", PATH: bin + ":" + process.env.PATH }
  })
  return { out: r.stdout + r.stderr, status: r.status }
}

function warn(plugin, message) {
  return `${esc}[33m  WARN${esc}[97m scene${esc}[0m: qs://${plugin}/ui/LauncherWindow.qml[170:-1]: ${message}\n`
}

function reloading(name) {
  return `${esc}[34m DEBUG${esc}[97m qml${esc}[0m: Local plugin changed, reloading: ${name}\n`
}

test("doctor fails on a ReferenceError from the loaded plugin, once per line", (t) => {
  const r = doctor(t, (plugin) => {
    const line = warn(plugin, "ReferenceError: Hyprland is not defined")
    return reloading("typecraft.omacast.dev-2") + line + line + line
  })
  assert.equal(r.status, 1)
  assert.match(r.out, /FAIL {2}the shell logged QML errors for the plugin:/)
  assert.equal(r.out.split("ReferenceError: Hyprland is not defined").length - 1, 1, r.out)
  assert.doesNotMatch(r.out, /\x1b\[/, "colour codes are stripped")
  assert.match(r.out, /omacast reload/)
})

test("doctor ignores errors from an older dev link and from before the last reload", (t) => {
  const r = doctor(t, (plugin) =>
    warn(plugin, "ReferenceError: Hyprland is not defined") +
    reloading("typecraft.omacast.dev-2") +
    warn(plugin.replace(/dev-2$/, "dev-1"), "ReferenceError: Hyprland is not defined") +
    warn(plugin + "0", "TypeError: x is null"))
  assert.match(r.out, /ok {4}no QML errors in the shell log/, r.out)
})

test("doctor reports a type that failed to load", (t) => {
  const r = doctor(t, (plugin) => `  WARN scene: qs://${plugin}/Launcher.qml[6:1]: Type LauncherWindow unavailable\n`)
  assert.match(r.out, /Type LauncherWindow unavailable/)
  assert.equal(r.status, 1)
})
