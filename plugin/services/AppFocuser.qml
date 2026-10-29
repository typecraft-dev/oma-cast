import QtQuick
import Quickshell
import Quickshell.Io
import "../core/RootSearch.js" as RootSearch

// Opening an app that already has a window focuses that window instead of
// starting another instance [D]. Anything that goes wrong on the way (no
// hyprctl, bad JSON, no match) falls back to launching.
Item {
  id: service
  property var pending: null
  signal launchRequested(var candidate)

  function open(candidate) {
    if (!candidate.windowKeys || !candidate.windowKeys.length) {
      service.launchRequested(candidate)
      return
    }
    if (service.pending) service.launchRequested(service.pending)
    service.pending = candidate
    clients.running = false
    clients.running = true
  }

  // Focusing the window is what moves you to its workspace. Hyprland refuses
  // focus to any window while the launcher's layer holds exclusive keyboard
  // focus, and refocuses the previous window when it unmaps, so wait (up to a
  // second) for the "oma-cast" layer to go before dispatching. The Lua-config
  // dispatcher is tried first and the classic keyword form is the fallback;
  // the dispatch is retried for half a second in case it still lands early.
  // On floating workspaces focus doesn't raise, so the window is then brought
  // to the top the way the dock does it; a window minimized to the dock is
  // first moved back to the workspace in front of the user.
  function focusWindow(address, minimized) {
    Quickshell.execDetached(["bash", "-c",
      'for _ in $(seq 20); do'
      + ' hyprctl layers -j 2>/dev/null | grep -q \'"namespace": *"oma-cast"\' || break;'
      + ' sleep 0.05;'
      + ' done;'
      + ' if [[ $1 == 1 ]]; then'
      + ' ws=$(hyprctl activeworkspace -j | jq -r .id);'
      + ' hyprctl dispatch "hl.dsp.window.move({ workspace = \\"$ws\\", window = \\"address:$0\\" })" >/dev/null 2>&1'
      + ' || hyprctl dispatch movetoworkspacesilent "$ws,address:$0" >/dev/null 2>&1;'
      + ' fi;'
      + ' for _ in 1 2 3 4 5 6 7 8 9 10; do'
      + ' hyprctl dispatch "hl.dsp.focus({ window = \\"address:$0\\" })" >/dev/null 2>&1'
      + ' || hyprctl dispatch focuswindow "address:$0" >/dev/null 2>&1;'
      + ' if [[ $(hyprctl activewindow -j | jq -r .address) == "$0" ]]; then'
      + ' hyprctl dispatch "hl.dsp.window.alter_zorder({ mode = \\"top\\", window = \\"address:$0\\" })" >/dev/null 2>&1'
      + ' || hyprctl dispatch alterzorder "top,address:$0" >/dev/null 2>&1;'
      + ' exit 0;'
      + ' fi;'
      + ' sleep 0.05;'
      + ' done',
      address, minimized ? "1" : "0"])
  }

  Process {
    id: clients
    command: ["hyprctl", "clients", "-j"]
    stdout: StdioCollector {
      onStreamFinished: {
        var candidate = service.pending
        service.pending = null
        if (!candidate) return
        var address = ""
        var minimized = false
        try {
          var list = JSON.parse(text)
          address = RootSearch.findAppWindow(list, candidate.windowKeys)
          minimized = list.some(function(c) {
            return String(c.address) === address && c.workspace && c.workspace.name === "special:minimized"
          })
        } catch (e) {}
        if (address) service.focusWindow(address, minimized)
        else service.launchRequested(candidate)
      }
    }
    onExited: function(exitCode) {
      if (exitCode === 0 || !service.pending) return
      var candidate = service.pending
      service.pending = null
      service.launchRequested(candidate)
    }
  }
}
