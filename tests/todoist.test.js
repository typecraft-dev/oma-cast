// Todoist shared core: priority mapping (the v1 doc line is wrong —
// API 4 = p1), due labels/buckets without Intl, filtering, grouping,
// validation and the RootSearch row/action shapes.
const test = require("node:test")
const assert = require("node:assert/strict")
const TD = require("../plugin/core/Todoist.js")
const RS = require("../plugin/core/RootSearch.js")

// 2026-11-12 is a Thursday. Noon UTC keeps the local day stable across
// timezones for the date-only assertions below.
const NOW = Date.UTC(2026, 10, 12, 12)

function task(overrides) {
  return Object.assign({
    id: "1", content: "Buy milk", description: "",
    project_id: "p1", section_id: null, labels: [],
    priority: 1, due: null, deadline: null,
    added_at: "2026-11-11T10:30:00Z"
  }, overrides || {})
}

test("API 4 is p1 (urgent) and 1 is p4 (none) — the doc line is wrong", () => {
  assert.deepEqual(TD.PRIORITY_LABELS, { 4: "p1", 3: "p2", 2: "p3", 1: "p4" })
  assert.equal(TD.priorityLabel(4), "p1")
  assert.equal(TD.priorityLabel(3), "p2")
  assert.equal(TD.priorityLabel(2), "p3")
  assert.equal(TD.priorityLabel(1), "p4")
  assert.equal(TD.priorityLabel(9), "p4", "unknown values read as no priority")
  assert.equal(TD.priorityLabel(undefined), "p4")
})

test("due labels without Intl", () => {
  assert.equal(TD.dueLabel(null, NOW), "")
  assert.equal(TD.dueLabel({ date: "2026-11-12" }, NOW), "Today")
  assert.equal(TD.dueLabel({ date: "2026-11-13" }, NOW), "Tomorrow")
  assert.equal(TD.dueLabel({ date: "2026-11-14T17:00:00" }, NOW), "Sat 14 Nov")
  assert.equal(TD.dueLabel({ date: "2026-11-10" }, NOW), "Tue 10 Nov", "overdue reads as the date")
  assert.equal(TD.dueLabel({ date: "garbage" }, NOW), "")
})

test("due buckets group the list", () => {
  assert.equal(TD.dueBucket(null, NOW), "none")
  assert.equal(TD.dueBucket({ date: "2026-11-10" }, NOW), "overdue")
  assert.equal(TD.dueBucket({ date: "2026-11-12" }, NOW), "today")
  assert.equal(TD.dueBucket({ date: "2026-11-20" }, NOW), "upcoming")
})

test("filtering matches content and labels", () => {
  const tasks = [
    task({ id: "1", content: "Buy milk", labels: ["errands"] }),
    task({ id: "2", content: "Write report", labels: ["work"] }),
    task({ id: "3", content: "Milk the report", labels: [] })
  ]
  assert.deepEqual(TD.filterTasks(tasks, "").map(function(t) { return t.id }), ["1", "2", "3"])
  assert.deepEqual(TD.filterTasks(tasks, "milk").map(function(t) { return t.id }), ["1", "3"])
  assert.deepEqual(TD.filterTasks(tasks, "work").map(function(t) { return t.id }), ["2"])
  assert.deepEqual(TD.filterTasks(tasks, "milk errands").map(function(t) { return t.id }), ["1"])
  assert.deepEqual(TD.filterTasks(tasks, "zzz"), [])
})

test("grouping orders overdue, today, upcoming, none and drops empties", () => {
  const groups = TD.groupTasks([
    task({ id: "n", content: "someday", due: null }),
    task({ id: "u", content: "later", due: { date: "2026-11-20" } }),
    task({ id: "o", content: "late", due: { date: "2026-11-10" } }),
    task({ id: "t", content: "now", due: { date: "2026-11-12" } })
  ], NOW)
  assert.deepEqual(groups.map(function(g) { return g.id }), ["todoist-overdue", "todoist-today", "todoist-upcoming", "todoist-none"])
  assert.equal(groups[0].tasks[0].id, "todoist:o")
  assert.deepEqual(TD.groupTasks([], NOW), [])
  assert.deepEqual(TD.groupTasks([{ content: "no id" }], NOW), [], "id-less rows never surface")
})

