import QtQuick
import Quickshell
import Quickshell.Io
import "../core/FileSearch.js" as FileSearch

// Live file search under $HOME (core/FileSearch.js). request() is cheap and
// safe to call on every keystroke: it re-filters the last results at once,
// then runs fd after a short pause and bumps `revision` when it answers.
Item {
  id: source

  readonly property string home: Quickshell.env("HOME") || ""
  property string wanted: ""          // last query asked for
  property string answered: ""        // query `results` were made for
  property var results: []            // candidates, best first, up to VIEW_LIMIT
  property var byId: ({})             // current and previous rows, for actions on a row just replaced
  property bool loading: debounce.running || proc.running
  property int revision: 0

  signal message(string level, string text, var metadata)

  function request(query) {
    var q = String(query || "").trim()
    if (q === source.wanted) return
    source.wanted = q
    if (!FileSearch.searchable(q)) { source.publish(q, []); return }
    debounce.restart()
  }

  // Rows for a query: fresh ones once fd has answered, until then the
  // previous answer re-filtered, so typing does not make the section flicker.
  function rowsFor(query, limit) {
    var q = String(query || "").trim()
    if (!FileSearch.searchable(q)) return []
    var rows = q === source.answered ? source.results : FileSearch.rank(source.results, q, source.home, limit)
    return rows.slice(0, limit)
  }

  function lookup(id) { return source.byId[id] || null }

  function publish(q, rows) {
    var next = ({})
    for (var i = 0; i < source.results.length; i++) next[source.results[i].id] = source.results[i]
    for (var j = 0; j < rows.length; j++) next[rows[j].id] = rows[j]
    source.byId = next
    source.results = rows
    source.answered = q
    source.revision++
  }

  function start() {
    if (proc.running) { proc.running = false; return }   // onExited starts the newest query
    proc.query = source.wanted
    proc.command = FileSearch.fdArgv(proc.query, source.home)
    proc.running = true
  }

  Timer {
    id: debounce
    interval: 60    // [D]
    onTriggered: source.start()
  }

  Process {
    id: proc
    property string query: ""
    stdout: StdioCollector { id: out }
    onExited: function(exitCode, exitStatus) {
      if (proc.query !== source.wanted) {
        if (FileSearch.searchable(source.wanted)) source.start()
        return
      }
      if (exitCode !== 0 && exitCode !== 1) source.message("warning", "fd exited with " + exitCode, null)
      source.publish(proc.query, FileSearch.parse(out.text, proc.query, source.home, FileSearch.VIEW_LIMIT))
    }
  }
}
