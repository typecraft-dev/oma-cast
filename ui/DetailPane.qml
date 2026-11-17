import QtQuick
import qs.Commons

// The detail pane of a list/detail view (Clipboard History, SPEC §8.2): a preview (text,
// image or colour swatch) above its Information rows
// (ClipboardHistory.detail).
Item {
  id: pane

  property var detail: null
  property var look: null
  property real zoom: 1

  function px(v) { return Math.round(Style.space(v) * pane.zoom) }

  Rectangle {
    anchors.left: parent.left
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    width: Style.spacing.hairline
    color: Util.alpha(pane.look.foreground, 0.12)
  }

  Item {
    id: preview
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.bottom: info.top
    anchors.margins: pane.px(14)
    clip: true

    Text {
      anchors.fill: parent
      visible: !!pane.detail && !pane.detail.image && !pane.detail.color
      textFormat: Text.PlainText
      text: pane.detail ? pane.detail.text : ""
      color: pane.look.foreground
      wrapMode: Text.WrapAnywhere
      elide: Text.ElideRight
      font.family: Style.fontFamily
      font.pixelSize: Math.round(Style.font.bodySmall * pane.zoom)
    }

    // Two images: the new one decodes hidden and the old one stays up until it's
    // ready, so moving through a list doesn't flash an empty pane.
    readonly property url wanted: pane.detail && pane.detail.image ? Util.fileUrl(pane.detail.image) : ""
    property int front: 0
    onWantedChanged: {
      var back = images.itemAt(1 - preview.front)
      if (!back) return
      back.source = preview.wanted
      if (back.status === Image.Ready || !preview.wanted) preview.front = 1 - preview.front
    }

    Repeater {
      id: images
      model: 2
      Image {
        anchors.fill: parent
        visible: index === preview.front && !!pane.detail && !!pane.detail.image
        fillMode: Image.PreserveAspectFit
        asynchronous: true
        cache: false
        // Decode at the pane's size: a 4K screenshot needn't cost 33 MB.
        sourceSize.width: Math.max(1, Math.round(width * 2))
        sourceSize.height: Math.max(1, Math.round(height * 2))
        Component.onCompleted: if (index === 0) source = preview.wanted
        onStatusChanged: if (index !== preview.front && source === preview.wanted && status !== Image.Loading) preview.front = index
      }
    }

    Column {
      anchors.centerIn: parent
      visible: !!pane.detail && !!pane.detail.color
      spacing: pane.px(10)

      Rectangle {
        anchors.horizontalCenter: parent.horizontalCenter
        width: pane.px(96)
        height: pane.px(96)
        radius: Style.cornerRadius
        color: pane.detail && pane.detail.color ? pane.detail.color : "transparent"
        border.width: 1
        border.color: Util.alpha(pane.look.foreground, 0.2)
      }
      Text {
        anchors.horizontalCenter: parent.horizontalCenter
        textFormat: Text.PlainText
        text: pane.detail ? pane.detail.text.trim() : ""
        color: pane.look.foreground
        font.family: Style.fontFamily
        font.pixelSize: Math.round(Style.font.body * pane.zoom)
      }
    }
  }

  Column {
    id: info
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    anchors.leftMargin: pane.px(14)
    anchors.rightMargin: pane.px(14)
    anchors.bottomMargin: pane.px(8)
    spacing: pane.px(5)

    Rectangle {
      width: parent.width
      height: Style.spacing.hairline
      color: Util.alpha(pane.look.foreground, 0.12)
    }

    Text {
      textFormat: Text.PlainText
      text: "Information"
      color: pane.look.foreground
      opacity: 0.7
      font.family: pane.look.fontFamily
      font.pixelSize: Math.round(Style.font.bodySmall * pane.zoom)
      font.bold: true
    }

    Repeater {
      model: pane.detail ? pane.detail.info : []

      Item {
        required property var modelData
        width: info.width
        height: label.implicitHeight

        Text {
          id: label
          anchors.left: parent.left
          textFormat: Text.PlainText
          text: modelData.label
          color: pane.look.foreground
          opacity: 0.55
          font.family: pane.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * pane.zoom)
        }
        Text {
          anchors.right: parent.right
          width: parent.width - label.implicitWidth - pane.px(12)
          horizontalAlignment: Text.AlignRight
          textFormat: Text.PlainText
          text: modelData.value
          color: pane.look.foreground
          elide: Text.ElideLeft
          font.family: pane.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * pane.zoom)
        }
      }
    }
  }
}
