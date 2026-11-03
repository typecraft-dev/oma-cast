import QtQuick
import Quickshell.Io
import "../core/Migrate.js" as Migrate

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

  property string _lastWritten: ""

  function update(mutator) {
    if (!store.loaded || store.readOnly) return false
    var next = JSON.parse(JSON.stringify(store.doc))
    var result = mutator(next)
    store.doc = result === undefined ? next : result
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
    if (!store.loaded || store.readOnly) return
    var text = Migrate.serialize(store.doc)
    if (text === store._lastWritten) return
    store._lastWritten = text
    file.setText(text)
  }

  function ingest(text) {
    if (store.loaded && !store.readOnly && text === store._lastWritten) return

    var parsed = Migrate.parse(text)
    if (parsed.error) {
      store.readOnly = true
      store.lastError = "unreadable " + store.path + ": " + parsed.error
      store.message("error", store.lastError + " (left untouched; fix or remove it)", null)
      return
    }

    var result
    try {
      result = Migrate.migrate(parsed.doc, store.migrations, store.now())
    } catch (e) {
      store.readOnly = true
      store.lastError = "migration failed for " + store.path + ": " + e
      store.message("error", store.lastError, null)
      return
    }
    if (result.error) {
      store.readOnly = true
      store.lastError = result.error
      store.message("error", store.path + ": " + result.error, null)
      return
    }

    store.readOnly = result.readOnly
    store.lastError = ""
    if (result.readOnly)
      store.message("warning", store.path + " has schemaVersion " + result.from + ", newer than this build; not writing it", null)
    if (result.applied.length > 0)
      store.message("info", "migrated " + store.path, { from: result.from, to: result.to, applied: result.applied })

    store._lastWritten = String(text || "")
    store.doc = result.doc
    store.loaded = true
    if (result.changed) store.write()
    store.changed()
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
        store.readOnly = true
        store.lastError = "cannot read " + store.path + ": " + FileViewError.toString(error)
        store.message("error", store.lastError, null)
      }
    }
    onSaveFailed: function(error) {
      store.message("error", "cannot write " + store.path + ": " + FileViewError.toString(error), null)
    }
  }
}
