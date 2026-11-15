import QtQuick
import qs.Commons
import "../core/LargeType.js" as LargeType

// Large Type (Ctrl+L): the query across the whole screen, as Alfred's Large
// Type does. Dynamic text is always PlainText — user input is never markup —
// and Text.Fit walks the sizes itself inside the bounds from
// core/LargeType.js, so fitting stays bounded for any input length.
Rectangle {
  id: overlay

  property string text: ""
  property var look: null
  property real zoom: 1

  function px(v) { return Math.round(Style.space(v) * overlay.zoom) }

  readonly property var fit: LargeType.fitRange(overlay.width, overlay.height, overlay.zoom)

  color: overlay.look ? overlay.look.background : "#000000"

  Text {
    id: display
    anchors.centerIn: parent
    width: overlay.fit ? overlay.fit.width : parent.width
    height: overlay.fit ? overlay.fit.height : parent.height
    textFormat: Text.PlainText
    text: overlay.text
    color: overlay.look ? overlay.look.foreground : "#ffffff"
    horizontalAlignment: Text.AlignHCenter
    verticalAlignment: Text.AlignVCenter
    wrapMode: Text.WrapAtWordBoundaryOrAnywhere
    fontSizeMode: Text.Fit
    font.family: overlay.look ? overlay.look.fontFamily : ""
    font.pixelSize: overlay.fit ? overlay.fit.max : 64
    minimumPixelSize: overlay.fit ? overlay.fit.min : 8
    clip: true
  }

  Text {
    anchors.horizontalCenter: parent.horizontalCenter
    anchors.bottom: parent.bottom
    anchors.bottomMargin: overlay.px(16)
    textFormat: Text.PlainText
    text: "Esc to close"
    visible: overlay.width >= 500 && overlay.height >= 300
    color: overlay.look ? overlay.look.foreground : "#ffffff"
    opacity: 0.4
    font.family: overlay.look ? overlay.look.fontFamily : ""
    font.pixelSize: Math.round(Style.font.bodySmall * overlay.zoom)
  }
}
