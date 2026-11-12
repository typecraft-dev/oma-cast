import AppKit
import SwiftUI

/// Sizes from ui/LauncherWindow.qml, in points at zoom 1.
enum Metrics {
  static let width: CGFloat = 750
  static let height: CGFloat = 475
  static let header: CGFloat = 62
  static let footer: CGFloat = 40
  static let row: CGFloat = 42
  static let section: CGFloat = 28
  static let calculator: CGFloat = 118
  static let radius: CGFloat = 12
}

struct LauncherView: View {
  @ObservedObject var model: LauncherModel

  var body: some View {
    let s = model.state
    let p = Palette(s.theme)
    let z = CGFloat(s.zoom)
    VStack(spacing: 0) {
      HeaderView(model: model, z: z)
        .frame(height: Metrics.header * z)
      if !s.compact {
        Divider().opacity(0.6)
        BodyView(model: model, z: z)
          .frame(maxHeight: .infinity)
        Divider().opacity(0.6)
        FooterView(state: s, z: z)
          .frame(height: Metrics.footer * z)
      }
    }
    .overlay(alignment: .bottomTrailing) {
      if let popup = s.popup, popup.kind == "actions" {
        PopupView(model: model, popup: popup, z: z).padding(.trailing, 10 * z).padding(.bottom, (Metrics.footer + 6) * z)
      } else if let about = s.about {
        AboutView(about: about, z: z).padding(.trailing, 10 * z).padding(.bottom, (Metrics.footer + 6) * z)
      }
    }
    .overlay(alignment: .topTrailing) {
      if let popup = s.popup, popup.kind == "dropdown" {
        PopupView(model: model, popup: popup, z: z, width: 240).padding(.trailing, 10 * z).padding(.top, (Metrics.header + 4) * z)
      }
    }
    .overlay(alignment: .bottomLeading) {
      if let popup = s.popup, popup.kind == "toast" {
        PopupView(model: model, popup: popup, z: z, width: 280).padding(.leading, 10 * z).padding(.bottom, (Metrics.footer + 6) * z)
      }
    }
    .overlay {
      if let alert = s.alert { AlertView(model: model, alert: alert, z: z) }
    }
    .background(Backdrop())
    .clipShape(RoundedRectangle(cornerRadius: Metrics.radius, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Metrics.radius, style: .continuous).strokeBorder(p.border, lineWidth: 1))
    .palette(Palette(s.theme))
  }
}

struct VisualEffect: NSViewRepresentable {
  func makeNSView(context: Context) -> NSVisualEffectView {
    let view = NSVisualEffectView()
    view.material = .popover
    view.blendingMode = .behindWindow
    view.state = .active
    return view
  }
  func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

// MARK: header

struct HeaderView: View {
  @Environment(\.palette) private var p
  @ObservedObject var model: LauncherModel
  let z: CGFloat