test("task rows carry p-labels, due labels and the todoist: namespace", () => {
  const row = TD.taskRow(task({ id: "abc", content: "Ship it", priority: 4, due: { date: "2026-11-12" }, labels: ["work"] }), NOW)
  assert.equal(row.id, "todoist:abc")
  assert.equal(row.kind, "todoist-task")
  assert.equal(row.title, "Ship it")
  assert.equal(row.subtitle, "Today")
  assert.equal(row.typeLabel, "p1")
  assert.equal(row.glyph, "")
  const plain = TD.taskRow(task({ id: "x" }), NOW)
  assert.equal(plain.typeLabel, "", "p4 shows no badge")
  assert.equal(plain.subtitle, "")
})

test("text validation mirrors the launcher guards", () => {
  assert.equal(TD.validateText(""), "Type a task first")
  assert.equal(TD.validateText("   "), "Type a task first")
  assert.equal(TD.validateText("buy milk tomorrow #Shopping p1"), null, "quick-add syntax passes through verbatim")
  assert.match(TD.validateText("x".repeat(501)), /under/)
  assert.match(TD.validateText("a\x00b"), /NUL/)
  assert.equal(TD.previewTitle("  buy   milk  "), "buy milk")
  assert.ok(TD.previewTitle("x".repeat(100)).length <= 60)
})

test("builtins push the two views", () => {
  const list = RS.BUILTINS.find(function(b) { return b.id === "builtin:todoist" })
  const add = RS.BUILTINS.find(function(b) { return b.id === "builtin:todoist-add" })
  assert.ok(list && add, "both builtins exist")
  assert.equal(list.run.push.kind, "todoist")
  assert.equal(add.run.push.kind, "todoist-add")
  assert.equal(list.platform, undefined, "cross-platform: no platform field")
  assert.ok(list.keywords.indexOf("task") >= 0 && add.keywords.indexOf("add task") >= 0)
})

test("the add view shows one live row while the query is non-empty", () => {
  assert.deepEqual(RS.todoistAddSections("", "x"), [])
  assert.deepEqual(RS.todoistAddSections("   ", "x"), [])
  const sections = RS.todoistAddSections("buy milk", "buy milk")
  assert.equal(sections.length, 1)
  const row = sections[0].rows[0].candidate
  assert.equal(row.id, RS.TODO_ADD_ID)
  assert.equal(row.kind, "todoist-add")
  assert.equal(row.title, "buy milk")
  assert.equal(row.subtitle, "Todoist")
})

test("task sections filter and group through the injected core", () => {
  const tasks = [
    task({ id: "1", content: "Buy milk", due: { date: "2026-11-12" } }),
    task({ id: "2", content: "Write report", due: null })
  ]
  assert.deepEqual(RS.todoistSections(tasks, "", NOW, TD).map(function(s) { return s.id }), ["todoist-today", "todoist-none"])
  assert.deepEqual(RS.todoistSections(tasks, "milk", NOW, TD).map(function(s) { return s.id }), ["todoist-today"])
  assert.deepEqual(RS.todoistSections(tasks, "zzz", NOW, TD), [])
})

test("task actions are complete / delete / copy on ↵ slots", () => {
  const ids = RS.actionsFor({ kind: "todoist-task" }).map(function(a) { return a.id })
  assert.deepEqual(ids, ["complete", "delete", "copy"])
  const shortcuts = RS.actionsFor({ kind: "todoist-task" }).map(function(a) { return a.shortcut })
  assert.deepEqual(shortcuts, ["↵", "Ctrl ↵", "Ctrl Shift ↵"])
  assert.deepEqual(RS.actionsFor({ kind: "todoist-add" }).map(function(a) { return a.id }), ["open"])
})

