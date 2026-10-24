import QtQuick
import qs.Commons

// A centered confirm dialog over the card (ref 04 §2.6 alert-store): ↵
// confirms, Esc cancels. spec: {title, message, primary, destructive}.
Rectangle {
  id: alert

  property var spec: null
  property var look: null
  property real zoom: 1

  signal confirmed()
  signal cancelled()

  function px(v) { return Math.round(Style.space(v) * alert.zoom) }

  readonly property color danger: "#e06c75"

  color: Util.alpha("#000000", 0.35)

  MouseArea { anchors.fill: parent; onClicked: alert.cancelled() }

  Rectangle {
    id: box
    anchors.centerIn: parent
    width: alert.px(320)
    height: column.implicitHeight + alert.px(36)
    radius: Math.max(Style.cornerRadius, alert.px(10))
    color: alert.look.background
    border.width: 1
    border.color: Util.alpha(alert.look.foreground, 0.18)

    MouseArea { anchors.fill: parent }

    Column {
      id: column
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.margins: alert.px(18)
      spacing: alert.px(10)

      Text {
        width: parent.width
        horizontalAlignment: Text.AlignHCenter
        textFormat: Text.PlainText
        text: alert.spec ? alert.spec.title : ""
        color: alert.look.foreground
        wrapMode: Text.Wrap
        font.family: alert.look.fontFamily
        font.pixelSize: Math.round(Style.font.title * alert.zoom)
        font.bold: true
      }

      Text {
        width: parent.width
        horizontalAlignment: Text.AlignHCenter
        textFormat: Text.PlainText
        text: alert.spec ? alert.spec.message : ""
        visible: text.length > 0
        color: alert.look.foreground
        opacity: 0.7
        wrapMode: Text.Wrap
        font.family: alert.look.fontFamily
        font.pixelSize: Math.round(Style.font.bodySmall * alert.zoom)
      }

      Item { width: 1; height: alert.px(4) }

      Row {
        anchors.horizontalCenter: parent.horizontalCenter
        spacing: alert.px(10)

        Repeater {
          model: [
            { primary: false, title: "Cancel", key: "Esc" },
            { primary: true, title: alert.spec ? alert.spec.primary : "OK", key: "↵" }
          ]

          Rectangle {
            required property var modelData
            readonly property bool danger: modelData.primary && alert.spec && alert.spec.destructive
            width: (column.width - alert.px(10)) / 2
            height: alert.px(34)
            radius: Math.max(Style.cornerRadius, alert.px(6))
            color: danger ? Util.alpha(alert.danger, 0.85)
              : modelData.primary ? alert.look.selectedBackground
              : Util.alpha(alert.look.foreground, 0.08)

            Row {
              anchors.centerIn: parent
              spacing: alert.px(8)

              Text {
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: modelData.title
                color: parent.parent.danger ? "#ffffff" : alert.look.foreground
                font.family: alert.look.fontFamily
                font.pixelSize: Math.round(Style.font.body * alert.zoom)
              }
              KeyHint {
                anchors.verticalCenter: parent.verticalCenter
                keys: modelData.key
                color: parent.parent.danger ? "#ffffff" : alert.look.foreground
                fontFamily: alert.look.fontFamily
                zoom: alert.zoom
              }
            }

            MouseArea {
              anchors.fill: parent
              cursorShape: Qt.PointingHandCursor
              onClicked: modelData.primary ? alert.confirmed() : alert.cancelled()
            }
          }
        }
      }
    }
  }
}
