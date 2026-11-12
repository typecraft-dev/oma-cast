# omacast for macOS

The same launcher as the Omarchy plugin, as a native macOS app. The search,
ranking, calculator and every keyboard decision come from the shared
`core/*.js`, which runs inside JavaScriptCore. Swift only draws the window and
talks to macOS. The design is in [`../MACOS.md`](../MACOS.md).

It needs macOS 14 or later and Xcode (or the Command Line Tools) to build. It
has no other dependencies.

## Install

```sh
git clone https://github.com/typecraft-dev/oma-cast.git
cd oma-cast
macos/bin/omacast install
```

That builds `omacast.app` and copies it to `~/Applications`. It also links the
CLI to `~/.local/bin/omacast` and starts the app. Press **Option+Space**.

Open **omacast Settings** from the launcher (or press ⌘, inside it) to change
the hotkey or to turn on launch at login.

### Themes

Pick a theme under **Theme** in omacast Settings. **System** follows light/dark mode and your accent colour on a translucent background. Catppuccin Mocha, Macchiato, Frappé and Latte are built in.

To add your own, put a JSON file in `~/Library/Application Support/omacast/themes/` (**Open Themes Folder** in Settings). The file name, without `.json`, is the theme's id; use lower-case letters, digits and dashes. omacast reads the folder each time the launcher opens.

```json
{
  "name": "Tokyo Night",
  "appearance": "dark",
  "colors": { "background": "#1a1b26", "text": "#c0caf5", "accent": "#7aa2f7" }
}
```

`background`, `text` and `accent` are required. `subtext`, `faint`, `selection`, `border` and `failure` are optional; omacast works them out from `text` when they're missing. Colours are `#rrggbb` or `#rrggbbaa`. `appearance` (`dark` or `light`) sets the colour of system controls such as the alert buttons. A file with a mistake is skipped, and Settings shows what's wrong. [`themes/tokyo-night.example.json`](themes/tokyo-night.example.json) lists every key.

### Permissions

The launcher needs no permission. Two features use **Accessibility** (System
Settings › Privacy & Security › Accessibility):

* **Paste Answer** (⌘↵ on a calculation) sends ⌘V to the app you came from.
* **Open New Window** (⇧↵ on an app) sends ⌘N to it.

The first Empty Trash, Restart, Shut Down, Log Out or Toggle System Appearance
asks once for permission to control Finder, System Events or loginwindow.

By default the build is ad-hoc signed, and macOS forgets the Accessibility
permission each time you rebuild. To keep it, sign with your own certificate:

```sh
security find-identity -v -p codesigning
OMACAST_SIGN_IDENTITY="Apple Development: …" macos/bin/omacast install
```

### Remove

```sh
omacast uninstall
```

That removes the app and the CLI link. Your data stays in
`~/Library/Application Support/omacast`; delete that folder to forget
everything.

## What's different from Omarchy

| Omarchy | macOS |
|---|---|
| Alt+Space, bound in Hyprland | Option+Space, set in the settings window or `config.json` `"hotkey"` |
| Ctrl is the command key (Ctrl+K, Ctrl+↵, Ctrl+1–9) | ⌘ is (⌘K, ⌘↵, ⌘1–9); Control+N/P (or J/K) still moves |
| The Omarchy menu, ~400 actions | System commands (Lock Screen, Sleep, Restart, Empty Trash…) and System Settings panes |
| `~/.config/omacast`, `~/.local/share/omacast` | `~/Library/Application Support/omacast` (same `db/*.json` files) |
| Theme from Omarchy | System look, Catppuccin, or your own JSON palettes |
| Copy Desktop ID | Copy Bundle Identifier |

## CLI

```sh
omacast toggle | show | hide
omacast run builtin:mac-lock          # any root-search command id
omacast call system.info              # any backend method
omacast doctor [--latency]
omacast settings
omacast log
omacast start | quit | restart
```

## Development

```sh
swift test --package-path macos                      # JavaScriptCore vs node, hotkeys, private files
node --test tests/macos-app.test.js tests/backend.test.js
macos/bin/omacast dev                                # debug build, restart
```

`omacast key '{"key":"a","text":"a","primary":false,"control":false,"alt":false,"shift":false}'`
types into the launcher and `omacast state` prints what it shows, without
synthesizing keystrokes.
