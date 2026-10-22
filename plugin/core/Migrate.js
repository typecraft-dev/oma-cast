
function validateMigrations(migrations) {
  for (var i = 0; i < migrations.length; i++) {
    var m = migrations[i]
    if (!m || typeof m.up !== "function") throw new Error("Migration " + i + " has no up()")
    if (m.version !== i + 1) throw new Error("Migration versions must be 1.." + migrations.length + " in order; got " + m.version + " at " + i)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(m.name || ""))) throw new Error("Migration " + m.version + " needs a kebab-case name")
  }
}

function latestVersion(migrations) {
  return migrations.length
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function parse(text) {
  var raw = String(text || "").trim()
  if (!raw) return { doc: null, error: "" }
  try {
    var value = JSON.parse(raw)
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { doc: null, error: "document is not a JSON object" }
    return { doc: value, error: "" }
  } catch (e) {
    return { doc: null, error: String(e && e.message || e) }
  }
}

function migrate(doc, migrations, now) {
  validateMigrations(migrations)
  var latest = latestVersion(migrations)
  var stamp = typeof now === "number" ? now : Date.now()
  var current = doc ? clone(doc) : {}
  var from = doc ? Number(current.schemaVersion || 0) : 0

  if (!isFinite(from) || from < 0 || Math.floor(from) !== from)
    return { doc: null, from: from, to: from, applied: [], changed: false, readOnly: true, error: "invalid schemaVersion " + current.schemaVersion }

  if (from > latest)
    return { doc: current, from: from, to: from, applied: [], changed: false, readOnly: true, error: "" }

  var history = Array.isArray(current.schemaHistory) ? current.schemaHistory : []
  var applied = []
  for (var v = from + 1; v <= latest; v++) {
    var m = migrations[v - 1]
    // `ctx.from` is the document's version before this migrate() call, so a
    // migration can tell a fresh document (0) from an upgrade (1, 2, …).
    var next = m.up(current, { from: from, version: v })
    if (next !== undefined) current = next
    if (!current || typeof current !== "object") throw new Error("Migration " + v + " (" + m.name + ") returned no document")
    history = history.concat([{ version: v, name: m.name, appliedAt: stamp }])
    applied.push(m.name)
  }

  current.schemaVersion = Math.max(from, latest)
  current.schemaHistory = history
  return { doc: current, from: from, to: current.schemaVersion, applied: applied, changed: applied.length > 0, readOnly: false, error: "" }
}

function serialize(doc) {
  return JSON.stringify(doc, null, 2) + "\n"
}

if (typeof module !== "undefined") {
  module.exports = {
    validateMigrations: validateMigrations,
    latestVersion: latestVersion,
    parse: parse,
    migrate: migrate,
    serialize: serialize
  }
}
