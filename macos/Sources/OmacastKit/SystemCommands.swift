import AppKit
import Foundation

/// The `run.system` names from macos/js/MacCommands.js. Every command line here
/// is constant: no user text reaches argv.
enum SystemCommands {
  static func run(_ name: String) -> String {
    if name.hasPrefix("settings:") {
      let pane = String(name.dropFirst("settings:".count))
      return Launcher.openURL("x-apple.systempreferences:" + pane)
    }
    // After the launcher hides, so the command acts on the desktop.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { perform(name) }
    return known.contains(name) ? "" : "unknown system command \(name)"
  }

  static let known: Set<String> = [
    "lock", "sleep", "sleep-displays", "screensaver", "toggle-appearance", "empty-trash",
    "restart", "shutdown", "logout"
  ]

  private static func perform(_ name: String) {
    switch name {
    case "lock": lockScreen()
    case "sleep": exec("/usr/bin/pmset", ["sleepnow"])
    case "sleep-displays": exec("/usr/bin/pmset", ["displaysleepnow"])
    case "screensaver":
      _ = Launcher.openApp("/System/Library/CoreServices/ScreenSaverEngine.app")
    case "toggle-appearance":
      appleScript("tell application \"System Events\" to tell appearance preferences to set dark mode to not dark mode")
    case "empty-trash":
      appleScript("tell application \"Finder\" to empty trash")
    // The launcher already asked; these Apple Events act without asking again.
    case "restart": appleScript("tell application \"loginwindow\" to «event aevtrest»")
    case "shutdown": appleScript("tell application \"loginwindow\" to «event aevtshut»")
    case "logout": appleScript("tell application \"loginwindow\" to «event aevtrlgo»")
    default: break
    }
  }

  /// login.framework's SACLockScreenImmediate, what the menu bar's
  /// Lock Screen item calls. Falls back to sleeping the displays.
  private static func lockScreen() {
    typealias Lock = @convention(c) () -> Int32
    if let handle = dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login", RTLD_LAZY),
       let symbol = dlsym(handle, "SACLockScreenImmediate") {
      _ = unsafeBitCast(symbol, to: Lock.self)()
      return
    }
    exec("/usr/bin/pmset", ["displaysleepnow"])
  }

  private static func exec(_ path: String, _ args: [String]) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = args
    do { try process.run() } catch {
      Log.write("[omacast] [error] [system] \(path) failed: \(error.localizedDescription)")
    }
  }

  private static func appleScript(_ source: String) {
    var error: NSDictionary?
    NSAppleScript(source: source)?.executeAndReturnError(&error)
    if let error { Log.write("[omacast] [error] [system] AppleScript failed: \(error)") }
  }
}
