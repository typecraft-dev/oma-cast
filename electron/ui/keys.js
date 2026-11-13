// oma-cast UI, part 3: navigation state machine (push/pop/popToRoot),
// action dispatch, and the complete handleKey port from LauncherWindow.qml —
// same branches, same precedence, same Qt→DOM key mapping. [D]
"use strict"

var Agent = require("../../plugin/core/Agent.js")

// ----------------------------------------------------------- navigation
function closePopups() {
  W.actionPanelOpen = false
  W.dropdownOpen = false
  W.toastPanelOpen = false
  W.aboutOpen = false
  W.alert = null
}

function popToRoot() {
  W.stack = [{ kind: "root", title: "oma-cast", query: "" }]
  W.query = ""
  W.rootFilter = "all"
  rebuild(true)
}

function push(next) {
  var saved = W.stack.slice()
  saved[saved.length - 1] = Object.assign({}, view(), { query: W.query, selectedIndex: W.selectedIndex })
  W.stack = saved.concat([next])
  W.query = (next.kind === "alias" || next.kind === "setting-edit") ? (next.value || "") : ""
  rebuild(true)
}

function pop() {
  if (atRoot()) return
  var next = W.stack.slice(0, -1)
  var top = next[next.length - 1]
  W.stack = next
  W.query = top.query || ""
  rebuild(false)
  if (top.selectedIndex >= 0) select(top.selectedIndex)
}

function rebuild(resetSelection, opts) {
  gate.reset()
  var keepId = !resetSelection && W.selectedRow ? W.selectedRow.itemId : ""
  W.rows = []
  if (view().kind === "alias" || view().kind === "setting-edit") { select(-1); renderList(); return }
  var result = backend.callSync("rootSearch.search", {
    query: W.query, view: view(), filter: atRoot() ? W.rootFilter : "all",
    skipFiles: !!(opts && opts.skipFiles)
  })
  if (!result.ok) { showToast("failure", result.error); select(-1); renderList(); return }
  var keepIndex = -1
  result.data.forEach(function(section, s) {
    if (section.title || s > 0) W.rows.push(rowData({ id: "section:" + section.id, title: section.title }, "section"))
    section.rows.forEach(function(c) {
      if (c.id === keepId) keepIndex = W.rows.length
      W.rows.push(rowData(c, c.kind === "calculator" ? "calculator" : "item"))
    })
  })
  renderList()
  select(keepIndex >= 0 ? keepIndex : nextSelectable(-1, 1))
}

// Typing coalescing: a keydown used to run the full search + list render
// synchronously before returning, so fast typing queued whole searches and
// characters arrived a word at a time. Now setQuery paints the query text
// and caret immediately (cheap) and schedules the heavy search for the next
// task; rapid keys collapse into one rebuild. Enter/actions flush first so
// they always act on the latest query. [D]
var rebuildTimer = null
var pendingReset = false
// Files are the slow tier (100k-entry match on the UI thread): the fast
// pass paints apps/commands instantly with skipFiles, then the trailing
// pass adds the Files section once typing pauses. Icon extractions stay
// gated until the trailing pass so PowerShell spawns never contend with
// keystrokes. [D]
var filesTimer = null
var typingIdleTimer = null
function markTyping() {
  try { if (backend.apps && backend.apps.setTyping) backend.apps.setTyping(true) } catch (e) {}
  if (typingIdleTimer) clearTimeout(typingIdleTimer)
  typingIdleTimer = setTimeout(function() {
    typingIdleTimer = null
    try { if (backend.apps && backend.apps.setTyping) backend.apps.setTyping(false) } catch (e) {}
  }, 300)
}
function scheduleFilesPass() {
  if (filesTimer) clearTimeout(filesTimer)
  filesTimer = setTimeout(function() {
    filesTimer = null
    if (rebuildTimer) return  // a keystroke is still pending; it re-arms us
    rebuild(false)
  }, 150)
}
function scheduleRebuild(resetSelection) {
  if (resetSelection) pendingReset = true
  markTyping()
  if (rebuildTimer) return
  rebuildTimer = setTimeout(function() {
    rebuildTimer = null
    var r = pendingReset
    pendingReset = false
    rebuild(r, { skipFiles: true })
    scheduleFilesPass()
  }, 0)
}
function flushRebuild() {
  if (filesTimer) { clearTimeout(filesTimer); filesTimer = null }
  if (!rebuildTimer) return
  clearTimeout(rebuildTimer)
  rebuildTimer = null
  var r = pendingReset
  pendingReset = false
  rebuild(r)
}
function setQuery(next) {
  if (W.query === next) return
  W.query = next
  W.historyIndex = -1
  try { renderHeader() } catch (e) {}
  scheduleRebuild(true)
}

