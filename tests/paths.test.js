const test = require("node:test")
const assert = require("node:assert/strict")
const Paths = require("../plugin/core/Paths.js")

const envOf = (vars) => (name) => vars[name] || ""

test("defaults follow the XDG base directory spec", () => {
  const p = Paths.resolve(envOf({ HOME: "/home/u", XDG_RUNTIME_DIR: "/run/user/1000" }))
  assert.equal(p.config, "/home/u/.config/oma-cast")
  assert.equal(p.configFile, "/home/u/.config/oma-cast/config.json")
  assert.equal(p.db, "/home/u/.local/share/oma-cast/db")
  assert.equal(p.extensions, "/home/u/.local/share/oma-cast/extensions")
  assert.equal(p.cache, "/home/u/.cache/oma-cast")
  assert.equal(p.logs, "/home/u/.local/state/oma-cast/logs")
  assert.equal(p.runtime, "/run/user/1000/oma-cast")
  assert.equal(p.scriptCommands, "/home/u/.config/oma-cast/script-commands")
  assert.equal(p.fffDb, "/home/u/.local/share/oma-cast/db/fff")
  assert.deepEqual(p.helperCandidates, [
    "/home/u/.local/lib/oma-cast/oma-cast-files",
    "/usr/lib/oma-cast/oma-cast-files"
  ])
})

test("the helper override comes first and is not required to exist", () => {
  const p = Paths.resolve(envOf({ HOME: "/home/u", OMA_CAST_FILES_BIN: "/opt/oma-cast-files" }))
  assert.equal(p.helperCandidates[0], "/opt/oma-cast-files")
  assert.equal(p.helperCandidates.length, 3)
})

test("absolute XDG overrides win, relative ones are ignored", () => {
  const p = Paths.resolve(envOf({
    HOME: "/home/u/",
    XDG_CONFIG_HOME: "/cfg/",
    XDG_DATA_HOME: "relative/data",
    XDG_STATE_HOME: "/st"
  }))
  assert.equal(p.config, "/cfg/oma-cast")
  assert.equal(p.data, "/home/u/.local/share/oma-cast")
  assert.equal(p.state, "/st/oma-cast")
})

test("missing HOME is an error", () => {
  assert.throws(() => Paths.resolve(envOf({})), /HOME is not set/)
})

test("startup creates the persistent dirs and the runtime dir", () => {
  const p = Paths.resolve(envOf({ HOME: "/h", XDG_RUNTIME_DIR: "/r" }))
  assert.deepEqual(Paths.directoriesToCreate(p), [
    "/h/.config/oma-cast", "/h/.local/share/oma-cast/db", "/h/.cache/oma-cast",
    "/h/.local/state/oma-cast/logs", "/h/.local/state/oma-cast/backups", "/r/oma-cast"
  ])
})
