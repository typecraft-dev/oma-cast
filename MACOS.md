# omacast for macOS

A native macOS app for the same launcher. Everything that decides behaviour
lives in `core/*.js` and runs in both apps: ranker, frecency, root search,
calculator, the RPC surface, the store rules and the launcher window's logic.
On macOS it runs inside JavaScriptCore, and Swift only draws and talks to
macOS. SPEC.md
stays the source of truth for behaviour; this file covers what differs on
macOS. Install and use: [`macos/README.md`](macos/README.md).

The ground rules from SPEC §0 apply unchanged: clean room, no
`*.raycast.com`, no telemetry, no AI features, no user text in argv, private
files (`0700` dirs, `0600` files). There are no third-party dependencies, only
Swift, AppKit/SwiftUI, JavaScriptCore and Carbon.

## Layout

```
core/Backend.js          RPC methods: Backend.qml and the macOS app both build a `host` for it
core/LauncherState.js    window logic (view stack, selection, popups, toasts, keys); LauncherWindow.qml and SwiftUI draw its state()
core/Store.js            JSON store rules (parse, migrate, never overwrite unreadable or newer files)
core/CalculatorData.js   when to refresh exchange rates and zone offsets
macos/js/App.js          the macOS host: file I/O, config, candidates, over Swift primitives
macos/js/MacCommands.js  System commands and System Settings panes for root search
macos/js/Themes.js       Catppuccin palettes and user theme files
macos/Sources/OmacastKit Swift: JSEngine, Native (the primitives), panel, SwiftUI views, hotkey, socket, settings
macos/bin/build-app      builds omacast.app; Resources mirror the checkout (core/, macos/js/)
macos/bin/omacast        the CLI; the app binary is its own socket client (`omacast --cli`)
```

The macOS-only modules sit in
`macos/js/`, and the Omarchy plugin never loads them.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Logic | `core/*.js` and `macos/js/*.js` in one `JSContext`, each file in its own function scope with a `module` shim | The modules never import each other, so the Swift host passes dependencies in the way the QML does. |
| Backend | `Backend.qml`'s method handlers moved to `core/Backend.js` | One copy of the RPC surface instead of two that drift. Side effects stay in the host. |
| Window logic | `core/LauncherState.js`, drawn by `ui/LauncherWindow.qml` and by SwiftUI | One keyboard model, tested in node. Platform differences are options: `platform: "macos"` keeps navigation on Control and commands on ⌘; Omarchy passes its async Flea search and its `Util.editsFilter` text editing. |
| Window | A borderless non-activating `NSPanel`, created once and kept hidden | The app underneath keeps focus, so paste goes back to it. Keys typed right after the hotkey land in the panel. |
| Keys | ⌘ takes Ctrl's role (⌘K, ⌘↵, ⌘1–9); Control+N/P or J/K still moves | Raycast's macOS column (SPEC §10.3). |
| Hotkey | Carbon `RegisterEventHotKey`, `config.json` `"hotkey"` (default `alt+space`), also set in Settings | Needs no permission. |
| Apps | Scan the app folders and watch them with FSEvents | Deterministic, and doesn't depend on Spotlight indexing. |
| Open an app | `NSWorkspace.openApplication`, which acts like a Dock click: a running app comes forward and AppKit reopens or un-minimizes a window | No Accessibility needed. |
| Open New Window | Bring the app forward and send ⌘N | macOS has no generic call. Needs Accessibility. |
| Paste | Copy to `NSPasteboard`, wait for modifier keys to be released, post ⌘V | Needs Accessibility. |
| Lock Screen | `SACLockScreenImmediate` from login.framework via `dlsym`, falling back to `pmset displaysleepnow` | Private API, the call the menu bar's Lock Screen item makes. macOS has no public call that locks the screen immediately. |
| Restart, Shut Down, Log Out, Empty Trash, Toggle Appearance | Constant Apple Events through `NSAppleScript` | macOS asks once for Automation permission. |
| Storage | `~/Library/Application Support/omacast/db/*.json`, cache in `~/Library/Caches/omacast` | `core/Paths.js` has a `darwin` branch. The files match Linux, so they can be copied between machines. |
| Logging | `~/Library/Logs/omacast/omacast.log` (0600), tailed by `omacast log` | Matches `qs log` on Omarchy. `os.Logger` would redact the details by default. |
| CLI | Unix socket `run/omacast.sock` (0600, same-uid peers only) | The same commands as Linux: `toggle`, `show`, `hide`, `run`, `call`, `doctor`. |
| Themes | `general.theme`: `system`, the built-in Catppuccin palettes, or JSON files in `<config>/themes/` | Omarchy's theme tokens don't exist on macOS. |
| Signing | Ad-hoc by default; `OMACAST_SIGN_IDENTITY` for a real certificate | Accessibility is tied to the signature. Without hardened runtime the app can't be notarized, which is fine for local builds. |
| Concurrency | UI types are `@MainActor`; Swift tools 5.9 (Swift 5 mode) | JavaScriptCore and the Carbon/FSEvents callbacks run on the main thread. A move to Swift 6 mode is possible later. |

## Status (2026-11-12, macOS 27.2, Swift 6.4)

Verified:
- **Tests:**
  - `node --test tests/*.test.js`: 167 pass and 3 are skipped on the Omarchy machine. On macOS, 160 pass, 4 are skipped and 6 fail; the 6 need GNU tools and `wtype`, as they did before this branch.
  - `swift test` compares JavaScriptCore's answers with node's, and checks hotkey parsing and private dirs.
- **On Omarchy 4.5 (Hyprland 0.56.2):**
  - With the plugin on this branch, the shell log shows no omacast errors.
  - `omarchy plugin validate .` passes, and `tests/smoke.sh` passes (show 56–58 ms, hide 28–31 ms).
  - Typing, the Ctrl+K action panel, the Ctrl+P dropdown, the calculator, argument pills and the alias editor were driven with `wtype` and checked by screenshot, in Omarchy's theme.
- **Live on macOS:**
  - The panel shows and becomes key in about 7 ms once warm, and hides in 1–5 ms.
  - Launch, and focus of a running app.
  - Lock Screen, Sleep Displays, Empty Trash, Toggle Appearance and Restart (chosen in the launcher; omacast came back at login).
  - A System Settings pane opens.
  - Launch at login with an ad-hoc signature.
  - Install and uninstall.
  - Every view and theme was checked by screenshot.
- **Settings from Omarchy:** files written by the Omarchy build load unchanged.

Open:
- **macOS, with Accessibility granted:** a real hotkey press, Paste Answer and Open New Window.
- **Not run:** Shut Down and Log Out. They send the same loginwindow Apple Event as Restart, which was run.
- **Dropped:** a clean-account install; the scratch-folder install test stands in for it.

Not built: the optional Flea search helper (the JS matcher is used),
notifications, an app icon, and notarized releases. Later SPEC phases
(clipboard history, snippets, script commands, extensions, window management)
apply to both versions.
