// Todoist task management (https://api.todoist.com/api/v1). Pure: no Qt,
// no fs, no fetch, no Intl — the backends own I/O (QML XHR in
// plugin/services/TodoistSource.qml, node https in electron/src/todoist.js).
// Shared unchanged by both backends; QML wires modules together, so this
// module never imports another one. [D]
//
// Priority mapping — read this before touching the code: the v1 REST doc
// line "1-4, where 1 is highest" is WRONG for the wire format. The Sync
// section of the same v1 doc page says "4 for very urgent and 1 for
// natural", Todoist's own CLI maps p1→4 when writing and 4→p1 when
// reading, and the official Python SDK says "priority ... (4 for very
// urgent)". So: API 4 = p1 (most urgent, red), 3 = p2, 2 = p3, 1 = p4
// (none). The write path sidesteps this entirely: creates go through
// POST /tasks/quick so Todoist's own parser resolves p1/tomorrow/#label.

var API_BASE = "https://api.todoist.com/api/v1"
var MAX_TEXT = 500          // Todoist's content limit
var LIST_LIMIT = 200        // GET /tasks max page size

// API value → p-label. Unknown values read as no priority.
var PRIORITY_LABELS = { 4: "p1", 3: "p2", 2: "p3", 1: "p4" }

function priorityLabel(apiValue) {
  return PRIORITY_LABELS[Number(apiValue)] || "p4"
}

var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// Whole calendar days from today (local) to the due date. Null when the
// task has no parseable due date.
function dayDiff(due, nowMs) {
  if (!due || !due.date) return null
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(due.date))
  if (!m) return null
  var today = new Date(Number(nowMs))
  today.setHours(0, 0, 0, 0)
  var then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (isNaN(then.getTime())) return null
  return Math.round((then.getTime() - today.getTime()) / 86400000)
}

// "Today" | "Tomorrow" | "Sat 7 Nov" | "". Overdue dates (even yesterday)
// read as the calendar date — the section header carries the urgency.
function dueLabel(due, nowMs) {
  var d = dayDiff(due, nowMs)
  if (d === null) return ""
  if (d === 0) return "Today"
  if (d === 1) return "Tomorrow"
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(due.date))
  var then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return WEEKDAYS[then.getDay()] + " " + then.getDate() + " " + MONTHS[then.getMonth()]
}

function dueBucket(due, nowMs) {
  var d = dayDiff(due, nowMs)
  if (d === null) return "none"
  if (d < 0) return "overdue"
  if (d === 0) return "today"
  return "upcoming"
}

// The launcher row for one ItemSyncView task. id namespace "todoist:*",
// separate from the builtins that push the views ("builtin:todoist*",
// which earn the frecency visits), so rows never share selection or
// frecency with the commands. [D]
function taskRow(task, nowMs) {
  var pl = priorityLabel(task.priority)
  var dl = dueLabel(task.due, nowMs)
  var labels = Array.isArray(task.labels) ? task.labels.slice() : []
  return {
    id: "todoist:" + task.id,
    type: "command",
    kind: "todoist-task",
    title: String(task.content || ""),
    subtitle: dl,
    typeLabel: pl === "p4" ? "" : pl,
    glyph: "",                     // nf-fa-tasks (U+F0AE)
    taskId: String(task.id || ""),
    content: String(task.content || ""),
    dueLabel: dl,
    priorityLabel: pl,
    labels: labels,
    rootSearch: { when: "always" }
  }
}

var GROUP_ORDER = [
  ["overdue", "Overdue"],
  ["today", "Today"],
  ["upcoming", "Upcoming"],
  ["none", "No due date"]
]

// [{id, title, tasks:[candidates]}] in display order, empty groups dropped.
function groupTasks(tasks, nowMs) {
  var buckets = { overdue: [], today: [], upcoming: [], none: [] }
  for (var i = 0; i < (tasks || []).length; i++) {
    var t = tasks[i]
    if (!t || !t.id) continue
    buckets[dueBucket(t.due, nowMs)].push(taskRow(t, nowMs))
  }
  var out = []
  for (var g = 0; g < GROUP_ORDER.length; g++) {
    if (buckets[GROUP_ORDER[g][0]].length) {
      out.push({ id: "todoist-" + GROUP_ORDER[g][0], title: GROUP_ORDER[g][1], tasks: buckets[GROUP_ORDER[g][0]] })
    }
  }
  return out
}

// Every whitespace-separated token must appear in the content or labels.
function filterTasks(tasks, query) {
  var tokens = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return (tasks || []).slice()
  var out = []
  for (var i = 0; i < (tasks || []).length; i++) {
    var t = tasks[i]
    if (!t) continue
    var hay = String(t.content || "").toLowerCase() + " " + (Array.isArray(t.labels) ? t.labels.join(" ").toLowerCase() : "")
    var ok = true
    for (var k = 0; k < tokens.length; k++) {
      if (hay.indexOf(tokens[k]) < 0) { ok = false; break }
    }
    if (ok) out.push(t)
  }
  return out
}

// One-line preview for the live add row.
function previewTitle(text, width) {
  var s = String(text).replace(/\s+/g, " ").trim()
  var w = width || 60
  return s.length > w ? s.slice(0, w - 1).trim() + "…" : s
}

// The task text, or an error string when it cannot be created.
function validateText(text) {
  var s = String(text === undefined || text === null ? "" : text)
  if (!s.trim()) return "Type a task first"
  if (s.indexOf("\u0000") >= 0) return "Tasks cannot contain a NUL character"
  if (s.length > MAX_TEXT) return "Keep the task under " + (MAX_TEXT + 1) + " characters"
  return null
}

// Non-2xx bodies are JSON: {"error": "...", "http_code": 401}. Map the
// codes to actionable messages; the write path never sees these (quick-add
// still creates the task when only an element fails to parse).
function apiError(status, json) {
  var server = json && (json.error || json.error_tag)
  if (status === 401) return "Invalid Todoist token — check TODOIST_TOKEN or todoistToken in config.json"
  if (status === 403) return "Todoist refused the request (403)" + (server ? ": " + server : "")
  if (status === 404) return "Task not found — it may already be gone"
  if (status === 429) return "Todoist rate limit — try again in a minute"
  if (server) return "Todoist: " + server
  return "Todoist request failed (HTTP " + status + ")"
}

if (typeof module !== "undefined") {
  module.exports = {
    API_BASE: API_BASE,
    MAX_TEXT: MAX_TEXT,
    LIST_LIMIT: LIST_LIMIT,
    PRIORITY_LABELS: PRIORITY_LABELS,
    priorityLabel: priorityLabel,
    dueLabel: dueLabel,
    dueBucket: dueBucket,
    taskRow: taskRow,
    groupTasks: groupTasks,
    filterTasks: filterTasks,
    previewTitle: previewTitle,
    validateText: validateText,
    apiError: apiError
  }
}
