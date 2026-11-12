# CLAUDE.md

This repo is a clean-room rebuild of **Raycast for Linux**. The first target is **Omarchy**: Arch Linux + Hyprland, plus Omarchy's own scripts, themes and bindings. The behaviour and interfaces come from a static reverse-engineering pass over Raycast 2.8.2 on macOS, done with the `reverse-engineer-anything` skill. This repo holds that pass's results and no Raycast code.

## Read these first

| File | What it is | When to read it |
|---|---|---|
| `SPEC.md` | **The plan.** Architecture, IPC contract, platform matrix, data layer, root-search algorithm, feature catalog, extension runtime, frontend, `.rayconfig` import, phased build plan with acceptance checks. | Before any work. Re-read the relevant section before each phase. |
| `docs/THEME_SPEC.md` | **The theme spec.** Omarchy QML tokens, Windows Electron theme engine, `colors.toml` / `shell.toml` schemas, layout scaling, contrast and component mapping. | Any UI, styling, or theming work |
| `reference/01-host-ipc.md` | Native host: window model, ~408 host capabilities (§4.1), WebView bridge, host↔backend wire protocol, helper processes, a Linux mapping for each (§4.3). | Phase 1 (window), Phase 5 (supervisor, for the Node extension host), Phase 6 (WM) |
| `reference/02-backend.md` | Backend service map and RPC methods, DB engine, **root-search ranking (§4)**, frecency (§4.6), clipboard (§5.1), snippet placeholder grammar (§5.2), quicklinks (§6), calculator, indexer. | Phases 1–4, 7 |
| `reference/03-extensions.md` | `@raycast/api` runtime: worker model, reconciler, **render-tree JSON schema (§2.4)**, API→RPC table (§3.2), manifest (§4), Script Commands (§5), install pipeline (§6), Icon enum (App. A). | Phase 2 (script commands), Phase 5 |
| `reference/04-frontend-features.md` | **Built-in command catalog (§1, App. A)**, launcher UI anatomy (§2), default shortcuts (§2.8), settings pages (§3, App. B/C), themes and design tokens (§4). | Phase 1 onward, every UI task |
| `reference/05-data-config.md` | On-disk layout, DB encryption, reconstructed schema, `.rayconfig` format (§5), XDG mapping (§8). | Phase 0 (paths, DB), Phase 8 (import) |
| `reference/schema-nonai.sql` | Raycast's non-AI DDL, reconstructed. **Reference only.** The clone uses the simpler schema in `SPEC.md §6.4`. | When you need a field Raycast stores |
| `reference/backend-methods-nonai.txt` | Every non-AI backend RPC method name. **Do not implement all of them.** Reuse the names for what each phase needs. | When naming an IPC method |

Spec legend: **[O]** observed in Raycast, **[I]** inferred, **[D]** design decision for this clone. [O] is ground truth for behaviour. [D] may be changed if you have a reason; note the change in `SPEC.md`.

## Ground rules (from SPEC.md §0, non-negotiable)

1. **Clean room.** Never copy, bundle or redistribute anything from `Raycast.app` (JS, icons, fonts, `.node` modules). Allowed: the public npm `@raycast/api` / `@raycast/utils` packages (check the license of the pinned version) and the MIT `raycast/extensions` repo.
2. **Never call `*.raycast.com`.** No store, account, sync, telemetry or currency APIs. Build extensions from a local `raycast/extensions` clone.
3. **No telemetry.** No Sentry, no PostHog.
4. **No embedded AI features.** The fork's user-authorized exception is an explicit hand-off of root-search text to Omarchy's existing default-agent terminal launcher (SPEC §2.0). No model API, credential handling or automatic submission while typing. Other built-ins remain non-AI.
5. **Port the root-search ranker exactly** from `reference/02-backend.md §4.2–4.5`. Do not substitute fzf, nucleo or fuse.js.

## How to work

- Build **phase by phase** following `SPEC.md §12` (Phase 0 → 9). A phase is done only when its **Accept** checks pass. Then move on.
- After each phase, update the **Status** section at the bottom of this file: what works, what's stubbed, and any deviations from the spec.
- If the reference docs don't answer a question, choose a sensible value, mark it `[I]` or `[D]` in a code comment, and keep going. Raycast.app is not on the Omarchy machine. Re-running the reverse-engineering only works on the Mac where `/Applications/Raycast.app` lives.
- The working name is **`oma-cast`**: plugin id `typecraft.oma-cast`, CLI `oma-cast`, IPC target `oma-cast`, layer namespace `oma-cast`, URL scheme `oma-cast://` (later). Also register `raycast://` for extension deep links (SPEC §5.5).

## Architecture: an Omarchy shell plugin (SPEC §2.0)

oma-cast runs **inside `omarchy-shell`**, Omarchy's long-lived Quickshell process, as the plugin `typecraft.oma-cast`. That is how Omarchy builds its own menu, emoji picker and clipboard overlays. **Keep external dependencies near zero:** QML and plain JS only, using what Omarchy already ships (Quickshell, Qt, bash, socat, Hyprland). No Tauri, Node runtime, npm packages or native modules without asking first. The Tauri/Node design in SPEC §2 is kept for reference only.

