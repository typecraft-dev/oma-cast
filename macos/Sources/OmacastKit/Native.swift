import AppKit
import Foundation
@preconcurrency import JavaScriptCore

/// The `native` object macos/js/App.js receives (its header lists every
/// primitive). Runs on the main thread, like the JSContext.
@MainActor
public final class Native {
  /// The window side; nil in tests, where those calls do nothing.
  weak var app: OmacastApp?
  public var environment: [String: String]
  private var timers: [Int: JSValue] = [:]
  private var nextTimer = 1

  public init(environment: [String: String] = ProcessInfo.processInfo.environment) {
    self.environment = environment
  }

  func install(in context: JSContext) -> JSValue {
    let object = JSValue(newObjectIn: context)!
    func set(_ name: String, _ block: Any) { object.setObject(block, forKeyedSubscript: name as NSString) }

    set("env", { [unowned self] (name: String) -> String in self.environment[name] ?? "" } as @convention(block) (String) -> String)
    set("readFile", { (path: String) -> Any in Files.read(path) ?? NSNull() } as @convention(block) (String) -> Any)
    set("writeFile", { (path: String, text: String) -> String in Files.writePrivate(path, text) } as @convention(block) (String, String) -> String)
    set("mtime", { (path: String) -> Double in Files.mtime(path) } as @convention(block) (String) -> Double)
    set("listDir", { (path: String) -> [String] in
      (try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []
    } as @convention(block) (String) -> [String])
    set("ensurePrivateDirs", { (dirs: JSValue) -> String in
      Files.ensurePrivateDirs((dirs.toArray() as? [String]) ?? [])
    } as @convention(block) (JSValue) -> String)
    set("log", { (line: String) in Log.write(line) } as @convention(block) (String) -> Void)

    set("copy", { (text: String) in Clipboard.copy(text) } as @convention(block) (String) -> Void)
    set("readClipboard", { () -> String in Clipboard.read() } as @convention(block) () -> String)
    set("paste", { [unowned self] (text: String) in
      Clipboard.copy(text)
      self.ui { $0.paste() }
    } as @convention(block) (String) -> Void)

    set("openUrl", { (url: String) -> String in Launcher.openURL(url) } as @convention(block) (String) -> String)
    set("openApp", { (path: String) -> String in Launcher.openApp(path) } as @convention(block) (String) -> String)
    set("launchNew", { (path: String) -> String in Launcher.openNewWindow(path) } as @convention(block) (String) -> String)
    set("runSystem", { (name: String) -> String in
      if name == "settings" { DispatchQueue.main.async { MainActor.assumeIsolated { SettingsWindow.shared.show() } }; return "" }
      return SystemCommands.run(name)
    } as @convention(block) (String) -> String)

    set("later", { [unowned self] (ms: Double, fn: JSValue) -> Int in self.later(ms, fn) } as @convention(block) (Double, JSValue) -> Int)
    set("cancel", { [unowned self] (id: Int) in self.timers[id] = nil } as @convention(block) (Int) -> Void)
    set("fetch", { (url: String, fn: JSValue) in Native.fetch(url, fn) } as @convention(block) (String, JSValue) -> Void)
    set("zoneOffsets", { (names: JSValue) -> [String: Int] in
      var out: [String: Int] = [:]
      let now = Date()
      for name in (names.toArray() as? [String]) ?? [] {
        if let zone = TimeZone(identifier: name) { out[name] = zone.secondsFromGMT(for: now) / 60 }
      }
      return out
    } as @convention(block) (JSValue) -> [String: Int])
    set("hour12", { () -> Bool in
      (DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: .current) ?? "").contains("a")
    } as @convention(block) () -> Bool)

    set("changed", { [unowned self] in self.ui { $0.changed() } } as @convention(block) () -> Void)
    set("dismiss", { [unowned self] in self.ui { $0.dismiss() } } as @convention(block) () -> Void)
    set("show", { [unowned self] in self.ui { $0.show() } } as @convention(block) () -> Void)
    set("hud", { [unowned self] (text: String) in self.ui { $0.hud(text) } } as @convention(block) (String) -> Void)
    set("quit", { NSApp.terminate(nil) } as @convention(block) () -> Void)
    return object
  }

  /// JavaScriptCore calls these blocks on the main thread, where the app lives.
  private func ui(_ body: @MainActor (OmacastApp) -> Void) {
    MainActor.assumeIsolated { if let app { body(app) } }
  }

  private func later(_ ms: Double, _ fn: JSValue) -> Int {
    let id = nextTimer
    nextTimer += 1
    timers[id] = fn
    DispatchQueue.main.asyncAfter(deadline: .now() + max(0, ms) / 1000) { [weak self] in
      guard let self, let fn = self.timers.removeValue(forKey: id) else { return }
      fn.call(withArguments: [])
    }
    return id
  }

  /// A plain GET (exchange rates); the callback runs on the main thread.
  private static func fetch(_ url: String, _ fn: JSValue) {
    guard let target = URL(string: url) else { fn.call(withArguments: [0, ""]); return }
    var request = URLRequest(url: target, timeoutInterval: 15)
    request.setValue("omacast", forHTTPHeaderField: "User-Agent")
    URLSession.shared.dataTask(with: request) { data, response, _ in
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      DispatchQueue.main.async { fn.call(withArguments: [status, body]) }
    }.resume()
  }
}
