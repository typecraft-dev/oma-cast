# oma-cast for Windows (Electron)

The Windows port of oma-cast: a Raycast-style launcher that keeps the
Omarchy build's behaviour and its **pixel-faithful UI**. Every layout value,
colour and animation comes from the same sources the QML build uses —
Omarchy's `Style`/`Color` tokens and this repo's `plugin/ui/*.qml` — ported
component-for-component rather than redesigned. [D]

```
main.js            host layer: card-sized window, Alt+Space hotkey, CLI pipe,
                   paste orchestration (SendInput), HUD toasts, Open at
                   Login (HKCU Run) and the focus hand-back helper
src/backend.js     port of plugin/Backend.qml (same RPC surface, same names)
src/theme/         port of omarchy-theme-color / -set-templates + the
                   Color/Style/Border singletons (exact token resolution)
src/json-store.js  port of services/JsonStore.qml (fs + atomic + 250 ms)
src/calculator-data.js  ECB rates (frankfurter.dev) + Intl time zones
src/apps.js        Start Menu/Desktop .lnk + Store apps: enumerate, icons, launch
src/host.js        renderer-side adapters (clipboard, paste, external, agent)
src/windows-settings.js  ms-settings: page table for the Windows Settings view
src/themes.js        theme discovery (bundled + %APPDATA%\oma-cast\themes)
                   and shell.toml rendering for surface.createTheme
ui/index.html      the launcher surface
ui/style.css       px-for-px port of the QML geometry at zoom 1
ui/app.js          theme + geometry + header (LauncherWindow top half)
ui/view.js         rows/panels/footer/alert (ResultRow, ActionPanel, …)
ui/keys.js         navigation + the complete handleKey port
bin/oma-cast.ps1   CLI: toggle/show/hide/run/call/doctor/install
themes/            Omarchy's shell.toml.tpl + Tokyo Night colors.toml
assets/            omarchy.ttf (MIT) + JetBrainsMono Nerd Font (OFL)
```

## Run

```sh
cd electron
npm install        # devDependencies: electron + electron-builder
npm start          # the launcher; hotkey Alt+Space
npm test           # node --test: the shared core tests + this port's tests
npm run dist       # Windows: NSIS installer → dist/oma-cast-<version>-setup.exe
```

CI builds the installer on every push (`build-windows` job) and uploads
`oma-cast-setup-win32-x64` — the setup exe, per-user install (no admin),
Start Menu + desktop shortcut, Omarchy-logo icon rendered from
`assets/omarchy.ttf`.

> **Why `asarUnpack: assets/**`:** Chromium memory-maps font files and
> mmap cannot pass through Electron's asar patch, so fonts packed inside
> `app.asar` fail silently — every Nerd Font glyph renders as tofu. The
> fonts live in `app.asar.unpacked/assets/` (real files on disk); the
> `file://…app.asar/assets/…` URLs in `style.css` keep working through
> Electron's transparent unpacked redirect. The CI layout check asserts
> both locations.

`oma-cast.ps1` speaks JSON-lines to the running app over `\\.\pipe\oma-cast`
(the IpcHandler contract from the Linux build):

```powershell
bin\oma-cast.ps1 toggle
bin\oma-cast.ps1 call system.info
bin\oma-cast.ps1 run builtin:calculator-history
bin\oma-cast.ps1 doctor
bin\oma-cast.ps1 install     # PATH shim in %LOCALAPPDATA%\oma-cast\bin + Open at Login
```

## What is shared with the Linux build

Everything under `plugin/core/` runs unchanged: `Ranker` (the exact
ref-02 §4 ranking), `Frecency`, `Calculator`, `RootSearch`, `Schema`,
`Migrate`, `Rpc`, `Log`, plus the newer `FileSearch`, `SettingsView`. The golden tests in `../tests/` cover the same
files for both platforms; the Electron port adds tests for its own ports
(theme resolution golden against the real Omarchy template, the store, the
backend surface).

The UI is a DOM port of the QML components — same `px()` scale
(`Style.space × uiZoom`), same font scale (base 12: caption 10 … heading
16), same colours (`Color.menu.*`), same geometry formulas (card
`min(px(750), w−2·gapsOut)` × `min(px(475), h−2·gapsOut)` at
`y = max(gapsOut, min(h/4, …))`), same 530 ms caret blink, same 900 ms
loader sweep. The Omarchy icon font (`U+E900` logo) and every Nerd Font
glyph (`U+F0xx`, `U+F06A9`, …) are the exact same codepoints in the same
fonts — `omarchy.ttf` and JetBrainsMono Nerd Font are bundled, so text and
icons match the Omarchy default out of the box.

