# CLAUDE.md

This repo is a clean-room rebuild of **Raycast for Linux**. The first target is **Omarchy**: Arch Linux + Hyprland, plus Omarchy's own scripts, themes and bindings. The behaviour and interfaces come from a static reverse-engineering pass over Raycast 2.8.2 on macOS, done with the `reverse-engineer-anything` skill. This repo holds that pass's results and no Raycast code.

## Read these first

| File | What it is | When to read it |
|---|---|---|
| `SPEC.md` | **The plan.** Architecture, IPC contract, platform matrix, data layer, root-search algorithm, feature catalog, extension runtime, frontend, `.rayconfig` import, phased build plan with acceptance checks. | Before any work. Re-read the relevant section before each phase. |
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
4. **No embedded AI features.** No model API or credential handling. (The default-agent hand-off was removed on 2026-11-02; see SPEC §2.0.)
5. **Port the root-search ranker exactly** from `reference/02-backend.md §4.2–4.5`. Do not substitute fzf, nucleo or fuse.js. The user-authorized flea-search matcher in SPEC §2.0 is the matching exception; personalization still uses this ranker.
6. **No user text in argv; private files stay private.** Queries, calculator text and anything else the user typed go to other processes on stdin (`services/ClipboardWriter.qml`), never as arguments. omacast dirs are `0700` and store files `0600` (SPEC §2.0 "Privacy"). The marketplace review enforces this.

## How to work

- Build **phase by phase** following `SPEC.md §12` (Phase 0 → 9). A phase is done only when its **Accept** checks pass. Then move on.
- After each phase, update the **Status** section at the bottom of this file: what works, what's stubbed, and any deviations from the spec.
- If the reference docs don't answer a question, choose a sensible value, mark it `[I]` or `[D]` in a code comment, and keep going. Raycast.app is not on the Omarchy machine. Re-running the reverse-engineering only works on the Mac where `/Applications/Raycast.app` lives.
- The working name is **`omacast`**: plugin id `typecraft.omacast`, CLI `omacast`, IPC target `omacast`, layer namespace `omacast`, URL scheme `omacast://` (later). Also register `raycast://` for extension deep links (SPEC §5.5).

## Architecture: an Omarchy shell plugin (SPEC §2.0)

omacast runs **inside `omarchy-shell`**, Omarchy's long-lived Quickshell process, as the plugin `typecraft.omacast`. That is how Omarchy builds its own menu, emoji picker and clipboard overlays. **Keep external dependencies near zero:** QML and plain JS only, using what Omarchy already ships (Quickshell, Qt, bash, socat, Hyprland). No Tauri, Node runtime, npm packages or native modules without asking first. The Tauri/Node design in SPEC §2 is kept for reference only.

To learn the host, read the shell's own code in `$OMARCHY_PATH/shell/` (`/usr/share/omarchy/shell`):
- `shell.qml`: plugin loading, `summon`/`hide`/`toggle`, and the scoped `shell` API
- `plugins/menu/Menu.qml`: the Omarchy launcher/menu
- `plugins/emojis/Emojis.qml`: a small overlay plugin
- `services/AppLibrary.qml` + `AppSearch.js`: desktop entries, icons, `uwsm-app -- gtk-launch` launching
- `Commons/{Style,Color,Util}.qml` (Omarchy 4.0.x has no `Ui/OverlayWindow`; overlays are a `PanelWindow` on `WlrLayer.Overlay`)
- `default/agents/skills/omarchy/plugins.md`: plugin safety rules. Use `textFormat: Text.PlainText` for any dynamic text.

## Repo layout

```
# The repo root is the plugin: `omarchy plugin add` clones it into ~/.config/omarchy/plugins/typecraft.omacast/
manifest.json            # id typecraft.omacast, kind "menu" (so the shell passes shell.appLibrary), keepLoaded
Launcher.qml             # entry point: open()/close() from the shell, IpcHandler "omacast", GlobalShortcut omacast:toggle
Backend.qml              # in-process backend: paths, config.json, stores, method registry, notifications
ui/                      # launcher surface and (later) views
services/                # QML services that do I/O (JsonStore, OmarchyMenuSource; later clipboard, …)
core/*.js                # pure logic, no Qt imports: shared by QML and node tests (module.exports guard)
                         #   Ranker, Frecency (ref 02 §4, port exactly), OmarchyMenu, RootSearch, Schema, Migrate, Rpc, Paths, Log
bin/omacast              # bash CLI (works from a dev checkout or a marketplace install)
bin/omacast-search       # built flea-search helper (gitignored; bin/build-search builds it from search/)
search/                  # Rust source of the optional helper; builds into ~/.cache/omacast/search-target
SPEC.md, reference/      # the spec
tests/*.test.js          # node --test unit tests for core/ (ranker, frecency, Omarchy menu, root search, …)
tests/smoke.sh           # live acceptance check against the running shell
LICENSE, README.md       # marketplace requirements: root license, install/removal instructions
```

