// Quicklinks (SPEC §8.4): the saved-link library, placeholder expansion
// (SPEC §8.3), web-address detection, and how a link is opened.
// A document is { items: [{id, name, link, iconName, openWith, createdAt, updatedAt}] }.

var NAME_MAX = 200                   // [D] long enough for any row title
var ARGUMENTS_MAX = 3                // [O] ref 02 §5.2
var KEYWORDS = ["argument", "clipboard", "selection", "uuid", "datetime", "date", "time", "day"]
// Refused in quicklinks: browser-tab and cursor [O] ref 02 §6; snippet and
// calculator until those features exist, and ai (no AI features) [D].
var REFUSED = ["browser-tab", "cursor", "snippet", "calculator", "ai"]
var MODIFIERS = ["uppercase", "lowercase", "trim", "percent-encode", "json-stringify", "raw"]
var QUOTES = { "\"": "\"", "'": "'", "`": "`", "“": "”", "‘": "’" }
var OFFSET = /^([+-])(\d+)([mhHdDMyY])$/

// ---------------------------------------------------------------- library

function list(doc) {
  return (doc && Array.isArray(doc.items) ? doc.items : []).filter(function(item) {
    return item && typeof item.id === "string" && typeof item.name === "string" && typeof item.link === "string"
  })
}

function get(doc, id) {
  var items = list(doc)
  for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i]
  return null
}

function nameTaken(doc, name, exceptId) {
  var wanted = String(name).trim().toLowerCase()
  return list(doc).some(function(item) { return item.id !== exceptId && item.name.trim().toLowerCase() === wanted })
}

function newId(doc, now) {
  var id = "ql-" + now.toString(36)
  while (get(doc, id)) id += "x"
  return id
}

// Checks one {name, link, iconName?, openWith?}. ctx.apps is the desktop
// catalog (installedApps); an empty one means it has not loaded, so only
// the id's shape is checked. ctx.keepOpenWith is allowed even if uninstalled.
function validate(input, ctx) {
  var name = String(input && input.name != null ? input.name : "").trim()
  var link = String(input && input.link != null ? input.link : "").trim()
  if (!name) return { error: "A quicklink needs a name" }
  if (name.length > NAME_MAX) return { error: "That name is too long" }
  if (!link) return { error: "A quicklink needs a link" }
  var refused = refusedTarget(link)
  if (refused) return { error: refused }
  var parsed = parseLink(link)
  if (parsed.error) return { error: parsed.error }
  var openWith = String(input.openWith || "").trim()
  if (openWith && !(ctx && ctx.keepOpenWith === openWith)) {
    if (!isDesktopId(openWith)) return { error: "Open With must be a desktop id such as firefox.desktop" }
    var apps = (ctx && ctx.apps) || []
    if (apps.length) {
      var app = findApp(apps, openWith)
      if (!app) return { error: openWith + " is not installed" }
      openWith = app.id
    }
  }
  return { error: "", item: { name: name, link: link, iconName: String(input.iconName || "").trim(), openWith: openWith } }
}

function save(doc, input, ctx) {
  var checked = validate(input, ctx)
  if (checked.error) return { error: checked.error }
  if (nameTaken(doc, checked.item.name, "")) return { error: "A quicklink named " + checked.item.name + " already exists" }
  var now = ctx.now
  var item = Object.assign({ id: newId(doc, now) }, checked.item, { createdAt: now, updatedAt: now })
  return { error: "", item: item, doc: { items: list(doc).concat([item]) } }
}

function update(doc, id, input, ctx) {
  var current = get(doc, id)
  if (!current) return { error: "Quicklink not found" }
  var checked = validate(input, Object.assign({}, ctx, { keepOpenWith: current.openWith }))
  if (checked.error) return { error: checked.error }
  if (nameTaken(doc, checked.item.name, id)) return { error: "A quicklink named " + checked.item.name + " already exists" }
  var item = Object.assign({ id: id }, checked.item, { createdAt: current.createdAt, updatedAt: ctx.now })
  return { error: "", item: item, doc: { items: list(doc).map(function(it) { return it.id === id ? item : it }) } }
}

