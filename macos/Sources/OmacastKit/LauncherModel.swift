import AppKit
import SwiftUI

/// core/LauncherState.js state(), decoded. Field names match the JS.
struct ViewState: Decodable {
  struct View: Decodable { var kind: String; var title: String }
  struct Row: Decodable {
    var rowKind: String
    var itemId: String
    var kind: String
    var title: String
    var subtitle: String
    var symbol: String
    var iconName: String
    var typeLabel: String
    var alias: String
    var checked: Bool
    var disabled: Bool
    var favorite: Bool
    var calcInput: String
    var calcResult: String
    var calcInputCaption: String
    var calcResultCaption: String
  }
  struct Argument: Decodable { var name: String; var placeholder: String; var required: Bool; var value: String }
  struct Action: Decodable { var id: String; var title: String; var shortcut: String?; var section: String?; var icon: String? }
  struct Popup: Decodable { var kind: String; var placeholder: String; var filter: String; var selectedIndex: Int; var actions: [Action] }
  struct InfoRow: Decodable { var label: String; var value: String }
  struct About: Decodable { var title: String; var rows: [InfoRow] }
  struct Alert: Decodable { var title: String; var message: String; var primary: String; var destructive: Bool? }
  struct Toast: Decodable { var style: String; var title: String; var hasActions: Bool }
  struct Primary: Decodable { var title: String }
  struct Empty: Decodable { var title: String; var subtitle: String }
  struct Theme: Decodable {
    var name: String; var appearance: String; var background: String; var text: String; var accent: String
    var subtext: String; var faint: String; var selection: String; var border: String; var failure: String
  }

  var revision: Int
  var shown: Bool
  var view: View
  var atRoot: Bool
  var compact: Bool
  var zoom: Double
  var query: String
  var placeholder: String
  var rows: [Row]
  var selectedIndex: Int
  var arguments: [Argument]
  var argFocus: Int
  var rootFilter: String
  var filterTitle: String
  var popup: Popup?
  var about: About?
  var alert: Alert?
  var toast: Toast?
  var primaryAction: Primary?
  var actionPanelKeys: String
  var empty: Empty?
  var theme: Theme?

  static let initial = ViewState(
    revision: -1, shown: false, view: View(kind: "root", title: "omacast"), atRoot: true, compact: false, zoom: 1,
    query: "", placeholder: "Search for apps and commands…", rows: [], selectedIndex: -1, arguments: [], argFocus: -1,
    rootFilter: "all", filterTitle: "All", popup: nil, about: nil, alert: nil, toast: nil, primaryAction: nil,
    actionPanelKeys: "Ctrl K", empty: nil, theme: nil)
}

/// Bridges the JS state machine to SwiftUI.
@MainActor
final class LauncherModel: ObservableObject {
  @Published private(set) var state = ViewState.initial
  /// Bumped when the keyboard moved the selection, so the list scrolls to it.
  @Published private(set) var scrollRequest = 0
  weak var engine: JSEngine?
  private var mouseAtKey: NSPoint = .zero
  private var lastSelection = -1

  func reload() {
    guard let engine else { return }
    let json = engine.string("state")
    guard let data = json.data(using: .utf8) else { return }
    do {
      let next = try JSONDecoder().decode(ViewState.self, from: data)
      let moved = next.selectedIndex != lastSelection || next.query != state.query || next.view.kind != state.view.kind
      lastSelection = next.selectedIndex
      state = next
      if moved { scrollRequest += 1 }
    } catch {
      Log.write("[omacast] [error] [ui] cannot decode state: \(error)")
    }
  }

  /// A key went to the launcher: hovering only counts after a real pointer move.
  func noteKeyboard() { mouseAtKey = NSEvent.mouseLocation }

  func hover(_ index: Int) {
    let mouse = NSEvent.mouseLocation
    guard mouse != mouseAtKey else { return }
    mouseAtKey = mouse
    lastSelection = index
    engine?.invoke("hover", [index])
  }

  func click(_ index: Int) { engine?.invoke("click", [index]) }
  func clickPopup(_ index: Int) { engine?.invoke("clickPopup", [index]) }
  func clickArgument(_ index: Int) { engine?.invoke("clickArgument", [index]) }
  func toggleDropdown() { engine?.invoke("toggleDropdown") }
  func back() { engine?.invoke("back") }
  func confirmAlert() { engine?.invoke("confirmAlert") }
  func cancelAlert() { engine?.invoke("cancelAlert") }
}

/// Shortcut labels from core use Linux names ("Ctrl Shift C"); on macOS the
/// primary modifier is Command.
enum Keycaps {
  static func split(_ shortcut: String) -> [String] {
    shortcut.split(separator: " ").map { token in
      switch token {
      case "Ctrl": return "⌘"
      case "Alt": return "⌥"
      case "Shift": return "⇧"
      default: return String(token)
      }
    }
  }
}
