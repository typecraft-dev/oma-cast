const test = require("node:test")
const assert = require("node:assert/strict")
const K = require("../core/Keybindings.js")

// Lines as omarchy-menu-keybindings caches them: "<chord> → <what>\t<dispatcher>\t<arg>".
const RECORDS = [
  "SUPER + K                           → Keybindings\texec\tomarchy-menu-keybindings",
  "SUPER + RETURN                      → Terminal\texec\tomarchy-launch-terminal",
  "SUPER SHIFT + RETURN                → Browser\texec\tomarchy-launch-browser",
  "SUPER SHIFT + F                     → File manager\texec\tomarchy-launch-nautilus",
  "SUPER + W / SUPER + Q               → Close window\tlua\thl.dsp.window.close()",
  "SUPER SHIFT ALT + B                 → Browser (private)\texec\tomarchy-launch-browser --private",
  "SUPER SHIFT + B                     → Browser\texec\tomarchy-launch-browser",
  "SUPER ALT + RETURN                  → Tmux\texec\tomarchy-launch-terminal-tmux",
  "SUPER + PRINT                       → Color picker\texec\tpkill hyprpicker || hyprpicker -a",
  "SUPER SHIFT + A                     → ChatGPT\texec\tomarchy-launch-webapp 'https://chatgpt.com'",
  "SUPER SHIFT ALT + G                 → WhatsApp\texec\tomarchy-launch-or-focus-webapp 'WhatsApp' 'https://web.whatsapp.com/'",
  "SUPER SHIFT + O                     → Obsidian\texec\tomarchy-launch-or-focus '^obsidian$' 'uwsm-app -- obsidian'",
  "SUPER SHIFT ALT + M                 → Music TUI\texec\tomarchy-launch-or-focus-tui 'cliamp'",
  "SUPER SHIFT + G                     → Signal\texec\tomarchy-launch-signal",
  "SUPER SHIFT + N                     → Editor\texec\tomarchy-launch-editor",
  "SUPER SHIFT + Q                     → Calculator\texec\tomacalc",
  "SUPER SHIFT + R                     → SSH\texec\talacritty -e ssh box"
].join("\n")

const DEFAULTS = { terminal: "com.mitchellh.ghostty.desktop", browser: "zen.desktop", editor: "nvim" }

const ENTRIES = [
  { id: "com.mitchellh.ghostty", execString: "ghostty --gtk-single-instance=true" },
  { id: "zen", execString: "/opt/zen-browser-bin/zen-bin %u" },
  { id: "org.gnome.Nautilus", command: ["nautilus", "--new-window", "%U"] },
  { id: "ChatGPT", execString: "omarchy-launch-webapp https://chatgpt.com/" },
  { id: "WhatsApp", execString: "omarchy-launch-webapp https://web.whatsapp.com/" },
  { id: "obsidian", execString: "/usr/bin/obsidian %U" },
  { id: "cliamp", execString: "omarchy-launch-tui cliamp" },
  { id: "signal", execString: "signal-desktop -- %u" },
  { id: "nvim", execString: "nvim %F" },
  { id: "omacalc", execString: "omacalc" },
  { id: "Alacritty", execString: "alacritty" },
  { id: "foot", execString: "foot" },
  { id: "hyprpicker", execString: "hyprpicker" }
]

test("parses Omarchy's keybinding records", () => {
  const r = K.parseRecords(RECORDS)
  assert.equal(r.length, 17)
  assert.deepEqual(r[2], { chord: "SUPER SHIFT + RETURN", description: "Browser", dispatcher: "exec", arg: "omarchy-launch-browser" })
  assert.equal(r[4].chord, "SUPER + W", "the first of several chords")
  assert.equal(r[9].arg, "omarchy-launch-webapp 'https://chatgpt.com'")
})

test("each app gets the bind that opens it", () => {
  const hotkeys = K.appHotkeys(K.parseRecords(RECORDS), ENTRIES, DEFAULTS)
  assert.deepEqual(hotkeys, {
    "com.mitchellh.ghostty": "SUPER + RETURN",
    zen: "SUPER SHIFT + RETURN",
    "org.gnome.Nautilus": "SUPER SHIFT + F",
    ChatGPT: "SUPER SHIFT + A",
    WhatsApp: "SUPER SHIFT ALT + G",
    obsidian: "SUPER SHIFT + O",
    cliamp: "SUPER SHIFT ALT + M",
    signal: "SUPER SHIFT + G",
    nvim: "SUPER SHIFT + N",
    omacalc: "SUPER SHIFT + Q"
  })
})

test("the terminal and browser binds follow the defaults", () => {
  const records = K.parseRecords(RECORDS)
  const swapped = K.appHotkeys(records, ENTRIES, { terminal: "foot.desktop", browser: "" })
  assert.equal(swapped.foot, "SUPER + RETURN")
  assert.equal(swapped["com.mitchellh.ghostty"], undefined)
  assert.equal(swapped.zen, undefined, "no default browser, no browser hotkey")
})

test("binds that run a task, not the app, mark nothing", () => {
  const hotkeys = K.appHotkeys(K.parseRecords(RECORDS), ENTRIES, DEFAULTS)
  assert.equal(hotkeys.Alacritty, undefined, "alacritty -e ssh box")
  assert.equal(hotkeys.hyprpicker, undefined, "a pipeline")
})

test("the first bind for an app wins", () => {
  const records = K.parseRecords(RECORDS)
  assert.equal(K.appHotkeys(records, ENTRIES, DEFAULTS).zen, "SUPER SHIFT + RETURN")
  const reversed = records.slice().reverse()
  assert.equal(K.appHotkeys(reversed, ENTRIES, DEFAULTS).zen, "SUPER SHIFT + B")
})

test("chords render as keycaps in one modifier order", () => {
  assert.equal(K.formatChord("SUPER + RETURN"), "Super ↵")
  assert.equal(K.formatChord("SUPER SHIFT + RETURN"), "Super Shift ↵")
  assert.equal(K.formatChord("SUPER SHIFT ALT + G"), "Super Alt Shift G")
  assert.equal(K.formatChord("SUPER SHIFT + SLASH"), "Super Shift /")
  assert.equal(K.formatChord("SUPER + semicolon"), "Super ;")
  assert.equal(K.formatChord("SHIFT CTRL + 4"), "Ctrl Shift 4")
  assert.equal(K.formatChord("XF86Calculator"), "XF86Calculator")
  assert.equal(K.formatChord("SUPER + LEFT MOUSE BUTTON"), "")
})

test("splitCommand honours quotes and refuses shell syntax", () => {
  assert.deepEqual(K.splitCommand("omarchy-launch-or-focus '^obsidian$' 'uwsm-app -- obsidian'"), ["omarchy-launch-or-focus", "^obsidian$", "uwsm-app -- obsidian"])
  assert.deepEqual(K.splitCommand('"/opt/app dir/bin" --flag'), ["/opt/app dir/bin", "--flag"])
  assert.equal(K.splitCommand("pkill hyprpicker || hyprpicker -a"), null)
  assert.equal(K.splitCommand("echo $(id)"), null)
})

test("parseScan splits the defaults from the records", () => {
  const scan = K.parseScan("terminal\tcom.mitchellh.ghostty.desktop\nbrowser\tzen.desktop\neditor\tnvim\n\x1e\n" + RECORDS)
  assert.deepEqual(scan.defaults, DEFAULTS)
  assert.equal(scan.records.length, 17)
  assert.deepEqual(K.parseScan("").records, [])
})
