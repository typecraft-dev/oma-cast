const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const Agent = require("../plugin/core/Agent.js")

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oma-cast-agent-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const script = (name, source) => fs.writeFileSync(path.join(dir, name), "#!/bin/bash\n" + source, { mode: 0o700 })
  for (const tool of ["omarchy-agent", "omarchy-agent-prompt", "omarchy-launch-tui", "uwsm-app", "codex"]) script(tool, "exit 0\n")
  script("omarchy-default-agent", 'printf "%s" "${TEST_AGENT-codex}"\n')
  script("xdg-terminal-exec", '[[ $1 == --print-id ]] || exit 9\nprintf "%s" "${TEST_TERMINAL-foot.desktop}"\n')
  const env = { ...process.env, PATH: dir }
  return { dir, env, script, check: extra => spawnSync("/bin/bash", ["-c", Agent.CHECK_SCRIPT], { env: { ...env, ...extra }, encoding: "utf8" }) }
}

test("preflight accepts configured agents and terminal providers without starting a session", t => {
  const f = fixture(t)
  f.script("omarchy-agent", "exit 99\n")
  for (const terminal of ["foot.desktop", "com.mitchellh.ghostty.desktop", "kitty.desktop", "Alacritty.desktop"]) {
    const r = f.check({ TEST_TERMINAL: terminal })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(r.stdout, "")
  }
})

test("preflight distinguishes missing tooling, default agent, installation and terminal", t => {
  const f = fixture(t)
  for (const [env, message] of [
    [{ TEST_AGENT: "" }, /Choose a default agent/],
    [{ TEST_AGENT: "not-installed" }, /default agent is not installed/],
    [{ TEST_TERMINAL: "" }, /default terminal/]
  ]) {
    const r = f.check(env)
    assert.equal(r.status, 1)
    assert.match(r.stdout, message)
  }
  fs.unlinkSync(path.join(f.dir, "omarchy-agent-prompt"))
  assert.match(f.check().stdout, /missing omarchy-agent-prompt/)
})

test("questions remain one literal argument, including CLI flags and shell metacharacters", t => {
  const f = fixture(t)
  f.script("omarchy-agent", '[[ $# == 2 && $1 == --prompt ]] || exit 8\nprintf "%s" "$2"\n')
  const marker = path.join(f.dir, "must-not-exist")
  for (const prompt of ["--inline", "--pick", "--prompt", "  Why?  ", 'Quotes: "hello" and \'hi\'', "line one\nline two 🚀", `$(touch ${marker}); \`touch ${marker}\`; >${marker}`]) {
    const argv = Agent.launchArgv(prompt)
    const r = spawnSync("/bin/bash", ["-c", 'exec "$@"', "bash", ...argv], { env: f.env, encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, prompt)
    assert.ok(!fs.existsSync(marker))
  }
})

test("empty, NUL and oversized prompts fail before any process starts", () => {
  for (const query of [null, undefined, "", " \n\t "]) assert.throws(() => Agent.launchArgv(query), /Type a question/)
  assert.throws(() => Agent.launchArgv("a\0b"), /NUL/)
  assert.throws(() => Agent.launchArgv("x".repeat(16385)), /characters/)
  assert.equal(Agent.launchArgv("x".repeat(16384))[2].length, 16384)
})
