import AppKit
import ApplicationServices
import Carbon.HIToolbox

/// The clipboard, in process: text never reaches a command line.
enum Clipboard {
  static func copy(_ text: String) {
    let board = NSPasteboard.general
    board.clearContents()
    board.setString(text, forType: .string)
  }

  static func read() -> String {
    NSPasteboard.general.string(forType: .string) ?? ""
  }
}

/// Synthesized keystrokes into the frontmost app. They need the
/// Accessibility permission; `omacast doctor` explains how to grant it.
enum Keystrokes {
  static var trusted: Bool { AXIsProcessTrusted() }

  /// Asks macOS to show the Accessibility prompt (once per app identity).
  static func requestTrust() {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
  }

  /// ⌘ plus one key (V to paste, N for a new window).
  @discardableResult
  static func command(_ keyCode: Int) -> Bool {
    guard trusted else { return false }
    let source = CGEventSource(stateID: .combinedSessionState)
    let down = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(keyCode), keyDown: true)
    let up = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(keyCode), keyDown: false)
    down?.flags = .maskCommand
    up?.flags = .maskCommand
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
    return true
  }

  /// Runs `body` once ⌘, ⌥, ⌃ and ⇧ are up (at most 1 s), so a ⌘↵ that
  /// asked for a paste doesn't turn ⌘V into ⌘⌥V.
  static func afterModifiersRelease(_ body: @escaping @MainActor () -> Void, waited: Int = 0) {
    let held = CGEventSource.flagsState(.combinedSessionState).intersection([.maskCommand, .maskAlternate, .maskControl, .maskShift])
    if held.isEmpty || waited >= 50 { MainActor.assumeIsolated { body() }; return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { afterModifiersRelease(body, waited: waited + 1) }
  }

  static let keyV = kVK_ANSI_V
  static let keyN = kVK_ANSI_N
}

/// Opening apps and URLs through LaunchServices.
enum Launcher {
  static func openURL(_ string: String) -> String {
    guard let url = URL(string: string) else { return "not a URL" }
    return NSWorkspace.shared.open(url) ? "" : "no app opens it"
  }

  /// Like a Dock click: an open app comes forward with its last window (and
  /// un-minimizes or reopens one if it has none showing); a closed app launches.
  static func openApp(_ path: String) -> String {
    let url = URL(fileURLWithPath: path)
    guard FileManager.default.fileExists(atPath: path) else { return "\(path) is gone" }
    let config = NSWorkspace.OpenConfiguration()
    config.activates = true
    NSWorkspace.shared.openApplication(at: url, configuration: config) { _, error in
      if let error { Log.write("[omacast] [error] [apps] opening \(url.lastPathComponent) failed: \(error.localizedDescription)") }
    }
    return ""
  }

  /// Shift+↵ "Open New Window" [D]: macOS has no generic new-window call, so
  /// a running app is brought forward and sent ⌘N. Without Accessibility it
  /// only comes forward.
  static func openNewWindow(_ path: String) -> String {
    let url = URL(fileURLWithPath: path)
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle(url: url)?.bundleIdentifier ?? "")
    if running.isEmpty { return openApp(path) }
    let error = openApp(path)
    if !error.isEmpty { return error }
    if !Keystrokes.trusted { return "" }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
      if NSWorkspace.shared.frontmostApplication?.bundleURL?.standardizedFileURL == url.standardizedFileURL {
        Keystrokes.command(Keystrokes.keyN)
      }
    }
    return ""
  }
}
