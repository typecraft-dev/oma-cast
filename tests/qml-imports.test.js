const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

// A Quickshell name used without its module import is a ReferenceError only
// when the binding first runs, not a load error. The launcher's targetMonitor
// read Hyprland.monitors without `import Quickshell.Hyprland`, so the window
// mapped but its content never revealed. No test loads QML, so check the
// imports against the names each file uses.
const root = path.join(__dirname, "..")
const modules = {
  "Quickshell.Hyprland": /\bHyprland\.|\b(GlobalShortcut|HyprlandFocusGrab)\s*\{/,
  "Quickshell.Wayland": /\b(WlrLayer|WlrKeyboardFocus|WlrLayershell|ToplevelManager)\b/,
  "Quickshell.Io": /\b(Process|IpcHandler|FileView|StdioCollector|SplitParser|Socket)\s*\{/
}

function qmlFiles() {
  return ["Backend.qml", "Launcher.qml", ...["ui", "services"].flatMap((d) =>
    fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith(".qml")).map((f) => d + "/" + f))]
}

function code(source) {
  return source.split("\n").map((line) => line.replace(/(^|\s)\/\/.*$/, "")).join("\n")
}

test("every QML file imports the Quickshell modules it uses", () => {
  for (const file of qmlFiles()) {
    const source = code(fs.readFileSync(path.join(root, file), "utf8"))
    const imports = new Set([...source.matchAll(/^import\s+([\w.]+)/gm)].map((m) => m[1]))
    for (const [module, uses] of Object.entries(modules)) {
      if (uses.test(source)) assert.ok(imports.has(module), `${file} uses ${module} without importing it`)
    }
  }
})

test("the import check catches a Hyprland singleton without its import", () => {
  const source = code("import QtQuick\nimport Quickshell\nItem {\n  // Hyprland.monitors in a comment is fine\n  property var m: Hyprland.monitors.values\n}\n")
  const imports = new Set([...source.matchAll(/^import\s+([\w.]+)/gm)].map((m) => m[1]))
  assert.ok(modules["Quickshell.Hyprland"].test(source))
  assert.ok(!imports.has("Quickshell.Hyprland"))
})