function remove(doc, id) {
  if (!get(doc, id)) return { error: "Quicklink not found" }
  return { error: "", doc: { items: list(doc).filter(function(it) { return it.id !== id }) } }
}

// Raycast's export format [I]: [{name, link, iconName?, openWith?}].
// [D] A row with the same name and link as a saved one is a duplicate.
function importText(doc, text, ctx) {
  var rows
  try { rows = JSON.parse(String(text || "")) } catch (e) { return { error: "That is not valid JSON" } }
  if (!Array.isArray(rows)) return { error: "Import expects a JSON array" }
  var next = { items: list(doc) }
  var added = 0, duplicates = 0, withoutApp = 0, failed = []
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    var label = row && typeof row.name === "string" && row.name.trim() ? row.name.trim() : "row " + (i + 1)
    if (!row || typeof row !== "object" || Array.isArray(row)) { failed.push(label); continue }
    var same = list(next).some(function(it) { return it.name === String(row.name).trim() && it.link === String(row.link).trim() })
    if (same) { duplicates++; continue }
    // [D] A Raycast export names macOS apps; keep the link, open it with the default.
    var apps = ctx.apps || []
    var openWith = String(row.openWith || "").trim()
    if (openWith && !(isDesktopId(openWith) && (!apps.length || findApp(apps, openWith)))) {
      openWith = ""
      withoutApp++
    }
    var saved = save(next, Object.assign({}, row, { openWith: openWith }), { apps: apps, now: ctx.now + i })
    if (saved.error) { failed.push(label); continue }
    next = saved.doc
    added++
  }
  return { error: "", doc: next, added: added, duplicates: duplicates, withoutApp: withoutApp, failed: failed }
}

function exportList(doc) {
  return list(doc).map(function(item) {
    var row = { name: item.name, link: item.link }
    if (item.iconName) row.iconName = item.iconName
    if (item.openWith) row.openWith = item.openWith
    return row
  })
}

function toCandidate(item) {
  var parsed = parseLink(item.link)
  return {
    id: "quicklink:" + item.id,
    type: "quicklink",
    kind: "quicklink",
    title: item.name,
    subtitle: item.link,
    keywords: [],
    typeLabel: "Quicklink",
    glyph: item.iconName ? "" : "",   // nf-fa-link
    iconName: item.iconName || "",
    quicklinkId: item.id,
    // [O] Up to 3 arguments become argument pills after the search text.
    // Pills read {placeholder, required}; a default makes one optional.
    arguments: parsed.error ? [] : parsed.arguments.map(function(a) {
      return {
        name: a.name, defaultValue: a.defaultValue, options: a.options, required: !a.defaultValue,
        placeholder: a.options.length ? a.name + " ▾" : (a.defaultValue || a.name)
      }
    }),
    rootSearch: { when: "searching" }   // [O] Search Quicklinks lists them all
  }
}

// ----------------------------------------------------------- placeholders

// Index of the "}" that closes the placeholder at `start`, or -1 when
// there is none on that line: then "{" is literal text [O]. Quotes may hide "}".
function placeholderEnd(text, start) {
  var close = ""
  for (var i = start + 1; i < text.length; i++) {
    var ch = text.charAt(i)
    if (close) {
      if (ch === "\\") i++
      else if (ch === close) close = ""
    } else if (ch === "\n") return -1
    else if (QUOTES[ch]) close = QUOTES[ch]
    else if (ch === "}") return i
  }
  return -1
}

// Splits on spaces and "|" outside quotes. Returns {words, modifiers}; a
// word that starts with a quote is marked `quoted` (a value, never key=value).
function tokenize(inner) {
  var words = [], modifiers = [], buf = "", quoted = false, inPipe = false
  function flush() {
    if (!buf && !quoted) return
    if (inPipe) modifiers.push(buf)
    else words.push({ text: buf, quoted: quoted })
    buf = ""
    quoted = false
  }
  for (var i = 0; i < inner.length; i++) {
    var ch = inner.charAt(i)
    if (QUOTES[ch]) {
      var close = QUOTES[ch]
      if (!buf) quoted = true
      for (i++; i < inner.length && inner.charAt(i) !== close; i++) {
        if (inner.charAt(i) === "\\" && i + 1 < inner.length) i++
        buf += inner.charAt(i)
      }
    } else if (ch === " ") flush()
    else if (ch === "|") { flush(); inPipe = true }
    else buf += ch
  }
  flush()
  return { words: words, modifiers: modifiers }
}

