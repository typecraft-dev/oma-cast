import QtQuick
import Quickshell.Io
import "../core/FileSearch.js" as FileSearch

// The listing that file search matches against (core/FileSearch.js). fd
// lists the home directory with fixed arguments only: the query is matched
// in-process and never reaches an argv. A refresh takes ~55 ms for ~25k
// entries, so it reruns each time the launcher opens, if older than
// maxAgeMs, instead of keeping an index and an inotify watcher [D].
Item {
  id: index

  property string home: ""
  property int maxAgeMs: 30000
  property var entries: []
  property double refreshedAt: 0
  property bool available: true
  signal message(string level, string text, var metadata)

  // Build output, caches and environments that fd's ignore files miss in
  // projects that are not git repositories (SPEC §8.6 default excludes).
  readonly property var excludes: ["node_modules", "__pycache__", ".venv", "venv", "site-packages", "target", ".cache", ".git"]

  function refresh() {
    if (!index.home || !index.available || lister.running) return
    if (Date.now() - index.refreshedAt < index.maxAgeMs) return
    lister.running = true
  }

  Process {
    id: lister
    command: {
      // Bash turns a missing fd into exit 127 instead of a failed start.
      var argv = ["bash", "-c", 'command -v fd >/dev/null || exit 127; exec "$@"', "omacast-files",
        "fd", "--type", "f", "--type", "d", "--absolute-path"]
      for (var i = 0; i < index.excludes.length; i++) argv.push("--exclude", index.excludes[i])
      return argv.concat([".", index.home, "--exec-batch", "stat", "--printf", "%F|%Y|%s|%n\\0"])
    }
    stdout: StdioCollector {
      onStreamFinished: {
        var t0 = Date.now()
        index.entries = FileSearch.parseListing(text, index.home)
        index.refreshedAt = Date.now()
        index.message("debug", "listed " + index.entries.length + " files", { parseMs: index.refreshedAt - t0 })
      }
    }
    onExited: function(exitCode) {
      // 127: fd is not installed. File search then stays off until the
      // shell reloads the plugin, instead of failing on every open.
      if (exitCode === 127) {
        index.available = false
        index.message("warning", "fd not found; file search is off", null)
      } else if (exitCode !== 0) {
        index.message("warning", "file listing exited with " + exitCode, null)
      }
    }
  }
}
