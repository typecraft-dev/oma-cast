import QtQuick
import Quickshell.Io
import "../core/ScriptCommands.js" as ScriptCommands

// Script Commands (SPEC §9.9): scans the script folders, runs scripts and
// refreshes inline ones on their refreshTime.
Item {
  id: source

  property var directories: []
  property var scripts: []
  property var errors: []
  property var byId: ({})
  // Inline output per script id: {text, error}.
  property var inline: ({})
  property int foregroundRuns: 0
  property int revision: 0

  // runId → {id, scriptId, title, mode, path, args, argv, output, running,
  // exitCode, crashed, cancelled, foreground, startedAt, proc}
  property var runs: ({})
  property int runCounter: 0
  property var lastInlineRun: ({})
  property bool rescan: false
  property bool announce: false
  property string lastScan: ""

  readonly property int maxOutput: 512 * 1024          // [D] keeps the tail
  readonly property int maxRuns: 20
  readonly property int inlineTimeoutMs: 30000         // [D]

  signal message(string level, string text, var metadata)
  signal reloaded(int count, int errorCount)
  signal runOutput(string runId)
  signal runFinished(string runId, var result)
  signal created(bool ok, string path, string text)

  onDirectoriesChanged: source.scan(false)

  function scan(announce) {
    if (announce) source.announce = true
    if (source.directories.length === 0) return
    if (scanProc.running) { source.rescan = true; return }
    scanProc.collected = ""
    scanProc.command = ["bash", "-c", ScriptCommands.SCAN_SCRIPT, "oma-cast-scan"].concat(source.directories)
    scanProc.running = true
  }

  function applyScan(text) {
    var announce = source.announce
    source.announce = false
    if (text !== source.lastScan) {
      source.lastScan = text
      var loaded = ScriptCommands.load(ScriptCommands.parseScan(text))
      var ids = ({})
      for (var i = 0; i < loaded.scripts.length; i++) ids[loaded.scripts[i].id] = loaded.scripts[i]
      for (var e = 0; e < loaded.errors.length; e++) source.message("warning", "skipping script " + loaded.errors[e].path + ": " + loaded.errors[e].error, null)
      source.scripts = loaded.scripts
      source.errors = loaded.errors
      source.byId = ids
      var kept = ({})
      for (var id in source.inline) if (ids[id] && ids[id].mode === "inline") kept[id] = source.inline[id]
      source.inline = kept
      source.revision++
      source.refreshInline(true)
    }
    if (announce) source.reloaded(source.scripts.length, source.errors.length)
  }

  // Starts a script; returns the run id. args are positional values.
  function start(script, args, mode) {
    var id = "run-" + (++source.runCounter)
    var rec = {
      id: id, scriptId: script.id, title: script.title, mode: mode || script.mode, path: script.path,
      args: args, argv: ScriptCommands.runArgv(script, args), output: "", running: true, exitCode: null, crashed: false,
      cancelled: false, foreground: true, startedAt: Date.now(), proc: null
    }
    source.launch(rec)
    return id
  }

  function launch(rec) {
    source.runs[rec.id] = rec
    if (rec.foreground) source.foregroundRuns++
    if (rec.mode === "inline") source.lastInlineRun[rec.scriptId] = rec.startedAt
    var proc = runComponent.createObject(source, { runId: rec.id, command: rec.argv })
    rec.proc = proc
    proc.running = true
    source.prune()
  }

  function append(runId, line) {
    var rec = source.runs[runId]
    if (!rec) return
    rec.output += line + "\n"
    if (rec.output.length > source.maxOutput) {
      rec.output = rec.output.slice(rec.output.length - source.maxOutput)
      rec.truncated = true
    }
    rec.dirty = true
    if (!outputTimer.running) outputTimer.start()
  }

  function finish(runId, exitCode, exitStatus) {
    var rec = source.runs[runId]
    if (!rec || !rec.running) return
    rec.running = false
    rec.exitCode = exitCode
    rec.crashed = exitStatus !== 0
    rec.finishedAt = Date.now()
    rec.proc = null
    if (rec.foreground) source.foregroundRuns--
    var result = ScriptCommands.outcome(rec.mode, exitCode, rec.crashed, rec.output)
    if (rec.mode === "inline" && !rec.cancelled) {
      var next = Object.assign({}, source.inline)
      next[rec.scriptId] = result.ok ? { text: result.message } : { error: result.message }
      source.inline = next
      source.revision++
    }
    if (rec.foreground) {
      source.runOutput(runId)
      source.runFinished(runId, { runId: runId, title: rec.title, mode: rec.mode, ok: result.ok, cancelled: rec.cancelled, message: result.message })
    }
  }

  function cancel(runId) {
    var rec = source.runs[runId]
    if (!rec || !rec.running) return false
    rec.cancelled = true
    if (rec.proc) rec.proc.running = false
    return true
  }

  function run(runId) { return source.runs[runId] || null }

  // Drops the oldest finished runs past maxRuns.
  function prune() {
    var ids = Object.keys(source.runs)
    if (ids.length <= source.maxRuns) return
    var done = ids.filter(function(id) { return !source.runs[id].running })
      .sort(function(a, b) { return source.runs[a].startedAt - source.runs[b].startedAt })
    for (var i = 0; i < done.length && ids.length - i > source.maxRuns; i++) delete source.runs[done[i]]
  }

  // Background inline refreshes: every due inline script, one run each.
  function refreshInline(force) {
    var now = Date.now()
    for (var i = 0; i < source.scripts.length; i++) {
      var s = source.scripts[i]
      if (s.mode !== "inline") continue
      var busy = false
      for (var id in source.runs) {
        var r = source.runs[id]
        if (r.scriptId !== s.id || !r.running) continue
        busy = true
        if (now - r.startedAt > source.inlineTimeoutMs && !r.foreground) source.cancel(id)
      }
      if (busy) continue
      // A rescan also runs inline scripts that have no output yet.
      var last = source.lastInlineRun[s.id] || 0
      var due = !last || now - last >= s.refreshSeconds * 1000
      if (!due && !(force && !source.inline[s.id])) continue
      var rec = {
        id: "run-" + (++source.runCounter), scriptId: s.id, title: s.title, mode: "inline", path: s.path,
        argv: ScriptCommands.runArgv(s, []), output: "", running: true, exitCode: null, crashed: false,
        cancelled: false, foreground: false, startedAt: now, proc: null
      }
      source.launch(rec)
    }
  }

  function create(dir, title, mode) {
    if (createProc.running) throw new Error("Already creating a script")
    var text = ScriptCommands.template(title, mode)
    var path = dir + "/" + ScriptCommands.slug(title) + ".sh"
    createProc.path = path
    createProc.collected = ""
    createProc.command = ["bash", "-c", ScriptCommands.CREATE_SCRIPT, "oma-cast-create", dir, path, text]
    createProc.running = true
    return path
  }

  Component.onDestruction: {
    for (var id in source.runs) if (source.runs[id].proc) source.runs[id].proc.running = false
  }

  Component {
    id: runComponent
    Process {
      id: proc
      property string runId: ""
      stdout: SplitParser { onRead: function(line) { source.append(proc.runId, line) } }
      stderr: SplitParser { onRead: function(line) { source.append(proc.runId, line) } }
      onExited: function(exitCode, exitStatus) {
        source.finish(proc.runId, exitCode, exitStatus)
        proc.destroy()
      }
    }
  }

  // Streams output to an open output view at most every 100 ms.
  Timer {
    id: outputTimer
    interval: 100
    onTriggered: {
      for (var id in source.runs) {
        var rec = source.runs[id]
        if (!rec.dirty) continue
        rec.dirty = false
        if (rec.foreground) source.runOutput(id)
      }
    }
  }

  Timer {
    interval: 5000
    repeat: true
    running: source.scripts.some(function(s) { return s.mode === "inline" })
    onTriggered: source.refreshInline(false)
  }

  Process {
    id: scanProc
    property string collected: ""
    stdout: SplitParser { onRead: function(line) { scanProc.collected += line + "\n" } }
    onExited: function(exitCode, exitStatus) {
      if (exitCode === 0 && exitStatus === 0) source.applyScan(scanProc.collected)
      else source.message("error", "scanning script folders failed", { exitCode: exitCode })
      if (source.rescan) { source.rescan = false; source.scan(false) }
    }
  }

  Process {
    id: createProc
    property string path: ""
    property string collected: ""
    stdout: SplitParser { onRead: function(line) { createProc.collected += line + "\n" } }
    stderr: SplitParser { onRead: function(line) { createProc.collected += line + "\n" } }
    onExited: function(exitCode, exitStatus) {
      var ok = exitCode === 0 && exitStatus === 0
      if (ok) source.scan(false)
      source.created(ok, createProc.path, ok ? "" : (ScriptCommands.lastLine(createProc.collected) || "Could not create " + createProc.path))
    }
  }
}
