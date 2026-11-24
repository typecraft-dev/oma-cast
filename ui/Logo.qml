import QtQuick

// The launcher's logo, picked by config.json `logo`. By default it is
// logo.svg, the same drawing as the website's icon: pixel art on a 30-unit
// grid. With `omarchy` it is Omarchy's logo glyph from the `omarchy` font,
// drawn on a 15 px grid and tinted with `color`. Size either one with
// LauncherWindow.crispLogoSize().
Item {
  id: logo

  property real size: 0
  property bool omarchy: false
  property color color: "white"

  width: size
  height: size

  Image {
    anchors.fill: parent
    visible: !logo.omarchy
    sourceSize.width: Math.round(logo.size * Screen.devicePixelRatio)
    sourceSize.height: Math.round(logo.size * Screen.devicePixelRatio)
    source: logo.omarchy ? "" : Qt.resolvedUrl("logo.svg")
  }

  Text {
    anchors.centerIn: parent
    visible: logo.omarchy
    textFormat: Text.PlainText
    text: ""
    font.family: "omarchy"
    font.pixelSize: Math.max(1, Math.round(logo.size))
    renderType: Text.NativeRendering
    color: logo.color
  }
}
