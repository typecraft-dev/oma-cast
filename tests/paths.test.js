const test = require("node:test")
const assert = require("node:assert/strict")
const Paths = require("../core/Paths.js")

const envOf = (vars) => (name) => vars[name] || ""

test("defaults follow the XDG base directory spec", () => {
  const p = Paths.resolve(envOf({ HOME: "/home/u", XDG_RUNTIME_DIR: "/run/user/1000" }))
  assert.equal(p.config, "/home/u/.config/omacast")
  assert.equal(p.configFile, "/home/u/.config/omacast/config.json")
  assert.equal(p.db, "/home/u/.local/share/omacast/db")
  assert.equal(p.extensions, "/home/u/.local/share/omacast/extensions")
  assert.equal(p.cache, "/home/u/.cache/omacast")
  assert.equal(p.logs, "/home/u/.local/state/omacast/logs")
  assert.equal(p.runtime, "/run/user/1000/omacast")
  assert.equal(p.scriptCommands, "/home/u/.config/omacast/script-commands")
})

test("absolute XDG overrides win, relative ones are ignored", () => {
  const p = Paths.resolve(envOf({
    HOME: "/home/u/",
    XDG_CONFIG_HOME: "/cfg/",
    XDG_DATA_HOME: "relative/data",
    XDG_STATE_HOME: "/st"
  }))
  assert.equal(p.config, "/cfg/omacast")
  assert.equal(p.data, "/home/u/.local/share/omacast")
  assert.equal(p.state, "/st/omacast")
})

test("missing HOME is an error", () => {
  assert.throws(() => Paths.resolve(envOf({})), /HOME is not set/)
})

test("startup creates the persistent dirs and the runtime dir", () => {
  const p = Paths.resolve(envOf({ HOME: "/h", XDG_RUNTIME_DIR: "/r" }))
  assert.deepEqual(Paths.directoriesToCreate(p), [
    "/h/.config/omacast", "/h/.local/share/omacast/db", "/h/.local/share/omacast/clipboard", "/h/.local/share/omacast/gifs", "/h/.cache/omacast",
    "/h/.local/state/omacast/logs", "/h/.local/state/omacast/backups", "/r/omacast"
  ])
})

test("directories under the old oma-cast name move to omacast", () => {
  const p = Paths.resolve(envOf({ HOME: "/h", XDG_CONFIG_HOME: "/cfg" }))
  assert.deepEqual(Paths.legacyMoves(p), [
    ["/cfg/oma-cast", "/cfg/omacast"],
    ["/h/.local/share/oma-cast", "/h/.local/share/omacast"],
    ["/h/.cache/oma-cast", "/h/.cache/omacast"],
    ["/h/.local/state/oma-cast", "/h/.local/state/omacast"]
  ])
})
