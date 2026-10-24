var FALLBACK_ID = "fallback:agent"

function launchArgv(query) {
  var prompt = String(query === undefined || query === null ? "" : query)
  if (!prompt.trim()) throw new Error("Type a question first")
  if (prompt.indexOf("\u0000") >= 0) throw new Error("Questions cannot contain a NUL character")
  if (prompt.length > 16384) throw new Error("Keep the question under 16,385 characters")
  return ["omarchy-agent", "--prompt", prompt]
}

var CHECK_SCRIPT = [
  'for tool in omarchy-agent omarchy-agent-prompt omarchy-default-agent omarchy-launch-tui xdg-terminal-exec uwsm-app; do',
  '  command -v "$tool" >/dev/null 2>&1 || { printf "Agent launch unavailable: missing %s. Update Omarchy.\\n" "$tool"; exit 1; }',
  'done',
  'agent=$(omarchy-default-agent) || { printf "Could not read the default agent\\n"; exit 1; }',
  '[[ -n $agent ]] || { printf "Choose a default agent in Omarchy Settings first\\n"; exit 1; }',
  'command -v "$agent" >/dev/null 2>&1 || { printf "Your default agent is not installed\\n"; exit 1; }',
  'terminal=$(xdg-terminal-exec --print-id 2>/dev/null) || { printf "Choose an installed default terminal in Omarchy Settings\\n"; exit 1; }',
  '[[ -n $terminal ]] || { printf "Choose an installed default terminal in Omarchy Settings\\n"; exit 1; }'
].join("\n")

if (typeof module !== "undefined") {
  module.exports = { FALLBACK_ID: FALLBACK_ID, launchArgv: launchArgv, CHECK_SCRIPT: CHECK_SCRIPT }
}
