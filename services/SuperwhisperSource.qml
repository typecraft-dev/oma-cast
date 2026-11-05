import QtQuick
import Quickshell
import Quickshell.Io
import "../core/Superwhisper.js" as Superwhisper

// Superwhisper through its CLI: whether it is installed, its dictation
// history (`superwhisper history list`, JSON), and start/stop.
Item {
  id: source

  // Shown only when Superwhisper is Omarchy's dictation backend (Setup >
  // Defaults > Dictation) and its CLI is installed, the same test Omarchy's
  // own dictation bindings use.
  readonly property bool available: source.installed && source.isDefault
  property bool installed: false
  property bool isDefault: false
  // History is on in Superwhisper and holds at least one dictation.
  property bool hasHistory: false
  property var entries: []
  property double loadedAt: 0
  readonly property bool loading: history.running
  signal historyChanged()
  signal message(string level, string text)

  // Re-checked on every launcher open, so installing or removing it shows up.
  function refresh() { if (!detect.running) detect.running = true }

  Process {
    id: detect
    running: true
    command: ["bash", "-c", "command -v superwhisper >/dev/null || exit 127; superwhisper general show"]
    stdout: StdioCollector {
      onStreamFinished: source.hasHistory = Superwhisper.historyAvailable(text)
    }
    onExited: function(exitCode) { source.installed = exitCode !== 127 }
  }

  FileView {
    path: (Quickshell.env("XDG_CONFIG_HOME") || Quickshell.env("HOME") + "/.config") + "/omarchy/defaults/dictation"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: source.isDefault = text().trim() === "superwhisper"
    onLoadFailed: source.isDefault = false
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
