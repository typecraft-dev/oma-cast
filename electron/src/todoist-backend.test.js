// Todoist on the Electron backend with a stubbed service: views, the
// add/complete/delete/copy flows, the delete confirm naming the task,
// pending async pattern, and the no-token gate. Real fs layout, fake app
// entries and host adapters (the backend.test.js pattern).
const test = require("node:test")
const assert = require("node:assert")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { createBackend } = require("./backend")
const RootSearch = require("../../plugin/core/RootSearch.js")

function task(overrides) {
  return Object.assign({
    id: "1", content: "Buy milk", description: "",
    project_id: "p1", section_id: null, labels: [],
    priority: 1, due: null, deadline: null
  }, overrides || {})
}

// Same surface as electron/src/todoist.js, in-memory and synchronous-ish.
function stubTodoist(seed) {
  const tasks = seed.map(function(t) { return Object.assign({}, t) })
  let revision = 0
  const changedListeners = []
  function changed() { revision++; changedListeners.forEach(function(cb) { cb() }) }
  return {
    get tasks() { return tasks },
    get loading() { return false },
    get revision() { return revision },
    on: function(ev, cb) { if (ev === "changed") changedListeners.push(cb) },
    refresh: function() { changed(); return Promise.resolve(tasks) },
    createTask: function(text) {
      tasks.push(task({ id: "new-" + tasks.length, content: String(text).trim() }))
      changed()
      return Promise.resolve(tasks[tasks.length - 1])
    },
    completeTask: function(id) {
      const at = tasks.findIndex(function(t) { return t.id === id })
      if (at < 0) return Promise.reject(new Error("Task not found — it may already be gone"))
      tasks.splice(at, 1)
      changed()
      return Promise.resolve(null)
    },
    createStructured: function(body) {
      if (!body || !String(body.content || "").trim()) return Promise.reject(new Error("Type a description first"))
      tasks.push(task({ id: "new-" + tasks.length, content: String(body.content).trim() }))
      changed()
      return Promise.resolve(tasks[tasks.length - 1])
    },
    deleteTask: function(id) {
      const at = tasks.findIndex(function(t) { return t.id === id })
      if (at < 0) return Promise.reject(new Error("Task not found — it may already be gone"))
      tasks.splice(at, 1)
      changed()
      return Promise.resolve(null)
    }
  }
}

function setup(overrides) {
  overrides = overrides || {}
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oma-cast-todo-"))
  const paths = {
    home: root, config: path.join(root, "config"), configFile: path.join(root, "config", "config.json"),
    scriptCommands: path.join(root, "config", "script-commands"),
    data: path.join(root, "data"), db: path.join(root, "data", "db"),
    extensions: path.join(root, "data", "extensions"), extensionSupport: path.join(root, "data", "extension-support"),
    clipboard: path.join(root, "data", "clipboard"), notesAttachments: path.join(root, "data", "notes"),
    cache: path.join(root, "cache"), state: path.join(root, "state"),
    logs: path.join(root, "state", "logs"), backups: path.join(root, "state", "backups"),
    runtime: path.join(root, "runtime")
  }
  const calls = { copy: [] }
  const host = {
    copy: function(t) { calls.copy.push(t) },
    openExternal: function() {},
    pasteText: function() {},
    checkCommand: function(exe, cb) { cb(true) }
  }
  const apps = {
    entries: [{ id: "C:\\links\\Firefox.lnk", name: "Firefox", icon: "", keywords: [] }],
    loading: false,
    on: function() {},
    refresh: function() { return Promise.resolve(this.entries) },
    launch: function() {},
    iconSource: function() { return Promise.resolve("") }
  }
  // A dummy token by default so the service stub is reachable; the
  // no-token test passes config: {} explicitly. [D]
  const config = overrides.config === undefined ? { todoistToken: "test-token" } : overrides.config
  if (config) {
    fs.mkdirSync(paths.config, { recursive: true })
    fs.writeFileSync(paths.configFile, JSON.stringify(config))
  }
  // Dates relative to the real clock (the backend uses Date.now()).
  const today = new Date()
  const iso = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString().slice(0, 10)
  const service = overrides.todoist === null ? null : (overrides.todoist || stubTodoist([
    task({ id: "1", content: "Buy milk", due: { date: iso } }),
    task({ id: "2", content: "Ship it", priority: 4, labels: ["work"] })
  ]))
  const backend = createBackend({
    paths: paths, host: host, apps: apps, fileIndex: null,
    todoist: service
  }).start()
  const notes = []
  backend.onNotification(function(method, data) { notes.push([method, data]) })
  return { backend, calls, notes, service }
}

