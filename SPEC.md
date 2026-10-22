# Raycast for Linux: Reconstruction Spec

**Source:** static reverse engineering of Raycast **2.8.2** (`com.raycast.macos`, macOS 26, arm64) installed on this machine, done 2026-10-19.
**Target:** a clean-room, feature-equivalent launcher for **Arch Linux**, Wayland first (Hyprland → KDE → GNOME), with an X11 fallback.
**Scope:** all Raycast features **except AI** (AI Chat, Quick AI, AI Commands, MCP, Screen Awareness, Browser-context-for-AI, "Ask X" commands, Dictate-to-AI, Remote). This fork adds a user-authorized explicit hand-off to Omarchy's default agent in its default terminal (§2.0); it does not implement those Raycast AI features.

This file is the plan. Claude Code should read it first. The `reference/` folder holds the detailed evidence (verbatim schemas, method lists, wire formats), and this spec points into it by section.

| File | Contents |
|---|---|
| `reference/01-host-ipc.md` | Native host, window model, all ~408 host capabilities, WebView bridge, host↔backend wire protocol, helper processes, a Linux mapping for each |
| `reference/02-backend.md` | Backend service map, the 735 RPC methods, the DB engine, the **root-search ranking algorithm**, frecency maths, clipboard, the snippet placeholder grammar, quicklinks, calculator, file indexer |
| `reference/03-extensions.md` | `@raycast/api` runtime: worker model, React reconciler, **render-tree JSON schema**, every API→RPC call, manifest schema, Script Commands, Store install pipeline, Icon enum |
| `reference/04-frontend-features.md` | **Complete built-in command catalog**, launcher UI anatomy, all default shortcuts, every settings page, the theme model and 8 bundled themes, design tokens |
| `reference/05-data-config.md` | On-disk layout, DB encryption, reconstructed schema (124 tables), `.rayconfig` export format, XDG mapping |
| `reference/schema-nonai.sql` | Raycast's non-AI DDL, reconstructed from its migrations (reference only; §6 defines a simpler schema for the clone) |
| `reference/backend-methods-nonai.txt` | Every non-AI backend RPC method name |

Legend: **[O]** = observed in the shipped binaries or JS. **[I]** = inferred. **[D]** = a design decision for the clone, not a Raycast fact.

---

## 0. Ground rules (read before writing any code)

1. **Clean room.** Do not copy, bundle or redistribute anything from `/Applications/Raycast.app`: no frontend JS, `index.mjs`, `@raycast/api/index.js` from the app bundle, icons, PNGs, fonts or `.node` modules. They are proprietary. This spec describes *behaviour and interfaces* so you can write your own implementation. The open-source pieces you can use are the public npm package `@raycast/api` (type definitions and the `ray` CLI; check its license for the version you pin), `@raycast/utils`, and the `raycast/extensions` GitHub repo (MIT), which is the corpus you test compatibility against.
2. **Don't call Raycast's servers.** Store, account, sync, currency rates, translation and telemetry all go to `*.raycast.com`. A third-party client must not use them. Get extensions from the `raycast/extensions` repo and build them locally (§9.8). Use your own or public data sources for everything else.
3. **No telemetry.** Drop Sentry and PostHog completely.
4. **Embedded AI is out of scope.** The explicit default-agent terminal hand-off in §2.0 is the fork's authorized exception. Where another built-in mixes AI with non-AI behaviour (Dictation, Translator), build only the non-AI path and leave a `// AI: not implemented` seam.
5. **Prior art to study, not copy:** Vicinae (an open-source Linux launcher with Raycast-extension compatibility; check its current state), Espanso (text expansion via evdev/uinput), cliphist/clipse (Wayland clipboard history), plocate/fsearch (file index), Ulauncher/Walker/Anyrun (launcher UX on Wayland).

---

## 1. What Raycast 2.x actually is

Raycast 2.x is a rewrite. It is not the old all-Swift Raycast 1.x. Four layers [O]:

```
┌──────────── Raycast.app (Swift/AppKit, LSUIElement, no Dock icon) ─────────────┐
│ WKWebView windows ── React 19 SPA (frontend/*.html, Vite build)                 │
│   JS → window.webkit.messageHandlers.ipcRequest.postMessage({method,data,       │
│         destination:"host"|"backend", timeout})  → returns JSON reply           │
│   Host → JS: window.ipcRequest(method,data) / window.ipcNotification(...)       │
│   ipc://image?path=…  ipc://file-preview…  local://file…   (custom URL schemes)  │
│                                                                                 │
│ Swift host = router + ~408 native "host.*" methods (AX, pasteboard, hotkeys,    │
│              windows, EventKit, CoreAudio, …)                                   │
│        │ destination "backend"                                                  │
│        ▼                                                                        │
│ libraycast_host.dylib (Rust/tokio, UniFFI) "backend coordinator":               │
│   spawn, health-probe, restart and time out the Node backend                    │
│        │ stdin: NDJSON     stdout: \x1e header \x1f data \x1d \n                │
│        ▼                                                                        │
│ node v22 backend/index.mjs: ~58 service namespaces / 735 RPC methods            │
│   ├─ data.node (Rust): every SQLite DB (encrypted), migrations, cloud sync      │
│   ├─ indexer.node + "Content Indexer" helper: file index ("minidex", fst)       │
│   ├─ calculator-rs.node (+ Soulver on mac)                                      │
│   ├─ worker_threads: one Worker per running extension command                   │
│   │     (@raycast/api runtime + custom React reconciler → render-tree JSON)     │
│   └─ WS server 127.0.0.1:7265 for the browser extension                         │
│ XPC helpers: Accessibility (AX work), Pasteboard (clipboard capture)            │
│ Palette.app: input method for clipboard-free text insertion + caret position    │
│ Updater agent/daemon                                                            │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Consequences for Linux:
- **Business logic lives in the backend and the UI is web.** Both are OS-agnostic. Only the host layer (§5) needs Linux-specific work.
- The macOS and Windows builds share one IPC schema. The frontend already has Windows-only branches (Run dialog, taskbar, `Windows` shortcut variants), so Raycast was designed for more than one OS. Mirroring that split is the lowest-risk path.

---

## 2. Target architecture [D]

### 2.0 Quickshell build (current) [D, 2026-10-19]

**This supersedes the Tauri + Node design below for Omarchy.** Omarchy's desktop (bar, menus, launcher, notifications, lock screen) runs in one long-lived Quickshell process, `omarchy-shell`, whose features are plugins. oma-cast is one more plugin there, built the way Omarchy builds its own menu and emoji picker. The reasons:
- **No external dependencies.** No Tauri, WebKitGTK, Node runtime, npm packages or native SQLite modules. It needs only what Omarchy already ships: Quickshell, Qt, bash, socat and Hyprland.
- **Native look.** The plugin reads the active Omarchy theme's `[menu]` tokens (`qs.Commons.Color`, `Style`), so `omarchy theme set` restyles it live with no theme parser.
- **Speed.** The shell process is always warm. A hotkey reaches the plugin as a Hyprland global shortcut with no process spawn, and the CLI goes through the shell's socket (about 5 ms).

```
omarchy-shell (Quickshell, one process)
 └─ plugin typecraft.oma-cast   (~/.config/omarchy/plugins/<link> → repo/plugin)
     ├─ Launcher.qml        lifecycle open()/close(), ShellIpc target "oma-cast", GlobalShortcut oma-cast:toggle
     ├─ ui/                 launcher surface on Omarchy's OverlayWindow (wlr-layer-shell, namespace "oma-cast")
     ├─ Backend.qml         the "backend": paths, config.json, stores, method registry
     ├─ services/           QML services with I/O (JsonStore = FileView + migrations; later clipboard, apps…)
     └─ core/*.js           pure logic, no Qt: Rpc, Paths, Migrate, Log, Schema. Unit-tested with `node --test`
bin/oma-cast                bash CLI → omarchy-shell oma-cast <fn> (socket), plus install/reload/doctor/setup
```

How the rest of this spec maps onto it:
- **§3 IPC.** There is no wire protocol between UI and backend; both live in one QML engine. The *method surface* stays: services register `namespace.method` handlers in one registry (`core/Rpc.js`), using Raycast's names (§3.4). `call()` returns a Promise and `callSync()` returns `{ok,data|error}`. Notifications (`window.visibilityChanged`, `settings.generalSettingsChanged`) go through `subscribe()`/`emit()`. External callers use `ShellIpc` (`oma-cast call <method> <json>`). The NDJSON host↔backend contract and supervisor (§3.3) are **deferred to Phase 5**: only Raycast extensions need Node, and they will run as a supervised child `Process` that speaks §3.3/§9.2.
- **§4 platform.** Omarchy = Hyprland, so Phase 0 targets Hyprland only. Its config is **Lua** (`hyprland.lua`, `o.bind(...)`, `hl.dsp.global(...)`), not `.conf`.
- **§5.1 window.** It uses Omarchy's `OverlayWindow`: a fullscreen transparent layer surface with exclusive keyboard focus, and the 750×475 card drawn inside it. Clicking outside the card counts as focus loss. The surface is mapped fresh on every open, which is how Omarchy avoids stale surfaces when monitors change.
- **§6 data.** Persisted state is one versioned JSON document per store under `$XDG_DATA_HOME/oma-cast/db/` (`core/Migrate.js`: numbered migrations, history, atomic writes, never overwrite an unreadable or newer file). There is **no encryption at rest** and no libsecret key: Qt's FileView has no cipher, and full-disk encryption is the Omarchy default. If a store outgrows JSON (clipboard history, file index), revisit with Qt's built-in `QtQuick.LocalStorage` (SQLite) before adding a native dependency.
- **§10 frontend.** QML instead of React, with themes from Omarchy's tokens. The 8 Raycast themes (§10.4) become optional palettes over the same tokens.
- **Logging** goes to the shell's log (`qs log -n -p "$OMARCHY_PATH/shell"`, lines prefixed `[oma-cast]`), with the level from `config.json`. There are no separate log files.

**Default-agent hand-off [D, fork, 2026-10-20].** Non-empty root queries add an
"Ask default agent" row after the web-search fallbacks. Selecting it or pressing
Ctrl+Alt+Enter explicitly submits the current query to `omarchy-agent --prompt`
as one literal argument. Omarchy owns agent/account choice, authentication,
approval flags, working directory and terminal selection via `omarchy-launch-tui`
and `xdg-terminal-exec`. No agent SDK, network endpoint, credentials or new
package is introduced. Reference: Omarchy `quattro` `3ac43659dcbf88e84d951e3ce979b48a60a7d1f2`,
`shell/plugins/agents/Panel.qml` (`startPrompt`) and `bin/omarchy-agent{,-prompt}`.

`services/AgentLauncher.qml` owns one bounded preflight at a time; core argv
validation and the fixed check script live in `core/Agent.js`. Missing tooling,
unset/uninstalled agent or unavailable terminal reports a visible error without
clearing the query. Hide, timeout or plugin unload cancels the pending request.
On success the entry point closes the overlay, clears the query and forwards
argv using `Util.execArgv`. This checks prerequisites only: authentication and
terminal startup failures remain the existing launcher's responsibility.

Accept: normal app ranking/Enter selection is unchanged; fallback and shortcut
launch a fresh default-agent session in the selected terminal; quotes, Unicode,
multiline text, shell metacharacters and leading dashes arrive literally; blank
queries never submit; missing setup and cancellation never launch. Portable
fixtures cover argv/preflight and lifecycle; live Omarchy focus, terminal and
account acceptance remains required. Embedded chat and model calls are deferred.

The original Tauri design follows, kept for reference and for non-Omarchy targets.

```
┌──────────────────────── <app> (Tauri 2, Rust) ─────────────────────────┐
│ WebKitGTK webviews: main launcher, settings, notes, theme studio, HUD  │
│   frontend (React 19 + TanStack Router/Query + Vite + TypeScript)      │
│   bridge: invoke("ipc", {method,data,destination,timeoutMs})           │
│           listen("ipc://notification"), host→page eval for requests    │
│   custom schemes: app-image://  app-file://                            │
│                                                                        │
│ Rust host core                                                         │
│   router (frontend ⇄ host ⇄ backend)                                   │
│   backend supervisor (spawn node, NDJSON, health, restart)             │
│   platform::* adapters (trait per capability, impl per DE):            │
│     hyprland | kwin | gnome-ext | wlroots-generic | x11                │
│   clipboard watcher (ext/wlr-data-control | X11 XFixes)                │
│   input service (uinput writer; evdev reader for snippets, opt-in)     │
│   hotkeys (GlobalShortcuts portal | compositor bind + CLI | XGrabKey)  │
│   StatusNotifierItem tray + extension MenuBarExtras (ksni)             │
│   D-Bus: single instance, deep links (<app>://), CLI toggle            │
│   file indexer (ignore + notify + SQLite FTS5 trigram)                 │
│   calculator (fend crate, or libqalculate)                             │
└───────────────┬────────────────────────────────────────────────────────┘
                │ stdin/stdout NDJSON
┌───────────────▼────────────────────────────────────────────────────────┐
│ backend (Node ≥ 22, TypeScript, bundled with esbuild)                  │
│   services: rootSearch, settings, frecency, apps, quicklinks, snippets,│
│   clipboard, notes, emoji, scriptCommands, windowManagement layouts,   │
│   focus, themes, extensions (host for workers), import/export          │
│   DB: better-sqlite3 (optionally SQLCipher build), one file + ATTACH   │
│   extension workers: worker_threads (or child_process isolation)       │
│     runtime = OUR @raycast/api-compatible module + react-reconciler    │
└────────────────────────────────────────────────────────────────────────┘
```

Why this shape:
- **Tauri 2** gives Rust, which suits D-Bus, Wayland protocols, uinput and evdev. It renders through WebKitGTK, the same engine family as Raycast's WKWebView, so CSS behaves alike. Its plugins cover custom URI schemes, `eval`, tray, single-instance, deep-link and autostart. Electron also works but is heavier, and Chromium makes Wayland layer-shell harder.
- **A Node backend is unavoidable**: Raycast extensions are Node/React programs. Putting the rest of the business logic there too mirrors Raycast and keeps one language for the services.
- Write the host in Rust, not Node, for anything that needs Wayland protocols, uinput/evdev, D-Bus signals or low latency.

**Working name:** `<app>` throughout. Pick one, e.g. `oma-cast`. Use app id `dev.<you>.<App>` and binary `<app>`.

---

## 3. Process model and IPC (the contract to implement first)

### 3.1 Destinations [O → D]
`host`, `backend`, `frontend:main`, `frontend:settings`, `frontend:notes`, `frontend:themeStudio`, `frontend:hud`, `frontend:welcome` (AI windows dropped). Methods are dotted strings `namespace.method` (e.g. `rootSearch.search`, `clipboard.placeInClipboard`). Keep Raycast's namespace names where they exist; it makes the reference files directly usable.

### 3.2 Frontend ↔ host [D, modelled on O]
- Request: `invoke("ipc", { method, data, destination: "host"|"backend", timeoutMs? })` → `Promise<any>`. In the frontend, wrap it in a Proxy so call sites read `ipc.backend.clipboard.getAll(args)` (Raycast does exactly this [O]).
- Host → page request: the host evaluates `window.__ipcRequest(id, method, dataJson)`, and the page answers through `invoke("ipc_reply", {id, data|error})`. Use this for backend→`frontend:main` requests such as `extensionHost.render` and `general.showToast`.
- Notification: Tauri `emit_to(windowLabel, "ipc-notification", {method, data})`. Frontend subscribers look like `ipcNotification.clipboard.subscribeStateChanged(cb)` ↔ method `clipboard.stateChanged`.
- Boot globals the host injects before the page script runs [O pattern]: `window.identifier`, `window.initialGeneralSettings`, `window.initialThemes`, `window.homedir`, `window.platform = "linux"`, `window.desktop = "hyprland"|"kde"|"gnome"|"x11"`.

### 3.3 Host ↔ backend [O, simplify per D]
Raycast's framing [O]:
- host→node: one JSON object per line.
- node→host: `\x1e{header incl. dataLength}\x1f{data}\x1d\n`, so large payloads skip a second parse.

For the clone, use **plain NDJSON both ways**:
```jsonc
// host → backend
{"type":"initialize","databaseKey":"<64 hex>","supportDir":"…","cacheDir":"…","platform":"linux","desktop":"hyprland"}
{"type":"message","kind":"request","id":"<uuid>","method":"rootSearch.search","data":{…}}
{"type":"message","kind":"response","id":"<uuid from backend>","data":{…}}            // or "error":"…"
{"type":"message","kind":"notification","method":"window.visibilityChanged","data":{…}}
// backend → host
{"type":"message","kind":"request","id":"…","destination":"host"|"frontend:main","method":"clipboard.placeInClipboard","data":{…}}
{"type":"message","kind":"response","id":"…","data":{…}}  |  {"…","error":"Unknown method foo.bar"}
{"type":"message","kind":"notification","method":"indexer.stateChanged","destinations":["frontend:main"],"data":{…}}
{"type":"startupCheckpoint","phase":"step"|"finished"}
{"type":"shutdownCheckpoint","phase":"started"|"graceful"}
{"type":"log","level":"trace|debug|info|warning|error|fatal","message":"…"}
```
Supervisor behaviour, copied from Raycast [O; numbers I]:
- **Startup.** Spawn node with `--max-semi-space-size=4`, write `initialize`, then wait for `startupCheckpoint`. Startup timeout is 30 s, and each `step` extends it by 10 s. Queue requests that arrive while the backend is starting.
- **Requests.** The default per-request timeout is 5 s. Pause the timeout clock while the system sleeps (logind `PrepareForSleep`).
- **Health.** Probe `system.healthPing` / `system.healthDatabase` every ~10 s. If the backend stalls, restart it, but only while no window is open.
- **Crashes.** Allow up to 3 restarts per 60 s, then show a fatal error.
- **Shutdown.** Close stdin, wait up to 5 s for `shutdownCheckpoint graceful`, then SIGKILL.
- **Secrets.** Pass them in `initialize`, never in env vars.
- **PID file.** Write it to `$XDG_RUNTIME_DIR/<app>/backend.pid` and kill any stale instance on start.

### 3.4 Method surface
- Backend namespaces to implement (non-AI) [O]: `system, settings, rootSearch, frecency, clipboard, snippets, quicklinks, notes, emojiPicker, calculator, scriptCommands, windowManagement, focus, themes, extensionHost, store, indexer, fileSystem, screenshots, calendars, contacts, userDefaults, userActivity, hotkey, menuBar, general, database, releases (stub), translator (non-AI path)`. Full list: `reference/backend-methods-nonai.txt`. **Do not implement all 479.** Implement what each phase in §12 needs, reusing these names.
- Host namespaces [O]: `raycast` (rename to `app`: window show/hide/resize/compact/confetti/quit), `applications, clipboard, fileSystem, hotkey, media, navigation, permissions, system, systemNotifications, windowManagement, virtualDesktops, wifi, bluetooth, menuBar, snippets, settings, calendars, contacts, location, dictionary`. Full list with semantics: `reference/01-host-ipc.md §4.1`.

---

## 4. Platform targets and detection [D]

Detect the desktop at startup (`XDG_CURRENT_DESKTOP`, `HYPRLAND_INSTANCE_SIGNATURE`, `SWAYSOCK`, `WAYLAND_DISPLAY`/`DISPLAY`) and select an adapter set. In `platform/mod.rs`, define one Rust trait per capability, for example:

```rust
trait WindowControl { fn active_window(&self)->Result<Win>; fn list(&self)->Result<Vec<Win>>; fn set_bounds(&self,id,&Rect)->Result<()>;
                      fn focus(&self,id); fn close(&self,id); fn minimize(&self,id); fn toggle_fullscreen(&self,id);
                      fn monitors(&self)->Vec<Monitor>; fn workspaces(&self)->Vec<Ws>; fn switch_workspace(&self,i); fn move_to_workspace(&self,id,i); }
trait Clipboard     { fn watch(&self, tx); fn read_all_mimes(&self)->Vec<Repr>; fn write(&self, reprs, concealed:bool); }
trait Input         { fn paste(&self); fn type_text(&self,&str); fn backspace(&self,n); fn key_combo(&self, keys); }
trait Hotkeys       { fn register(&self,id,&Shortcut); fn unregister(&self,id); }
trait SelectedText  { fn get(&self)->Option<String>; }
trait Frontmost     { fn app(&self)->Option<AppRef>; }   // desktop-file id + pid + title
```

| Capability | Hyprland (primary) | KDE Plasma 6 | GNOME 46+ | X11 |
|---|---|---|---|---|
| Launcher window | Normal toplevel, class `<app>`, with **windowrules**: float, pin, center, noborder, noshadow, stayfocused, `blur` on `layerrule` (layer-shell optional later) | layer-shell (KWin supports it) or toplevel + KWin rule | Undecorated always-on-top toplevel (no layer-shell). Centre on the primary monitor | override-redirect or `_NET_WM_STATE_ABOVE` |
| Show on monitor with cursor | `hyprctl -j cursorpos` + `monitors` | KWin script | not available without an extension → primary | XQueryPointer + XRandR |
| Global launcher hotkey | `bind = ALT, SPACE, exec, <app> toggle` (written for the user by an onboarding step) or GlobalShortcuts portal (xdph) | GlobalShortcuts portal | GlobalShortcuts portal (GNOME 48+) or a custom keybinding via gsettings | XGrabKey |
| Per-command hotkeys | same, binding `<app> run <commandId>` | portal | portal / gsettings | XGrabKey |
| Window list/move/resize | Hyprland IPC socket (`clients`, `activewindow`, `dispatch movewindowpixel exact`, `resizewindowpixel exact`, `focuswindow`, `closewindow`, `pin`, `fullscreen`, `movetoworkspace`) + socket2 events | KWin scripting over D-Bus (load a JS script per action) | small companion **GNOME Shell extension** exposing a D-Bus API | EWMH via x11rb |
| Clipboard watch/write | `ext-data-control-v1` / `wlr-data-control` (wayland-client) | same (KWin supports data-control) | no data-control → companion GNOME extension, or `wl-paste --watch` while focused | XFixes SelectionNotify |
| Paste / key synthesis | `zwp_virtual_keyboard_v1` (as wtype does) or uinput | uinput or RemoteDesktop portal | RemoteDesktop portal (one-time consent) or uinput | XTest |
| Selected text | PRIMARY selection (`ext-data-control` primary) → fallback: synthesize Ctrl+C, read, restore clipboard | same | same | XA_PRIMARY |
| Frontmost app | `activewindow` → pid → `/proc/<pid>` → desktop-file match | KWin script | GNOME ext | `_NET_ACTIVE_WINDOW` → `_NET_WM_PID` |
| Workspaces | dispatch `workspace N` / `movetoworkspace` | `org.kde.KWin.VirtualDesktopManager` | GNOME ext | `_NET_CURRENT_DESKTOP` |
| Blur/vibrancy | `layerrule = blur, <ns>` / `windowrule` + transparent bg | `org_kde_kwin_blur` (KWindowEffects) | none → opaque bg | picom |
| Tray / MenuBarExtra | waybar SNI | native SNI | AppIndicator extension | XEmbed/SNI |

Common to all DEs: logind (lock/suspend/hibernate/poweroff/reboot), PipeWire `wpctl` or libpulse (volume and devices), MPRIS (media), NetworkManager (Wi-Fi), BlueZ (Bluetooth), UPower and power-profiles-daemon, UDisks2 (eject), `org.freedesktop.Notifications`, portals (FileChooser, Screenshot, OpenURI, Settings `color-scheme`), libsecret, `org.freedesktop.FileManager1.ShowItems`, `gio trash`, freedesktop thumbnails, GeoClue2. Full per-capability mapping: `reference/01-host-ipc.md §4.3`.

**Permissions UX** [D]: add a "Permissions" onboarding page and a `<app> doctor` CLI that checks for:
- the `input` group or a uinput udev rule (needed only for snippet expansion and the uinput paste fallback)
- AT-SPI enabled (optional)
- the portal backend present
- the data-control protocol advertised
- the Hyprland socket reachable
- the GNOME companion extension installed (GNOME only)

---

## 5. Host responsibilities in detail

### 5.1 Launcher window [O behaviour]
- Size **750 × 475** logical px at `uiZoom` 1. Header 66, footer 42. Corner radius 8 (Raycast uses 26 on macOS 26). Transparent window; the page paints `--color-window-bg` = theme background at **40 % alpha**, over compositor blur.
- **Compact mode** (`windowMode: compact`): only the 66 px search bar shows until the user types, then the window grows to full height. Optionally a row of favourite icons.
- **Show:** pick the monitor (`windowPresentationMode`: `mouse-screen` default / `active-screen` / `primary-screen`), place the window horizontally centred about 1/4 down from the top [I], focus the search field.
  - **Buffer keystrokes** typed between the hotkey and webview focus, then replay them. Raycast does this explicitly [O], and it matters on Wayland where focus is slow.
  - Keep the webview warm (hidden, not destroyed) so the window appears instantly.
- **Hide** on focus loss, unless `keepMainWindowVisibleOnResignKey` (dev aid) is set or the view requests it.
  - **Pop to root** after `popToRootTimeout`, default **90 s**. Options: immediately, 5, 15, 30, 60, 90, 120 or 180 s.
- **Escape:** `escapeKeyBehavior` = "Navigate back or close window" (default) or "Close window and pop to root".
- **Single instance:** D-Bus name `dev.<you>.<App>`. A second launch forwards its argv (`toggle`, `run <id>`, `<app>://…` deep link, `import file.rayconfig`) and exits.

### 5.2 Hotkeys and the Hyper key [O → D]
- The default launcher hotkey on macOS is ⌥Space. On Linux, default to **Alt+Space**, and warn that GNOME/KDE use it for the window menu.
- Per-command hotkeys are stored in `commands.hotkey` (JSON `{modifiers:[…], key}`), with conflict detection.
- Raycast's Hyper key remaps Caps Lock at the HID level. On Linux, don't reimplement this. Document **keyd** (`capslock = overload(hyper, esc)`) / **kanata**, or the XKB option `caps:hyper`, and show it in Settings → Keyboard as guidance.
- Double-tap-modifier hotkeys need evdev and are optional.

### 5.3 Clipboard capture [O → D]
- Watch every selection change on the regular clipboard. Record each MIME type offered, the source app (frontmost at copy time), and a timestamp, then call backend `clipboard.add({entry:{items:[{representations:[{content, contentType:"text"|"blob"|"url", mimeType}]}], source:{name, url, host:"Linux"}}, observationId})`.
- Skip offers that carry `x-kde-passwordManagerHint` = `secret` (the analogue of macOS `ConcealedType`). Also skip apps on the disabled list (defaults: KeePassXC, Bitwarden, 1Password, Seahorse).
- When writing a concealed copy, set that hint MIME.
- **Paste** = write all representations, give focus back to the previous window (hide the launcher first), wait ~50 ms, then send Ctrl+V. For terminals (by WM class: kitty, alacritty, foot, wezterm, ghostty, konsole, gnome-terminal) send **Ctrl+Shift+V**. Keep a per-app override table.

### 5.4 Snippet expansion engine [O → D]
On macOS this runs in the host and is fed by `snippets.register({snippetIds, keywords})` [O]. On Linux, offer two backends:
1. **evdev reader** (default when the user is in the `input` group).
   - Read key events from keyboards, translate them with xkbcommon using the active layout, and keep a 64-char rolling buffer. Reset it on mouse click, focus change, Enter, Esc or arrow keys.
   - Match against a trie of keywords (respect `expandWithinWords`).
   - On a match: send N backspaces through uinput, resolve placeholders (§8.3), write the result to the clipboard, paste, restore the previous clipboard after ~300 ms, and put the caret at `{cursor}` by sending ← × (chars after the cursor).
   - Modes [O]: `Immediately`, `AfterDelimiterKeeping`, `AfterDelimiterDiscarding`.
   - Disable it in password fields where detectable (AT-SPI `ROLE_PASSWORD_TEXT`) and for apps on the disabled list.
2. **IBus engine / Fcitx5 addon** (optional, later). It can `commit_text`, `delete_surrounding_text` and read the cursor rect. This is the Linux analogue of Raycast's Palette input method [O] and needs no input-group access.

Security note [D]: an evdev reader is technically a keylogger. Make it opt-in, keep it in-process with no logging of the buffer, and explain this in onboarding.

### 5.5 Other host services
- Notifications use `notify-rust`; action clicks → `systemNotifications.notificationClicked`.
- Autostart via `~/.config/autostart/<app>.desktop`, or `systemd --user` `<app>.service`.
- Deep links: a `.desktop` file with `MimeType=x-scheme-handler/<app>;x-scheme-handler/raycast;application/x-rayconfig;`. Forward them to `system.handleDeeplink`. Support `raycast://extensions/<owner>/<ext>/<command>?arguments=…` so existing docs and links work [O scheme].
- Tray: an SNI icon with Open, Settings, Notes and Quit, plus one SNI per extension `MenuBarExtra` (§9.6).
- Custom URI schemes, served from Rust:
  - `app-image://icon?name=firefox&size=32` resolves icon-theme names (`freedesktop-icons` crate) and file paths.
  - `app-image://thumb?path=…&w=&h=` uses freedesktop thumbnails, creating them if missing.
  - `app-file://…` serves local files to the webview with range support.
- Sleep/wake (logind `PrepareForSleep`), network change (NetworkManager `StateChanged`) and power source (UPower) → backend notifications `system.sessionStatusUpdate`, `system.networkConfigurationChanged`, `system.powerSourceChanged` [O names].

---

## 6. Data layer [O for Raycast, D for clone]

### 6.1 Raycast's design
- 11 SQLite files (`main, clipboard, emoji, frecency, settings_v2, node_extensions, app_index, screenshots, user_activity, ai, settings`).
- `main.db` is opened first and the others are `ATTACH`ed by stem. All are encrypted with the proprietary SQLite Encryption Extension (AES-256-OFB); the key is 64 hex chars from the Keychain.
- 248 refinery migrations, FTS5 everywhere (unicode61 `remove_diacritics 2`, plus a trigram index for clipboard).
- Custom SQL functions: `RAYDATE`, `RAYCAST_LOWER`, `RAYACRONYM`, `RAYFIRSTLINE`.

You **cannot** read Raycast's DB files. Migrate through `.rayconfig` import (§11).

### 6.2 Clone storage [D]
- `better-sqlite3` in the backend. For encryption at rest, use `better-sqlite3-multiple-ciphers` with SQLCipher-compatible settings, and keep the key in **libsecret** (attributes `{application:"<app>", kind:"database_key"}`). Fall back to a `0600` key file at `$XDG_DATA_HOME/<app>/db/.database-key`. Store an HMAC of the key in `key.check` to detect a mismatch.
- One file, `main.db`, plus ATTACHed `clipboard.db` (it grows large; this lets the user wipe it on its own) and `index.db` (file index, in cache).
- Migrations: numbered `.sql` files and a `schema_history` table.

### 6.3 Paths (XDG) [D, from reference/05 §8]
| What | Path |
|---|---|
| DBs, key check | `$XDG_DATA_HOME/<app>/db/` |
| Installed extensions | `$XDG_DATA_HOME/<app>/extensions/<id>/`, plus a compatibility symlink `~/.config/raycast/extensions → …` so `npx ray develop` output lands in the right place |
| Extension support dirs (Cache API) | `$XDG_DATA_HOME/<app>/extension-support/<id>/` |
| Clipboard blobs | `$XDG_DATA_HOME/<app>/clipboard/` |
| Notes attachments | `$XDG_DATA_HOME/<app>/notes/attachments/` |
| File index, thumbnails, webview cache, node compile cache | `$XDG_CACHE_HOME/<app>/…` |
| Logs (rotate: keep 10) | `$XDG_STATE_HOME/<app>/logs/<app>-<ts>.log` |
| DB backups per version | `$XDG_STATE_HOME/<app>/backups/<ver>/<ms>/` |
| Host flags (non-secret, user-editable) | `$XDG_CONFIG_HOME/<app>/config.toml` |
| Script command dirs (default) | `$XDG_CONFIG_HOME/<app>/script-commands/` |
| Runtime (lock, pids) | `$XDG_RUNTIME_DIR/<app>/` |

### 6.4 Clone schema (core tables) [D, simplified from O]
Raycast's exact columns are in `reference/schema-nonai.sql`. The clone only needs this:

```sql
-- settings
CREATE TABLE kv_settings (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,   -- scope: 'general' | 'ext:<extId>' | 'internal:<extKey>'
  PRIMARY KEY(scope,key));
CREATE TABLE commands (id TEXT PRIMARY KEY,           -- e.g. 'builtin:clipboard-history:clipboard-history' or 'ext:<owner>/<name>:<cmd>'
  enabled INTEGER NOT NULL DEFAULT 1, alias TEXT, hotkey TEXT /*json*/, favorite_order REAL, fallback_order REAL,
  meta TEXT NOT NULL DEFAULT '{}' /* per-command prefs, intervalEnabled, subtitle override */);
