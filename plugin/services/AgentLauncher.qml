import QtQuick
import Quickshell.Io
import "../core/Agent.js" as Agent

Item {
  id: service
  property bool checking: false
  property var pendingArgv: null
  property string output: ""
  signal prepared(var argv)
  signal failed(string message)

  function start(query) {
    var argv = Agent.launchArgv(query)
    if (service.checking) throw new Error("Agent launch is already being checked")
    service.pendingArgv = argv
    service.output = ""
    service.checking = true
    timeout.restart()
    check.running = true
  }

  function cancel() {
    service.pendingArgv = null
    timeout.stop()
    check.running = false
  }

  Component.onDestruction: service.cancel()

  Timer {
    id: timeout
    interval: 5000
    onTriggered: {
      service.cancel()
      service.failed("Agent launch check timed out. Try again.")
    }
  }

  Process {
    id: check
    command: ["bash", "-lc", Agent.CHECK_SCRIPT]
    stdout: SplitParser {
      onRead: function(line) { service.output = (service.output + line + "\n").slice(0, 400) }
    }
    onExited: function(exitCode, exitStatus) {
      timeout.stop()
      var argv = service.pendingArgv
      service.pendingArgv = null
      service.checking = false
      if (!argv) return
      if (exitCode !== 0 || exitStatus !== 0) {
        service.failed(service.output.trim() || "Could not check the default agent. Update Omarchy and try again.")
        return
      }
      service.prepared(argv)
    }
  }
}