Text elide is `Text.ElideLeft` ported to `src/text.js`: the query, the
argument pills and the panel filter cut the **front** and keep the tail.
The DOM way to get a left ellipsis is `direction: rtl` + `text-align:
left`, and that was the first attempt — but it flips the paragraph
direction, so the bidi algorithm reorders anything whose first strong
character is not LTR (`1 rem to px` rendered as `rem to px 1`). The
elide therefore happens in JS on the logical string and the elements stay
LTR. [D]

Themes resolve through the real Omarchy pipeline: `themes/shell.toml.tpl`
rendered against `themes/tokyo-night/colors.toml` with the same token,
mix (awk rounding included) and gradient functions as
`omarchy-theme-set-templates`. Tokyo Night is Omarchy's default theme.

**The place for themes** is `%APPDATA%\oma-cast\themes\<name>\colors.toml`
(next to `config.json`) — a directory with a `colors.toml` is a theme; it
doesn't need a rebuild. The **Theme** row in the Settings view lists what
is on disk (bundled first, then yours) and ↵ repaints the launcher in
place — colours, font and the `gapsOut`/`cornerRadius` geometry all come
from `config.json`, so `oma-cast call themes.list` and an edit of
`"theme": "<name>"` do the same. A theme may ship its own `shell.toml` to
override the bundled template. [D]

## Built-in commands beyond the Linux build

| command | what it does |
|---|---|
| **File search** | a Files section in root search (SPEC §8.6 slice): name match first, then path, recency within a tier; Open / Reveal in Explorer / Copy Path. Built-in chunked walk of home (or `fileSearchScopes`), 100k cap, 10-min re-walk, disk cache — or voidtools Everything via `es.exe` when `fileSearchProvider` is `"everything"` (system-wide, instant; same ranker tiers the hits) — no inotify watcher yet [D] |
| **Settings** | the Phase-2 stub made real: a pushed view over every window/hotkey/search/calculator setting; ↵ cycles values — `hotkey` re-registers and **Open at Login** re-applies immediately |
| **Kill Process** | running processes by memory (PowerShell snapshot), confirm-first destructive alert, `taskkill /F`, Reveal + Copy PID. The snapshot service is created in `ui/app.js` and handed to the backend — the pushed view is empty without it — and the launcher's own processes (this pid + anything running from `process.execPath`) stay out of the list |
| **Typed addresses** | a query that reads as a web address (`apple.com`, `www.org`, `https://example.com/x`, `localhost:3000`) gets an **Open in Default Browser** row above Results; ↵ opens it through `shell.openExternal`, Ctrl+Shift+C copies it. Bare tokens need a listed web TLD, so `main.rs`, `notes.md` and `deploy.sh` stay searches; an explicit `http(s)://` always opens [D] |
| **Search Google / DuckDuckGo / unduck** | `https://…?q=%s` as root fallback rows and as builtins that push a dedicated search view with a full-width query bar (type there, ↵ searches) — no inline pill [D] |
| **Windows Settings** | a pushed, searchable list of the Settings app's own `ms-settings:` deep links grouped by category (Themes, Display, Windows Update, privacy, …); also the first row of the launcher's Settings view. ↵ opens the page through `shell.openExternal` [D] |
| **Shut Down / Restart / Sleep** | the Omarchy system actions' Windows equivalents: the first two ask the destructive confirm, then fire immediately (`shutdown /s|/r /t 0`) and close the window; Sleep closes the window first and suspends via PowerShell `SetSuspendState('Suspend')` to ensure true sleep even when hibernation is enabled [D] |

The window also hands the backend the **file index** behind the Files
section (`fileSearchScopes` → `roots`, cache in `%LOCALAPPDATA%\Temp\oma-cast\file-index.json`)
and calls `backend.visibility()` on every show/hide, which refreshes
exchange rates, re-scans the Start Menu and re-walks files when stale.
Both services and that hook were implemented and unit-tested (the tests
inject them) but never wired into the window — Kill Process pushed an
empty view and the Files section never appeared until this was fixed.

There is **no extension runtime** yet (SPEC Phase 5/§9): new capabilities
land as built-ins in `plugin/core/RootSearch.js` + a service, which is how
all five above were added.

## Windows substitutions [D]

