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
- `Ui/OverlayWindow.qml`, `Commons/{Style,Color,Util}.qml`
- `default/agents/skills/omarchy/plugins.md`: plugin safety rules. Use `textFormat: Text.PlainText` for any dynamic text.

## Repo layout

```
SPEC.md, reference/      # the spec
plugin/                  # the Omarchy shell plugin (what gets linked into ~/.config/omarchy/plugins/)
  manifest.json          #   id typecraft.oma-cast, kind "menu" (so the shell passes shell.appLibrary), keepLoaded
  Launcher.qml           #   entry point: open()/close() from the shell, ShellIpc "oma-cast", GlobalShortcut oma-cast:toggle
  Backend.qml            #   in-process backend: paths, config.json, stores, method registry, notifications
  ui/                    #   launcher surface and (later) views
  services/              #   QML services that do I/O (JsonStore, OmarchyMenuSource, Files; later clipboard, …)
  core/*.js              #   pure logic, no Qt imports: shared by QML and node tests (module.exports guard)
                         #   Ranker, Frecency (ref 02 §4, port exactly), OmarchyMenu, RootSearch, Files, Schema, Migrate, Rpc, Paths, Log
helper/                  #   oma-cast-files: Rust sidecar around fff-search 0.11.0 (file-name search, frecency)
bin/oma-cast             # bash CLI
tests/*.test.js          # node --test unit tests for plugin/core (ranker, frecency, Omarchy menu, root search, files, …)
tests/smoke.sh           # live acceptance check against the running shell
```

Rules for `plugin/core/*.js`: one self-contained file per module (QML `import "x.js"` and node `require` must both work, so a module never imports another one). Expose functions through the `if (typeof module !== "undefined") module.exports = …` guard. QML wires the modules together.

## Commands

```sh
node --test tests/*.test.js   # unit tests (node's built-in runner; no npm install)
cargo test --manifest-path helper/Cargo.toml   # file-search sidecar tests
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
oma-cast files status|enable|disable|root|reindex|reset-ranking|retry
oma-cast files build                 # local cargo build of the sidecar (no shell needed)
oma-cast doctor
oma-cast setup hyprland              # writes ~/.config/hypr/oma-cast.lua (Alt+Space) and requires it from hyprland.lua

qs log -n -p "$OMARCHY_PATH/shell" -t 50    # shell log; our lines start with [oma-cast]
```

**Reloading.** Quickshell keeps every QML/JS file it has read, keyed by path, for the life of the process, and the shell's inotify watch doesn't follow the symlink into this repo. So editing files under `plugin/` changes nothing until `oma-cast reload` re-links the plugin under a fresh `typecraft.oma-cast.dev-<ns>` path. Always reload, then check `qs log` for QML errors, before concluding a change works. A QML error shows up as "Type X unavailable" plus the real cause on the next line. Names that clash with JS globals (such as `escape`) are "Illegal method name".

## Running on Omarchy

Check each of these on the machine instead of assuming it; Omarchy changes often.