// "a, b, Title: value" -> [{title, value}], with "\" escapes [O].
function parseOptions(text) {
  var out = [], buf = ""
  for (var i = 0; i <= text.length; i++) {
    var ch = text.charAt(i)
    if (ch === "\\" && i + 1 < text.length) { buf += text.charAt(++i); continue }
    if (ch !== "," && i < text.length) { buf += ch; continue }
    var item = buf.trim()
    buf = ""
    if (!item) continue
    var colon = item.indexOf(":")
    out.push(colon < 0 ? { title: item, value: item } : { title: item.slice(0, colon).trim(), value: item.slice(colon + 1).trim() })
  }
  return out
}

function parsePlaceholder(inner) {
  var head = inner.split(/[ |]/)[0]
  var keyword = head.toLowerCase()
  for (var r = 0; r < REFUSED.length; r++) {
    if (keyword === REFUSED[r] || keyword.indexOf(REFUSED[r] + ".") === 0) return { error: "Quicklinks cannot use {" + head + "}" }
  }
  var tokens = tokenize(inner)
  for (var m = 0; m < tokens.modifiers.length; m++) {
    if (MODIFIERS.indexOf(tokens.modifiers[m]) < 0) return { error: "Unknown modifier " + tokens.modifiers[m] }
  }
  head = keyword
  if (KEYWORDS.indexOf(head) < 0) {
    // [O] Any other {word} or {word:default} is an argument (legacy form).
    var legacy = inner.split("|")[0].trim()
    if (!legacy || legacy.indexOf("=") >= 0) return { error: "Unknown placeholder {" + inner + "}" }
    var colon = legacy.indexOf(":")
    var name = colon < 0 ? legacy : legacy.slice(0, colon).trim()
    return { kind: "argument", name: name, defaultValue: colon < 0 ? "" : legacy.slice(colon + 1).trim(), options: [], modifiers: tokens.modifiers }
  }
  var attrs = {}, positional = []
  for (var w = 1; w < tokens.words.length; w++) {
    var word = tokens.words[w]
    var eq = word.quoted ? -1 : word.text.indexOf("=")
    if (eq > 0) attrs[word.text.slice(0, eq)] = word.text.slice(eq + 1)
    else positional.push(word.text)
  }
  var out = { kind: head, modifiers: tokens.modifiers, attrs: attrs }
  if (head === "argument") {
    out.name = attrs.name || "argument"
    out.defaultValue = attrs["default"] || ""
    out.options = attrs.options ? parseOptions(attrs.options) : []
  } else if (head === "clipboard" && attrs.offset && attrs.offset !== "0") {
    return { error: "{clipboard offset} needs clipboard history, which is not built yet" }
  } else if (head === "date" || head === "time" || head === "datetime" || head === "day") {
    // [O] Legacy {date "format" +1d}: a quoted format and offsets.
    var offsets = attrs.offset ? attrs.offset.trim().split(/\s+/) : []
    for (var q = 0; q < positional.length; q++) {
      if (/^[+-]\d/.test(positional[q])) offsets.push(positional[q])
      else if (!attrs.format) attrs.format = positional[q]
    }
    for (var o = 0; o < offsets.length; o++) if (!OFFSET.test(offsets[o])) return { error: "Bad date offset " + offsets[o] }
    out.offsets = offsets
  }
  return out
}