// --------------------------------------------------------------- actions
function actionsForSelected() {
  if (!W.selectedRow) return []
  var r = backend.callSync("rootSearch.getActions", { id: W.selectedRow.itemId })
  return r.ok ? r.data : []
}

// The add view is a real form: its inputs handle their own keys
// natively (the capture listener must not steal them), Enter submits
// unless a select/checkbox has focus; Escape pops via handleEscape. [D]
function handleAddFormKey(e, enter, ctrl, alt, shift) {
  var t = document.activeElement
  var inForm = !!(t && el.todoform.contains(t))
  var tag = t && t.tagName
  // Escape pops through handleEscape (runs before this branch).
  if (enter && !ctrl && !alt && !shift) {
    if (inForm && (tag === "SELECT" || (tag === "INPUT" && t.type === "checkbox"))) return false
    submitAddForm()
    return true
  }
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && W.formHandler
      && !(inForm && (tag === "SELECT" || (tag === "INPUT" && t.type === "date")))) {
    W.formHandler.focusNext(e.key === "ArrowDown" ? 1 : -1)
    return true
  }
  return false
}

function submitAddForm() {
  if (!W.formHandler || W.addSubmitting) return
  var r = W.formHandler.submit()
  if (!r.ok) {
    var first = Object.keys(r.errors)[0]
    showToast("failure", r.errors[first])
    return
  }
  W.addSubmitting = true
  var res = backend.callSync("rootSearch.performAction",
    { id: RootSearch.TODO_ADD_ID, action: "submit", query: "", arguments: r.values })
  if (!res.ok) { W.addSubmitting = false; showToast("failure", res.error); return }
}

function perform(actionId, index) {
  flushRebuild()
  if (index !== undefined && index >= 0) select(index)
  if (!W.selectedRow) return
  W.actionPanelOpen = false
  // ↵ on a command with an empty required argument focuses that pill.
  if (actionId === "open" && W.argDefs.length) {
    var missing = RootSearch.missingArgument(W.argDefs, W.argValues)
    if (missing >= 0) { W.argFocus = missing; renderAll(); return }
  }
  request({ id: W.selectedRow.itemId, action: actionId, query: W.query, arguments: W.argValues })
}

function request(payload) {
  var r = backend.callSync("rootSearch.performAction", payload)
  if (!r.ok) { showToast("failure", r.error); return }
  var outcome = r.data || {}
  if (outcome.confirm) { W.alert = { spec: outcome.confirm, payload: payload }; renderPanels(); return }
  if (outcome.push) { push(outcome.push); return }
  if (outcome.close) {
    if (outcome.hud) host.hud(outcome.hud)
    host.dismiss()
    W.argValues = {}
    W.argFocus = -1
    if (atRoot()) setQuery("")
    return
  }
  if (outcome.toast) showToast(outcome.toast.style, outcome.toast.title, outcome.toast.actions)
  rebuild(false)
}

function confirmAlert() {
  var payload = Object.assign({}, W.alert.payload, { confirmed: true })
  W.alert = null
  request(payload)
}

function performNth(n) {
  flushRebuild()
  var list = actionsForSelected()
  if (list.length > n) perform(list[n].id)
}

function performIfOffered(actionIds) {
  flushRebuild()
  var list = actionsForSelected()
  for (var i = 0; i < list.length; i++) if (actionIds.indexOf(list[i].id) >= 0) { perform(list[i].id); return true }
  return false
}

