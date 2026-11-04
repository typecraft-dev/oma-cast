import QtQuick
import Quickshell.Io
import "../core/ScriptCommands.js" as ScriptCommands

// Runs one script command per Process: the file itself (it needs +x and a
// shebang), from its currentDirectoryPath, under a login shell for the
// user's PATH (ref 03 §5 "Execution"). stdin is closed, as in Raycast.
Item {
  id: runner

  signal finished(var command, var result)

  // Arguments reach the script as $1..$3, so they are in its argv: that is
  // the Script Commands interface, and the script is the user's own [D].
  function run(command, args) {
    var proc = processComponent.createObject(runner, {
      script: command,
      command: ["bash", "-lc", 'cd -- "$1" || exit; shift; exec "$@" </dev/null', "script", command.cwd, command.path].concat(args)
    })
    proc.running = true
  }

  Component {
    id: processComponent
    Process {
      id: proc
      property var script: null
      stdout: StdioCollector { id: out }
      stderr: StdioCollector { id: err }
      onExited: function(exitCode) {
        // The collectors finish on the next tick; read them after it.
        Qt.callLater(function() {
          runner.finished(proc.script, ScriptCommands.outcome(proc.script, exitCode, out.text, err.text))
          proc.destroy()
        })
      }
    }
  }
}