  var body: some View {
    let s = model.state
    HStack(spacing: 12 * z) {
      Group {
        if s.atRoot {
          Image(systemName: "command").font(.system(size: 17 * z, weight: .semibold)).foregroundStyle(.tint)
        } else {
          Button(action: model.back) {
            Image(systemName: "chevron.left").font(.system(size: 15 * z, weight: .semibold)).foregroundStyle(.secondary)
          }.buttonStyle(.plain)
        }
      }
      .frame(width: 28 * z, height: 28 * z)

      HStack(spacing: 1) {
        if s.query.isEmpty {
          Caret(visible: s.popup == nil && s.argFocus < 0, height: 22 * z)
          if s.arguments.isEmpty {
            Text(s.placeholder).foregroundStyle(.tertiary).lineLimit(1)
          }
        } else {
          Text(s.query).lineLimit(1).truncationMode(.head)
          Caret(visible: s.popup == nil && s.argFocus < 0, height: 22 * z)
        }
      }
      .font(.system(size: 20 * z))
      .layoutPriority(1)

      if !s.arguments.isEmpty {
        HStack(spacing: 6 * z) {
          ForEach(Array(s.arguments.enumerated()), id: \.offset) { index, arg in
            ArgumentPill(arg: arg, focused: s.argFocus == index, z: z)
              .onTapGesture { model.clickArgument(index) }
          }
        }
      }
      Spacer(minLength: 8)
      if s.atRoot && !s.compact {
        Button(action: model.toggleDropdown) {
          HStack(spacing: 6 * z) {
            Text(s.filterTitle).opacity(s.rootFilter == "all" ? 0.7 : 1)
            Image(systemName: "chevron.down").font(.system(size: 9 * z, weight: .semibold)).opacity(0.6)
          }
          .font(.system(size: 12 * z))
          .padding(.horizontal, 10 * z)
          .frame(height: 26 * z)
          .background(RoundedRectangle(cornerRadius: 6 * z).fill(p.text.opacity(s.popup?.kind == "dropdown" ? 0.12 : 0.06)))
          .overlay(RoundedRectangle(cornerRadius: 6 * z).strokeBorder(p.border))
        }
        .buttonStyle(.plain)
      }
    }
    .padding(.leading, 16 * z)
    .padding(.trailing, 14 * z)
  }
}

struct Caret: View {
  @Environment(\.palette) private var p
  let visible: Bool
  let height: CGFloat
  var body: some View {
    TimelineView(.periodic(from: .now, by: 0.53)) { context in
      let on = Int(context.date.timeIntervalSinceReferenceDate / 0.53) % 2 == 0
      Rectangle().fill(p.accent).frame(width: 2, height: height).opacity(visible && on ? 1 : 0)
    }
    .frame(width: 2)
  }
}

struct ArgumentPill: View {
  @Environment(\.palette) private var p
  let arg: ViewState.Argument
  let focused: Bool
  let z: CGFloat
  var body: some View {
    HStack(spacing: 1) {
      Text(arg.value.isEmpty ? arg.placeholder + (arg.required ? "" : " (optional)") : arg.value)
        .foregroundStyle(arg.value.isEmpty ? .tertiary : .primary)
        .lineLimit(1).truncationMode(.head)
      if focused { Caret(visible: true, height: 15 * z) }
    }
    .font(.system(size: 13 * z))
    .padding(.horizontal, 10 * z)
    .frame(height: 28 * z)
    .frame(maxWidth: 220 * z)
    .background(RoundedRectangle(cornerRadius: 6 * z).fill(p.text.opacity(focused ? 0.12 : 0.06)))
    .overlay(RoundedRectangle(cornerRadius: 6 * z).strokeBorder(focused ? p.accent : p.border))
  }
}

// MARK: body

struct BodyView: View {
  @Environment(\.palette) private var p
  @ObservedObject var model: LauncherModel
  let z: CGFloat

  var body: some View {
    let s = model.state
    if let empty = s.empty {
      VStack(spacing: 8 * z) {
        Image(systemName: s.view.kind == "alias" ? "character.cursor.ibeam" : "magnifyingglass")
          .font(.system(size: 26 * z)).foregroundStyle(.tint)
        Text(empty.title).font(.system(size: 15 * z, weight: .medium))
        if !empty.subtitle.isEmpty {
          Text(empty.subtitle).font(.system(size: 12 * z)).foregroundStyle(.secondary)
            .multilineTextAlignment(.center).frame(maxWidth: 420 * z)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(spacing: 0) {
            ForEach(Array(s.rows.enumerated()), id: \.offset) { index, row in
              RowView(row: row, selected: index == s.selectedIndex, z: z)
                .id(index)
                .contentShape(Rectangle())
                .onContinuousHover { phase in if case .active = phase { model.hover(index) } }
                .onTapGesture { model.click(index) }
            }
          }
          .padding(.horizontal, 8 * z)
          .padding(.vertical, 4 * z)
        }
        .scrollIndicators(.automatic)
        .onChange(of: model.scrollRequest) { _, _ in
          let s = model.state
          let first = s.rows.firstIndex { $0.rowKind != "section" } ?? 0
          if s.selectedIndex <= first { proxy.scrollTo(0, anchor: .top) }
          else if s.selectedIndex >= 0 { proxy.scrollTo(s.selectedIndex) }
        }
      }
    }
  }
}

struct RowView: View {
  @Environment(\.palette) private var p
  let row: ViewState.Row
  let selected: Bool
  let z: CGFloat

