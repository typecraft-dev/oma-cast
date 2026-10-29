const test = require("node:test")
const assert = require("node:assert/strict")
const T = require("../plugin/core/Translate.js")
const RS = require("../plugin/core/RootSearch.js")
const Schema = require("../plugin/core/Schema.js")
const Migrate = require("../plugin/core/Migrate.js")

test("validText rejects empty text and text over the limit", () => {
  assert.throws(() => T.validText("   "), /Type text to translate/)
  assert.throws(() => T.validText("a".repeat(T.MAX_TEXT + 1)), /under 8000 characters/)
  assert.equal(T.validText("  Hola  "), "Hola")
})

test("a missing target language falls back to English", () => {
  assert.equal(T.target(""), T.DEFAULT_TARGET)
  assert.equal(T.target(null), T.DEFAULT_TARGET)
  assert.equal(T.target("  "), T.DEFAULT_TARGET)
  assert.equal(T.target("French"), "French")
})

test("a missing source language falls back to auto detection", () => {
  assert.equal(T.source(""), T.AUTO)
  assert.equal(T.source(null), T.AUTO)
  assert.equal(T.source("  "), T.AUTO)
  assert.equal(T.source("auto"), T.AUTO)
  assert.equal(T.source("AUTO"), T.AUTO)
  assert.equal(T.source("German"), "German")
})

test("settings migrate to a translate target without losing existing values", () => {
  const fresh = Migrate.migrate(null, Schema.settingsMigrations, 1000)
  assert.equal(fresh.doc.general.translateTargetLanguage, "English")
  assert.equal(fresh.doc.general.navigationBindings, "emacs")

  const v1 = { schemaVersion: 1, general: { navigationBindings: "vim-motions", uiZoom: 1.5 }, commands: {} }
  const upgraded = Migrate.migrate(v1, Schema.settingsMigrations, 2000)
  assert.equal(upgraded.doc.general.translateTargetLanguage, "English")
  assert.equal(upgraded.doc.general.navigationBindings, "vim-motions")
  assert.equal(upgraded.doc.general.uiZoom, 1.5)
})

test("languages match on substrings and map names to translate-shell codes", () => {
  const L = require("../plugin/core/Languages.js")
  assert.ok(L.names().includes("English"))
  assert.deepEqual(L.matches("portu"), ["Portuguese (Brazil)", "Portuguese (Portugal)"])
  assert.equal(L.matches("").length, L.LANGUAGES.length)
  assert.equal(L.codeFor("Portuguese (Brazil)"), "pt-BR")
  assert.equal(L.codeFor("english"), "en")
  assert.ok(L.known("English"))
  assert.ok(!L.known("Klingon"))
  assert.ok(!L.known(""))
  assert.equal(L.codeFor("Klingon"), null)
})

test("detected codes map back to display names", () => {
  const L = require("../plugin/core/Languages.js")
  assert.equal(L.nameFor("es"), "Spanish")
  assert.equal(L.nameFor("DE"), "German")
  assert.equal(L.nameFor("zh"), "Chinese (Simplified)")
  assert.equal(L.nameFor("pt-PT"), "Portuguese (Portugal)")
  assert.equal(L.nameFor("xx"), "xx")
  assert.equal(L.nameFor(""), "")
})

test("the Translate command opens the translate window", () => {
  const translate = RS.BUILTINS.filter((b) => b.id === "builtin:translate")[0]
  assert.ok(translate)
  assert.equal(translate.run.translate, true)
  assert.ok(translate.keywords.includes("translator"))
})