// Walks the link once. `visit(placeholder)` returns the text to put in its
// place, or {error}. Literal text goes through `literal`.
function walk(link, visit, literal) {
  var out = ""
  for (var i = 0; i < link.length;) {
    var start = link.indexOf("{", i)
    if (start < 0) { out += literal(link.slice(i)); break }
    out += literal(link.slice(i, start))
    var end = placeholderEnd(link, start)
    if (end < 0) { out += literal("{"); i = start + 1; continue }
    var placeholder = parsePlaceholder(link.slice(start + 1, end))
    if (placeholder.error) return { error: placeholder.error }
    var value = visit(placeholder)
    if (value && value.error) return { error: value.error }
    out += value
    i = end + 1
  }
  return { error: "", text: out }
}

// What opening a link needs: its arguments (merged by name, max 3) and
// whether it reads the clipboard or the selection.
function parseLink(link) {
  var args = [], needs = { clipboard: false, selection: false }
  var result = walk(String(link || ""), function(p) {
    if (p.kind === "clipboard" || p.kind === "selection") needs[p.kind] = true
    if (p.kind !== "argument") return ""
    var known = args.filter(function(a) { return a.name === p.name })[0]
    if (!known) args.push({ name: p.name, defaultValue: p.defaultValue, options: p.options })
    else {
      if (!known.defaultValue) known.defaultValue = p.defaultValue
      if (!known.options.length) known.options = p.options
    }
    return ""
  }, function() { return "" })
  if (result.error) return { error: result.error }
  if (args.length > ARGUMENTS_MAX) return { error: "A quicklink can have at most " + ARGUMENTS_MAX + " arguments" }
  return { error: "", arguments: args, needsClipboard: needs.clipboard, needsSelection: needs.selection }
}

// Fills defaults, trims, and checks required arguments and options.
// An option matches its title or its value, ignoring case.
function argumentValues(parsed, given) {
  var out = {}
  for (var i = 0; i < parsed.arguments.length; i++) {
    var arg = parsed.arguments[i]
    var text = String(given && given[arg.name] != null ? given[arg.name] : "").trim() || arg.defaultValue
    if (!text) return { error: arg.name + " is required" }
    if (arg.options.length) {
      var wanted = text.toLowerCase()
      var hit = arg.options.filter(function(o) { return o.title.toLowerCase() === wanted || o.value.toLowerCase() === wanted })[0]
      if (!hit) return { error: text + " is not one of " + arg.options.map(function(o) { return o.title }).join(", ") }
      text = hit.value
    }
    out[arg.name] = text
  }
  return { error: "", values: out }
}

// ctx: {now, values, clipboard, selection, uuid, names}. names(locale)
// gives month and day names, "" meaning the system locale (QML passes
// Qt.locale); without it, English.
// [I] Substituted values are percent-encoded unless `| raw`, except in a
// file path, which xdg-open needs as written.
function expand(link, ctx) {
  var text = String(link || "").trim()
  var path = isPath(text)
  var result = walk(text, function(p) {
    var value
    if (p.kind === "argument") value = ctx.values[p.name] || ""
    else if (p.kind === "clipboard") value = ctx.clipboard || ""
    else if (p.kind === "selection") value = ctx.selection || ""
    else if (p.kind === "uuid") value = ctx.uuid || ""
    else value = dateText(p, ctx)
    var raw = path
    for (var i = 0; i < p.modifiers.length; i++) {
      var m = p.modifiers[i]
      if (m === "uppercase") value = value.toUpperCase()
      else if (m === "lowercase") value = value.toLowerCase()
      else if (m === "trim") value = value.trim()
      else if (m === "json-stringify") value = JSON.stringify(value)
      else if (m === "percent-encode") { value = encodeURIComponent(value); raw = true }
      else if (m === "raw") raw = true
    }
    return raw ? value : encodeURIComponent(value)
  }, function(part) { return path ? part : part.replace(/ /g, "%20") })
  if (result.error) return { error: result.error }
  if (!result.text.trim()) return { error: "The link is empty after its placeholders are filled in" }
  var refused = refusedTarget(result.text)
  if (refused) return { error: refused }
  return { error: "", url: result.text }
}

// --------------------------------------------------------------- dates

