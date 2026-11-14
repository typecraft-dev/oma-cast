import QtQuick
import Quickshell.Io

// Runs bin/omacast-gif-probe for each source, one at a time. The source
// (a path or URL) goes on stdin, never argv.
Item {
  id: importer

  property string directory: ""
  property var queue: []
  readonly property bool busy: proc.running
  readonly property string probe: decodeURIComponent(Qt.resolvedUrl("../bin/omacast-gif-probe").toString().replace(/^file:\/\//, ""))
  // meta is the probe's JSON ({error} on failure); quiet as given to add().
  signal finished(var meta, bool quiet)

  // quiet: an automatic import (a copied X link, a download), which only
  // reports GIFs, not posts or files that have none.
  function add(source, quiet) {
    importer.queue = importer.queue.concat([{ source: String(source), quiet: !!quiet }])
    if (!proc.running) importer.next()
  }

  function next() {
    if (!importer.queue.length || !importer.directory) return
    proc.source = importer.queue[0].source
    proc.quiet = importer.queue[0].quiet
    importer.queue = importer.queue.slice(1)
    proc.out = ""
    proc.stdinEnabled = true
    proc.command = [importer.probe, importer.directory]
    proc.running = true
  }

  Process {
    id: proc
    property string source: ""
    property bool quiet: false
    property string out: ""
    stdout: SplitParser { onRead: function(line) { proc.out += line } }
    onStarted: { write(proc.source.replace(/\n/g, "") + "\n"); proc.source = ""; proc.stdinEnabled = false }
    onExited: function(exitCode) {
      var meta
      try { meta = JSON.parse(proc.out) } catch (e) { meta = { error: "Could not read the GIF" } }
      importer.finished(meta, proc.quiet)
      importer.next()
    }
  }
}
