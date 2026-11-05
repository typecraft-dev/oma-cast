// Switch Theme (ref 04 App. A raycast.switch-theme [O]), backed by Omarchy's
// themes instead of Raycast's. The rows come from Omarchy's own picker
// (`omarchy-theme-switcher --print-rows`: "<preview>\t<thumbnail>" per theme,
// the preview named <slug>.<ext>), so omacast lists exactly what it lists.

var VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi)$/i

// "tokyo-night" → "Tokyo Night", as omarchy-theme-list prints it.
function displayName(slug) {
  return String(slug).replace(/(^|-)([a-z])/g, function(m, sep, c) { return sep + c.toUpperCase() }).replace(/-/g, " ")
}

function parseRows(text) {
  var out = [], seen = {}
  String(text || "").split("\n").forEach(function(line) {
    var cols = line.split("\t")
    var preview = cols[0].trim()
    if (!preview) return
    var slug = preview.split("/").pop().replace(/\.[^.]+$/, "")
    if (!slug || seen[slug]) return
    seen[slug] = true
    // A video preview can't show in an Image; the thumbnail is its first frame.
    var image = VIDEO.test(preview) ? String(cols[1] || "").trim() : preview
    out.push({ slug: slug, name: displayName(slug), image: image })
  })
  return out.sort(function(a, b) { return a.name.localeCompare(b.name) })
}

function sections(themes, current, query) {
  var needle = String(query || "").trim().toLowerCase()
  var rows = (themes || []).filter(function(t) {
    return !needle || t.name.toLowerCase().indexOf(needle) >= 0 || t.slug.indexOf(needle) >= 0
  }).map(function(t) {
    return { candidate: {
      id: "theme:" + t.slug, type: "command", kind: "theme", title: t.name, subtitle: "",
      typeLabel: t.slug === current ? "Current" : "", checked: t.slug === current,
      glyph: "", rootSearch: { when: "always" }   // nf-fa-palette
    } }
  })
  return rows.length ? [{ id: "themes", title: "", rows: rows }] : []
}

function detail(theme, current) {
  return {
    category: "image", text: "", color: "", image: theme.image,
    info: [{ label: "Theme", value: theme.name }].concat(theme.slug === current ? [{ label: "Status", value: "Current theme" }] : [])
  }
}

function actionsFor(theme, current) {
  return [{ id: "open", title: theme.slug === current ? "Reapply Theme" : "Apply Theme", shortcut: "↵", section: "primary", icon: "" }]
}

if (typeof module !== "undefined") {
  module.exports = { displayName: displayName, parseRows: parseRows, sections: sections, detail: detail, actionsFor: actionsFor }
}
