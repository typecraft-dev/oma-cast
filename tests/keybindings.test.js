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

const Q = K.QT

test("a recorded key press becomes a Hyprland bind", () => {
  assert.deepEqual(K.hotkeyFromKey(0x5a, Q.MetaModifier | Q.ShiftModifier, 52), { bind: "SUPER + SHIFT + Z" })
  assert.deepEqual(K.hotkeyFromKey(0x5a, Q.ShiftModifier | Q.ControlModifier | Q.AltModifier | Q.MetaModifier, 52), { bind: "SUPER + CTRL + ALT + SHIFT + Z" })
  assert.deepEqual(K.hotkeyFromKey(Q.Key_Return, Q.MetaModifier, 36), { bind: "SUPER + RETURN" })
  assert.deepEqual(K.hotkeyFromKey(Q.Key_Backtab, Q.AltModifier | Q.ShiftModifier, 23), { bind: "ALT + SHIFT + TAB" })
  // Shift+1 reports "!"; digits and punctuation bind by keycode.
  assert.deepEqual(K.hotkeyFromKey(0x21, Q.MetaModifier | Q.ShiftModifier, 10), { bind: "SUPER + SHIFT + code:10" })
  assert.deepEqual(K.hotkeyFromKey(0x2f, Q.ControlModifier, 61), { bind: "CTRL + code:61" })
  assert.deepEqual(K.hotkeyFromKey(Q.Key_F1 + 4, 0, 71), { bind: "F5" })
  assert.deepEqual(K.hotkeyFromKey(0x01000022, Q.MetaModifier, 133), { pending: true }, "Super alone waits for a key")
  assert.ok(K.hotkeyFromKey(0x5a, 0, 52).error, "a bare letter would eat typing")
  assert.ok(K.hotkeyFromKey(0x5a, Q.ShiftModifier, 52).error, "Shift alone isn't enough")
  assert.ok(K.hotkeyFromKey(0x01234567, Q.MetaModifier, 0).error)
})

test("both chord spellings format and compare the same", () => {
  assert.equal(K.formatChord("SUPER + SHIFT + RETURN"), "Super Shift ↵")
  assert.equal(K.formatChord("SUPER + SHIFT + code:10"), "Super Shift 1")
  assert.equal(K.formatChord("SUPER + code:200"), "", "an unknown keycode shows nothing")
  assert.equal(K.bindString("SUPER SHIFT + RETURN"), "SUPER + SHIFT + RETURN")
  assert.equal(K.bindString("SHIFT CONTROL + 4"), "CTRL + SHIFT + 4")
  assert.equal(K.bindString("HYPER + X"), "")
  assert.ok(K.sameChord("SUPER SHIFT + RETURN", "SHIFT + SUPER + RETURN"))
  assert.ok(K.sameChord("SHIFT CTRL + 4", "CTRL + SHIFT + code:13"), "Omarchy shows code binds by their label")
  assert.ok(!K.sameChord("SUPER + A", "SUPER + B"))
})

test("settings become a plan of binds and unbinds", () => {
  const plan = K.hotkeyPlan({
    "app:zen": { hotkey: "SUPER + SHIFT + Z", alias: "z" },
    "app:files": { removedBinds: ["SUPER SHIFT + F"] },
    "app:evil": { hotkey: 'SUPER + ") os.exit(' },
    "builtin:x": { favoriteOrder: 0 }
  })
  assert.deepEqual(plan, {
    binds: [{ commandId: "app:zen", bind: "SUPER + SHIFT + Z", name: K.shortcutName("app:zen") }],
    unbinds: ["SUPER + SHIFT + F"]
  })
  assert.match(K.shortcutName("app:zen"), /^hk-[0-9a-f]{8}$/)
  assert.notEqual(K.shortcutName("app:zen"), K.shortcutName("app:zed"))
})

test("the Lua for a plan unbinds first and escapes titles", () => {
  const plan = { binds: [{ commandId: "a", bind: "SUPER + Z", name: "hk-1" }], unbinds: ["SUPER + SHIFT + F"] }
  assert.equal(K.hotkeyLua(plan, { a: 'Say "hi"\\\n' }), [
    'pcall(hl.unbind, "SUPER + SHIFT + F")',
    'pcall(hl.unbind, "SUPER + Z")',
    'hl.bind("SUPER + Z", hl.dsp.global("omacast:hk-1"), { description = "Say \\"hi\\"\\\\  (omacast)" })'
  ].join("\n"))
  assert.equal(K.hotkeyLua({ binds: [], unbinds: [] }, {}), "")
})

test("taking a bind away needs a config reload, adding one doesn't", () => {
  const a = { binds: [{ commandId: "a", bind: "SUPER + Z", name: "hk-1" }], unbinds: [] }
  assert.equal(K.needsReload(null, a), false)
  assert.equal(K.needsReload({ binds: [], unbinds: [] }, a), false)
  assert.equal(K.needsReload(a, { binds: [], unbinds: [] }), true)
  assert.equal(K.needsReload(a, { binds: [{ commandId: "a", bind: "SUPER + X", name: "hk-1" }], unbinds: [] }), true)
  assert.equal(K.needsReload({ binds: [], unbinds: ["SUPER + F"] }, { binds: [], unbinds: [] }), true)
  assert.equal(K.needsReload({ binds: [], unbinds: [] }, { binds: [], unbinds: ["SUPER + F"] }), false)
})

test("conflicts name another command's hotkey or a Hyprland bind", () => {
  const records = K.parseRecords(RECORDS + "\nSUPER + Z                → Zen (omacast)\t__lua\t")
  const commands = { "app:zen": { hotkey: "SUPER + Z" } }
  assert.deepEqual(K.hotkeyConflict("SUPER + Z", "app:files", commands, records, { "app:zen": "Zen" }), { kind: "omacast", commandId: "app:zen", title: "Zen" })
  assert.equal(K.hotkeyConflict("SUPER + Z", "app:zen", commands, records, {}), null, "its own hotkey and bind")
  assert.deepEqual(K.hotkeyConflict("SHIFT + SUPER + RETURN", "app:files", commands, records, {}), { kind: "hyprland", title: "Browser" })
  assert.equal(K.hotkeyConflict("SUPER + CTRL + F12", "app:files", commands, records, {}), null)
})
