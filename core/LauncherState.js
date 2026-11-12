// The launcher window's behaviour as a pure state machine: view stack,
// query, selection, popups, toasts and the keyboard model. Both apps draw
// `state()` and feed it key events (ui/LauncherWindow.qml on Omarchy,
// SwiftUI on macOS), so every decision lives here once. [D, 2026-11-12]
//
// opts.backend: { callSync(method, data) }   (core/Backend.js)
// opts.host:
//   dismiss()            hide the window
//   show()               show it (omacast run with a pushed view)
//   hud(text)            transient message after the window closes
//   copy(text)           clipboard
//   readClipboard()      plain text for paste into the query
//   later(ms, fn) -> handle, cancel(handle)
//   changed()            state() has something new to draw
// opts.search(request, done): optional asynchronous search (Omarchy's Flea
//   helper); without it rootSearch.search runs synchronously. While a search
//   is pending nothing can be activated. opts.cancelSearch() drops one.
// opts.editText(event, value): optional; the edited text for an editing key,
//   or null. Omarchy passes its Util.editsFilter/editedFilter here.
// opts.symbolFor(candidate): optional icon name for a row (macOS SF Symbols).
// opts.filters, opts.missingArgument: RootSearch.FILTERS / missingArgument.
// opts.platform: "macos" keeps navigation on the Control key and commands
//   on Command, so Control+P moves up and the action panel is always ⌘K.
//   Anything else is the Linux model, where one Ctrl key does both.
//
// Key events: { key, text, primary, control, alt, shift, meta }. `key` is a name
// ("Escape", "Return", "Up", "Down", "PageUp", "PageDown", "Tab",
// "Backspace", "Space", "Insert") or the lower-case character ("k", "1",
// "[", "=", "-"). On Linux primary and control are the same Ctrl key.

var FILTERS_FALLBACK = [{ id: "all", title: "All" }]

