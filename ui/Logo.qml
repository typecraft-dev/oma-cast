import QtQuick

// The omacast logo: logo.svg, the same drawing as the website's icon. It is
// pixel art on a 30-unit grid, so size it with LauncherWindow.crispLogoSize().
Image {
  id: logo

  property real size: 0

  width: size
  height: size
  sourceSize.width: Math.round(size * Screen.devicePixelRatio)
  sourceSize.height: Math.round(size * Screen.devicePixelRatio)
  source: Qt.resolvedUrl("logo.svg")
}