CREATE TABLE themes (id TEXT PRIMARY KEY, json TEXT NOT NULL, bundled INTEGER NOT NULL DEFAULT 0);

-- ranking
CREATE TABLE frecency (item_id TEXT PRIMARY KEY, anchor REAL NOT NULL /* unix seconds, see §7.4 */,
  opened_at INTEGER, search_terms TEXT NOT NULL DEFAULT '[]' /* [{term, at}] */);

-- apps (rebuilt from .desktop files)
CREATE TABLE apps (id TEXT PRIMARY KEY /* desktop-file id */, name TEXT, generic_name TEXT, keywords TEXT, exec TEXT,
  icon TEXT, path TEXT, categories TEXT, is_settings_panel INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0);

-- quicklinks / snippets / notes
CREATE TABLE quicklinks (id TEXT PRIMARY KEY /* ulid */, name TEXT NOT NULL, link TEXT NOT NULL, icon TEXT,
  open_with TEXT /* desktop id */, open_count INTEGER DEFAULT 0, pinned REAL, tags TEXT DEFAULT '[]', created_at INTEGER, updated_at INTEGER);
CREATE TABLE snippets (id TEXT PRIMARY KEY, title TEXT NOT NULL, keyword TEXT, text TEXT NOT NULL,
  copy_count INTEGER DEFAULT 0, pinned REAL, tags TEXT DEFAULT '[]', created_at INTEGER, updated_at INTEGER, accessed_at INTEGER);