function create(opts) {
  var backend = opts.backend
  var host = opts.host
  var separateNav = opts.platform === "macos"
  var filters = opts.filters || FILTERS_FALLBACK
  var missingArgument = opts.missingArgument || function() { return -1 }

  var DEFAULT_GENERAL = { uiZoom: 1, windowMode: "expanded", escapeKeyBehavior: "pop-back-or-close", popToRootTimeout: 90, navigationBindings: "emacs" }
  var ROOT = function() { return { kind: "root", title: "omacast", query: "" } }

  var s = {
    shown: false,
    stack: [ROOT()],
    query: "",
    rows: [],
    selectedIndex: -1,
    selectedRow: null,
    actionPanel: null,     // { kind, actions, filter, selectedIndex, placeholder }
    toast: null,           // { style, title, actions }
    historyIndex: -1,
    rootFilter: "all",
    about: null,           // { title, rows }
    alert: null,           // { spec, payload }
    argDefs: [],
    argValues: {},
    argFocus: -1,
    argsForId: "",
    searchPending: false,
    revision: 0
  }
  var popTimer = null, toastTimer = null, searchSerial = 0

  function changed() { s.revision++; if (host.changed) host.changed() }

  function general() {
    var r = backend.callSync("settings.getGeneralSettings", null)
    return r && r.ok ? r.data : DEFAULT_GENERAL
  }
  function view() { return s.stack[s.stack.length - 1] }
  function atRoot() { return s.stack.length === 1 }
  function vim() { return general().navigationBindings === "vim-motions" }

  // ------------------------------------------------------------- popups

  function popupOpen(kind) { return !!s.actionPanel && s.actionPanel.kind === kind }
  function openPopup(kind, actions, placeholder, selectedIndex) {
    s.actionPanel = { kind: kind, actions: actions, filter: "", selectedIndex: selectedIndex || 0, placeholder: placeholder }
  }
  function visibleActions(panel) {
    var f = panel.filter.trim().toLowerCase()
    return panel.actions.filter(function(a) { return !f || a.title.toLowerCase().indexOf(f) >= 0 })
  }
  function movePopup(delta) {
    var list = visibleActions(s.actionPanel)
    if (!list.length) return
    s.actionPanel.selectedIndex = (s.actionPanel.selectedIndex + delta + list.length) % list.length
  }
  function setPopupFilter(text) {
    s.actionPanel.filter = text
    s.actionPanel.selectedIndex = 0
  }
  function activatePopup(index) {
    var panel = s.actionPanel
    if (index !== undefined) panel.selectedIndex = index
    var a = visibleActions(panel)[panel.selectedIndex]
    if (!a) return
    if (panel.kind === "actions") perform(a.id)
    else if (panel.kind === "dropdown") setRootFilter(a.id)
    else if (panel.kind === "toast") runToastAction(a.id)
  }

  function closePopups() {
    s.actionPanel = null
    s.about = null
    s.alert = null
  }

  // ------------------------------------------------------------- lifecycle

  function prepare(payload) {
    if (popTimer) { host.cancel(popTimer); popTimer = null }
    s.shown = true
    if (payload && typeof payload.query === "string") s.query = payload.query
    closePopups()
    s.historyIndex = -1
    rebuild(true)
  }

  function hidden() {
    if (!s.shown) return
    s.shown = false
    searchSerial++
    if (opts.cancelSearch) opts.cancelSearch()
    s.searchPending = false
    closePopups()
    var seconds = Number(general().popToRootTimeout)
    if (!(seconds > 0)) popToRoot()
    else {
      if (popTimer) host.cancel(popTimer)
      popTimer = host.later(seconds * 1000, function() { popTimer = null; popToRoot() })
    }
    changed()
  }

  function popToRoot() {
    s.stack = [ROOT()]
    s.query = ""
    s.rootFilter = "all"
    rebuild(true)
  }

  function push(next) {
    var saved = s.stack.slice()
    saved[saved.length - 1] = Object.assign({}, view(), { query: s.query, selectedIndex: s.selectedIndex })
    s.stack = saved.concat([next])
    s.query = next.kind === "alias" ? (next.value || "") : ""
    rebuild(true)
  }

  function pop() {
    if (atRoot()) return
    var next = s.stack.slice(0, -1)
    var top = next[next.length - 1]
    s.stack = next
    s.query = top.query || ""
    rebuild(false, top.selectedIndex)
  }

  // ------------------------------------------------------------- rows

  function rebuild(resetSelection, restoreIndex) {
    var serial = ++searchSerial
    if (opts.cancelSearch) opts.cancelSearch()
    var keepId = !resetSelection && s.selectedRow ? s.selectedRow.itemId : ""
    s.searchPending = false
    if (view().kind === "alias") { s.rows = []; select(-1); changed(); return }
    var request = { query: s.query, view: view(), filter: atRoot() ? s.rootFilter : "all" }
    if (!opts.search) {
      applySearch(backend.callSync("rootSearch.search", request), keepId, restoreIndex)
      changed()
      return
    }
    s.searchPending = true
    opts.search(request, function(result) {
      if (serial !== searchSerial) return
      s.searchPending = false
      applySearch(result, keepId, restoreIndex)
      changed()
    })
    changed()
  }

  function applySearch(result, keepId, restoreIndex) {
    if (!result.ok) {
      s.rows = []
      showToast("failure", result.error)
      select(-1)
      return
    }
    var keepIndex = -1, next = []
    for (var i = 0; i < result.data.length; i++) {
      var section = result.data[i]
      if (section.title || i > 0) next.push(rowData({ id: "section:" + section.id, title: section.title }, "section"))
      for (var r = 0; r < section.rows.length; r++) {
        var c = section.rows[r]
        if (c.id === keepId) keepIndex = next.length
        next.push(rowData(c, c.kind === "calculator" ? "calculator" : "item"))
      }
    }
    s.rows = next
    if (restoreIndex >= 0 && restoreIndex < s.rows.length && isSelectable(restoreIndex)) select(restoreIndex)
    else select(keepIndex >= 0 ? keepIndex : nextSelectable(-1, 1))
  }

  function rowData(c, kind) {
    return {
      rowKind: kind,
      itemId: String(c.id || ""),
      kind: String(c.kind || ""),
      title: String(c.title || ""),
      subtitle: String(c.subtitle || ""),
      glyph: String(c.glyph || ""),
      glyphFont: String(c.glyphFont || ""),
      symbol: String((opts.symbolFor ? opts.symbolFor(c) : c.symbol) || ""),
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
      arguments: c.arguments || []
    }
  }

  function isSelectable(index) {
    var kind = s.rows[index] && s.rows[index].rowKind
    return kind === "item" || kind === "calculator"
  }

  function nextSelectable(from, direction) {
    for (var i = from + direction; i >= 0 && i < s.rows.length; i += direction) if (isSelectable(i)) return i
    return -1
  }

  function select(index) {
    s.selectedIndex = index
    s.selectedRow = index >= 0 && index < s.rows.length ? s.rows[index] : null
    // Argument values belong to one command; a different row starts empty.
    var id = s.selectedRow ? s.selectedRow.itemId : ""
    if (id !== s.argsForId) {
      s.argsForId = id
      s.argValues = {}
      s.argFocus = -1
    }
    s.argDefs = s.selectedRow ? s.selectedRow.arguments : []
  }

  function move(delta) {
    if (s.selectedIndex < 0) { select(nextSelectable(-1, 1)); return }
    var step = delta > 0 ? 1 : -1
    var target = s.selectedIndex
    for (var n = 0; n < Math.abs(delta); n++) {
      var next = nextSelectable(target, step)
      if (next < 0) break
      target = next
    }
    select(target)
  }

  function jumpSection(direction) {
    var i = s.selectedIndex
    for (i += direction; i >= 0 && i < s.rows.length; i += direction) if (s.rows[i].rowKind === "section") break
    if (direction < 0) for (i -= 1; i >= 0; i--) if (s.rows[i].rowKind === "section") break
    var first = nextSelectable(Math.max(-1, i), 1)
    if (first >= 0) select(first)
  }

  function nthItem(n) {
    var seen = 0
    for (var i = 0; i < s.rows.length; i++) {
      if (!isSelectable(i)) continue
      if (++seen === n) return i
    }
    return -1
  }

  // ------------------------------------------------------------- actions

  function actionsForSelected() {
    if (s.searchPending || !s.selectedRow) return []
    var r = backend.callSync("rootSearch.getActions", { id: s.selectedRow.itemId })
    return r.ok ? r.data : []
  }

  function perform(actionId, index) {
    if (s.searchPending) return
    if (index !== undefined && index >= 0) select(index)
    if (!s.selectedRow) return
    s.actionPanel = null
    // ↵ on a command with an empty required argument focuses that pill.
    if (actionId === "open" && s.argDefs.length) {
      var missing = missingArgument(s.argDefs, s.argValues)
      if (missing >= 0) { s.argFocus = missing; return }
    }
    request({ id: s.selectedRow.itemId, action: actionId, query: s.query, arguments: s.argValues })
  }

  function request(payload) {
    var r = backend.callSync("rootSearch.performAction", payload)
    if (!r.ok) { showToast("failure", r.error); return }
    var outcome = r.data || {}
    if (outcome.confirm) { s.alert = { spec: outcome.confirm, payload: payload }; return }
    if (outcome.push) { push(outcome.push); return }
    if (outcome.close) {
      if (outcome.hud) host.hud(outcome.hud)
      host.dismiss()
      s.argValues = {}
      s.argFocus = -1
      if (atRoot()) setQuery("")
      return
    }
    if (outcome.toast) showToast(outcome.toast.style, outcome.toast.title, outcome.toast.actions)
    rebuild(false)
  }

  function confirmAlert() {
    var payload = Object.assign({}, s.alert.payload, { confirmed: true })
    s.alert = null
    request(payload)
  }

  function performNth(n) {
    var list = actionsForSelected()
    if (list.length > n) perform(list[n].id)
  }

  function performIfOffered(ids) {
    var list = actionsForSelected()
    for (var i = 0; i < list.length; i++) if (ids.indexOf(list[i].id) >= 0) { perform(list[i].id); return true }
    return false
  }

  function toggleActionPanel() {
    if (popupOpen("actions")) { s.actionPanel = null; return }
    var actions = actionsForSelected()
    if (actions.length) openPopup("actions", actions, "Search for actions…")
  }

  function toggleDropdown() {
    if (popupOpen("dropdown") || !atRoot()) { if (popupOpen("dropdown")) s.actionPanel = null; return }
    var at = filters.map(function(f) { return f.id }).indexOf(s.rootFilter)
    openPopup("dropdown", filters.map(function(f) {
      return { id: f.id, title: f.title, shortcut: "", section: "filter", icon: f.id === s.rootFilter ? "✓" : "" }
    }), "Filter…", Math.max(0, at))
  }

  function setRootFilter(id) {
    s.actionPanel = null
    if (s.rootFilter === id) return
    s.rootFilter = id
    rebuild(true)
  }

  function toggleAbout() {
    if (s.about || !s.selectedRow) { s.about = null; return }
    var r = backend.callSync("rootSearch.getItemInfo", { id: s.selectedRow.itemId, query: s.query })
    if (!r.ok) { showToast("failure", r.error); return }
    s.about = r.data.length ? { title: s.selectedRow.title, rows: r.data } : null
  }

  function toggleToastPanel() {
    if (popupOpen("toast")) { s.actionPanel = null; restartToastTimer(); return }
    if (!s.toast || !s.toast.actions.length) return
    openPopup("toast", s.toast.actions.map(function(a) {
      return { id: a.id, title: a.title, shortcut: "", section: "toast", icon: "" }
    }), "Search toast actions…")
    if (toastTimer) { host.cancel(toastTimer); toastTimer = null }
  }

  // A toast action is a copy or a backend call, with `done` as the success toast.
  function runToastAction(actionId) {
    var action = (s.toast ? s.toast.actions : []).filter(function(a) { return a.id === actionId })[0]
    s.actionPanel = null
    if (!action) return
    if (action.copy !== undefined) {
      host.copy(action.copy)
      showToast("success", "Copied to Clipboard")
      return
    }
    var r = backend.callSync(action.call.method, action.call.data)
    if (!r.ok) { showToast("failure", r.error); return }
    s.toast = null
    rebuild(false)
    if (action.done) showToast("success", action.done)
  }

  function saveAlias() {
    var r = backend.callSync("settings.updateCommandSettings", { commandId: view().commandId, alias: s.query })
    if (!r.ok) { showToast("failure", r.error); return }
    var saved = s.query.trim()
    pop()
    showToast("success", saved ? "Alias saved" : "Alias removed")
    rebuild(false)
  }

  // A failure toast always offers its message to copy.
  function showToast(style, title, actions) {
    var list = (actions || []).slice()
    if (style === "failure") list.push({ id: "copy-error", title: "Copy Error Message", copy: String(title || "") })
    if (popupOpen("toast")) s.actionPanel = null
    s.toast = { style: style, title: String(title || ""), actions: list }
    restartToastTimer()
  }

  function restartToastTimer() {
    if (toastTimer) host.cancel(toastTimer)
    if (!s.toast) return
    toastTimer = host.later(s.toast.actions.length ? 6000 : 2500, function() {
      toastTimer = null
      if (!popupOpen("toast")) { s.toast = null; changed() }
    })
  }

  // ------------------------------------------------------------- typing

  function setQuery(next) {
    if (s.query === next) return
    s.query = next
    s.historyIndex = -1
    rebuild(true)
  }

  function recallHistory(direction) {
    var r = backend.callSync("rootSearch.getSearchHistory", null)
    var history = r.ok ? r.data : []
    if (history.length === 0) return false
    var next = Math.max(-1, Math.min(history.length - 1, s.historyIndex + direction))
    if (next === s.historyIndex) return true
    s.query = next < 0 ? "" : history[next]
    rebuild(true)
    s.historyIndex = next
    return true
  }

  function setZoom(value) {
    var z = Math.round(Math.max(0.8, Math.min(1.5, value)) * 10) / 10
    backend.callSync("settings.updateGeneralSettings", { uiZoom: z })
  }

  function zoom() { var z = general().uiZoom; return z > 0 ? z : 1 }

  function pasteText(raw) {
    var text = String(raw || "").replace(/[\r\n\u2028\u2029]+/g, " ")
    if (!text) return
    if (s.actionPanel) setPopupFilter(s.actionPanel.filter + text)
    else if (s.argFocus >= 0) setArgument((s.argValues[s.argDefs[s.argFocus].name] || "") + text)
    else {
      if (view().kind === "alias") text = text.replace(/\s/g, "")
      setQuery(s.query + text)
    }
  }

  function setArgument(value) {
    var def = s.argDefs[s.argFocus]
    var values = Object.assign({}, s.argValues)
    values[def.name] = String(value || "")
    s.argValues = values
  }

  function isTyping(e) {
    var t = e.text
    // macOS layouts type characters like @ with Option, so it counts there.
    return !!t && t.length === 1 && t.charCodeAt(0) >= 32 && t.charCodeAt(0) !== 127 && !e.primary && !e.control && !e.meta && (separateNav || !e.alt)
  }

  // Backspace deletes a character, Alt/Ctrl+Backspace or Ctrl+W a word,
  // Cmd+Backspace or Ctrl+U everything. null when the key is not an edit.
  function editedText(e, value) {
    if (opts.editText) return opts.editText(e, value)
    var wordKey = separateNav ? e.alt : e.primary
    if (e.key === "Backspace" && !value) return null
    if (e.key === "Backspace" && separateNav && e.primary) return ""
    if (e.key === "Backspace" && wordKey) return value.replace(/\S+\s*$|\s+$/, "")
    if (e.key === "Backspace" && !e.primary && !e.control && !e.alt) return value.slice(0, -1)
    if (e.control && !e.alt && !e.shift && e.key === "u" && value) return ""
    if (e.control && !e.alt && !e.shift && e.key === "w" && value) return value.replace(/\s*\S+\s*$/, "")
    return null
  }

  function handleArgumentKey(e) {
    var def = s.argDefs[s.argFocus]
    var value = s.argValues[def.name] || ""
    if (e.key === "Tab") {
      var next = s.argFocus + (e.shift ? -1 : 1)
      s.argFocus = next >= s.argDefs.length ? 0 : next
      return true
    }
    if (e.key === "Backspace" && !value) { s.argFocus--; return true }
    var edited = editedText(e, value)
    if (edited !== null) { setArgument(edited); return true }
    if (isTyping(e)) { setArgument(value + e.text); return true }
    return false
  }

  function handleEscape(shift) {
    if (s.alert) { s.alert = null; return }
    if (s.about) { s.about = null; return }
    if (popupOpen("toast")) { toggleToastPanel(); return }
    if (s.actionPanel) { s.actionPanel = null; return }
    if (s.argFocus >= 0 && !shift) { s.argFocus = -1; return }
    if (shift) { popToRoot(); return }
    if (general().escapeKeyBehavior === "close-and-pop-to-root") {
      host.dismiss()
      popToRoot()
      return
    }
    if (s.query && view().kind !== "alias") setQuery("")
    else if (!atRoot()) pop()
    else host.dismiss()
  }

  // -1 up, 1 down or 0, per the navigation bindings.
  function direction(e, inPopup) {
    if (!e.primary && !e.control && !e.alt && e.key === "Down") return 1
    if (!e.primary && !e.control && !e.alt && e.key === "Up") return -1
    if (!e.control || e.alt || e.shift || (separateNav && e.primary)) return 0
    if (vim()) return e.key === "j" ? 1 : (e.key === "k" ? -1 : 0)
    return e.key === "n" ? 1 : (e.key === "p" && (inPopup || separateNav) ? -1 : 0)
  }

  function isActionPanelKey(e) {
    if (e.key !== "k" || e.shift) return false
    if (separateNav) return e.primary && !e.alt && !e.control
    return vim() ? e.alt && !e.primary : e.primary && !e.alt
  }

  function actionPanelKeys() {
    if (separateNav) return "Ctrl K"
    return vim() ? "Alt K" : "Ctrl K"
  }

  function handlePopupKey(e) {
    var dir = direction(e, true)
    if (dir) { movePopup(dir); return true }
    if (e.key === "Return") { activatePopup(); return true }
    var edited = editedText(e, s.actionPanel.filter)
    if (edited !== null) { setPopupFilter(edited); return true }
    if (isTyping(e)) { setPopupFilter(s.actionPanel.filter + e.text); return true }
    return true
  }

  function handleKey(e) {
    var p = e.primary, shift = e.shift, alt = e.alt, key = e.key
    var enter = key === "Return"

    if (s.alert) {
      if (key === "Escape") s.alert = null
      else if (enter) confirmAlert()
      return true
    }
    if (key === "Escape") { handleEscape(shift); return true }
    if (p && (key === "=" || key === "+")) { setZoom(zoom() + 0.1); return true }
    if (p && key === "-") { setZoom(zoom() - 0.1); return true }
    if (p && key === "0") { setZoom(1); return true }
    if (p && key === "[") { closePopups(); pop(); return true }
    if (!e.meta && ((key === "v" && p && !alt) || (key === "Insert" && shift && !p && !alt))) {
      pasteText(host.readClipboard())
      return true
    }

    if (s.about) {
      if (p && shift && key === "k") s.about = null
      return true
    }
    if (popupOpen("dropdown")) {
      if (p && !shift && key === "p") { s.actionPanel = null; return true }
      return handlePopupKey(e)
    }
    if (popupOpen("toast")) {
      if (p && key === "t") { toggleToastPanel(); return true }
      return handlePopupKey(e)
    }
    if (popupOpen("actions")) {
      if (isActionPanelKey(e)) { s.actionPanel = null; return true }
      return handlePopupKey(e)
    }

    if (view().kind === "alias") {
      if (enter) { saveAlias(); return true }
      if (key === "Space") return true
    } else {
      if (p && shift && key === "k") { toggleAbout(); return true }
      if (isActionPanelKey(e)) { toggleActionPanel(); return true }
      if (p && !shift && key === "p") { toggleDropdown(); return true }
      if (p && !shift && key === "t") { toggleToastPanel(); return true }
      // Shift+Enter opens a new window for apps; Enter focuses an open one.
      if (enter && shift && !p && !alt && performIfOffered(["open-new"])) return true
      if (enter && p && shift) { performNth(2); return true }
      if (enter && p) { performNth(1); return true }
      if (enter) { performNth(0); return true }
      if (s.argFocus >= 0 && handleArgumentKey(e)) return true
      if (key === "Tab" && s.argDefs.length) { s.argFocus = 0; return true }
      if (p && alt && key === "Up") { performIfOffered(["favorite-up"]); return true }
      if (p && alt && key === "Down") { performIfOffered(["favorite-down"]); return true }
      if (p && key === "Up") { jumpSection(-1); return true }
      if (p && key === "Down") { jumpSection(1); return true }
      var dir = direction(e, false)
      if (dir < 0) {
        if (atRoot() && (s.query === "" || s.historyIndex >= 0) && s.selectedIndex === nextSelectable(-1, 1) && recallHistory(1)) return true
        move(-1); return true
      }
      if (dir > 0) {
        if (s.historyIndex >= 0) { recallHistory(-1); return true }
        move(1); return true
      }
      if (key === "PageUp") { move(-8); return true }
      if (key === "PageDown") { move(8); return true }
      if (p && shift && key === "f") { performIfOffered(["favorite-add", "favorite-remove"]); return true }
      if (p && shift && key === "c") { performIfOffered(["copy-command", "copy-id", "copy-question-answer"]); return true }
      if (p && shift && key === "d") { performIfOffered(["delete-all-entries"]); return true }
      if (p && key === "d") { performIfOffered(["delete-entry"]); return true }
      if (alt && shift && key === "d") { performIfOffered(["disable"]); return true }
      if (p && key.length === 1 && key >= "1" && key <= "9") {
        var target = nthItem(Number(key))
        if (target >= 0) perform("open", target)
        return true
      }
    }

    var edited = editedText(e, s.query)
    if (edited !== null) { setQuery(edited); return true }
    if (key === "Backspace" && !s.query && !atRoot()) { pop(); return true }
    if (isTyping(e)) {
      if (view().kind === "alias" && e.text === " ") return true
      setQuery(s.query + e.text)
      return true
    }
    return false
  }

  // ------------------------------------------------------------- public

  function state() {
    var g = general()
    var v = view()
    var compact = g.windowMode === "compact" && atRoot() && !s.query
    var primary = null
    if (v.kind === "alias") primary = { title: "Save Alias", shortcut: "↵" }
    else { var list = actionsForSelected(); primary = list.length ? list[0] : null }
    var panel = s.actionPanel
    var empty = null
    if (v.kind === "alias") empty = { title: v.title, subtitle: "Typing the alias exactly in the root search puts this command on top. Leave it empty to remove it." }
    else if (s.rows.length === 0) empty = v.kind === "calculator-history" && !s.query
      ? { title: "No Calculations Yet", subtitle: "Type a calculation in the root search, then copy or paste the answer." }
      : { title: "No results", subtitle: "" }
    return {
      revision: s.revision,
      shown: s.shown,
      view: { kind: v.kind, title: v.title },
      atRoot: atRoot(),
      compact: compact,
      zoom: zoom(),
      query: s.query,
      placeholder: v.kind === "alias" ? "Type an alias, then press ↵"
        : v.kind === "menu" ? "Search " + v.title + "…"
        : v.kind === "calculator-history" ? "Search calculations…"
        : "Search for apps and commands…",
      rows: s.rows,
      selectedIndex: s.selectedIndex,
      arguments: v.kind === "alias" ? [] : s.argDefs.map(function(d) {
        return { name: d.name, placeholder: d.placeholder, required: !!d.required, value: s.argValues[d.name] || "" }
      }),
      argFocus: s.argFocus,
      rootFilter: s.rootFilter,
      filterTitle: (filters.filter(function(f) { return f.id === s.rootFilter })[0] || filters[0]).title,
      popup: panel ? { kind: panel.kind, placeholder: panel.placeholder, filter: panel.filter, selectedIndex: panel.selectedIndex, actions: visibleActions(panel) } : null,
      about: s.about,
      alert: s.alert ? s.alert.spec : null,
      toast: s.toast ? { style: s.toast.style, title: s.toast.title, hasActions: s.toast.actions.length > 0 } : null,
      primaryAction: primary,
      actionPanelKeys: actionPanelKeys(),
      empty: empty,
      searchPending: s.searchPending
    }
  }

  function wrap(fn) {
    return function() {
      var out = fn.apply(null, arguments)
      changed()
      return out
    }
  }

  // `omacast run`: explicit, so it skips the confirmation alert.
  function run(commandId) {
    var r = backend.callSync("rootSearch.performAction", { id: commandId, action: "open", query: "", confirmed: true })
    if (!r.ok) return r
    var outcome = r.data || {}
    if (outcome.push) {
      host.show()
      popToRoot()
      push(outcome.push)
    } else if (outcome.close) {
      host.dismiss()
      if (outcome.hud) host.hud(outcome.hud)
    }
    changed()
    return r
  }

  return {
    state: state,
    prepare: wrap(prepare),
    hidden: hidden,
    popToRoot: wrap(popToRoot),
    push: wrap(push),
    pop: wrap(pop),
    key: wrap(handleKey),
    hover: function(index) { if (!s.actionPanel && isSelectable(index) && index !== s.selectedIndex) { select(index); changed() } },
    click: wrap(function(index) { if (isSelectable(index)) perform("open", index) }),
    clickPopup: wrap(function(index) { if (s.actionPanel) activatePopup(index) }),
    hoverPopup: function(index) { if (s.actionPanel && index !== s.actionPanel.selectedIndex) { s.actionPanel.selectedIndex = index; changed() } },
    clickArgument: wrap(function(index) { s.argFocus = index }),
    toggleDropdown: wrap(toggleDropdown),
    dismissPopups: wrap(closePopups),
    confirmAlert: wrap(function() { if (s.alert) confirmAlert() }),
    cancelAlert: wrap(function() { s.alert = null }),
    refresh: function() { if (s.shown && !s.actionPanel && !s.alert) { rebuild(false); } },
    run: run,
    hud: function(text) { host.hud(text) }
  }
}

if (typeof module !== "undefined") module.exports = { create: create }
