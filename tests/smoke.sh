#!/bin/bash
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
cli=bin/oma-cast
shell_ipc() { omarchy-shell oma-cast "$@"; }   # plugin functions the CLI does not wrap
fail=0
pass() { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; fail=1; }

echo "doctor"
$cli doctor | sed 's/^/  /' || fail=1

echo "ipc"
[[ $($cli call system.healthPing '{}') == '{"ok":true,"data":null}' ]] && pass "system.healthPing round trip" || bad "system.healthPing round trip"
[[ $($cli call foo.bar) == '{"ok":false,"error":"Unknown method foo.bar"}' ]] && pass "unknown methods are errors" || bad "unknown methods are errors"
$cli call settings.getGeneralSettings | grep -q '"popToRootTimeout"' && pass "settings document loaded" || bad "settings document loaded"

echo "root search (Phase 1)"
search() { $cli call rootSearch.search "{\"query\":\"$1\"}"; }
first() { search "$1" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d["data"][0]["rows"][0]["title"] if d["ok"] and d["data"] else "")'; }
[[ $(first nightlight) == "Nightlight" ]] && pass "Omarchy menu items are searchable (nightlight)" || bad "Omarchy menu items are searchable (nightlight)"
[[ $(first "") != "" ]] && pass "empty root has sections" || bad "empty root has sections"
search zzzz-no-match | grep -q '"id":"fallback-commands"' && pass "fallback section for unmatched queries" || bad "fallback section for unmatched queries"
count=$($cli call system.info | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["data"]["candidates"])')
(( count > 300 )) && pass "$count candidates (apps + Omarchy menu)" || bad "only $count candidates"

# The surface stays mapped (ui/LauncherWindow.qml), so there are no Hyprland
# open/close layer events to time. Trigger the real hotkey path (the global
# shortcut, no CLI) and read back when the plugin drew its first frame.
echo "toggle latency (hotkey -> first frame shown / hidden; budget 100 ms)"
toggle() { hyprctl dispatch 'hl.dsp.global("oma-cast:toggle")' >/dev/null; }
frame_at() { shell_ipc lastFrameAt; }
$cli hide
toggle; sleep 0.3; toggle; sleep 0.3   # warm-up: the first show after a reload is slower
worst=0
for i in 1 2 3 4 5; do
  t0=$(date +%s%3N); toggle; sleep 0.3; shown=$(frame_at)
  t1=$(date +%s%3N); toggle; sleep 0.3; hidden=$(frame_at)
  if [[ ! $shown =~ ^[0-9]+$ || ! $hidden =~ ^[0-9]+$ ]] || (( shown < t0 || hidden < t1 )); then bad "run $i: no frame recorded"; continue; fi
  show_ms=$(( shown - t0 )); hide_ms=$(( hidden - t1 ))
  printf '        run %d: show %3d ms, hide %3d ms\n' "$i" "$show_ms" "$hide_ms"
  (( show_ms > worst )) && worst=$show_ms
  (( hide_ms > worst )) && worst=$hide_ms
done
[[ $(shell_ipc isOpen) == false ]] || { $cli hide; bad "launcher left open"; }
(( worst > 0 && worst < 100 )) && pass "worst toggle ${worst} ms" || bad "worst toggle ${worst} ms"

exit $fail
