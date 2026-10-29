import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "../core/Languages.js" as Languages
import "../core/Translate.js" as Translate

// Translate window (ref 04 §1 Translator): source text on the left, target
// language and the translation on the right. Runs translate-shell through the
// backend, which owns the process and the settings.
PanelWindow {
  id: window

  required property var backend
  property bool shown: false

  property string target: "English"
  property string sourceLanguage: "Auto"
  property string resultText: ""
  property string status: ""
  property bool translating: false
  property bool pickerOpen: false
  property string pickerSide: "target"
  property string languageFilter: ""
  property int languageIndex: 0

  signal dismissRequested()

  visible: window.shown
  anchors { top: true; bottom: true; left: true; right: true }
  color: "transparent"
  exclusionMode: ExclusionMode.Ignore
  WlrLayershell.namespace: "oma-cast-translate"
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive

  // Same zoom and typography scale as the launcher.
  readonly property var general: {
    window.backend.storeRevision
    var r = window.backend.ready ? window.backend.callSync("settings.getGeneralSettings", null) : null
    return r && r.ok ? r.data : ({ uiZoom: 1, navigationBindings: "emacs" })
  }
  readonly property real zoom: window.general.uiZoom > 0 ? window.general.uiZoom : 1
  function px(value) { return Math.round(Style.space(value) * window.zoom) }

  readonly property var look: ({
    background: Commons.Color.menu.background,
    foreground: Commons.Color.menu.text,
    accent: Commons.Color.menu.selectedText,
    selectedBackground: Commons.Color.menu.selectedBackground,
    fontFamily: Style.font.menuFamily
  })
  readonly property var borderSpec: Border.surfaceSpec("menu", "border", Commons.Color.menu.border, Math.max(1, Style.space(2)))

  readonly property int padding: window.px(18)
  readonly property int cardWidth: Math.min(window.px(750), width - Style.gapsOut * 2)
  readonly property int cardHeight: Math.min(window.px(475), height - Style.gapsOut * 2)
  readonly property int headerHeight: window.px(52)
  readonly property int footerHeight: window.px(42)
  readonly property int paneGap: window.px(28)

  readonly property int languageRowHeight: window.px(30)
  readonly property int languagePickerRows: 8
  readonly property int languageVisibleRows: Math.min(window.languagePickerRows, Math.max(1, window.languageList.length))
  readonly property int languagePickerHeight: window.languageRowHeight * window.languageVisibleRows + window.px(46)

  readonly property real pickerSpace: {
    var pane = window.pickerSide === "source" ? sourcePane : targetPane
    var button = window.pickerSide === "source" ? sourceLanguageButton : languageButton
    return Math.max(0, pane.height - button.y - button.height - window.px(6))
  }

  function resetLanguageFilter() {
    languageInput.text = ""
    window.languageFilter = ""
    window.languageIndex = 0
  }

  function load(text, language) {
    window.resultText = ""
    window.sourceLanguage = Translate.AUTO
    window.status = ""
    window.translating = false
    window.pickerOpen = false
    window.resetLanguageFilter()
    window.target = language || window.backend.translateTarget()
    sourceInput.text = String(text || "")
    Qt.callLater(function() {
      sourceInput.forceActiveFocus()
      sourceInput.cursorPosition = sourceInput.text.length
    })
  }

  function request() {
    var text = sourceInput.text.trim()
    if (!text) {
      window.resultText = ""
      window.status = "Type text to translate"
      return
    }
    window.status = ""
    var r = window.backend.callSync("translate.translate", {
      text: text,
      target: window.target,
      source: window.sourceLanguage
    })
    if (!r.ok) {
      window.translating = false
      window.status = r.error
      return
    }
    window.translating = true
  }

  function copyResult() {
    if (!window.resultText) return
    Quickshell.execDetached(["wl-copy", "--", window.resultText])
    window.dismissRequested()
  }

  function swap() {
    if (!window.resultText) return
    var oldSource = window.sourceLanguage
    var oldTarget = window.target
    sourceInput.text = window.resultText
    sourceInput.cursorPosition = sourceInput.text.length
    window.resultText = ""
    window.status = ""
    window.sourceLanguage = oldTarget
    if (oldSource !== Translate.AUTO) window.target = oldSource
    sourceInput.forceActiveFocus()
    window.request()
  }

  function chooseLanguage(name) {
    if (window.pickerSide === "source") {
      window.sourceLanguage = name
      window.pickerOpen = false
      window.resetLanguageFilter()
      sourceInput.forceActiveFocus()
      if (window.resultText && name !== Translate.AUTO) window.request()
      return
    }
    var r = window.backend.callSync("translate.setTarget", { language: name })
    if (!r.ok) {
      window.status = r.error
      return
    }
    window.target = r.data
    window.pickerOpen = false
    window.resetLanguageFilter()
    sourceInput.forceActiveFocus()
    if (window.resultText) window.request()
  }

  function closePicker() {
    window.pickerOpen = false
    window.resetLanguageFilter()
    sourceInput.forceActiveFocus()
  }

  function openPicker(side) {
    window.pickerSide = side || "target"
    window.pickerOpen = true
    window.resetLanguageFilter()
    var current = window.pickerSide === "source" ? window.sourceLanguage : window.target
    var index = window.languageList.indexOf(current)
    window.languageIndex = index >= 0 ? index : 0
    Qt.callLater(function() { languageInput.forceActiveFocus() })
  }

  function handleKey(event) {
    if (window.pickerOpen) {
      if (event.key === Qt.Key_Escape) { window.closePicker(); return true }
      if (event.key === Qt.Key_Down) { window.languageIndex = Math.min(window.languageIndex + 1, window.languageList.length - 1); return true }
      if (event.key === Qt.Key_Up) { window.languageIndex = Math.max(window.languageIndex - 1, 0); return true }
      if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
        var list = window.languageList
        if (list.length > 0) window.chooseLanguage(list[Math.min(window.languageIndex, list.length - 1)])
        return true
      }
      return false
    }
    if (event.key === Qt.Key_Escape) { window.dismissRequested(); return true }
    if (event.key === Qt.Key_L && (event.modifiers & Qt.ControlModifier)) {
      window.openPicker((event.modifiers & Qt.ShiftModifier) ? "source" : "target")
      return true
    }
    if (event.key === Qt.Key_S && (event.modifiers & Qt.ControlModifier)) { window.swap(); return true }
    if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
      if (event.modifiers & Qt.MetaModifier) { window.copyResult(); return true }
      if (event.modifiers & Qt.ShiftModifier) return false
      window.request()
      return true
    }
    if (event.key === Qt.Key_C && (event.modifiers & Qt.ShiftModifier) && (event.modifiers & Qt.ControlModifier)) { window.copyResult(); return true }
    if (event.key === Qt.Key_Tab) { resultArea.forceActiveFocus(); return true }
    if (event.key === Qt.Key_Backtab) { sourceInput.forceActiveFocus(); return true }
    return false
  }

  Connections {
    target: window.backend
    function onNotification(method, data) {
      if (method === "translate.ready") {
        window.translating = false
        window.resultText = data.text
        window.status = ""
        return
      }
      if (method === "translate.failed") {
        window.translating = false
        window.status = data.message
        return
      }
      if (method === "translate.detected") {
        if (window.sourceLanguage === Translate.AUTO && data.language && Languages.known(data.language) && data.text === sourceInput.text.trim()) {
          window.sourceLanguage = data.language
        }
        return
      }
    }
  }

  MouseArea {
    anchors.fill: parent
    onClicked: window.dismissRequested()
  }

  BorderSurface {
    id: card
    width: window.cardWidth
    height: window.cardHeight
    radius: Math.max(Style.cornerRadius, window.px(8))
    anchors.horizontalCenter: parent.horizontalCenter
    y: Math.max(Style.gapsOut, Math.min(Math.round(window.height / 4), window.height - window.cardHeight - Style.gapsOut))
    color: window.look.background
    borderSpec: window.borderSpec
    clip: true

    MouseArea { anchors.fill: parent; onClicked: sourceInput.forceActiveFocus() }

    Item {
      id: keyCatcher
      anchors.fill: parent
      focus: true
      Keys.priority: Keys.BeforeItem
      Keys.onPressed: function(event) { if (window.handleKey(event)) event.accepted = true }
    }

    Item {
      id: header
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      height: window.headerHeight

      Row {
        anchors.left: parent.left
        anchors.leftMargin: window.px(16)
        anchors.verticalCenter: parent.verticalCenter
        spacing: window.px(10)

        Text {
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: "󰗊"
          font.family: "omarchy"
          font.pixelSize: window.px(18)
          color: window.look.accent
        }

        Text {
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: "Translate"
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.title * window.zoom)
          color: window.look.foreground
        }
      }

      KeyHint {
        anchors.right: parent.right
        anchors.rightMargin: window.px(14)
        anchors.verticalCenter: parent.verticalCenter
        keys: "Esc"
        color: window.look.foreground
        pixelSize: Math.round(Style.font.caption * window.zoom)
        zoom: window.zoom
      }
    }

    Rectangle {
      id: headerRule
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: header.bottom
      height: Style.spacing.hairline
      color: Util.alpha(window.look.foreground, 0.12)
    }

    Item {
      id: body
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: headerRule.bottom
      anchors.bottom: footerRule.top

      Item {
        id: sourcePane
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        anchors.leftMargin: window.padding
        anchors.topMargin: window.px(8)
        anchors.bottomMargin: window.px(8)
        width: Math.round((parent.width - window.padding * 2 - window.paneGap) * 0.52)

        Text {
          id: sourceLabel
          textFormat: Text.PlainText
          text: "TEXT"
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.caption * window.zoom)
          font.weight: Font.DemiBold
          color: window.look.foreground
          opacity: 0.5
        }

        Rectangle {
          id: sourceLanguageButton
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: sourceLabel.bottom
          anchors.topMargin: window.px(6)
          height: window.px(30)
          radius: Math.max(Style.cornerRadius, window.px(6))
          color: Util.alpha(window.look.foreground, 0.04)
          border.width: 1
          border.color: window.pickerOpen && window.pickerSide === "source" ? window.look.accent : Util.alpha(window.look.foreground, 0.08)

          Text {
            anchors.left: parent.left
            anchors.leftMargin: window.px(14)
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: window.sourceLanguage
            font.family: window.look.fontFamily
            font.pixelSize: Math.round(Style.font.body * window.zoom)
            color: window.look.foreground
          }

          KeyHint {
            anchors.right: parent.right
            anchors.rightMargin: window.px(14)
            anchors.verticalCenter: parent.verticalCenter
            keys: "Ctrl+Shift+L"
            color: window.look.foreground
            pixelSize: Math.round(Style.font.caption * window.zoom)
            zoom: window.zoom
          }

          MouseArea {
            anchors.fill: parent
            onClicked: window.openPicker("source")
          }
        }

        Rectangle {
          id: sourceField
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: sourceLanguageButton.bottom
          anchors.topMargin: window.px(6)
          anchors.bottom: parent.bottom
          radius: Math.max(Style.cornerRadius, window.px(6))
          color: Util.alpha(window.look.foreground, 0.04)
          border.width: 1
          border.color: sourceInput.activeFocus ? window.look.accent : Util.alpha(window.look.foreground, 0.08)
          clip: true

          TextEdit {
            id: sourceInput
            anchors.fill: parent
            anchors.leftMargin: window.px(14)
            anchors.rightMargin: window.px(14)
            anchors.topMargin: window.px(10)
            anchors.bottomMargin: window.px(10)
            textFormat: TextEdit.PlainText
            wrapMode: TextEdit.Wrap
            selectByMouse: true
            color: window.look.foreground
            selectionColor: window.look.accent
            selectedTextColor: window.look.background
            font.family: window.look.fontFamily
            font.pixelSize: Math.round(Style.font.body * window.zoom)
            focus: true
            Keys.onPressed: function(event) { if (window.handleKey(event)) event.accepted = true }
          }

          Text {
            anchors.left: sourceInput.left
            anchors.right: sourceInput.right
            anchors.top: sourceInput.top
            textFormat: Text.PlainText
            text: "Type or paste text, then press Enter"
            font.family: window.look.fontFamily
            font.pixelSize: Math.round(Style.font.body * window.zoom)
            color: window.look.foreground
            opacity: 0.35
            visible: !sourceInput.text
          }
        }
      }

      Rectangle {
        id: bodyRule
        width: Style.spacing.hairline
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        anchors.topMargin: window.px(8)
        anchors.bottomMargin: window.px(8)
        anchors.left: sourcePane.right
        anchors.leftMargin: Math.round(window.paneGap / 2)
        color: Util.alpha(window.look.foreground, 0.12)
      }

      Item {
        id: targetPane
        anchors.left: bodyRule.right
        anchors.leftMargin: Math.round(window.paneGap / 2)
        anchors.right: parent.right
        anchors.rightMargin: window.padding
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        anchors.topMargin: window.px(8)
        anchors.bottomMargin: window.px(8)

        Text {
          id: targetLabel
          textFormat: Text.PlainText
          text: "TRANSLATE TO"
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.caption * window.zoom)
          font.weight: Font.DemiBold
          color: window.look.foreground
          opacity: 0.5
        }

        Rectangle {
          id: languageButton
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: targetLabel.bottom
          anchors.topMargin: window.px(6)
          height: window.px(30)
          radius: Math.max(Style.cornerRadius, window.px(6))
          color: Util.alpha(window.look.foreground, 0.04)
          border.width: 1
          border.color: window.pickerOpen && window.pickerSide === "target" ? window.look.accent : Util.alpha(window.look.foreground, 0.08)

          Text {
            anchors.left: parent.left
            anchors.leftMargin: window.px(14)
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: window.target
            font.family: window.look.fontFamily
            font.pixelSize: Math.round(Style.font.body * window.zoom)
            color: window.look.foreground
          }

          KeyHint {
            anchors.right: parent.right
            anchors.rightMargin: window.px(14)
            anchors.verticalCenter: parent.verticalCenter
            keys: "Ctrl+L"
            color: window.look.foreground
            pixelSize: Math.round(Style.font.caption * window.zoom)
            zoom: window.zoom
          }

          MouseArea {
            anchors.fill: parent
            onClicked: window.openPicker()
          }
        }

        Rectangle {
          id: resultField
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: languageButton.bottom
          anchors.topMargin: window.px(6)
          anchors.bottom: parent.bottom
          radius: Math.max(Style.cornerRadius, window.px(6))
          color: Util.alpha(window.look.foreground, 0.04)
          border.width: 1
          border.color: resultArea.activeFocus ? window.look.accent : Util.alpha(window.look.foreground, 0.08)
          clip: true

          TextEdit {
            id: resultArea
            anchors.fill: parent
            anchors.leftMargin: window.px(14)
            anchors.rightMargin: window.px(14)
            anchors.topMargin: window.px(10)
            anchors.bottomMargin: window.px(10)
            textFormat: TextEdit.PlainText
            wrapMode: TextEdit.Wrap
            readOnly: true
            selectByMouse: true
            text: window.resultText
            color: window.look.foreground
            selectionColor: window.look.accent
            selectedTextColor: window.look.background
            font.family: window.look.fontFamily
            font.pixelSize: Math.round(Style.font.body * window.zoom)
            Keys.onPressed: function(event) { if (window.handleKey(event)) event.accepted = true }
          }

          Text {
            anchors.left: resultArea.left
            anchors.right: resultArea.right
            anchors.top: resultArea.top
            textFormat: Text.PlainText
            text: window.translating ? "Translating…" : "Translation appears here"
            font.family: window.look.fontFamily
            font.pixelSize: Math.round(Style.font.body * window.zoom)
            color: window.look.foreground
            opacity: 0.35
            visible: !window.resultText
          }
        }
      }

      Rectangle {
        id: swapButton
        width: window.px(22)
        height: width
        anchors.horizontalCenter: bodyRule.horizontalCenter
        anchors.verticalCenter: parent.verticalCenter
        radius: width / 2
        color: swapArea.containsMouse ? Util.alpha(window.look.accent, 0.2) : window.look.background
        border.width: 1
        border.color: swapArea.containsMouse ? window.look.accent : Util.alpha(window.look.foreground, 0.25)
        opacity: window.resultText ? 1 : 0.35

        Text {
          anchors.centerIn: parent
          anchors.horizontalCenterOffset: window.px(1)
          textFormat: Text.PlainText
          text: "↔"
          font.family: window.look.fontFamily
          font.pixelSize: window.px(16)
          color: swapArea.containsMouse ? window.look.accent : window.look.foreground
          opacity: 0.85
        }

        MouseArea {
          id: swapArea
          anchors.fill: parent
          hoverEnabled: true
          enabled: window.resultText.length > 0
          cursorShape: Qt.PointingHandCursor
          onClicked: window.swap()
        }
      }

      Rectangle {
        id: picker
        anchors.left: window.pickerSide === "source" ? sourcePane.left : targetPane.left
        anchors.right: window.pickerSide === "source" ? sourcePane.right : targetPane.right
        anchors.top: window.pickerSide === "source" ? sourcePane.top : targetPane.top
        anchors.topMargin: (window.pickerSide === "source" ? sourceLanguageButton.y + sourceLanguageButton.height : languageButton.y + languageButton.height) + window.px(6)
        height: Math.min(window.languagePickerHeight, window.pickerSpace)
        visible: window.pickerOpen
        radius: Math.max(Style.cornerRadius, window.px(6))
        color: window.look.background
        border.width: 1
        border.color: window.look.accent
        clip: true

        TextInput {
          id: languageInput
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.leftMargin: window.px(14)
          anchors.rightMargin: window.px(14)
          anchors.topMargin: window.px(6)
          height: window.px(30)
          padding: 0
          verticalAlignment: TextInput.AlignVCenter
          clip: true
          color: window.look.foreground
          selectionColor: window.look.accent
          selectedTextColor: window.look.background
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.body * window.zoom)
          onTextChanged: { window.languageFilter = text; window.languageIndex = 0 }
          Keys.onPressed: function(event) { if (window.handleKey(event)) event.accepted = true }
        }

        Text {
          anchors.left: languageInput.left
          anchors.verticalCenter: languageInput.verticalCenter
          visible: !languageInput.text
          textFormat: Text.PlainText
          text: "Filter languages"
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.body * window.zoom)
          color: window.look.foreground
          opacity: 0.35
        }

        Rectangle {
          id: languageInputRule
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: languageInput.bottom
          anchors.leftMargin: window.px(14)
          anchors.rightMargin: window.px(14)
          height: Style.spacing.hairline
          color: Util.alpha(window.look.foreground, 0.12)
        }

        Rectangle {
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: languageInputRule.bottom
          anchors.bottom: parent.bottom
          anchors.margins: window.px(4)
          color: "transparent"
          clip: true

          ListView {
            id: languageView
            anchors.fill: parent
            model: window.languageList
            currentIndex: window.languageIndex
            clip: true
            onCurrentIndexChanged: if (currentIndex >= 0) positionViewAtIndex(currentIndex, ListView.Contain)
            delegate: Item {
              required property int index
              required property string modelData
              width: ListView.view.width
              height: window.languageRowHeight
              Rectangle {
                anchors.fill: parent
                anchors.leftMargin: window.px(3)
                anchors.rightMargin: window.px(3)
                radius: Math.max(Style.cornerRadius, window.px(4))
                color: index === window.languageIndex ? window.look.selectedBackground : "transparent"
              }
              Text {
                anchors.left: parent.left
                anchors.leftMargin: window.px(10)
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: modelData
                font.family: window.look.fontFamily
                font.pixelSize: Math.round(Style.font.body * window.zoom)
                color: index === window.languageIndex ? window.look.accent : window.look.foreground
              }
              MouseArea { anchors.fill: parent; onClicked: window.chooseLanguage(modelData) }
            }
          }
        }
      }
    }

    Rectangle {
      id: footerRule
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.bottom: footer.top
      height: Style.spacing.hairline
      color: Util.alpha(window.look.foreground, 0.12)
    }

    Item {
      id: footer
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      height: window.footerHeight

      Row {
        anchors.left: parent.left
        anchors.leftMargin: window.px(16)
        anchors.verticalCenter: parent.verticalCenter
        spacing: window.px(8)

        Text {
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: "󰗊"
          font.family: "omarchy"
          font.pixelSize: window.px(11)
          color: window.look.accent
        }

        Text {
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: window.status ? window.status : "Translate"
          color: window.status ? "#e06c75" : window.look.foreground
          opacity: 0.6
          elide: Text.ElideRight
          width: Math.min(implicitWidth, footer.width / 2)
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * window.zoom)
        }
      }

      Row {
        anchors.right: parent.right
        anchors.rightMargin: window.px(14)
        anchors.verticalCenter: parent.verticalCenter
        spacing: window.px(8)

        Text {
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: "Translate"
          color: window.look.foreground
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * window.zoom)
        }
        KeyHint {
          anchors.verticalCenter: parent.verticalCenter
          keys: "↵"
          color: window.look.foreground
          pixelSize: Math.round(Style.font.caption * window.zoom)
          zoom: window.zoom
        }
        Rectangle {
          anchors.verticalCenter: parent.verticalCenter
          width: 1
          height: window.px(14)
          color: Util.alpha(window.look.foreground, 0.2)
        }
        Text {
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: "Swap"
          color: window.look.foreground
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * window.zoom)
        }
        KeyHint {
          anchors.verticalCenter: parent.verticalCenter
          keys: "Ctrl+S"
          color: window.look.foreground
          pixelSize: Math.round(Style.font.caption * window.zoom)
          zoom: window.zoom
        }
        Rectangle {
          anchors.verticalCenter: parent.verticalCenter
          width: 1
          height: window.px(14)
          color: Util.alpha(window.look.foreground, 0.2)
        }
        Text {
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: "Copy"
          color: window.look.foreground
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * window.zoom)
        }
        KeyHint {
          anchors.verticalCenter: parent.verticalCenter
          keys: "Super+↵"
          color: window.look.foreground
          pixelSize: Math.round(Style.font.caption * window.zoom)
          zoom: window.zoom
        }
      }
    }
  }

  readonly property var languageList: {
    var list = Languages.matches(window.languageFilter)
    if (window.pickerSide === "source") {
      var query = window.languageFilter.trim().toLowerCase()
      if (!query || "auto".indexOf(query) === 0) list = [Translate.AUTO].concat(list)
    }
    return list
  }
}
