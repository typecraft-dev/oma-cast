import QtQuick
import Quickshell
import Quickshell.Io
import "../core/Superwhisper.js" as Superwhisper

// Superwhisper through its CLI: whether it is installed, its dictation
// history (`superwhisper history list`, JSON), and start/stop.
Item {
  id: source

  property bool available: false
  property var entries: []
  property double loadedAt: 0
  readonly property bool loading: history.running
  signal historyChanged()
  signal message(string level, string text)

  Process {
    running: true
    command: ["bash", "-c", "command -v superwhisper"]
    onExited: function(exitCode) { source.available = exitCode === 0 }
  }

  // The history view asks on every search; reload at most every 5 s.
  function refreshIfStale() {
    if (!source.available || history.running || Date.now() - source.loadedAt < 5000) return
    history.running = true
  }

  Process {
    id: history
    command: ["superwhisper", "history", "list", "--limit", String(Superwhisper.HISTORY_LIMIT)]
    stdout: StdioCollector {
      onStreamFinished: {
        source.entries = Superwhisper.parseHistory(text)
        source.loadedAt = Date.now()
        source.historyChanged()
      }
    }
    onExited: function(exitCode) { if (exitCode !== 0) source.message("warning", "superwhisper history list exited " + exitCode) }
  }

  // Starts or stops dictation once the launcher has unmapped, so the
  // dictation lands in the window the user came from, not in omacast.
  function run(verb) {
    if (verb !== "start" && verb !== "stop") throw new Error("Unknown Superwhisper command " + verb)
    Quickshell.execDetached(["bash", "-c",
      'for _ in $(seq 20); do'
      + ' hyprctl layers -j 2>/dev/null | grep -q \'"namespace": *"omacast"\' || break;'
      + ' sleep 0.05;'
      + ' done;'
      + ' exec superwhisper "$1"', "omacast-superwhisper", verb])
  }
}
