// What a key event inserts into the launcher query.
//
// Numpad keys arrive as Qt.KeypadModifier. With NumLock off they are also
// reported as arrows, Home/End, PageUp/Down, Insert, Delete and Clear.
// Treating those as list movement runs the synchronous search-history read
// on numpad 8, which is the stall, and the digit never lands. The number
// row has no keypad modifier and no navigation keysym, so it stays fast.
//
// Qt Wayland's nativeScanCode is the xkb keycode (linux evdev + 8).
// Raw evdev is not used: NumLock is evdev 69, so its xkb code is 77, and
// raw KP6 is also 77. Mapping raw 77 inserted "6" and ate the lock.

var KEYPAD = 0x20000000
var SHIFT = 0x02000000

var KEY_INSERT = 0x01000006
var KEY_DELETE = 0x01000007
var KEY_CLEAR = 0x0100000b
var KEY_HOME = 0x01000010
var KEY_END = 0x01000011
var KEY_LEFT = 0x01000012
var KEY_UP = 0x01000013
var KEY_RIGHT = 0x01000014
var KEY_DOWN = 0x01000015
var KEY_PAGEUP = 0x01000016
var KEY_PAGEDOWN = 0x01000017
var KEY_CAPSLOCK = 0x01000024
var KEY_NUMLOCK = 0x01000025
var KEY_SCROLLLOCK = 0x01000026

// NumLock off, when Qt still sets KeypadModifier.
var PAD_OFF = {}
PAD_OFF[KEY_INSERT] = "0"
PAD_OFF[KEY_END] = "1"
PAD_OFF[KEY_DOWN] = "2"
PAD_OFF[KEY_PAGEDOWN] = "3"
PAD_OFF[KEY_LEFT] = "4"
PAD_OFF[KEY_CLEAR] = "5"
PAD_OFF[KEY_RIGHT] = "6"
PAD_OFF[KEY_HOME] = "7"
PAD_OFF[KEY_UP] = "8"
PAD_OFF[KEY_PAGEUP] = "9"
PAD_OFF[KEY_DELETE] = "."

// xkb keycodes (evdev + 8). "" is keypad Enter: keypad, but not text.
var PAD_SCAN = {
  63: "*",
  79: "7",
  80: "8",
  81: "9",
  82: "-",
  83: "4",
  84: "5",
  85: "6",
  86: "+",
  87: "1",
  88: "2",
  89: "3",
  90: "0",
  91: ".",
  104: "",
  106: "/",
}

/**
 * True when the event came from the numeric keypad, not the number row
 * or the arrow cluster.
 * @param {{modifiers?: number, key?: number, nativeScanCode?: number}} event
 * @returns {boolean}
 */
function isLock(key) {
  return key === KEY_CAPSLOCK || key === KEY_NUMLOCK || key === KEY_SCROLLLOCK
}

function isKeypad(event) {
  if (!event || isLock(event.key)) return false
  if ((event.modifiers || 0) & KEYPAD) return true
  var scan = event.nativeScanCode || 0
  return !!scan && Object.prototype.hasOwnProperty.call(PAD_SCAN, scan)
}

/**
 * The single character this event should insert, or "" if it is a shortcut
 * or real navigation.
 * @param {{modifiers?: number, key?: number, text?: string, nativeScanCode?: number}} event
 * @param {boolean} [numLock] Keypad inserts digits only while this is true.
 * @returns {string}
 */
function character(event, numLock) {
  if (!event || isLock(event.key)) return ""
  if (numLock === undefined) numLock = true
  var mods = event.modifiers || 0
  if ((mods & ~(KEYPAD | SHIFT)) !== 0) return ""
  // Unlocked keypad is navigation, even if Qt still reports a digit.
  if (!numLock && isKeypad(event)) return ""

  var text = event.text || ""
  if (text.length === 1) {
    var code = text.charCodeAt(0)
    if (code >= 32 && code !== 127) return text
  }

  if ((mods & KEYPAD) && Object.prototype.hasOwnProperty.call(PAD_OFF, event.key)) {
    return PAD_OFF[event.key]
  }

  var scan = event.nativeScanCode || 0
  if (scan && Object.prototype.hasOwnProperty.call(PAD_SCAN, scan)) return PAD_SCAN[scan]
  return ""
}

if (typeof module !== "undefined") {
  module.exports = {
    KEYPAD: KEYPAD,
    character: character,
    isKeypad: isKeypad,
  }
}
