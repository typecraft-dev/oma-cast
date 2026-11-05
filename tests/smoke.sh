#!/bin/bash
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
cli=bin/omacast
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
[[ $(first nightlight) =~ ^Nightlight(\ On|\ Off)?$ ]] && pass "Omarchy menu items are searchable (nightlight)" || bad "Omarchy menu items are searchable (nightlight)"
[[ $(first "") != "" ]] && pass "empty root has sections" || bad "empty root has sections"
search zzzz-no-match | grep -q '"id":"fallback-commands"' && pass "fallback section for unmatched queries" || bad "fallback section for unmatched queries"
count=$($cli call system.info | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["data"]["candidates"])')
(( count > 300 )) && pass "$count candidates (apps + Omarchy menu)" || bad "only $count candidates"

# The surface stays mapped between opens, so time the commit that takes or
# gives back the keyboard (Hyprland sends no event for it), polled over IPC.
echo "toggle latency (show -> keyboard taken, hide -> given back; budget 100 ms)"
ki() { hyprctl repl "for _, l in ipairs(hl.get_layers()) do if l.namespace == 'omacast' then return l.keyboard_interactivity end end return 0" 2>/dev/null; }
until_ki() { local deadline=$(( $(date +%s%N) + 1000000000 )); until [[ $(ki) == "$1" ]]; do (( $(date +%s%N) < deadline )) || return 1; done; }
$cli hide; sleep 0.3
worst=0
for i in 1 2 3 4 5; do
  t0=$(date +%s%N); $cli show; until_ki 1 || { bad "run $i: launcher never took the keyboard"; continue; }
  show_ms=$(( ($(date +%s%N) - t0) / 1000000 )); sleep 0.3
  t1=$(date +%s%N); $cli hide; until_ki 0 || { bad "run $i: launcher kept the keyboard"; continue; }
  hide_ms=$(( ($(date +%s%N) - t1) / 1000000 )); sleep 0.3
  printf '        run %d: show %3d ms, hide %3d ms\n' "$i" "$show_ms" "$hide_ms"
  (( show_ms > worst )) && worst=$show_ms
  (( hide_ms > worst )) && worst=$hide_ms
done
(( worst > 0 && worst < 100 )) && pass "worst toggle ${worst} ms" || bad "worst toggle ${worst} ms"

exit $fail
