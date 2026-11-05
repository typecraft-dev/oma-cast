// Superwhisper (superwhisper.com) dictation: the history view and its
// actions. The history comes from `superwhisper history list` (JSON); the
// CLI is Superwhisper's own interface, so omacast never reads its files.

// shortcut: the view loads the newest 500 dictations; page with --offset if
// anyone needs older ones in search.
var HISTORY_LIMIT = 500

// {items:[{timestamp, audioPath, metadata:{result, rawResult, datetime, …}}]}
// → entries, newest first. Dictations with no text are dropped.
function parseHistory(raw) {
  var data
  try { data = JSON.parse(String(raw || "")) } catch (e) { return [] }
  var items = data && Array.isArray(data.items) ? data.items : []
  var out = []
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {}
    var m = it.metadata || {}
    var text = String(m.result || m.llmResult || m.rawResult || "")
    if (!text.trim()) continue
    var at = Date.parse(m.datetime || "")
    if (isNaN(at)) at = Number(it.timestamp) * 1000 || 0
    var linux = m.linux || {}
    out.push({
      id: String(it.timestamp || at),
      text: text,
      raw: String(m.rawResult || ""),
      createdAt: at,
      durationMs: Number(m.duration) || 0,
      voiceModel: String(m.modelName || ""),
      languageModel: String(m.languageModelName || ""),
      mode: String(m.modeName || ""),
      language: String(m.languageSelected || ""),
      delivery: String(linux.delivery || ""),
      device: String(m.recordingDevice || "").replace(/^linux:input:/, "")
    })
  }
  out.sort(function(a, b) { return b.createdAt - a.createdAt })
  return out
}

// `superwhisper general show` (JSON) → whether the history view has
// anything to show: history recording is on and there is at least one entry.
function historyAvailable(raw) {
  var data
  try { data = JSON.parse(String(raw || "")) } catch (e) { return false }
  var linux = data && data.config && data.config.linux || {}
  return linux.historyEnabled !== false && !!(data.history && data.history.entries > 0)
}

function relativeTime(ms, nowMs) {
  var s = Math.max(0, Math.round((nowMs - ms) / 1000))
  if (s < 60) return "Just now"
  if (s < 3600) return Math.floor(s / 60) + " min ago"
  if (s < 86400) return Math.floor(s / 3600) + " h ago"
  var d = Math.floor(s / 86400)
  return d === 1 ? "Yesterday" : d + " days ago"
}

function candidate(entry, nowMs) {
  var line = entry.text.slice(0, 400).replace(/\s+/g, " ").trim()
  return {
    id: "superwhisper:" + entry.id, type: "command", kind: "superwhisper-history",
    title: line.length > 200 ? line.slice(0, 200) + "…" : line, subtitle: "",
    typeLabel: relativeTime(entry.createdAt, nowMs), glyph: "",   // nf-fa-microphone
    rootSearch: { when: "always" }
  }
}

// Today, Yesterday and Earlier, as in Clipboard History; the query matches
// the text anywhere. [I]
function sections(entries, query, nowMs) {
  var needle = String(query || "").trim().toLowerCase()
  var midnight = new Date(nowMs); midnight.setHours(0, 0, 0, 0)
  var today = midnight.getTime(), yesterday = today - 86400000
  var groups = { today: [], yesterday: [], earlier: [] }
  ;(entries || []).forEach(function(e) {
    if (needle && e.text.toLowerCase().indexOf(needle) < 0) return
    groups[e.createdAt >= today ? "today" : e.createdAt >= yesterday ? "yesterday" : "earlier"].push({ candidate: candidate(e, nowMs) })
  })
  var out = []
  if (groups.today.length) out.push({ id: "superwhisper-today", title: "Today", rows: groups.today })
  if (groups.yesterday.length) out.push({ id: "superwhisper-yesterday", title: "Yesterday", rows: groups.yesterday })
  if (groups.earlier.length) out.push({ id: "superwhisper-earlier", title: "Earlier", rows: groups.earlier })
  return out
}

function formatDuration(ms) {
  var s = Math.round(ms / 1000)
  return s < 60 ? s + " s" : Math.floor(s / 60) + " min " + (s % 60) + " s"
}

function formatDate(ms) {
  var d = new Date(ms)
  return d.toDateString() + " " + d.toTimeString().slice(0, 5)
}