  var body: some View {
    switch row.rowKind {
    case "section":
      HStack {
        Text(row.title).font(.system(size: 11 * z, weight: .semibold)).foregroundStyle(.secondary)
        Spacer()
      }
      .padding(.leading, 12 * z)
      .padding(.bottom, 4 * z)
      .frame(height: (row.title.isEmpty ? 6 : Metrics.section) * z, alignment: .bottom)
    case "calculator":
      CalculatorCard(row: row, selected: selected, z: z)
        .padding(.vertical, 2 * z)
    default:
      HStack(spacing: 10 * z) {
        Icon(row: row, selected: selected, z: z).frame(width: 22 * z, height: 22 * z)
        HStack(spacing: 8 * z) {
          Text(row.title).font(.system(size: 14 * z)).lineLimit(1)
          if !row.subtitle.isEmpty {
            Text(row.subtitle).font(.system(size: 13 * z)).foregroundStyle(.secondary).lineLimit(1)
          }
        }
        Spacer(minLength: 8 * z)
        if !row.alias.isEmpty {
          Text(row.alias).font(.system(size: 11 * z)).foregroundStyle(.secondary)
            .padding(.horizontal, 6 * z).padding(.vertical, 2 * z)
            .overlay(RoundedRectangle(cornerRadius: 4 * z).strokeBorder(p.text.opacity(0.3)))
        }
        if row.favorite { Image(systemName: "star.fill").font(.system(size: 10 * z)).foregroundStyle(.tint) }
        if row.checked { Image(systemName: "checkmark").font(.system(size: 12 * z)).foregroundStyle(.tint) }
        Text(row.typeLabel).font(.system(size: 12 * z)).foregroundStyle(.tertiary)
      }
      .padding(.horizontal, 12 * z)
      .frame(height: Metrics.row * z)
      .background(RoundedRectangle(cornerRadius: 8 * z, style: .continuous).fill(selected ? p.selection : .clear))
      .opacity(row.disabled ? 0.45 : 1)
    }
  }
}

struct Icon: View {
  @Environment(\.palette) private var p
  let row: ViewState.Row
  let selected: Bool
  let z: CGFloat
  var body: some View {
    if row.kind == "app", !row.iconName.isEmpty {
      Image(nsImage: IconCache.icon(row.iconName)).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
    } else {
      Image(systemName: row.symbol.isEmpty ? "command" : row.symbol)
        .font(.system(size: 13 * z, weight: .medium))
        .foregroundStyle(selected ? p.accent : p.subtext)
        .frame(width: 22 * z, height: 22 * z)
        .background(RoundedRectangle(cornerRadius: 5 * z).fill(p.text.opacity(0.07)))
    }
  }
}

struct CalculatorCard: View {
  @Environment(\.palette) private var p
  let row: ViewState.Row
  let selected: Bool
  let z: CGFloat
  var body: some View {
    HStack(spacing: 0) {
      side(row.calcInput, row.calcInputCaption, answer: false)
      ZStack {
        Circle().fill(p.text.opacity(0.08)).frame(width: 28 * z, height: 28 * z)
        Image(systemName: "arrow.right").font(.system(size: 12 * z, weight: .semibold)).foregroundStyle(.secondary)
      }
      side(row.calcResult, row.calcResultCaption, answer: true)
    }
    .frame(height: Metrics.calculator * z)
    .background(RoundedRectangle(cornerRadius: 8 * z, style: .continuous).fill((selected ? p.selection : p.text.opacity(0.04))))
    .overlay(RoundedRectangle(cornerRadius: 8 * z, style: .continuous).strokeBorder((selected ? Color.clear : p.border)))
  }

