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

  function copy(text, mime) { writer.send({ text: String(text), mime: mime || "", paste: false }) }
  function paste(text, mime) { writer.send({ text: String(text), mime: mime || "", paste: true }) }
  // A file of ours (a Clipboard History image or long text): its path and
  // MIME type are on the command line, never its contents.
  function copyFile(path, mime, paste) { writer.send({ file: String(path), mime: String(mime), paste: !!paste }) }

  function send(item) {
    if (proc.running) { writer.queued = item; return }
    proc.text = item.file ? "" : item.text
    proc.command = ["bash", "-lc", item.paste ? writer.pasteScript : writer.copyScript, "omacast-copy", item.mime || "", item.file || ""]
    proc.stdinEnabled = !item.file
    proc.running = true
  }

  // Constant scripts: no caller text ever reaches the command line. $1 is a
  // MIME type, $2 a file to copy instead of stdin.
  readonly property string copyScript: 'if [[ $2 ]]; then exec wl-copy ${1:+--type "$1"} <"$2"; else exec wl-copy ${1:+--type "$1"}; fi'
  // Wait for the launcher to unmap, as omarchy-clipboard-paste-text does.
  // Terminals take Ctrl+Shift+V (SPEC §5.3): most map Shift+Insert to the
  // primary selection, and Herdr passes it to the pane's program.
  readonly property string pasteScript: 'if [[ $2 ]]; then wl-copy ${1:+--type "$1"} <"$2"; else wl-copy ${1:+--type "$1"}; fi || exit; sleep 0.15
class=$(hyprctl activewindow -j 2>/dev/null | jq -r ".class // empty" 2>/dev/null)
case ${class,,} in
  *alacritty*|*kitty*|foot|footclient|*wezterm*|*ghostty*|*konsole*|*gnome-terminal*|*ptyxis*|*herdr*)
    wtype -M ctrl -M shift -k v -m shift -m ctrl 2>/dev/null || true ;;
  *) wtype -M shift -k Insert -m shift 2>/dev/null || true ;;
esac'

  Process {
    id: proc
    property string text: ""
    onStarted: {
      if (!proc.stdinEnabled) return
      write(proc.text)
      proc.text = ""
      proc.stdinEnabled = false
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) writer.failed("Could not copy to the clipboard")
      var next = writer.queued
      writer.queued = null
      if (next) writer.send(next)
    }
  }
}