test("delete confirms with the task named; other rows are untouched", () => {
  const spec = RS.confirmationFor("todoist:6XGgmFVcrG5RRjVr", "delete", "Buy milk")
  assert.equal(spec.title, "Delete Task")
  assert.match(spec.message, /Buy milk/)
  assert.equal(spec.primary, "Delete")
  assert.equal(spec.destructive, true)
  const anon = RS.confirmationFor("todoist:x", "delete", "")
  assert.match(anon.message, /There is no undo/)
  assert.equal(RS.confirmationFor("todoist:x", "open"), null, "complete needs no confirm")
  assert.equal(RS.confirmationFor("todoist:x", "complete"), null, "advertised complete id needs no confirm either")
  assert.equal(RS.confirmationFor("todoist:x", "copy"), null)
  assert.equal(RS.confirmationFor("builtin:shutdown", "open").primary, "Shut Down", "exact-id rules still work")
})

test("the about panel describes a task", () => {
  const row = TD.taskRow(task({ id: "abc", content: "Ship it", priority: 4, due: { date: "2026-11-12" }, labels: ["work"] }), NOW)
  const about = Object.fromEntries(RS.aboutFor(row, NOW).map(function(r) { return [r.label, r.value] }))
  assert.equal(about.Task, "Ship it")
  assert.equal(about.Due, "Today")
  assert.equal(about.Priority, "p1")
  assert.equal(about.Labels, "work")
  assert.equal(about.ID, "abc")
})

test("the add form carries every editor field", () => {
  const form = TD.addFormDefinition()
  assert.equal(form.kind, "Form")
  assert.deepEqual(form.items.map(function(i) { return i.id }),
    ["description", "priority", "dueDate", "scheduledDate", "recurrence", "tags"])
  assert.deepEqual(form.items.map(function(i) { return i.kind }),
    ["TextField", "Dropdown", "DatePicker", "DatePicker", "TextField", "TagPicker"])
  assert.deepEqual(TD.addFormInitial(),
    { description: "", priority: "1", dueDate: null, scheduledDate: null, recurrence: "", tags: [] })
})

test("structured creates map to the POST /tasks body", () => {
  const full = TD.createTaskBody({
    description: "  Buy bread ", priority: "4",
    dueDate: "2026-11-20", scheduledDate: "2026-11-21",
    recurrence: "", tags: ["shopping", " shopping "]
  })
  assert.deepEqual(full.body, {
    content: "Buy bread", priority: 4, labels: ["shopping"],
    due_date: "2026-11-20", deadline_date: "2026-11-21"
  })
  const rec = TD.createTaskBody({ description: "Standup", recurrence: "every day", dueDate: "2026-11-20" })
  assert.equal(rec.body.due_string, "every day", "recurrence wins over Due Date")
  assert.ok(!("due_date" in rec.body))
  const bare = TD.createTaskBody({ description: "x" })
  assert.deepEqual(bare.body, { content: "x", priority: 1 })
  assert.equal(TD.createTaskBody({ description: "   " }).error, "Type a description first")
  assert.equal(TD.createTaskBody({ description: "x", dueDate: "Nov 20" }).error, "Due Date must be YYYY-MM-DD")
  assert.equal(TD.createTaskBody({ description: "x", scheduledDate: "2026-02-30" }).error, "Scheduled Date must be YYYY-MM-DD")
  assert.equal(TD.normalizeDate("2026-02-29"), false, "2026 is not a leap year")
  assert.equal(TD.normalizeDate("2024-02-29"), "2024-02-29")
  assert.deepEqual(TD.parseTags("a, b,,a"), ["a", "b"])
})