  func side(_ text: String, _ caption: String, answer: Bool) -> some View {
    VStack(spacing: 8 * z) {
      Text(text)
        .font(.system(size: 24 * z, weight: answer ? .semibold : .regular))
        .foregroundStyle(answer && selected ? p.accent : p.text)
        .lineLimit(1).minimumScaleFactor(0.5)
      if !caption.isEmpty {
        Text(caption).font(.system(size: 11 * z)).foregroundStyle(.secondary).lineLimit(1)
          .padding(.horizontal, 8 * z).padding(.vertical, 3 * z)
          .background(Capsule().fill(p.text.opacity(0.08)))
      }
    }
    .padding(.horizontal, 12 * z)
    .frame(maxWidth: .infinity)
  }
}

// MARK: footer

struct KeyHint: View {
  @Environment(\.palette) private var p
  let keys: String
  let z: CGFloat
  var body: some View {
    HStack(spacing: 3 * z) {
      ForEach(Array(Keycaps.split(keys).enumerated()), id: \.offset) { _, cap in
        Text(cap).font(.system(size: 11 * z, weight: .medium)).foregroundStyle(.secondary)
          .frame(minWidth: 18 * z, minHeight: 18 * z)
          .padding(.horizontal, cap.count > 1 ? 4 * z : 0)
          .background(RoundedRectangle(cornerRadius: 4 * z).fill(p.text.opacity(0.08)))
      }
    }
  }
}

struct FooterView: View {
  @Environment(\.palette) private var p
  let state: ViewState
  let z: CGFloat
  var body: some View {
    HStack(spacing: 8 * z) {
      if let toast = state.toast {
        Image(systemName: toast.style == "failure" ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
          .foregroundStyle(toast.style == "failure" ? p.failure : p.accent)
          .font(.system(size: 12 * z))
        Text(toast.title).lineLimit(1)
        if toast.hasActions { KeyHint(keys: "Ctrl T", z: z) }
      } else {
        Image(systemName: "command").font(.system(size: 11 * z)).foregroundStyle(.tint)
        Text(state.view.title).foregroundStyle(.secondary).lineLimit(1)
      }
      Spacer()
      if let primary = state.primaryAction {
        Text(primary.title).lineLimit(1)
        KeyHint(keys: "↵", z: z)
      }
      if state.view.kind != "alias" {
        Rectangle().fill(p.text.opacity(0.2)).frame(width: 1, height: 14 * z)
        Text("Actions").foregroundStyle(.secondary)
        KeyHint(keys: state.actionPanelKeys, z: z)
      }
    }
    .font(.system(size: 12 * z))
    .padding(.horizontal, 14 * z)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(p.text.opacity(0.03))
  }
}

// MARK: popups

struct PopupView: View {
  @Environment(\.palette) private var p
  @ObservedObject var model: LauncherModel
  let popup: ViewState.Popup
  let z: CGFloat
  var width: CGFloat = 340

