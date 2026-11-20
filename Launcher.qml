import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import qs.Commons
import "ui"
import "core/RootSearch.js" as RootSearch

Item {
  id: root

  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property var shell: null
  property var manifest: null

  readonly property string pluginId: (root.manifest && root.manifest.id) || "typecraft.omacast"

  property bool opened: false
  property double openedAt: 0


  function open(payloadJson) {
    var payload = ({})
    try { payload = JSON.parse(payloadJson || "{}") } catch (e) { payload = ({}) }
    var wasOpen = root.opened
    root.opened = true
    root.openedAt = Date.now()
    launcher.prepare(payload)
    if (!wasOpen) backend.emit("window.visibilityChanged", { visible: true })
  }

  function close() {
    if (!root.opened) return
    root.opened = false
    backend.emit("window.visibilityChanged", { visible: false })
  }


  // filter: a RootSearch.FILTERS id to open on (omacast:toggle-<filter>);
  // "" keeps whatever the launcher was left on.
  function show(filter) {
    if (root.opened) {
      if (filter) launcher.prepare({ filter: filter })
      return
    }
    var payload = JSON.stringify(filter ? { filter: filter } : {})
    if (root.shell && root.shell.summon(root.pluginId, payload)) return
    root.open(payload)
  }

  function hide() {
    if (!root.opened) return
    if (root.shell && root.shell.hide(root.pluginId)) {
      root.close()
      return
    }
    root.close()
  }

  // A filtered toggle closes only when that filter's root is on screen;
  // otherwise it switches the open launcher to it.
  function toggle(filter) {
    if (root.opened && (!filter || (launcher.atRoot && launcher.rootFilter === filter))) root.hide()
    else root.show(filter)
  }

  // A command's own hotkey toggles it: a second press while its view is on
  // screen closes the launcher, as the launcher hotkey does.
  function toggleView(commandId, kind) {
    if (root.opened && launcher.view.kind === kind) root.hide()
    else root.run(commandId)
  }

  function run(commandId) {
    // `omacast run` is explicit, so it skips the confirmation alert.
    var r = backend.callSync("rootSearch.performAction", { id: commandId, action: "open", query: "", confirmed: true })
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

  // A script command's last line of output: a toast if the launcher is still
  // open, else a HUD (SPEC §10.2 Toast → HUD).
  Connections {
    target: backend
    function onNotification(method, data) {
      if (method !== "scriptCommands.finished") return
      if (root.opened && data.mode !== "silent") launcher.showToast(data.style, data.title)
      else launcher.hud(data.title)
    }
  }

  LauncherWindow {
    id: launcher
    shown: root.opened
    backend: backend
    appLibrary: backend.appLibrary
    onDismissRequested: root.hide()
  }

  GlobalShortcut {
    appid: "omacast"
    name: "toggle"
    description: "Toggle omacast"
    onPressed: root.toggle()
  }

  // Open on one root filter: hl.dsp.global("omacast:toggle-applications"),
  // "omacast:toggle-commands" or "omacast:toggle-all".
  GlobalShortcut {
    appid: "omacast"
    name: "toggle-all"
    description: "Toggle omacast on All"
    onPressed: root.toggle("all")
  }

  GlobalShortcut {
    appid: "omacast"
    name: "toggle-applications"
    description: "Toggle omacast on Applications"
    onPressed: root.toggle("applications")
  }

  GlobalShortcut {
    appid: "omacast"
    name: "toggle-commands"
    description: "Toggle omacast on Commands"
    onPressed: root.toggle("commands")
  }

  // Toggles Switch Theme directly: hl.dsp.global("omacast:theme").
  GlobalShortcut {
    appid: "omacast"
    name: "theme"
    description: "Toggle omacast Switch Theme"
    onPressed: root.toggleView("builtin:switch-theme", "theme")
  }

  // Toggles Clipboard History directly: hl.dsp.global("omacast:clipboard").
  GlobalShortcut {
    appid: "omacast"
    name: "clipboard"
    description: "Toggle omacast Clipboard History"
    onPressed: root.toggleView("builtin:clipboard-history", "clipboard")
  }

  // Opens Emoji & Symbols directly: hl.dsp.global("omacast:emoji").
  GlobalShortcut {
    appid: "omacast"
    name: "emoji"
    description: "Open omacast Emoji & Symbols"
    onPressed: root.run("builtin:emoji-picker")
  }

  IpcHandler {
    target: "omacast"

    function toggle(): string {
      root.toggle()
      return root.opened ? "shown" : "hidden"
    }

    function show(): string {
      root.show()
      return "shown"
    }

    function toggleFilter(filter: string): string {
      if (!RootSearch.isFilter(filter)) return "unknown-filter"
      root.toggle(filter)
      return root.opened ? "shown" : "hidden"
    }

    function showFilter(filter: string): string {
      if (!RootSearch.isFilter(filter)) return "unknown-filter"
      root.show(filter)
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

    function run(commandId: string): string {
      return JSON.stringify(root.run(commandId))
    }

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
