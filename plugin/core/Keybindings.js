// Read Omarchy's public --print output: it already resolves the active
// keyboard layout, Lua bindings, personal overrides and translated labels.
function parse(text) {
  var seen = {}
  var rows = []
  String(text || "").split(/\r?\n/).forEach(function(line) {
    var arrow = line.indexOf(" → ")
    if (arrow < 0) return
    var shortcut = line.slice(0, arrow).trim().replace(/\s+/g, " ")
    var title = line.slice(arrow + 3).trim()
    if (!shortcut || !title) return
    var id = "keybinding:" + encodeURIComponent(shortcut + "\n" + title)
    if (seen[id]) return
    seen[id] = true
    rows.push({
      id: id, type: "command", kind: "keybinding", title: title,
      subtitle: "", shortcut: shortcut,
      // SUPER, RETURN → Super, Return; single letters and F-keys stay as-is.
      shortcutKeys: shortcut.replace(/\s*\+\s*/g, " ")
        .replace(/\b([A-Z])([A-Z]+)\b/g, function(m, a, b) { return a + b.toLowerCase() }),
      keywords: [shortcut, "keyboard shortcut keybinding"],
      typeLabel: "", glyph: "", rootSearch: { when: "searching" }
    })
  })
  return rows
}

// Token matching makes both "super shift f" and "Super+Shift+F" useful.
// Bindings stay in Omarchy's familiar order when no query is entered.
function search(rows, query, ranker) {
  var q = String(query || "").trim()
  if (!q) return rows
  var tokens = q.toLowerCase().replace(/\+/g, " ").split(/\s+/).filter(Boolean)
  var modifiers = ["super", "shift", "ctrl", "alt", "mod2", "mod3", "mod5"]
  var chordQuery = tokens.some(function(token) { return modifiers.indexOf(token) >= 0 })
  var direct = rows.filter(function(row) {
    return row.shortcut.split(" / ").some(function(chord) {
      var text = (row.title + " " + chord).toLowerCase()
      var keys = chord.toLowerCase().replace(/\+/g, " ").split(/\s+/)
      return tokens.every(function(token) {
        if (chordQuery && (token.length === 1 || /^f[0-9]+$/.test(token) || modifiers.indexOf(token) >= 0)) return keys.indexOf(token) >= 0
        return text.indexOf(token) >= 0
      })
    })
  })
  // A modifier query asks for that actual chord, not a fuzzy near-match.
  // Exact chords first: "super f" puts Super+F above Super+Alt+F.
  if (chordQuery) {
    var exact = function(row) {
      return row.shortcut.split(" / ").some(function(chord) {
        var keys = chord.toLowerCase().replace(/\+/g, " ").split(/\s+/).filter(Boolean)
        return keys.length === tokens.length
      })
    }
    return direct.filter(exact).concat(direct.filter(function(row) { return !exact(row) }))
  }
  var seen = {}
  direct.forEach(function(row) { seen[row.id] = true })
  var fuzzy = ranker.rank(rows, q, { sensitivity: "medium" })
    .map(function(result) { return result.candidate })
    .filter(function(row) { return !seen[row.id] })
  return direct.concat(fuzzy)
}

if (typeof module !== "undefined") module.exports = { parse: parse, search: search }
