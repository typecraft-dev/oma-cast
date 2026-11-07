import QtQuick
import Quickshell
import Quickshell.Io
import "../core/Themes.js" as Themes

// Omarchy's themes for Switch Theme: the list from Omarchy's own picker
// (refreshed whenever the view opens), the current theme, and applying one.
Item {
  id: source

  property var themes: []
  property string current: ""
  readonly property bool loading: rows.running
  signal loaded()

  function refresh() { if (!rows.running) rows.running = true }

  // A slug from the list, never typed text.
  function apply(slug) { Quickshell.execDetached(["omarchy-theme-set", slug]) }

  Process {
    id: rows
    command: ["omarchy-theme-switcher", "--print-rows"]
    stdout: StdioCollector {
      onStreamFinished: {
        source.themes = Themes.parseRows(text)
        source.loaded()
      }
    }
  }

  FileView {
    path: (Quickshell.env("XDG_STATE_HOME") || Quickshell.env("HOME") + "/.local/state") + "/omarchy/current/theme.name"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: { source.current = text().trim(); source.loaded() }
  }
}
