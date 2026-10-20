# Running on released Omarchy 4.0.5

The plugin originally targeted Omarchy's unreleased `quattro` branch, which
ships two shell types that released 4.0.x does not have. On released
Omarchy the plugin installed and enabled, then answered no IPC:

```
$ oma-cast install
Enabled typecraft.oma-cast
oma-cast: plugin did not answer; check the shell log with: qs log -n -p "$OMARCHY_PATH/shell"

$ oma-cast doctor
  ok    plugin is enabled
  FAIL  plugin answers IPC
  FAIL  backend answers system.healthPing
```

The shell log names the cause:

```
WARN scene: .../plugins/typecraft.oma-cast/Launcher.qml[111:3]: ShellIpc is not a type
```

## What was missing

| Used | Provided by | In released 4.0.x? |
|---|---|---|
| `ShellIpc` (`Launcher.qml:111`) | `qs.Commons/ShellIpc.qml` | **no** — `qs.Commons` ships only Border, Color, Style, Util |
| `OverlayWindow` (`ui/LauncherWindow.qml:14`) | `qs.Ui/OverlayWindow.qml` | **no** — absent from `qs.Ui` |

Both are thin wrappers over Quickshell built-ins: `ShellIpc` is an
`IpcHandler` that also registers with `IpcRegistry`, and `OverlayWindow` is
a `PanelWindow` carrying Omarchy's layer-shell setup. The port uses the
bases directly, the way Omarchy's own overlays (`plugins/emojis`,
`plugins/clipboard`, `plugins/menu`) are built.

The two errors are sequential, not independent. The panel loader aborts on
the first QML error, so `ui/LauncherWindow.qml` is never reached until
`ShellIpc` is fixed — fixing only one still leaves the launcher dead.

## The port

```qml
// Launcher.qml
import Quickshell.Io
...
IpcHandler {            // was: ShellIpc {
  target: "oma-cast"

  function toggle(): string { ... }
}
```

```qml
// ui/LauncherWindow.qml
PanelWindow {           // was: OverlayWindow {
  id: window

  property bool shown: false

  visible: window.shown
  anchors { top: true; bottom: true; left: true; right: true }
  color: "transparent"
  exclusionMode: ExclusionMode.Ignore
  WlrLayershell.namespace: "oma-cast"
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
}
```

`PanelWindow` comes from `Quickshell` (which default-imports
`Quickshell._Window`); `WlrLayershell` from `Quickshell.Wayland`.

## Three things worth knowing

### Quickshell caches QML by path for the life of the process

Re-linking the same path serves the file the shell cached earlier, so
installing over an existing install keeps running the **old** code —
including a fix for a type the old code used. The plugin id comes from
`manifest.json`, not the directory name, so the install links under a fresh
path:

```sh
link="$plugin_link.dev-$(date +%s%N)"
ln -s "$plugin_src" "$link"
```

`oma-cast reload` already worked this way; `install` did not. It is also
why the shell's inotify watch does not follow the symlink into the repo:
the shell sees the path it loaded, not the file behind it.

### The rebuild must finish before the surface maps

Omarchy's `OverlayWindow` only became visible once a target monitor
resolved, so the synchronous root-search rebuild had already completed
before the surface was mapped. A plain `PanelWindow` maps immediately, so
the rebuild blocked the first frame instead. Preparing the rows *before*
flipping `opened` restores the original ordering and cut map time from
64 ms to 40 ms:

```qml
function open(payloadJson) {
  ...
  launcher.prepare(payload)   // rebuild first
  root.opened = true          // then map
}
```

### A plugin that fails to load answers no IPC

Over IPC that is indistinguishable from a plugin that was never installed:
the shell only logs the QML error. `doctor` and `install` now read the
shell log for errors in the *current* link and print them, which turns
"plugin did not answer" into the actual cause.

Only the current link counts. `reload` links under a new path each time
and the log keeps the errors of the paths before it, so matching every path
would report a failure that has already been fixed.

## Latency on 4.0.5

Measured on Omarchy 4.0.5-1, Quickshell 0.3.2, Hyprland 0.56.2:

- **Layer map** (shell-side, excludes the CLI): ~40 ms. Same range as
  Omarchy's own overlays — `omarchy.menu` ~29 ms, `omarchy.emojis` ~51 ms
  (which maps *slower* than this plugin does).
- **End to end through the CLI**: ~100–140 ms. Released 4.0.5's
  `omarchy-shell` has no socat socket fast path, so every call spawns a
  `qs ipc` client, ~47 ms by itself. The `quattro` branch added that fast
  path (~5 ms).
- **Alt+Space** (the real user path, in-process): 70–100 ms.

So `tests/smoke.sh`'s 100 ms toggle budget is not reachable on released
4.0.5 *through the CLI*, but is via the hotkey.

## Where this checkout lives

Local-only git repo, no public fork:

```
~/.config/omarchy/plugins/oma-cast/                                  # the plugin repo
~/.config/omarchy/plugins/typecraft.oma-cast.dev-<ns> -> oma-cast/plugin
~/.local/bin/oma-cast -> oma-cast/bin/oma-cast
```

The repo sits inside the plugins dir, so the shell's own inotify watch
sees it: a write anywhere in the repo reloads the shell's plugins, and a
write to a *non-plugin* file (e.g. `SPEC.md`) closes an open launcher.
Harmless, but surprising.