To learn the host, read the shell's own code in `$OMARCHY_PATH/shell/` (`/usr/share/omarchy/shell`):
- `shell.qml`: plugin loading, `summon`/`hide`/`toggle`, and the scoped `shell` API
- `plugins/menu/Menu.qml`: the Omarchy launcher/menu
- `plugins/emojis/Emojis.qml`: a small overlay plugin
- `services/AppLibrary.qml` + `AppSearch.js`: desktop entries, icons, `uwsm-app -- gtk-launch` launching
- `Commons/{Style,Color,Util}.qml` (Omarchy 4.0.x has no `Ui/OverlayWindow`; overlays are a `PanelWindow` on `WlrLayer.Overlay`)
- `default/agents/skills/omarchy/plugins.md`: plugin safety rules. Use `textFormat: Text.PlainText` for any dynamic text.

## Repo layout

```
SPEC.md, reference/      # the spec
plugin/                  # the Omarchy shell plugin (what gets linked into ~/.config/omarchy/plugins/)
  manifest.json          #   id typecraft.oma-cast, kind "menu" (so the shell passes shell.appLibrary), keepLoaded
  Launcher.qml           #   entry point: open()/close() from the shell, IpcHandler "oma-cast", GlobalShortcut oma-cast:toggle
  Backend.qml            #   in-process backend: paths, config.json, stores, method registry, notifications
  ui/                    #   launcher surface and (later) views
  services/              #   QML services that do I/O (JsonStore, OmarchyMenuSource; later clipboard, …)
  core/*.js              #   pure logic, no Qt imports: shared by QML and node tests (module.exports guard)
                         #   Ranker, Frecency (ref 02 §4, port exactly), OmarchyMenu, RootSearch, Schema, Migrate, Rpc, Paths, Log
electron/                # the Windows port (Electron): pixel-faithful DOM port of plugin/ui + node ports of the services
                         # reuses plugin/core unchanged; see electron/README.md
bin/oma-cast             # bash CLI
tests/*.test.js          # node --test unit tests for plugin/core (ranker, frecency, Omarchy menu, root search, …)
tests/smoke.sh           # live acceptance check against the running shell
```

Rules for `plugin/core/*.js`: one self-contained file per module (QML `import "x.js"` and node `require` must both work, so a module never imports another one). Expose functions through the `if (typeof module !== "undefined") module.exports = …` guard. QML wires the modules together.

## Commands

```sh
node --test tests/*.test.js   # unit tests (node's built-in runner; no npm install)
mise x act@latest -- act push   # run .github/workflows/ci.yml locally in Docker (.actrc maps the WarpBuild label)
tests/smoke.sh               # live checks: doctor, IPC, toggle latency (<100 ms). Shows/hides the launcher, never types.
omarchy plugin validate plugin

bin/oma-cast install         # link plugin into ~/.config/omarchy/plugins, enable it, link CLI into ~/.local/bin
bin/oma-cast reload          # pick up QML/JS edits (see "Reloading" below)
bin/oma-cast dev             # reload on every save under plugin/ (needs inotifywait)
bin/oma-cast uninstall

oma-cast toggle | show | hide
oma-cast run <commandId>             # Phase 1+
oma-cast call <method> [json]        # any backend method, e.g. oma-cast call system.info
oma-cast doctor
oma-cast setup hyprland              # writes ~/.config/hypr/oma-cast.lua (Alt+Space) and requires it from hyprland.lua

qs log -n -p "$OMARCHY_PATH/shell" -t 50    # shell log; our lines start with [oma-cast]
```

**Reloading.** Quickshell keeps every QML/JS file it has read, keyed by path, for the life of the process, and the shell's inotify watch doesn't follow the symlink into this repo. So editing files under `plugin/` changes nothing until `oma-cast reload` re-links the plugin under a fresh `typecraft.oma-cast.dev-<ns>` path. Always reload, then check `qs log` for QML errors, before concluding a change works. A QML error shows up as "Type X unavailable" plus the real cause on the next line. Names that clash with JS globals (such as `escape`) are "Illegal method name".

## Running on Omarchy

Check each of these on the machine instead of assuming it; Omarchy changes often.