| Omarchy | Windows |
|---|---|
| `shell.appLibrary` | Start Menu + Desktop `.lnk` scan (user and machine Start Menu roots, user and public Desktop) plus `shell:AppsFolder` rows for Store/MSIX apps — they ship no `.lnk` anywhere, which is why Notion was invisible — plus the App Paths registry (HKLM + HKCU) for registered exes with no shortcut anywhere, all through one PowerShell pass; icons extracted with `System.Drawing.Icon` into a PNG cache (Store rows have no file and fall back to the generic window glyph); launch via `explorer.exe` (ShellExecute / `shell:AppsFolder\<AppID>`, UAC-aware); **open existing window**: ↵ on an app that is already running with a window switches to it instead of a second instance — exe name from the shortcut target → `Get-Process` → `MainWindowHandle` → `SW_RESTORE` if minimized → focus through the resident helper (and the launcher's own focus hand-back is dropped, so the app keeps it); only when nothing is running does the launch happen (Store rows guess the process from the package family prefix, wrapper shortcuts with explorer/cmd targets never ask), and every attempt is logged as `app switch:` in `main.log` |
| layer-shell overlay + exclusive keyboard focus | one frameless transparent card-sized window centered on the monitor under the cursor (`alwaysOnTop: screen-saver`, no taskbar entry) — never a fullscreen overlay, so a machine without transparent compositing (VM, RDP, some drivers) still shows the desktop around the card instead of a black screen; the renderer reports its card size and main resizes to fit; blur dismisses unless `keepVisibleOnFocusLoss`; **on close the foreground goes back to the window that had it** — `showInactive` maps without activating so the resident focus helper can sample that window's HWND, `hide` does `SetForegroundWindow` (only while we still hold focus: on blur the clicked window already won), and the paste path waits for the hand-back so Ctrl+V lands there too |
| `wl-copy` / `omarchy-clipboard-paste-text` | Electron clipboard; paste = hide window, then Ctrl+V via `keybd_event` |
| `omarchy-shell osd` HUD | Windows toast (`Notification`) |
| `omarchy-agent` hand-off | `agentCommand` template in config.json with `{prompt}` substitution, preflighted with `where.exe` (5 s cap) — the same bounded, question-free check; the fallback row explains how to enable it when unset |
| Omarchy Menu provider + guards | dropped: there is no omarchy-shell to summon; the summon-only builtin is filtered from candidates |
| `hyprctl` corner rounding / gaps | `cornerRadius` / `gapsOut` config keys (same defaults Style falls back to: 0 / 5) |
| Hyprland `hyprctl` dispatches | none yet (Phase 6 equivalent) |

## config.json (`%APPDATA%\oma-cast\config.json`)

Everything the Linux build accepts (`logLevel`, `keepVisibleOnFocusLoss`,
`currencyRates`, `remToPxRate`, `workHoursPerDay`, `clockFormat`), plus:

| key | default | meaning |
|---|---|---|
| `hotkey` | `"Alt+Space"` | Electron accelerator for toggle |
| `openAtLogin` | `false` | start at login: main registers the exe with `app.setLoginItemSettings` (HKCU Run) at launch and on every config change; the Settings view's **Open at Login** row and `oma-cast.ps1 install` set it (both also drop any legacy Startup-folder shortcut — one mechanism only) |
| `fontFamily` | `""` (bundled JetBrainsMono Nerd Font stack) | UI font stack override |
| `agentCommand` | `""` | e.g. `"wt.exe claude {prompt}"`; empty disables the hand-off |
| `gapsOut` | `5` | card-to-screen-edge gap (Style's fallback) |
| `cornerRadius` | `0` | window rounding (Hyprland fallback) |
| `fileSearchScopes` | `[]` (home dir) | directories the file index walks |
| `fileSearchIncludeHidden` | `false` | index dotfiles/hidden files |
| `fileSearchProvider` | `"built-in"` | `"built-in"` walks your folders; `"everything"` queries voidtools Everything via `es.exe` (install Everything, keep it running) across all drives instantly — a dead Everything falls back to the walk for that query; the Settings view's **File Search Provider** row flips it live |

Data lives in `%LOCALAPPDATA%\oma-cast` (`db\settings.json`,
`db\frecency.json`, `db\calculator.json`), logs in
`%LOCALAPPDATA%\State\oma-cast\logs\main.log` and the cache in
`%LOCALAPPDATA%\Temp\oma-cast` — `resolveWindows` mirrors the XDG state
and cache layout; config in `%APPDATA%\oma-cast` — the same key set as
the XDG layout (`plugin/core/Paths.js resolveWindows`).

## Verifying on a real Windows machine

This port was written on Linux; unit tests and a headless boot cover the
logic, but these need a live Windows box: hotkey registration (Alt+Space
stealing from the focused window's system menu), paste timing
(`keybd_event` after unmap), Start Menu/Desktop/Store enumeration + icon
extraction, multi-monitor placement under the cursor, DPI scaling
(`uiZoom` × display scale), toasts, and UAC-gated shortcuts — plus, new
in 0.2.0: **Open at Login** (the Run entry appears/disappears, no window
pops open at login), the **focus hand-back** (close the launcher → the
previous window takes keys again, and paste lands there), a
Store-installed app such as Notion showing up in root search, and ↵ on an
already-running app focusing its window (minimized included) instead of
opening a second instance — when it doesn't, the `app switch:` lines in
`main.log` show the lookup's answer (`ok 1`, `none` or `no answer`).
`bin\oma-cast.ps1 doctor` reports the state (its `applications:` line is
the scan count); the same checklist as `tests/smoke.sh` applies.
