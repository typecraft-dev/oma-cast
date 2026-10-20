import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import qs.Ui

// Launcher surface (SPEC §5.1, §10.2): 750×475 at uiZoom 1, 66 px search
// header, 42 px footer, centred horizontally about a quarter down the
// screen, coloured by the active Omarchy theme's [menu] tokens.
//
// Views form a navigation stack: root search, a pushed Omarchy submenu, or
// the alias editor. Each view keeps its own query.
OverlayWindow {
  id: window

  required property var backend
  property var appLibrary: null

  signal dismissRequested()

  WlrLayershell.namespace: "oma-cast"

  // ------------------------------------------------------------ settings
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

  // --------------------------------------------------------------- state
  property var stack: [{ kind: "root", title: "oma-cast", query: "" }]
  readonly property var view: window.stack[window.stack.length - 1]
  property string query: ""
  property int selectedIndex: -1
  property var selectedRow: null
  property bool actionPanelOpen: false
  property var actions: []
  property var toast: null
  property int historyIndex: -1
  // A file row is being dragged out: hide the card and let the pointer pass
  // through the fullscreen surface, so the app underneath receives the drop.
  property bool draggingOut: false

  mask: window.draggingOut ? passThrough : null
  // Hyprland keeps pointer focus on a layer with exclusive keyboard focus,
  // so the drop would never reach the window underneath; let go while dragging.
  shownKeyboardFocus: window.draggingOut ? WlrKeyboardFocus.None : WlrKeyboardFocus.Exclusive
  Region { id: passThrough }

  readonly property bool atRoot: window.stack.length === 1
  readonly property bool compact: window.general.windowMode === "compact" && window.atRoot && !window.query
  readonly property string placeholder: window.view.kind === "alias" ? "Type an alias, then press ↵"
    : (window.view.kind === "menu" ? "Search " + window.view.title + "…"
    : (window.view.kind === "files" ? "Search files and folders…" : "Search for apps, commands and files…"))

  readonly property int cardWidth: Math.min(px(750), width - Style.gapsOut * 2)
  readonly property int fullHeight: Math.min(px(475), height - Style.gapsOut * 2)
  readonly property int headerHeight: px(66)
  readonly property int footerHeight: px(42)

  ListModel { id: rows }

  PointerMoveGate {
    id: pointerGate
    referenceItem: card
  }

  // ----------------------------------------------------------- lifecycle

  // Called on every open, before the surface maps.
  function prepare(payload) {
    popTimer.stop()
    window.draggingOut = false
    if (typeof payload.query === "string") window.query = payload.query
    window.actionPanelOpen = false
    window.historyIndex = -1
    window.rebuild(true)
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  // The shell hid us: start the pop-to-root clock (SPEC §5.1).
  onShownChanged: {
    // A drag whose row was destroyed mid-flight never reports its end; never
    // let that leave the next open invisible and click-through.
    window.draggingOut = false
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
    window.query = ""
    window.rebuild(true)
  }

  // ---------------------------------------------------------- navigation

  function push(next) {
    var saved = window.stack.slice()
    saved[saved.length - 1] = Object.assign({}, window.view, { query: window.query, selectedIndex: window.selectedIndex })
    window.stack = saved.concat([next])
    window.query = next.kind === "alias" ? (next.value || "") : ""
    window.rebuild(true)
  }

  function pop() {
    if (window.atRoot) return
    var next = window.stack.slice(0, -1)
    var top = next[next.length - 1]
    window.stack = next
    window.query = top.query || ""
    window.rebuild(false)
    if (top.selectedIndex >= 0) window.select(top.selectedIndex)
  }

  // ---------------------------------------------------------------- rows

  function rebuild(resetSelection) {
    pointerGate.reset()
    // A selection still on the top row follows the top row, so rows that
    // arrive late (file search) take the top instead of pushing it down.
    var onTop = window.selectedIndex >= 0 && window.selectedIndex === window.nextSelectable(-1, 1)
    var keepId = !resetSelection && !onTop && window.selectedRow ? window.selectedRow.itemId : ""
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
        rows.append(window.rowData(c, "item"))
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
      path: String(c.path || "")
    }
  }

  function nextSelectable(from, direction) {
    for (var i = from + direction; i >= 0 && i < rows.count; i += direction)
      if (rows.get(i).rowKind === "item") return i
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
      if (rows.get(i).rowKind !== "item") continue
      if (++seen === n) return i
    }
    return -1
  }

  // ------------------------------------------------------------- actions

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
      // [I] A launch clears the root search, so the next open starts fresh
      // instead of appending to the old query. Pushed views stay until
      // pop-to-root, as the reference describes.
      if (window.atRoot) window.setQuery("")
      return
    }
    if (outcome.toast) window.showToast(outcome.toast.style, outcome.toast.title)
    window.rebuild(false)
  }

  // nth action of the selected row: 0 primary (↵), 1 secondary (Ctrl ↵).
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

  function saveAlias() {
    var r = window.backend.callSync("settings.updateCommandSettings", { commandId: window.view.commandId, alias: window.query })
    if (!r.ok) { window.showToast("failure", r.error); return }
    var saved = window.query.trim()
    window.pop()
    window.showToast("success", saved ? "Alias saved" : "Alias removed")
    window.rebuild(false)
  }

  // ------------------------------------------------------------ feedback

  function showToast(style, title) {
    window.toast = { style: style, title: String(title || "") }
    toastTimer.restart()
  }

  Timer {
    id: toastTimer
    interval: 2500
    onTriggered: window.toast = null
  }

  // While hidden, a toast becomes a HUD: Omarchy's OSD pill. [D]
  function hud(text) {
    Quickshell.execDetached(["omarchy-shell", "osd", "show", JSON.stringify({ icon: "", message: String(text), duration: 1500 })])
  }

  // ----------------------------------------------------------- the query

  function setQuery(next) {
    if (window.query === next) return
    window.query = next
    window.historyIndex = -1
    window.rebuild(true)
  }

  // ↑ on an empty root walks back through queries that launched something.
  function recallHistory(direction) {
    var r = window.backend.callSync("rootSearch.getSearchHistory", null)
    var history = r.ok ? r.data : []
    if (history.length === 0) return false
    var next = Math.max(-1, Math.min(history.length - 1, window.historyIndex + direction))
    if (next === window.historyIndex) return true
    window.query = next < 0 ? "" : history[next]
    window.rebuild(true)
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
    // pop-back-or-close [O]: clear the search, then go back, then close.
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
    // Zoom in / out / reset (SPEC §10.3), persisted as uiZoom. [I] step 0.1
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
      if (ctrl && shift && key === Qt.Key_C) { window.performIfOffered(["copy-command", "copy-id", "copy-path"]); return true }
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

  // Ranking inputs changed (apps installed, guards answered, favourites
  // edited): refresh what is on screen without losing the selection.
  Connections {
    target: window.backend
    function onCandidatesRevisionChanged() { if (window.shown && !window.actionPanelOpen) window.rebuild(false) }
  }

  // ================================================================== UI

  // Clicking outside the card is the layer-shell form of focus loss.
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
    opacity: window.draggingOut ? 0 : 1

    MouseArea { anchors.fill: parent; onClicked: { window.actionPanelOpen = false; keyCatcher.forceActiveFocus() } }

    Item {
      id: keyCatcher
      anchors.fill: parent
      focus: true
      Keys.priority: Keys.BeforeItem
      Keys.onPressed: function(event) { if (window.handleKey(event)) event.accepted = true }
    }

    // -------------------------------------------------------- header
    Item {
      id: header
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.topMargin: card.borderTop
      anchors.leftMargin: card.borderLeft
      anchors.rightMargin: card.borderRight
      height: window.headerHeight

      // Omarchy logo at the root, a back arrow inside pushed views.
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

      // 2 px loading bar under the header (SPEC §10.2).
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

    // ---------------------------------------------------------- body
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
          // Only a real pointer move selects: a row sliding under a still
          // pointer (open, typing, scrolling) must not steal the cursor.
          onHovered: function(i, item, mouse) { if (!window.actionPanelOpen && pointerGate.moved(item, mouse)) window.select(i) }
          onClicked: function(i) { window.perform("open", i) }
          onDragStarted: function(i) { window.select(i); window.actionPanelOpen = false; window.draggingOut = true }
          // A drop somewhere else is done with the launcher; a cancelled drag brings it back.
          onDragEnded: function(dropped) {
            window.draggingOut = false
            if (dropped) window.dismissRequested()
          }
        }
      }

      // Empty states.
      Column {
        anchors.centerIn: parent
        spacing: window.px(8)
        visible: window.view.kind === "alias" || rows.count === 0

        Text {
          anchors.horizontalCenter: parent.horizontalCenter
          textFormat: Text.PlainText
          text: window.view.kind === "alias" ? "" : ""
          color: window.look.accent
          font.family: window.view.kind === "alias" ? window.look.fontFamily : "omarchy"
          font.pixelSize: window.px(28)
        }
        Text {
          anchors.horizontalCenter: parent.horizontalCenter
          textFormat: Text.PlainText
          text: window.view.kind === "alias" ? window.view.title
            : (!window.backend.ready ? "Loading…"
            : (window.view.kind !== "files" ? "No results"
            : (window.query.trim().length < 2 ? "Search your home folder" : (window.backend.loading ? "Searching…" : "No files found"))))
          color: window.look.foreground
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.title * window.zoom)
        }
        Text {
          anchors.horizontalCenter: parent.horizontalCenter
          textFormat: Text.PlainText
          text: window.view.kind === "alias" ? "Typing the alias exactly in the root search puts this command on top. Leave it empty to remove it." : ""
          visible: text.length > 0
          color: window.look.foreground
          opacity: 0.55
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * window.zoom)
        }
      }
    }

    // -------------------------------------------------------- footer
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

      // Left: the active toast, or where we are.
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

      // Right: primary action ↵ | Actions Ctrl K.
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
