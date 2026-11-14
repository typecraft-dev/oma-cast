import QtQuick
import Quickshell.Io

// Saves every GIF downloaded into the XDG download folder to the GIF Library
// [D]. One inotifywait watches the folder (not subfolders). Browsers write
// to a .crdownload/.part file and rename it when done, so moved_to catches
// the finished file; close_write catches tools that write in place. Empty
// files (Firefox's placeholder) are skipped. Paths come out as JSON lines.
Item {
  id: watcher

  property bool enabled: true
  signal downloaded(string path)
  signal message(string level, string text)

  readonly property string script: '
dir=$(xdg-user-dir DOWNLOAD 2>/dev/null)
# xdg-user-dir answers $HOME when the folder is not set; never watch $HOME.
[[ -n $dir && $dir != "$HOME" && -d $dir ]] || dir=$HOME/Downloads
[[ -d $dir ]] || exit 0
# pdeathsig: inotifywait ends with this bash, not at its next event.
setpriv --pdeathsig TERM inotifywait -m -q -e close_write,moved_to --format "%w%f" -- "$dir" | while IFS= read -r f; do
  [[ ${f,,} == *.gif && -s $f ]] && jq -cn --arg path "$f" "{path: \\$path}"
done
'

  onEnabledChanged: watcher.restart()
  Component.onCompleted: watcher.restart()

  function restart() {
    watch.running = false
    if (watcher.enabled && !reap.running) reap.running = true
  }

  // Reap a watcher left by an earlier instance of the plugin (omacast reload).
  Process {
    id: reap
    command: ["pkill", "-f", "^bash -c .* omacast-downloads$"]
    onExited: if (watcher.enabled) watch.running = true
  }

  Process {
    id: watch
    command: ["setpriv", "--pdeathsig", "TERM", "bash", "-c", watcher.script, "omacast-downloads"]
    stdout: SplitParser {
      onRead: function(line) {
        try { watcher.downloaded(JSON.parse(line).path) }
        catch (e) { watcher.message("warning", "unreadable download line: " + e) }
      }
    }
    onExited: function(exitCode) {
      // No inotifywait (inotify-tools) or no download folder: stay off.
      if (exitCode === 0 || exitCode === 127) { watcher.message("info", "downloads watcher off (exit " + exitCode + ")"); return }
      if (!watcher.enabled) return
      watcher.message("warning", "downloads watcher exited (" + exitCode + "); restarting")
      restartTimer.restart()
    }
  }

  Timer {
    id: restartTimer
    interval: 5000
    onTriggered: if (watcher.enabled && !watch.running) watch.running = true
  }
}
