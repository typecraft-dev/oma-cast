#!/bin/bash
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
cli=bin/oma-cast
fail=0
pass() { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; fail=1; }

echo "doctor"
$cli doctor | sed 's/^/  /' || fail=1

echo "ipc"
[[ $($cli call system.healthPing '{}') == '{"ok":true,"data":null}' ]] && pass "system.healthPing round trip" || bad "system.healthPing round trip"
[[ $($cli call foo.bar) == '{"ok":false,"error":"Unknown method foo.bar"}' ]] && pass "unknown methods are errors" || bad "unknown methods are errors"
$cli call settings.getGeneralSettings | grep -q '"popToRootTimeout"' && pass "settings document loaded" || bad "settings document loaded"
$cli call files.status | grep -q '"ok":true' && pass "file search status answers (passive)" || bad "file search status answers (passive)"

echo "root search (Phase 1)"
search() { $cli call rootSearch.search "{\"query\":\"$1\"}"; }
first() { search "$1" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d["data"][0]["rows"][0]["title"] if d["ok"] and d["data"] else "")'; }
[[ $(first nightlight) == "Nightlight" ]] && pass "Omarchy menu items are searchable (nightlight)" || bad "Omarchy menu items are searchable (nightlight)"
[[ $(first "") != "" ]] && pass "empty root has sections" || bad "empty root has sections"
search zzzz-no-match | grep -q '"id":"fallback-commands"' && pass "fallback section for unmatched queries" || bad "fallback section for unmatched queries"
count=$($cli call system.info | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["data"]["candidates"])')
(( count > 300 )) && pass "$count candidates (apps + Omarchy menu)" || bad "only $count candidates"

echo "toggle latency (show -> layer mapped, hide -> unmapped; budget 100 ms)"
sock="$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket2.sock"
events=$(mktemp)
socat -u "UNIX-CONNECT:$sock" - 2>/dev/null | while IFS= read -r line; do
  case $line in *layer\>\>oma-cast*) echo "$(date +%s%N) ${line%%>>*}" >>"$events" ;; esac
done &
watcher=$!
sleep 0.3
$cli hide
worst=0
for i in 1 2 3 4 5; do
  t0=$(date +%s%N); $cli show; sleep 0.3
  t1=$(date +%s%N); $cli hide; sleep 0.3
  open=$(grep openlayer "$events" | sed -n "${i}p" | cut -d' ' -f1)
  close=$(grep closelayer "$events" | sed -n "${i}p" | cut -d' ' -f1)
  if [[ -z $open || -z $close ]]; then bad "run $i: no layer event seen"; continue; fi
  show_ms=$(( (open - t0) / 1000000 )); hide_ms=$(( (close - t1) / 1000000 ))
  printf '        run %d: show %3d ms, hide %3d ms\n' "$i" "$show_ms" "$hide_ms"
  (( show_ms > worst )) && worst=$show_ms
  (( hide_ms > worst )) && worst=$hide_ms
done
kill "$watcher" 2>/dev/null; pkill -f "socat -u UNIX-CONNECT:$sock" 2>/dev/null; rm -f "$events"
(( worst > 0 && worst < 100 )) && pass "worst toggle ${worst} ms" || bad "worst toggle ${worst} ms"

exit $fail