function toggleActionPanel() {
  flushRebuild()
  if (W.actionPanelOpen) { W.actionPanelOpen = false; renderPanels(); renderHeader(); return }
  W.actions = actionsForSelected()
  actionPanelState.filter = ""
  actionPanelState.actions = W.actions
  actionPanelState.selectedIndex = 0
  actionPanelState.refilter()
  W.actionPanelOpen = W.actions.length > 0
  renderPanels()
  renderHeader()
}

function toggleDropdown() {
  if (W.dropdownOpen || !atRoot()) { W.dropdownOpen = false; renderPanels(); renderHeader(); return }
  dropdownState.filter = ""
  dropdownState.actions = RootSearch.FILTERS.map(function(f) {
    return { id: f.id, title: f.title, shortcut: "", section: "filter", icon: f.id === W.rootFilter ? "✓" : " " }
  })
  dropdownState.selectedIndex = Math.max(0, RootSearch.FILTERS.map(function(f) { return f.id }).indexOf(W.rootFilter))
  dropdownState.refilter()
  W.dropdownOpen = true
  renderPanels()
  renderHeader()
}

function setRootFilter(id) {
  W.dropdownOpen = false
  if (W.rootFilter === id) { renderPanels(); renderHeader(); return }
  W.rootFilter = id
  rebuild(true)
  renderHeader()
}

function toggleAbout() {
  flushRebuild()
  if (W.aboutOpen || !W.selectedRow) { W.aboutOpen = false; renderPanels(); return }
  var r = backend.callSync("rootSearch.getItemInfo", { id: W.selectedRow.itemId, query: W.query })
  if (!r.ok) { showToast("failure", r.error); return }
  W.aboutRows = r.data
  W.aboutOpen = r.data.length > 0
  renderPanels()
}

function restartToastTimer() {
  if (toastTimer) clearTimeout(toastTimer)
  var list = W.toast ? W.toast.actions : []
  toastTimer = setTimeout(function() {
    if (!W.toastPanelOpen) { W.toast = null; renderFooter() }
  }, list.length ? 6000 : 2500)
}

function toggleToastPanel() {
  if (W.toastPanelOpen) { W.toastPanelOpen = false; restartToastTimer(); renderPanels(); return }
  if (!W.toast || !W.toast.actions.length) return
  toastPanelState.filter = ""
  toastPanelState.actions = W.toast.actions
  toastPanelState.selectedIndex = 0
  toastPanelState.refilter()
  W.toastPanelOpen = true
  if (toastTimer) clearTimeout(toastTimer)
  renderPanels()
}

function askAgent() {
  var r = backend.callSync("rootSearch.performAction", { id: Agent.FALLBACK_ID, action: "open", query: W.query })
  if (!r.ok) showToast("failure", r.error)
}

function saveAlias() {
  var r = backend.callSync("settings.updateCommandSettings", { commandId: view().commandId, alias: W.query })
  if (!r.ok) { showToast("failure", r.error); return }
  var saved = W.query.trim()
  pop()
  showToast("success", saved ? "Alias saved" : "Alias removed")
  rebuild(false)
}

// The Quick Capture directory row (Settings → Quick Capture Directory)
// pushes a setting-edit view where the query is the value; ↵ saves it
// through the validated general-settings path. Empty resets to default.
function saveSettingEdit() {
  var parts = String(view().settingId || "").split(":")
  var key = parts.length === 3 ? parts[2] : ""
  if (!key) { showToast("failure", "Unknown setting"); return }
  var value = W.query.trim()
  var patch = {}
  patch[key] = value
  var r = backend.callSync("settings.updateGeneralSettings", patch)
  if (!r.ok) { showToast("failure", r.error); return }
  pop()
  showToast("success", value ? "Saved" : "Reset to default")
  rebuild(false)
}

