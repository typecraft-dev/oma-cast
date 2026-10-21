import QtQuick
import Quickshell
import Quickshell.Io

// The screenshots in Omarchy's screenshot folder, newest first, and the saved
// versions of each one. A screenshot editor that keeps versions puts them in
// <folder>/.edits/<name>/ (original.png, edit-<date>.png); without one the
// list just has no versions. [D] Refreshed on every open, in the background.
Item {
  id: source

  // Same folder rule as omarchy-capture-screenshot.
  readonly property string folder: Quickshell.env("OMARCHY_SCREENSHOT_DIR") || (Quickshell.env("HOME") + "/Pictures")
  readonly property string editor: Quickshell.env("OMARCHY_SCREENSHOT_EDITOR") || "tensaku-edit"

  // [{ path, name, modifiedMs, versions: [{ path, name, modifiedMs }] }]
  property var shots: []
  property int revision: 0

  signal message(string level, string text, var metadata)

  Component.onCompleted: refresh()

  function refresh() {
    if (listProc.running) return
    listProc.running = true
  }

  // One line per file: kind, mtime in seconds, size in bytes, path. Versions are sorted by
  // the caller, so find's order doesn't matter.
  Process {
    id: listProc
    command: ["bash", "-c",
      'cd -- "$1" 2>/dev/null || exit 0\n' +
      'find . -maxdepth 1 -type f \\( -iname "*.png" -o -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.webp" \\) -printf "shot\\t%T@\\t%s\\t%f\\n"\n' +
      '[[ -d .edits ]] && find .edits -mindepth 2 -maxdepth 2 -type f -iname "*.png" -printf "version\\t%T@\\t%s\\t%P\\n"\n' +
      'exit 0',
      "bash", source.folder]
    stdout: StdioCollector {
      onStreamFinished: source.parse(text)
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) source.message("warning", "could not list " + source.folder, { exitCode: exitCode })
    }
  }

  function parse(text) {
    var byName = {}, shots = [], versions = {}
    var lines = String(text || "").split("\n")
    for (var i = 0; i < lines.length; i++) {
      var parts = lines[i].split("\t")
      if (parts.length < 4) continue
      var ms = Math.round(parseFloat(parts[1]) * 1000)
      var bytes = parseInt(parts[2], 10) || 0
      var rel = parts.slice(3).join("\t")
      if (parts[0] === "shot") {
        var shot = { path: source.folder + "/" + rel, name: rel, modifiedMs: ms, bytes: bytes, versions: [] }
        shots.push(shot)
        byName[rel.replace(/\.[^.]+$/, "")] = shot
      } else {
        var slash = rel.indexOf("/")
        var stem = rel.slice(0, slash)
        ;(versions[stem] = versions[stem] || []).push({ path: source.folder + "/.edits/" + rel, name: rel.slice(slash + 1), modifiedMs: ms, bytes: bytes })
      }
    }
    for (var stem2 in versions) {
      if (!byName[stem2]) continue
      // The untouched original first, then each saved edit, oldest first.
      byName[stem2].versions = versions[stem2].sort(function(a, b) {
        if (a.name === "original.png") return -1
        if (b.name === "original.png") return 1
        // edit-<date>.png, then edit-<date>-2.png for a second save that second.
        var ka = a.name.replace(/(\d\d)\.png$/, "$1-1.png"), kb = b.name.replace(/(\d\d)\.png$/, "$1-1.png")
        return ka < kb ? -1 : 1
      })
    }
    source.shots = shots.sort(function(a, b) { return b.modifiedMs - a.modifiedMs })
    source.revision++
  }
}
