import AppKit
import ServiceManagement
import SwiftUI

/// The settings window (MACOS.md M5): hotkey, launch at login, the general
/// settings in settings.json, and disabled commands to switch back on.
@MainActor
final class SettingsWindow {
  static let shared = SettingsWindow()
  private(set) var window: NSWindow?

  func show() {
    guard let app = OmacastApp.current else { return }
    if window == nil {
      let model = SettingsModel(app: app)
      let w = NSWindow(contentViewController: NSHostingController(rootView: SettingsView(model: model)))
      w.title = "omacast Settings"
      w.styleMask = [.titled, .closable]
      w.isReleasedWhenClosed = false
      w.center()
      window = w
    }
    (window?.contentViewController as? NSHostingController<SettingsView>)?.rootView.model.reload()
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
  }
}

@MainActor
final class SettingsModel: ObservableObject {
  struct Disabled: Identifiable { let id: String; let title: String }

  unowned let app: OmacastApp
  @Published var general: [String: Any] = [:]
  @Published var disabled: [Disabled] = []
  @Published var hotkey = ""
  @Published var hotkeyError = ""
  @Published var recording = false
  @Published var launchAtLogin = SMAppService.mainApp.status == .enabled
  @Published var message = ""
  @Published var themes: [(id: String, name: String)] = []
  @Published var theme = "system"
  @Published var themeErrors: [String] = []
  var themesFolder = ""
  private var monitor: Any?

  init(app: OmacastApp) { self.app = app; reload() }

  func reload() {
    general = JSON.object(app.engine.call("settings.getGeneralSettings", ""))["data"] as? [String: Any] ?? [:]
    let list = (try? JSONSerialization.jsonObject(with: Data(app.engine.string("disabledCommands").utf8))) as? [[String: Any]] ?? []
    disabled = list.map { Disabled(id: $0["id"] as? String ?? "", title: $0["title"] as? String ?? "") }
    (hotkey, hotkeyError) = app.hotkeyStatus
    launchAtLogin = SMAppService.mainApp.status == .enabled
    let info = JSON.object(app.engine.string("themes"))
    themes = (info["themes"] as? [[String: Any]] ?? []).map { (id: $0["id"] as? String ?? "", name: $0["name"] as? String ?? "") }
    theme = info["current"] as? String ?? "system"
    themeErrors = info["errors"] as? [String] ?? []
    themesFolder = info["folder"] as? String ?? ""
  }

  func setTheme(_ id: String) {
    set("theme", id)
    app.changed()
  }

  func openThemesFolder() {
    guard !themesFolder.isEmpty else { return }
    NSWorkspace.shared.open(URL(fileURLWithPath: themesFolder, isDirectory: true))
  }

  func string(_ key: String) -> String { general[key] as? String ?? "" }
  func number(_ key: String) -> Double { (general[key] as? NSNumber)?.doubleValue ?? 0 }

  func set(_ key: String, _ value: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: [key: value]) else { return }
    let reply = JSON.object(app.engine.call("settings.updateGeneralSettings", String(data: data, encoding: .utf8)!))
    if reply["ok"] as? Bool != true { message = reply["error"] as? String ?? "could not save" }
    reload()
  }

  func enable(_ id: String) {
    _ = app.engine.call("settings.updateCommandSettings", #"{"commandId":"\#(id)","enabled":true}"#)
    reload()
  }

  func setLaunchAtLogin(_ on: Bool) {
    do {
      if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
      message = ""
    } catch {
      message = "Launch at login: \(error.localizedDescription)"
    }
    launchAtLogin = SMAppService.mainApp.status == .enabled
  }

  /// The next key press with a modifier becomes the hotkey.
  func record() {
    recording = true
    monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      let used = MainActor.assumeIsolated { self?.record(event) ?? false }
      return used ? nil : event
    }
  }

  /// True when the key press was taken.
  private func record(_ event: NSEvent) -> Bool {
    if event.keyCode == 53 { stopRecording(); return true }
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    var parts: [String] = []
    if flags.contains(.control) { parts.append("ctrl") }
    if flags.contains(.option) { parts.append("alt") }
    if flags.contains(.shift) { parts.append("shift") }
    if flags.contains(.command) { parts.append("cmd") }
    parts.append(event.keyCode == 49 ? "space" : (event.charactersIgnoringModifiers ?? "").lowercased())
    let spec = parts.joined(separator: "+")
    if Hotkey.Spec.isReserved(spec) { hotkeyError = "That shortcut belongs to every app; pick another"; return true }
    if Hotkey.Spec.parse(spec) == nil { hotkeyError = "Use at least one modifier"; return true }
    saveHotkey(spec)
    stopRecording()
    return true
  }

  private func stopRecording() {
    recording = false
    if let monitor { NSEvent.removeMonitor(monitor) }
    monitor = nil
  }

  /// Writes `hotkey` into config.json, keeping every other key.
  private func saveHotkey(_ spec: String) {
    let paths = JSON.object(app.engine.call("system.getPaths", ""))["data"] as? [String: Any] ?? [:]
    guard let file = paths["configFile"] as? String else { return }
    var doc = (Files.read(file).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) } as? [String: Any]) ?? [:]
    doc["hotkey"] = spec
    guard let data = try? JSONSerialization.data(withJSONObject: doc, options: [.prettyPrinted, .sortedKeys]) else { return }
    let error = Files.writePrivate(file, String(data: data, encoding: .utf8)! + "\n")
    if !error.isEmpty { message = "config.json: \(error)"; return }
    app.reloadHotkey()
    reload()
  }
}

