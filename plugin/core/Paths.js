
var APP = "oma-cast"

function xdg(env, name, homeFallback) {
  var value = String(env(name) || "")
  if (value.charAt(0) === "/") return value.replace(/\/+$/, "")
  return homeFallback
}

function resolve(env) {
  var home = String(env("HOME") || "").replace(/\/+$/, "")
  if (!home) throw new Error("HOME is not set")
  var uid = String(env("UID") || "")
  var runtimeBase = xdg(env, "XDG_RUNTIME_DIR", uid ? "/run/user/" + uid : "/tmp")

  var config = xdg(env, "XDG_CONFIG_HOME", home + "/.config") + "/" + APP
  var data = xdg(env, "XDG_DATA_HOME", home + "/.local/share") + "/" + APP
  var cache = xdg(env, "XDG_CACHE_HOME", home + "/.cache") + "/" + APP
  var state = xdg(env, "XDG_STATE_HOME", home + "/.local/state") + "/" + APP

  return {
    home: home,
    config: config,
    configFile: config + "/config.json",
    scriptCommands: config + "/script-commands",
    data: data,
    db: data + "/db",
    extensions: data + "/extensions",
    extensionSupport: data + "/extension-support",
    clipboard: data + "/clipboard",
    notesAttachments: data + "/notes/attachments",
    cache: cache,
    state: state,
    logs: state + "/logs",
    backups: state + "/backups",
    runtime: runtimeBase + "/" + APP
  }
}

function directoriesToCreate(paths) {
  return [paths.config, paths.db, paths.cache, paths.logs, paths.backups, paths.runtime]
}

if (typeof module !== "undefined") {
  module.exports = { APP: APP, resolve: resolve, directoriesToCreate: directoriesToCreate }
}