  var body: some View {
    VStack(spacing: 0) {
      ScrollViewReader { proxy in
        ScrollView {
          VStack(spacing: 0) {
            ForEach(Array(popup.actions.enumerated()), id: \.offset) { index, action in
              let newSection = index > 0 && popup.actions[index - 1].section != action.section
              if newSection { Divider().padding(.vertical, 4 * z) }
              HStack(spacing: 8 * z) {
                Text(action.icon ?? "").frame(width: 14 * z).foregroundStyle(.secondary)
                Text(action.title).lineLimit(1)
                Spacer()
                if let shortcut = action.shortcut, !shortcut.isEmpty { KeyHint(keys: shortcut, z: z) }
              }
              .font(.system(size: 13 * z))
              .padding(.horizontal, 10 * z)
              .frame(height: 32 * z)
              .background(RoundedRectangle(cornerRadius: 6 * z).fill(index == popup.selectedIndex ? p.selection : .clear))
              .contentShape(Rectangle())
              .onTapGesture { model.clickPopup(index) }
              .id(index)
            }
          }
          .padding(6 * z)
        }
        .onChange(of: popup.selectedIndex) { _, index in proxy.scrollTo(index) }
      }
      .frame(maxHeight: 320 * z)
      .fixedSize(horizontal: false, vertical: true)
      Divider()
      HStack {
        Text(popup.filter.isEmpty ? popup.placeholder : popup.filter)
          .foregroundStyle(popup.filter.isEmpty ? .tertiary : .primary)
          .lineLimit(1).truncationMode(.head)
        Spacer()
      }
      .font(.system(size: 13 * z))
      .padding(.horizontal, 14 * z)
      .frame(height: 36 * z)
    }
    .frame(width: width * z)
    .background(Backdrop())
    .clipShape(RoundedRectangle(cornerRadius: 10 * z, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 10 * z, style: .continuous).strokeBorder(p.border))
    .shadow(color: .black.opacity(0.25), radius: 12, y: 4)
  }
}

struct AboutView: View {
  @Environment(\.palette) private var p
  let about: ViewState.About
  let z: CGFloat
  var body: some View {
    VStack(alignment: .leading, spacing: 6 * z) {
      Text(about.title).font(.system(size: 13 * z, weight: .semibold)).lineLimit(1)
      Divider()
      ForEach(Array(about.rows.enumerated()), id: \.offset) { _, row in
        HStack(alignment: .firstTextBaseline, spacing: 10 * z) {
          Text(row.label).foregroundStyle(.secondary).frame(width: 110 * z, alignment: .leading)
          Text(row.value).textSelection(.enabled).lineLimit(3)
          Spacer(minLength: 0)
        }
        .font(.system(size: 12 * z))
      }
    }
    .padding(12 * z)
    .frame(width: 380 * z)
    .background(Backdrop())
    .clipShape(RoundedRectangle(cornerRadius: 10 * z, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 10 * z, style: .continuous).strokeBorder(p.border))
    .shadow(color: .black.opacity(0.25), radius: 12, y: 4)
  }
}

struct AlertView: View {
  @Environment(\.palette) private var p
  @ObservedObject var model: LauncherModel
  let alert: ViewState.Alert
  let z: CGFloat
  var body: some View {
    ZStack {
      Color.black.opacity(0.25).onTapGesture { model.cancelAlert() }
      VStack(spacing: 10 * z) {
        Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 26 * z)).foregroundStyle(.orange)
        Text(alert.title).font(.system(size: 15 * z, weight: .semibold))
        Text(alert.message).font(.system(size: 12 * z)).foregroundStyle(.secondary).multilineTextAlignment(.center)
        HStack(spacing: 8 * z) {
          Button(action: model.cancelAlert) {
            HStack { Text("Cancel"); KeyHint(keys: "Esc", z: z) }.frame(maxWidth: .infinity)
          }
          Button(action: model.confirmAlert) {
            HStack { Text(alert.primary); KeyHint(keys: "↵", z: z) }.frame(maxWidth: .infinity)
          }
          .tint(alert.destructive == true ? p.failure : p.accent)
          .buttonStyle(.borderedProminent)
        }
        .controlSize(.large)
        .padding(.top, 4 * z)
      }
      .padding(18 * z)
      .frame(width: 300 * z)
      .background(Backdrop())
      .clipShape(RoundedRectangle(cornerRadius: 12 * z, style: .continuous))
      .shadow(color: .black.opacity(0.3), radius: 16, y: 6)
    }
  }
}
