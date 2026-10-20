import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import qs.Commons
import "ui"

// oma-cast: a Raycast-style launcher as an Omarchy shell plugin.
//
// omarchy-shell loads this once (keepLoaded) and calls open(payloadJson) on
// summon and close() on hide. Everything else reaches it three ways, all of
// which end in toggle()/show()/hide():
//   - the Hyprland global shortcut oma-cast:toggle (no process per keypress)
//   - `oma-cast toggle` -> omarchy-shell oma-cast toggle (shell socket)
//   - `omarchy-shell shell toggle typecraft.oma-cast`
Item {
  id: root

  // Injected by the shell's panel loader.
  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property var shell: null
  property var manifest: null

  readonly property string pluginId: (root.manifest && root.manifest.id) || "typecraft.oma-cast"

  property bool opened: false
  property double openedAt: 0

  // ------------------------------------------------------- shell lifecycle

  function open(payloadJson) {
    var payload = ({})
    try { payload = JSON.parse(payloadJson || "{}") } catch (e) { payload = ({}) }
    var wasOpen = root.opened
    launcher.prepare(payload)
    root.opened = true
    root.openedAt = Date.now()
    if (!wasOpen) backend.emit("window.visibilityChanged", { visible: true })
  }

  function close() {
    if (!root.opened) return
    root.opened = false
    backend.emit("window.visibilityChanged", { visible: false })
  }

  // ---------------------------------------------------------- our controls

  // Route through the shell when it is there so its open-panel bookkeeping
  // matches; it calls open()/close() back.
  function show() {
    if (root.opened) return
    if (root.shell && root.shell.summon(root.pluginId, "{}")) return
    root.open("{}")
  }

  function hide() {
    if (!root.opened) return
    if (root.shell && root.shell.hide(root.pluginId)) {
      // The shell calls close(); make sure even if it did not.
      root.close()
      return
    }
    root.close()
  }

  function toggle() {
    if (root.opened) root.hide()
    else root.show()
  }

  // Open a command directly (`oma-cast run <id>`, later per-command
  // hotkeys). It counts as a launch for frecency, like Raycast's hotkeys.
  function run(commandId) {
    var r = backend.callSync("rootSearch.performAction", { id: commandId, action: "open", query: "" })
    if (!r.ok) return r
    var outcome = r.data || {}
    if (outcome.push) {
      root.show()
      launcher.popToRoot()
      launcher.push(outcome.push)
    } else if (outcome.close) {
      root.hide()
      if (outcome.hud) launcher.hud(outcome.hud)
    }
    return r
  }

  Backend {
    id: backend
    appLibrary: root.shell ? root.shell.appLibrary : null
    summon: function(id, payload) { return root.shell ? root.shell.summon(id, payload) : false }
  }

  LauncherWindow {
    id: launcher
    shown: root.opened
    backend: backend
    appLibrary: backend.appLibrary
    onDismissRequested: root.hide()
  }

  // Bound as hl.dsp.global("oma-cast:toggle"); see `oma-cast setup hyprland`.
  // The name is fixed: a GlobalShortcut cannot be renamed once registered.
  GlobalShortcut {
    appid: "oma-cast"
    name: "toggle"
    description: "Toggle oma-cast"
    onPressed: root.toggle()
  }

  IpcHandler {
    target: "oma-cast"

    function toggle(): string {
      root.toggle()
      return root.opened ? "shown" : "hidden"
    }

    function show(): string {
      root.show()
      return "shown"
    }

    function hide(): string {
      root.hide()
      return "hidden"
    }

    function isOpen(): string {
      return root.opened ? "true" : "false"
    }

    function ping(): string {
      return "ok"
    }

    // Ids as rootSearch.search reports them: app:<desktop-id>,
    // omarchy:<menu-id>, builtin:<name>.
    function run(commandId: string): string {
      return JSON.stringify(root.run(commandId))
    }

    // Dispatch any backend method: oma-cast call system.healthPing '{}'.
    function call(method: string, dataJson: string): string {
      var data = null
      if (dataJson && dataJson.length > 0) {
        try { data = JSON.parse(dataJson) } catch (e) {
          return JSON.stringify({ ok: false, error: "data is not JSON: " + e })
        }
      }
      return JSON.stringify(backend.callSync(method, data))
    }
  }
}
