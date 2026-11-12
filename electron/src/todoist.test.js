// Todoist v1 client against a stubbed https transport: request shapes,
// response parsing, revision bumps and the friendly error mapping.
const test = require("node:test")
const assert = require("node:assert")
const { createTodoist } = require("./todoist")

function task(overrides) {
  return Object.assign({
    id: "1", content: "Buy milk", description: "",
    project_id: "p1", section_id: null, labels: [],
    priority: 1, due: null, deadline: null
  }, overrides || {})
}

// Minimal https.request double: routes "METHOD /api/v1/..." to a canned
// {status, json}; records method/path/headers/body for shape assertions.
function stubTransport(routes) {
  const calls = []
  function requestFn(options, onResponse) {
    const key = options.method + " " + options.path
    const call = { options: options, key: key, body: "" }
    calls.push(call)
    const listeners = { error: [], timeout: [] }
    const req = {
      on: function(ev, cb) { listeners[ev].push(cb); return req },
      write: function(chunk) { call.body += chunk },
      destroy: function() {},
      end: function() {
        const route = routes[key] || routes["*"]
        if (!route) throw new Error("unexpected request " + key)
        const res = {
          statusCode: route.status,
          on: function(ev, cb) {
            if (ev === "data" && route.json !== undefined) cb(JSON.stringify(route.json))
            if (ev === "end") cb()
            return res
          }
        }
        onResponse(res)
      }
    }
    return req
  }
  return { requestFn: requestFn, calls: calls }
}

const LIST = { results: [task({ id: "1" }), task({ id: "2", content: "Ship it", priority: 4 })], next_cursor: null }

test("refresh lists tasks and bumps the revision", async () => {
  const t = stubTransport({ "GET /api/v1/tasks?limit=200": { status: 200, json: LIST } })
  const api = createTodoist({ requestFn: t.requestFn, token: "sekret" })
  let changed = 0
  api.on("changed", function() { changed++ })
  assert.equal(api.loading, false)
  const tasks = await api.refresh()
  assert.equal(tasks.length, 2)
  assert.equal(api.tasks[0].content, "Buy milk")
  assert.equal(api.revision, 1)
  assert.ok(changed >= 2, "loading flip + results both notify")
  assert.equal(api.loading, false)
  assert.equal(t.calls[0].options.headers.Authorization, "Bearer sekret")
})

test("create uses quick-add so the server parses dates and priorities", async () => {
  const routes = {
    "POST /api/v1/tasks/quick": { status: 200, json: task({ id: "9", content: "buy milk tomorrow p1" }) },
    "GET /api/v1/tasks?limit=200": { status: 200, json: LIST }
  }
  const t = stubTransport(routes)
  const api = createTodoist({ requestFn: t.requestFn, token: "sekret" })
  await api.createTask("buy milk tomorrow #Shopping p1")
  assert.equal(t.calls[0].key, "POST /api/v1/tasks/quick")
  const body = JSON.parse(t.calls[0].body)
  assert.equal(body.text, "buy milk tomorrow #Shopping p1", "user text passes through verbatim")
  assert.equal(body.meta, true)
  assert.ok(!("priority" in body), "no numeric priority is ever sent")
  assert.equal(t.calls[1].key, "GET /api/v1/tasks?limit=200", "mutations re-sync afterwards")
})

test("complete and delete hit the task endpoints, then re-sync", async () => {
  const routes = {
    "POST /api/v1/tasks/abc/close": { status: 200, json: undefined },
    "DELETE /api/v1/tasks/def": { status: 200, json: undefined },
    "GET /api/v1/tasks?limit=200": { status: 200, json: LIST }
  }
  const t = stubTransport(routes)
  const api = createTodoist({ requestFn: t.requestFn, token: "sekret" })
  await api.completeTask("abc")
  await api.deleteTask("def")
  const keys = t.calls.map(function(c) { return c.key })
  assert.deepEqual(keys, [
    "POST /api/v1/tasks/abc/close",
    "GET /api/v1/tasks?limit=200",
    "DELETE /api/v1/tasks/def",
    "GET /api/v1/tasks?limit=200"
  ])
})

test("a 401 names the token; other codes stay actionable", async () => {
  const api = createTodoist({
    requestFn: stubTransport({ "*": { status: 401, json: { error: "Unauthorized", http_code: 401 } } }).requestFn,
    token: "bad"
  })
  await assert.rejects(api.refresh(), /Invalid Todoist token/)
  const gone = createTodoist({
    requestFn: stubTransport({ "*": { status: 404, json: { error: "Not found" } } }).requestFn,
    token: "sekret"
  })
  await assert.rejects(gone.deleteTask("x"), /already be gone/)
  const limited = createTodoist({
    requestFn: stubTransport({ "*": { status: 429, json: {} } }).requestFn,
    token: "sekret"
  })
  await assert.rejects(limited.refresh(), /rate limit/)
})

test("a 404 on mutation still refreshes so the list self-heals", async () => {
  const routes = {
    "POST /api/v1/tasks/gone/close": { status: 404, json: { error: "Not found" } },
    "GET /api/v1/tasks?limit=200": { status: 200, json: LIST }
  }
  const t = stubTransport(routes)
  const api = createTodoist({ requestFn: t.requestFn, token: "sekret" })
  await assert.rejects(api.completeTask("gone"), /already be gone/)
  assert.ok(t.calls.some(function(c) { return c.key === "GET /api/v1/tasks?limit=200" }), "refresh ran despite the failure")
})

test("empty text and a missing token fail before any request", async () => {
  const t = stubTransport({})
  const api = createTodoist({ requestFn: t.requestFn, token: "sekret" })
  await assert.rejects(api.createTask("   "), /Type a task first/)
  assert.equal(t.calls.length, 0, "validation runs before the network")
  const noToken = createTodoist({ requestFn: t.requestFn, token: "" })
  await assert.rejects(noToken.refresh(), /TODOIST_TOKEN/)
  assert.equal(t.calls.length, 0)
})
