import QtQuick
import Quickshell.Io
import "../core/ScriptCommands.js" as ScriptCommands

// Scans the script commands folder (non-recursive; ref 03 §5 discovery):
// executable regular files, 1 byte to 2 MB, no ".template." in the name.
// Only the first 60 lines are read; headers live at the top.
Item {
  id: source

  property string directory: ""
  property var commands: []
  property int revision: 0

  signal message(string level, string text, var metadata)

  function refresh() {
    if (!source.directory || scan.running) return
    scan.command = ["bash", "-c", source.scanScript, "scan", source.directory]
    scan.running = true
  }

  readonly property string scanScript: 'for f in "$1"/*; do '
    + '[[ -f $f && -x $f && $f != *.template.* ]] || continue; '
    + 's=$(stat -c %s -- "$f"); (( s > 0 && s <= 2097152 )) || continue; '
    + 'printf "\\036%s\\n" "$f"; head -n 60 -- "$f"; done'

  Process {
    id: scan
    stdout: StdioCollector {
      onStreamFinished: {
        var next = []
        var files = ScriptCommands.splitScan(text)
        for (var i = 0; i < files.length; i++) {
          var r = ScriptCommands.parse(files[i].text, files[i].path)
          if (r.command) next.push(r.command)
          else source.message("warning", "skipping " + files[i].path + ": " + r.error, null)
        }
        if (JSON.stringify(next) === JSON.stringify(source.commands)) return
        source.commands = next
        source.revision++
      }
    }
  }
}
