import QtQuick
import Quickshell.Hyprland
import Quickshell.Io
import "../core/Keybindings.js" as Keybindings

// The Hyprland binds Omarchy's keybindings menu knows, with the commands they
// run, plus the default terminal, browser and editor those commands resolve
// to. `omarchy-menu-keybindings --print` keeps its record cache current
// (~90 ms warm; it evaluates the Lua config only when the binds changed), and
// the newest cache file is read back for the dispatcher and command columns
// that --print leaves out. Rescanned on start, on every Hyprland config
// reload, and on a show at most once a minute (default browser changes). [D]
Item {
  id: source

  property var records: []
  property var defaults: ({})
  property int revision: 0
  property double scannedAt: 0
  property string lastText: ""

  function refresh() {
    if (scan.running) return
    source.scannedAt = Date.now()
    scan.running = true
  }

  function refreshIfStale() {
    if (Date.now() - source.scannedAt > 60000) source.refresh()
  }

  // xdg-terminal-exec's lookup: <desktop>-xdg-terminals.list then
  // xdg-terminals.list in each config dir; the first entry installed wins.
  readonly property string scanScript: 'IFS=: read -ra cfg <<<"${XDG_CONFIG_HOME:-$HOME/.config}:${XDG_CONFIG_DIRS:-/etc/xdg}"; '
    + 'IFS=: read -ra data <<<"${XDG_DATA_HOME:-$HOME/.local/share}:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"; '
    + 'IFS=: read -ra desk <<<"${XDG_CURRENT_DESKTOP:-}"; '
    + 'term=""; for c in "${cfg[@]}"; do for d in "${desk[@]}" ""; do l="$c/${d:+${d,,}-}xdg-terminals.list"; [[ -f $l ]] || continue; '
    + 'while read -r e; do e=${e#+}; e=${e%%:*}; [[ -z $e || $e == \\#* || $e == -* ]] && continue; '
    + 'for dd in "${data[@]}"; do [[ -f $dd/applications/$e ]] && { term=$e; break 4; }; done; done <"$l"; done; done; '
    + 'printf "terminal\\t%s\\n" "$term"; '
    + 'printf "browser\\t%s\\n" "$(omarchy-cmd-default-browser 2>/dev/null)"; '
    + 'ed=nvim; [[ -f $HOME/.local/state/omarchy/defaults/editor ]] && read -r ed <"$HOME/.local/state/omarchy/defaults/editor"; '
    + '[[ $ed == sublime_text ]] && ed=subl; printf "editor\\t%s\\n" "$ed"; '
    + 'printf "\\036\\n"; '
    + 'omarchy-menu-keybindings --print >/dev/null 2>&1; '
    + 'f=$(ls -t "${XDG_CACHE_HOME:-$HOME/.cache}"/omarchy/keybindings-*.records 2>/dev/null | head -n 1); '
    + '[[ -n $f ]] && cat -- "$f"'

  Process {
    id: scan
    command: ["bash", "-c", source.scanScript]
    stdout: StdioCollector {
      onStreamFinished: {
        if (text === source.lastText) return
        source.lastText = text
        var parsed = Keybindings.parseScan(text)
        source.records = parsed.records
        source.defaults = parsed.defaults
        source.revision++
      }
    }
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (event && String(event.name) === "configreloaded") source.refresh()
    }
  }

  Component.onCompleted: source.refresh()
}