function tick() { return new Promise(function(r) { setTimeout(r, 20) }) }

test("Todoist commands rank at the root and push their views", () => {
  const { backend } = setup()
  const empty = backend.callSync("rootSearch.search", { query: "", view: null, filter: "all" })
  const commands = (empty.data.find(function(s) { return s.id === "commands" }) || { rows: [] }).rows
  assert.ok(commands.some(function(r) { return r.id === "builtin:todoist" }), "Todoist ranks")
  assert.ok(commands.some(function(r) { return r.id === "builtin:todoist-add" }), "Add Todoist Task ranks")
  backend.dispose()
})

test("the task view groups and filters the cached list", () => {
  const { backend } = setup()
  const r = backend.callSync("rootSearch.search", { query: "", view: { kind: "todoist", title: "Todoist" }, filter: "all" })
  assert.equal(r.ok, true)
  assert.deepEqual(r.data.map(function(s) { return s.id }), ["todoist-today", "todoist-none"])
  assert.equal(r.data[0].rows[0].title, "Buy milk")
  assert.equal(r.data[0].rows[0].typeLabel, "", "p4 shows no badge")
  const f = backend.callSync("rootSearch.search", { query: "ship", view: { kind: "todoist", title: "Todoist" }, filter: "all" })
  assert.equal(f.data.length, 1)
  assert.equal(f.data[0].rows[0].title, "Ship it")
  assert.equal(f.data[0].rows[0].typeLabel, "p1")
  const acts = backend.callSync("rootSearch.getActions", { id: "todoist:2" })
  assert.deepEqual(acts.data.map(function(a) { return a.id }), ["complete", "delete", "copy"])
  const info = backend.callSync("rootSearch.getItemInfo", { id: "todoist:2", query: "" })
  assert.ok(info.data.some(function(x) { return x.label === "Priority" && x.value === "p1" }))
  backend.dispose()
})

test("the add view renders no rows — the form owns it", () => {
  const { backend } = setup()
  const blank = backend.callSync("rootSearch.search", { query: "", view: { kind: "todoist-add", title: "Add Todoist Task" }, filter: "all" })
  assert.deepEqual(blank.data, [])
  const typed = backend.callSync("rootSearch.search", { query: "buy milk", view: { kind: "todoist-add", title: "Add Todoist Task" }, filter: "all" })
  assert.deepEqual(typed.data, [], "no live quick-add row anymore")
  backend.dispose()
})

test("submitting the form creates the structured task", async () => {
  const { backend, notes } = setup()
  const bad = backend.callSync("rootSearch.performAction",
    { id: RootSearch.TODO_ADD_ID, action: "submit", query: "", arguments: { description: "   " }, confirmed: true })
  assert.equal(bad.ok, false, "empty description is rejected")
  const r = backend.callSync("rootSearch.performAction", {
    id: RootSearch.TODO_ADD_ID, action: "submit", query: "", confirmed: true,
    arguments: { description: "Buy bread", priority: "4", dueDate: "2026-11-20", scheduledDate: "", recurrence: "", tags: ["shopping"] }
  })
  assert.deepEqual(r.data, { pending: true })
  await tick()
  assert.ok(notes.some(function(n) { return n[0] === "todoist.taskAdded" }), "success toast notification fired")
  assert.ok(backend.callSync("rootSearch.search", { query: "bread", view: { kind: "todoist", title: "Todoist" }, filter: "all" })
    .data.some(function(s) { return s.rows.some(function(row) { return row.title === "Buy bread" }) }), "new task cached")
  backend.dispose()
})

