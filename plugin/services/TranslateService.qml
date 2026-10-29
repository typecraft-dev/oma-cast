import QtQuick
import Quickshell.Io

// Runs translate-shell (trans) and returns its stdout. One translation runs
// at a time. Detections are serialized so a late result cannot replace a
// newer one.
Item {
  id: service

  property bool running: false
  property var job: null
  property string output: ""
  property string errors: ""

  property var detectJob: null
  property var detectPending: null
  property string detectOutput: ""

  signal finished(string text)
  signal failed(string message)
  signal detected(string code, string text)

  function start(text, target, source) {
    if (service.running) {
      service.failed("A translation is already running")
      return
    }
    service.job = { text: text, target: target, source: String(source || "") }
    service.output = ""
    service.errors = ""
    service.running = true
    translateProcess.running = true
  }

  function cancel() {
    service.running = false
    service.job = null
    service.output = ""
    service.errors = ""
    translateProcess.running = false
    service.detectPending = null
    if (detectProcess.running) {
      service.detectJob = null
      detectProcess.running = false
    }
  }

  function detect(text) {
    var phrase = String(text || "").trim()
    if (!phrase) return
    if (detectProcess.running) {
      service.detectPending = phrase
      return
    }
    service.startDetect(phrase)
  }

  function startDetect(text) {
    service.detectOutput = ""
    service.detectJob = { text: text }
    detectProcess.running = true
  }

  function detectedCode() {
    var lines = service.detectOutput.split("\n")
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim()
      if (line.indexOf("Code") === 0) {
        var parts = line.split(/\s+/)
        if (parts.length > 1) return parts[1]
      }
    }
    return ""
  }

  Process {
    id: detectProcess
    command: service.detectJob ? ["trans", "-id", "-no-ansi", "--", service.detectJob.text] : []
    stdout: SplitParser {
      onRead: function(line) { service.detectOutput += line + "\n" }
    }
    onExited: function(exitCode) {
      var current = service.detectJob
      service.detectJob = null
      var pending = service.detectPending
      service.detectPending = null
      if (current && exitCode === 0) {
        var code = service.detectedCode()
        service.detectOutput = ""
        if (code) service.detected(code, current.text)
      } else {
        service.detectOutput = ""
      }
      if (pending) service.startDetect(pending)
    }
  }

  Process {
    id: translateProcess
    command: service.job
      ? ["trans", "-b", "-no-ansi", "-show-original", "n", "-show-original-phonetics", "n", "-show-translation-phonetics", "n"]
        .concat(service.job.source ? ["-from", service.job.source] : [])
        .concat(["-to", service.job.target, "--", service.job.text])
      : []
    stdout: SplitParser {
      onRead: function(line) { service.output += line + "\n" }
    }
    stderr: SplitParser {
      onRead: function(line) { service.errors += line + "\n" }
    }
    onExited: function(exitCode) {
      var current = service.job
      service.running = false
      service.job = null
      if (!current) return
      if (exitCode !== 0) {
        service.failed(service.errors.trim() || "Translation failed with exit code " + exitCode)
        return
      }
      var translated = service.output.trim()
      if (!translated) {
        service.failed(service.errors.trim() || "Translation returned no text")
        return
      }
      service.finished(translated)
    }
  }
}
