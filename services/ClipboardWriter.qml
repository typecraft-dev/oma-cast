import QtQuick
import Quickshell.Io

// Copies (and optionally pastes) text without putting it in any process's
// argv, where other local users could read it from /proc. The text goes to
// wl-copy on stdin; the paste is Shift+Insert, the keystroke Omarchy's own
// omarchy-clipboard-paste-text sends for clipboard-history entries.
Item {
  id: writer

  property var queued: null
  signal failed(string message)

  function copy(text) { writer.send(String(text), false) }
  function paste(text) { writer.send(String(text), true) }

  function send(text, paste) {
    if (proc.running) { writer.queued = { text: text, paste: paste }; return }
    proc.text = text
    proc.command = ["bash", "-lc", paste ? writer.pasteScript : writer.copyScript]
    proc.stdinEnabled = true
    proc.running = true
  }

  // Constant scripts: no caller data ever reaches the command line.
  readonly property string copyScript: 'exec wl-copy'
  // Wait for the launcher to unmap, as omarchy-clipboard-paste-text does.
  readonly property string pasteScript: 'wl-copy || exit; sleep 0.15; wtype -M shift -k Insert -m shift 2>/dev/null || true'

  Process {
    id: proc
    property string text: ""
    onStarted: {
      write(proc.text)
      proc.text = ""
      proc.stdinEnabled = false
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) writer.failed("Could not copy to the clipboard")
      var next = writer.queued
      writer.queued = null
      if (next) writer.send(next.text, next.paste)
    }
  }
}