function pasteClipboard() {
  var text = host.readText().replace(/[\r\n\u2028\u2029]+/g, " ")
  if (!text) return
  if (W.actionPanelOpen) { actionPanelState.filter += text; actionPanelState.refilter() }
  else if (W.argFocus >= 0) {
    var name = W.argDefs[W.argFocus].name
    W.argValues = Object.assign({}, W.argValues)
    W.argValues[name] = (W.argValues[name] || "") + text
    renderHeader()
  } else {
    if (view().kind === "alias") text = text.replace(/\s/g, "")
    if (view().kind === "setting-edit") text = text.replace(/[\r\n\u2028\u2029]+/g, " ")
    setQuery(W.query + text)
  }
}

function recallHistory(directionStep) {
  var r = backend.callSync("rootSearch.getSearchHistory", null)
  var history = r.ok ? r.data : []
  if (history.length === 0) return false
  var next = Math.max(-1, Math.min(history.length - 1, W.historyIndex + directionStep))
  if (next === W.historyIndex) return true
  W.query = next < 0 ? "" : history[next]
  try { renderHeader() } catch (e) {}
  scheduleRebuild(true)
  W.historyIndex = next
  return true
}

function setZoom(value) {
  var z = Math.round(Math.max(0.8, Math.min(1.5, value)) * 10) / 10
  backend.callSync("settings.updateGeneralSettings", { uiZoom: z })
  refreshGeneral()
  renderAll()
}

function handleEscape(shift) {
  if (W.alert) { W.alert = null; renderPanels(); return }
  if (W.aboutOpen) { W.aboutOpen = false; renderPanels(); return }
  if (W.dropdownOpen) { W.dropdownOpen = false; renderPanels(); renderHeader(); return }
  if (W.toastPanelOpen) { toggleToastPanel(); return }
  if (W.actionPanelOpen) { W.actionPanelOpen = false; renderPanels(); renderHeader(); return }
  if (W.argFocus >= 0 && !shift) { W.argFocus = -1; renderAll(); return }
  if (shift) { popToRoot(); return }
  if (general.escapeKeyBehavior === "close-and-pop-to-root") {
    host.dismiss()
    popToRoot()
    return
  }
  if (W.query && view().kind !== "alias" && view().kind !== "setting-edit") setQuery("")
  else if (!atRoot()) pop()
  else host.dismiss()
}

// ------------------------------------------------------------ key helpers
function editsFilter(e, text) {
  if (!text) return false
  if (e.altKey || e.metaKey) return false
  if (e.key === "u") return e.ctrlKey && !e.shiftKey
  return e.key === "Backspace"
}
function editedFilter(e, text) {
  if (e.key === "u") return ""
  if (e.ctrlKey) return text.replace(/\s+$/, "").replace(/\S+$/, "")
  return text.slice(0, -1)
}
function isTyping(e) {
  return e.key && e.key.length === 1 && e.key.charCodeAt(0) >= 32 && e.key.charCodeAt(0) !== 127
    && !e.ctrlKey && !e.altKey && !e.metaKey
}
// -1 up, 1 down or 0, per the navigation bindings. Ctrl+P only moves up
// inside popups: in the list it opens the dropdown.
function direction(e, ctrl, alt, inPopup) {
  var k = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (!ctrl && !alt && e.key === "ArrowDown") return 1
  if (!ctrl && !alt && e.key === "ArrowUp") return -1
  if (!ctrl || alt || e.shiftKey) return 0
  if (vim()) return k === "j" ? 1 : (k === "k" ? -1 : 0)
  return k === "n" ? 1 : (k === "p" && inPopup ? -1 : 0)
}
function isActionPanelKey(ctrl, alt, shift, k) {
  if (k !== "k" || shift) return false
  return vim() ? (alt && !ctrl) : (ctrl && !alt)
}
function handlePopupKey(e, panel, ctrl, alt) {
  var dir = direction(e, ctrl, alt, true)
  if (dir) { panel.move(dir); return true }
  if (e.key === "Enter") { panel.activate(); return true }
  if (editsFilter(e, panel.filter)) { panel.filter = editedFilter(e, panel.filter); panel.refilter(); return true }
  if (isTyping(e)) { panel.filter += e.key; panel.refilter(); return true }
  return true
}