CREATE UNIQUE INDEX snippets_keyword ON snippets(keyword) WHERE keyword IS NOT NULL AND keyword <> '';
CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT, text TEXT, raw_content TEXT /* ProseMirror JSON */,
  pinned INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER, last_accessed_at INTEGER);

-- clipboard (clipboard.db)
CREATE TABLE clip_entries (id TEXT PRIMARY KEY, title TEXT, source_name TEXT, source_app TEXT, content_hash TEXT NOT NULL,
  copy_count INTEGER DEFAULT 1, pinned REAL, created_at INTEGER, updated_at INTEGER);
CREATE INDEX clip_entries_hash ON clip_entries(content_hash);
CREATE TABLE clip_representations (id INTEGER PRIMARY KEY, entry_id TEXT REFERENCES clip_entries(id) ON DELETE CASCADE,
  item_index INTEGER, mime_type TEXT, content_type TEXT /* text|blob|url(path) */, content BLOB, ocr_text TEXT);
CREATE TABLE clip_categories (entry_id TEXT, category TEXT /* text|link|email|image|file|color */, PRIMARY KEY(entry_id,category));
CREATE VIRTUAL TABLE clip_fts USING fts5(content, title, tokenize='trigram');   -- substring search like Raycast's tri index

-- emoji
CREATE TABLE emoji (symbol TEXT PRIMARY KEY, name TEXT, category TEXT, aliases TEXT, keywords TEXT,
  custom_keywords TEXT DEFAULT '[]', pinned REAL, frecency_anchor REAL);
CREATE VIRTUAL TABLE emoji_fts USING fts5(symbol UNINDEXED, name, aliases, keywords, custom_keywords);

-- extensions
CREATE TABLE extensions (id TEXT PRIMARY KEY /* owner/name */, name TEXT, title TEXT, author TEXT, owner TEXT,
  version TEXT, source TEXT /* 'repo'|'local' */, source_path TEXT, manifest TEXT NOT NULL, installed_at INTEGER, enabled INTEGER DEFAULT 1,
  local_storage TEXT NOT NULL DEFAULT '{}', oauth_tokens TEXT NOT NULL DEFAULT '{}', prefs TEXT NOT NULL DEFAULT '{}');
  -- password prefs + oauth tokens: store in libsecret instead if you prefer (see reference/05 §8)

