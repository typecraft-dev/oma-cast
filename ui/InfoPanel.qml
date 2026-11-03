import QtQuick
import qs.Commons

// The About panel (Ctrl+Shift+K): label/value rows describing the selected
// row (RootSearch.aboutFor).
Rectangle {
  id: panel

  property string title: ""
  property var rows: []
  property var look: null
  property real zoom: 1

  function px(v) { return Math.round(Style.space(v) * panel.zoom) }

  width: px(400)
  height: content.implicitHeight + px(24)
  radius: Math.max(Style.cornerRadius, px(8))
  color: look.background
  border.width: 1
  border.color: Util.alpha(look.foreground, 0.15)

  MouseArea { anchors.fill: parent }

  Column {
    id: content
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.margins: panel.px(12)
    spacing: panel.px(6)

    Text {
      width: parent.width
      textFormat: Text.PlainText
      text: panel.title
      color: panel.look.foreground
      elide: Text.ElideRight
      font.family: panel.look.fontFamily
      font.pixelSize: Math.round(Style.font.body * panel.zoom)
      font.bold: true
    }

    Rectangle {
      width: parent.width
      height: 1
      color: Util.alpha(panel.look.foreground, 0.1)
    }

    Repeater {
      model: panel.rows

      Row {
        required property var modelData
        width: content.width
        spacing: panel.px(10)

        Text {
          width: panel.px(100)
          textFormat: Text.PlainText
          text: modelData.label
          color: panel.look.foreground
          opacity: 0.55
          elide: Text.ElideRight
          font.family: panel.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * panel.zoom)
        }
        Text {
          width: content.width - panel.px(110)
          textFormat: Text.PlainText
          text: modelData.value
          color: panel.look.foreground
          wrapMode: Text.WrapAnywhere
          maximumLineCount: 4
          elide: Text.ElideRight
          font.family: panel.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * panel.zoom)
        }
      }
    }
  }
}
