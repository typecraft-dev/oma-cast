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
      command: ["bash", "-lc", 'cd -- "$1" || exit; shift; exec "$@" </dev/null 2>&1', "script", command.cwd, command.path].concat(args)
    })
    proc.running = true
  }

  Component {
    id: processComponent
    Process {
      id: proc
      property var script: null
      // Exit and end of output arrive in either order; report after both.
      property var exitCode: null
      property var output: null
      function report() {
        if (proc.exitCode === null || proc.output === null) return
        runner.finished(proc.script, ScriptCommands.outcome(proc.script, proc.exitCode, proc.output))
        proc.destroy()
      }
      stdout: StdioCollector { onStreamFinished: { proc.output = text; proc.report() } }
      onExited: function(code) { proc.exitCode = code; proc.report() }
    }
  }
}
