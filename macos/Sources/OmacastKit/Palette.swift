import AppKit
import SwiftUI

/// The colours every launcher view draws with: a macos/js/Themes.js theme, or
/// the system look (translucent, light/dark, accent colour) when none is set.
struct Palette {
  var background: Color?          // nil: the system's translucent material
  var scheme: ColorScheme?
  var text: Color
  var subtext: Color
  var faint: Color
  var accent: Color
  var selection: Color
  var border: Color
  var failure: Color

  static let system = Palette(
    background: nil, scheme: nil, text: .primary, subtext: .secondary, faint: Color(nsColor: .tertiaryLabelColor),
    accent: .accentColor, selection: Color.primary.opacity(0.1), border: Color.primary.opacity(0.12), failure: .red)

  init(background: Color?, scheme: ColorScheme?, text: Color, subtext: Color, faint: Color, accent: Color, selection: Color, border: Color, failure: Color) {
    self.background = background; self.scheme = scheme; self.text = text; self.subtext = subtext; self.faint = faint
    self.accent = accent; self.selection = selection; self.border = border; self.failure = failure
  }

  init(_ theme: ViewState.Theme?) {
    guard let t = theme else { self = .system; return }
    self.init(
      background: Color(hex: t.background), scheme: t.appearance == "light" ? .light : .dark,
      text: Color(hex: t.text), subtext: Color(hex: t.subtext), faint: Color(hex: t.faint), accent: Color(hex: t.accent),
      selection: Color(hex: t.selection), border: Color(hex: t.border), failure: Color(hex: t.failure))
  }
}

private struct PaletteKey: EnvironmentKey { static let defaultValue = Palette.system }

extension EnvironmentValues {
  var palette: Palette {
    get { self[PaletteKey.self] }
    set { self[PaletteKey.self] = newValue }
  }
}

extension Color {
  /// "#rrggbb" or "#rrggbbaa", as macos/js/Themes.js checks them.
  init(hex: String) {
    var value: UInt64 = 0
    let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    Scanner(string: digits).scanHexInt64(&value)
    let hasAlpha = digits.count == 8
    let r = Double((value >> (hasAlpha ? 24 : 16)) & 0xFF) / 255
    let g = Double((value >> (hasAlpha ? 16 : 8)) & 0xFF) / 255
    let b = Double((value >> (hasAlpha ? 8 : 0)) & 0xFF) / 255
    let a = hasAlpha ? Double(value & 0xFF) / 255 : 1
    self.init(.sRGB, red: r, green: g, blue: b, opacity: a)
  }
}

/// The card or popup background: the theme colour, else the system material.
struct Backdrop: View {
  @Environment(\.palette) private var p
  var body: some View {
    if let background = p.background { background } else { VisualEffect() }
  }
}

extension View {
  /// Puts a palette in effect for everything below: colours, light/dark
  /// controls, and the .secondary / .tertiary styles.
  func palette(_ p: Palette) -> some View {
    environment(\.palette, p)
      .environment(\.colorScheme, p.scheme ?? (NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? .dark : .light))
      .tint(p.accent)
      .foregroundStyle(p.text, p.subtext, p.faint)
  }
}
