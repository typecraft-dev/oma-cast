// Target languages offered by the Translate window. The window shows the
// name and translate-shell receives the language code.
var LANGUAGES = [
  { name: "Arabic", code: "ar" },
  { name: "Bengali", code: "bn" },
  { name: "Bulgarian", code: "bg" },
  { name: "Chinese (Simplified)", code: "zh-CN" },
  { name: "Chinese (Traditional)", code: "zh-TW" },
  { name: "Croatian", code: "hr" },
  { name: "Czech", code: "cs" },
  { name: "Danish", code: "da" },
  { name: "Dutch", code: "nl" },
  { name: "English", code: "en" },
  { name: "Estonian", code: "et" },
  { name: "Finnish", code: "fi" },
  { name: "French", code: "fr" },
  { name: "German", code: "de" },
  { name: "Greek", code: "el" },
  { name: "Hebrew", code: "he" },
  { name: "Hindi", code: "hi" },
  { name: "Hungarian", code: "hu" },
  { name: "Indonesian", code: "id" },
  { name: "Italian", code: "it" },
  { name: "Japanese", code: "ja" },
  { name: "Korean", code: "ko" },
  { name: "Latvian", code: "lv" },
  { name: "Lithuanian", code: "lt" },
  { name: "Norwegian", code: "no" },
  { name: "Persian", code: "fa" },
  { name: "Polish", code: "pl" },
  { name: "Portuguese (Brazil)", code: "pt-BR" },
  { name: "Portuguese (Portugal)", code: "pt-PT" },
  { name: "Romanian", code: "ro" },
  { name: "Russian", code: "ru" },
  { name: "Serbian", code: "sr" },
  { name: "Slovak", code: "sk" },
  { name: "Slovenian", code: "sl" },
  { name: "Spanish", code: "es" },
  { name: "Swedish", code: "sv" },
  { name: "Thai", code: "th" },
  { name: "Turkish", code: "tr" },
  { name: "Ukrainian", code: "uk" },
  { name: "Vietnamese", code: "vi" }
]

function names() {
  return LANGUAGES.map(function(language) { return language.name })
}

function matches(query) {
  var q = String(query || "").trim().toLowerCase()
  if (!q) return names()
  return LANGUAGES.filter(function(language) { return language.name.toLowerCase().indexOf(q) >= 0 })
    .map(function(language) { return language.name })
}

function known(name) {
  return codeFor(name) !== null
}

function nameFor(code) {
  var value = String(code || "").trim()
  if (!value) return ""
  var lower = value.toLowerCase()
  var i
  for (i = 0; i < LANGUAGES.length; i++) {
    if (LANGUAGES[i].code.toLowerCase() === lower) return LANGUAGES[i].name
  }
  var base = lower.split("-")[0]
  for (i = 0; i < LANGUAGES.length; i++) {
    var candidate = LANGUAGES[i].code.toLowerCase()
    if (candidate === base || candidate.split("-")[0] === base) return LANGUAGES[i].name
  }
  return value
}

function codeFor(name) {
  var value = String(name || "").trim().toLowerCase()
  if (!value) return null
  for (var i = 0; i < LANGUAGES.length; i++) {
    if (LANGUAGES[i].name.toLowerCase() === value) return LANGUAGES[i].code
  }
  return null
}

if (typeof module !== "undefined") {
  module.exports = { LANGUAGES: LANGUAGES, names: names, matches: matches, known: known, codeFor: codeFor, nameFor: nameFor }
}
