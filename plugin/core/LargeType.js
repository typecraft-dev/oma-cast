
// Large Type (Ctrl+L): the launcher query shown across the whole screen, as
// Alfred's Large Type does (ref: alfredapp.com/help/features/large-type).
// This module is policy only — the QML side owns measuring and painting —
// so both the display guard and the font bounds are testable in node.

// Outer margin as a fraction of the smaller screen edge, so the glyphs keep
// off the bezel at any aspect ratio.
var MARGIN_RATIO = 0.08

// Font bounds in px at zoom 1. Text.Fit shrinks from `max` down to `min`;
// past `min` the text is clipped, which beats shrinking to unreadable.
var MIN_PIXEL_SIZE = 24
var MAX_PIXEL_SIZE = 1024

// The text to display, or "" when there is nothing to show. Content is kept
// exactly (case, punctuation, inner spacing, markup included); only outer
// whitespace is dropped, and blank input becomes "" so the caller can no-op
// instead of taking over the screen.
function displayText(query) {
  return String(query == null ? "" : query).trim()
}

// Pixel-size bounds for a Text.Fit inside a screen of w × h. Returns the
// text box (inside the margins) plus the font range. Null when the geometry
// is unusable. Fitting is text-independent: Text.Fit walks the sizes itself,
// so the loop stays inside Qt and these bounds can never be exceeded.
function fitRange(w, h, zoom) {
  w = Number(w)
  h = Number(h)
  if (!(w > 0) || !(h > 0)) return null
  var z = zoom > 0 ? Number(zoom) : 1
  var margin = Math.min(w, h) * MARGIN_RATIO
  var boxW = Math.max(1, Math.floor(w - margin * 2))
  var boxH = Math.max(1, Math.floor(h - margin * 2))
  var max = Math.max(1, Math.min(Math.round(MAX_PIXEL_SIZE * z), Math.min(boxW, boxH)))
  var min = Math.min(Math.max(1, Math.round(MIN_PIXEL_SIZE * z)), max)
  return { min: min, max: max, width: boxW, height: boxH }
}

if (typeof module !== "undefined") {
  module.exports = {
    MARGIN_RATIO: MARGIN_RATIO,
    MIN_PIXEL_SIZE: MIN_PIXEL_SIZE,
    MAX_PIXEL_SIZE: MAX_PIXEL_SIZE,
    displayText: displayText,
    fitRange: fitRange
  }
}