var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
var ENGLISH = {
  month: function(i, long) { return long ? MONTHS[i] : MONTHS[i].slice(0, 3) },
  day: function(i, long) { return long ? DAYS[i] : DAYS[i].slice(0, 3) }
}
// ICU pattern letters we support, longest first.
var TOKENS = ["yyyy", "yy", "y", "MMMM", "MMM", "MM", "M", "dd", "d", "EEEE", "EEE", "EE", "E", "HH", "H", "hh", "h", "mm", "m", "ss", "s", "a"]

function shifted(now, offsets) {
  var date = new Date(now)
  for (var i = 0; i < offsets.length; i++) {
    var m = OFFSET.exec(offsets[i])
    var n = (m[1] === "-" ? -1 : 1) * parseInt(m[2], 10)
    var unit = m[3]
    if (unit === "m") date.setMinutes(date.getMinutes() + n)
    else if (unit === "h" || unit === "H") date.setHours(date.getHours() + n)
    else if (unit === "d" || unit === "D") date.setDate(date.getDate() + n)
    else if (unit === "M") date.setMonth(date.getMonth() + n)
    else date.setFullYear(date.getFullYear() + n)
  }
  return date
}

function pad(n, width) {
  var s = String(n)
  while (s.length < width) s = "0" + s
  return s
}

function formatDate(date, pattern, names) {
  var out = ""
  for (var i = 0; i < pattern.length;) {
    if (pattern.charAt(i) === "'") {
      var close = pattern.indexOf("'", i + 1)
      out += close === i + 1 ? "'" : pattern.slice(i + 1, close < 0 ? pattern.length : close)
      i = close < 0 ? pattern.length : close + 1
      continue
    }
    var token = TOKENS.filter(function(t) { return pattern.substr(i, t.length) === t })[0]
    if (!token) { out += pattern.charAt(i++); continue }
    var h12 = date.getHours() % 12 || 12
    var values = {
      yyyy: pad(date.getFullYear(), 4), yy: pad(date.getFullYear() % 100, 2), y: date.getFullYear(),
      MMMM: names.month(date.getMonth(), true), MMM: names.month(date.getMonth(), false),
      MM: pad(date.getMonth() + 1, 2), M: date.getMonth() + 1, dd: pad(date.getDate(), 2), d: date.getDate(),
      EEEE: names.day(date.getDay(), true), EEE: names.day(date.getDay(), false),
      EE: names.day(date.getDay(), false), E: names.day(date.getDay(), false),
      HH: pad(date.getHours(), 2), H: date.getHours(), hh: pad(h12, 2), h: h12,
      mm: pad(date.getMinutes(), 2), m: date.getMinutes(), ss: pad(date.getSeconds(), 2), s: date.getSeconds(),
      a: date.getHours() < 12 ? "AM" : "PM"
    }
    out += values[token]
    i += token.length
  }
  return out
}

// [I] Defaults follow Raycast's medium styles: "20 Oct 2026", "14:05".
function dateText(p, ctx) {
  var date = shifted(ctx.now, p.offsets)
  var names = ctx.names ? ctx.names(p.attrs.locale || "") : ENGLISH
  if (p.attrs.format) return formatDate(date, p.attrs.format, names)
  if (p.kind === "day") return formatDate(date, "EEEE", names)
  if (p.kind === "time") return formatDate(date, "HH:mm", names)
  if (p.kind === "datetime") return formatDate(date, "d MMM yyyy HH:mm", names)
  return formatDate(date, "d MMM yyyy", names)
}

// ------------------------------------------------------- web addresses

