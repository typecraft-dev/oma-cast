import QtQuick
import Quickshell.Hyprland
import Quickshell.Io
import "../core/Keybindings.js" as Keybindings

// Puts the command hotkeys from settings.json into Hyprland at runtime with
// `hyprctl eval`, so omacast writes no Hyprland config [D]. Each hotkey
// fires hl.dsp.global("omacast:hk-…"), a GlobalShortcut in Launcher.qml.
// Hyprland drops runtime binds on a config reload, so every configreloaded
// applies the plan again. Taking a bind away (a removed hotkey, a restored
// Omarchy bind) needs that reload: only Hyprland's config knows the bind a
// hotkey had replaced. The argv carries key names, shortcut names and row
// titles, never anything typed into the launcher.
Item {
  id: binder

  // { binds: [{ commandId, bind, name }], unbinds: [bind] }
  property var plan: ({ binds: [], unbinds: [] })
  property var titles: ({})
  property bool enabled: false
  // The plan Hyprland has now; null before the first apply and after a reload.
  property var applied: null
  property string appliedKey: ""
  property bool dirty: false

  // The plan plus the titles its binds describe themselves with.
  function planKey(plan) {
    return JSON.stringify({ plan: plan, titles: plan.binds.map(function(h) { return binder.titles[h.commandId] || "" }) })
  }

  signal message(string level, string text)
  signal changedBinds()

  function schedule() { debounce.restart() }

  function sync() {
    if (!binder.enabled) return
    if (apply.running || reload.running) { binder.dirty = true; return }
    var next = binder.plan
    var key = binder.planKey(next)
    if (binder.applied && binder.appliedKey === key) return
    if (Keybindings.needsReload(binder.applied, next)) {
      binder.applied = null
      reload.running = true
      return
    }
    var code = Keybindings.hotkeyLua(next, binder.titles)
    if (!code) { binder.applied = next; binder.appliedKey = key; return }
    apply.command = ["hyprctl", "eval", code]
    apply.pendingPlan = next
    apply.pendingKey = key
    apply.running = true
  }

  Timer {
    id: debounce
    interval: 50
    onTriggered: binder.sync()
  }

  onEnabledChanged: binder.schedule()
  onPlanChanged: binder.schedule()
  onTitlesChanged: binder.schedule()

  Process {
    id: apply
    property var pendingPlan: null
    property string pendingKey: ""
    stdout: StdioCollector { id: applyOut }
    stderr: StdioCollector { id: applyErr }
    onExited: function(code) {
      // hyprctl eval exits non-zero on a Lua error (7); its text may still be
      // arriving, so the code decides.
      if (code === 0) {
        binder.applied = apply.pendingPlan
        binder.appliedKey = apply.pendingKey
        binder.changedBinds()
      } else {
        binder.message("error", "applying hotkeys failed (hyprctl exit " + code + "): " + (applyOut.text + applyErr.text).trim())
      }
      if (binder.dirty) { binder.dirty = false; binder.schedule() }
    }
  }

  // configreloaded follows, which applies the plan from scratch.
  Process {
    id: reload
    command: ["hyprctl", "reload", "config-only"]
    onExited: if (binder.dirty) { binder.dirty = false; binder.schedule() }
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (!event || String(event.name) !== "configreloaded") return
      binder.applied = null
      binder.schedule()
    }
  }
}