- **Hyprland config is Lua** (Hyprland 0.56). `~/.config/hypr/hyprland.lua` `require`s `default.hypr.omarchy` and the user's `hypr.bindings` etc. Bindings use `o.bind("ALT + SPACE", "desc", dispatcher)`. `oma-cast setup hyprland` writes only `~/.config/hypr/oma-cast.lua` and appends one `require("hypr.oma-cast")`. Never edit Omarchy's files.
- **Hotkey.** Super+Space is the Omarchy menu and Super+Alt+Space is the dock's app grid. oma-cast defaults to **Alt+Space** through `hl.dsp.global("oma-cast:toggle")`, so the plugin's GlobalShortcut fires with no process spawn. Users can change their binding in `oma-cast.lua`; never force a Super+Space swap.
- **IPC.** `omarchy-shell <target> <fn> args…` answers over the shell's socket (needs `socat`), falling back to `qs ipc`. Our target is `oma-cast`. `ShellIpc` functions must have typed params and return a string.
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
- **Keyboard:** Ctrl+K action panel (filterable, per-row shortcuts), ↵ / Ctrl+↵ / Ctrl+Shift+↵ for the first three actions, Ctrl+1–9, Ctrl+↑↓ to jump sections, PageUp/PageDown, Ctrl+N/P (emacs), ↑ on an empty root for search history, Ctrl+Shift+C copy, Alt+Shift+D disable, Ctrl + / − / 0 zoom.
- **Feedback:** toasts in the footer, a HUD through Omarchy's OSD when the window closes, and a 2 px loading bar while guards and providers refresh (on every open, about 250 ms in the background).
- **Window behaviour:**
  - The `escapeKeyBehavior` setting works both ways.
  - Pop-to-root runs after `popToRootTimeout`.
  - Compact mode shows only the header until you type.
  - A launch from root clears the query [I].
  - A row is selected on hover only after a real pointer move (Omarchy's PointerMoveGate).
- **File search (Phase 7 partial):** a Rust sidecar (`helper/`, `fff-search = 0.11.0`) indexes file names under `~` and answers a Files section in root plus a "Search Files" view. Query history is deliberately not stored; only FFF's access frecency LMDB is. Three rows max in root, a filename-confidence gate, hidden/secret filtering, `.ignore` support, and `Show All Files`. New installs default on and `install` builds the helper; existing installs opt in. `oma-cast files …` controls it.
- **Calculator** (`core/Calculator.js`, our own engine [D]; no `qalc`/fend dependency): a "Calculator" section above Results with Raycast's two-pane card (question → answer, captions below each). It handles:
  - arithmetic and functions
  - Soulver-style percentages (`$30 + 20%`, `20% off 50`, `50 as a % of 200`)
  - ~250 units (`5 ft to cm`, `60 mph * 2 h`, `16px to rem`)
  - currencies (ECB rates from frankfurter.dev, cached daily in `~/.cache/oma-cast/currencies.json`; turn off with `"currencyRates": false` in config.json)
  - dates (`3 days from now`, `days until christmas`)
  - time zones (`time in tokyo`, `3pm london to nyc`; offsets come from one bash `printf %(%z)T` pass because QML has no Intl)
  - bases (`255 to hex`)

  ↵ copies the answer (HUD), Ctrl+↵ pastes it through `omarchy-clipboard-paste-text`, Ctrl+Shift+C copies "question = answer". Each one saves to **Calculator History** (`db/calculator.json`, 4096 rows / 90 days): a built-in command and pushed view, searchable, Ctrl+D deletes an entry, Ctrl+Shift+D deletes all. RPC: `calculator.calculate|historyGetAll|historyDelete|historyDeleteAll|refreshCurrencies|getCurrencies`. A bare number, word or quantity (`42`, `firefox`, `5 kg`) never produces a row, because the section takes ↵.
- **Latency:** show → mapped in 37–44 ms, hide in 9–25 ms (`tests/smoke.sh`).
- **Tests:** 106 node unit tests + 8 helper tests (`node --test tests/*.test.js`, `cargo test --manifest-path helper/Cargo.toml`), covering root search, files, calculator and the default-agent hand-off. One test parses the installed Omarchy menu and fails on an Omarchy whose root menus were renamed (`style` → `appearance`).

**Default-agent hand-off (fork, 2026-10-20):** user-authorized addition outside the original phase plan. The root fallback "Ask default agent" and Ctrl+Alt+Enter pass the query to `omarchy-agent --prompt` as a literal argv element. `AgentLauncher.qml` checks the configured agent/terminal with a bounded, question-free preflight, prevents overlapping submissions and cancels on hide/unload. `Launcher.qml` dismisses the overlay before launching through `Util.execArgv`. Errors leave the query visible. There are no new dependencies, model APIs, credentials or question-history writes. Existing CLI approval behaviour is inherited. Portable checks do not establish live terminal focus, authentication, or provider compatibility; verify those on Omarchy.

Stubbed / not yet:
- File search previews/Quick Look and content search; hidden dotfiles at a non-git root; multi-root/scopes; a per-file "forget" action.
- Keystroke buffering before the surface maps. Keys sent within ~40 ms of the hotkey go to the window underneath.
- Vim navigation bindings, Ctrl+P dropdown, Ctrl+T, Ctrl+Shift+K, inline argument pills, alerts.
- No settings window, so you can't re-enable a disabled command except by editing `~/.local/share/oma-cast/db/settings.json` (delete its `enabled: false`). That's Phase 2.
- No deep links (`oma-cast://`); Phase 2 or 9.
- Calculator gaps:
  - Color, Weather and Flight inline results
  - pinning history entries, a history detail pane
  - `remToPxRate` and `workHoursPerDay` settings (16 and 8 are fixed)
  - mixed units (`5 ft 3 in`), crypto, the unix timestamp
  - a 24-hour clock only if the Qt locale says so

  Trig takes radians unless given `°`/`deg` [D].

Deviations from the original spec (SPEC §2.0 and the Phase 1 note in §12):
- A Quickshell plugin instead of Tauri + Node; there's no NDJSON supervisor until Phase 5.
- File search uses an out-of-process `fff-search` sidecar instead of the custom Rust/SQLite indexer in SPEC §8.6/Phase 7. It is a new build/runtime dependency, default-on only for new installs; existing installs opt in. Recorded in SPEC.
- JSON documents instead of SQLite; no DB encryption or libsecret key.
- Logs go to the shell log; `config.json` instead of `config.toml`; no D-Bus name.
- The Omarchy theme replaces Raycast's 8 themes; the HUD is Omarchy's OSD.

Testing lesson: the query survives hide/show until pop-to-root. A live test must clear it first (Ctrl+U), or typed text gets appended to the old query. Pressing ↵ on a stale query once opened real browser tabs.
