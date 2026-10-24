import QtQuick
import Quickshell
import Quickshell.Io
import "../core/OmarchyMenu.js" as OmarchyMenu

Item {
  id: source

  property string omarchyPath: Quickshell.env("OMARCHY_PATH") || "/usr/share/omarchy"
  readonly property string defaultPath: source.omarchyPath + "/default/omarchy/omarchy-menu.jsonc"
  readonly property string userPath: Quickshell.env("HOME") + "/.config/omarchy/extensions/omarchy-menu.jsonc"

  property var defaultItems: []
  property var userItems: []
  property var tree: OmarchyMenu.buildTree([], [])
  property var guards: ({ when: {}, checked: {}, disabled: {} })
  property var providerItems: ({})
  property bool loading: guardProc.running || providerProc.running
  property int revision: 0

  signal message(string level, string text, var metadata)

  function rebuild() {
    source.tree = OmarchyMenu.buildTree(source.defaultItems, source.userItems)
    source.revision++
    source.refresh()
  }

  function refresh() {
    if (!guardProc.running) {
      var script = OmarchyMenu.guardScript(source.tree)
      if (script) {
        guardProc.collected = ""
        guardProc.command = ["bash", "-lc", script]
        guardProc.running = true
      }
    }
    if (!providerProc.running) {
      source.providerQueue = source.providerMenus()
      source.startNextProvider()
    }
  }

  function providerMenus() {
    var out = []
    for (var i = 0; i < source.tree.order.length; i++) {
      var item = source.tree.items[source.tree.order[i]]
      if (item.provider && OmarchyMenu.PROVIDERS[item.provider]) out.push(item.id)
    }
    return out
  }

  property var providerQueue: []
  property var pendingProviderItems: ({})

  function startNextProvider() {
    if (source.providerQueue.length === 0) {
      source.providerItems = source.pendingProviderItems
      source.pendingProviderItems = ({})
      source.revision++
      return
    }
    var menuId = source.providerQueue[0]
    source.providerQueue = source.providerQueue.slice(1)
    var spec = OmarchyMenu.PROVIDERS[source.tree.items[menuId].provider]
    providerProc.menuId = menuId
    providerProc.collected = ""
    providerProc.command = ["bash", "-lc", spec.script]
    providerProc.running = true
  }

  function load(which, text) {
    var parsed = OmarchyMenu.parse(text)
    if (parsed.error) source.message("warning", "ignoring unreadable " + (which === "user" ? source.userPath : source.defaultPath) + ": " + parsed.error, null)
    if (which === "user") source.userItems = parsed.items
    else source.defaultItems = parsed.items
    source.rebuild()
  }

  Process {
    id: guardProc
    property string collected: ""
    stdout: SplitParser { onRead: function(line) { guardProc.collected += line + "\n" } }
    onExited: function(exitCode, exitStatus) {
      if (exitStatus !== 0) return
      source.guards = OmarchyMenu.parseGuardOutput(guardProc.collected)
      source.revision++
    }
  }

  Process {
    id: providerProc
    property string menuId: ""
    property string collected: ""
    stdout: SplitParser { onRead: function(line) { providerProc.collected += line + "\n" } }
    onExited: {
      var item = source.tree.items[providerProc.menuId]
      if (item) {
        var next = ({})
        for (var k in source.pendingProviderItems) next[k] = source.pendingProviderItems[k]
        next[providerProc.menuId] = OmarchyMenu.providerItems(providerProc.menuId, item.provider, providerProc.collected)
        source.pendingProviderItems = next
      }
      source.startNextProvider()
    }
  }

  FileView {
    path: source.defaultPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: source.load("default", text())
    onLoadFailed: { source.message("error", "Omarchy menu not found at " + source.defaultPath, null); source.load("default", "") }
  }

  FileView {
    path: source.userPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: source.load("user", text())
    onLoadFailed: source.load("user", "")
  }
}
