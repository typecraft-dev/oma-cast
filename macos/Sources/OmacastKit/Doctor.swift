import AppKit
import ServiceManagement

/// `omacast doctor`: what works and how to fix what doesn't. Plain text.
@MainActor
enum Doctor {
  static func report(_ app: OmacastApp, latency: Bool) -> String {
    var lines: [String] = []
    func check(_ ok: Bool, _ name: String, _ detail: String) {
      lines.append((ok ? "✓ " : "✗ ") + name + (detail.isEmpty ? "" : ": " + detail))
    }
    let info = JSON.object(app.engine.call("system.info", ""))["data"] as? [String: Any] ?? [:]
    let paths = JSON.object(app.engine.call("system.getPaths", ""))["data"] as? [String: Any] ?? [:]
    lines.append("omacast \(info["version"] ?? "?") on macOS \(ProcessInfo.processInfo.operatingSystemVersionString)")
    lines.append("  app: \(Bundle.main.bundlePath)")

    check((info["ready"] as? Bool) == true, "data stores", (paths["db"] as? String) ?? "")
    let (hotkey, error) = app.hotkeyStatus
    check(!hotkey.isEmpty, "hotkey", hotkey.isEmpty ? error + " (set \"hotkey\" in config.json or the settings window)" : hotkey)
    check(!app.socketPath.isEmpty, "CLI socket", app.socketPath)
    check(((info["apps"] as? Int) ?? 0) > 0, "applications", "\(info["apps"] ?? 0) found, \(info["candidates"] ?? 0) commands in root search")
    check(Keystrokes.trusted, "Accessibility",
          Keystrokes.trusted ? "paste and Open New Window work"
            : "needed only to paste answers (⌘↵) and for Open New Window. Grant it in System Settings › Privacy & Security › Accessibility, then restart omacast")

    var privateOK = true
    for key in ["config", "db", "cache", "logs", "runtime"] {
      guard let dir = paths[key] as? String, let mode = permissions(dir) else { continue }
      if mode & 0o077 != 0 { privateOK = false; lines.append("  \(dir) is \(String(mode, radix: 8)), expected 700") }
    }
    if let db = paths["db"] as? String, let files = try? FileManager.default.contentsOfDirectory(atPath: db) {
      for file in files where file.hasSuffix(".json") {
        if let mode = permissions(db + "/" + file), mode & 0o077 != 0 { privateOK = false; lines.append("  \(file) is \(String(mode, radix: 8)), expected 600") }
      }
    }
    check(privateOK, "private files", privateOK ? "dirs 0700, stores 0600" : "chmod 600 the files listed above")

    let login = SMAppService.mainApp.status
    lines.append("  launch at login: \(login == .enabled ? "on" : "off") (settings window, ⌘, in the launcher)")
    if latency {
      for _ in 0..<5 {
        let r = app.measureLatency()
        lines.append(String(format: "  latency: show %.1f ms, hide %.1f ms%@", r.show, r.hide, r.key ? "" : " (panel not key!)"))
      }
    }
    return lines.joined(separator: "\n")
  }

  private static func permissions(_ path: String) -> Int? {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: path) else { return nil }
    return (attrs[.posixPermissions] as? NSNumber)?.intValue
  }
}