- **Hyprland config is Lua** (Hyprland 0.56). `~/.config/hypr/hyprland.lua` `require`s `default.hypr.omarchy` and the user's `hypr.bindings` etc. Bindings use `o.bind("ALT + SPACE", "desc", dispatcher)`. `oma-cast setup hyprland` writes only `~/.config/hypr/oma-cast.lua` and appends one `require("hypr.oma-cast")`. Never edit Omarchy's files.
- **Hotkey.** Super+Space is the Omarchy menu and Super+Alt+Space is the dock's app grid. oma-cast defaults to **Alt+Space** through `hl.dsp.global("oma-cast:toggle")`, so the plugin's GlobalShortcut fires with no process spawn. Users can change their binding in `oma-cast.lua`; never force a Super+Space swap.
- **IPC.** `omarchy-shell <target> <fn> args…` answers over the shell's socket (needs `socat`), falling back to `qs ipc`. Our target is `oma-cast`. `IpcHandler` (Quickshell.Io; 4.0.x dropped `ShellIpc`) functions must have typed params and return a string.
- **Theme.** Bind colours to `Commons.Color.menu.*` and sizes to `Style.*`. They follow `omarchy theme set` live; no theme parsing.
- **App launching.** Use `shell.appLibrary.launch(id, name)`. It goes through `uwsm-app -- gtk-launch`, sends terminal apps to `omarchy-launch-tui`, and shows Omarchy's launch OSD. The shell only provides `appLibrary` to `menu`-kind plugins.
- **Terminals and paste.** Alacritty/Ghostty/Kitty need Ctrl+Shift+V (SPEC §5.3). Read the class from `hyprctl activewindow -j`.
- **Notifications** go to the Omarchy shell's notification service (`org.freedesktop.Notifications`). The bar has a tray widget (SNI).
- **Snippet expansion** needs the `input` group or a uinput udev rule. Keep it opt-in; `oma-cast doctor` explains it.
- **Testing on the live desktop.** Don't synthesize keystrokes (`wtype`) unless the launcher is already mapped and focused. Keys sent within about 25 ms of `show` go to the window underneath, which is usually the terminal running Claude.

## Status

Renamed **raylinux → oma-launcher → oma-cast** on 2026-10-19 (plugin `typecraft.oma-cast`, CLI `oma-cast`, IPC target and global shortcut `oma-cast:toggle`, XDG dirs `oma-cast`). The app icon is Omarchy's logo: glyph `\ue900` in the `omarchy` font, the same one the bar's menu button uses.

**Phase 1 (Quickshell build): done**, with the gaps listed below. **Phase 0: done.** Omarchy 4.0.0.alpha, Quickshell 0.3.2, Hyprland 0.56.2.

Works:
- **Root search** ported from ref 02 §4.2–4.6 (`core/Ranker.js`, `core/Frecency.js`, golden tests). Sections (`core/RootSearch.js`):
  - empty root: Favorites, Suggestions (frecency > 1, top 6), Commands, Applications
  - query: Results, then `Use "<q>" with…` (Google, DuckDuckGo fallbacks)
