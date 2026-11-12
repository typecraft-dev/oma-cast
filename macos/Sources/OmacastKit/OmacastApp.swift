import AppKit
import SwiftUI

/// The app: owns the JS engine, the panel, the hotkey and the CLI socket.
@MainActor
public final class OmacastApp: NSObject, NSApplicationDelegate, NSWindowDelegate {
  public static func main() {
    let args = Array(CommandLine.arguments.dropFirst())
    if args.first == "--cli" { exit(cli(Array(args.dropFirst()))) }
    // One instance: a second launch shows the running one and quits before
    // touching any data.
    if SocketServer.isServing(socketPath) {
      _ = SocketServer.send(socketPath, fn: "show", args: [])
      exit(0)
    }
    let app = NSApplication.shared
    let delegate = OmacastApp()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { app.run() }
  }

  static private(set) weak var current: OmacastApp?

  /// Paths.js `runtime` for darwin, known before the engine starts.
  nonisolated static var socketPath: String {
    FileManager.default.homeDirectoryForCurrentUser.path + "/Library/Application Support/omacast/run/omacast.sock"
  }

  /// `omacast --cli <fn> [args…]`: one request to the running app.
  nonisolated static func cli(_ args: [String]) -> Int32 {
    guard let fn = args.first else {
      FileHandle.standardError.write(Data("usage: omacast --cli <fn> [args…]\n".utf8))
      return 2
    }
    guard let reply = SocketServer.send(socketPath, fn: fn, args: Array(args.dropFirst()), timeout: 30) else {
      FileHandle.standardError.write(Data("omacast is not running (no answer on \(socketPath))\n".utf8))
      return 1
    }
    FileHandle.standardOutput.write(Data((reply + "\n").utf8))
    return reply.hasPrefix(#"{"ok":false"#) ? 1 : 0
  }

  let native = Native()
  private(set) var engine: JSEngine!
  let model = LauncherModel()
  private var panel: LauncherPanel!
  private let hud = HUD()
  private var hotkey: Hotkey!
  private var socket: SocketServer?
  private let apps = AppIndex()
  private var renderScheduled = false
  private(set) var isOpen = false
  private var configText = ""

  public func applicationDidFinishLaunching(_ notification: Notification) {
    OmacastApp.current = self
    native.app = self
    do {
      engine = try JSEngine(native: native)
    } catch {
      Log.write("[omacast] [fatal] cannot start: \(error)")
      let alert = NSAlert()
      alert.messageText = "omacast cannot start"
      alert.informativeText = "\(error)"
      alert.runModal()
      NSApp.terminate(nil)
      return
    }
    model.engine = engine

    panel = LauncherPanel()
    panel.delegate = self
    let host = NSHostingView(rootView: LauncherView(model: model))
    host.sizingOptions = []
    panel.contentView = host
    panel.onKey = { [weak self] event in self?.handleKey(event) ?? false }

    hotkey = Hotkey { [weak self] in self?.toggle() }
    applyConfig()

    let server = SocketServer(path: OmacastApp.socketPath) { [weak self] fn, args in self?.handle(fn, args) ?? "" }
    do { try server.start(); socket = server } catch {
      Log.write("[omacast] [error] [socket] \(error.localizedDescription)")
    }

    apps.onChange = { [weak self] entries in
      guard let self, let data = try? JSONEncoder().encode(entries) else { return }
      self.engine.invoke("setApps", [String(data: data, encoding: .utf8)!])
    }
    apps.start()
    model.reload()
    Log.write("[omacast] [info] started; hotkey \(hotkey.spec?.display ?? "none") \(hotkey.error)")
  }

  public func applicationWillTerminate(_ notification: Notification) {
    engine?.invoke("flush")
    socket?.stop()
  }

  /// Hotkey from config.json `hotkey` (default alt+space).
  private func applyConfig() {
    let json = engine.string("config")
    guard json != configText else { return }
    configText = json
    let spec = JSON.object(json)["hotkey"] as? String ?? "alt+space"
    if !hotkey.register(spec) { Log.write("[omacast] [error] [hotkey] \(hotkey.error)") }
  }

  // MARK: window

  func toggle() { isOpen ? dismiss() : show() }

  func show() {
    let wasOpen = isOpen
    isOpen = true
    engine.invoke("shown", ["{}"])
    applyConfig()
    model.noteKeyboard()
    render()
    layout(reposition: !wasOpen)
    panel.makeKeyAndOrderFront(nil)
  }

  func dismiss() {
    guard isOpen else { return }
    isOpen = false
    panel.orderOut(nil)
    engine.invoke("hidden")
  }

  private func layout(reposition: Bool) {
    let z = CGFloat(model.state.zoom)
    let full = Metrics.height * z
    let height = model.state.compact ? Metrics.header * z : full
    panel.place(width: Metrics.width * z, height: height, fullHeight: full, reposition: reposition)
  }

  public func windowDidResignKey(_ notification: Notification) {
    guard isOpen, JSON.object(engine.string("config"))["keepVisibleOnFocusLoss"] as? Bool != true else { return }
    dismiss()
  }

  /// JS changed its state; draw once per run-loop turn.
  func changed() {
    if renderScheduled { return }
    renderScheduled = true
    DispatchQueue.main.async { [weak self] in
      MainActor.assumeIsolated {
        self?.renderScheduled = false
        self?.render()
      }
    }
  }

  private func render() {
    let before = (model.state.compact, model.state.zoom)
    model.reload()
    if isOpen, before != (model.state.compact, model.state.zoom) { layout(reposition: false) }
  }

  private func handleKey(_ event: NSEvent) -> Bool {
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    if flags == .command, event.charactersIgnoringModifiers == "," { dismiss(); SettingsWindow.shared.show(); return true }
    if flags == .command, event.charactersIgnoringModifiers == "w" { dismiss(); return true }
    return key(KeyEvents.json(event))
  }

  private func key(_ json: String) -> Bool {
    model.noteKeyboard()
    let handled = engine.invoke("key", [json])?.toBool() ?? false
    render()
    return handled
  }

  func hud(_ text: String) { hud.show(text) }

  /// The text is on the clipboard already; the panel never took focus from
  /// the app underneath, so ⌘V goes there once the keys from the shortcut
  /// that asked for it are released.
  func paste() {
    Keystrokes.afterModifiersRelease { [weak self] in
      if Keystrokes.command(Keystrokes.keyV) { return }
      Keystrokes.requestTrust()
      self?.hud.show("Copied. Allow omacast in Accessibility to paste")
    }
  }

  // MARK: CLI

  private func handle(_ fn: String, _ args: [String]) -> String {
    switch fn {
    case "ping": return "ok"
    case "toggle": toggle(); return isOpen ? "shown" : "hidden"
    case "show": show(); return "shown"
    case "hide": dismiss(); return "hidden"
    case "run": return engine.string("run", [args.first ?? ""])
    case "call": return engine.call(args.first ?? "", args.count > 1 ? args[1] : "")
    // Drive the launcher without synthesizing keystrokes (tests, scripting).
    case "key": return key(args.first ?? "{}") ? "true" : "false"
    case "state": return engine.string("state")
    case "settings": SettingsWindow.shared.show(); return "ok"
    case "doctor": return Doctor.report(self, latency: args.first == "latency")
    case "quit": DispatchQueue.main.async { NSApp.terminate(nil) }; return "ok"
    default: return #"{"ok":false,"error":"unknown function"}"#
    }
  }

  /// Show → panel on screen and key, then hide, in ms (MACOS.md M2: < 100 ms).
  func measureLatency() -> (show: Double, hide: Double, key: Bool) {
    if isOpen { dismiss() }
    let t0 = CACurrentMediaTime()
    show()
    panel.displayIfNeeded()
    let showMs = (CACurrentMediaTime() - t0) * 1000
    let key = panel.isKeyWindow
    let t1 = CACurrentMediaTime()
    dismiss()
    return (showMs, (CACurrentMediaTime() - t1) * 1000, key)
  }

  var hotkeyStatus: (String, String) { (hotkey.spec?.display ?? "", hotkey.error) }
  var socketPath: String { socket?.path ?? "" }
  func reloadHotkey() { configText = ""; applyConfig() }
}

/// JSON text from the engine as a dictionary, or empty.
enum JSON {
  static func object(_ text: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:]
  }
}
