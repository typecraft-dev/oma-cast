import AppKit
import SwiftUI

/// The launcher window: a borderless, non-activating panel created once and
/// kept hidden between uses, so the app underneath stays frontmost (paste
/// goes back to it) and keys typed right after the hotkey land here.
final class LauncherPanel: NSPanel {
  var onKey: ((NSEvent) -> Bool)?

  init() {
    super.init(contentRect: NSRect(x: 0, y: 0, width: Metrics.width, height: Metrics.height),
               styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView], backing: .buffered, defer: false)
    isFloatingPanel = true
    level = .floating
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
    isOpaque = false
    backgroundColor = .clear
    hasShadow = true
    hidesOnDeactivate = false
    isMovable = false
    isReleasedWhenClosed = false
    animationBehavior = .none
  }

  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }

  override func sendEvent(_ event: NSEvent) {
    if event.type == .keyDown, let onKey, onKey(event) { return }
    super.sendEvent(event)
  }

  /// The card's size at the current zoom, placed a quarter down the screen
  /// under the pointer; the top edge stays put when compact mode resizes it.
  func place(width: CGFloat, height: CGFloat, fullHeight: CGFloat, reposition: Bool) {
    let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
    guard let area = screen?.visibleFrame else { return }
    var top = frame.maxY
    var x = frame.minX
    if reposition {
      x = area.midX - width / 2
      let fromTop = min(area.height / 4, max(0, area.height - fullHeight))
      top = area.maxY - fromTop
    }
    setFrame(NSRect(x: x, y: top - height, width: width, height: height), display: true)
  }
}

/// The macOS stand-in for Omarchy's OSD: a short message after the launcher closes.
final class HUD {
  private let panel: NSPanel
  private let label = NSTextField(labelWithString: "")
  private var hideWork: DispatchWorkItem?

  init() {
    panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    panel.level = .statusBar
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.ignoresMouseEvents = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
    let effect = NSVisualEffectView()
    effect.material = .hudWindow
    effect.state = .active
    effect.wantsLayer = true
    effect.layer?.cornerRadius = 10
    label.font = .systemFont(ofSize: 14, weight: .medium)
    label.alignment = .center
    label.translatesAutoresizingMaskIntoConstraints = false
    effect.addSubview(label)
    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: effect.centerXAnchor),
      label.centerYAnchor.constraint(equalTo: effect.centerYAnchor)
    ])
    panel.contentView = effect
  }

  func show(_ text: String) {
    label.stringValue = text
    let size = NSSize(width: max(180, label.intrinsicContentSize.width + 40), height: 40)
    let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
    guard let area = screen?.visibleFrame else { return }
    panel.setFrame(NSRect(x: area.midX - size.width / 2, y: area.minY + area.height * 0.18, width: size.width, height: size.height), display: true)
    panel.alphaValue = 1
    panel.orderFrontRegardless()
    hideWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      NSAnimationContext.runAnimationGroup({ $0.duration = 0.25; self?.panel.animator().alphaValue = 0 }) { self?.panel.orderOut(nil) }
    }
    hideWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: work)
  }
}

/// NSEvent → the key event core/LauncherState.js reads.
enum KeyEvents {
  static func json(_ event: NSEvent) -> String {
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    var text = event.characters ?? ""
    var key: String
    switch Int(event.keyCode) {
    case 53: key = "Escape"
    case 36, 76: key = "Return"
    case 126: key = "Up"
    case 125: key = "Down"
    case 123: key = "Left"
    case 124: key = "Right"
    case 116: key = "PageUp"
    case 121: key = "PageDown"
    case 115: key = "Home"
    case 119: key = "End"
    case 48: key = "Tab"
    case 51: key = "Backspace"
    case 117: key = "Delete"
    case 114: key = "Insert"
    case 49: key = "Space"
    default: key = (event.charactersIgnoringModifiers ?? "").lowercased()
    }
    if key.count > 1 && key != "Space" { text = "" }
    if key == "Space" { text = flags.contains(.command) || flags.contains(.control) ? "" : " " }
    let object: [String: Any] = [
      "key": key, "text": text,
      "primary": flags.contains(.command), "control": flags.contains(.control),
      "alt": flags.contains(.option), "shift": flags.contains(.shift)
    ]
    let data = try! JSONSerialization.data(withJSONObject: object)
    return String(data: data, encoding: .utf8)!
  }
}
