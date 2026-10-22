const test = require("node:test")
const assert = require("node:assert/strict")
const Migrate = require("../plugin/core/Migrate.js")
const Schema = require("../plugin/core/Schema.js")

const migrations = [
  { version: 1, name: "init", up: (d) => { d.items = []; return d } },
  { version: 2, name: "add-flag", up: (d) => { d.flag = true } }
]

test("a new document runs every migration and records history", () => {
  const r = Migrate.migrate(null, migrations, 1000)
  assert.equal(r.from, 0)
  assert.equal(r.to, 2)
  assert.ok(r.changed)
  assert.deepEqual(r.applied, ["init", "add-flag"])
  assert.deepEqual(r.doc, {
    items: [], flag: true, schemaVersion: 2,
    schemaHistory: [{ version: 1, name: "init", appliedAt: 1000 }, { version: 2, name: "add-flag", appliedAt: 1000 }]
  })
})

test("only pending migrations run, and the input is not mutated", () => {
  const v1 = { items: [1], schemaVersion: 1, schemaHistory: [{ version: 1, name: "init", appliedAt: 5 }] }
  const before = JSON.stringify(v1)
  const r = Migrate.migrate(v1, migrations, 9)
  assert.deepEqual(r.applied, ["add-flag"])
  assert.deepEqual(r.doc.items, [1])
  assert.equal(r.doc.schemaHistory.length, 2)
  assert.equal(JSON.stringify(v1), before)
})

test("an up-to-date document is unchanged", () => {
  const latest = Migrate.migrate(null, migrations, 1).doc
  const r = Migrate.migrate(latest, migrations, 2)
  assert.equal(r.changed, false)
  assert.deepEqual(r.doc, latest)
})

test("a document from a newer build is read-only and untouched", () => {
  const future = { schemaVersion: 7, items: ["x"] }
  const r = Migrate.migrate(future, migrations, 1)
  assert.equal(r.readOnly, true)
  assert.equal(r.changed, false)
  assert.deepEqual(r.doc, future)
})

test("an invalid schemaVersion is reported, not migrated", () => {
  const r = Migrate.migrate({ schemaVersion: "two" }, migrations, 1)
  assert.equal(r.readOnly, true)
  assert.match(r.error, /invalid schemaVersion/)
})

test("migration lists must be numbered 1..n with names", () => {
  assert.throws(() => Migrate.validateMigrations([{ version: 2, name: "x", up() {} }]), /in order/)
  assert.throws(() => Migrate.validateMigrations([{ version: 1, name: "Bad Name", up() {} }]), /kebab-case/)
  assert.throws(() => Migrate.validateMigrations([{ version: 1, name: "x" }]), /no up/)
})

test("parse separates new, valid, and unreadable files", () => {
  assert.deepEqual(Migrate.parse(""), { doc: null, error: "" })
  assert.deepEqual(Migrate.parse('{"a":1}'), { doc: { a: 1 }, error: "" })
  assert.match(Migrate.parse("{oops").error, /JSON|Expected|Unexpected/)
  assert.match(Migrate.parse("[1]").error, /not a JSON object/)
})

test("serialize round-trips through parse", () => {
  const doc = Migrate.migrate(null, migrations, 3).doc
  assert.deepEqual(Migrate.parse(Migrate.serialize(doc)).doc, doc)
})

test("shipped settings migrations are valid and use Raycast defaults", () => {
  const r = Migrate.migrate(null, Schema.settingsMigrations, 1)
  assert.equal(r.doc.schemaVersion, Schema.settingsMigrations.length)
  assert.equal(r.doc.general.popToRootTimeout, 90)
  assert.equal(r.doc.general.escapeKeyBehavior, "pop-back-or-close")
  assert.equal(r.doc.general.windowPresentationMode, "mouse-screen")
  assert.equal(r.doc.general.uiZoom, 1)
  assert.deepEqual(r.doc.commands, {})
})

test("migrations receive the original document version", () => {
  const seen = []
  const list = [
    { version: 1, name: "one", up(doc) { doc.one = true } },
    { version: 2, name: "two", up(doc, ctx) { seen.push(ctx); doc.two = true } }
  ]
  Migrate.migrate({ schemaVersion: 1, one: true }, list, 1)
  assert.deepEqual(seen, [{ from: 1, version: 2 }])
})

test("file search is on for a new install and off for an existing v1 doc", () => {
  const fresh = Migrate.migrate(null, Schema.settingsMigrations, 1).doc
  assert.equal(fresh.files.enabled, true)
  assert.equal(fresh.files.root, "~")
  assert.equal(fresh.files.includeInRootSearch, true)
  assert.equal(fresh.files.followSymlinks, false)

  const v1 = Migrate.migrate(null, [Schema.settingsMigrations[0]], 1).doc
  const upgraded = Migrate.migrate(v1, Schema.settingsMigrations, 2).doc
  assert.equal(upgraded.files.enabled, false)

  v1.files = { enabled: true, root: "/tmp/work" }
  const explicit = Migrate.migrate(v1, Schema.settingsMigrations, 3).doc
  assert.equal(explicit.files.enabled, true)
  assert.equal(explicit.files.root, "/tmp/work")
})

test("config keeps known keys of the right type and drops the rest", () => {
  assert.deepEqual(Schema.withConfigDefaults(null), Schema.configDefaults)
  const c = Schema.withConfigDefaults({ logLevel: "debug", keepVisibleOnFocusLoss: "yes", extra: 1 })
  assert.equal(c.logLevel, "debug")
  assert.equal(c.keepVisibleOnFocusLoss, false)
  assert.equal(c.extra, undefined)
})