- **Providers:** apps from `shell.appLibrary`, the whole Omarchy menu (about 400 items, with breadcrumbs, guards, ✓ state and font/power-profile provider rows), and the built-in "Omarchy Menu".
- **Ranking state:** frecency (+100 per launch, 10-day half-life) and learned search terms in `db/frecency.json`. Aliases (exact → top; duplicates rejected), favourites (Ctrl+Shift+F, reorder Ctrl+Alt+↑↓) and disabled commands live in `db/settings.json` `commands`.
- **Navigation:** pushed Omarchy submenus (search within them), the alias editor, back with Esc / Ctrl+[ / Backspace on an empty query / the header arrow, and Shift+Esc to pop to root.
- **Keyboard:** Ctrl+K action panel (filterable, per-row shortcuts), ↵ / Ctrl+↵ / Ctrl+Shift+↵ for the first three actions, Ctrl+1–9, Ctrl+↑↓ to jump sections, PageUp/PageDown, ↑ on an empty root for search history, Ctrl+Shift+C copy, Alt+Shift+D disable, Ctrl + / − / 0 zoom.
  - Navigation bindings (`general.navigationBindings`): `emacs` moves down with Ctrl+N; `vim-motions` moves with Ctrl+J/K and puts the action panel on **Alt+K**. Set it with `oma-cast call settings.updateGeneralSettings '{"navigationBindings":"vim-motions"}'`.
  - **Ctrl+P** opens the root dropdown (All / Applications / Commands); emacs Ctrl+P = up only works inside popups.
  - **Ctrl+T** opens the toast's actions (Copy Error Message on failures, Undo after Disable Command). **Ctrl+Shift+K** opens the About panel for the selected row.
  - **Web search:** "Search Google" / "Search DuckDuckGo" / "Search unduck" push a dedicated view with a full-width query bar (like Settings) — type the query there, ↵ searches. No inline pills.
  - **Alerts:** Shut Down, Restart, Log Out and Delete All Entries ask first (↵ confirms, Esc cancels). `oma-cast run` skips the alert.
- **Feedback:** toasts in the footer, a HUD through Omarchy's OSD when the window closes, and a 2 px loading bar while guards and providers refresh (on every open, about 250 ms in the background).
- **Window behaviour:**
  - The `escapeKeyBehavior` setting works both ways.
  - Pop-to-root runs after `popToRootTimeout`.
  - Compact mode shows only the header until you type.
  - A launch from root clears the query [I].
  - A row is selected on hover only after a real pointer move (Omarchy's PointerMoveGate).
- **Calculator** (`core/Calculator.js`, our own engine [D]; no `qalc`/fend dependency): a "Calculator" section above Results with Raycast's two-pane card (question → answer, captions below each). It handles:
  - arithmetic and functions
  - Soulver-style percentages (`$30 + 20%`, `20% off 50`, `50 as a % of 200`)
  - ~250 units (`5 ft to cm`, `60 mph * 2 h`, `16px to rem`)
  - currencies (ECB rates from frankfurter.dev, cached daily in `~/.cache/oma-cast/currencies.json`; turn off with `"currencyRates": false` in config.json)
  - dates (`3 days from now`, `days until christmas`)
  - time ranges (`10:35pm to 11:10pm` → 35 minutes; times read forward and wrap past midnight, `11pm to 1am` → 2 hours; `dec 25 to jan 5` → 11 days)
  - time zones (`time in tokyo`, `3pm london to nyc`; offsets come from one bash `printf %(%z)T` pass because QML has no Intl)
  - bases (`255 to hex`)
  - mixed units (`5 ft 3 in to cm`, `1 h 30 min + 45 min`)
  - work time (`40 hours in work days`, a work week is 5 days)
  - Unix time (`unix 1700000000`, `1700000000 to date`, `now to unix`, `unix time`)

  config.json sets `remToPxRate` (16), `workHoursPerDay` (8) and `clockFormat` (`auto` follows the Qt locale, or `12h` / `24h`).

  ↵ copies the answer (HUD), Ctrl+↵ pastes it through `omarchy-clipboard-paste-text`, Ctrl+Shift+C copies "question = answer". Each one saves to **Calculator History** (`db/calculator.json`, 4096 rows / 90 days): a built-in command and pushed view, searchable, Ctrl+D deletes an entry, Ctrl+Shift+D deletes all. RPC: `calculator.calculate|historyGetAll|historyDelete|historyDeleteAll|refreshCurrencies|getCurrencies`. A bare number, word or quantity (`42`, `firefox`, `5 kg`) never produces a row, because the section takes ↵.
- **Latency:** show → mapped in 59–66 ms, hide in 24–42 ms on Omarchy 4.0.6 (`tests/smoke.sh`; it was 37–44 ms on the old `OverlayWindow`).
- **Tests:** root search, calculator and default-agent hand-off coverage (`node --test tests/*.test.js`).

**Default-agent hand-off (fork, 2026-10-20):** user-authorized addition outside the original phase plan. The root fallback "Ask default agent" and Ctrl+Alt+Enter pass the query to `omarchy-agent --prompt` as a literal argv element. `AgentLauncher.qml` checks the configured agent/terminal with a bounded, question-free preflight, prevents overlapping submissions and cancels on hide/unload. `Launcher.qml` dismisses the overlay before launching through `Util.execArgv`. Errors leave the query visible. There are no new dependencies, model APIs, credentials or question-history writes. Existing CLI approval behaviour is inherited. Portable checks do not establish live terminal focus, authentication, or provider compatibility; verify those on Omarchy.

Stubbed / not yet:
- No settings window, so you can't re-enable a disabled command except with Undo on the toast (Ctrl+T) or by editing `~/.local/share/oma-cast/db/settings.json` (delete its `enabled: false`). That's Phase 2.
- No deep links (`oma-cast://`); Phase 2 or 9.

Won't do (decided 2026-10-22):
- Keystroke buffering. Keys sent within ~40 ms of the hotkey go to the window underneath; fixing it needs a parked surface, which Omarchy avoids (SPEC §12 Phase 1).
- Calculator: Color, Weather and Flight results, crypto, pinned history entries and a history detail pane. Trig takes radians unless given `°`/`deg` [D].

**Windows port (Electron, `electron/`, started 2026-10-23):** built on request (“port this to windows, UI copy-faithful”). A pixel-for-pixel DOM port of the QML UI: the theme pipeline (Omarchy's own `shell.toml.tpl` renderer + `colors.toml` resolver, Tokyo Night bundled), the token scale, every geometry formula, the `handleKey` state machine and the Nerd Font glyphs (bundled `omarchy.ttf` + JetBrainsMono Nerd Font). `plugin/core` runs unchanged on both platforms. Host substitutions and everything that needs a live Windows box are listed in `electron/README.md`. `Schema.js` gained Windows config keys (`hotkey`, `fontFamily`, `agentCommand`, `gapsOut`, `cornerRadius`, `fileSearchScopes`, `fileSearchIncludeHidden`) and `Paths.js` a `resolveWindows`; both are backward compatible with the QML build. Data on Windows: `%APPDATA%\oma-cast` (config), `%LOCALAPPDATA%\oma-cast` (db), `%LOCALAPPDATA%\State\oma-cast` (logs/state), `%LOCALAPPDATA%\Temp\oma-cast` (cache) — `resolveWindows` mirrors the XDG layout.

Windows-port additions (2026-10-25, user-driven): **file search** (`FileSearch.js` + `electron/src/file-index.js`, SPEC §8.6 slice: Files section, Open/Reveal/Copy Path, 100k walk with cache, no watcher [D]), **unduck.link** as the third web fallback + quicklink, an in-app **Settings** view (`SettingsView.js`, ↵ cycles, hotkey re-registers live — the Phase-2 stub closed on this platform), **Kill Process** (`electron/src/processes.js`, confirm → `taskkill /F`), **Windows Settings** (`electron/src/windows-settings.js`, 71 `ms-settings:` deep links grouped by category, pushed from the root and from the first row of the Settings view; built-ins marked `platform: "windows"` are skipped by `plugin/Backend.qml`), NSIS installer exe via electron-builder (icon from the omarchy TTF; **fonts must be `asarUnpack`ed** — Chromium mmaps them and asar-mmap fails silently → tofu icons), a foreground-lock focus grab with PowerShell `SetForegroundWindow` fallback, and `%LOCALAPPDATA%\State\oma-cast\logs\main.log` diagnostics. `VERSION` in `backend.js` comes from `electron/package.json`, so `doctor`/`system.info` cannot drift from the installer. Also: a **place for themes** — `%APPDATA%\oma-cast\themes\<name>\colors.toml` (`electron/src/themes.js`, no rebuild needed) with a **Theme** row in Settings that cycles what's on disk and repaints live through `settings.configChanged`; the caret actually blinks now (`caret-blink` in `style.css`, the 530 ms half-periods the README already claimed); and Start Menu icons extract again — `powershell.exe -Command` joins its trailing arguments into the script text, so `$args[0]/[1]` never bound and every extraction failed silently; the paths are interpolated (PowerShell-quoted) instead, links resolve to their target first, and rows fall back to `U+F2D0` when nothing comes back. Wiring bugs found 2026-10-25 from the first real Windows runs: `ui/app.js` never created the `processes` and `fileIndex` services (the tests inject them, so both suites stayed green), which is why **Kill Process pushed an empty view and the Files section never appeared**, and `backend.visibility()` was never called, so a show never refreshed rates/apps/files. Fixed — the window creates both services now (`excludePaths: [process.execPath]` keeps the launcher out of its own list, alongside `ownPid`) and calls `backend.visibility` on every show/hide; both PowerShell snapshots set `[Console]::OutputEncoding` to UTF-8 first. Text elide is ported rather than faked: the DOM left-ellipsis trick (`direction: rtl; text-align: left`) reordered any query whose first strong character is not LTR — `1 rem to px` displayed as `rem to px 1` — so `#query`, `.pill span` and `.panel-search span` are LTR again and `electron/src/text.js` does `Text.ElideLeft` in JS (tail kept, `…` in front); the pill caret also stopped measuring a detached element (`clientWidth` was 0). Still no extension runtime (Phase 5).

**0.2.0 (2026-10-26, one release — three user asks shipped together):** (1) **Open at Login** — a Settings row over ref 04 §3's `openAtLogin` (`config.json`): `main.js applyOpenAtLogin()` turns it into the real HKCU Run entry with `app.setLoginItemSettings` (dev runs pass the repo dir as `args`), applied at launch and on every `host-config-changed`; the backend's config watch now calls `host.configChanged()` too, so an on-disk edit of `config.json` reaches the process that owns the hotkey and the login item. `oma-cast.ps1 install` no longer plants a Startup-folder shortcut — it writes `"openAtLogin": true` BOM-free (`[IO.File]::WriteAllText`) and both it and main delete the legacy `oma-cast.lnk`, because two entries racing at login ends with the second instance toggling the window open on the desktop. (2) **Focus hand-back on close** — `show()` maps with `showInactive()` so a resident PowerShell helper (`ping`/`getfg`/`focus <hwnd>`, `FOCUS_HELPER_SCRIPT`; ~10 ms a command once warm instead of a ~300 ms spawn) can sample the *other* window's HWND before we take the foreground; `hide(afterFocus)` hands it back with `SetForegroundWindow` — only while we still hold focus, since on blur the clicked window already won (`prevFh` is cleared there) — and the paste path waits for the hand-back (≥150 ms total) so Ctrl+V lands in the right window. A cold helper means no wait and stock Windows behaviour: focus never waits on the capture. (3) **The missing apps (Notion)** — the scan now covers the user and public **Desktops**, and **Store/MSIX apps**, which ship no `.lnk` anywhere: `Get-StartApps` (falling back to the in-box `shell:AppsFolder` namespace) yields `uwp:<AppID>` rows that launch through `explorer shell:AppsFolder\<AppID>` and show the generic `U+F2D0` glyph (no file to extract an icon from). `system.info.applications` + the doctor's `applications:` line print the scan count so a short list is visible. (4) **Take me there** — ↵ on an app that already has a window switches to it instead of spawning a second instance: the backend derives the exe name from the shortcut target and asks main (`host-focus-app`), and the renderer's `focusAppWindow` settles exactly once (reply, error or a 2.5 s safety timer → launch) so a launch can never be swallowed. Main clears `prevFh` on receipt — the close that follows must not hand focus back, the app gets it — and the helper's new `app <exe>` command does `Get-Process` → `MainWindowHandle` → restore (`SW_RESTORE` when minimized) → `SetForegroundWindow`, sharing one `FocusHwnd` (dummy-ALT fallback) with the hand-back command. No window (tray-only process), a Store row's family-prefix guess that misses, a wrapper shortcut (explorer/cmd target with the app in its arguments), or no answer → the normal launch — and every attempt is now logged on both sides (`app switch: X → ok 1|none|no answer` in `%LOCALAPPDATA%\State\oma-cast\logs\main.log`, plus the backend's `switch requested` / `direct launch`) so a live machine can show exactly which way it went. Two hardenings with it: the handler sanitises instead of whitelisting (an exe with parentheses used to silently fall through to a launch) and the helper gets 2 s — inside the renderer's 2.5 s fallback — so a cold PowerShell answers instead of timing out into a duplicate. Tests: the row + validation, the toggle writing config and notifying main, an on-disk edit reaching main, the hand-back wiring, the switch fallback chain + host adapter, and `launchArg`/scan coverage.

**0.2.2 (2026-10-27, root-caused live on the Windows box):** the switch never worked on 0.2.0/0.2.1 — not a lookup problem: `Add-Type` received **one `[DllImport]` for six `extern` methods** (a C# attribute covers only the next declaration) so the type refused to compile, `getfg`/`focus`/`app` all threw and answered `err`, and main read `err` as "not running" → a duplicate instance on every ↵. The close hand-back (`getfg` never captured `prevFh`, so no `foreground before show` line ever appeared) and the one-shot foreground steal were dead the same way — the steal was doubly broken, passing its HWND as a trailing `-Command` argument (powershell.exe joins those into the script text; the apps.js lesson again). Every extern carries its own `DllImport` now, `focusScript()` interpolates a validated integer handle, and a regression test counts `DllImport` vs `static extern` in `main.js` and forbids `$args`. Proven on the box through the real helper: `ping`/`getfg`/`focus <fg>`/`app Obsidian` answer `pong`/`fg 330594`/`ok 1`/`ok 1`, an unknown name answers `none`. Docs corrected with it: logs are `%LOCALAPPDATA%\State\oma-cast\logs\main.log`, cache is `%LOCALAPPDATA%\Temp\oma-cast` (`resolveWindows` mirrors XDG state/cache — the old paths in README/release notes never existed, which is why the log took a `find` to locate).

**0.2.3 (2026-10-27):** app searches returned files instead of the app — two compounding defects, reproduced without a Windows box. `FileSearch.match` fell back to full-*path* matching with no quality floor, so `files` returned `data.db` purely because its path contains `...\Files\...`; and well-known apps couldn't match their natural query (`files` vs "File Explorer", `notes` vs "Notepad", `screenshot` vs "Snipping Tool") because entries carry no keywords and the ranker is the strict exact port. Fix: `match()` gains a `nameOnly` option, the backend passes it for single-token non-path queries (multi-token and path-like queries keep path matching), and `apps.js` carries a small alias table (`APP_KEYWORDS`, exported as `keywordsFor` for tests). `files` now ranks File Explorer with no Files section; `notes` ranks Notepad *and* keeps the genuine `notes.txt` row.

**0.2.4 (2026-10-27):** typing-lag fix. Keystrokes painted immediately with the heavy search coalesced to one rebuild per burst (Enter/actions flush first); rows switched to flexbox (no per-row forced layout); file-match lowers each entry once per query with index-cached lowercase; index walk slices 400→120 with timer yields; Start Menu scan throttled to 30 s and icon extractions capped at 4 concurrent with duplicate coalescing; show paints from cache first, background refresh deferred 250 ms.

**0.2.5 (2026-10-27):** black-screen fix. The launcher was a fullscreen transparent overlay, which paints the whole monitor opaque black wherever compositing fails (VMs, RDP, some drivers). It is now a card-sized window centered on the monitor under the cursor (Raycast/Spotlight style): the renderer reports its card size after every layout (`host.resizeWindow` → `resize-window`) and main resizes to fit, so even with no alpha the desktop stays visible around the card and only the rounded corners are affected. Clicks outside dismiss through blur as before.

**0.2.6 (2026-10-27):** missing-apps coverage. The scan only walked Start Menu Programs + Desktops plus Store rows, so registered exes with no shortcut anywhere (portable tools, dev-tool binaries, browsers) were invisible. It now walks the Start Menu roots (stray top-level links count) and appends the App Paths registry (HKLM + HKCU, registry reads only — no COM, so they survive locked-down PowerShells), skipping an App Paths row whose exe a shortcut row already covers. Every scan also logs its entry count (`library refreshed` in main.log) next to the doctor's `applications:` line, so a short list is diagnosable.

**0.2.7 (2026-10-27):** file search provider setting. The Settings view gains a **File Search Provider** row (↵ cycles Built-in Index ⇄ Everything): `everything` queries voidtools Everything through `es.exe` (`%ProgramFiles%\Everything`, then PATH; one sync spawn per query, 5 s cap) so Files goes system-wide and instant, while the same ranker — nameOnly guard included — tiers the hits. A dead Everything (not installed/running) answers null and that query falls back to the walk pool; the walk parks (no re-walk churn) while Everything serves, and resumes when you switch back.

**0.2.8 (2026-10-28):** (1) **Web search without the pill** — Search Google / DuckDuckGo / unduck no longer take the query in a ~200 px inline pill after the root text (Tab in, Shift+Tab out); each builtin pushes a dedicated search view with a full-width query bar, like Settings (type there, ↵ searches, Esc pops). The pushed view shows one live row per query (`web-search:*`, separate from the root `fallback:*` rows), errors on empty ↵, and records the frecency visit on the builtin so engines rise with use. Root `Use "q" with…` fallbacks are unchanged. (2) **Power actions fire immediately** — Shut Down / Restart no longer schedule `shutdown /s|/r /t 15` with a cancellable toast (`shutdown /a`); like Sleep they close the window first and fire at once (`shutdown.exe /t 0`) with a HUD. `system.cancelPowerShutdown` stays for old toasts.

**0.2.9 (2026-11-01):** (1) **Calculator time ranges** — `<time/date> to|until|till <time/date>` returns the span: `10:35pm to 11:10pm` → 35 minutes. Times read forward and wrap past midnight when both sides fall on the same day (`11pm to 1am` → 2 hours, `11pm to 10pm` → 23 hours); date-only pairs stay absolute with floating year-less sides rolling forward (`dec 25 to jan 5` → 11 days); conversion targets still convert (`now to unix`, `1700000000 to date`). (2) **Typing latency, second pass** — each keystroke burst paints apps/commands instantly with the Files tier deferred to a 150 ms trailing pass, and icon extractions stay queued while typing. (3) **Files wait for apps** — the Files section stays hidden until the first Start Menu scan completes (`apps.scanned` latch), so a cold show never renders Files before Applications exists.

**0.2.10 (2026-11-03):** app search is up to 71× faster (median 34× on repeats, ~3× on fresh keystrokes — `bench/app-search.chart.svg`). Three layers, all result-identical (differential-fuzzed old-vs-new over ASCII/Unicode/pins/sensitivities, 0 diffs/77 cases): (1) **Ranker prefilter** — an O(n) subsequence gate in `fuzzyMatch` plus a hoisted `needsFullRecord` that skips transliterate + all DP for provable non-matches (transliteration-aware after review caught a `Café`/`cafe` false reject), string-keyed normalize/transliterate caches, hoisted query transliteration, and keyword-DP skip once the title already passes (keywords only feed the match boolean, never ordering). (2) **Decorated-list memo** — one clone + Math.exp per candidate per minute-bucket instead of per keystroke (frecency order is monotonic in anchor at fixed now, so bucketing never reorders). (3) **Result memos** — single-entry rank memo in `RootSearch` plus a frozen shared-reference memo in `backend` for the app-only root path (calculator rows stay fresh; time-varying outputs ride in the key). `bench/app-search.bench.js` reproduces the numbers (`node bench/app-search.bench.js new|old`).

**0.2.11 (2026-11-05):** typed web addresses open in the browser. A root query that reads as an address — `apple.com`, `www.org`, `https://example.com/x?q=1`, `192.168.1.1:8080`, `localhost:3000` — gains a header-less **Open in Default Browser** row above Results (globe glyph, the URL as subtitle), selected first, so ↵ leaves the launcher for the browser instead of searching. Ctrl+Shift+C (or the Ctrl+K panel) copies the URL instead. Detection is deliberately conservative because it is the first row: whitespace disqualifies, numeric endings (`1.5`, `12.3.4`) are calculator input, and bare tokens need a listed web TLD, so `main.rs`, `notes.md`, `app.js` and `deploy.sh` stay searches (they are also country TLDs); an explicit `http(s)://` bypasses the list so any address still opens. The row is derived from the current query rather than stored as a candidate, so the QML backend opens it through `omarchy-launch-browser`, the Electron port through `shell.openExternal`, and neither touches frecency. `RootSearch.typedUrl`/`urlCandidate` carry the logic; tests cover the accepted and rejected shapes on both backends. Not checked against a live shell (the desktop session was not running when this was built).

**0.2.14 (2026-11-11):** Quick Capture — type a note, save it as markdown. A **Quick Capture** builtin pushes a view with a full-width note bar (like web search): type there, ↵ saves. Settings rows **Quick Capture Mode** (`inbox` = same `inbox.md`, `daily` = same `YYYY-MM-DD.md` per day, `new` = a new timestamped file per capture; ↵ cycles) and **Quick Capture Directory** (empty = the default Notes folder under app data; `~`/relative resolve against home; ↵ pushes an editor view where the query is the value, empty resets to default). The pushed row previews the note with its target file and mode; ↵ saves respecting the mode, Ctrl+↵ (**Save as New File**) forces a new file for that capture, Ctrl+Shift+C copies the note, plus Reveal Folder. Pure shaping in `plugin/core/QuickCapture.js` (shared by both backends; `RootSearch` stays dependency-free), sync `fs` writes on Electron (heading on first append, `-1` on same-second collisions) and one `bash` mkdir+append/write (argv, never a shell string) on QML; the builtin earns the frecency visit so it rises with use. New `tests/quickcapture.test.js` + `electron/src/quickcapture.test.js`; `settings.json` gains migration v2 (`store.test.js` now expects v2). Not checked against a live shell/Windows box.

**0.2.14 (2026-11-12):** Todoist — add, complete and delete tasks (shipped in the same 0.2.14 as Quick Capture above; no tag existed yet, so one release covers both). **Todoist** and **Add Todoist Task** builtins push a grouped task list (Overdue / Today / Upcoming / No due date) and a full-width add bar. ↵ marks done, Ctrl+↵ deletes (confirming with the task named — deletes have no undo), Ctrl+Shift+↵ copies the title. Creates go through `POST /tasks/quick` so the server parses `p1`, dates, `#projects` and `@labels` — no numeric priority is ever sent (the v1 doc's "1 is highest" line is wrong on the wire: API 4 = p1, confirmed against Todoist's CLI/SDK and noted in `plugin/core/Todoist.js`). Token from `TODOIST_TOKEN` or `"todoistToken"` in config.json (deliberately no Settings row, to keep it off screen); without one the commands explain instead of pushing. Pure shaping in `plugin/core/Todoist.js` (no `Intl` — plain `Date` + month arrays, like Calculator), QML I/O in `plugin/services/TodoistSource.qml` (XHR queue, one request at a time), node I/O in `electron/src/todoist.js` (https, stubbed transport in tests). Same RPC surface both sides; the sync RPC returns `{pending:true}` (the AgentLauncher pattern) and `todoist.*` notifications toast + rebuild (`todoistRevision` polled on Windows, bound on QML). New `tests/todoist.test.js` + `electron/src/todoist.test.js` + `electron/src/todoist-backend.test.js`. Not checked against a live shell/Windows box, and not against the real Todoist API from this machine.

**0.2.13 (2026-11-06):** cold-start app audit — from a cold start the window searched everything *except* apps. Root cause: the app library had no disk cache (every launch began with zero candidates and waited on the async PowerShell enumeration, seconds on a cold boot), the scan parse was one stray char from silent wipeout (`JSON.parse(res.stdout)` with no BOM/whitespace hardening — PowerShell can emit a BOM, and the es.exe path already strips `\uFEFF` for exactly that reason), and a 0-row scan clobbered good entries while still flipping `scanned`. Fix in `electron/src/apps.js`: `%LOCALAPPDATA%\Temp\oma-cast\apps.json` cache (slim rows, preloaded synchronously in the factory — ~100 KB, single-digit ms — so the first show paints cached apps and the scan only refreshes), `execFile`/`log` hooks, hardened parse, and an empty-scan guard that keeps previous entries, never persists empty, and warns. `electron/ui/app.js` passes the cache path; new `electron/src/apps.test.js` covers round-trip, preload-before-scan, BOM/blank, single-object wrap, the empty-scan guard, and a backend cold-start search. `VERSION` comes from `package.json`, so `doctor`/`system.info` report 0.2.13 with no drift.

**0.2.12 (2026-11-06):** launch-to-ready is 30–50× faster (100×+ with a stale file index). `start()` no longer parses the file-index cache synchronously (a 9 MB / 100k-entry cache cost 382 ms; a stale cache also triggered its re-walk on the launch path) — it loads post-launch and lands via rebuild. Timezone offsets (66 `Intl` constructors, ~30 ms) build only on tz-shaped queries through a new `Calculator.maybeTimeZone` gate; the ECB fetch and its ~70 ms undici init fire one loop after start; and the heavy modules (`FileSearch` 43 ms, `themes` 9 ms, `Calculator` 8 ms parse) load lazily on first use, so the show path never touches them. A post-start warmup runs one side-effect-free search (`skipFiles`, no es.exe spawn, no frecency writes) through the real wrapper so the first keystroke skips JIT/compile coldness. New `bench/show-startup.bench.js` (CPU-time based, so a loaded box can't fake numbers) plus a `.hillclimb.tsv` run ledger; `features.test.js` now asserts the index goes ready after its background load instead of synchronously.

Deviations from the original spec (SPEC §2.0 and the Phase 1 note in §12):
- A Quickshell plugin instead of Tauri + Node; there's no NDJSON supervisor until Phase 5.
- JSON documents instead of SQLite; no DB encryption or libsecret key.
- Logs go to the shell log; `config.json` instead of `config.toml`; no D-Bus name.
- The Omarchy theme replaces Raycast's 8 themes; the HUD is Omarchy's OSD.

Testing lesson: the query survives hide/show until pop-to-root. A live test must clear it first (Ctrl+U), or typed text gets appended to the old query. Pressing ↵ on a stale query once opened real browser tabs.