// [D] A bare host needs a two-letter country TLD, an IDN TLD, or one of
// these common longer ones, so "vs.code" or "node.js" stay searches. Any
// other TLD works with its scheme (https://example.museum).
var LONG_TLDS = ["com", "net", "org", "edu", "gov", "mil", "int", "info", "biz", "dev", "app", "xyz", "online", "site", "store", "shop", "tech", "blog", "cloud", "page", "wiki", "news", "design", "club", "live", "life", "world", "space", "website", "email", "link", "art", "pro", "name", "mobi", "codes", "software", "systems", "social", "media", "studio", "agency", "digital", "network", "games", "tools", "host", "lol", "one", "top", "fun", "run", "build", "chat", "zone", "today", "academy", "school", "photo", "photos", "travel", "music", "video", "tv", "work", "works", "company", "solutions", "services", "group", "team", "eu", "asia", "moe", "museum", "coop", "aero", "jobs", "berlin", "london", "nyc", "paris", "tokyo"]
// A last label that is a common file extension is a file, not a TLD.
var FILE_EXTENSIONS = ["json", "md", "js", "ts", "txt", "pdf", "png", "jpg", "jpeg", "gif", "svg", "html", "css", "xml", "sh", "py", "rs", "qml", "zip", "tar", "gz", "conf", "toml", "yaml", "yml", "log", "lock"]
// Zero-width and bidi controls make a host look like another one.
var HIDDEN_CHARS = /[᠎​-‏‪-‮⁠⁦-⁩﻿]/

function isPath(text) {
  return /^[\/~]/.test(text)
}

function isHost(host) {
  if (/^localhost$/i.test(host)) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host.split(".").every(function(n) { return Number(n) <= 255 })
  if (HIDDEN_CHARS.test(host)) return false
  var labels = host.split(".")
  if (labels.length < 2) return false
  if (!labels.every(function(l) { return /^[^\s\-_.:@\/][^\s_.:@\/]{0,62}$/.test(l) && !/-$/.test(l) })) return false
  var tld = labels[labels.length - 1].toLowerCase()
  return /^([a-z]{2}|xn--[a-z0-9-]+|[^\x00-\x7f]{2,})$/.test(tld) ? FILE_EXTENSIONS.indexOf(tld) < 0 : LONG_TLDS.indexOf(tld) >= 0
}

// "github.com/x", "localhost:3000", "1.2.3.4" -> a full http(s) URL, or "".
// [D] localhost is http; every other bare host is https.
// Dev servers and routers rarely serve TLS: localhost, loopback and private
// IPv4 ranges open as http [D].
function isLocalHost(host) {
  if (/^localhost$/i.test(host)) return true
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false
  return /^(127|10)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
}

