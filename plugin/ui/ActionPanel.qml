import QtQuick
import qs.Commons

Rectangle {
  id: panel

  property var actions: []
  property string filter: ""
  property string placeholder: "Search for actions…"
  property int selectedIndex: 0
  property var look: null
  property real zoom: 1

  signal activated(string actionId)

  function px(v) { return Math.round(Style.space(v) * panel.zoom) }

  readonly property var visibleActions: {
    var f = panel.filter.trim().toLowerCase()
    return panel.actions.filter(function(a) { return !f || a.title.toLowerCase().indexOf(f) >= 0 })
  }

  function move(delta) {
    var n = panel.visibleActions.length
    if (n === 0) return
    panel.selectedIndex = (panel.selectedIndex + delta + n) % n
    list.positionViewAtIndex(panel.selectedIndex, ListView.Contain)
  }

  function activateSelected() {
    var a = panel.visibleActions[panel.selectedIndex]
    if (a) panel.activated(a.id)
  }

  onFilterChanged: selectedIndex = 0
  onActionsChanged: selectedIndex = 0

  width: px(340)
  height: Math.min(px(360), list.contentHeight + searchRow.height + px(16))
  // Follow Hyprland like the native HUD (Style mirrors decoration:rounding).
  radius: Style.cornerRadius
  color: look.background
  border.width: 1
  border.color: Util.alpha(look.foreground, 0.15)

  MouseArea { anchors.fill: parent }

  ListView {
    id: list
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.bottom: separator.top
    anchors.margins: panel.px(6)
    clip: true
    model: panel.visibleActions
    boundsBehavior: Flickable.StopAtBounds

    delegate: Item {
      required property var modelData
      required property int index
      readonly property bool newSection: index > 0 && panel.visibleActions[index - 1].section !== modelData.section
      width: ListView.view.width
      height: panel.px(34) + (newSection ? panel.px(9) : 0)

      Rectangle {
        visible: parent.newSection
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.topMargin: panel.px(4)
        height: 1
        color: Util.alpha(panel.look.foreground, 0.1)
      }

      Rectangle {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        height: panel.px(34)
        radius: Style.cornerRadius
        color: index === panel.selectedIndex ? panel.look.selectedBackground : "transparent"

        Text {
          id: actionIcon
          anchors.left: parent.left
          anchors.leftMargin: panel.px(10)
          anchors.verticalCenter: parent.verticalCenter
          width: panel.px(18)
          horizontalAlignment: Text.AlignHCenter
          textFormat: Text.PlainText
          text: modelData.icon || ""
          color: panel.look.foreground
          opacity: 0.75
          font.family: modelData.icon === "" ? "omarchy" : panel.look.fontFamily
          font.pixelSize: panel.px(13)
        }

        Text {
          anchors.left: actionIcon.right
          anchors.leftMargin: panel.px(8)
          anchors.right: keys.left
          anchors.rightMargin: panel.px(8)
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: modelData.title
          color: panel.look.foreground
          elide: Text.ElideRight
          font.family: panel.look.fontFamily
          font.pixelSize: Math.round(Style.font.body * panel.zoom)
        }

        KeyHint {
          id: keys
          anchors.right: parent.right
          anchors.rightMargin: panel.px(8)
          anchors.verticalCenter: parent.verticalCenter
          keys: modelData.shortcut || ""
          color: panel.look.foreground
          fontFamily: panel.look.fontFamily
          zoom: panel.zoom
        }

        MouseArea {
          anchors.fill: parent
          hoverEnabled: true
          onPositionChanged: panel.selectedIndex = index
          onClicked: { panel.selectedIndex = index; panel.activateSelected() }
        }
      }
    }
  }

  Rectangle {
    id: separator
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: searchRow.top
    height: 1
    color: Util.alpha(panel.look.foreground, 0.1)
  }

  Item {
    id: searchRow
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    height: panel.px(38)

    Text {
      anchors.left: parent.left
      anchors.leftMargin: panel.px(14)
      anchors.right: parent.right
      anchors.rightMargin: panel.px(14)
      anchors.verticalCenter: parent.verticalCenter
      textFormat: Text.PlainText
      text: panel.filter || panel.placeholder
      opacity: panel.filter ? 1 : 0.45
      color: panel.look.foreground
      elide: Text.ElideLeft
      font.family: panel.look.fontFamily
      font.pixelSize: Math.round(Style.font.body * panel.zoom)
    }
  }
}
