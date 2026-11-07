import QtQuick
import Quickshell
import Quickshell.Io

// Clipboard capture for Clipboard History (SPEC §5.3): `wl-paste --watch`
// runs captureScript on every new selection, which prints one JSON line per
// copy. Images and long text are saved under `directory` (0700) by content
// hash; short text travels in the JSON line, never on a command line.
// Password managers' copies (x-kde-passwordManagerHint, CLIPBOARD_STATE
// sensitive) are skipped before anything is read or written.
Item {
  id: watcher

  property string directory: ""
  property bool enabled: true
  signal captured(var observation)
  signal message(string level, string text)

  readonly property bool wanted: watcher.enabled && watcher.directory !== ""
  onWantedChanged: watcher.restart()
  Component.onCompleted: watcher.restart()

  function restart() {
    watch.running = false
    if (watcher.wanted && !reap.running) reap.running = true
  }

  // $1 is the clipboard directory. The text limit matches
  // ClipboardHistory.INLINE_TEXT_LIMIT.
  readonly property string captureScript: '
dir=$1
umask 077
[[ ${CLIPBOARD_STATE:-} == data ]] || exit 0
tmp=$(mktemp -p "$dir" .capture.XXXXXX) || exit 0
trap \'rm -f -- "$tmp"\' EXIT
types=$(timeout 1s wl-paste --list-types 2>/dev/null)
grep -qx x-kde-passwordManagerHint <<<"$types" && exit 0
# The selection owner streams the copy and can stall; a cut-off copy is dropped.
timeout 2s cat >"$tmp" 2>/dev/null || exit 0
hash_of() { local h; h=$(md5sum <"$1") && echo "${h%% *}"; }
image=$(grep -m1 -xE "image/(png|jpeg|webp|gif|bmp)" <<<"$types")
if [[ $image ]]; then
  timeout 2s wl-paste --type "$image" >"$tmp" 2>/dev/null && [[ -s $tmp ]] || exit 0
  hash=$(hash_of "$tmp") || exit 0
  ext=${image#image/}; [[ $ext == jpeg ]] && ext=jpg
  file=$dir/$hash.$ext
  [[ -e $file ]] || mv -- "$tmp" "$file" || exit 0
  jq -cn --arg mime "$image" --arg path "$file" --arg hash "$hash" --argjson bytes "$(stat -c %s -- "$file")" \
    \'{type:"image", mime:$mime, path:$path, hash:$hash, bytes:$bytes}\'
  exit 0
fi
grep -qE "^(text/|UTF8_STRING$|STRING$|TEXT$)" <<<"$types" || exit 0
mime=text/plain
# Files copied in a file manager: keep their URI list, not the plain-text paths.
if grep -qx text/uri-list <<<"$types"; then
  uris=$(timeout 2s wl-paste --type text/uri-list 2>/dev/null)
  if [[ $uris == file://* ]]; then printf %s "$uris" >"$tmp"; mime=text/uri-list; fi
fi
[[ -s $tmp ]] || exit 0
bytes=$(stat -c %s -- "$tmp")
hash=$(hash_of "$tmp") || exit 0
if (( bytes >= 30720 )); then
  file=$dir/file-$hash.txt
  [[ -e $file ]] || cp -- "$tmp" "$file" || exit 0
  head -c 30720 -- "$file" | jq -cRs --arg mime "$mime" --arg path "$file" --arg hash "$hash" --argjson bytes "$bytes" \
    \'{type:"text", text:., mime:$mime, path:$path, hash:$hash, bytes:$bytes}\'
else
  jq -cRs --arg mime "$mime" --arg hash "$hash" --argjson bytes "$bytes" \
    \'{type:"text", text:., mime:$mime, hash:$hash, bytes:$bytes}\' <"$tmp"
fi
'

  // Reap a watcher left by an earlier instance of the plugin (omacast
  // reload), then start ours; pdeathsig ends it with the shell.
  Process {
    id: reap
    command: ["pkill", "-f", "^wl-paste --watch bash -c .* omacast-clipboard "]
    onExited: if (watcher.wanted) watch.running = true
  }

  // wl-paste reports the selection already there when it starts; that
  // first line is marked so a restart doesn't count it as a new copy.
  property bool fresh: false

  Process {
    id: watch
    command: ["setpriv", "--pdeathsig", "TERM", "wl-paste", "--watch", "bash", "-c", watcher.captureScript, "omacast-clipboard", watcher.directory]
    onStarted: watcher.fresh = true
    stdout: SplitParser {
      onRead: function(line) {
        var initial = watcher.fresh
        watcher.fresh = false
        try { watcher.captured(Object.assign(JSON.parse(line), { initial: initial })) }
        catch (e) { watcher.message("warning", "unreadable capture: " + e) }
      }
    }
    // A dead watcher silently stops the history; bring it back.
    onExited: function(exitCode) {
      if (!watcher.wanted) return
      watcher.message("warning", "clipboard watcher exited (" + exitCode + "); restarting")
      restartTimer.restart()
    }
  }

  Timer {
    id: restartTimer
    interval: 2000
    onTriggered: if (watcher.wanted && !watch.running) watch.running = true
  }
}
