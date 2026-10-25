<div align="center">

# oma-cast

**A Raycast-esque launcher for [Omarchy](https://omarchy.org).**
It learns what you use, searches your apps and every Omarchy action, and looks like it shipped with your theme.

<img src="docs/screenshots/hero.png" alt="oma-cast showing suggestions for apps and Omarchy commands" width="760">

</div>

---

## Why

Omarchy's built-in menu is great at what it does. oma-cast adds what Raycast users miss on Linux:

* **Learns your habits.** Results are ranked with a port of Raycast's root-search algorithm, plus frecency and learned search terms. The things you actually use float to the top, and if you type `ff` and pick Firefox, `ff` keeps meaning Firefox.
* **One search for everything.** Your apps, all ~400 Omarchy menu actions (with breadcrumbs and live ✓ state), web-search fallbacks, and an explicit hand-off to your default coding agent.
* **Your shortcuts.** Give anything an alias, pin favorites, and hide the commands you never touch.
* **Keyboard-first.** A Ctrl+K action panel, Ctrl+1–9 quick picks, search history on ↑, section jumping, and emacs-style navigation.
* **Native to Omarchy.** It runs inside `omarchy-shell` as a plugin, with no Electron, no Node and no extra daemons. It opens in about 40 ms and follows your theme live when you run `omarchy theme set`.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/search.png" alt="Searching 'screen' shows Omarchy actions with breadcrumbs"></td>
    <td width="50%"><img src="docs/screenshots/actions.png" alt="The Ctrl+K action panel"></td>
  </tr>
  <tr>
    <td align="center"><b>Every Omarchy action, with breadcrumbs</b></td>
    <td align="center"><b>Ctrl+K: actions for any result</b></td>
  </tr>
</table>

<p align="center">
  <img src="docs/screenshots/fallbacks.png" alt="Web-search fallbacks under the results" width="49%">
</p>
<p align="center"><b>No match? Send the query to Google or DuckDuckGo</b></p>

### Follows your Omarchy theme

There's no theme config. oma-cast binds to Omarchy's own colours, so it changes the moment you switch themes.

<img src="docs/screenshots/themes.png" alt="oma-cast in Tokyo Night, Gruvbox, Rose Pine, Flexoki Light, Everforest and Osaka Jade">

## Install

Requires Omarchy 4 (Hyprland 0.56+, `omarchy-shell`) and `socat`, which Omarchy already ships.

```sh
git clone https://github.com/typecraft-dev/oma-cast.git
cd oma-cast
bin/oma-cast install          # link the plugin into omarchy-shell and the CLI into ~/.local/bin
oma-cast setup hyprland       # bind Alt+Space
oma-cast doctor               # check everything is wired up
```

Press **Alt+Space**. Super+Space stays the Omarchy menu. You can change the launcher binding in `~/.config/hypr/oma-cast.lua`.

To remove it: `oma-cast uninstall`.

## Ask your default agent

Type a question, select **Ask default agent** under the web-search fallbacks,
and press Enter. **Ctrl+Alt+Enter** sends the current root-search text directly.
This opens a new session with your question in Omarchy's configured default
agent and terminal (Foot, Ghostty, Kitty or Alacritty).

The action checks your setup first. Missing agent/terminal setup leaves the
launcher open with your question and an error. Closing the launcher during the
check cancels the pending hand-off. Normal app search and Enter selection keep
working as before; typing alone never submits a question.

Requires an Omarchy version with `omarchy-agent-prompt` and
`omarchy-agent --prompt` (verified against `quattro` revision `3ac4365`). Select
your defaults in Omarchy Settings. Agent authentication, accounts, approval
behaviour, session working directory and terminal selection remain owned by
Omarchy and the agent CLI. oma-cast does not store the question in search history,
read credentials, or make model API calls. Successful preflight checks establish
launch prerequisites, not successful sign-in or a running terminal; those still
need live desktop validation.

## Script Commands

Put an executable script with Raycast's `@raycast.*` header comments in
`~/.config/oma-cast/script-commands`, and it shows up in root search:

```bash
#!/bin/bash
# @raycast.schemaVersion 1
# @raycast.title Restart Waybar
# @raycast.mode compact
# @raycast.argument1 { "type": "text", "placeholder": "Profile", "optional": true }
```

Scripts from the [`raycast/script-commands`](https://github.com/raycast/script-commands)
repo use the same format, but many of them call macOS-only tools.

- **Modes:** `compact` shows the last line of output in a toast, `silent`
  closes the launcher and shows it in the OSD, `fullOutput` opens a view that
  streams the output, and `inline` shows the first line as the row's subtitle,
  refreshed every `refreshTime` (10 s or more).
- **Arguments:** up to three (`text`, `password` or `dropdown`), typed in pills
  after the search text. Tab moves between them and ↑/↓ steps through a
  dropdown's options.
- **Commands:** *Search Script Commands* lists your scripts by package, plus any
  files with a broken header. *Create Script Command* writes a script from a
  template and opens it in your editor. *Reload Script Commands* rescans the
  folders (oma-cast also rescans every time it opens).
- **Actions:** Edit Script (`Ctrl+E`) and Copy Path (`Ctrl+Shift+C`). In the
  output view, ↵ copies the output and `Ctrl+R` runs the script again.

To scan more folders, add them to `~/.config/oma-cast/config.json`:
`"scriptCommandDirectories": ["~/bin/raycast"]`.

## Keyboard

| Key | Does |
|---|---|
| `↵` / `Ctrl+↵` / `Ctrl+Shift+↵` | Run the first, second or third action |
| `Ctrl+K` | Open the action panel |
| `Super+V` / `Ctrl+V` / `Ctrl+Shift+V` / `Shift+Insert` | Paste text into the query (also accepts clipboard-history selections) |
| `Ctrl+Alt+↵` | Ask the default agent using the current root-search text |
| `Ctrl+1`…`9` | Pick a result |
| `↑` on an empty search | Search history |
| `Ctrl+↑` / `Ctrl+↓` | Jump between sections |
| `Ctrl+N` / `Ctrl+P` | Next / previous |
| `Ctrl+Shift+F` | Add to favorites (`Ctrl+Alt+↑↓` to reorder) |
| `Ctrl+Shift+C` | Copy |
| `Alt+Shift+D` | Disable a command |
| `Esc` / `Shift+Esc` | Back / back to root |
| `Ctrl +` / `Ctrl −` / `Ctrl 0` | Zoom |

## CLI

```sh
oma-cast toggle | show | hide
oma-cast run <commandId>         # e.g. app:com.mitchellh.ghostty, omarchy:style.theme
oma-cast call <method> [json]    # call any backend method
oma-cast doctor
```

## Roadmap

oma-cast is early. Search, ranking and the Omarchy integration are done. Coming next:

- [ ] Settings window
- [x] Script Commands
- [ ] Clipboard history, snippets, quicklinks, calculator
- [ ] Running Raycast extensions built from the open-source [`raycast/extensions`](https://github.com/raycast/extensions) repo
- [ ] Window management
- [ ] Importing your `.rayconfig` from macOS

The full plan is in [`SPEC.md`](SPEC.md).

## Development

```sh
node --test tests/*.test.js # unit tests, no npm install needed
tests/smoke.sh            # live checks against the running shell
oma-cast dev          # reload on every save
```

Quickshell caches QML for the life of the process, so run `oma-cast reload` after editing anything under `plugin/`. See [`CLAUDE.md`](CLAUDE.md) for the layout and conventions.

## Notes

oma-cast is an independent, clean-room project. It isn't affiliated with or endorsed by Raycast, and it contains no Raycast code or assets. It never contacts Raycast's servers and has no telemetry. Its agent action explicitly hands your question to Omarchy's existing coding-agent launcher; it provides no embedded AI runtime.