// Typing, Tab and Backspace while an argument pill has focus.
function handleArgumentKey(e, shift) {
  var def = W.argDefs[W.argFocus]
  var value = W.argValues[def.name] || ""
  var k = e.key
  function set(next) {
    W.argValues = Object.assign({}, W.argValues)
    W.argValues[def.name] = next
    renderHeader()
  }
  if (k === "Tab") {
    var step = shift ? -1 : 1
    var nextIndex = W.argFocus + step
    W.argFocus = nextIndex >= W.argDefs.length ? 0 : nextIndex
    renderAll()
    return true
  }
  if (k === "Backspace" && !value) { W.argFocus--; renderAll(); return true }
  if (editsFilter(e, value)) { set(editedFilter(e, value)); return true }
  if (isTyping(e)) { set(value + e.key); return true }
  return false
}

// The LauncherWindow.handleKey port.
function handleKey(e) {
  var ctrl = e.ctrlKey
  var shift = e.shiftKey
  var alt = e.altKey
  var meta = e.metaKey
  var k = e.key
  var kl = k.length === 1 ? k.toLowerCase() : k
  var enter = k === "Enter"

  if (W.alert) {
    if (k === "Escape") { W.alert = null; renderPanels() }
    else if (enter) confirmAlert()
    return true
  }
  if (k === "Escape") { handleEscape(shift); return true }
  if (ctrl && (k === "+" || k === "=")) { setZoom(zoom() + 0.1); return true }
  if (ctrl && k === "-") { setZoom(zoom() - 0.1); return true }
  if (ctrl && k === "0") { setZoom(1); return true }
  if (ctrl && k === "[") { closePopups(); pop(); renderAll(); return true }
  // Ctrl+V, Ctrl+Shift+V (the terminal habit) and Shift+Insert paste.
  if ((kl === "v" && ctrl && !alt && !meta) || (k === "Insert" && shift && !ctrl && !alt && !meta)) {
    pasteClipboard()
    return true
  }

  if (W.aboutOpen) {
    if (ctrl && shift && kl === "k") { W.aboutOpen = false; renderPanels() }
    return true
  }
  if (W.dropdownOpen) {
    if (ctrl && !shift && kl === "p") { W.dropdownOpen = false; renderPanels(); renderHeader(); return true }
    return handlePopupKey(e, dropdownState, ctrl, alt)
  }
  if (W.toastPanelOpen) {
    if (ctrl && kl === "t") { toggleToastPanel(); return true }
    return handlePopupKey(e, toastPanelState, ctrl, alt)
  }
  if (W.actionPanelOpen) {
    if (isActionPanelKey(ctrl, alt, shift, kl)) { W.actionPanelOpen = false; renderPanels(); renderHeader(); return true }
    return handlePopupKey(e, actionPanelState, ctrl, alt)
  }

  if (view().kind === "alias" || view().kind === "setting-edit") {
    if (enter) { if (view().kind === "alias") saveAlias(); else saveSettingEdit(); return true }
    if (k === " " && view().kind === "alias") return true
  } else {
    if (atRoot() && enter && ctrl && alt && !shift) { askAgent(); return true }
    if (ctrl && shift && kl === "k") { toggleAbout(); return true }
    if (isActionPanelKey(ctrl, alt, shift, kl)) { toggleActionPanel(); return true }
    if (ctrl && !shift && kl === "p") { toggleDropdown(); return true }
    if (ctrl && !shift && kl === "t") { toggleToastPanel(); return true }
    if (view().kind === "web-search" && enter && !ctrl && !alt && !String(W.query || "").trim()) { showToast("failure", "Type a query first"); return true }
    if (view().kind === "quick-capture" && enter && !shift && !alt && !String(W.query || "").trim()) { showToast("failure", "Type a note first"); return true }
    if (view().kind === "todoist-add") return handleAddFormKey(e, enter, ctrl, alt, shift)
    if (view().kind === "quick-capture" && enter && ctrl && !shift && !alt) { perform("open"); return true }
    if (enter && ctrl && shift) { performNth(2); return true }
    if (enter && ctrl) { performNth(1); return true }
    if (enter) { performNth(0); return true }
    if (W.argFocus >= 0 && handleArgumentKey(e, shift)) return true
    if (k === "Tab" && W.argDefs.length) { W.argFocus = 0; renderAll(); return true }
    if (ctrl && alt && e.key === "ArrowUp") { performIfOffered(["favorite-up"]); return true }
    if (ctrl && alt && e.key === "ArrowDown") { performIfOffered(["favorite-down"]); return true }
    if (ctrl && e.key === "ArrowUp") { jumpSection(-1); return true }
    if (ctrl && e.key === "ArrowDown") { jumpSection(1); return true }
    var dir = direction(e, ctrl, alt, false)
    if (dir < 0) {
      if (atRoot() && (W.query === "" || W.historyIndex >= 0) && W.selectedIndex === nextSelectable(-1, 1) && recallHistory(1)) return true
      move(-1)
      return true
    }
    if (dir > 0) {
      if (W.historyIndex >= 0) { recallHistory(-1); return true }
      move(1)
      return true
    }
    if (k === "PageUp") { move(-8); return true }
    if (k === "PageDown") { move(8); return true }
    if (ctrl && shift && kl === "f") { performIfOffered(["favorite-add", "favorite-remove"]); return true }
    if (ctrl && shift && kl === "c") { performIfOffered(["copy-command", "copy-id", "copy-question-answer", "copy-path", "copy-pid", "copy-url", "copy-note", "copy"]); return true }
    if (ctrl && shift && kl === "d") { performIfOffered(["delete-all-entries"]); return true }
    if (ctrl && kl === "d") { performIfOffered(["delete-entry"]); return true }
    if (alt && shift && kl === "d") { performIfOffered(["disable"]); return true }
    if (ctrl && k >= "1" && k <= "9") {
      var target = nthItem(k.charCodeAt(0) - 48)
      if (target >= 0) perform("open", target)
      return true
    }
  }

  if (editsFilter(e, W.query)) { setQuery(editedFilter(e, W.query)); return true }
  if (k === "Backspace" && !W.query && !atRoot()) { pop(); return true }
  if (isTyping(e)) { setQuery(W.query + e.key); return true }
  return false
}

