// The file indexer behind core/FileSearch (SPEC §8.6): a chunked,
// cancellable walk of the configured scopes with a disk cache. Excludes
// come from FileSearch.DEFAULT_EXCLUDE_DIRS; hidden files only when the
// config says so. Deviations from SPEC [D]: no inotify watcher (re-walk
// on a 10-minute staleness timer and at startup), no .gitignore parsing,
// a 100k-entry cap instead of a 500k SQLite/FTS index.
var fs = require("fs")
var path = require("path")
var childProcess = require("child_process")
var FileSearch = require("../../plugin/core/FileSearch.js")

var MAX_ENTRIES = 100000
var CACHE_VERSION = 1
var STALE_AFTER_MS = 10 * 60 * 1000

// Everything (voidtools) file search — the optional fileSearchProvider.
// Everything indexes every local drive in real time and its es.exe CLI
// answers a query in milliseconds, so the Files section goes system-wide
// without the home-dir walk. Needs Everything installed AND running (the
// service answers es.exe); otherwise searchEverything returns null and
// the built-in index stays the pool. No new dependency: one sync spawn of
// a millisecond-fast CLI, straight argv (no shell, no quoting games). [D]
var ES_RESULT_LIMIT = 100
var ES_DETECT_TTL_MS = 60000

// Where es.exe lives: beside Everything.exe in %ProgramFiles% (both
// bitnesses), else anywhere on PATH (choco/scoop installs). fakes
// injectable for tests (env/existsSync/runWhere). [D]
function findEsExe(opts) {
  opts = opts || {}
  var env = opts.env || function(k) { return process.env[k] }
  var exists = opts.existsSync || fs.existsSync
  var cands = []
  var pf = env("ProgramFiles")
  var pf86 = env("ProgramFiles(x86)")
  if (pf) cands.push(path.join(pf, "Everything", "es.exe"))
  if (pf86 && pf86 !== pf) cands.push(path.join(pf86, "Everything", "es.exe"))
  for (var i = 0; i < cands.length; i++) {
    try { if (exists(cands[i])) return cands[i] } catch (e) {}
  }
  try {
    var out = opts.runWhere
      ? opts.runWhere()
      : childProcess.execFileSync("where.exe", ["es.exe"], { encoding: "utf8", timeout: 3000, windowsHide: true })
    var lines = String(out || "").split(/\r?\n/)
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j].trim()
      if (!line) continue
      try { if (!exists(line)) continue } catch (e) {}
      return line
    }
  } catch (e) { /* not on PATH */ }
  return null
}

