import QtQuick
import Quickshell.Io
import "../core/Migrate.js" as Migrate
import "../core/Store.js" as Store

// File I/O for core/Store.js, which parses, migrates and decides what to
// write; the macOS app uses the same module.
Item {
  id: store

  required property string path
  required property var migrations
  property bool ready: false
  property var now: function() { return Date.now() }

  property var doc: null
  property bool loaded: false
  property bool readOnly: false
  property string lastError: ""

  signal changed()
  signal message(string level, string text, var metadata)

  readonly property var core: Store.create({
    path: store.path, migrations: store.migrations, Migrate: Migrate,
    now: function() { return store.now() },
    log: function(level, text, metadata) { store.message(level, text, metadata || null) }
  })

  function sync() {
    store.doc = store.core.doc
    store.loaded = store.core.loaded
    store.readOnly = store.core.readOnly
    store.lastError = store.core.lastError
  }

  function update(mutator) {
    if (!store.core.update(mutator)) return false
    store.doc = store.core.doc
    saveTimer.restart()
    store.changed()
    return true
  }

  function flush() {
    if (!saveTimer.running) return
    saveTimer.stop()
    store.write()
  }

  function write() {
    var text = store.core.pendingWrite()
    if (text !== null) file.setText(text)
  }

  function ingest(text) {
    var result = store.core.ingest(text)
    store.sync()
    if (result.write !== null) file.setText(result.write)
    if (result.replaced) store.changed()
  }

  Component.onDestruction: store.flush()

  Timer {
    id: saveTimer
    interval: 250
    onTriggered: store.write()
  }

  FileView {
    id: file
    path: store.ready ? store.path : ""
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: store.ingest(text())
    onFileChanged: reload()
    onLoadFailed: function(error) {
      if (error === FileViewError.FileNotFound) store.ingest("")
      else {
        store.core.refuse("cannot read " + store.path + ": " + FileViewError.toString(error))
        store.sync()
        store.message("error", store.lastError, null)
      }
    }
    onSaveFailed: function(error) {
      store.message("error", "cannot write " + store.path + ": " + FileViewError.toString(error), null)
    }
  }
}