The shell loads only the manifest's entry points, so the spec, tests and Rust source ride along harmlessly. Every push to the default branch reaches marketplace users on their next `omarchy plugin update`. `omarchy plugin validate .` must pass and the tree may hold no symlinks.

Rules for `core/*.js`: one self-contained file per module (QML `import "x.js"` and node `require` must both work, so a module never imports another one). Expose functions through the `if (typeof module !== "undefined") module.exports = …` guard. QML wires the modules together.

## Commands

```sh
node --test tests/*.test.js   # unit tests (node's built-in runner; no npm install)
mise x act@latest -- act push   # run .github/workflows/ci.yml locally in Docker (.actrc maps the WarpBuild label)
tests/smoke.sh               # live checks: doctor, IPC, toggle latency (<100 ms). Shows/hides the launcher, never types.
omarchy plugin validate .

bin/omacast install         # link this checkout into ~/.config/omarchy/plugins, enable it, link CLI into ~/.local/bin
bin/omacast reload          # pick up QML/JS edits (see "Reloading" below)
bin/omacast dev             # reload on every save (needs inotifywait)
bin/omacast uninstall

omacast toggle | show | hide
omacast run <commandId>             # Phase 1+
omacast call <method> [json]        # any backend method, e.g. omacast call system.info
omacast doctor
omacast setup hyprland [--yes]      # asks, then writes ~/.config/hypr/omacast.lua (Alt+Space) and requires it from hyprland.lua

qs log -n -p "$OMARCHY_PATH/shell" -t 50    # shell log; our lines start with [omacast]
```

**Reloading.** Quickshell keeps every QML/JS file it has read, keyed by path, for the life of the process, and the shell's inotify watch doesn't follow the symlink into this repo. So editing files in a checkout changes nothing until `omacast reload` re-links the plugin under a fresh `typecraft.omacast.dev-<ns>` path. Always reload, then check `qs log` for QML errors, before concluding a change works. A QML error shows up as "Type X unavailable" plus the real cause on the next line. Names that clash with JS globals (such as `escape`) are "Illegal method name".

## Running on Omarchy

Check each of these on the machine instead of assuming it; Omarchy changes often.

- **Hyprland config is Lua** (Hyprland 0.56). `~/.config/hypr/hyprland.lua` `require`s `default.hypr.omarchy` and the user's `hypr.bindings` etc. Bindings use `o.bind("ALT + SPACE", "desc", dispatcher)`. `omacast setup hyprland` writes only `~/.config/hypr/omacast.lua` and appends one `require("hypr.omacast")`. Never edit Omarchy's files.
- **Hotkey.** Super+Space is the Omarchy menu and Super+Alt+Space is the dock's app grid. omacast defaults to **Alt+Space** through `hl.dsp.global("omacast:toggle")`, so the plugin's GlobalShortcut fires with no process spawn. Users can change their binding in `omacast.lua`; never force a Super+Space swap.
- **IPC.** `omarchy-shell <target> <fn> args…` answers over the shell's socket (needs `socat`), falling back to `qs ipc`. Our target is `omacast`. `IpcHandler` (Quickshell.Io; 4.0.x dropped `ShellIpc`) functions must have typed params and return a string.
- **Theme.** Bind colours to `Commons.Color.menu.*` and sizes to `Style.*`. They follow `omarchy theme set` live; no theme parsing.
- **App launching.** Use `shell.appLibrary.launch(id, name)`. It goes through `uwsm-app -- gtk-launch`, sends terminal apps to `omarchy-launch-tui`, and shows Omarchy's launch OSD. The shell only provides `appLibrary` to `menu`-kind plugins.
- **Terminals and paste.** Alacritty/Ghostty/Kitty need Ctrl+Shift+V (SPEC §5.3). Read the class from `hyprctl activewindow -j`.
- **Notifications** go to the Omarchy shell's notification service (`org.freedesktop.Notifications`). The bar has a tray widget (SNI).
- **Snippet expansion** needs the `input` group or a uinput udev rule. Keep it opt-in; `omacast doctor` explains it.
- **Testing on the live desktop.** Don't synthesize keystrokes (`wtype`) unless the launcher is already mapped and focused. Keys sent within about 25 ms of `show` go to the window underneath, which is usually the terminal running Claude.