function createFileIndex(opts) {
  opts = opts || {}
  var roots = (opts.roots && opts.roots.length ? opts.roots : [opts.home]).filter(Boolean)
  var includeHidden = !!opts.includeHidden
  var provider = opts.provider === "everything" ? "everything" : "built-in"
  var execEs = opts.execEs || null     // test hook: function(esExe, args) -> stdout
  var esExeOpt = opts.esExe || null    // test hook: skip detection
  var esCache = { at: 0, path: undefined }
  var exclude = opts.exclude || FileSearch.DEFAULT_EXCLUDE_DIRS
  var cachePath = opts.cachePath || ""

  function everythingAvailable() {
    if (esExeOpt) return esExeOpt
    if (esCache.path !== undefined && Date.now() - esCache.at < ES_DETECT_TTL_MS) return esCache.path
    var found = findEsExe()
    esCache = { at: Date.now(), path: found }
    return found
  }
  function useEverything() { return provider === "everything" && !!everythingAvailable() }
  // One Everything query, shaped like walk entries (nl/pl included so the
  // shared ranker costs nothing). null = Everything is dead → caller falls
  // back to the walk pool. A per-file stat recovers the dir flag + mtime
  // for the glyph and the recency tier; an unstatable hit is kept anyway. [D]
  function searchEverything(query, limit) {
    var es = everythingAvailable()
    if (provider !== "everything" || !es) return null
    var q = String(query || "").trim()
    if (!q) return null
    var stdout
    try {
      stdout = execEs
        ? execEs(es, ["-n", String(limit || ES_RESULT_LIMIT), q])
        : childProcess.execFileSync(es, ["-n", String(limit || ES_RESULT_LIMIT), q],
            { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
    } catch (e) { return null }
    var lines = String(stdout || "").replace(/^\uFEFF/, "").split(/\r?\n/)
    var out = []
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim()
      if (!line) continue
      var d = false, m = 0
      try { var st = fs.statSync(line); d = st.isDirectory(); m = st.mtimeMs } catch (e) {}
      out.push(withLower({ p: line, n: path.basename(line) || line, d: d, m: m }))
    }
    return out
  }

  var state = {
    entries: [],
    ready: false,
    loading: false,
    lastIndexedAt: 0,
    fromCache: false
  }
  var listeners = { changed: [] }
  var generation = 0

  function emit() { (listeners.changed || []).forEach(function(cb) { cb() }) }
  function shouldSkip(name) {
    // The root itself never passes through here (it enters the queue
    // directly), so every scope — including a user-set scope that happens
    // to sit inside AppData — gets the same excludes for its children.
    if (exclude.indexOf(name) >= 0) return true
    if (!includeHidden && FileSearch.isHidden(name)) return true
    return false
  }

  // Lowercased name/path for match(): computed once here (or backfilled
  // on cache load) so every keystroke doesn't re-lower 100k strings.
  // Stripped before writing — the disk format stays {p,n,d,m}. [D]
  function withLower(entry) {
    if (entry.nl === undefined) entry.nl = String(entry.n || "").toLowerCase()
    if (entry.pl === undefined) entry.pl = String(entry.p || "").toLowerCase()
    return entry
  }
  function loadCache() {
    if (!cachePath) return false
    try {
      var doc = JSON.parse(fs.readFileSync(cachePath, "utf8"))
      if (doc && doc.v === CACHE_VERSION && Array.isArray(doc.entries)) {
        for (var li = 0; li < doc.entries.length; li++) withLower(doc.entries[li])
        state.entries = doc.entries
        state.lastIndexedAt = Number(doc.at) || 0
        state.ready = true
        state.fromCache = true
        return true
      }
    } catch (e) { /* no cache yet */ }
    return false
  }

  function saveCache() {
    if (!cachePath) return
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true })
      var tmp = cachePath + ".tmp"
      // Strip the in-memory lowercased copies: disk stays {p,n,d,m} so an
      // old build can still read it and the file doesn't double in size.
      var slim = state.entries.map(function(e) { return { p: e.p, n: e.n, d: e.d, m: e.m } })
      fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, at: state.lastIndexedAt, entries: slim }))
      fs.renameSync(tmp, cachePath)
    } catch (e) { /* cache is best-effort */ }
  }

  // Iterative walk: no recursion depth limits, one stat per entry for the
  // recency sort, yields to the event loop every few hundred entries so the
  // launcher stays responsive while indexing. [D]
  function walk() {
    if (state.loading) return Promise.resolve()
    var token = ++generation
    state.loading = true
    var out = []
    var truncated = false
    var queue = roots.map(function(r) { return { dir: String(r), root: true } })

    function step() {
      if (token !== generation) { state.loading = false; return Promise.resolve() }
      // Small slices so typing stays responsive while indexing: each chunk
      // is a few ms of sync readdir/stat, then the event loop (and input
      // events) get a turn before the next slice. [D]
      var budget = 120          // entries processed before yielding
      while (queue.length > 0 && budget > 0) {
        var job = queue.shift()
        var dir = job.dir
        var list
        try { list = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { continue }
        for (var i = 0; i < list.length; i++) {
          var dirent = list[i]
          var name = dirent.name
          var full = path.join(dir, name)
          if (dirent.isSymbolicLink()) continue            // no cycles [D]
          if (shouldSkip(name)) continue
          if (dirent.isDirectory()) {
            queue.push({ dir: full, root: false })
          } else if (dirent.isFile()) {
            var m = 0
            try { m = fs.statSync(full).mtimeMs } catch (e) { continue }
            out.push(withLower({ p: full, n: name, d: false, m: m }))
          } else continue
          if (out.length >= MAX_ENTRIES) { truncated = true; queue.length = 0; break }
          if (--budget <= 0) break
        }
        if (budget <= 0 && queue.length > 0) break
      }
      if (queue.length > 0) {
        // setTimeout(0), not setImmediate: input/render tasks queued behind
        // a setImmediate chain can starve while indexing; a timer yields to
        // them between slices. [D]
        return new Promise(function(resolve) { setTimeout(resolve, 0) }).then(step)
      }
      return null
    }

    return Promise.resolve().then(step).then(function() {
      if (token !== generation) return
      // Folders get an entry too (SPEC searches folders); their mtime comes
      // from the parent-walk stat of the dir itself.
      var dirs = []
      var seen = {}
      var dirSet = {}
      for (var q = 0; q < roots.length; q++) dirSet[roots[q]] = true
      // Collect visited directory paths cheaply from file paths.
      for (var i = 0; i < out.length; i++) {
        var parent = FileSearch.parentOf(out[i].p)
        while (parent && !dirSet[parent] && !seen[parent]) {
          seen[parent] = true
          var nm = parent.slice(parent.lastIndexOf("/") >= 0 ? parent.lastIndexOf("/") + 1 : 0) || parent
          dirs.push(withLower({ p: parent, n: path.basename(parent), d: true, m: 0 }))
          var up = FileSearch.parentOf(parent)
          if (up === parent) break
          parent = up
        }
      }
      state.entries = dirs.concat(out)
      state.lastIndexedAt = Date.now()
      state.ready = true
      state.fromCache = false
      state.loading = false
      saveCache()
      emit()
      if (truncated && opts.log) opts.log("warning", "file index hit the " + MAX_ENTRIES + "-entry cap")
    }, function(err) {
      state.loading = false
      if (opts.log) opts.log("error", "file index failed: " + err)
      emit()
    })
  }

  function refreshIfStale(force) {
    if (state.loading) return
    if (useEverything()) return      // Everything answers live; the walk stays parked
    if (force || Date.now() - state.lastIndexedAt > STALE_AFTER_MS) walk()
  }

  return {
    get entries() { return state.entries },
    get ready() { return state.ready },
    get loading() { return state.loading },
    get lastIndexedAt() { return state.lastIndexedAt },
    get provider() { return provider },
    roots: roots,
    start: function() {
      if (useEverything()) {
        // No walk: Everything answers live. The cache (possibly empty)
        // seeds the fallback pool; ready so the section works at once. [D]
        if (!state.ready) state.ready = true
        emit()
        return
      }
      // Launch must not parse a 16 MB cache (~200 ms) or open a disk
      // walk: load in the background, land via changed → rebuild. A
      // first-show files query before it lands simply shows no section. [D]
      setImmediate(function() {
        try {
          var fromCache = loadCache()
          if (!fromCache || Date.now() - state.lastIndexedAt > STALE_AFTER_MS) walk()
          else emit()
        } catch (e) {}
      })
    },
    refresh: function() { walk() },
    refreshIfStale: refreshIfStale,
    on: function(event, cb) { if (listeners[event]) listeners[event].push(cb) },
    setIncludeHidden: function(v) { includeHidden = !!v },
    setProvider: function(v) {
      provider = (v === "everything") ? "everything" : "built-in"
      if (useEverything()) {
        if (!state.ready) state.ready = true
        emit()
      } else refreshIfStale(false)     // back to the walk: re-walk when stale
    },
    everythingAvailable: everythingAvailable,
    searchEverything: searchEverything
  }
}

if (typeof module !== "undefined") {
  module.exports = { createFileIndex: createFileIndex, findEsExe: findEsExe, MAX_ENTRIES: MAX_ENTRIES, STALE_AFTER_MS: STALE_AFTER_MS }
}