test("adding returns pending, then notifies and records frecency", async () => {
  const { backend, notes } = setup()
  const r = backend.callSync("rootSearch.performAction", { id: RootSearch.TODO_ADD_ID, action: "open", query: "buy milk tomorrow p1", confirmed: true })
  assert.equal(r.ok, true)
  assert.deepEqual(r.data, { pending: true })
  await tick()
  assert.ok(notes.some(function(n) { return n[0] === "todoist.taskAdded" }), "success toast notification fired")
  assert.ok(notes.some(function(n) { return n[0] === "todoist.tasksChanged" }), "list refresh fired")
  assert.ok(backend.callSync("rootSearch.search", { query: "milk", view: { kind: "todoist", title: "Todoist" }, filter: "all" })
    .data.some(function(s) { return s.rows.some(function(row) { return row.title === "buy milk tomorrow p1" }) }), "new task cached")
  const freq = backend.callSync("frecency.get", { id: "builtin:todoist-add" })
  assert.ok(freq.data && freq.data.anchor > 0, "the add command rises with use")
  backend.dispose()
})

test("complete removes the row and toasts", async () => {
  const { backend, notes } = setup()
  const r = backend.callSync("rootSearch.performAction", { id: "todoist:1", action: "complete", query: "", confirmed: true })
  assert.deepEqual(r.data, { pending: true })
  await tick()
  assert.ok(notes.some(function(n) { return n[0] === "todoist.taskCompleted" }))
  const after = backend.callSync("rootSearch.search", { query: "", view: { kind: "todoist", title: "Todoist" }, filter: "all" })
  assert.ok(!after.data.some(function(s) { return s.rows.some(function(row) { return row.id === "todoist:1" }) }), "completed task left the list")
  backend.dispose()
})

test("delete asks first with the task named, then deletes", async () => {
  const { backend, notes } = setup()
  const ask = backend.callSync("rootSearch.performAction", { id: "todoist:1", action: "delete", query: "" })
  assert.equal(ask.ok, true)
  assert.equal(ask.data.confirm.title, "Delete Task")
  assert.match(ask.data.confirm.message, /Buy milk/)
  assert.equal(ask.data.confirm.destructive, true)
  const go = backend.callSync("rootSearch.performAction", { id: "todoist:1", action: "delete", query: "", confirmed: true })
  assert.deepEqual(go.data, { pending: true })
  await tick()
  assert.ok(notes.some(function(n) { return n[0] === "todoist.taskDeleted" }))
  backend.dispose()
})

test("copy takes the title into the clipboard and closes", () => {
  const { backend, calls } = setup()
  const r = backend.callSync("rootSearch.performAction", { id: "todoist:2", action: "copy", query: "", confirmed: true })
  assert.equal(r.ok, true)
  assert.equal(r.data.close, true)
  assert.deepEqual(calls.copy, ["Ship it"])
  backend.dispose()
})

test("without a token the commands explain instead of pushing", () => {
  delete process.env.TODOIST_TOKEN
  const { backend } = setup({ todoist: null, config: {} })
  const push = backend.callSync("rootSearch.performAction", { id: "builtin:todoist", action: "open", query: "", confirmed: true })
  assert.equal(push.ok, true)
  assert.match(push.data.toast.title, /TODOIST_TOKEN/)
  const add = backend.callSync("rootSearch.performAction", { id: RootSearch.TODO_ADD_ID, action: "open", query: "x", confirmed: true })
  assert.equal(add.ok, false)
  assert.match(add.error, /TODOIST_TOKEN/)
  backend.dispose()
})

test("a failing request surfaces the API error, not a crash", async () => {
  const { backend, notes } = setup()
  const r = backend.callSync("rootSearch.performAction", { id: "todoist:gone", action: "open", query: "", confirmed: true })
  assert.deepEqual(r.data, { pending: true })
  await tick()
  const err = notes.filter(function(n) { return n[0] === "todoist.error" })
  assert.ok(err.length > 0, "failure notification fired")
  assert.match(err[0][1].message, /already be gone/)
  backend.dispose()
})
