import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import qs.Commons
import "ui"

Item {
  id: root

  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property var shell: null
  property var manifest: null

  readonly property string pluginId: (root.manifest && root.manifest.id) || "typecraft.oma-cast"

  property bool opened: false
  property double openedAt: 0
  property bool translateOpen: false

  function openTranslate(text) {
    if (root.opened) root.hide()
    root.translateOpen = true
    translateWindow.load(String(text || ""))
  }

  function closeTranslate() {
    if (!root.translateOpen) return
    root.translateOpen = false
    backend.callSync("translate.cancel", null)
  }


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


  function show() {
    if (root.translateOpen) root.closeTranslate()
    if (root.opened) return
    if (root.shell && root.shell.summon(root.pluginId, "{}")) return
    root.open("{}")
  }

  function hide() {
    if (!root.opened) return
    if (root.shell && root.shell.hide(root.pluginId)) {
      root.close()
      return
    }
    root.close()
  }

  function toggle() {
    if (root.opened) root.hide()
    else root.show()
  }

  function run(commandId) {
    // `oma-cast run` is explicit, so it skips the confirmation alert.
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

  Connections {
    target: backend
    function onNotification(method, data) {
      if (method === "translate.open") { root.openTranslate(data.text || ""); return }
      if (method !== "agent.launchReady") return
      root.hide()
      launcher.popToRoot()
      Util.execArgv(data.argv)
    }
  }

  TranslateWindow {
    id: translateWindow
    backend: backend
    shown: root.translateOpen
    onDismissRequested: root.closeTranslate()
  }

  LauncherWindow {
    id: launcher
    shown: root.opened
    backend: backend
    appLibrary: backend.appLibrary
    onDismissRequested: root.hide()
  }

  GlobalShortcut {
    appid: "oma-cast"
    name: "toggle"
    description: "Toggle oma-cast"
    onPressed: root.toggle()
  }

  GlobalShortcut {
    appid: "oma-cast"
    name: "translate"
    description: "Translate text"
    onPressed: root.openTranslate("")
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

    function run(commandId: string): string {
      return JSON.stringify(root.run(commandId))
    }

    function translate(text: string): string {
      root.openTranslate(text)
      return "shown"
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
