// Word bounds for the launcher's search field. The field itself is a QML
// TextInput, so Qt owns the caret, the selection and the standard editing
// keys; this module only supplies the word ranges used by Ctrl+Backspace and
// Ctrl+Delete [D]. A word is a run of non-whitespace characters; a move in
// either direction skips whitespace first, then the word.

function clampPosition(text, position) {
  text = String(text == null ? "" : text)
  position = Number(position)
  if (!isFinite(position)) return 0
  return Math.max(0, Math.min(text.length, Math.round(position)))
}

function isSpace(ch) {
  return /\s/.test(ch)
}

// Start of the word before `position`: "alpha beta " at 11 -> 6, at 6 -> 0.
function wordStart(text, position) {
  text = String(text == null ? "" : text)
  var i = clampPosition(text, position)
  while (i > 0 && isSpace(text.charAt(i - 1))) i--
  while (i > 0 && !isSpace(text.charAt(i - 1))) i--
  return i
}

// End of the word after `position`: "alpha beta" at 0 -> 5, at 5 -> 10.
function wordEnd(text, position) {
  text = String(text == null ? "" : text)
  var i = clampPosition(text, position)
  var n = text.length
  while (i < n && isSpace(text.charAt(i))) i++
  while (i < n && !isSpace(text.charAt(i))) i++
  return i
}

// Range removed by Ctrl+Backspace (forward false) / Ctrl+Delete (forward
// true): the selection when there is one, otherwise one word next to the
// caret. start === end means there is nothing to delete.
function deletionRange(text, anchor, caret, forward) {
  text = String(text == null ? "" : text)
  var start = clampPosition(text, Math.min(anchor, caret))
  var end = clampPosition(text, Math.max(anchor, caret))
  if (start !== end) return { start: start, end: end }
  var at = clampPosition(text, caret)
  return forward
    ? { start: at, end: wordEnd(text, at) }
    : { start: wordStart(text, at), end: at }
}

if (typeof module !== "undefined") module.exports = { clampPosition, wordStart, wordEnd, deletionRange }
