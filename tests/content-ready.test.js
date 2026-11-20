const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const source = fs.readFileSync(path.join(__dirname, "../ui/LauncherWindow.qml"), "utf8")

// The binding is plain JavaScript over `window`, so node can evaluate it as is.
// Sample: "readonly property bool contentReady: window.shown && …\n  property bool contentRevealed".
function contentReady(window) {
  const match = source.match(/readonly property bool contentReady: ([\s\S]*?)\n  property bool contentRevealed/)
  assert.ok(match, "missing contentReady binding")
  const expression = match[1].split("\n").filter(line => !line.trim().startsWith("//")).join("\n")
  return new Function("window", "return " + expression)(window)
}

function shownOn(scale, devicePixelRatio) {
  const screen = { name: "HDMI-A-1", width: 2400, height: 1350 }
  return {
    shown: true,
    screen,
    targetMonitor: { name: screen.name, scale },
    width: screen.width,
    height: screen.height,
    devicePixelRatio,
  }
}

test("content is revealed once Qt has the output's scale", () => {
  assert.equal(contentReady(shownOn(1.6, 1)), false)
  assert.equal(contentReady(shownOn(1.6, 1.6)), true)
  assert.equal(contentReady(shownOn(1.25, 1.25)), true)
})

// Seen on a 1920x1080 output at scale 0.8: Qt keeps devicePixelRatio at 1.
test("content is revealed on an output scaled below 1", () => {
  assert.equal(contentReady(shownOn(0.8, 1)), true)
  assert.equal(contentReady(shownOn(0.5, 1)), true)
})

test("content stays hidden until the surface has the output's size", () => {
  assert.equal(contentReady({ ...shownOn(0.8, 1), width: 1920 }), false)
  assert.equal(contentReady({ ...shownOn(1, 1), shown: false }), false)
})
