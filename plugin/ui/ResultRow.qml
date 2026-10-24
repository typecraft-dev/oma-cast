import QtQuick
import Quickshell
import qs.Commons

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
  required property string calcInput
  required property string calcResult
  required property string calcInputCaption
  required property string calcResultCaption

  property bool selected: false
  property var look: null
  property var appLibrary: null
  property real zoom: 1

  signal hovered(int index, var item, var mouse)
  signal clicked(int index)

  readonly property bool isSection: row.rowKind === "section"
  readonly property bool isCalculator: row.rowKind === "calculator"
  function px(v) { return Math.round(Style.space(v) * row.zoom) }

  width: ListView.view ? ListView.view.width : 0
  height: row.isSection ? (row.title ? px(30) : px(6)) : (row.isCalculator ? px(118) : px(42))

  // The inline calculator (ref 04 §1 Calculator): question on the left,
  // answer on the right, each with a caption, an arrow between them.
  Rectangle {
    visible: row.isCalculator
    anchors.fill: parent
    radius: Math.max(Style.cornerRadius, row.px(6))
    color: row.selected ? row.look.selectedBackground : Util.alpha(row.look.foreground, 0.04)
    border.width: 1
    border.color: Util.alpha(row.look.foreground, row.selected ? 0 : 0.08)

    Repeater {
      model: row.isCalculator ? [
        { text: row.calcInput, caption: row.calcInputCaption, answer: false },
        { text: row.calcResult, caption: row.calcResultCaption, answer: true }
      ] : []

      delegate: Item {
        required property var modelData
        required property int index
        x: index === 0 ? 0 : parent.width / 2 + row.px(20)
        width: parent.width / 2 - row.px(20)
        height: parent.height

        Text {
          id: calcText
          textFormat: Text.PlainText
          anchors.horizontalCenter: parent.horizontalCenter
          anchors.verticalCenter: parent.verticalCenter
          anchors.verticalCenterOffset: -row.px(10)
          width: parent.width - row.px(24)
          horizontalAlignment: Text.AlignHCenter
          text: modelData.text
          color: modelData.answer && row.selected ? row.look.accent : row.look.foreground
          font.family: row.look.fontFamily
          font.pixelSize: Math.round(Style.font.heading * 1.25 * row.zoom)
          font.weight: modelData.answer ? Font.DemiBold : Font.Normal
          fontSizeMode: Text.HorizontalFit
          minimumPixelSize: Math.round(Style.font.body * row.zoom)
          elide: Text.ElideRight
        }

        Rectangle {
          visible: modelData.caption.length > 0
          anchors.horizontalCenter: parent.horizontalCenter
          anchors.top: calcText.bottom
          anchors.topMargin: row.px(8)
          width: Math.min(captionText.implicitWidth + row.px(16), parent.width - row.px(24))
          height: captionText.implicitHeight + row.px(6)
          radius: height / 2
          color: Util.alpha(row.look.foreground, 0.08)

          Text {
            id: captionText
            anchors.centerIn: parent
            width: Math.min(implicitWidth, parent.parent.width - row.px(40))
            textFormat: Text.PlainText
            text: modelData.caption
            color: row.look.foreground
            opacity: 0.7
            font.family: row.look.fontFamily
            font.pixelSize: Math.round(Style.font.caption * row.zoom)
            elide: Text.ElideRight
          }
        }
      }
    }

    Rectangle {
      anchors.centerIn: parent
      width: row.px(28)
      height: row.px(28)
      radius: width / 2
      color: Util.alpha(row.look.foreground, 0.08)
      Text {
        anchors.centerIn: parent
        textFormat: Text.PlainText
        text: "→"
        color: row.look.foreground
        opacity: 0.7
        font.family: row.look.fontFamily
        font.pixelSize: Math.round(Style.font.body * row.zoom)
      }
    }
  }

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
    visible: !row.isSection && !row.isCalculator
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

  MouseArea {
    anchors.fill: parent
    enabled: !row.isSection
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onPositionChanged: function(mouse) { row.hovered(row.index, row, mouse) }
    onClicked: row.clicked(row.index)
  }
}
