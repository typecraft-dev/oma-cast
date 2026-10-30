import QtQuick
import QtTest
import "../../plugin/ui"

Item {
  width: 500
  height: 100

  QueryInput {
    id: input
    width: 200
    height: 40
    font.pixelSize: 20
    text: tests.query
    placeholderText: "Search…"
    onTextEdited: tests.query = text
  }

  TestCase {
    id: tests
    name: "QueryInput"
    when: windowShown
    property string query: ""

    function init() {
      query = ""
      input.forceActiveFocus()
      verify(input.activeFocus)
    }

    function typeText(text) {
      for (var i = 0; i < text.length; i++) keyClick(text[i])
    }

    function test_issue25_insertAtCursor() {
      typeText("12+34")
      keyClick(Qt.Key_Left)
      keyClick(Qt.Key_Left)
      compare(input.cursorPosition, 3)
      typeText("5")
      compare(query, "12+534")
      compare(input.cursorPosition, 4)
      keyClick(Qt.Key_Right)
      typeText("6")
      compare(query, "12+5364")
    }

    function test_deleteAtCursor() {
      query = "12+34"
      keyClick(Qt.Key_Left)
      keyClick(Qt.Key_Backspace)
      compare(query, "12+4")
      keyClick(Qt.Key_Delete)
      compare(query, "12+")
    }

    function test_selectionReplacement() {
      query = "12+34"
      keyClick(Qt.Key_Left, Qt.ShiftModifier)
      keyClick(Qt.Key_Left, Qt.ShiftModifier)
      compare(input.selectedText, "34")
      typeText("5")
      compare(query, "12+5")
      keyClick(Qt.Key_A, Qt.ControlModifier)
      keyClick(Qt.Key_Backspace)
      compare(query, "")
    }

    function test_homeEndAndBoundaries() {
      query = "12+34"
      keyClick(Qt.Key_Home)
      keyClick(Qt.Key_Left)
      compare(input.cursorPosition, 0)
      typeText("5")
      compare(query, "512+34")
      keyClick(Qt.Key_End)
      keyClick(Qt.Key_Right)
      compare(input.cursorPosition, query.length)
    }

    function test_wordDeletion() {
      query = "first second third"
      keyClick(Qt.Key_Left, Qt.ControlModifier)
      compare(input.cursorPosition, 13)
      keyClick(Qt.Key_Backspace, Qt.ControlModifier)
      compare(query, "first third")
    }

    function test_externalQueryReplacement() {
      query = "old query"
      keyClick(Qt.Key_Home)
      query = "12+34"
      compare(input.cursorPosition, query.length)
      keyClick(Qt.Key_Left)
      typeText("5")
      compare(query, "12+354")
      query = ""
      compare(input.text, "")
      compare(input.cursorPosition, 0)
    }

    function test_focusPreservesCursor() {
      query = "12+34"
      keyClick(Qt.Key_Left)
      keyClick(Qt.Key_Left)
      input.focus = false
      input.forceActiveFocus()
      compare(input.cursorPosition, 3)
      typeText("5")
      compare(query, "12+534")
    }

    function test_unicodeDeletion() {
      query = "a😀b"
      keyClick(Qt.Key_Left)
      keyClick(Qt.Key_Backspace)
      compare(query, "ab")
      compare(input.cursorPosition, 1)
    }

    function test_longQueryScrollsWithCursor() {
      query = "1234567890".repeat(10)
      verify(input.contentWidth > input.width)
      verify(input.cursorRectangle.x >= 0 && input.cursorRectangle.x <= input.width)
      keyClick(Qt.Key_Home)
      verify(input.cursorRectangle.x >= 0 && input.cursorRectangle.x <= input.width)
      typeText("5")
      compare(query, "5" + "1234567890".repeat(10))
    }
  }
}