// The detail pane (ui/DetailPane.qml): the text, then Information rows.
function detail(entry) {
  var info = []
  function add(label, value) { if (value !== undefined && value !== null && value !== "") info.push({ label: label, value: String(value) }) }
  var words = entry.text.match(/\S+/g)
  add("Recorded", formatDate(entry.createdAt))
  if (entry.durationMs) add("Duration", formatDuration(entry.durationMs))
  add("Words", words ? words.length : 0)
  add("Mode", entry.mode)
  add("Voice model", entry.voiceModel)
  add("Language model", entry.languageModel)
  add("Language", entry.language)
  add("Microphone", entry.device)
  return { category: "text", text: entry.text, image: "", color: "", info: info }
}

function actionsFor(entry, appName) {
  var list = [
    { id: "paste", title: "Paste to " + (appName || "Active App"), shortcut: "↵", section: "primary", icon: "" },
    { id: "copy", title: "Copy to Clipboard", shortcut: "Ctrl ↵", section: "primary", icon: "" }
  ]
  if (entry.raw && entry.raw !== entry.text) list.push({ id: "copy-raw", title: "Copy Raw Transcript", shortcut: "Ctrl Shift C", section: "copy", icon: "" })
  list.push({ id: "open-in-superwhisper", title: "Open in Superwhisper", shortcut: "", section: "configure", icon: "" })
  return list
}

// ------------------------------------------------------------- settings
// Switch Processing Mode / Microphone / Language: a list read from the CLI
// with the current choice checked, and the CLI command that picks one.

var SETTINGS = {
  mode: { title: "Switch Processing Mode", show: ["models", "show"], placeholder: "Search processing modes…" },
  microphone: { title: "Switch Microphone", show: ["audio", "show"], placeholder: "Search microphones…" },
  language: { title: "Switch Language", show: ["general", "show"], placeholder: "Search languages…" }
}

// The show command's JSON → {current, options:[{value, label}]}, or null.
// Modes are the ones ready to use (processingOptions: models downloaded).
// Languages are Superwhisper's own list.
function settingOptions(setting, raw) {
  var d
  try { d = JSON.parse(String(raw || "")) } catch (e) { return null }
  if (!d || typeof d !== "object") return null
  if (setting === "mode") {
    return { current: String(d.processing || ""), options: (d.processingOptions || []).map(function(o) { return { value: String(o.value), label: String(o.label || o.value) } }) }
  }
  if (setting === "microphone") {
    var c = d.config || {}
    var options = [{ value: "", label: "System Default" }]
    ;(d.devices || []).forEach(function(dev) {
      if (!dev.ignored && dev.name) options.push({ value: String(dev.name), label: String(dev.label || dev.description || dev.name) })
    })
    return { current: c.useDefaultInputDevice ? "" : String(c.selectedDeviceID || ""), options: options }
  }
  if (setting === "language") {
    var langs = (d.options && d.options.languages) || []
    return { current: String((d.config && d.config.language) || ""), options: langs.map(function(o) { return { value: String(o.value), label: String(o.label || o.value) } }) }
  }
  return null
}

function settingSections(setting, state, query) {
  if (!state) return []
  var needle = String(query || "").trim().toLowerCase()
  var rows = state.options.filter(function(o) {
    return !needle || o.label.toLowerCase().indexOf(needle) >= 0 || o.value.toLowerCase() === needle
  }).map(function(o) {
    return { candidate: {
      id: "superwhisper-setting:" + setting + ":" + o.value, type: "command", kind: "superwhisper-setting",
      title: o.label, subtitle: "", typeLabel: o.value === state.current ? "Current" : "",
      checked: o.value === state.current, glyph: "", rootSearch: { when: "always" }
    } }
  })
  return rows.length ? [{ id: "superwhisper-" + setting, title: "", rows: rows }] : []
}

// "superwhisper-setting:<setting>:<value>" → {setting, value}.
function parseSettingId(id) {
  var m = /^superwhisper-setting:([a-z]+):(.*)$/.exec(String(id))
  return m && SETTINGS[m[1]] ? { setting: m[1], value: m[2] } : null
}

// argv after `superwhisper` that picks a value. Values come from
// Superwhisper's own lists, never from what the user typed.
function selectArgv(setting, value) {
  if (setting === "mode") return ["models", "select", value]
  if (setting === "microphone") return ["audio", "select", value]
  if (setting === "language") return ["general", "set", "language", JSON.stringify(value)]
  throw new Error("Unknown Superwhisper setting " + setting)
}

if (typeof module !== "undefined") {
  module.exports = {
    HISTORY_LIMIT: HISTORY_LIMIT, parseHistory: parseHistory, historyAvailable: historyAvailable, candidate: candidate,
    sections: sections, detail: detail, actionsFor: actionsFor,
    SETTINGS: SETTINGS, settingOptions: settingOptions, settingSections: settingSections, parseSettingId: parseSettingId, selectArgv: selectArgv
  }
}