struct SettingsView: View {
  @ObservedObject var model: SettingsModel

  private func picker(_ title: String, _ key: String, _ options: [(String, String)]) -> some View {
    Picker(title, selection: Binding(get: { model.string(key) }, set: { model.set(key, $0) })) {
      ForEach(options, id: \.0) { Text($0.1).tag($0.0) }
    }
  }

  var body: some View {
    Form {
      Section("General") {
        LabeledContent("Hotkey") {
          HStack {
            Button(model.recording ? "Press a shortcut…" : (model.hotkey.isEmpty ? "Not set" : model.hotkey)) { model.record() }
            if !model.hotkeyError.isEmpty { Text(model.hotkeyError).foregroundStyle(.red).font(.caption) }
          }
        }
        Toggle("Launch at login", isOn: Binding(get: { model.launchAtLogin }, set: { model.setLaunchAtLogin($0) }))
        picker("Window mode", "windowMode", [("expanded", "Expanded"), ("compact", "Compact")])
        picker("Escape key", "escapeKeyBehavior", [("pop-back-or-close", "Go back, then close"), ("close-and-pop-to-root", "Close and go to root")])
        picker("Navigation", "navigationBindings", [("emacs", "Emacs (⌃N / ⌃P)"), ("vim-motions", "Vim (⌃J / ⌃K)")])
        picker("Search sensitivity", "rootSearchSensitivity", [("low", "Low"), ("medium", "Medium"), ("high", "High")])
        Picker("Pop to root after", selection: Binding(get: { model.number("popToRootTimeout") }, set: { model.set("popToRootTimeout", $0) })) {
          Text("Immediately").tag(0.0)
          Text("30 seconds").tag(30.0)
          Text("90 seconds").tag(90.0)
          Text("5 minutes").tag(300.0)
          Text("10 minutes").tag(600.0)
        }
      }
      Section("Theme") {
        Picker("Theme", selection: Binding(get: { model.theme }, set: { model.setTheme($0) })) {
          ForEach(model.themes, id: \.id) { Text($0.name).tag($0.id) }
        }
        HStack {
          Text("Add your own: drop a JSON palette in the themes folder.").foregroundStyle(.secondary)
          Spacer()
          Button("Open Themes Folder") { model.openThemesFolder() }
        }
        ForEach(model.themeErrors, id: \.self) { Text($0).foregroundStyle(.red).font(.caption) }
      }
      Section("Disabled commands") {
        if model.disabled.isEmpty {
          Text("None. Disable a command from its actions (⌥⇧D).").foregroundStyle(.secondary)
        }
        ForEach(model.disabled) { item in
          HStack { Text(item.title); Spacer(); Button("Enable") { model.enable(item.id) } }
        }
      }
      if !model.message.isEmpty { Text(model.message).foregroundStyle(.red) }
    }
    .formStyle(.grouped)
    .frame(width: 480)
    .fixedSize()
  }
}