function bareWebUrl(text) {
  var m = /^([^\/?#:\s]+)(?::(\d{1,5}))?([\/?#][^\s]*)?$/.exec(String(text || ""))
  if (!m || !isHost(m[1])) return ""
  if (m[2] !== undefined && !(Number(m[2]) >= 1 && Number(m[2]) <= 65535)) return ""
  return (isLocalHost(m[1]) ? "http://" : "https://") + m[0]
}

// A root-search query that is an address: scheme://…, mailto:/tel:, or a bare host.
function webAddress(query) {
  var q = String(query || "").trim()
  if (!q || /\s/.test(q)) return ""
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(q) || /^(mailto|tel):\S+$/i.test(q)) return refusedTarget(q) ? "" : q
  return bareWebUrl(q)
}

// A starting name and link for Create Quicklink from a typed query or the
// clipboard [O: Raycast autofills from a URL or file path in the
// clipboard]: a web address named after its host, or a path named after its
// last part. Anything else gives null.
function suggestion(text) {
  var q = String(text || "").trim()
  if (!q || q.length > 2048 || /\s/.test(q.replace(/ /g, ""))) return null
  if ((q.charAt(0) === "/" || q.indexOf("~/") === 0) && q.length > 2) {
    var parts = q.replace(/\/+$/, "").split("/")
    return { name: parts[parts.length - 1], link: q }
  }
  var url = webAddress(q)
  if (!url || refusedTarget(url)) return null
  if (/^(mailto|tel):/i.test(url)) return { name: url.slice(url.indexOf(":") + 1), link: url }
  var host = url.replace(/^[a-z][a-z0-9+.-]*:(\/\/)?/i, "").split(/[\/?#]/)[0].replace(/^[^@]*@/, "").replace(/^www\./i, "")
  return { name: host || url, link: url }
}

// ------------------------------------------------------------- opening

function refusedTarget(target) {
  var text = String(target || "").trim()
  if (/^javascript:/i.test(text)) return "Links cannot use javascript:"
  // xdg-utils' xdg-open has no "--", so a leading "-" would be read as an option.
  if (text.charAt(0) === "-") return "A link cannot start with -"
  return ""
}

// The argv that opens `url`. http(s) and bare hosts go through Omarchy's
// browser launcher, like the web-search fallbacks; anything else (a path,
// spotify://, mailto:) through xdg-open; a chosen app through gtk-launch.
function openArgv(url, openWith, home) {
  var target = String(url || "").trim()
  if (refusedTarget(target)) return null
  if (target === "~" || target.indexOf("~/") === 0) target = home + target.slice(1)
  var bare = isPath(target) ? "" : bareWebUrl(target)
  if (bare) target = bare
  if (openWith) return isDesktopId(openWith) ? ["uwsm-app", "--", "gtk-launch", openWith, target] : null
  if (/^https?:\/\//i.test(target)) return ["omarchy-launch-browser", target]
  return ["xdg-open", target]
}

// ----------------------------------------------------------- open with

function isDesktopId(id) {
  return /^[A-Za-z0-9][A-Za-z0-9_.+-]*\.desktop$/.test(String(id || ""))
}

// Quickshell DesktopEntry objects -> [{id: "x.desktop", name, icon}], by name.
function installedApps(entries) {
  var out = []
  for (var i = 0; i < (entries || []).length; i++) {
    var e = entries[i]
    if (!e || !e.id) continue
    var id = /\.desktop$/.test(e.id) ? String(e.id) : e.id + ".desktop"
    if (isDesktopId(id) && !out.some(function(a) { return a.id === id })) out.push({ id: id, name: String(e.name || id), icon: String(e.icon || "") })
  }
  return out.sort(function(a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : (a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0) })
}

// An exact id, or the only one that matches ignoring case.
function findApp(apps, id) {
  var exact = apps.filter(function(a) { return a.id === id })
  if (exact.length) return exact[0]
  var folded = apps.filter(function(a) { return a.id.toLowerCase() === String(id).toLowerCase() })
  return folded.length === 1 ? folded[0] : null
}

var DEFAULT_APP = "Default"

function openWithLabel(apps, id) {
  if (!id) return DEFAULT_APP
  var app = findApp(apps, id)
  return app ? app.name : (apps.length ? id + " (not installed)" : id)
}

// Picker rows: Default, then a saved app that is gone, then installed apps.
function openWithChoices(apps, query, current) {
  var q = String(query || "").trim().toLowerCase()
  var match = function(text) { return !q || text.toLowerCase().indexOf(q) >= 0 }
  var rows = []
  if (match(DEFAULT_APP)) rows.push({ id: "", title: DEFAULT_APP, subtitle: "Browser for web links, xdg-open for the rest", glyph: "", iconName: "" })
  if (current && !findApp(apps, current) && match(current)) rows.push({ id: current, title: openWithLabel(apps, current), subtitle: "", glyph: "", iconName: "" })
  for (var i = 0; i < apps.length; i++) {
    if (match(apps[i].name + " " + apps[i].id)) rows.push({ id: apps[i].id, title: apps[i].name, subtitle: "", glyph: "", iconName: apps[i].icon })
  }
  return rows
}

function randomUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
    var r = Math.floor(Math.random() * 16)
    return (c === "x" ? r : (r & 3) | 8).toString(16)
  })
}

if (typeof module !== "undefined") {
  module.exports = {
    NAME_MAX: NAME_MAX,
    list: list,
    get: get,
    save: save,
    update: update,
    remove: remove,
    importText: importText,
    exportList: exportList,
    toCandidate: toCandidate,
    suggestion: suggestion,
    parseLink: parseLink,
    argumentValues: argumentValues,
    expand: expand,
    formatDate: formatDate,
    bareWebUrl: bareWebUrl,
    webAddress: webAddress,
    refusedTarget: refusedTarget,
    openArgv: openArgv,
    isDesktopId: isDesktopId,
    installedApps: installedApps,
    findApp: findApp,
    openWithLabel: openWithLabel,
    openWithChoices: openWithChoices,
    randomUuid: randomUuid
  }
}
