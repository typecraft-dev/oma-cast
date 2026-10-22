import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "../core/Agent.js" as Agent

OverlayWindow {
  id: window

  required property var backend
  property var appLibrary: null

  signal dismissRequested()

  WlrLayershell.namespace: "oma-cast"

  readonly property var general: {
    window.backend.storeRevision
    var r = window.backend.ready ? window.backend.callSync("settings.getGeneralSettings", null) : null
    return r && r.ok ? r.data : ({ uiZoom: 1, windowMode: "expanded", escapeKeyBehavior: "pop-back-or-close", popToRootTimeout: 90 })
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

  property var stack: [{ kind: "root", title: "oma-cast", query: "" }]
  readonly property var view: window.stack[window.stack.length - 1]
  property string query: ""
  property int selectedIndex: -1
  property var selectedRow: null
  property bool actionPanelOpen: false
  property var actions: []
  property var toast: null
  property int historyIndex: -1

  readonly property bool atRoot: window.stack.length === 1
  readonly property bool compact: window.general.windowMode === "compact" && window.atRoot && !window.query
  readonly property string placeholder: window.view.kind === "alias" ? "Type an alias, then press ↵"
    : window.view.kind === "menu" ? "Search " + window.view.title + "…"
    : window.view.kind === "files" ? "Search files…"
    : window.view.kind === "calculator-history" ? "Search calculations…"
    : "Search for apps and commands…"

  readonly property var filesStatus: {
    window.backend.filesStatusRevision
    window.backend.ready
    window.backend.filesSettings.enabled
    var r = window.backend.callSync("files.status", null)
    return r.ok ? r.data : ({})
  }

  function emptyTitle() {
    if (window.view.kind === "alias") return window.view.title
    if (window.view.kind === "files") {
      var state = window.filesStatus.state
      if (state === "starting" || state === "scanning") return "Indexing…"
      if (state === "disabled") return "File search is off"
      if (state === "error") return "File search unavailable"
      return window.query ? "No files found" : "Type to search files"
    }
    if (window.view.kind === "calculator-history" && !window.query) return "No Calculations Yet"
    return window.backend.ready ? "No results" : "Loading…"
  }

  readonly property int cardWidth: Math.min(px(750), width - Style.gapsOut * 2)
  readonly property int fullHeight: Math.min(px(475), height - Style.gapsOut * 2)
  readonly property int headerHeight: px(66)
  readonly property int footerHeight: px(42)

  ListModel { id: rows }

  PointerMoveGate {
    id: pointerGate
    referenceItem: card
  }


  function prepare(payload) {
    popTimer.stop()
    if (typeof payload.query === "string") window.query = payload.query
    window.actionPanelOpen = false
    window.historyIndex = -1
    window.applyQuery(window.query)
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  onShownChanged: {
    if (window.shown) return
    window.actionPanelOpen = false
    var seconds = Number(window.general.popToRootTimeout)
    if (!(seconds > 0)) window.popToRoot()
    else { popTimer.interval = seconds * 1000; popTimer.restart() }
  }

  Timer {
    id: popTimer
    onTriggered: window.popToRoot()
  }

  function popToRoot() {
    window.stack = [{ kind: "root", title: "oma-cast", query: "" }]
    window.applyQuery("")
  }


  function push(next) {
    var saved = window.stack.slice()
    saved[saved.length - 1] = Object.assign({}, window.view, { query: window.query, selectedIndex: window.selectedIndex })
    window.stack = saved.concat([next])
    window.applyQuery(next.query !== undefined ? next.query : (next.kind === "alias" ? (next.value || "") : ""))
  }

  function pop() {
    if (window.atRoot) return
    var next = window.stack.slice(0, -1)
    var top = next[next.length - 1]
    window.stack = next
    window.query = top.query || ""
    window.rebuild(false)
    window.requestFilesForView()
    if (top.selectedIndex >= 0) window.select(top.selectedIndex)
  }


  function rebuild(resetSelection) {
    pointerGate.reset()
    var keepId = !resetSelection && window.selectedRow ? window.selectedRow.itemId : ""
    rows.clear()
    if (window.view.kind === "alias") { window.select(-1); return }
    var result = window.backend.callSync("rootSearch.search", { query: window.query, view: window.view })
    if (!result.ok) {
      window.showToast("failure", result.error)
      window.select(-1)
      return
    }
    var keepIndex = -1
    for (var s = 0; s < result.data.length; s++) {
      var section = result.data[s]
      if (section.title || s > 0) rows.append(window.rowData({ id: "section:" + section.id, title: section.title }, "section"))
      for (var r = 0; r < section.rows.length; r++) {
        var c = section.rows[r]
        if (c.id === keepId) keepIndex = rows.count
        rows.append(window.rowData(c, c.kind === "calculator" ? "calculator" : "item"))
      }
    }
    window.select(keepIndex >= 0 ? keepIndex : window.nextSelectable(-1, 1))
  }

  function rowData(c, kind) {
    return {
      rowKind: kind,
      itemId: String(c.id || ""),
      title: String(c.title || ""),
      subtitle: String(c.subtitle || ""),
      glyph: String(c.glyph || ""),
      glyphFont: String(c.glyphFont || ""),
      iconName: String(c.iconName || ""),
      typeLabel: String(c.typeLabel || ""),
      alias: String(c.alias || ""),
      checked: !!c.checked,
      disabled: !!c.disabled,
      favorite: typeof c.favoriteOrder === "number",
      calcInput: String(c.calcInput || ""),
      calcResult: String(c.calcResult || ""),
      calcInputCaption: String(c.calcInputCaption || ""),
      calcResultCaption: String(c.calcResultCaption || "")
    }
  }

  function isSelectable(index) {
    var kind = rows.get(index).rowKind
    return kind === "item" || kind === "calculator"
  }

  function nextSelectable(from, direction) {
    for (var i = from + direction; i >= 0 && i < rows.count; i += direction)
      if (window.isSelectable(i)) return i
    return -1
  }

  function select(index) {
    window.selectedIndex = index
    window.selectedRow = index >= 0 && index < rows.count ? rows.get(index) : null
    if (index >= 0) list.positionViewAtIndex(index, ListView.Contain)
    if (index === window.nextSelectable(-1, 1)) list.positionViewAtBeginning()
  }

  function move(delta) {
    pointerGate.reset()
    if (window.selectedIndex < 0) { window.select(window.nextSelectable(-1, 1)); return }
    var step = delta > 0 ? 1 : -1
    var target = window.selectedIndex
    for (var n = 0; n < Math.abs(delta); n++) {
      var next = window.nextSelectable(target, step)
      if (next < 0) break
      target = next
    }
    window.select(target)
  }

  function jumpSection(direction) {
    var i = window.selectedIndex
    for (i += direction; i >= 0 && i < rows.count; i += direction)
      if (rows.get(i).rowKind === "section") break
    if (direction < 0) {
      for (i -= 1; i >= 0; i--) if (rows.get(i).rowKind === "section") break
    }
    var first = window.nextSelectable(Math.max(-1, i), 1)
    if (first >= 0) window.select(first)
  }

  function nthItem(n) {
    var seen = 0
    for (var i = 0; i < rows.count; i++) {
      if (!window.isSelectable(i)) continue
      if (++seen === n) return i
    }
    return -1
  }


  function actionsForSelected() {
    if (!window.selectedRow) return []
    var r = window.backend.callSync("rootSearch.getActions", { id: window.selectedRow.itemId })
    return r.ok ? r.data : []
  }

  function perform(actionId, index) {
    if (index !== undefined && index >= 0) window.select(index)
    if (!window.selectedRow) return
    var id = window.selectedRow.itemId
    window.actionPanelOpen = false
    var r = window.backend.callSync("rootSearch.performAction", { id: id, action: actionId, query: window.query })
    if (!r.ok) { window.showToast("failure", r.error); return }
    var outcome = r.data || {}
    if (outcome.push) { window.push(outcome.push); return }
    if (outcome.close) {
      if (outcome.hud) window.hud(outcome.hud)
      window.dismissRequested()
      if (window.atRoot) window.setQuery("")
      return
    }
    if (outcome.toast) window.showToast(outcome.toast.style, outcome.toast.title)
    window.rebuild(false)
  }

  function performNth(n) {
    var list = window.actionsForSelected()
    if (list.length > n) window.perform(list[n].id)
  }

  function performIfOffered(actionIds) {
    var list = window.actionsForSelected()
    for (var i = 0; i < list.length; i++) if (actionIds.indexOf(list[i].id) >= 0) { window.perform(list[i].id); return true }
    return false
  }

  function toggleActionPanel() {
    if (window.actionPanelOpen) { window.actionPanelOpen = false; return }
    window.actions = window.actionsForSelected()
    actionPanel.filter = ""
    window.actionPanelOpen = window.actions.length > 0
  }

  function askAgent() {
    var r = window.backend.callSync("rootSearch.performAction", { id: Agent.FALLBACK_ID, action: "open", query: window.query })
    if (!r.ok) window.showToast("failure", r.error)
  }

  function saveAlias() {
    var r = window.backend.callSync("settings.updateCommandSettings", { commandId: window.view.commandId, alias: window.query })
    if (!r.ok) { window.showToast("failure", r.error); return }
    var saved = window.query.trim()
    window.pop()
    window.showToast("success", saved ? "Alias saved" : "Alias removed")
    window.rebuild(false)
  }


  function showToast(style, title) {
    window.toast = { style: style, title: String(title || "") }
    toastTimer.restart()
  }

  Timer {
    id: toastTimer
    interval: 2500
    onTriggered: window.toast = null
  }

  function hud(text) {
    Quickshell.execDetached(["omarchy-shell", "osd", "show", JSON.stringify({ icon: "", message: String(text), duration: 1500 })])
  }


  // Every query entry point goes through here so the Files cache is kept in
  // step with the visible text (prepare, typing, history, push, pop).
  function applyQuery(next) {
    window.query = String(next || "")
    window.historyIndex = -1
    window.rebuild(true)
    window.requestFilesForView()
  }

  // Only the root and files views care about files; other views clear the
  // cache so a later query cannot leak stale rows into them.
  function requestFilesForView() {
    var wants = window.view.kind === "files"
      || (window.view.kind === "root" && window.backend.filesSettings.includeInRootSearch)
    window.backend.filesRequest(wants ? window.query : "")
  }

  function setQuery(next) {
    if (window.query === next) return
    window.applyQuery(next)
  }

  function recallHistory(direction) {
    var r = window.backend.callSync("rootSearch.getSearchHistory", null)
    var history = r.ok ? r.data : []
    if (history.length === 0) return false
    var next = Math.max(-1, Math.min(history.length - 1, window.historyIndex + direction))
    if (next === window.historyIndex) return true
    window.applyQuery(next < 0 ? "" : history[next])
    window.historyIndex = next
    return true
  }

  function setZoom(value) {
    var z = Math.round(Math.max(0.8, Math.min(1.5, value)) * 10) / 10
    window.backend.callSync("settings.updateGeneralSettings", { uiZoom: z })
  }

  function handleEscape(shift) {
    if (window.actionPanelOpen) { window.actionPanelOpen = false; return }
    if (shift) { window.popToRoot(); return }
    if (window.general.escapeKeyBehavior === "close-and-pop-to-root") {
      window.dismissRequested()
      window.popToRoot()
      return
    }
    if (window.query && window.view.kind !== "alias") window.setQuery("")
    else if (!window.atRoot) window.pop()
    else window.dismissRequested()
  }

  function handleKey(event) {
    var ctrl = (event.modifiers & Qt.ControlModifier) !== 0
    var shift = (event.modifiers & Qt.ShiftModifier) !== 0
    var alt = (event.modifiers & Qt.AltModifier) !== 0
    var key = event.key
    var enter = key === Qt.Key_Return || key === Qt.Key_Enter

    if (key === Qt.Key_Escape) { window.handleEscape(shift); return true }
    if (ctrl && (key === Qt.Key_Plus || key === Qt.Key_Equal)) { window.setZoom(window.zoom + 0.1); return true }
    if (ctrl && key === Qt.Key_Minus) { window.setZoom(window.zoom - 0.1); return true }
    if (ctrl && key === Qt.Key_0) { window.setZoom(1); return true }
    if (ctrl && key === Qt.Key_BracketLeft) { window.pop(); return true }

    if (window.actionPanelOpen) {
      if (ctrl && key === Qt.Key_K) { window.actionPanelOpen = false; return true }
      if (key === Qt.Key_Down || (ctrl && key === Qt.Key_N)) { actionPanel.move(1); return true }
      if (key === Qt.Key_Up || (ctrl && key === Qt.Key_P)) { actionPanel.move(-1); return true }
      if (enter) { actionPanel.activateSelected(); return true }
      if (Util.editsFilter(event, actionPanel.filter)) { actionPanel.filter = Util.editedFilter(event, actionPanel.filter); return true }
      if (window.isTyping(event)) { actionPanel.filter += event.text; return true }
      return true
    }

    if (window.view.kind === "alias") {
      if (enter) { window.saveAlias(); return true }
      if (key === Qt.Key_Space) return true
    } else {
      if (window.atRoot && enter && ctrl && alt && !shift) { window.askAgent(); return true }
      if (ctrl && key === Qt.Key_K) { window.toggleActionPanel(); return true }
      if (enter && ctrl && shift) { window.performNth(2); return true }
      if (enter && ctrl) { window.performNth(1); return true }
      if (enter) { window.performNth(0); return true }
      if (ctrl && alt && key === Qt.Key_Up) { window.performIfOffered(["favorite-up"]); return true }
      if (ctrl && alt && key === Qt.Key_Down) { window.performIfOffered(["favorite-down"]); return true }
      if (ctrl && key === Qt.Key_Up) { window.jumpSection(-1); return true }
      if (ctrl && key === Qt.Key_Down) { window.jumpSection(1); return true }
      if (key === Qt.Key_Up || (ctrl && key === Qt.Key_P)) {
        if (window.atRoot && (window.query === "" || window.historyIndex >= 0) && window.selectedIndex === window.nextSelectable(-1, 1) && window.recallHistory(1)) return true
        window.move(-1); return true
      }
      if (key === Qt.Key_Down || (ctrl && key === Qt.Key_N)) {
        if (window.historyIndex >= 0) { window.recallHistory(-1); return true }
        window.move(1); return true
      }
      if (key === Qt.Key_PageUp) { window.move(-8); return true }
      if (key === Qt.Key_PageDown) { window.move(8); return true }
      if (ctrl && shift && key === Qt.Key_F) { window.performIfOffered(["favorite-add", "favorite-remove"]); return true }
      if (ctrl && shift && key === Qt.Key_C) { window.performIfOffered(["copy-command", "copy-id", "copy-path", "copy-question-answer"]); return true }
      if (ctrl && shift && key === Qt.Key_D) { window.performIfOffered(["delete-all-entries"]); return true }
      if (ctrl && key === Qt.Key_D) { window.performIfOffered(["delete-entry"]); return true }
      if (alt && shift && key === Qt.Key_D) { window.performIfOffered(["disable"]); return true }
      if (ctrl && key >= Qt.Key_1 && key <= Qt.Key_9) {
        var target = window.nthItem(key - Qt.Key_0)
        if (target >= 0) window.perform("open", target)
        return true
      }
    }

    if (Util.editsFilter(event, window.query)) { window.setQuery(Util.editedFilter(event, window.query)); return true }
    if (key === Qt.Key_Backspace && !window.query && !window.atRoot) { window.pop(); return true }
    if (window.isTyping(event)) { window.setQuery(window.query + event.text); return true }
    return false
  }

  function isTyping(event) {
    return event.text && event.text.length === 1 && event.text.charCodeAt(0) >= 32 && event.text.charCodeAt(0) !== 127
      && (event.modifiers === Qt.NoModifier || event.modifiers === Qt.ShiftModifier)
  }

  Connections {
    target: window.backend
    function onCandidatesRevisionChanged() { if (window.shown && !window.actionPanelOpen) window.rebuild(false) }
    function onFilesRevisionChanged() {
      if (!window.shown || window.actionPanelOpen) return
      var y = list.contentY
      window.rebuild(false)
      list.contentY = y
    }
    function onFilesHelperUnavailable() {
      window.showToast("failure", "File search helper missing — run: oma-cast files build")
    }
    function onNotification(method, data) {
      if (method === "agent.launchFailed" && window.shown) window.showToast("failure", data.message)
    }
    // Exchange rates or zone offsets arrived: re-evaluate a calculation on screen.
    function onCalculatorRevisionChanged() { if (window.shown && !window.actionPanelOpen && window.query) window.rebuild(false) }
  }


  MouseArea {
    anchors.fill: parent
    onClicked: if (!window.backend.config.keepVisibleOnFocusLoss) window.dismissRequested()
  }

  BorderSurface {
    id: card
    width: window.cardWidth
    height: window.compact ? window.headerHeight + card.borderTop + card.borderBottom : window.fullHeight
    radius: Math.max(Style.cornerRadius, window.px(8))
    anchors.horizontalCenter: parent.horizontalCenter
    y: Math.max(Style.gapsOut, Math.min(Math.round(window.height / 4), window.height - window.fullHeight - Style.gapsOut))
    color: window.look.background
    borderSpec: window.borderSpec
    clip: true

    MouseArea { anchors.fill: parent; onClicked: { window.actionPanelOpen = false; keyCatcher.forceActiveFocus() } }

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
      anchors.topMargin: card.borderTop
      anchors.leftMargin: card.borderLeft
      anchors.rightMargin: card.borderRight
      height: window.headerHeight

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
          text: window.atRoot ? "" : ""
          font.family: window.atRoot ? "omarchy" : window.look.fontFamily
          font.pixelSize: window.atRoot ? window.px(18) : window.px(15)
          color: window.atRoot ? window.look.accent : window.look.foreground
          opacity: window.atRoot ? 1 : 0.7
        }

        MouseArea {
          anchors.fill: parent
          enabled: !window.atRoot
          cursorShape: Qt.PointingHandCursor
          onClicked: window.pop()
        }
      }

      Text {
        id: queryText
        textFormat: Text.PlainText
        anchors.left: lead.right
        anchors.leftMargin: window.px(12)
        anchors.right: parent.right
        anchors.rightMargin: window.px(20)
        anchors.verticalCenter: parent.verticalCenter
        text: window.query || window.placeholder
        color: window.look.foreground
        opacity: window.query ? 1 : 0.45
        font.family: window.look.fontFamily
        font.pixelSize: Math.round(Style.font.heading * 1.15 * window.zoom)
        elide: Text.ElideLeft
      }

      Rectangle {
        width: Math.max(1, Style.space(2))
        height: queryText.font.pixelSize + Style.space(4)
        anchors.verticalCenter: parent.verticalCenter
        x: queryText.x + (window.query ? Math.min(queryText.contentWidth, queryText.width) + Style.space(1) : 0)
        color: window.look.accent
        visible: window.shown && !window.actionPanelOpen

        SequentialAnimation on opacity {
          running: window.shown
          loops: Animation.Infinite
          NumberAnimation { to: 1; duration: 0 }
          PauseAnimation { duration: 530 }
          NumberAnimation { to: 0; duration: 0 }
          PauseAnimation { duration: 530 }
        }
      }

      Rectangle {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        height: Style.spacing.hairline
        color: Util.alpha(window.look.foreground, 0.12)
        visible: !window.compact

        Rectangle {
          id: loader
          visible: window.backend.loading && window.shown
          height: Math.max(2, Style.space(2))
          width: parent.width / 4
          anchors.verticalCenter: parent.verticalCenter
          color: window.look.accent
          NumberAnimation on x {
            running: loader.visible
            loops: Animation.Infinite
            from: -loader.width
            to: header.width
            duration: 900
          }
        }
      }
    }

    Item {
      id: body
      visible: !window.compact
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
        boundsBehavior: Flickable.StopAtBounds

        delegate: ResultRow {
          selected: index === window.selectedIndex
          look: window.look
          appLibrary: window.appLibrary
          zoom: window.zoom
          onHovered: function(i, item, mouse) { if (!window.actionPanelOpen && pointerGate.moved(item, mouse)) window.select(i) }
          onClicked: function(i) { window.perform("open", i) }
        }
      }

      Column {
        anchors.centerIn: parent
        spacing: window.px(8)
        visible: window.view.kind === "alias" || rows.count === 0

        Text {
          anchors.horizontalCenter: parent.horizontalCenter
          textFormat: Text.PlainText
          text: window.view.kind === "files" ? "\uf15b" : (window.view.kind === "alias" ? "" : "")
          color: window.look.accent
          font.family: window.view.kind === "files" ? window.look.fontFamily : (window.view.kind === "alias" ? window.look.fontFamily : "omarchy")
          font.pixelSize: window.px(28)
        }
        Text {
          anchors.horizontalCenter: parent.horizontalCenter
          textFormat: Text.PlainText
          text: window.emptyTitle()
          color: window.look.foreground
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.title * window.zoom)
        }
        Text {
          anchors.horizontalCenter: parent.horizontalCenter
          textFormat: Text.PlainText
          text: window.view.kind === "alias" ? "Typing the alias exactly in the root search puts this command on top. Leave it empty to remove it."
            : window.view.kind === "calculator-history" && !window.query ? "Type a calculation in the root search, then copy or paste the answer." : ""
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
      visible: !window.compact
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      anchors.bottomMargin: card.borderBottom
      anchors.leftMargin: card.borderLeft
      anchors.rightMargin: card.borderRight
      height: window.footerHeight
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
          text: window.toast ? (window.toast.style === "failure" ? "" : "") : ""
          font.family: window.toast ? window.look.fontFamily : "omarchy"
          font.pixelSize: window.toast ? window.px(12) : window.px(11)
          color: window.toast && window.toast.style === "failure" ? "#e06c75" : window.look.accent
        }
        Text {
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: window.toast ? window.toast.title : window.view.title
          color: window.look.foreground
          opacity: window.toast ? 0.9 : 0.6
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * window.zoom)
        }
      }

      Row {
        id: footerActions
        anchors.right: parent.right
        anchors.rightMargin: window.px(14)
        anchors.verticalCenter: parent.verticalCenter
        spacing: window.px(8)

        readonly property var primary: {
          window.selectedRow
          window.backend.storeRevision
          if (window.view.kind === "alias") return { title: "Save Alias", shortcut: "↵" }
          var list = window.actionsForSelected()
          return list.length ? list[0] : null
        }

        Text {
          visible: footerActions.primary !== null
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: footerActions.primary ? footerActions.primary.title : ""
          color: window.look.foreground
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * window.zoom)
        }
        KeyHint {
          visible: footerActions.primary !== null
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
          keys: "Ctrl K"
          color: window.look.foreground
          zoom: window.zoom
        }
      }
    }

    ActionPanel {
      id: actionPanel
      visible: window.actionPanelOpen
      z: 10
      anchors.right: parent.right
      anchors.rightMargin: card.borderRight + window.px(10)
      anchors.bottom: footer.top
      anchors.bottomMargin: window.px(6)
      actions: window.actions
      look: window.look
      zoom: window.zoom
      onActivated: function(actionId) { window.perform(actionId) }
    }
  }
}
