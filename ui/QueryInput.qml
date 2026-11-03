pragma ComponentBehavior: Bound

import QtQuick

TextInput {
  id: input

  property string placeholderText: ""
  property color accentColor: color

  clip: true
  selectByMouse: true

  Text {
    anchors.fill: parent
    textFormat: Text.PlainText
    text: input.placeholderText
    font: input.font
    color: input.color
    opacity: 0.45
    elide: Text.ElideLeft
    visible: !input.text && !input.preeditText
  }

  cursorDelegate: Rectangle {
    width: 2
    color: input.accentColor
    visible: input.cursorVisible

    SequentialAnimation on opacity {
      running: input.cursorVisible
      loops: Animation.Infinite
      NumberAnimation { to: 1; duration: 0 }
      PauseAnimation { duration: 530 }
      NumberAnimation { to: 0; duration: 0 }
      PauseAnimation { duration: 530 }
    }
  }
}
