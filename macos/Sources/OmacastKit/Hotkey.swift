import Carbon.HIToolbox
import Foundation

/// A system-wide hotkey through Carbon's RegisterEventHotKey, which needs
/// no permission. Spec strings look like "alt+space" or "cmd+shift+k".
final class Hotkey {
  struct Spec: Equatable {
    var keyCode: UInt32
    var modifiers: UInt32

    static let keyNames: [String: Int] = {
      var map: [String: Int] = [
        "space": kVK_Space, "return": kVK_Return, "enter": kVK_Return, "tab": kVK_Tab, "escape": kVK_Escape,
        "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6,
        "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
        "`": kVK_ANSI_Grave, "-": kVK_ANSI_Minus, "=": kVK_ANSI_Equal, ";": kVK_ANSI_Semicolon,
        "'": kVK_ANSI_Quote, ",": kVK_ANSI_Comma, ".": kVK_ANSI_Period, "/": kVK_ANSI_Slash,
        "[": kVK_ANSI_LeftBracket, "]": kVK_ANSI_RightBracket, "\\": kVK_ANSI_Backslash
      ]
      let letters: [(String, Int)] = [
        ("a", kVK_ANSI_A), ("b", kVK_ANSI_B), ("c", kVK_ANSI_C), ("d", kVK_ANSI_D), ("e", kVK_ANSI_E), ("f", kVK_ANSI_F),
        ("g", kVK_ANSI_G), ("h", kVK_ANSI_H), ("i", kVK_ANSI_I), ("j", kVK_ANSI_J), ("k", kVK_ANSI_K), ("l", kVK_ANSI_L),
        ("m", kVK_ANSI_M), ("n", kVK_ANSI_N), ("o", kVK_ANSI_O), ("p", kVK_ANSI_P), ("q", kVK_ANSI_Q), ("r", kVK_ANSI_R),
        ("s", kVK_ANSI_S), ("t", kVK_ANSI_T), ("u", kVK_ANSI_U), ("v", kVK_ANSI_V), ("w", kVK_ANSI_W), ("x", kVK_ANSI_X),
        ("y", kVK_ANSI_Y), ("z", kVK_ANSI_Z), ("0", kVK_ANSI_0), ("1", kVK_ANSI_1), ("2", kVK_ANSI_2), ("3", kVK_ANSI_3),
        ("4", kVK_ANSI_4), ("5", kVK_ANSI_5), ("6", kVK_ANSI_6), ("7", kVK_ANSI_7), ("8", kVK_ANSI_8), ("9", kVK_ANSI_9)
      ]
      for (name, code) in letters { map[name] = code }
      return map
    }()

    /// Shortcuts every app relies on; a global hotkey would take them away.
    static let reserved: Set<String> = ["cmd+q", "cmd+w", "cmd+h", "cmd+m", "cmd+tab", "cmd+`", "cmd+shift+q", "cmd+alt+escape"]

    static func isReserved(_ text: String) -> Bool {
      let parts = text.lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
      let names = parts.compactMap { normalize($0) }
      let mods: [String] = ["ctrl", "alt", "shift", "cmd"].filter { names.contains($0) }
      let key: String = parts.first { normalize($0) == nil } ?? ""
      // Canonical order is the one `reserved` is written in: cmd first.
      let ordered = (mods.contains("cmd") ? ["cmd"] : []) + mods.filter { $0 != "cmd" }
      return reserved.contains((ordered + [key]).joined(separator: "+"))
    }

    private static func normalize(_ part: String) -> String? {
      switch part {
      case "cmd", "command", "⌘": return "cmd"
      case "alt", "opt", "option", "⌥": return "alt"
      case "ctrl", "control", "⌃": return "ctrl"
      case "shift", "⇧": return "shift"
      default: return nil
      }
    }

    static func parse(_ text: String) -> Spec? {
      if isReserved(text) { return nil }
      var modifiers: UInt32 = 0
      var key: Int?
      for part in text.lowercased().split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
        switch part {
        case "cmd", "command", "⌘": modifiers |= UInt32(cmdKey)
        case "alt", "opt", "option", "⌥": modifiers |= UInt32(optionKey)
        case "ctrl", "control", "⌃": modifiers |= UInt32(controlKey)
        case "shift", "⇧": modifiers |= UInt32(shiftKey)
        default:
          guard key == nil, let code = keyNames[part] else { return nil }
          key = code
        }
      }
      guard let key, modifiers != 0 || key >= kVK_F1 else { return nil }
      return Spec(keyCode: UInt32(key), modifiers: modifiers)
    }

    /// "⌥ Space" for the settings window.
    var display: String {
      var out = ""
      if modifiers & UInt32(controlKey) != 0 { out += "⌃" }
      if modifiers & UInt32(optionKey) != 0 { out += "⌥" }
      if modifiers & UInt32(shiftKey) != 0 { out += "⇧" }
      if modifiers & UInt32(cmdKey) != 0 { out += "⌘" }
      let name = Spec.keyNames.first { $0.value == Int(keyCode) }?.key ?? "?"
      return out + " " + (name.count == 1 ? name.uppercased() : name.capitalized)
    }
  }

  private var ref: EventHotKeyRef?
  private var handler: EventHandlerRef?
  private let action: @MainActor () -> Void
  private(set) var spec: Spec?
  private(set) var error: String = ""

  init(action: @escaping @MainActor () -> Void) {
    self.action = action
    var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, _, info in
      guard let info else { return noErr }
      let hotkey = Unmanaged<Hotkey>.fromOpaque(info).takeUnretainedValue()
      DispatchQueue.main.async { MainActor.assumeIsolated { hotkey.action() } }
      return noErr
    }, 1, &type, Unmanaged.passUnretained(self).toOpaque(), &handler)
  }

  /// Replaces the registration; false (with `error`) when the spec is bad or taken.
  @discardableResult
  func register(_ text: String) -> Bool {
    guard let next = Spec.parse(text) else {
      error = Spec.isReserved(text) ? "“\(text)” is a shortcut every app uses; pick another" : "cannot read hotkey “\(text)”"
      return false
    }
    if next == spec, ref != nil { return true }
    if let ref { UnregisterEventHotKey(ref); self.ref = nil }
    let id = EventHotKeyID(signature: OSType(0x6F6D6163), id: 1)   // 'omac'
    let status = RegisterEventHotKey(next.keyCode, next.modifiers, id, GetApplicationEventTarget(), 0, &ref)
    guard status == noErr else { error = "\(next.display) is taken by another app (\(status))"; spec = nil; return false }
    spec = next
    error = ""
    return true
  }
}
