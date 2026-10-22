import QtQuick
import Quickshell.Io
import "../core/Keybindings.js" as Keybindings

Item {
  id: source
  property var rows: []
  property string error: ""
  readonly property bool loading: process.running
  property int revision: 0
  property string lastOutput: ""

  function refresh() {
    if (process.running) return
    process.collected = ""
    process.running = true
  }

  Component.onCompleted: refresh()

  Process {
    id: process
    property string collected: ""
    command: ["timeout", "10", "omarchy", "menu", "keybindings", "--print"]
    stdout: SplitParser { onRead: function(line) { process.collected += line + "\n" } }
    onExited: function(exitCode, exitStatus) {
      var error = exitCode === 0 && exitStatus === 0 ? "" : "Could not refresh keybindings"
      if (source.error === error && (error || source.lastOutput === process.collected)) return
      source.error = error
      if (!error) {
        source.rows = Keybindings.parse(process.collected)
        source.lastOutput = process.collected
      }
      source.revision++
    }
  }
}