// ----------------------------------------------------------------- wiring
document.addEventListener("keydown", function(e) {
  if (handleKey(e)) { e.preventDefault(); e.stopPropagation() }
}, true)

// Small-window mode: clicks outside the window land on the underlying app
// and dismiss us through main's blur handler; the #window mousedown below
// only catches the rounding pixels. Card click = close popups and refocus.
el.window.addEventListener("mousedown", function(e) {
  if (e.target === el.window && !backend.config.keepVisibleOnFocusLoss) host.dismiss()
})
el.card.addEventListener("mousedown", function() {
  closePopups()
  renderPanels()
})
el.lead.addEventListener("mousedown", function(e) {
  e.stopPropagation()
  if (!atRoot()) pop()
})
el.filterbutton.addEventListener("mousedown", function(e) {
  e.stopPropagation()
  toggleDropdown()
})
el.alertCancel.addEventListener("mousedown", function(e) {
  e.stopPropagation()
  W.alert = null
  renderPanels()
})
el.alertOk.addEventListener("mousedown", function(e) {
  e.stopPropagation()
  confirmAlert()
})
el.alert.addEventListener("mousedown", function(e) {
  if (e.target === el.alert) { W.alert = null; renderPanels() }
})

// ----------------------------------------------------------- show/hide
function prepare() {
  if (popTimer) { clearTimeout(popTimer); popTimer = null }
  if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null; pendingReset = false }
  W.historyIndex = -1
  closePopups()
  rebuild(true)
}

host.onVisibility(function(visible) {
  // The backend's own show handler (QML's Connections block): refresh
  // exchange rates, re-scan the Start Menu, re-walk files when stale.
  // Deferred past the first paint: those spawns + walks used to contend
  // with the first keystrokes, so typing started ~a second late. The
  // window paints from cache first, refreshes land in the background. [D]
  if (visible) setTimeout(function() { if (W.shown) backend.visibility(visible) }, 250)
  else backend.visibility(visible)
  if (!W.shown && visible) {
    W.shown = true
    prepare()
    renderAll()
    // Keystrokes only reach the document when the window really holds
    // keyboard focus; Windows can refuse it to a fresh frameless window.
    // Ask main to break the foreground lock if we didn't get it. [D]
    setTimeout(function() {
      if (W.shown && !document.hasFocus()) host.refocus()
    }, 150)
    return
  }
  if (W.shown && !visible) {
    W.shown = false
    closePopups()
    var seconds = Number(general.popToRootTimeout)
    if (!(seconds > 0)) popToRoot()
    else popTimer = setTimeout(popToRoot, seconds * 1000)
    renderAll()
  }
})

