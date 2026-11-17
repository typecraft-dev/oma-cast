import QtQuick
import qs.Commons

Row {
  id: hint

  property string keys: ""
  property color color: "white"
  property string fontFamily: Style.font.menuFamily
  property int pixelSize: Style.font.caption
  property real zoom: 1

  spacing: Math.max(2, Math.round(Style.space(3) * hint.zoom))

  Repeater {
    model: hint.keys ? hint.keys.split(" ") : []

    Rectangle {
      required property string modelData
      height: label.implicitHeight + Math.round(Style.space(4) * hint.zoom)
      width: Math.max(height, label.implicitWidth + Math.round(Style.space(10) * hint.zoom))
      radius: Math.round(Style.space(4) * hint.zoom)
      color: Util.alpha(hint.color, 0.1)

      Text {
        id: label
        anchors.centerIn: parent
        textFormat: Text.PlainText
        text: parent.modelData
        color: hint.color
        opacity: 0.75
        font.family: hint.fontFamily
        font.pixelSize: hint.pixelSize
      }
    }
  }
}