-- misc
CREATE TABLE calculator_history (id INTEGER PRIMARY KEY, query TEXT, result TEXT, created_at INTEGER);   -- cap 4096 rows [O]
CREATE TABLE window_layouts (id TEXT PRIMARY KEY, name TEXT, kind TEXT /* command|layout */, json TEXT);
CREATE TABLE focus_categories (id TEXT PRIMARY KEY, title TEXT, icon TEXT, kind TEXT, website_hosts TEXT, app_ids TEXT);
CREATE TABLE focus_sessions (id TEXT PRIMARY KEY, goal TEXT, category_ids TEXT, started_at INTEGER, ends_at INTEGER, completed_at INTEGER, paused_ms INTEGER DEFAULT 0);
CREATE TABLE user_defaults (key TEXT PRIMARY KEY, value TEXT);
```

---

## 7. Root search (the heart of the product)

### 7.1 Candidate providers [O]
Built-in commands, dynamic commands (apps, settings panels, quicklinks, window layouts, script commands, Focus categories, translate targets), extension commands, files (only when "Include Files in Root Search" is on), contacts (when enabled), and inline result providers: calculator, color, weather, flight [skip: needs Raycast API], translate (optional).

Each command definition carries `rootSearch: {when: empty|searching|always, matching: always|url|file-path|normal, section, pinned?}` [O]. Model the catalog declaratively, the way Raycast does (§10.1).

### 7.2 Sections [O]
- **Empty query** (in this order): Favorites (by `favorite_order`), Suggestions (frecency-sorted, top N≈6 [I]), Commands, Applications, System Settings, Recently Used Files. Raycast's announcements, updates, AI and walkthroughs sections are skipped.
- **With a query:** Color, Calculator, Weather*, Translate*, **Results** (the unified ranked list), Files, **`Use "<query>" with…`** (fallback commands, by `fallback_order`).

### 7.3 Matching and ordering
Port **exactly** from `reference/02-backend.md §4.2–4.5`. It is about 300 lines. Do not substitute `fzf`, `nucleo` or `fuse.js`; they rank differently and the result won't feel like Raycast. In summary:
- Normalise: lowercase, record camelCase word boundaries, transliterate to ASCII. The separator set is `\t \n space - . / ( ) [ ]`.
- Fuzzy DP scores per matched char:
  - 4 for the first char at position 0
  - 3 at a word start
  - 2 elsewhere
  - 1 for a separator↔separator match
  - −1 for each non-adjacent jump
- Thresholds by `rootSearchSensitivity`:
  - low: any match
  - medium: `score ≥ 1.5·(n−skipped−2)+4`
  - high: `score > 2·(n−skipped)`

  Raycast's settings UI shows high as the default. The backend default is medium [O conflict]. **Use medium**.
- Per candidate, compute the match class for each of these: alias (exact/prefix), title (exact/prefix/score), alternate titles, subtitle (only if it differs from the title), keywords (including `"title subtitle"` concatenations), and learned **search terms** (queries that previously launched this item, valid for 17 days, classed exact/prefix/overbounds≤3).
- Whole-word title boost for queries of 3+ chars.
- Comparator chain (15 steps): exact alias → exact search term → exact title → exact subtitle → prefix alias/term → overbounds → best score → frecency → … → type priority (app 5, command 4, quicklink 3, settings/file 1, contact 0) → collator on title.

### 7.4 Frecency [O, from machine code]
```
λ = ln 2 / 10 per day        (half-life 10 days)
score(t) = max(1, exp(min(709.78, λ·(anchor − t)/86400)))
on launch at t:  s = score(t); anchor = t + 86400·ln(s + 100)/λ        // +100 per launch
```
Store one `anchor` per item, in Unix seconds [D]. Record a visit on every launch (including via hotkey) and append the query string to `search_terms`. Emoji recents use the same formula [O].

### 7.5 Root-level UX [O]
- **Aliases:** typing an alias exactly puts the command on top.
- **Inline arguments:** when the selected command declares arguments (max 3), argument pills appear in the search bar right after the typed text. Tab moves between them and Enter runs.
- **Fallback commands:** "Use '<q>' with…" lists Google, DuckDuckGo, File Search, Search Snippets, Search Quicklinks, Translate and any command with `fallbackStatus: available`. The user orders them in Settings → Launcher.
- **Search history:** ↑ in an empty root restores recent queries.
- **Favorites:** ⌘⇧F (Linux: Ctrl+Shift+F) toggles; ⌘⌥↑/↓ reorders; ⌘1…9 (Linux: Ctrl+1…9) opens.
- A URL query surfaces "Open in Browser" and "Create Quicklink". A path-like query (`~/`, `/`) surfaces file results.

---

## 8. Built-in features: what to build

Full verbatim catalog: `reference/04-frontend-features.md §1 + Appendix A/B/C`. Priority: **P0** = MVP, **P1** = parity, **P2** = nice to have, **—** = skip.

### 8.1 Catalog with Linux implementation

| Extension (Raycast key) | Commands | Pri | Linux implementation notes |
|---|---|---|---|
| **Applications** (`applications`) | dynamic per app; Open, Show in File Manager, Copy Path/Name/ID, Hide (n/a on Wayland), Quit, Force Quit, Reset Ranking, favorites; *Uninstall Applications*; *Manage Auto Quits* | P0 | Parse `.desktop` from `$XDG_DATA_DIRS/applications` + `~/.local/share/applications` + flatpak exports. Honour `NoDisplay`, `Hidden`, `OnlyShowIn`/`NotShowIn`. Inotify-watch. Use `Actions=` as sub-actions. Launch via `gio launch` / `gtk-launch`, or exec with the field codes stripped, under `systemd-run --user --scope` so apps aren't children of the launcher. Quit = close via window adapter; Force Quit = SIGKILL the pid. Uninstall = `pacman -Qo <exec path>` → show `pkexec pacman -Rns <pkg>` / `flatpak uninstall`. Running indicator from the window list |
| **System Settings** (`preferences`) | dynamic per panel | P1 | `.desktop` files with `Categories=Settings` / `X-GNOME-Settings-Panel` / KDE `kcm_*` (`systemsettings kcm_x`, `gnome-control-center x`) |
| **Calculator** (`calculator`) | inline result; Calculator History; Color (inline preview); Weather (inline); Flight (skip) | P0 (calc), P1 (color, history), P2 (weather) | `fend-core` crate in the host (units, currencies, dates). Currency rates from ECB / frankfurter.app, cached daily. Settings: `remToPxRate`=16, `workHoursPerDay`=8, color detection, weather toggle. Weather: Open-Meteo + GeoClue2. History cap 4096. Copy result = Enter, Paste = Ctrl+Enter |
| **Clipboard History** (`clipboard-history`) | Clipboard History (list + detail, filter dropdown All/Text/Images/Files/Links/Colors), Paste Sequentially, Reset Paste Sequence | P0 | §5.3 + §8.2 |
| **Snippets** (`snippets`) | Create, Search, Import, Export Snippets | P0 (CRUD + search/paste), P1 (expansion) | §5.4 + §8.3 |
| **Quicklinks** (`quicklinks`) | Create, Search, Import, Export; dynamic per quicklink with arguments; Create Quicklink from URL query | P0 | §8.4. Open via `xdg-open` or `gio launch <open_with> <url>` |
| **Script Commands** (`script-commands`) | Search, Create (from template), Reload; dynamic per script | P0 | §9.9; identical to Raycast |
| **Web Searches / URL** (`web-searches`, `urls`) | Google, DuckDuckGo, Bing (fallbacks); Open in Browser | P0 | `xdg-open` |
| **System Actions** (`system`) | Lock Screen, Log Out, Sleep, Hibernate, Restart, Shut Down (confirm alert), Sleep Displays, Show Screen Saver, Empty Trash (confirm), Open Trash, Eject All Disks, Toggle System Appearance, Toggle Mute, Volume Up/Down, Set Volume 0/25/50/75/100 %, Set Volume…, Play/Pause, Next/Previous Track, Toggle Mic Mute, Set Sound Output/Input Device, Volume Mixer, Manage Wi-Fi, Toggle Wi-Fi, Toggle Airplane Mode, Manage Bluetooth Devices, Toggle Bluetooth, Toggle Night Light, Toggle Energy Saver (power-saver profile), Quit All Apps (confirm), Quit All Except Frontmost, Show Desktop, Toggle Hidden Files | P0 (power, volume, media, appearance), P1 (rest) | logind (`LockSession`/`Suspend`/`Hibernate`/`PowerOff`/`Reboot`/`TerminateSession`), DPMS via adapter, PipeWire `wpctl` (`@DEFAULT_AUDIO_SINK@`), per-app volume via pw-dump nodes, MPRIS (`playerctl` semantics; pick the most recently active player), NetworkManager, rfkill, BlueZ (`bluer`), power-profiles-daemon, appearance via gsettings `color-scheme` / `plasma-apply-colorscheme` / Hyprland user hook script, night light via gsettings / KWin NightLight / `hyprsunset`, trash via the freedesktop Trash spec, UDisks2 for eject |
| **Window Management** (`window-management`) | Halves (L/R/T/B), Thirds (13), Fourths (13), Quarters (4), Sixths (6), Maximize, Almost Maximize, Maximize Width/Height, Reasonable Size (60 %, max 1024×900), Center, Center Half, Restore, Minimize, Make Larger/Smaller, Toggle Fullscreen, Move Left/Right/Top/Bottom, Move to Next/Prev Display, Move to Next/Prev Workspace, Switch to Next/Prev Workspace, Move to Workspace 1–10, Open Workspace 1–10, Resize Window (exact), Move Window (exact), Toggle Always on Top, Custom Command, Create Layout, Save Current Layout | P1 | §8.5 |
| **Navigation** (`navigation`) | Switch Windows (list all windows; close/minimize/fullscreen actions); Search Menu Bar Items | P1 (switch), P2 (menus) | Window adapter list + focus. Menus: KDE global menu over `com.canonical.dbusmenu`, GTK `org.gtk.Menus`; partial coverage only |
| **Emoji & Symbols** (`emoji-picker`) | Search Emoji & Symbols (grid, 8 cols, skin tone, custom keywords, pin) | P0 | Seed from **emojibase** / Unicode CLDR annotations (Raycast embeds 2,736 records incl. 822 Unicode symbols [O]). Primary action Paste (default) or Copy |
| **File Search** (`file-search`) | Search Files (master-detail with preview), Quick Look (Ctrl+Y), Open/Reveal, Open With…, Copy Path, Move to Trash; root-search Files section; indexing status | P1 | §8.6 |
| **Raycast Notes** (`notes`) | Raycast Notes (separate floating window), Search Notes, Create Note | P1 | Separate webview window with a **ProseMirror** or **TipTap** editor, markdown shortcuts, find/replace, format bar, recently deleted (soft delete, purge after 30 d [I]). Optional SNI toggle |
| **Raycast Focus** (`raycast-focus`) | Start/Toggle/Pause/Resume/Complete/Edit Session, Search/Create/Import Categories | P2 | Timer in backend. App blocking = watch window-open events and close/minimize matching app ids (plus HUD). Website blocking needs your own small WebExtension. Snooze default 3 min |
| **Screenshots** (`screenshots`) | Search Screenshots (grid, OCR text search), Paste Latest Screenshot | P2 | Watch `$(xdg-user-dir PICTURES)/Screenshots` + configured dirs; OCR via tesseract (`leptess`) into FTS |
| **Calendar** (`calendar`) | My Schedule, Create Event, upcoming events in root (with join-meeting link detection) | P2 | Evolution Data Server D-Bus (covers GNOME Online Accounts) or read `khal`/vdirsyncer `.ics` dirs; KDE Akonadi optional |
| **Contacts** (`contacts`) | Search Contacts | P2 | EDS / CardDAV / vdirsyncer `.vcf` |
| **Dictionary** (`dictionary`) | Define Word | P2 | `dictd` (`dict` protocol) or offline Wiktionary (kaikki.org JSON) |
| **Translator** (`translator`) | Translate, inline "Translate to X", custom translate commands | P2 | Raycast's is a cloud/AI service. Use a pluggable provider: **LibreTranslate** (self-hosted) or **Argos Translate** (offline) |
| **Dictation** (`dictation`) | Dictate, Get Last Transcription, Vocabulary, History | P2 (non-AI path only) | Local **whisper.cpp** via PipeWire capture, then paste. Skip AI styles |
| **Developer** (`developer`) | Import Extension, Create Extension, Manage Extensions, Extension Diagnostics; prefs: auto reload on save, keep window visible | P1 | §9.8 |
| **Raycast (core)** (`raycast-core`) | Settings, Quit, Check for Updates (→ no-op/pacman hint), Release Notes (local), Reset Window Position, **Confetti**, **Switch Theme**, **Theme Studio**, Store (→ extension browser), Copy Version, Copy/Reveal Logs, Capture Window (screenshot of the launcher), Open Camera, **Export / Import Settings & Data** | P1 | Confetti = canvas-confetti overlay in a transparent fullscreen window. Camera = `getUserMedia` in a webview via the PipeWire camera portal |
| **Raycast Settings** (`raycast-settings`) | one command per settings page | P1 | deep links into the settings window routes |
| **Typing Practice** (`typing-practice`) | Start Typing Practice (WPM) | P2 | pure frontend |
| **Hotkeys/aliases/favorites** (cross-cutting) | — | P0 | §7.5, §5.2 |
| Run (Windows-only `windows-run`) | — | P2 | Linux bonus: "Run Shell Command" (run `$PATH` binaries, show output like script commands) |
| Apple Shortcuts, Stage Manager, Universal Clipboard, Games, Taskbar, Account, Teams, Cloud Sync, Wrapped, Trial Nudges, Debug, Browser (AI), MCP, Screen Awareness, AI | — | — | skip |

Features that are **store extensions, not built-ins** [O]: Kill Process, Color Picker, Spotify, Reminders, Lorem Ipsum. They should work through the extension runtime (§9). Consider shipping first-party Linux versions of Kill Process (`/proc`) and Color Picker (`hyprpicker` / portal `PickColor`).

### 8.2 Clipboard History details [O]
- **Dedup:** MD5 over the item representations. A match bumps `copy_count` and `updated_at`; no new row.
- **Categories:**
  - file → `file` (+ `image` if the file is an image)
  - image data → `image`
  - URL text → `link` (+ `email` for mailto)
  - colour literal → `color`
  - otherwise `text`
- Text ≥ **30,720 bytes** and all blobs are stored as files under `clipboard/` and referenced by path.
- **Retention** `historyDuration`: `P1D`, `P1W` (default), `P1M`, `P3M`, `P6M`, `P1Y`, `unlimited`. A periodic job deletes old rows. **Pinned entries are kept.**
- **OCR on images** (`textRecognitionEnabled` true, `ocrLevel` fast/accurate) feeds the FTS index. QR codes are decoded too (`rqrr`).
- **UI:** list on the left; detail on the right (text with syntax highlighting, image preview with dimensions, colour swatch, file preview) with metadata (source app, content type, chars/words, copied N times, first/last copied).
- **Actions:** Paste (↵), Copy (Ctrl+Enter), Paste as Plain Text, Pin (Ctrl+.), Edit, Rename, Delete (Ctrl+X), Delete All (Ctrl+Shift+X), Save as Snippet, Save as Quicklink (for links), Open link, Reveal file.
- **Paste Sequentially:** pastes the history from oldest to newest, one item per invocation, with optional newline (`addNewLine` true).

### 8.3 Snippet placeholder language [O, port exactly]
Grammar: `{keyword opt="v" opt2='v' | modifier | modifier}`. Quotes accepted: `" ' \` “ ” ‘ ’`, with `\` escapes. A newline aborts a placeholder.

| Placeholder | Options | Where |
|---|---|---|
| `{cursor}` | — | snippets only, at most 1 |
| `{clipboard}` | `offset=N` (Nth history item) | all |
| `{uuid}` | — | all |
| `{selection}` | — | quicklinks (snippets only if enabled) |
| `{argument}` | `name=`, `default=`, `options="a, b, Title: value"` | max **3** distinct; same name = same value |
| `{date}` `{time}` `{datetime}` `{day}` | `format="yyyy-MM-dd"` (ICU/Unicode patterns), `locale=`, `offset="+1d -2h"` | all |
| `{snippet name="Title"}` | — | nested; no `{snippet}`/`{argument}` inside, no cycles |
| `{calculator expression="…"}` | — | all |

- Modifiers: `uppercase`, `lowercase`, `trim`, `percent-encode`, `json-stringify`, `raw`.
- Offset units: `m` minutes, `h` hours, `d` days, `M` months, `y` years.
- Legacy forms still accepted: `{date "format" +1d}`. In quicklinks, any unknown `{word}` or `{word:default}` becomes an argument, so `{query}` keeps working.
- When a snippet has `{argument}`s, expansion opens a small argument form (or the launcher with argument pills) before inserting.