## Status

Renamed **raylinux → oma-launcher → oma-cast** on 2026-10-19, then **oma-cast → omacast** on 2026-11-01 for the Omarchy plugin marketplace (plugin `typecraft.omacast`, display name `omacast`, CLI `omacast`, IPC target `omacast`, global shortcut `omacast:toggle`, XDG dirs `omacast`). Another marketplace submission is called "Oma Cast" and uses IPC target `oma-cast`. The GitHub repo is still `typecraft-dev/oma-cast`. `core/Paths.js` `legacyMoves` moves the old XDG dirs on first start. `bin/omacast install` removes the old plugin links and CLI link, and `setup hyprland` migrates `oma-cast.lua`. The app icon is Omarchy's logo: glyph `\ue900` in the `omarchy` font, the same one the bar's menu button uses.

**Phase 1 (Quickshell build): done**, with the gaps listed below. **Phase 0: done.** Omarchy 4.0.0.alpha, Quickshell 0.3.2, Hyprland 0.56.2.

Works:
- **Root search** ported from ref 02 §4.2–4.6 (`core/Ranker.js`, `core/Frecency.js`, golden tests). Sections (`core/RootSearch.js`):
  - empty root: Favorites, Suggestions (frecency > 1, top 6), Commands, Applications
  - query: Results, then `Use "<q>" with…` (Google, DuckDuckGo fallbacks)
