const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const source = fs.readFileSync(path.join(__dirname, "../plugin/ui/LauncherWindow.qml"), "utf8")

// QML block sample: "  onBusyChanged: {\n    loadingDelay.stop()\n  }".
function qmlBlock(signature) {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, "missing QML block: " + signature)
  const end = source.indexOf("\n  }", start)
  assert.ok(end > start, "unterminated QML block: " + signature)
  return source.slice(start, end + 4)
}

test("loading feedback delays fast work, preserves toasts and resets across hide and reopen", { skip: !process.env.OMA_CAST_QML_RUNNER }, t => {
  const parent = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(parent, "oma-cast-loading-probe-"))
  const marker = path.join(root, ".oma-cast-loading-probe")
  fs.writeFileSync(marker, "loading feedback fixture\n")
  t.after(() => {
    assert.ok(path.isAbsolute(root))
    assert.equal(path.dirname(root), parent)
    assert.ok(path.basename(root).startsWith("oma-cast-loading-probe-"))
    assert.equal(fs.readFileSync(marker, "utf8"), "loading feedback fixture\n")
    fs.rmSync(root, { recursive: true, force: true })
  })
  const declarations = ["busy", "loadingVisible", "loadingFeedbackDelay"].map(name => {
    // Property sample: "  readonly property int loadingFeedbackDelay: 500".
    const declaration = source.match(new RegExp("^  (?:readonly )?property (?:bool|int) " + name + ":.+$", "m"))
    assert.ok(declaration, "missing loading property: " + name)
    return declaration[0]
  }).join("\n")
  // Footer sample: "id: footerStatus\n  text: window.toast ? window.toast.title : window.view.title".
  const footer = source.match(/id: footerStatus\s+[\s\S]*?text: ([^\n]+)/)
  assert.ok(footer, "missing footer status binding")
  const env = { ...process.env, HOME: root, TMPDIR: root, QT_QPA_PLATFORM: "offscreen", QML_DISABLE_DISK_CACHE: "1" }
  for (const key of ["XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) {
    env[key] = path.join(root, key)
    fs.mkdirSync(env[key], { mode: 0o700 })
  }
  const config = path.join(root, "shell.qml")
  fs.writeFileSync(config, `import QtQuick
import Quickshell
ShellRoot {
  id: window
  property QtObject backend: QtObject { property bool loading: false }
  property bool shown: false
  property var toast: null
  property var view: ({ title: "oma-cast" })
  ${declarations}
  ${qmlBlock("onBusyChanged: {")}
  ${qmlBlock("Timer {\n    id: loadingDelay")}
  property string footerText: ${footer[1]}
  property int stage: 0
  function check(ok, detail) { if (!ok) throw new Error(detail) }
  property var stages: [
    { wait: 50, run: function() { check(!window.loadingVisible && window.footerText === "oma-cast", "fast work flashed"); backend.loading = false } },
    { wait: loadingFeedbackDelay + 80, run: function() { check(!window.loadingVisible, "completed work left a pending cue"); backend.loading = true } },
    { wait: loadingFeedbackDelay + 80, run: function() { check(window.loadingVisible && window.footerText === "Loading…", "slow work lacks feedback"); window.toast = { title: "<b>Copied</b>" } } },
    { wait: 30, run: function() { check(window.footerText === "<b>Copied</b>", "toast lost priority"); window.toast = null; backend.loading = false } },
    { wait: 30, run: function() { check(!window.loadingVisible && window.footerText === "oma-cast", "completion did not restore context"); backend.loading = true } },
    { wait: 100, run: function() { window.shown = false } },
    { wait: loadingFeedbackDelay + 80, run: function() { check(!window.loadingVisible, "hidden window retained feedback"); window.shown = true } },
    { wait: 100, run: function() { check(!window.loadingVisible, "reopen reused an old delay") } },
    { wait: loadingFeedbackDelay + 80, run: function() { check(window.loadingVisible, "reopen lost persistent loading"); window.shown = false } },
    { wait: 30, run: function() { check(!window.loadingVisible, "close retained visible feedback"); backend.loading = false; window.shown = true } },
    { wait: loadingFeedbackDelay + 80, run: function() { check(!window.loadingVisible && window.footerText === "oma-cast", "idle reopen flashed"); console.log("OMA_CAST_LOADING_PROBE:OK"); Qt.quit() } }
  ]
  Timer {
    id: tick
    onTriggered: {
      try {
        window.stages[window.stage].run()
        window.stage++
        if (window.stage < window.stages.length) {
          tick.interval = window.stages[window.stage].wait
          tick.restart()
        }
      } catch (error) { console.error("OMA_CAST_LOADING_PROBE:FAIL " + error); Qt.quit() }
    }
  }
  Component.onCompleted: Qt.callLater(function() {
    window.shown = true
    backend.loading = true
    tick.interval = window.stages[0].wait
    tick.start()
  })
}
`)
  const result = spawnSync(process.env.OMA_CAST_QML_RUNNER, ["-p", config], { cwd: root, env, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL" })
  assert.ifError(result.error)
  const output = result.stdout + result.stderr
  assert.equal(result.status, 0, output)
  assert.match(output, /OMA_CAST_LOADING_PROBE:OK/)
  assert.doesNotMatch(output, /OMA_CAST_LOADING_PROBE:FAIL/)
})