### 8.4 Quicklinks [O]
- Fields: name, link (a template), icon (favicon fetched or an app icon), open with (desktop id), tags, open count.
- Arguments come from placeholders and are percent-encoded unless `| raw` [I].
- Shown in root search with inline argument pills. Can be a fallback command.
- Settings: Show Link Previews, Pass Selected Text as Argument.
- **Import/Export** JSON: `[{name, link, openWith?}]` [I, keep compatible with Raycast's documented format].

### 8.5 Window management maths [O command list, I geometry]
- Work area = monitor geometry minus reserved space (Hyprland `monitors -j` `reserved`; KDE/X11 `_NET_WORKAREA`).
- Gaps: `outerGap` (screen gap) and `innerGap` (window gap), default 0.
- Fractions are applied to the work area. For example, "First Two Thirds" = x 0, width 2/3. Sixths are a 3×2 grid.
- **Cycling** (`cycleMode`, default `sizes`): pressing Left Half repeatedly cycles ½ → ⅔ → ⅓. `displays` mode moves to the next monitor instead.
- Move to next display keeps relative size and position (`Keep Aspect Ratio` true), with `Wrap Around` true.
- Restore keeps the pre-action bounds per window id in memory.
- On Hyprland, tiled windows must first be made floating (`setfloating`) before pixel moves. Make this a setting ("Float window on WM action", default on), and also expose "Restore to tiling".
- Layouts = saved lists of `{appId, workspace, monitorIndex, rect}` applied by launching missing apps, then placing windows.

### 8.6 File search [O → D]
- Index: crawl configured scopes (default `$HOME`) with the `ignore` crate (respects `.gitignore`, `.ignore`, `.rayignore`, plus default excludes `node_modules`, `.cache`, `.git`, `CACHEDIR.TAG`). Store paths in SQLite FTS5 (trigram), or use an `fst` map like Raycast's minidex [O].
- Watch with inotify (`notify` crate); fanotify for whole-disk watching is optional.
- Settings [O]: scopes, ignore patterns, include hidden, use ignore files, index removable drives, content search.
- Content search (P2): extract text via `pdftotext`, docx/odt via zip+xml, plain text, OCR images. Run extraction in a **separate process**, as Raycast does for crash isolation [O].
- Results: name match first, then path, sorted by recency. Detail pane: preview (image, PDF first page, text head) plus metadata. Quick Look = a large preview window, or GNOME Sushi if installed.

> **Implementation note (2026-10-20):** the shipped file search uses
> [`fff-search` 0.11.0](https://github.com/dmtrKovalenko/fff) in a small
> out-of-process sidecar (`helper/`) instead of the SQLite/FTS indexer above.
> It covers file-name search, the root Files section, frecency and actions;
> previews, content search, scopes and hidden-file support are deferred. See
> [`docs/file-search.md`](docs/file-search.md). New installs default
> it on; existing installs opt in.

---

## 9. Extension runtime (Raycast-extension compatibility)

This is the largest single piece. Spec: `reference/03-extensions.md` (read the whole file before starting this phase).

### 9.1 Process model [O]
- Each command run = one `worker_threads` Worker in the backend.
  - The worker's entry is the **API runtime module**, which `require()`s `<extDir>/<command>.js` (CommonJS output of `ray build`).
  - `@raycast/api`, `react` and `react/jsx-runtime` stay **external** and must be resolvable. Raycast symlinks `extensions/node_modules` → its own API bundle and sets `NODE_PATH`.
  - **You provide your own `@raycast/api` implementation** at that path [D].
- Resource limit: 100 MB JS heap (`resourceLimits.maxOldGenerationSizeMb`). Keep one prewarmed worker. At most 4 sessions per command.
- No sandbox beyond the worker [O]. Optional improvement [D]: run each command in a child process with a `worker_threads` shim, for crash and memory isolation and so it can be killed.
- `child_process` is monkey-patched to track spawned pids, which are killed on unload [O].
- Linux bonus [D]: prepend a shim dir to `PATH` containing `open`→`xdg-open`, `pbcopy`/`pbpaste`→`wl-copy`/`wl-paste`, and an `osascript` that exits 1 with a clear message. Many store extensions call these directly.

### 9.2 Envelope (worker ⇄ backend) [O, keep exactly]
```jsonc
{"kind":"request","id":"<nanoid>","method":"showToast","params":{…}}
{"kind":"result","id":"…","result":{"success":true,"value":…}}  |  {"success":false,"error":{RayError}}
{"kind":"notify","method":"logCommand","params":{"sessionId","level","message"}}
```
- Backend→worker methods: `initialize` (payload in ref 03 §1.3), `nativeCallback {sessionId, callbackId, data}`, `terminate {code}`.

### 9.3 Modes and lifecycle [O]
- `no-view`: call the default export with `LaunchProps`, then unload.
- `view`: React-render it and keep it alive until the UI pops it.
- `menu-bar`: render to an SNI tray item. Run on its `interval` (minimum 10 s) and on menu open. Unload 5 s after `isLoading:false`.
- **Background interval scheduler:** at most 8 concurrent runs. Each run times out at 0.9 × min(interval, 5 min). (Raycast multiplies by 1000 twice here, which looks like a bug [O]; use seconds correctly.) Pause during sleep. A command's interval is enabled only after the user has run it once (`intervalEnabled`).
- `LaunchProps = {arguments, launchType: "userInitiated"|"background", launchContext, fallbackText, draftValues}`.

### 9.4 Reconciler and render tree [O, keep wire-compatible internally]
- Use `react-reconciler` in **persistence mode**. Host component names: `ray-list`, `ray-list-item`, `ray-form-textfield`, etc. (full list in ref 03 §2.2).
- After every commit, serialize the tree to `{model: CommandView, changes}` and send `render {renderTree, gzipped}`:
  - gzip+base64 when the tree is over 30 KB
  - `renderEmpty` when nothing changed
  - `renderSuspense` when suspended
- **Callbacks** become string ids `"<nodeId>_<propName>"`. The UI calls `extensionHost.callNodeCallback({sessionId, callbackId, data})`.
  - `onSearchTextChange`, `onChange` and `onSelectionChange` payloads are `{value, eventCount}`, with a 250 ms throttle when `throttle` is set.
  - `submit-form` sends all field values.
  - Only the **selected** item's `actions`/`detail` are rendered and hoisted, so the UI must report selection changes.
- The full schema (List/Grid/Detail/Form/MenuBarExtra/ActionPanel/Image/Color/Shortcut/Controlled) is in ref 03 §2.4, with a worked example in §2.5. Build the frontend renderer against it.

### 9.5 API surface to implement [O]
Every export of `@raycast/api` (ref 03 §3.1) and each one's RPC (ref 03 §3.2). Main groups:
- **UI:** `List`, `Grid`, `Detail`, `Form` (TextField, PasswordField, TextArea, Checkbox, DatePicker, Dropdown, TagPicker, FilePicker, Separator, Description, LinkAccessory), `ActionPanel`, `Action.*` (CopyToClipboard, Paste, Open, OpenInBrowser, OpenWith, ShowInFinder, Push, SubmitForm, Trash, ToggleQuickLook, PickDate, CreateQuicklink, CreateSnippet), `MenuBarExtra`, `useNavigation`.
- **Feedback:** `showToast`/`Toast`, `showHUD`, `confirmAlert`/`Alert`.
- **Window/navigation:** `closeMainWindow`, `popToRoot`, `clearSearchBar`, `launchCommand`, `updateCommandMetadata`, `openExtensionPreferences`, `openCommandPreferences`.
- **Environment:** `environment` (add `"linux"` handling; `canAccess(AI)` → false), `getPreferenceValues`.
- **Storage:** `LocalStorage` (backend-persisted JSON per extension), `Cache` (**pure fs**, LRU 10 MB; journal format in ref 03 §3.4, keep it byte-compatible), `Clipboard` (copy/paste/read with `offset` from history/clear, `concealed`).
- **OS:** `getSelectedText`, `getSelectedFinderItems` (Linux: return `[]`, or read a `text/uri-list` clipboard), `getFrontmostApplication`, `getApplications`, `getDefaultApplication`, `open`, `showInFinder`, `trash`.
- **OAuth:** `OAuth.PKCEClient` (PKCE S256; redirect through `<app>://oauth` or a loopback server; `redirectMethod: web` relies on raycast.com's redirect page, so loopback is the realistic option on Linux [D]).
- **Window management:** `WindowManagement.*` (via the adapter).
- **Other:** `BrowserExtension.*` (P2; needs your own WebExtension and native messaging), `Icon` (478 tokens; draw or map your own icon set, ref 03 Appendix A), `Color`, `Image.Mask`, `Keyboard.Shortcut.Common`, `LaunchType`, `PopToRootType`, `captureException`.
- **Stubs:** `AI.*`, `Notes.*` (stubbed even in Raycast 2.8.2 [O]).

**Shortcut translation** [D]: on Linux prefer `shortcut.Windows` when an extension provides it (Raycast added per-platform shortcuts). Otherwise map `cmd→ctrl`, `opt→alt`, `ctrl→ctrl` (resolve collisions by adding shift), and keep `shift`.

### 9.6 MenuBarExtra → StatusNotifierItem [D]
Each running menu-bar command owns one SNI item (ksni):
- `title` → SNI title/tooltip (waybar shows icons only, so render the title into the icon or a tooltip)
- `icon` → `IconPixmap` rendered from the Image spec
- items → DBusMenu, with Sections as separators + disabled header items, Submenus as submenus, and `alternate` dropped
- clicking an item → `nativeCallback(actionCallbackId)`

### 9.7 Manifest [O]
`package.json` fields: `name, title, description, icon, author, owner?, categories, commands[{name,title,subtitle?,description,mode,interval?,arguments?(≤3),preferences?,keywords?,disabledByDefault?}], preferences[], tools[] (AI: ignore)`.
- Preference types: `textfield, password, checkbox, dropdown, appPicker, file, directory`.
- Per-platform defaults use keys `macOS`/`Windows`; read `Linux`, falling back to `Windows`, then `macOS`.
- Required preferences that are missing → show the preferences form before the first run (Raycast's "onboarding" view [O]).
- Command id: `ext:<owner|author>/<name>:<command>` [D] (Raycast uses `c:n:<extId>::-::<cmd>` [O]).

### 9.8 Getting extensions [D]
- **Local/dev:**
  - "Import Extension" picks a folder with a built `dist/`.
  - `npx ray develop` from the npm `@raycast/api` package builds into `~/.config/raycast/extensions/<name>`, so keep that path as a symlink. Watch it with inotify and hot-reload (`autoReloadOnSave`).
  - `npx ray build -e dist` also works.
- **Catalog:** an in-app "Store" view over a local clone of `github.com/raycast/extensions`.
  - List `extensions/*/package.json`, filter out macOS-only ones (manifest `platforms` field if present; heuristics: grep for `osascript`/`runAppleScript`/`@raycast/utils`'s `runAppleScript`), then build on install with `npm ci && npx ray build -e dist`, and copy the output into `extensions/<owner>/<name>`.
  - Update = `git pull` + rebuild.
  - Do not call `backend.raycast.com`.
- Keep the install pipeline Raycast uses [O]: build into a staging dir, validate the manifest, atomically rename over the old dir with a backup, then upsert the DB.

### 9.9 Script Commands [O, portable as-is]
- Directories come from settings (default `$XDG_CONFIG_HOME/<app>/script-commands`). Scan non-recursively; skip dirs, files > 2 MB, `.template.` files and non-executables.
- Header regex: `^(?:#|REM|::|\/{2})\s*@raycast\.(\w+)\s+(.*)`.
  - Required keys: `schemaVersion 1`, `title`, `mode`.
  - Optional keys: `packageName, icon, iconDark, description, author, authorURL, currentDirectoryPath, needsConfirmation, refreshTime, argument1..3` (JSON `{type: text|password|dropdown, placeholder, optional, percentEncoded, data}`).
- Execution: run the file directly with cwd = `currentDirectoryPath` relative to the script, env = login-shell env (`$SHELL -lc env`, cached), and arguments as `$1..$3`.
- Modes:
  - `fullOutput`: output view with streamed stdout/stderr and ANSI colours
  - `compact`: toast showing the last non-empty line
  - `silent`: close the window, then a HUD with the last line
  - `inline`: the first line becomes the root-item subtitle, refreshed every `refreshTime` (≥ 10 s)
- Success = exit 0. A compatibility test corpus is the `raycast/script-commands` GitHub repo.

---

## 10. Frontend spec

### 10.1 Stack [O libraries; D choices]
- React 19, TanStack Router (memory history per window), TanStack Query (all backend reads), zod (IPC schemas), Vite, TypeScript.
- Small observable stores with `useSyncExternalStore` for toast/HUD/alert/settings state, as Raycast does [O]; no Redux.
- `motion` for animations, ProseMirror/TipTap for Notes, `marked` + `shiki`/`lowlight` for Detail markdown, `colorjs.io` for theme contrast maths.
- **Declarative command catalog** [O pattern]: one TS module defining every built-in extension as `{key, title, description, icon, availability, preferences: {name: {default, storage: "synced"|"local"|"platform"}}, commands: {...}, dynamicCommands: {...}}`, each command with `type` (view/no-view), `keywords`, `fallbackStatus`, `rootSearch`, `args`, and action groups whose handlers target `frontend` | `backend` | `navigation:/path`. Share it between frontend and backend, as Raycast does (it ships a copy in each [O]).

### 10.2 Launcher anatomy [O]
- **Header (66 px):**
  - back button inside pushed views; app logo at root
  - search field with placeholder "Search for apps and commands…" (each view sets its own)
  - inline argument pills after the measured text width
  - optional right-side dropdown accessory (Ctrl+P)
  - a 2 px loading bar under the header
- **Body:** sectioned list.
  - Row: icon 22 px, title, subtitle in secondary colour, and right-aligned accessories in this order: tags/text/date, alias badge, hotkey glyphs, type label ("Application", "Command", "Quicklink", …).
  - Master-detail split for list detail (~40/60). Grid view (columns 1–8). Empty state with icon, title and description.
- **Footer (42 px):**
  - left: current context icon + title, or the active toast (style icon, title, message)
  - right: primary action title + ↵, a separator, "Actions" + Ctrl+K
- **Action panel (Ctrl+K):** popover anchored bottom-right, with its own search field and sections (primary, then copy, configure, deeplink, delete).
  - Each row shows its shortcut.
  - Primary = ↵, secondary = Ctrl+↵, tertiary = Ctrl+Shift+↵ (Windows column), and so on.
  - Shared groups [O]: Favorites (Add/Remove/Move Up/Down), Deeplink (Copy Deeplink), Configure (Configure Command, Configure Extension, Reset Ranking), Delete (Disable Command).
- **Toast → HUD:** while the window is visible and expanded, toasts render in the footer. Otherwise they become a **HUD**, a small pill window near the bottom-centre that shows for ~1.5 s [I] (e.g. "Copied to Clipboard"). Ctrl+T focuses toast actions.
- **Alerts:** centred modal inside the launcher, with a destructive style.
- **Navigation:** push/pop stack. Back = Esc or Ctrl+[; pop to root = Shift+Esc (Raycast's Windows binding) [O].

### 10.3 Default shortcuts (Linux = Raycast's Windows column) [O]
| Action | Key |
|---|---|
| Primary / secondary / tertiary / quaternary / quinary | ↵ / Ctrl↵ / Ctrl⇧↵ / Ctrl Alt↵ / Alt⇧↵ |
| Action panel / About panel | Ctrl K / Ctrl⇧K |
| Copy / copy deeplink | Ctrl⇧C |
| Paste / edit / new / open / open with | Ctrl V / Ctrl E / Ctrl N / Ctrl O / Ctrl⇧O |
| Delete / delete all | Ctrl D / Ctrl⇧D (Windows column; macOS uses ⌃X) |
| Favorite / reorder | Ctrl⇧F / Ctrl Alt ↑↓ |
| Pin / Quick Look / refresh / save | Ctrl . / Ctrl Y / Ctrl R / Ctrl S |
| Back / forward / pop to root | Esc or Ctrl[ / Ctrl] / ⇧Esc |
| Next/prev section | Ctrl↓ / Ctrl↑ |
| Jump to item 1–9 | Ctrl 1–9 |
| Zoom in/out/reset | Ctrl + / Ctrl − / Ctrl 0 |
| Settings / configure command / extension | Ctrl , / Ctrl⇧, / Ctrl Alt , |
| Disable command | Alt⇧D |
| Toggle filter dropdown / toast | Ctrl P / Ctrl T |
- **Navigation bindings** (Settings → Keyboard): Emacs (Ctrl+B/F/P/N, default) or Vim (Ctrl+H/L/K/J).
- **Page navigation:** square brackets (default) or arrow keys.
- Full table: ref 04 §2.8.

### 10.4 Theming [O, port exactly]
- **Theme JSON** (15 fields): `{id, name, appearance: light|dark, background, backgroundSecondary, foreground, accent, selection, loader, red, orange, yellow, green, blue, purple, magenta}`.
- **Bundled themes:** Raycast Dark/Light, Sky, Sunset, Midnight, Dawn, Overcast, Noon. Exact hex values are in ref 04 §4.1. Theme values are data, so reusing these colour values is fine, but rename the themes.
- **CSS variables:**
  - Raw: `--bg --bg-secondary --fg --accent --selection --loader --red…--magenta`.
  - Alpha ramps for each: `-0 -5 -10 -20 -40 -60 -80`, using `rgb(from var(--x) r g b / N%)` (WebKitGTK ≥ 2.44; otherwise precompute them in JS).
  - Semantic tokens: `--color-text-primary: var(--fg)`, `-secondary: fg-60`, `-tertiary: fg-40`, `--color-border-separator: fg-10`, `--color-surface-list-selection: fg-10`, `--color-surface-list-hover: fg-5`, `--color-window-bg: bg-40`, brand `#ff6363`. Full list in ref 04 §4.2.
- **Design tokens:**
  - `--spx = 1px × uiZoom`
  - type scale 11/13/16/18/24, base 13
  - spacing 2/4/6/8/12/16/24/32
  - radius 4/6/8/10/12
  - easing `cubic-bezier(.16,1,.3,1)`
  - fonts: **Inter** (variable, features `ss03`) and **JetBrains Mono**, both OFL, so bundle them
- Follow the system light/dark via the portal `org.freedesktop.appearance color-scheme`. Settings: `appearance: system|light|dark`, `themeLightId`, `themeDarkId`.
- **Theme Studio:** a separate window with an installed-themes list, an editor for primary and support colours (hex + HSL sliders), live mock-launcher preview, duplicate/delete/save, set as light/dark, and copy as JSON. Install from a deep link `<app>://theme?…` (match the ray.so URL params [I]).

### 10.5 Settings window [O]
- Normal decorated window with a sidebar (searchable) and content.
- Pages: General, Launcher, Shortcuts/Extensions, Keyboard, Advanced, About, plus one page per built-in extension. Verbatim rows: ref 04 §3 and Appendix B. Main defaults:

| Setting | Default |
|---|---|
| appearance | system |
| uiZoom | 1 (Default/Large/Larger) |
| windowMode | expanded |
| showFavoritesInCompactMode | true |
| openAtLogin | true |
| showInMenuBar | true (→ SNI) |
| globalHotkey | Alt+Space |
| windowPresentationMode | mouse-screen |
| popToRootTimeout | 90 s |
| rootSearchSensitivity | medium |
| escapeKeyBehavior | navigate back or close |
| navigationBindings | emacs |
| faviconProvider | DuckDuckGo [D] |

- **Extensions table:** a tree of Extension → Commands with columns Name, Type, **Alias**, **Hotkey** (recorder with a conflict dot), Enabled. A side pane renders that extension's or command's preferences from its schema. The uninstall dialog offers "Keep Settings" or "Delete Settings".
- Preferences UI is **generated from schemas** for both built-ins and extensions: checkbox, dropdown, textfield, password, file/dir (portal), app picker, hotkey recorder.

---

## 11. Import from macOS Raycast [O format]
Implement a `.rayconfig` **reader**. This is the only way to bring the user's real data over.
- **Raycast 2.x (`RAYCFG3`):**
  - Magic `RAYCFG3\n`, then u32le header length, then gzip(JSON header `{exportedAt, appVersion, osName, schemaVersion:3, encryption?:{iv,salt}}`), then the payload.
  - Payload = gzip(JSON), or AES-256-GCM(gzip(JSON)) with key = `scrypt(password, salt, 32, {N:16384, r:8, p:1})`, a 16-byte IV, and the 16-byte tag at EOF.
- **Raycast 1.x:**
  - If the file starts with `1f 8b`, it is plain gzip JSON.
  - Otherwise it is `IV(16) ‖ AES-256-CBC(gzip(JSON))` with key = SHA-256(password).
- **Sections to import:** `snippets`, `quicklinks`, `notes`, `clipboardHistory`, `emoji` (custom keywords and pins), `settings` (general, command aliases and hotkeys translated to Linux modifiers, favorites, fallbacks, frecency, themes), `windowLayouts`, `focusCategories`, `nodeExtensions` (a list of `{owner,name}` → offer to install from the local catalog).
- **Skip:** `ai`, `mcpServers`, `userActivity`.
- Field shapes: ref 05 §5 and ref 02 §7.
- Also offer **export** in the same container (your own schemaVersion) for backups, and scheduled exports (default off, keep 8, 14 days).
- Test by exporting from the user's Mac (Raycast → Export Settings & Data) and importing on Arch.

---

## 12. Build plan for Claude Code

Work in a fresh repo (e.g. `~/git/<app>`). Copy this folder into `docs/spec/`. Create `CLAUDE.md` containing:
- "Spec lives in docs/spec/SPEC.md; reference details in docs/spec/reference/. Follow §0 ground rules. Implement phase by phase; each phase must pass its acceptance checks before the next."
- the repo layout below
- the commands to build, run and test

Repo layout [D]:
```
<app>/
  src-tauri/            # Rust host: main.rs, router.rs, supervisor.rs, platform/{hyprland,kwin,gnome,x11,wlroots}.rs,
                        # clipboard.rs, input/{uinput,evdev}.rs, hotkeys.rs, tray.rs, schemes.rs, indexer/, calc.rs
  backend/              # Node TS: server.ts (NDJSON), services/*, db/{migrations,*.ts}, extensions/{host,worker-pool,store}.ts
  packages/api/         # our @raycast/api-compatible runtime (reconciler, serializer, API fns)
  packages/catalog/     # declarative built-in catalog (shared FE/BE)
  frontend/             # React app: windows/{main,settings,notes,theme-studio,hud}, components/, renderer/ (render-tree → UI)
  gnome-extension/      # companion (window list/move, clipboard, cursor pos) for GNOME
  packaging/            # PKGBUILD, <app>.desktop, systemd user unit, 60-<app>-uinput.rules, hyprland.conf snippet
  docs/spec/            # this folder
```

### Phase 0: Skeleton and IPC (Quickshell build, §2.0) [D]
- Omarchy shell plugin `typecraft.oma-cast` (`plugin/`, kind `menu` so the shell hands it the shared app library, `keepLoaded`). `bin/oma-cast install` links it into `~/.config/omarchy/plugins/` and enables it.
- Launcher surface (750×475, 66 header, 42 footer) on the active Omarchy theme. It starts hidden and is toggled by `oma-cast toggle`, `omarchy-shell oma-cast toggle` or the global shortcut `oma-cast:toggle` (`oma-cast setup hyprland` binds Alt+Space).
- In-process backend: method registry with Raycast names, `system.healthPing`, `system.healthDatabase`, `system.info`, `system.getPaths`, `settings.getGeneralSettings` / `updateGeneralSettings`, and notifications. The footer shows a live `system.healthPing` round trip.
- XDG paths (§6.3), `config.json` (hot reload), logging to the shell log, and versioned JSON stores with a migrations framework.
- **Accept:** `oma-cast toggle` shows and hides in under 100 ms warm, measured from the CLI call to Hyprland's `openlayer`/`closelayer` event (`tests/smoke.sh`). A backend error or an unreadable store never takes the launcher down: calls answer `{ok:false,error}`, and the store goes read-only without overwriting the file, then recovers when the file is fixed. `node --test tests/` covers the registry, paths, migrations and logging.

### Phase 0 (original Tauri plan, superseded for Omarchy)
- Tauri app with a main window. Hidden at start, toggled by `<app> toggle` (D-Bus single instance).
- Node backend supervisor and NDJSON per §3.3, including `initialize`, checkpoints, health ping and restart.
- Frontend `ipc` Proxy (§3.2) and a demo round trip `system.healthPing`.
- XDG paths, logging, `config.toml`, the libsecret DB key, migrations framework.
- **Accept:** `<app> toggle` shows and hides in under 100 ms warm. Killing node triggers a restart within 2 s and the UI recovers. Unit tests for framing and the supervisor state machine.

### Phase 1: Launcher shell and root search
- Window behaviour (§5.1): Hyprland rules + generic toplevel, focus-loss hide, pop-to-root timer, keystroke buffering, compact mode.
  - Quickshell build: the layer surface maps about 25 ms after the call, and keys sent before that go to the window underneath. Phase 0 measured this with `wtype`, which types faster than a person. Buffering needs a surface that already holds keyboard focus at the keypress. One option is a pre-mapped, input-transparent layer that takes `Exclusive` focus on show; it must survive monitor hot-plug, which is why Omarchy's OverlayWindow remaps on every open.
- Theme system with the 8 themes and CSS variables (§10.4). Inter/JetBrains Mono.
- Declarative catalog. Applications provider (`.desktop`) plus System Settings panels.
- Root search per §7, ported exactly, with unit tests built from ref 02 §4 (fuzzy scores, thresholds, comparator), frecency, aliases, favorites, sections, fallback commands.
- Action panel, footer, toasts, HUD window, alerts, navigation stack, all shortcuts in §10.3.
- **Accept:** type "fir" → Firefox first. Launching bumps frecency. Alias "ff" → exact top. Ctrl+K opens actions. Esc behaviour matches the setting. Golden tests for the ranker.
- **Quickshell build [D, 2026-10-19]:**
  - **Omarchy menu.** Every item from `omarchy-menu.jsonc` (default plus the user's `~/.config/omarchy/extensions/` file) is a root-search command (`plugin/core/OmarchyMenu.js`). Its subtitle is the breadcrumb ("Trigger › Toggle"). `when` guards hide rows, `checked` adds ✓, and `disabled` dims a row. The `fonts` and `power-profiles` provider rows are searchable too. Top-level menus show in the empty root's Commands section; deeper items appear only while searching. Opening a submenu pushes it as a view, and Ctrl+↵ opens the item in the original Omarchy menu.
  - **Apps** come from the shell's `appLibrary`, which handles hidden entries, icons and `uwsm-app` launching.
  - **Themes.** The 8 Raycast themes and the CSS variables are replaced by the live Omarchy theme tokens (§2.0).
  - **HUD.** The HUD is Omarchy's OSD (`omarchy-shell osd show`).
  - **Settings.** There is no settings window yet (Phase 2); aliases are set from the action panel.
  - **Not done:** vim navigation bindings (Ctrl+K would clash with the action panel), Ctrl+P dropdown, Ctrl+T toast focus, Ctrl+Shift+K about panel, inline argument pills (no command declares arguments yet), alerts (no destructive action needs one yet), and keystroke buffering (see the note above).
  - **"fir" → Firefox:** on a list where another title starts with "Fire", the literal port ties at score 8 and the collator decides until Firefox has been launched once (`tests/ranker.test.js`).

### Phase 2: Core built-ins
- Calculator (fend) with inline result + history.
- Quicklinks (CRUD, arguments, placeholders §8.3 minus clipboard history), Web Searches/URL, System Actions P0 set (logind, wpctl, MPRIS, appearance toggle), Script Commands (§9.9).
- Settings window: General, Launcher, Keyboard, Extensions table with alias/hotkey recorder (portal or compositor-bind writer).
- **Accept:** `2+2`, `5 km in mi`, `100 usd in eur` work. A quicklink `https://duckduckgo.com/?q={query}` with an argument pill works. The `raycast/script-commands` samples (a few bash/python ones) run in all 4 modes. Hotkey → command works on Hyprland.

### Phase 3: Clipboard history
- Watcher per §5.3 (data-control first, X11 second), storage per §6.4 and §8.2, list/detail UI, paste/plain-paste, Paste Sequentially, pins, retention job, OCR (tesseract), disabled apps.
- **Accept:** copy text, image, file and colour from various apps and see them categorized. Dedup bumps the count. Paste lands in the previously focused window (including terminals with Ctrl+Shift+V). Secrets from KeePassXC are not recorded.

### Phase 4: Snippets and expansion
- CRUD + search + paste, the placeholder engine (§8.3) with an argument form, import/export.
- Expansion engine via evdev+uinput (§5.4), opt-in, with the three modes, `{cursor}` placement and a disabled-apps list.
- Packaging adds a udev rule and onboarding for the `input` group.
- **Accept:** `;sig` expands in Firefox, a GTK text field and kitty. `{date format="yyyy-MM-dd" offset="+1d"}` is correct. `{argument name="x"}` prompts. Nothing expands in password fields of AT-SPI-enabled apps.

### Phase 5: Extension runtime
- `packages/api` (reconciler, serializer, all APIs §9.5), worker pool, backend method table, frontend renderer for List/Grid/Detail/Form/ActionPanel, LocalStorage/Cache/preferences/OAuth (loopback), launchCommand, background intervals, MenuBarExtra → SNI, `npx ray develop` hot reload, extension catalog from a local `raycast/extensions` clone, PATH shims.
- **Accept:** these extensions work unmodified from `raycast/extensions`:
  - a List extension with search (e.g. `hacker-news`)
  - a Form extension (e.g. `qrcode-generator` or similar)
  - a Grid extension (e.g. `simple-icons` or similar)
  - a no-view extension
  - a menu-bar extension (a counter/clock)
  - an OAuth extension (e.g. `github` or `linear`, if keys allow)
  - `@raycast/utils` hooks (`useFetch`, `usePromise`, `useCachedState`) work
- Also write a compatibility report script that builds N extensions and records pass/fail.

### Phase 6: Window management and window switcher
- Adapters for Hyprland (IPC socket), KWin (scripts over D-Bus), X11 (EWMH), GNOME (companion extension).
- All WM commands in §8.1 with gaps, cycling, displays, workspaces, restore, layouts. Switch Windows view.
- `WindowManagement` API for extensions.
- **Accept:** every WM command is correct on a dual-monitor Hyprland setup with reserved waybar space, tested with a golden geometry table. Switch Windows focuses across workspaces.

### Phase 7: File search
- Indexer (Rust, separate thread; content extraction in a subprocess), search UI with preview, root-search Files section, Quick Look, settings.
- **Accept:** a 500k-file home dir indexes in under 2 min. Queries return in under 50 ms. Renames and moves are reflected within 2 s.

> **Implementation note (2026-10-20):** the first slice ships with
> `fff-search` 0.11.0 in `helper/` and a QML sidecar service; see
> `docs/file-search.md`. Measured on a 20,662-file home: 30 ms scan,
> 20–35 MB RSS with the watcher, 0–2 ms queries. Previews, content search,
> hidden files and scopes are later phases. The 500k-file acceptance is not yet
> tested.

### Phase 8: Parity features
- Emoji & Symbols, Notes window, Theme Studio, Switch Theme, Confetti, Focus, Screenshots, Calendar, Contacts, Dictionary, Translator (provider), Dictation (whisper.cpp), Typing Practice, `.rayconfig` import/export (§11), Kill Process and Color Picker as first-party extras.

### Phase 9: Packaging
- `PKGBUILD` (AUR, `-git` variant). Depends: `webkit2gtk-4.1 nodejs>=22 libsecret wl-clipboard gtk3 libayatana-appindicator`. Optdepends: `tesseract tesseract-data-eng whisper.cpp keyd ydotool hyprland`.
- Ship the `.desktop` file (+ URL scheme MIME), a systemd user unit, the udev rule for uinput, and a `<app> setup hyprland` command that appends binds and windowrules to `~/.config/hypr/<app>.conf` and sources it.
- Write a `<app> doctor`.

---

## 13. Risks and open questions
- **Wayland focus and positioning.** Each compositor behaves differently. Test the launcher on Hyprland first and treat GNOME as a degraded tier: it has no layer-shell, no cursor position and no data-control without the companion extension.
- **Extension compatibility ceiling.** Many store extensions are macOS-bound (AppleScript, `~/Library` paths, Mac apps). Expect roughly a minority to need changes. Measure it with the compatibility script, and prefer extensions that list `Windows` in `platforms`.
- **`@raycast/api` behaviour drift.** Raycast evolves the API, so pin a version (2.8.2 shipped API whose template depends on `@raycast/api ^2.6.3`, `@raycast/utils ^2.2.7` [O]). Track the public changelog.
- **Snippet expansion needs input-device access.** This is a security trade-off; keep it opt-in, and do the IBus/Fcitx5 engine as the cleaner long-term path.
- **Unrecovered numbers** [I]: backend timeouts and restart limits, HUD duration, the Suggestions section size, and window y-offset. Pick sensible values (given above) and tune them.
- **Frecency epoch:** Raycast's anchor epoch wasn't confirmed. It doesn't matter for a clone that uses Unix seconds consistently, but convert carefully when importing `frecency` from `.rayconfig` (check whether values look like 2001-epoch seconds, i.e. ≈ 8×10⁸ vs Unix ≈ 1.7×10⁹).
- **Calculator parity.** Soulver-style natural language ("$30 + 20%", "3 days from now", time zones) exceeds `fend`. Consider libqalculate as an alternate engine behind the same interface. **[D] 2026-10-19:** the Quickshell build uses neither. `plugin/core/Calculator.js` is a self-contained JS evaluator that covers these cases (see CLAUDE.md Status). libqalculate isn't an Omarchy dependency, and `qalc` reads "15% of 80" and "3 days from now" differently from Soulver.