// Backend notifications (the QML Connections block).
backend.onNotification(function(method, data) {
  // config.json changed (Theme/Font/gaps/corner in the Settings view, or
  // the file edited on disk): repaint in place.
  if (method === "settings.configChanged") retheme()
  if (method === "agent.launchFailed" && W.shown) showToast("failure", data.message)
  if (method === "todoist.tasksChanged" && W.shown && !W.actionPanelOpen && !W.alert) rebuild(false)
  if ((method === "todoist.taskAdded" || method === "todoist.taskCompleted" || method === "todoist.taskDeleted") && W.shown) showToast("success", data.message)
  if (method === "todoist.error" && W.shown) showToast("failure", data.message)
  // A submitted add form pops back to the root like Update Task dismisses
  // the editor; errors stay in the form for a retry. [D]
  if (method === "todoist.taskAdded" && view().kind === "todoist-add") { W.addSubmitting = false; pop(); renderAll() }
  if (method === "todoist.error" && view().kind === "todoist-add") W.addSubmitting = false
  if (method === "agent.launchReady") {
    host.dismiss()
    popToRoot()
    host.execDetached(data.argv)
  }
})

// Revision polling replaces QML property bindings: candidates → rebuild,
// calculator → rebuild only with a query, stores → refresh general. [D]
function refreshGeneral() {
  var r = backend.callSync("settings.getGeneralSettings", null)
  general = r && r.ok ? r.data : Object.assign({}, DEFAULT_GENERAL)
}
var lastRev = { candidates: -1, calculator: -1, store: -1, todoist: -1 }
setInterval(function() {
  var candChanged = backend.candidatesRevision !== lastRev.candidates
  var calcChanged = backend.calculatorRevision !== lastRev.calculator
  var storeChanged = backend.storeRevision !== lastRev.store
  var todoChanged = backend.todoistRevision !== lastRev.todoist
  lastRev.candidates = backend.candidatesRevision
  lastRev.calculator = backend.calculatorRevision
  lastRev.store = backend.storeRevision
  lastRev.todoist = backend.todoistRevision
  if (storeChanged) refreshGeneral()
  if (!W.shown) return
  // A scheduled keystroke rebuild already covers these revisions; running
  // a second synchronous rebuild here doubled the per-keystroke cost. [D]
  if (rebuildTimer) return
  if (candChanged && !W.actionPanelOpen && !W.alert) rebuild(false)
  else if (todoChanged && !W.actionPanelOpen && !W.alert) rebuild(false)
  else if (calcChanged && !W.actionPanelOpen && W.query) rebuild(false)
  el.loader.classList.toggle("visible", backend.loading)
}, 120)

// ------------------------------------------------------- CLI pipe bridge
host.onIpc(function(msg) {
  var value
  if (msg.kind === "run") {
    // `oma-cast run` is explicit, so it skips the confirmation alert.
    var r = backend.callSync("rootSearch.performAction", { id: String(msg.payload), action: "open", query: "", confirmed: true })
    if (r.ok && r.data && r.data.push) { W.shown = true; push(r.data.push); renderAll() }
    value = r
  } else if (msg.kind === "call") {
    value = backend.callSync(msg.payload.method, msg.payload.data === undefined ? null : msg.payload.data)
  } else {
    value = { ok: false, error: "Unknown kind " + msg.kind }
  }
  host.ipcResult(msg.id, value)
})

// ------------------------------------------------------------------ init
refreshGeneral()
applyThemeVars()
layout()
rebuild(true)
renderAll()
window.addEventListener("resize", function() { layout(); renderPanels() })
