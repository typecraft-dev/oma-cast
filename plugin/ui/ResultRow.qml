import QtQuick
import Quickshell
import qs.Commons
import "../core/FileSearch.js" as FileSearch

// One list row (SPEC §10.2): 22 px icon, title, secondary subtitle, and right
// accessories in Raycast's order: alias badge, ✓ state, type label. Section
// headers use the same delegate with rowKind "section".
Item {
  id: row

  required property int index
  required property string rowKind
  required property string itemId
  required property string title
  required property string subtitle
  required property string glyph
  required property string glyphFont
  required property string iconName
  required property string typeLabel
  required property string alias
  required property bool checked
  required property bool disabled
  required property bool favorite
  required property string path         // file rows only; makes the row draggable

  property bool selected: false
  property var look: null
  property var appLibrary: null
  property real zoom: 1

  signal hovered(int index, var item, var mouse)
  signal clicked(int index)
  signal dragStarted(int index)
  signal dragEnded(bool dropped)

  readonly property bool isSection: row.rowKind === "section"
  function px(v) { return Math.round(Style.space(v) * row.zoom) }

  width: ListView.view ? ListView.view.width : 0
  height: row.isSection ? (row.title ? px(30) : px(6)) : px(42)

  Text {
    visible: row.isSection && row.title.length > 0
    textFormat: Text.PlainText
    anchors.left: parent.left
    anchors.leftMargin: row.px(12)
    anchors.bottom: parent.bottom
    anchors.bottomMargin: row.px(6)
    text: row.title
    color: row.look.foreground
    opacity: 0.5
    font.family: row.look.fontFamily
    font.pixelSize: Math.round(Style.font.caption * row.zoom)
    font.weight: Font.DemiBold
  }

  Rectangle {
    visible: !row.isSection
    anchors.fill: parent
    radius: Math.max(Style.cornerRadius, row.px(6))
    color: row.selected ? row.look.selectedBackground : "transparent"
    opacity: row.disabled ? 0.45 : 1

    Item {
      id: iconBox
      width: row.px(22)
      height: row.px(22)
      anchors.left: parent.left
      anchors.leftMargin: row.px(12)
      anchors.verticalCenter: parent.verticalCenter

      Image {
        anchors.fill: parent
        visible: row.iconName.length > 0 && row.glyph.length === 0
        fillMode: Image.PreserveAspectFit
        asynchronous: true
        sourceSize.width: width * Screen.devicePixelRatio
        sourceSize.height: height * Screen.devicePixelRatio
        source: !visible ? "" : (row.appLibrary ? row.appLibrary.iconSource(row.iconName) : Quickshell.iconPath(row.iconName, "application-x-executable"))
      }

      Text {
        anchors.centerIn: parent
        visible: row.glyph.length > 0
        textFormat: Text.PlainText
        text: row.glyph
        color: row.selected ? row.look.accent : row.look.foreground
        font.family: row.glyphFont || row.look.fontFamily
        font.pixelSize: row.glyphFont === "omarchy" ? row.px(14) : row.px(17)
      }
    }

    Row {
      id: accessories
      anchors.right: parent.right
      anchors.rightMargin: row.px(12)
      anchors.verticalCenter: parent.verticalCenter
      spacing: row.px(10)

      Rectangle {
        visible: row.alias.length > 0
        anchors.verticalCenter: parent.verticalCenter
        height: aliasText.implicitHeight + row.px(4)
        width: aliasText.implicitWidth + row.px(12)
        radius: row.px(4)
        color: "transparent"
        border.width: 1
        border.color: Util.alpha(row.look.foreground, 0.3)
        Text {
          id: aliasText
          anchors.centerIn: parent
          textFormat: Text.PlainText
          text: row.alias
          color: row.look.foreground
          opacity: 0.7
          font.family: row.look.fontFamily
          font.pixelSize: Math.round(Style.font.caption * row.zoom)
        }
      }

      Text {
        visible: row.favorite
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: ""
        color: row.look.accent
        opacity: 0.8
        font.family: row.look.fontFamily
        font.pixelSize: Math.round(Style.font.caption * row.zoom)
      }

      Text {
        visible: row.checked
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: "✓"
        color: row.look.accent
        font.family: row.look.fontFamily
        font.pixelSize: Math.round(Style.font.body * row.zoom)
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: row.typeLabel
        color: row.look.foreground
        opacity: 0.45
        font.family: row.look.fontFamily
        font.pixelSize: Math.round(Style.font.bodySmall * row.zoom)
      }
    }

    Row {
      anchors.left: iconBox.right
      anchors.leftMargin: row.px(10)
      anchors.right: accessories.left
      anchors.rightMargin: row.px(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: row.px(8)
      clip: true

      Text {
        id: titleText
        textFormat: Text.PlainText
        text: row.title
        color: row.look.foreground
        font.family: row.look.fontFamily
        font.pixelSize: Math.round(Style.font.title * row.zoom)
        elide: Text.ElideRight
        width: Math.min(implicitWidth, parent.width)
      }

      Text {
        textFormat: Text.PlainText
        text: row.subtitle
        visible: text.length > 0
        color: row.look.foreground
        opacity: 0.5
        font.family: row.look.fontFamily
        font.pixelSize: Math.round(Style.font.body * row.zoom)
        anchors.baseline: titleText.baseline
        elide: Text.ElideRight
        width: Math.max(0, Math.min(implicitWidth, parent.width - titleText.width - parent.spacing))
      }
    }
  }

  // Drag a file row out to another app (terminal, browser upload, chat)
  // as text/uri-list, the same payload a file manager sends. [D]
  Item {
    id: dragProxy
    width: 1
    height: 1
    Drag.dragType: Drag.Automatic
    Drag.supportedActions: Qt.CopyAction
    Drag.mimeData: row.path ? ({ "text/uri-list": FileSearch.fileUri(row.path) + "\r\n", "text/plain": row.path }) : ({})
    Drag.active: rowMouse.drag.active
    Drag.onDragStarted: row.dragStarted(row.index)
    Drag.onDragFinished: function(dropAction) {
      dragProxy.x = 0
      dragProxy.y = 0
      row.dragEnded(dropAction !== Qt.IgnoreAction)
    }
  }

  MouseArea {
    id: rowMouse
    anchors.fill: parent
    enabled: !row.isSection
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    drag.target: row.path ? dragProxy : null
    drag.threshold: row.px(8)
    onPositionChanged: function(mouse) { if (!drag.active) row.hovered(row.index, row, mouse) }
    onClicked: row.clicked(row.index)
  }
}
