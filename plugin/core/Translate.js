// Translate settings helpers for the Translate window (ref 04 §1
// "Translator", SPEC §8.1 Translator). The window sends the text to
// translate-shell through the translate namespace in Backend.qml.

var DEFAULT_TARGET = "English"
var AUTO = "Auto"
var MAX_TEXT = 8000

function target(value) {
  var name = String(value || "").trim()
  return name || DEFAULT_TARGET
}

function source(value) {
  var name = String(value || "").trim()
  if (!name || name.toLowerCase() === "auto") return AUTO
  return name
}

function validText(value) {
  var phrase = String(value || "").trim()
  if (!phrase) throw new Error("Type text to translate")
  if (phrase.length > MAX_TEXT) throw new Error("Keep the text under " + MAX_TEXT + " characters")
  return phrase
}

if (typeof module !== "undefined") {
  module.exports = {
    DEFAULT_TARGET: DEFAULT_TARGET,
    AUTO: AUTO,
    MAX_TEXT: MAX_TEXT,
    target: target,
    source: source,
    validText: validText
  }
}
