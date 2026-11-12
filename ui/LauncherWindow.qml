import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "../core/LauncherState.js" as LauncherState
import "../core/RootSearch.js" as RootSearch
import "../core/Rows.js" as Rows

// Omarchy 4.0.x dropped qs.Ui.OverlayWindow; this is the same full-screen
// overlay layer the shell's own emoji picker uses.
//
// The launcher's behaviour (view stack, selection, popups, toasts, keys)
// lives in core/LauncherState.js, shared with the macOS app. This file
// draws its state() and feeds it key events.
PanelWindow {
  id: window

  required property var backend
  property var appLibrary: null
  property bool shown: false
  readonly property bool busy: window.shown && window.backend.loading
  readonly property int loadingFeedbackDelay: 500
  property bool loadingVisible: false

  onBusyChanged: {
    window.loadingVisible = false
    if (window.busy) loadingDelay.restart()
    else loadingDelay.stop()
  }

  Timer {
    id: loadingDelay
    interval: window.loadingFeedbackDelay
    onTriggered: window.loadingVisible = window.busy
  }

  signal dismissRequested()

  visible: window.shown
  anchors { top: true; bottom: true; left: true; right: true }
  color: "transparent"
  exclusionMode: ExclusionMode.Ignore
  WlrLayershell.namespace: "omacast"
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive

  readonly property real zoom: window.st.zoom > 0 ? window.st.zoom : 1
  function px(value) { return Math.round(Style.space(value) * window.zoom) }

  readonly property var look: ({
    background: Commons.Color.menu.background,
    foreground: Commons.Color.menu.text,
    accent: Commons.Color.menu.selectedText,
    selectedBackground: Commons.Color.menu.selectedBackground,
    fontFamily: Style.font.menuFamily
  })
  readonly property var borderSpec: Border.surfaceSpec("menu", "border", Commons.Color.menu.border, Math.max(1, Style.space(2)))

  // ------------------------------------------------------------- state

  readonly property var core: LauncherState.create({
    platform: "omarchy",
    backend: window.backend,
    filters: RootSearch.FILTERS,
    missingArgument: RootSearch.missingArgument,
    // Omarchy's own text-editing keys, so the query edits like its menus.
    editText: function(e, value) { return Util.editsFilter(e.raw, value) ? Util.editedFilter(e.raw, value) : null },
    search: function(request, done) {
      var revision = window.backend.candidatesRevision
      window.backend.searchAsync(request, function(result) {
        if (revision === window.backend.candidatesRevision) done(result)
      })
    },
    cancelSearch: function() { window.backend.cancelSearch() },
    host: {
      dismiss: function() { window.dismissRequested() },
      show: function() { window.showRequested() },
      hud: function(text) { window.hud(text) },
      copy: function(text) { window.backend.copyText(text) },
      readClipboard: function() { return window.readClipboard() },
      later: function(ms, fn) { return window.later(ms, fn) },
      cancel: function(id) { window.cancelLater(id) },
      changed: function() { Qt.callLater(window.applyState) }
    }
  })

  signal showRequested()

  property var st: window.core.state()
  property int selectedIndex: -1
  // Read by the footer the way it always was (tests/loading-feedback.test.js).
  readonly property var toast: window.st.toast
  readonly property var view: window.st.view
  readonly property bool atRoot: window.st.atRoot
  readonly property bool popupOpen: !!window.st.popup
  readonly property string popupKind: window.st.popup ? window.st.popup.kind : ""

  ListModel { id: rows }

  PointerMoveGate {
    id: pointerGate
    referenceItem: card
  }

  function applyState() {
    var next = window.core.state()
    var previous = window.selectedIndex
    // ListModel roles hold plain values; arguments travel in state().arguments.
    Rows.update(rows, next.rows.map(function(r) {
      return {
        rowKind: r.rowKind, itemId: r.itemId, title: r.title, subtitle: r.subtitle, glyph: r.glyph,
        glyphFont: r.glyphFont, iconName: r.iconName, typeLabel: r.typeLabel, alias: r.alias, checked: r.checked,
        disabled: r.disabled, favorite: r.favorite, calcInput: r.calcInput, calcResult: r.calcResult,
        calcInputCaption: r.calcInputCaption, calcResultCaption: r.calcResultCaption
      }
    }))
    window.st = next
    window.selectedIndex = next.selectedIndex
    if (next.selectedIndex !== previous && next.selectedIndex >= 0) {
      var first = -1
      for (var i = 0; i < next.rows.length; i++) if (next.rows[i].rowKind !== "section") { first = i; break }
      if (next.selectedIndex === first) list.positionViewAtBeginning()
      else list.positionViewAtIndex(next.selectedIndex, ListView.Contain)
    }
  }

  function prepare(payload) {
    window.core.prepare(payload)
    window.applyState()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  onShownChanged: if (!window.shown) window.core.hidden()

  function popToRoot() { window.core.popToRoot() }
  function run(commandId) { return window.core.run(commandId) }

  // setTimeout for core/LauncherState.js.
  property var timers: ({})
  property int nextTimer: 1
  Component { id: timerComponent; Timer {} }

  function later(ms, fn) {
    var id = window.nextTimer++
    var timer = timerComponent.createObject(window, { interval: Math.max(0, ms) })
    timer.triggered.connect(function() {
      delete window.timers[id]
      timer.destroy()
      fn()
    })
    window.timers[id] = timer
    timer.start()
    return id
  }

  function cancelLater(id) {
    var timer = window.timers[id]
    if (!timer) return
    delete window.timers[id]
    timer.stop()
    timer.destroy()
  }

  function hud(text) {
    Quickshell.execDetached(["omarchy-shell", "osd", "show", JSON.stringify({ icon: "\uf00c", message: String(text), duration: 1500 })])
  }

  function readClipboard() {
    clipboardInput.clear()
    clipboardInput.paste()
    var text = clipboardInput.text
    clipboardInput.clear()
    return text
  }

  TextEdit {
    id: clipboardInput
    visible: false
    textFormat: TextEdit.PlainText
  }

  // Qt key event -> the event core/LauncherState.js reads. One Ctrl key is
  // both the command and the navigation modifier on Linux.
  function keyEvent(event) {
    var m = event.modifiers
    var k = event.key
    var name
    if (k === Qt.Key_Escape) name = "Escape"
    else if (k === Qt.Key_Return || k === Qt.Key_Enter) name = "Return"
    else if (k === Qt.Key_Up) name = "Up"
    else if (k === Qt.Key_Down) name = "Down"
    else if (k === Qt.Key_PageUp) name = "PageUp"
    else if (k === Qt.Key_PageDown) name = "PageDown"
    else if (k === Qt.Key_Tab || k === Qt.Key_Backtab) name = "Tab"
    else if (k === Qt.Key_Backspace) name = "Backspace"
    else if (k === Qt.Key_Insert) name = "Insert"
    else if (k === Qt.Key_Space) name = "Space"
    else if (k > 0x20 && k < 0x7f) name = String.fromCharCode(k).toLowerCase()
    else name = ""
    var ctrl = (m & Qt.ControlModifier) !== 0
    return {
      key: name, text: event.text || "", raw: event,
      primary: ctrl, control: ctrl, alt: (m & Qt.AltModifier) !== 0,
      shift: (m & Qt.ShiftModifier) !== 0 || k === Qt.Key_Backtab, meta: (m & Qt.MetaModifier) !== 0
    }
  }

  Connections {
    target: window.backend
    function onCandidatesRevisionChanged() { if (window.shown) window.core.refresh() }
    // Exchange rates or zone offsets arrived: re-evaluate a calculation on screen.
    function onCalculatorRevisionChanged() { if (window.shown && window.st.query) window.core.refresh() }
  }

  // ------------------------------------------------------------- drawing

  MouseArea {
    anchors.fill: parent
    onClicked: if (!window.backend.config.keepVisibleOnFocusLoss) window.dismissRequested()
  }

  BorderSurface {
    id: card
    readonly property int cardWidth: Math.min(window.px(750), window.width - Style.gapsOut * 2)
    readonly property int fullHeight: Math.min(window.px(475), window.height - Style.gapsOut * 2)
    readonly property int headerHeight: window.px(66)
    readonly property int footerHeight: window.px(42)
    width: card.cardWidth
    height: window.st.compact ? card.headerHeight + card.borderTop + card.borderBottom : card.fullHeight
    radius: Math.max(Style.cornerRadius, window.px(8))
    anchors.horizontalCenter: parent.horizontalCenter
    y: Math.max(Style.gapsOut, Math.min(Math.round(window.height / 4), window.height - card.fullHeight - Style.gapsOut))
    color: window.look.background
    borderSpec: window.borderSpec
    clip: true

    MouseArea { anchors.fill: parent; onClicked: { window.core.dismissPopups(); keyCatcher.forceActiveFocus() } }

    Item {
      id: keyCatcher
      anchors.fill: parent
      focus: true
      Keys.priority: Keys.BeforeItem
      Keys.onPressed: function(event) {
        pointerGate.reset()
        if (window.core.key(window.keyEvent(event))) event.accepted = true
      }
    }

    Item {
      id: header
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.topMargin: card.borderTop
      anchors.leftMargin: card.borderLeft
      anchors.rightMargin: card.borderRight
      height: card.headerHeight

      Item {
        id: lead
        width: window.px(28)
        height: window.px(28)
        anchors.left: parent.left
        anchors.leftMargin: window.px(18)
        anchors.verticalCenter: parent.verticalCenter

        Text {
          anchors.centerIn: parent
          textFormat: Text.PlainText
          text: window.atRoot ? "\ue900" : "\uf060"           // omarchy logo, nf-fa-arrow_left
          font.family: window.atRoot ? "omarchy" : window.look.fontFamily
          font.pixelSize: window.atRoot ? window.px(18) : window.px(15)
          color: window.atRoot ? window.look.accent : window.look.foreground
          opacity: window.atRoot ? 1 : 0.7
        }

        MouseArea {
          anchors.fill: parent
          enabled: !window.atRoot
          cursorShape: Qt.PointingHandCursor
          onClicked: window.core.pop()
        }
      }

      // Room left of the filter button; argument pills sit right after the
      // typed text (ref 04 §2.2 WidthSizer).
      readonly property real queryRoom: (filterButton.visible ? filterButton.x - window.px(12) : header.width - window.px(20)) - queryText.x

      Text {
        id: queryText
        textFormat: Text.PlainText
        x: lead.x + lead.width + window.px(12)
        width: Math.min(implicitWidth, header.queryRoom - (pills.visible ? pills.width + window.px(10) : 0))
        anchors.verticalCenter: parent.verticalCenter
        text: window.st.query || (pills.visible ? "" : window.st.placeholder)
        color: window.look.foreground
        opacity: window.st.query ? 1 : 0.45
        font.family: window.look.fontFamily
        font.pixelSize: Math.round(Style.font.heading * 1.15 * window.zoom)
        elide: Text.ElideLeft
      }

      Rectangle {
        width: Math.max(1, Style.space(2))
        height: queryText.font.pixelSize + Style.space(4)
        anchors.verticalCenter: parent.verticalCenter
        x: queryText.x + (window.st.query ? Math.min(queryText.contentWidth, queryText.width) + Style.space(1) : 0)
        color: window.look.accent
        visible: window.shown && !window.popupOpen && window.st.argFocus < 0

        SequentialAnimation on opacity {
          running: window.shown
          loops: Animation.Infinite
          NumberAnimation { to: 1; duration: 0 }
          PauseAnimation { duration: 530 }
          NumberAnimation { to: 0; duration: 0 }
          PauseAnimation { duration: 530 }
        }
      }

      Row {
        id: pills
        visible: window.st.arguments.length > 0
        x: queryText.x + (window.st.query ? queryText.width : 0) + window.px(10)
        anchors.verticalCenter: parent.verticalCenter
        spacing: window.px(6)

        Repeater {
          model: pills.visible ? window.st.arguments : []

          Rectangle {
            id: pill
            required property var modelData
            required property int index
            readonly property string value: pill.modelData.value
            readonly property bool focused: window.st.argFocus === index
            height: window.px(28)
            width: Math.min(window.px(220), pillText.implicitWidth + window.px(20))
            radius: Math.max(Style.cornerRadius, window.px(6))
            color: Util.alpha(window.look.foreground, pill.focused ? 0.12 : 0.06)
            border.width: 1
            border.color: pill.focused ? window.look.accent : Util.alpha(window.look.foreground, 0.15)

            Text {
              id: pillText
              anchors.left: parent.left
              anchors.leftMargin: window.px(10)
              anchors.right: parent.right
              anchors.rightMargin: window.px(10)
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: pill.value || (pill.modelData.placeholder + (pill.modelData.required ? "" : " (optional)"))
              opacity: pill.value ? 1 : 0.5
              color: window.look.foreground
              elide: Text.ElideLeft
              font.family: window.look.fontFamily
              font.pixelSize: Math.round(Style.font.body * window.zoom)
            }

            Rectangle {
              visible: pill.focused && window.shown
              width: Math.max(1, Style.space(2))
              height: pillText.font.pixelSize + Style.space(2)
              anchors.verticalCenter: parent.verticalCenter
              x: pillText.x + (pill.value ? Math.min(pillText.contentWidth, pillText.width) + Style.space(1) : 0)
              color: window.look.accent
            }

            MouseArea {
              anchors.fill: parent
              cursorShape: Qt.IBeamCursor
              onClicked: { window.core.clickArgument(pill.index); keyCatcher.forceActiveFocus() }
            }
          }
        }
      }

      Rectangle {
        id: filterButton
        visible: window.atRoot && !window.st.compact
        anchors.right: parent.right
        anchors.rightMargin: window.px(16)
        anchors.verticalCenter: parent.verticalCenter
        height: window.px(28)
        width: filterRow.implicitWidth + window.px(20)
        radius: Math.max(Style.cornerRadius, window.px(6))
        color: Util.alpha(window.look.foreground, window.popupKind === "dropdown" ? 0.12 : 0.06)
        border.width: 1
        border.color: Util.alpha(window.look.foreground, 0.12)

        Row {
          id: filterRow
          anchors.centerIn: parent
          spacing: window.px(6)

          Text {
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: window.st.filterTitle
            color: window.look.foreground
            opacity: window.st.rootFilter === "all" ? 0.7 : 1
            font.family: window.look.fontFamily
            font.pixelSize: Math.round(Style.font.bodySmall * window.zoom)
          }
          Text {
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: "▾"
            color: window.look.foreground
            opacity: 0.6
            font.pixelSize: Math.round(Style.font.bodySmall * window.zoom)
          }
        }

        MouseArea {
          anchors.fill: parent
          cursorShape: Qt.PointingHandCursor
          onClicked: { window.core.toggleDropdown(); keyCatcher.forceActiveFocus() }
        }
      }

      Rectangle {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        height: Style.spacing.hairline
        color: Util.alpha(window.look.foreground, 0.12)
        visible: !window.st.compact
      }
    }

    Item {
      id: body
      visible: !window.st.compact
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: header.bottom
      anchors.bottom: footer.top
      anchors.leftMargin: card.borderLeft + window.px(8)
      anchors.rightMargin: card.borderRight + window.px(8)

      ListView {
        id: list
        anchors.fill: parent
        anchors.topMargin: window.px(4)
        anchors.bottomMargin: window.px(4)
        visible: window.view.kind !== "alias"
        clip: true
        model: rows
        reuseItems: true
        boundsBehavior: Flickable.StopAtBounds

        delegate: ResultRow {
          selected: index === window.selectedIndex
          look: window.look
          appLibrary: window.appLibrary
          zoom: window.zoom
          onHovered: function(i, item, mouse) { if (!window.popupOpen && pointerGate.moved(item, mouse)) window.core.hover(i) }
          onClicked: function(i) { window.core.click(i) }
        }
      }

      Column {
        anchors.centerIn: parent
        spacing: window.px(8)
        visible: !!window.st.empty

        Text {
          anchors.horizontalCenter: parent.horizontalCenter
          textFormat: Text.PlainText
          text: window.view.kind === "alias" ? "\uf02b" : "\ue900"   // nf-fa-tag, omarchy logo
          color: window.look.accent
          font.family: window.view.kind === "alias" ? window.look.fontFamily : "omarchy"
          font.pixelSize: window.px(28)
        }
        Text {
          anchors.horizontalCenter: parent.horizontalCenter
          textFormat: Text.PlainText
          text: window.st.empty ? (window.st.empty.title === "No results" && !window.backend.ready ? "Loading…" : window.st.empty.title) : ""
          color: window.look.foreground
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.title * window.zoom)
        }
        Text {
          anchors.horizontalCenter: parent.horizontalCenter
          textFormat: Text.PlainText
          text: window.st.empty ? window.st.empty.subtitle : ""
          visible: text.length > 0
          color: window.look.foreground
          opacity: 0.55
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * window.zoom)
        }
      }
    }

    Rectangle {
      id: footer
      visible: !window.st.compact
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      anchors.bottomMargin: card.borderBottom
      anchors.leftMargin: card.borderLeft
      anchors.rightMargin: card.borderRight
      height: card.footerHeight
      color: Util.alpha(window.look.foreground, 0.04)

      Rectangle {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        height: Style.spacing.hairline
        color: Util.alpha(window.look.foreground, 0.12)
      }

      Row {
        anchors.left: parent.left
        anchors.leftMargin: window.px(16)
        anchors.verticalCenter: parent.verticalCenter
        spacing: window.px(8)

        Text {
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: window.toast ? (window.toast.style === "failure" ? "\uf071" : "\uf00c") : "\ue900"
          font.family: window.toast ? window.look.fontFamily : "omarchy"
          font.pixelSize: window.toast ? window.px(12) : window.px(11)
          color: window.toast && window.toast.style === "failure" ? "#e06c75" : window.look.accent
        }
        Text {
          id: footerStatus
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: window.toast ? window.toast.title : window.loadingVisible ? "Loading…" : window.view.title
          color: window.look.foreground
          opacity: window.toast ? 0.9 : 0.6
          elide: Text.ElideRight
          width: Math.min(implicitWidth, footer.width / 2)
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * window.zoom)
        }
        KeyHint {
          visible: !!window.toast && window.toast.hasActions
          anchors.verticalCenter: parent.verticalCenter
          keys: "Ctrl T"
          color: window.look.foreground
          zoom: window.zoom
        }
      }

      Row {
        id: footerActions
        anchors.right: parent.right
        anchors.rightMargin: window.px(14)
        anchors.verticalCenter: parent.verticalCenter
        spacing: window.px(8)

        Text {
          visible: !!window.st.primaryAction
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: window.st.primaryAction ? window.st.primaryAction.title : ""
          color: window.look.foreground
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * window.zoom)
        }
        KeyHint {
          visible: !!window.st.primaryAction
          anchors.verticalCenter: parent.verticalCenter
          keys: "↵"
          color: window.look.foreground
          zoom: window.zoom
        }
        Rectangle {
          visible: window.view.kind !== "alias"
          anchors.verticalCenter: parent.verticalCenter
          width: 1
          height: window.px(14)
          color: Util.alpha(window.look.foreground, 0.2)
        }
        Text {
          visible: window.view.kind !== "alias"
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: "Actions"
          color: window.look.foreground
          opacity: 0.7
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * window.zoom)
        }
        KeyHint {
          visible: window.view.kind !== "alias"
          anchors.verticalCenter: parent.verticalCenter
          keys: window.st.actionPanelKeys
          color: window.look.foreground
          zoom: window.zoom
        }
      }
    }

    // The action panel, the root dropdown and the toast actions are one
    // popup in core/LauncherState.js; only where it sits differs.
    Component {
      id: popupPanel
      ActionPanel {
        placeholder: window.st.popup ? window.st.popup.placeholder : ""
        actions: window.st.popup ? window.st.popup.actions.map(function(a) {
          return { id: a.id, title: a.title, shortcut: a.shortcut || "", section: a.section || "", icon: a.icon || " " }
        }) : []
        filter: window.st.popup ? window.st.popup.filter : ""
        selectedIndex: window.st.popup ? window.st.popup.selectedIndex : 0
        look: window.look
        zoom: window.zoom
        onPicked: function(index) { window.core.clickPopup(index) }
        onHovered: function(index) { window.core.hoverPopup(index) }
      }
    }

    Loader {
      active: window.popupKind === "actions"
      z: 10
      anchors.right: parent.right
      anchors.rightMargin: card.borderRight + window.px(10)
      anchors.bottom: footer.top
      anchors.bottomMargin: window.px(6)
      sourceComponent: popupPanel
    }

    Loader {
      active: window.popupKind === "dropdown"
      z: 10
      width: window.px(240)
      anchors.right: parent.right
      anchors.rightMargin: card.borderRight + window.px(10)
      anchors.top: header.bottom
      anchors.topMargin: window.px(4)
      sourceComponent: popupPanel
    }

    Loader {
      active: window.popupKind === "toast"
      z: 10
      width: window.px(280)
      anchors.left: parent.left
      anchors.leftMargin: card.borderLeft + window.px(10)
      anchors.bottom: footer.top
      anchors.bottomMargin: window.px(6)
      sourceComponent: popupPanel
    }

    Loader {
      active: !!window.st.about
      z: 10
      anchors.right: parent.right
      anchors.rightMargin: card.borderRight + window.px(10)
      anchors.bottom: footer.top
      anchors.bottomMargin: window.px(6)
      sourceComponent: InfoPanel {
        title: window.st.about ? window.st.about.title : ""
        rows: window.st.about ? window.st.about.rows : []
        look: window.look
        zoom: window.zoom
      }
    }

    Loader {
      active: !!window.st.alert
      z: 20
      anchors.fill: parent
      sourceComponent: Alert {
        spec: window.st.alert
        look: window.look
        zoom: window.zoom
        onConfirmed: window.core.confirmAlert()
        onCancelled: window.core.cancelAlert()
      }
    }
  }
}
