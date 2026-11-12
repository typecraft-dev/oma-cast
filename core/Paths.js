
var APP = "omacast"
// The name before 2026-11-01. Its directories move to APP on first start. [D]
var LEGACY_APP = "oma-cast"

function xdg(env, name, homeFallback) {
  var value = String(env(name) || "")
  if (value.charAt(0) === "/") return value.replace(/\/+$/, "")
  return homeFallback
}

function resolve(env, platform) {
  var home = String(env("HOME") || "").replace(/\/+$/, "")
  if (!home) throw new Error("HOME is not set")
  if (platform === "darwin") return resolveDarwin(home)
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

// macOS keeps everything under ~/Library (MACOS.md "Storage") [D]. The
// layout below the base dirs matches Linux, so db/*.json files can be copied
// between machines.
function resolveDarwin(home) {
  var support = home + "/Library/Application Support/" + APP
  var state = support + "/state"
  return {
    home: home,
    config: support,
    configFile: support + "/config.json",
    scriptCommands: support + "/script-commands",
    data: support,
    db: support + "/db",
    extensions: support + "/extensions",
    extensionSupport: support + "/extension-support",
    clipboard: support + "/clipboard",
    notesAttachments: support + "/notes/attachments",
    cache: home + "/Library/Caches/" + APP,
    state: state,
    logs: home + "/Library/Logs/" + APP,
    backups: state + "/backups",
    runtime: support + "/run"
  }
}

// [from, to] pairs for the base directories still under LEGACY_APP.
function legacyMoves(paths) {
  var suffix = "/" + APP
  return [paths.config, paths.data, paths.cache, paths.state].map(function(dir) {
    return [dir.slice(0, -suffix.length) + "/" + LEGACY_APP, dir]
  })
}

function directoriesToCreate(paths) {
  return [paths.config, paths.db, paths.cache, paths.logs, paths.backups, paths.runtime]
}

// Histories and settings are private: other local users must not read them.
// Every base dir is made owner-only; config, data and state are repaired
// recursively (the cache holds only rates and a cargo build, so its 0700 root
// is enough). Store files are created 0600 before the first write, because
// atomic saves keep an existing file's mode but give a new one 0666 & umask.
function privateRoots(paths) {
  return [paths.config, paths.data, paths.cache, paths.state, paths.runtime]
}

function privateTrees(paths) {
  return [paths.config, paths.data, paths.state]
}

// argv after the script name: legacy [from, to] pairs, --, dirs to create, --,
// private roots, --, private trees, --, files to create. chmod go-rwx only
// ever removes access, so a stricter existing mode stays as it is.
var SETUP_SCRIPT = [
  'umask 077',
  'while [[ $1 != -- ]]; do [[ -d $1 && ! -e $2 ]] && mv -T -- "$1" "$2"; shift 2; done; shift',
  'dirs=(); while [[ $1 != -- ]]; do dirs+=("$1"); shift; done; shift',
  'roots=(); while [[ $1 != -- ]]; do roots+=("$1"); shift; done; shift',
  'trees=(); while [[ $1 != -- ]]; do trees+=("$1"); shift; done; shift',
  'mkdir -p -- "${dirs[@]}" || exit',
  'status=0',
  'chmod go-rwx -- "${roots[@]}" || status=1',
  'find "${trees[@]}" -xdev ! -type l -perm /077 -exec chmod go-rwx -- {} + || status=1',
  'for file; do [[ -e $file || -L $file ]] || : >"$file" || status=1; done',
  'exit $status'
].join("\n")

function setupArgv(paths, files) {
  return ["bash", "-c", SETUP_SCRIPT, "omacast-setup"]
    .concat([].concat.apply([], legacyMoves(paths)), ["--"], directoriesToCreate(paths), ["--"],
      privateRoots(paths), ["--"], privateTrees(paths), ["--"], files)
}

if (typeof module !== "undefined") {
  module.exports = {
    APP: APP, LEGACY_APP: LEGACY_APP, resolve: resolve, legacyMoves: legacyMoves, directoriesToCreate: directoriesToCreate,
    privateRoots: privateRoots, privateTrees: privateTrees, SETUP_SCRIPT: SETUP_SCRIPT, setupArgv: setupArgv
  }
}
