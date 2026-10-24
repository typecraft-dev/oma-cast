
var LEVELS = ["trace", "debug", "info", "warning", "error", "fatal"]

function levelIndex(level) {
  var i = LEVELS.indexOf(String(level || "").toLowerCase())
  return i < 0 ? LEVELS.indexOf("info") : i
}

function shouldLog(level, threshold) {
  return levelIndex(level) >= levelIndex(threshold)
}

function format(level, category, message, metadata) {
  var line = "[oma-cast] [" + LEVELS[levelIndex(level)] + "]"
  if (category) line += " [" + category + "]"
  line += " " + String(message)
  if (metadata !== undefined && metadata !== null) {
    try { line += " " + JSON.stringify(metadata) } catch (e) { line += " {unserializable}" }
  }
  return line
}

if (typeof module !== "undefined") {
  module.exports = { LEVELS: LEVELS, levelIndex: levelIndex, shouldLog: shouldLog, format: format }
}
