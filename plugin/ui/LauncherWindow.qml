import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "../core/Agent.js" as Agent
import "../core/RootSearch.js" as RootSearch
import "../core/Rows.js" as Rows

// Omarchy 4.0.x dropped qs.Ui.OverlayWindow; this is the same full-screen
// overlay layer the shell's own emoji picker uses.
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
  WlrLayershell.namespace: "oma-cast"
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive

  readonly property var general: {
    window.backend.storeRevision
    var r = window.backend.ready ? window.backend.callSync("settings.getGeneralSettings", null) : null
    return r && r.ok ? r.data : ({ uiZoom: 1, windowMode: "expanded", escapeKeyBehavior: "pop-back-or-close", popToRootTimeout: 90, navigationBindings: "emacs" })
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
  property int searchSerial: 0
  property bool searchPending: false
  property bool actionPanelOpen: false
  property var actions: []
  property var toast: null
  property int historyIndex: -1

  // Ctrl+P root filter (RootSearch.FILTERS), Ctrl+T toast actions,
  // Ctrl+Shift+K About panel and the confirm alert.
  property string rootFilter: "all"
  property bool dropdownOpen: false
  property bool toastPanelOpen: false
  property bool aboutOpen: false
  property var aboutRows: []
  property var alert: null

  // Inline argument pills for the selected command: argFocus -1 is the
  // search field, 0.. an argument.
  property var argDefs: []
  property var argValues: ({})
  property int argFocus: -1
  property string argsForId: ""

  // Navigation bindings (ref 04 §2.8): emacs moves with Ctrl+N (Ctrl+P is the
  // dropdown); vim-motions with Ctrl+J/K, which moves the action panel to
  // Alt+K. Ctrl+B/F and Ctrl+H/L move a text cursor in Raycast; our search
  // field has none, so they do nothing here. [D]
  readonly property bool vim: window.general.navigationBindings === "vim-motions"
  readonly property string actionPanelKeys: window.vim ? "Alt+K" : "Ctrl+K"

  readonly property bool atRoot: window.stack.length === 1
  readonly property bool compact: window.general.windowMode === "compact" && window.atRoot && !window.query
  readonly property string placeholder: window.view.kind === "alias" ? "Type an alias, then press ↵"
    : window.view.kind === "menu" ? "Search " + window.view.title + "…"
    : window.view.kind === "calculator-history" ? "Search calculations…"
    : "Search for apps and commands…"

  readonly property int cardWidth: Math.min(px(750), width - Style.gapsOut * 2)
  readonly property int fullHeight: Math.min(px(475), height - Style.gapsOut * 2)
  readonly property int headerHeight: px(66)
  readonly property int footerHeight: px(42)

  ListModel { id: rows }

  PointerMoveGate {
    id: pointerGate
    referenceItem: card
  }


  function closePopups() {
    window.actionPanelOpen = false
    window.dropdownOpen = false
    window.toastPanelOpen = false
    window.aboutOpen = false
    window.alert = null
  }

  function prepare(payload) {
    popTimer.stop()
    if (typeof payload.query === "string") window.query = payload.query
    window.closePopups()
    window.historyIndex = -1
    window.rebuild(true)
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  onShownChanged: {
    if (window.shown) return
    window.searchSerial++
    window.backend.cancelSearch()
    window.searchPending = false
    window.closePopups()
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
    window.rootFilter = "all"
    window.rebuild(true)
  }


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
    window.rebuild(false, top.selectedIndex)
  }


  function rebuild(resetSelection, restoreIndex) {
    var serial = ++window.searchSerial
    window.backend.cancelSearch()
    pointerGate.reset()
    var keepId = !resetSelection && window.selectedRow ? window.selectedRow.itemId : ""
    window.searchPending = false
    if (window.view.kind === "alias") { Rows.update(rows, []); window.select(-1); return }
    window.searchPending = true
    var revision = window.backend.candidatesRevision
    window.backend.searchAsync({ query: window.query, view: window.view, filter: window.atRoot ? window.rootFilter : "all" }, function(result) {
      if (serial !== window.searchSerial || revision !== window.backend.candidatesRevision) return
      window.applySearch(result, keepId, restoreIndex)
      window.searchPending = false
    })
  }

  function applySearch(result, keepId, restoreIndex) {
    if (!result.ok) {
      Rows.update(rows, [])
      window.showToast("failure", result.error)
      window.select(-1)
      return
    }
    var keepIndex = -1, next = []
    for (var s = 0; s < result.data.length; s++) {
      var section = result.data[s]
      if (section.title || s > 0) next.push(window.rowData({ id: "section:" + section.id, title: section.title }, "section"))
      for (var r = 0; r < section.rows.length; r++) {
        var c = section.rows[r]
        if (c.id === keepId) keepIndex = next.length
        next.push(window.rowData(c, c.kind === "calculator" ? "calculator" : "item"))
      }
    }
    Rows.update(rows, next)
    if (restoreIndex >= 0 && restoreIndex < rows.count && window.isSelectable(restoreIndex)) window.select(restoreIndex)
    else window.select(keepIndex >= 0 ? keepIndex : window.nextSelectable(-1, 1))
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
      calcResultCaption: String(c.calcResultCaption || ""),
      argsJson: JSON.stringify(c.arguments || [])
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
    if (index !== window.selectedIndex) {
      var previous = list.itemAtIndex(window.selectedIndex)
      if (previous) previous.selected = false
    }
    window.selectedIndex = index
    var current = list.itemAtIndex(index)
    if (current) current.selected = true
    window.selectedRow = Rows.snapshot(rows, index)
    // Argument values belong to one command; a different row starts empty.
    var id = window.selectedRow ? window.selectedRow.itemId : ""
    if (id !== window.argsForId) {
      window.argsForId = id
      window.argValues = ({})
      window.argFocus = -1
    }
    window.argDefs = window.selectedRow && window.selectedRow.argsJson ? JSON.parse(window.selectedRow.argsJson) : []
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
    if (window.searchPending || !window.selectedRow) return []
    var r = window.backend.callSync("rootSearch.getActions", { id: window.selectedRow.itemId })
    return r.ok ? r.data : []
  }

  function perform(actionId, index) {
    if (window.searchPending) return
    if (index !== undefined && index >= 0) window.select(index)
    if (!window.selectedRow) return
    window.actionPanelOpen = false
    // ↵ on a command with an empty required argument focuses that pill.
    if (actionId === "open" && window.argDefs.length) {
      var missing = RootSearch.missingArgument(window.argDefs, window.argValues)
      if (missing >= 0) { window.argFocus = missing; return }
    }
    window.request({ id: window.selectedRow.itemId, action: actionId, query: window.query, arguments: window.argValues })
  }

  function request(payload) {
    var r = window.backend.callSync("rootSearch.performAction", payload)
    if (!r.ok) { window.showToast("failure", r.error); return }
    var outcome = r.data || {}
    if (outcome.confirm) { window.alert = { spec: outcome.confirm, payload: payload }; return }
    if (outcome.push) { window.push(outcome.push); return }
    if (outcome.close) {
      if (outcome.hud) window.hud(outcome.hud)
      window.dismissRequested()
      window.argValues = ({})
      window.argFocus = -1
      if (window.atRoot) window.setQuery("")
      return
    }
    if (outcome.toast) window.showToast(outcome.toast.style, outcome.toast.title, outcome.toast.actions)
    window.rebuild(false)
  }

  function confirmAlert() {
    var payload = Object.assign({}, window.alert.payload, { confirmed: true })
    window.alert = null
    window.request(payload)
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
    window.actionPanelOpen = window.actions.length > 0
    if (actionPanel.item) actionPanel.item.filter = ""
  }

  function toggleDropdown() {
    if (window.dropdownOpen || !window.atRoot) { window.dropdownOpen = false; return }
    window.dropdownOpen = true
    dropdown.item.filter = ""
    var at = RootSearch.FILTERS.map(function(f) { return f.id }).indexOf(window.rootFilter)
    dropdown.item.selectedIndex = Math.max(0, at)
  }

  function setRootFilter(id) {
    window.dropdownOpen = false
    if (window.rootFilter === id) return
    window.rootFilter = id
    window.rebuild(true)
  }

  function toggleAbout() {
    if (window.aboutOpen || !window.selectedRow) { window.aboutOpen = false; return }
    var r = window.backend.callSync("rootSearch.getItemInfo", { id: window.selectedRow.itemId, query: window.query })
    if (!r.ok) { window.showToast("failure", r.error); return }
    window.aboutRows = r.data
    window.aboutOpen = r.data.length > 0
  }

  function toggleToastPanel() {
    if (window.toastPanelOpen) { window.toastPanelOpen = false; toastTimer.restart(); return }
    if (!window.toast || !window.toast.actions.length) return
    window.toastPanelOpen = true
    toastPanel.item.filter = ""
    toastTimer.stop()
  }

  // A toast action is a copy or a backend call (Backend.performAction's
  // toast.actions), with `done` as the success toast.
  function runToastAction(actionId) {
    var action = (window.toast ? window.toast.actions : []).filter(function(a) { return a.id === actionId })[0]
    window.toastPanelOpen = false
    if (!action) return
    if (action.copy !== undefined) {
      Util.execArgv(["wl-copy", "--", action.copy])
      window.showToast("success", "Copied to Clipboard")
      return
    }
    var r = window.backend.callSync(action.call.method, action.call.data)
    if (!r.ok) { window.showToast("failure", r.error); return }
    window.toast = null
    window.rebuild(false)
    if (action.done) window.showToast("success", action.done)
  }

  // Typing, Tab and Backspace while an argument pill has focus.
  function handleArgumentKey(event, shift) {
    var def = window.argDefs[window.argFocus]
    var value = window.argValues[def.name] || ""
    var key = event.key
    function set(next) {
      var values = Object.assign({}, window.argValues)
      values[def.name] = next
      window.argValues = values
    }
    if (key === Qt.Key_Tab || key === Qt.Key_Backtab) {
      var step = shift || key === Qt.Key_Backtab ? -1 : 1
      var next = window.argFocus + step
      window.argFocus = next >= window.argDefs.length ? 0 : next
      return true
    }
    if (key === Qt.Key_Backspace && !value) { window.argFocus--; return true }
    if (Util.editsFilter(event, value)) { set(Util.editedFilter(event, value)); return true }
    if (window.isTyping(event)) { set(value + event.text); return true }
    return false
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


  // A failure toast always offers its message to copy (Ctrl+T).
  function showToast(style, title, actions) {
    var list = (actions || []).slice()
    if (style === "failure") list.push({ id: "copy-error", title: "Copy Error Message", copy: String(title || "") })
    window.toastPanelOpen = false
    window.toast = { style: style, title: String(title || ""), actions: list }
    toastTimer.interval = list.length ? 6000 : 2500
    toastTimer.restart()
  }

  Timer {
    id: toastTimer
    interval: 2500
    onTriggered: if (!window.toastPanelOpen) window.toast = null
  }

  function hud(text) {
    Quickshell.execDetached(["omarchy-shell", "osd", "show", JSON.stringify({ icon: "", message: String(text), duration: 1500 })])
  }


  function setQuery(next) {
    if (window.query === next) return
    window.query = next
    window.historyIndex = -1
    window.rebuild(true)
  }

  function pasteClipboard() {
    clipboardInput.clear()
    clipboardInput.paste()
    var text = clipboardInput.text.replace(/[\r\n\u2028\u2029]+/g, " ")
    clipboardInput.clear()
    if (!text) return
    if (window.actionPanelOpen) actionPanel.item.filter += text
    else if (window.argFocus >= 0) {
      var name = window.argDefs[window.argFocus].name
      var values = Object.assign({}, window.argValues)
      values[name] = (values[name] || "") + text
      window.argValues = values
    } else {
      if (window.view.kind === "alias") text = text.replace(/\s/g, "")
      window.setQuery(window.query + text)
    }
  }

  TextEdit {
    id: clipboardInput
    visible: false
    textFormat: TextEdit.PlainText
  }

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
    if (window.alert) { window.alert = null; return }
    if (window.aboutOpen) { window.aboutOpen = false; return }
    if (window.dropdownOpen) { window.dropdownOpen = false; return }
    if (window.toastPanelOpen) { window.toggleToastPanel(); return }
    if (window.actionPanelOpen) { window.actionPanelOpen = false; return }
    if (window.argFocus >= 0 && !shift) { window.argFocus = -1; return }
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

  // -1 up, 1 down or 0, per the navigation bindings. Ctrl+P only moves up
  // inside popups: in the list it opens the dropdown.
  function direction(event, ctrl, alt, inPopup) {
    var key = event.key
    if (!ctrl && !alt && key === Qt.Key_Down) return 1
    if (!ctrl && !alt && key === Qt.Key_Up) return -1
    if (!ctrl || alt || (event.modifiers & Qt.ShiftModifier)) return 0
    if (window.vim) return key === Qt.Key_J ? 1 : (key === Qt.Key_K ? -1 : 0)
    return key === Qt.Key_N ? 1 : (key === Qt.Key_P && inPopup ? -1 : 0)
  }

  function isActionPanelKey(ctrl, alt, shift, key) {
    if (key !== Qt.Key_K || shift) return false
    return window.vim ? alt && !ctrl : ctrl && !alt
  }

  // Keys for a popup list (action panel, dropdown, toast actions).
  function handlePopupKey(event, panel, ctrl, alt) {
    var dir = window.direction(event, ctrl, alt, true)
    if (dir) { panel.move(dir); return true }
    if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) { panel.activateSelected(); return true }
    if (Util.editsFilter(event, panel.filter)) { panel.filter = Util.editedFilter(event, panel.filter); return true }
    if (window.isTyping(event)) { panel.filter += event.text; return true }
    return true
  }

  function handleKey(event) {
    var ctrl = (event.modifiers & Qt.ControlModifier) !== 0
    var shift = (event.modifiers & Qt.ShiftModifier) !== 0
    var alt = (event.modifiers & Qt.AltModifier) !== 0
    var key = event.key
    var enter = key === Qt.Key_Return || key === Qt.Key_Enter

    if (window.alert) {
      if (key === Qt.Key_Escape) window.alert = null
      else if (enter) window.confirmAlert()
      return true
    }
    if (key === Qt.Key_Escape) { window.handleEscape(shift); return true }
    if (ctrl && (key === Qt.Key_Plus || key === Qt.Key_Equal)) { window.setZoom(window.zoom + 0.1); return true }
    if (ctrl && key === Qt.Key_Minus) { window.setZoom(window.zoom - 0.1); return true }
    if (ctrl && key === Qt.Key_0) { window.setZoom(1); return true }
    if (ctrl && key === Qt.Key_BracketLeft) { window.closePopups(); window.pop(); return true }
    // Ctrl+V, Ctrl+Shift+V (the terminal habit) and Shift+Insert paste.
    var meta = (event.modifiers & Qt.MetaModifier) !== 0
    if ((key === Qt.Key_V && ctrl && !alt && !meta) || (key === Qt.Key_Insert && shift && !ctrl && !alt && !meta)) {
      window.pasteClipboard()
      return true
    }

    if (window.aboutOpen) {
      if (ctrl && shift && key === Qt.Key_K) window.aboutOpen = false
      return true
    }
    if (window.dropdownOpen) {
      if (ctrl && !shift && key === Qt.Key_P) { window.dropdownOpen = false; return true }
      return window.handlePopupKey(event, dropdown.item, ctrl, alt)
    }
    if (window.toastPanelOpen) {
      if (ctrl && key === Qt.Key_T) { window.toggleToastPanel(); return true }
      return window.handlePopupKey(event, toastPanel.item, ctrl, alt)
    }
    if (window.actionPanelOpen) {
      if (window.isActionPanelKey(ctrl, alt, shift, key)) { window.actionPanelOpen = false; return true }
      return window.handlePopupKey(event, actionPanel.item, ctrl, alt)
    }

    if (window.view.kind === "alias") {
      if (enter) { window.saveAlias(); return true }
      if (key === Qt.Key_Space) return true
    } else {
      if (window.atRoot && enter && ctrl && alt && !shift) { window.askAgent(); return true }
      if (ctrl && shift && key === Qt.Key_K) { window.toggleAbout(); return true }
      if (window.isActionPanelKey(ctrl, alt, shift, key)) { window.toggleActionPanel(); return true }
      if (ctrl && !shift && key === Qt.Key_P) { window.toggleDropdown(); return true }
      if (ctrl && !shift && key === Qt.Key_T) { window.toggleToastPanel(); return true }
      // Shift+Enter opens a new window for apps; Enter focuses an open one.
      if (enter && shift && !ctrl && !alt && window.performIfOffered(["open-new"])) return true
      if (enter && ctrl && shift) { window.performNth(2); return true }
      if (enter && ctrl) { window.performNth(1); return true }
      if (enter) { window.performNth(0); return true }
      if (window.argFocus >= 0 && window.handleArgumentKey(event, shift)) return true
      if (key === Qt.Key_Tab && window.argDefs.length) { window.argFocus = 0; return true }
      if (ctrl && alt && key === Qt.Key_Up) { window.performIfOffered(["favorite-up"]); return true }
      if (ctrl && alt && key === Qt.Key_Down) { window.performIfOffered(["favorite-down"]); return true }
      if (ctrl && key === Qt.Key_Up) { window.jumpSection(-1); return true }
      if (ctrl && key === Qt.Key_Down) { window.jumpSection(1); return true }
      var dir = window.direction(event, ctrl, alt, false)
      if (dir < 0) {
        if (window.atRoot && (window.query === "" || window.historyIndex >= 0) && window.selectedIndex === window.nextSelectable(-1, 1) && window.recallHistory(1)) return true
        window.move(-1); return true
      }
      if (dir > 0) {
        if (window.historyIndex >= 0) { window.recallHistory(-1); return true }
        window.move(1); return true
      }
      if (key === Qt.Key_PageUp) { window.move(-8); return true }
      if (key === Qt.Key_PageDown) { window.move(8); return true }
      if (ctrl && shift && key === Qt.Key_F) { window.performIfOffered(["favorite-add", "favorite-remove"]); return true }
      if (ctrl && shift && key === Qt.Key_C) { window.performIfOffered(["copy-command", "copy-id", "copy-question-answer"]); return true }
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
    function onCandidatesRevisionChanged() { if (window.shown && !window.actionPanelOpen && !window.alert) window.rebuild(false) }
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

    MouseArea { anchors.fill: parent; onClicked: { window.closePopups(); keyCatcher.forceActiveFocus() } }

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

      // Room left of the filter button; argument pills sit right after the
      // typed text (ref 04 §2.2 WidthSizer).
      readonly property real queryRoom: (filterButton.visible ? filterButton.x - window.px(12) : header.width - window.px(20)) - queryText.x

      Text {
        id: queryText
        textFormat: Text.PlainText
        x: lead.x + lead.width + window.px(12)
        width: Math.min(implicitWidth, header.queryRoom - (pills.visible ? pills.width + window.px(10) : 0))
        anchors.verticalCenter: parent.verticalCenter
        text: window.query || (pills.visible ? "" : window.placeholder)
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
        visible: window.shown && !window.actionPanelOpen && window.argFocus < 0

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
        visible: window.argDefs.length > 0 && window.view.kind !== "alias"
        x: queryText.x + (window.query ? queryText.width : 0) + window.px(10)
        anchors.verticalCenter: parent.verticalCenter
        spacing: window.px(6)

        Repeater {
          model: pills.visible ? window.argDefs : []

          Rectangle {
            id: pill
            required property var modelData
            required property int index
            readonly property string value: window.argValues[modelData.name] || ""
            readonly property bool focused: window.argFocus === index
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
              onClicked: { window.argFocus = pill.index; keyCatcher.forceActiveFocus() }
            }
          }
        }
      }

      Rectangle {
        id: filterButton
        visible: window.atRoot && !window.compact
        anchors.right: parent.right
        anchors.rightMargin: window.px(16)
        anchors.verticalCenter: parent.verticalCenter
        height: window.px(28)
        width: filterRow.implicitWidth + window.px(20)
        radius: Math.max(Style.cornerRadius, window.px(6))
        color: Util.alpha(window.look.foreground, window.dropdownOpen ? 0.12 : 0.06)
        border.width: 1
        border.color: Util.alpha(window.look.foreground, 0.12)

        Row {
          id: filterRow
          anchors.centerIn: parent
          spacing: window.px(6)

          Text {
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: (RootSearch.FILTERS.filter(function(f) { return f.id === window.rootFilter })[0] || RootSearch.FILTERS[0]).title
            color: window.look.foreground
            opacity: window.rootFilter === "all" ? 0.7 : 1
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
          onClicked: { window.toggleDropdown(); keyCatcher.forceActiveFocus() }
        }
      }

      Rectangle {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        height: Style.spacing.hairline
        color: Util.alpha(window.look.foreground, 0.12)
        visible: !window.compact
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
        reuseItems: true
        boundsBehavior: Flickable.StopAtBounds

        delegate: ResultRow {
          Component.onCompleted: selected = index === window.selectedIndex
          ListView.onReused: selected = index === window.selectedIndex
          ListView.onPooled: selected = false
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
          text: window.view.kind === "alias" ? "" : ""
          color: window.look.accent
          font.family: window.view.kind === "alias" ? window.look.fontFamily : "omarchy"
          font.pixelSize: window.px(28)
        }
        Text {
          anchors.horizontalCenter: parent.horizontalCenter
          textFormat: Text.PlainText
          text: window.view.kind === "alias" ? window.view.title
            : window.view.kind === "calculator-history" && !window.query ? "No Calculations Yet"
            : (window.backend.ready ? "No results" : "Loading…")
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
          visible: !!window.toast && window.toast.actions.length > 0
          anchors.verticalCenter: parent.verticalCenter
          keys: "Ctrl+T"
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
          keys: window.actionPanelKeys
          color: window.look.foreground
          zoom: window.zoom
        }
      }
    }

    Loader {
      id: actionPanel
      active: window.actionPanelOpen
      z: 10
      anchors.right: parent.right
      anchors.rightMargin: card.borderRight + window.px(10)
      anchors.bottom: footer.top
      anchors.bottomMargin: window.px(6)
      sourceComponent: ActionPanel {
        actions: window.actions
        look: window.look
        zoom: window.zoom
        onActivated: function(actionId) { window.perform(actionId) }
      }
    }

    Loader {
      id: dropdown
      active: window.dropdownOpen
      z: 10
      width: window.px(240)
      anchors.right: parent.right
      anchors.rightMargin: card.borderRight + window.px(10)
      anchors.top: header.bottom
      anchors.topMargin: window.px(4)
      sourceComponent: ActionPanel {
        placeholder: "Filter…"
        actions: RootSearch.FILTERS.map(function(f) {
          return { id: f.id, title: f.title, shortcut: "", section: "filter", icon: f.id === window.rootFilter ? "✓" : " " }
        })
        look: window.look
        zoom: window.zoom
        onActivated: function(id) { window.setRootFilter(id) }
      }
    }

    Loader {
      id: toastPanel
      active: window.toastPanelOpen
      z: 10
      width: window.px(280)
      anchors.left: parent.left
      anchors.leftMargin: card.borderLeft + window.px(10)
      anchors.bottom: footer.top
      anchors.bottomMargin: window.px(6)
      sourceComponent: ActionPanel {
        placeholder: "Search toast actions…"
        actions: (window.toast ? window.toast.actions : []).map(function(a) {
          return { id: a.id, title: a.title, shortcut: "", section: "toast", icon: " " }
        })
        look: window.look
        zoom: window.zoom
        onActivated: function(id) { window.runToastAction(id) }
      }
    }

    Loader {
      active: window.aboutOpen
      z: 10
      anchors.right: parent.right
      anchors.rightMargin: card.borderRight + window.px(10)
      anchors.bottom: footer.top
      anchors.bottomMargin: window.px(6)
      sourceComponent: InfoPanel {
        title: window.selectedRow ? window.selectedRow.title : ""
        rows: window.aboutRows
        look: window.look
        zoom: window.zoom
      }
    }

    Loader {
      active: !!window.alert
      z: 20
      anchors.fill: parent
      sourceComponent: Alert {
        spec: window.alert ? window.alert.spec : null
        look: window.look
        zoom: window.zoom
        onConfirmed: window.confirmAlert()
        onCancelled: window.alert = null
      }
    }
  }
}
