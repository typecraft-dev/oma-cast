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
  // Switch Processing Mode / Microphone / Language: setting → {current, options}.
  property var settings: ({})
  signal historyChanged()
  signal settingsLoaded()
  // A selection or a last-dictation fetch finished: style "success"|"failure".
  signal finished(string style, string title)
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

  // Loads a setting's list when its view opens (and again on every open).
  function loadSetting(setting) {
    var def = Superwhisper.SETTINGS[setting]
    if (!def || !source.available) return
    var proc = settingLoader.createObject(source, { setting: setting, command: ["superwhisper"].concat(def.show) })
    proc.running = true
  }

  Component {
    id: settingLoader
    Process {
      id: loader
      property string setting: ""
      stdout: StdioCollector {
        onStreamFinished: {
          var next = Object.assign({}, source.settings)
          next[loader.setting] = Superwhisper.settingOptions(loader.setting, text)
          source.settings = next
          source.settingsLoaded()
        }
      }
      onExited: loader.destroy()
    }
  }

  // Picks a value; the toast or HUD reports the outcome.
  function select(setting, value, label) {
    var proc = selector.createObject(source, { title: label, command: ["superwhisper"].concat(Superwhisper.selectArgv(setting, value)) })
    proc.running = true
  }

  Component {
    id: selector
    Process {
      id: sel
      property string title: ""
      stderr: StdioCollector { id: selErr }
      onExited: function(exitCode) {
        if (exitCode === 0) source.finished("success", sel.title)
        else {
          source.message("warning", "superwhisper " + sel.command.slice(1).join(" ") + " exited " + exitCode + ": " + selErr.text.trim())
          source.finished("failure", "Superwhisper couldn't switch: " + (selErr.text.trim().split("\n").pop() || "exit " + exitCode))
        }
        sel.destroy()
      }
    }
  }

  // The newest dictation with text, read fresh: callback(entry or null).
  property var lastCallbacks: []
  function withLastDictation(callback) {
    source.lastCallbacks = source.lastCallbacks.concat([callback])
    if (!last.running) last.running = true
  }

  Process {
    id: last
    command: ["superwhisper", "history", "list", "--limit", "10"]
    stdout: StdioCollector {
      onStreamFinished: {
        var entries = Superwhisper.parseHistory(text)
        var callbacks = source.lastCallbacks
        source.lastCallbacks = []
        callbacks.forEach(function(cb) { cb(entries.length ? entries[0] : null) })
      }
    }
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
