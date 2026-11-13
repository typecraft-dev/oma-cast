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

// Structured add form (the editor card): Description, Priority, Due
// Date, Scheduled Date, Recurrence, Tags. Todoist's API only carries two
// dates (due + deadline), so Scheduled Date maps to deadline_date and
// there is no Start Date row; Recurrence fills due_string and wins over
// Due Date when both are set, because only due_string carries server-side
// recurrence. [D]
var ADD_PRIORITIES = [
  { value: "1", title: "No Priority" },
  { value: "4", title: "P1" },
  { value: "3", title: "P2" },
  { value: "2", title: "P3" }
]

// Raw render-tree Form payload for the ExtensionForm renderers.
function addFormDefinition() {
  return {
    kind: "Form", navigationTitle: "Add Task", isLoading: false, enableDrafts: false,
    items: [
      { kind: "TextField", id: "description", title: "Description", placeholder: "Buy bread", required: true },
      { kind: "Dropdown", id: "priority", title: "Priority",
        menu: { sections: [{ id: "p", items: ADD_PRIORITIES }] }, defaultValue: "1" },
      { kind: "DatePicker", id: "dueDate", title: "Due Date", type: "date" },
      { kind: "DatePicker", id: "scheduledDate", title: "Scheduled Date", type: "date" },
      { kind: "TextField", id: "recurrence", title: "Recurrence", placeholder: "e.g., every day, every week on Monday" },
      { kind: "TagPicker", id: "tags", title: "Tags", placeholder: "Comma-separated labels" }
    ]
  }
}

// Editable values for a fresh form (no Controlled wrappers: the
// renderers take these as the starting point). [D]
function addFormInitial() {
  return { description: "", priority: "1", dueDate: null, scheduledDate: null, recurrence: "", tags: [] }
}

// "YYYY-MM-DD" or null. False for anything else (bad month/day,
// non-strings, impossible calendar dates like Feb 30).
function normalizeDate(value) {
  if (value === null || value === undefined || value === "") return null
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim())
  if (!m) return false
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false
  var dt = new Date(y, mo - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return false
  return m[1] + "-" + m[2] + "-" + m[3]
}

// Tags arrive as an array (TagPicker) or a comma string; both trim down
// to non-empty labels.
function parseTags(value) {
  var parts = Array.isArray(value) ? value : String(value === undefined || value === null ? "" : value).split(",")
  var out = []
  for (var i = 0; i < parts.length; i++) {
    var t = String(parts[i]).trim()
    if (t && out.indexOf(t) < 0) out.push(t)
  }
  return out
}

// Form values → POST /tasks body, or {error} when invalid. Description
// is required; priority falls back to none; dates must be YYYY-MM-DD.
function createTaskBody(values) {
  var v = values || {}
  var content = String(v.description === undefined || v.description === null ? "" : v.description).replace(/\s+/g, " ").trim()
  var verr = validateText(content)
  if (verr) return { error: verr === "Type a task first" ? "Type a description first" : verr }
  var pr = Number(v.priority)
  var body = { content: content, priority: (pr === 4 || pr === 3 || pr === 2) ? pr : 1 }
  var labels = parseTags(v.tags)
  if (labels.length) body.labels = labels
  var rec = String(v.recurrence === undefined || v.recurrence === null ? "" : v.recurrence).replace(/\s+/g, " ").trim()
  var due = normalizeDate(v.dueDate)
  if (due === false) return { error: "Due Date must be YYYY-MM-DD" }
  var sched = normalizeDate(v.scheduledDate)
  if (sched === false) return { error: "Scheduled Date must be YYYY-MM-DD" }
  if (rec) body.due_string = rec
  else if (due) body.due_date = due
  if (sched) body.deadline_date = sched
  return { body: body }
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
    apiError: apiError,
    ADD_PRIORITIES: ADD_PRIORITIES,
    addFormDefinition: addFormDefinition,
    addFormInitial: addFormInitial,
    normalizeDate: normalizeDate,
    parseTags: parseTags,
    createTaskBody: createTaskBody
  }
}