- **Providers:** apps from `shell.appLibrary`, the whole Omarchy menu (about 400 items, with breadcrumbs, guards, ✓ state and font/power-profile provider rows), and the built-in "Omarchy Menu".
- **Opening an open app [D]:** ↵ on an app focuses its most recently used window, switching to its workspace, and launches only when none is open. Windows match by desktop id, `StartupWMClass`, or the URL Chromium/Brave web app classes are built from (`RootSearch.findAppWindow`). The focus waits for the `omacast` layer to unmap, since Hyprland refuses focus while it holds the keyboard. Focus doesn't raise on Omarchy 4.5's floating workspaces, so the window is then brought to the top, and one minimized to the dock is moved back first, the way the dock does it. Shift+↵ ("Open New Window") always launches.
- **Ranking state:** frecency (+100 per launch, 10-day half-life) and learned search terms in `db/frecency.json`. Aliases (exact → top; duplicates rejected), favourites (Ctrl+Shift+F, reorder Ctrl+Alt+↑↓) and disabled commands live in `db/settings.json` `commands`.
- **Navigation:** pushed Omarchy submenus (search within them), the alias editor, back with Esc / Ctrl+[ / Backspace on an empty query / the header arrow, and Shift+Esc to pop to root.
- **Keyboard:** Ctrl+K action panel (filterable, per-row shortcuts), ↵ / Ctrl+↵ / Ctrl+Shift+↵ for the first three actions, Ctrl+1–9, Ctrl+↑↓ to jump sections, PageUp/PageDown, ↑ on an empty root for search history, Ctrl+Shift+C copy, Alt+Shift+D disable, Ctrl + / − / 0 zoom.
  - Navigation bindings (`general.navigationBindings`): `emacs` moves down with Ctrl+N; `vim-motions` moves with Ctrl+J/K and puts the action panel on **Alt+K**. Set it with `omacast call settings.updateGeneralSettings '{"navigationBindings":"vim-motions"}'`.
  - **Ctrl+P** opens the root dropdown (All / Applications / Commands); emacs Ctrl+P = up only works inside popups.
  - **Ctrl+T** opens the toast's actions (Copy Error Message on failures, Undo after Disable Command). **Ctrl+Shift+K** opens the About panel for the selected row.
  - **Argument pills:** "Search Google" / "Search DuckDuckGo" take a query in a pill after the search text (Tab in, Shift+Tab out).
  - **Alerts:** Shut Down, Restart, Log Out and Delete All Entries ask first (↵ confirms, Esc cancels). `omacast run` skips the alert.
- **Feedback:** toasts in the footer and a HUD through Omarchy's OSD when the window closes; static footer "Loading…" appears only after 500 ms of visible loading, yields to toasts and resets on hide. The header divider stays still.
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
  - currencies (ECB rates from frankfurter.dev, cached daily in `~/.cache/omacast/currencies.json`; turn off with `"currencyRates": false` in config.json)
  - dates (`3 days from now`, `days until christmas`)
  - time zones (`time in tokyo`, `3pm london to nyc`; offsets come from one bash `printf %(%z)T` pass because QML has no Intl)
  - bases (`255 to hex`)
  - mixed units (`5 ft 3 in to cm`, `1 h 30 min + 45 min`)
  - work time (`40 hours in work days`, a work week is 5 days)
  - Unix time (`unix 1700000000`, `1700000000 to date`, `now to unix`, `unix time`)

  config.json sets `remToPxRate` (16), `workHoursPerDay` (8) and `clockFormat` (`auto` follows the Qt locale, or `12h` / `24h`).

  ↵ copies the answer (HUD), Ctrl+↵ pastes it (wl-copy on stdin, then Shift+Insert), Ctrl+Shift+C copies "question = answer". Each one saves to **Calculator History** (`db/calculator.json`, 4096 rows / 90 days): a built-in command and pushed view, searchable, Ctrl+D deletes an entry, Ctrl+Shift+D deletes all. RPC: `calculator.calculate|historyGetAll|historyDelete|historyDeleteAll|refreshCurrencies|getCurrencies`. A bare number, word or quantity (`42`, `firefox`, `5 kg`) never produces a row, because the section takes ↵.
- **Clipboard History** (Phase 3, SPEC §5.3/§8.2, `core/ClipboardHistory.js`, `builtin:clipboard-history`, global shortcut `omacast:clipboard`): `services/ClipboardWatcher.qml` runs one `wl-paste --watch` whose constant bash script skips `CLIPBOARD_STATE != data` and `x-kde-passwordManagerHint`, prefers an `image/*` offer, keeps `text/uri-list` for `file://` copies, and prints one JSON line per copy. Images and text ≥ 30,720 bytes go to `~/.local/share/omacast/clipboard/` by MD5; short text travels in the JSON line. The backend adds the source (`ToplevelManager.activeToplevel` + `DesktopEntries.heuristicLookup`), drops disabled apps (`clipboardDisabledApplications`), dedups by hash (copy count, last copied), and prunes by `clipboardHistoryDuration` (default `P1W`, pins kept) plus a 1000-unpinned cap [D], deleting orphaned files. The first line after the watcher starts is skipped if already known, and our own writes from the history (5 s hash window) don't count as copies. UI: 40/60 list/detail (`ui/DetailPane.qml`: text, image or colour swatch, then Information rows), sections Pinned/Today/Yesterday/Earlier [I], type dropdown on Ctrl+P. Actions: Paste (↵, via `ClipboardWriter.copyFile` for files), Copy (Ctrl+↵), Open link/file (Ctrl+O), Pin (Ctrl+Shift+P), Delete (Ctrl+D), Delete All unpinned (Ctrl+Shift+D, confirmed). RPC: `clipboard.getAll|getDetail|copy|paste|pin|unpin|delete|deleteAll`. Not done: OCR, Paste Sequentially, rich-text representations (only plain text, URI lists and one image type are kept), edit/rename, Save as Snippet, moving pins, image dimensions. `omacast:clipboard` toggles: a second press closes the view.
- **Latency:** show → mapped in 59–66 ms, hide in 24–42 ms on Omarchy 4.0.6 (`tests/smoke.sh`; it was 37–44 ms on the old `OverlayWindow`).
- **Tests:** root search, calculator and privacy coverage (`node --test tests/*.test.js`).

**Default-agent hand-off:** removed 2026-11-02 after the marketplace review; it exposed the question in process arguments (SPEC §2.0).

Stubbed / not yet:
- No settings window, so you can't re-enable a disabled command except with Undo on the toast (Ctrl+T) or by editing `~/.local/share/omacast/db/settings.json` (delete its `enabled: false`). That's Phase 2.
- No deep links (`omacast://`); Phase 2 or 9.

Won't do (decided 2026-10-22):
- Keystroke buffering. Keys sent within ~40 ms of the hotkey go to the window underneath; fixing it needs a parked surface, which Omarchy avoids (SPEC §12 Phase 1).
- Calculator: Color, Weather and Flight results, crypto, pinned history entries and a history detail pane. Trig takes radians unless given `°`/`deg` [D].

Deviations from the original spec (SPEC §2.0 and the Phase 1 note in §12):
- A Quickshell plugin instead of Tauri + Node; there's no NDJSON supervisor until Phase 5.
- JSON documents instead of SQLite; no DB encryption or libsecret key.
- Logs go to the shell log; `config.json` instead of `config.toml`; no D-Bus name.
- The Omarchy theme replaces Raycast's 8 themes; the HUD is Omarchy's OSD.

Testing lesson: the query survives hide/show until pop-to-root. A live test must clear it first (Ctrl+U), or typed text gets appended to the old query. Pressing ↵ on a stale query once opened real browser tabs.
