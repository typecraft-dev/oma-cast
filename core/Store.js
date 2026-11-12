// One versioned JSON document on disk (SPEC §2.0 data layer): parse,
// migrate, refuse to overwrite an unreadable or newer file, and decide what
// to write. Shared by services/JsonStore.qml and the macOS app; each host
// only reads and writes the file and runs the save timer.
//
//   var s = Store.create({ path, migrations, now, log, Migrate })
//   s.ingest(text)        after a read; "" when the file is missing.
//                         Returns { replaced, write } (write: text or null)
//   s.update(mutator)     false when not loaded or read-only
//   s.pendingWrite()      text to save now, or null when nothing changed
//   s.refuse(message)     the host could not read the file; stay read-only
//   s.doc, s.loaded, s.readOnly, s.lastError

function create(opts) {
  var Migrate = opts.Migrate
  var log = opts.log || function() {}
  var now = opts.now || function() { return Date.now() }
  var s = { path: opts.path, doc: null, loaded: false, readOnly: false, lastError: "" }
  var lastWritten = ""

  function fail(message, note) {
    s.readOnly = true
    s.lastError = message
    log("error", message + (note || ""))
    return { replaced: false, write: null }
  }

  s.ingest = function(text) {
    var raw = String(text || "")
    // Our own write coming back through a file watch.
    if (s.loaded && !s.readOnly && raw === lastWritten) return { replaced: false, write: null }
    var parsed = Migrate.parse(raw)
    if (parsed.error) return fail("unreadable " + s.path + ": " + parsed.error, " (left untouched; fix or remove it)")
    var result
    try {
      result = Migrate.migrate(parsed.doc, opts.migrations, now())
    } catch (e) {
      return fail("migration failed for " + s.path + ": " + e)
    }
    if (result.error) return fail(s.path + ": " + result.error)
    s.readOnly = result.readOnly
    s.lastError = ""
    if (result.readOnly) log("warning", s.path + " has schemaVersion " + result.from + ", newer than this build; not writing it")
    if (result.applied.length > 0) log("info", "migrated " + s.path, { from: result.from, to: result.to, applied: result.applied })
    lastWritten = raw
    s.doc = result.doc
    s.loaded = true
    return { replaced: true, write: result.changed ? s.pendingWrite() : null }
  }

  // The host could not read the file: never write over it.
  s.refuse = function(message) {
    s.readOnly = true
    s.lastError = message
  }

  s.update = function(mutator) {
    if (!s.loaded || s.readOnly) return false
    var next = JSON.parse(JSON.stringify(s.doc))
    var result = mutator(next)
    s.doc = result === undefined ? next : result
    return true
  }

  s.pendingWrite = function() {
    if (!s.loaded || s.readOnly) return null
    var text = Migrate.serialize(s.doc)
    if (text === lastWritten) return null
    lastWritten = text
    return text
  }

  return s
}

if (typeof module !== "undefined") module.exports = { create: create }
