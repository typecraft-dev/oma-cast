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
  function focusWindow(address) {
    Quickshell.execDetached(["bash", "-c",
      'for _ in $(seq 20); do'
      + ' hyprctl layers -j 2>/dev/null | grep -q \'"namespace": *"oma-cast"\' || break;'
      + ' sleep 0.05;'
      + ' done;'
      + ' for _ in 1 2 3 4 5 6 7 8 9 10; do'
      + ' hyprctl dispatch "hl.dsp.focus({ window = \\"address:$0\\" })" >/dev/null 2>&1'
      + ' || hyprctl dispatch focuswindow "address:$0" >/dev/null 2>&1;'
      + ' [[ $(hyprctl activewindow -j | jq -r .address) == "$0" ]] && exit 0;'
      + ' sleep 0.05;'
      + ' done',
      address])
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
        try { address = RootSearch.findAppWindow(JSON.parse(text), candidate.windowKeys) } catch (e) {}
        if (address) service.focusWindow(address)
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
