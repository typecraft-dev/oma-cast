
function createRegistry() {
  return {
    handlers: {},
    subscribers: {}
  }
}

function isMethodName(method) {
  return /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/.test(String(method || ""))
}

function register(registry, namespace, handlers) {
  var ns = String(namespace || "")
  if (!/^[A-Za-z][A-Za-z0-9.]*$/.test(ns)) throw new Error("Invalid namespace " + ns)
  for (var name in handlers) {
    if (typeof handlers[name] !== "function") continue
    var method = ns + "." + name
    if (registry.handlers[method]) throw new Error("Method already registered " + method)
    registry.handlers[method] = handlers[name]
  }
}

function unregister(registry, namespace) {
  var prefix = String(namespace || "") + "."
  for (var method in registry.handlers) {
    if (method.indexOf(prefix) === 0) delete registry.handlers[method]
  }
}

function methods(registry) {
  return Object.keys(registry.handlers).sort()
}

function errorMessage(error) {
  if (error && typeof error.message === "string") return error.message
  return String(error)
}

function isThenable(value) {
  return !!value && typeof value.then === "function"
}

function callSync(registry, method, data) {
  var handler = registry.handlers[String(method || "")]
  if (!handler) return { ok: false, error: "Unknown method " + method }
  try {
    var result = handler(data === undefined ? null : data)
    if (isThenable(result)) return { ok: true, pending: true }
    return { ok: true, data: result === undefined ? null : result }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

function call(registry, method, data) {
  var handler = registry.handlers[String(method || "")]
  if (!handler) return Promise.reject(new Error("Unknown method " + method))
  try {
    return Promise.resolve(handler(data === undefined ? null : data))
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)))
  }
}

function subscribe(registry, method, callback) {
  var key = String(method || "")
  var list = registry.subscribers[key] || []
  list = list.concat([callback])
  registry.subscribers[key] = list
  return function() {
    var current = registry.subscribers[key] || []
    registry.subscribers[key] = current.filter(function(cb) { return cb !== callback })
  }
}

function emit(registry, method, data, onError) {
  var list = registry.subscribers[String(method || "")] || []
  for (var i = 0; i < list.length; i++) {
    try {
      list[i](data)
    } catch (error) {
      if (onError) onError(method, error)
    }
  }
  return list.length
}

if (typeof module !== "undefined") {
  module.exports = {
    createRegistry: createRegistry,
    isMethodName: isMethodName,
    register: register,
    unregister: unregister,
    methods: methods,
    callSync: callSync,
    call: call,
    subscribe: subscribe,
    emit: emit
  }
}
