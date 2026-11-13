// oma-cast UI, part 2: row/panel/footer/alert rendering — the ports of
// ResultRow.qml, ActionPanel.qml, InfoPanel.qml, Alert.qml and KeyHint.qml.
// Loaded after app.js; shares its globals (classic script, like the QML
// components share their engine). [D]
"use strict"

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
  var row = W.rows[index]
  return !!row && (row.rowKind === "item" || row.rowKind === "calculator")
}
function nextSelectable(from, direction) {
  for (var i = from + direction; i >= 0 && i < W.rows.length; i += direction) if (isSelectable(i)) return i
  return -1
}

// (Was accessoryWidth: the middle column used to inset by a JS-measured
// accessories width — one forced layout per row per keystroke. Rows are
// flex now, so the browser does it in one layout pass; kept for reference.)
function accessoryWidth(row) {
  return 0
}

function itemRowEl(row, index) {
  var node = document.createElement("div")
  node.className = "row" + (row.disabled ? " disabled" : "")
  node.style.height = px(42) + "px"
  node.dataset.index = String(index)

  var iconBox = document.createElement("div")
  iconBox.className = "iconbox"
  if (row.iconName && !row.glyph) {
    // App rows: the extracted .lnk icon, resolved through apps.iconSource
    // (the Quickshell.iconPath / appLibrary.iconSource slot).
    var img = document.createElement("img")
    img.style.width = "100%"
    img.style.height = "100%"
    backend.appsIcon(row.iconName).then(function(url) {
      if (url) { img.src = url; return }
      // Nothing extracted (protected link, PowerShell missing): fall back to
      // a generic window glyph so the icon column is never blank. [D]
      img.remove()
      if (iconBox.childElementCount) return
      var g = document.createElement("span")
      g.textContent = GLYPH_APP
      iconBox.appendChild(g)
    })
    iconBox.appendChild(img)
  } else if (row.glyph) {
    var g = document.createElement("span")
    g.textContent = row.glyph
    if (row.glyphFont === "omarchy") g.className = "omarchy-glyph"
    iconBox.appendChild(g)
  }
  node.appendChild(iconBox)

  var middle = document.createElement("div")
  middle.className = "middle"
  var title = document.createElement("span")
  title.className = "title"
  title.textContent = row.title
  middle.appendChild(title)
  if (row.subtitle) {
    var sub = document.createElement("span")
    sub.className = "subtitle"
    sub.textContent = row.subtitle
    middle.appendChild(sub)
  }
  node.appendChild(middle)

  var acc = document.createElement("div")
  acc.className = "accessories"
  if (row.alias) {
    var chip = document.createElement("span")
    chip.className = "alias-chip"
    chip.textContent = row.alias
    acc.appendChild(chip)
  }
  if (row.favorite) {
    var fav = document.createElement("span")
    fav.className = "favorite"
    fav.textContent = GLYPH_FAV
    acc.appendChild(fav)
  }
  if (row.checked) {
    var chk = document.createElement("span")
    chk.className = "checked"
    chk.textContent = "✓"
    acc.appendChild(chk)
  }
  var tl = document.createElement("span")
  tl.className = "typelabel"
  tl.textContent = row.typeLabel
  acc.appendChild(tl)
  node.appendChild(acc)

  bindRowPointer(node, index)
  return node
}

function sectionRowEl(row) {
  var node = document.createElement("div")
  node.className = "section"
  node.style.height = px(row.title ? 30 : 6) + "px"
  if (row.title) {
    var span = document.createElement("span")
    span.textContent = row.title
    node.appendChild(span)
  }
  return node
}

function calcRowEl(row, index) {
  var L = look()
  var node = document.createElement("div")
  node.className = "row calc"
  node.style.height = px(118) + "px"
  node.dataset.index = String(index)

  var panes = [
    { text: row.calcInput, caption: row.calcInputCaption, answer: false },
    { text: row.calcResult, caption: row.calcResultCaption, answer: true }
  ]
  panes.forEach(function(pair, i) {
    var pane = document.createElement("div")
    pane.className = "pane " + (i === 0 ? "left" : "right")
    var text = document.createElement("div")
    text.className = "calc-text" + (pair.answer ? " answer" : "")
    text.textContent = pair.text
    text.style.fontSize = Math.round(theme.font("heading") * 1.25 * zoom()) + "px"
    text.style.fontWeight = pair.answer ? 600 : 400
    text.style.color = pair.answer && index === W.selectedIndex ? L.accent : L.foreground
    pane.appendChild(text)
    if (pair.caption) {
      var cap = document.createElement("div")
      cap.className = "caption"
      cap.textContent = pair.caption
      pane.appendChild(cap)
    }
    node.appendChild(pane)
  })
  var arrow = document.createElement("div")
  arrow.className = "arrow"
  arrow.textContent = "→"
  node.appendChild(arrow)

  bindRowPointer(node, index)
  // Text.HorizontalFit: shrink the display size down to body size instead
  // of eliding the math.
  requestAnimationFrame(function() {
    var texts = node.querySelectorAll(".calc-text")
    for (var i = 0; i < texts.length; i++) {
      var t = texts[i]
      var size = parseFloat(t.style.fontSize)
      var avail = t.parentElement.clientWidth - px(24)
      var natural = measure(t.textContent, getComputedStyle(t).font)
      if (natural > avail && natural > 0) t.style.fontSize = Math.max(fontPx("body"), Math.floor(size * avail / natural)) + "px"
    }
  })
  return node
}

// The PointerMoveGate contract: hover only after real pointer movement.
function bindRowPointer(node, index) {
  node.addEventListener("mousemove", function(e) {
    if (W.actionPanelOpen) return
    var rect = el.card.getBoundingClientRect()
    if (gate.moved({ x: e.clientX - rect.left, y: e.clientY - rect.top })) select(index)
  })
  node.addEventListener("mousedown", function(e) {
    e.preventDefault()
    e.stopPropagation()
    perform("open", index)
  })
}

function renderList() {
  gate.reset()
  // The add view is a structured ExtensionForm (the editor card), not
  // rows: it renders once per push and keeps its own input state. [D]
  var isAddForm = view().kind === "todoist-add"
  el.todoform.style.display = isAddForm ? "block" : "none"
  if (isAddForm) {
    var formKey = W.stack.length + ":todoist-add"
    if (W.formKey !== formKey || !W.formHandler) {
      W.formKey = formKey
      W.addSubmitting = false
      el.todoform.innerHTML = ""
      W.formHandler = renderExtensionForm(el.todoform, Todoist.addFormDefinition(), {})
      var btn = document.createElement("button")
      btn.className = "form-submit"
      btn.textContent = "Add Task \u21b5"
      btn.addEventListener("mousedown", function(e) { e.stopPropagation() })
      btn.addEventListener("click", function() { submitAddForm() })
      el.todoform.appendChild(btn)
      W.formHandler.focusFirst()
    }
  } else if (W.formKey) { W.formKey = null; W.formHandler = null }
  el.list.innerHTML = ""
  W.rows.forEach(function(row, index) {
    if (row.rowKind === "section") el.list.appendChild(sectionRowEl(row))
    else if (row.rowKind === "calculator") el.list.appendChild(calcRowEl(row, index))
    else el.list.appendChild(itemRowEl(row, index))
  })

  var v = view()
  var isEditor = v.kind === "alias" || v.kind === "setting-edit"
  var emptyVisible = (isEditor || W.rows.length === 0) && v.kind !== "todoist-add"
  el.empty.classList.toggle("visible", emptyVisible && !compact())
  if (emptyVisible) {
    var isAlias = v.kind === "alias"
    var isSettingEdit = v.kind === "setting-edit"
    el.emptyGlyph.textContent = isAlias ? GLYPH_TAG : GLYPH_LOGO
    el.emptyGlyph.classList.toggle("omarchy-glyph", !isAlias)
    el.emptyGlyph.style.fontSize = px(28) + "px"
    el.emptyTitle.textContent = isAlias ? v.title
      : (isSettingEdit ? v.title
        : (v.kind === "quick-capture" && !W.query ? v.title
          : (v.kind === "todoist" && !W.query ? v.title
            : (v.kind === "todoist-add" && !W.query ? v.title
              : (v.kind === "web-search" && !W.query ? v.title
                : (v.kind === "calculator-history" && !W.query ? "No Calculations Yet"
                  : (backend.ready && !backend.loading ? "No results" : "Loading…")))))))
    el.emptyHint.textContent = isAlias
      ? "Typing the alias exactly in the root search puts this command on top. Leave it empty to remove it."
      : (isSettingEdit ? "Empty uses the default Notes folder."
        : (v.kind === "quick-capture" && !W.query ? "Type a note, then press \u21b5 or Ctrl+\u21b5 to save it."
          : (v.kind === "todoist" && !W.query ? "Type to filter tasks."
            : (v.kind === "todoist-add" && !W.query ? "Dates, #projects, @labels and p1–p4 are parsed."
              : (v.kind === "web-search" && !W.query ? "Type a query, then press \u21b5 to search."
            : (v.kind === "calculator-history" && !W.query ? "Type a calculation in the root search, then copy or paste the answer." : ""))))))
    el.emptyHint.style.display = el.emptyHint.textContent ? "block" : "none"
  }
  el.list.style.display = (isEditor || v.kind === "todoist-add") ? "none" : "block"
  paintSelection()
}

function paintSelection() {
  var children = el.list.children
  for (var i = 0; i < children.length; i++) {
    var idx = children[i].dataset ? Number(children[i].dataset.index) : NaN
    children[i].classList.toggle("selected", idx === W.selectedIndex)
    var answer = children[i].querySelector && children[i].querySelector(".pane.right .calc-text")
    if (answer) answer.style.color = idx === W.selectedIndex ? look().accent : look().foreground
  }
}

function scrollTo(index, toBeginning) {
  if (toBeginning) { el.list.scrollTop = 0; return }
  var node = el.list.children[index]
  if (!node) return
  var top = node.offsetTop
  var bottom = top + node.offsetHeight
  var vh = el.list.clientHeight
  if (top < el.list.scrollTop) el.list.scrollTop = top
  else if (bottom > el.list.scrollTop + vh) el.list.scrollTop = bottom - vh
}

function select(index) {
  W.selectedIndex = index
  W.selectedRow = index >= 0 && index < W.rows.length ? W.rows[index] : null
  var id = W.selectedRow ? W.selectedRow.itemId : ""
  if (id !== W.argsForId) {
    W.argsForId = id
    W.argValues = {}
    W.argFocus = -1
  }
  W.argDefs = W.selectedRow && W.selectedRow.argsJson ? JSON.parse(W.selectedRow.argsJson) : []
  if (index >= 0) scrollTo(index, index === nextSelectable(-1, 1))
  paintSelection()
  renderHeader()
  renderFooter()
}

function move(delta) {
  gate.reset()
  if (W.selectedIndex < 0) { select(nextSelectable(-1, 1)); return }
  var step = delta > 0 ? 1 : -1
  var target = W.selectedIndex
  for (var n = 0; n < Math.abs(delta); n++) {
    var next = nextSelectable(target, step)
    if (next < 0) break
    target = next
  }
  select(target)
}

function jumpSection(direction) {
  var i = W.selectedIndex
  for (i += direction; i >= 0 && i < W.rows.length; i += direction) if (W.rows[i].rowKind === "section") break
  if (direction < 0) for (i -= 1; i >= 0; i--) if (W.rows[i].rowKind === "section") break
  var first = nextSelectable(Math.max(-1, i), 1)
  if (first >= 0) select(first)
}

function nthItem(n) {
  var seen = 0
  for (var i = 0; i < W.rows.length; i++) {
    if (!isSelectable(i)) continue
    if (++seen === n) return i
  }
  return -1
}

// ----------------------------------------------------------------- footer
// KeyHint.qml: one rounded pill per space-separated key.
function keyHint(keys, node) {
  node.innerHTML = ""
  if (!keys) { node.style.display = "none"; return }
  node.style.display = "inline-flex"
  keys.split(" ").forEach(function(part) {
    var span = document.createElement("span")
    span.textContent = part
    node.appendChild(span)
  })
}

function renderFooter() {
  var v = view()
  var toast = W.toast

  if (toast) {
    el.toastIcon.className = "toast" + (toast.style === "failure" ? " failure" : "")
    el.toastIcon.textContent = toast.style === "failure" ? GLYPH_FAIL : GLYPH_OK
    el.toastIcon.style.fontSize = px(12) + "px"
  } else {
    el.toastIcon.className = "omarchy-glyph"
    el.toastIcon.textContent = GLYPH_LOGO
    el.toastIcon.style.fontSize = px(11) + "px"
  }
  el.toastText.className = toast ? "toast" : ""
  el.toastText.textContent = toast ? toast.title : v.title
  keyHint(toast && toast.actions.length ? "Ctrl T" : "", el.toastHint)

  var primary
  if (v.kind === "alias") primary = { title: "Save Alias" }
  else if (v.kind === "setting-edit") primary = { title: "Save" }
  else {
    var list = actionsForSelected()
    primary = list.length ? list[0] : null
  }
  el.primaryTitle.textContent = primary ? primary.title : ""
  el.primaryTitle.style.display = primary ? "inline" : "none"
  keyHint(primary ? "↵" : "", el.primaryHint)

  var aliasView = v.kind === "alias" || v.kind === "setting-edit"
  el.footerDivider.style.display = aliasView ? "none" : "block"
  el.actionsTitle.style.display = aliasView ? "none" : "inline"
  keyHint(aliasView ? "" : actionPanelKeys(), el.actionsHint)
}

// ----------------------------------------------------------------- panels
function panelRowEl(action, index, panelState) {
  var prev = panelState.visible[index - 1]
  var newSection = index > 0 && prev && prev.section !== action.section
  var wrap = document.createElement("div")
  wrap.className = "action"
  wrap.style.height = px(34) + "px"
  wrap.style.marginTop = newSection ? px(9) + "px" : "0px"
  if (newSection) {
    var sep = document.createElement("div")
    sep.className = "newsep"
    wrap.appendChild(sep)
  }
  if (index === panelState.selectedIndex) wrap.classList.add("selected")

  var icon = document.createElement("span")
  icon.className = "icon" + (action.icon === GLYPH_LOGO ? " omarchy-glyph" : "")
  icon.textContent = action.icon || ""
  wrap.appendChild(icon)
  var label = document.createElement("span")
  label.className = "label"
  label.textContent = action.title
  wrap.appendChild(label)
  var keys = document.createElement("span")
  keys.className = "keys"
  var hint = document.createElement("span")
  hint.className = "keyhint"
  keyHint(action.shortcut || "", hint)
  keys.appendChild(hint)
  if (!action.shortcut) keys.style.display = "none"
  wrap.appendChild(keys)

  wrap.addEventListener("mousemove", function() {
    if (panelState.selectedIndex !== index) { panelState.selectedIndex = index; paintPanel(panelState) }
  })
  wrap.addEventListener("mousedown", function(e) {
    e.preventDefault()
    e.stopPropagation()
    panelState.selectedIndex = index
    panelState.activate()
  })
  return wrap
}

function paintPanel(panelState) {
  var list = panelState.el.querySelector(".panel-list")
  list.innerHTML = ""
  panelState.visible.forEach(function(action, index) { list.appendChild(panelRowEl(action, index, panelState)) })
  var search = panelState.el.querySelector(".panel-search span")
  var filterText = panelState.filter || panelState.placeholder
  // ActionPanel.qml: elide the filter text at the start, LTR.
  var searchFont = "12px " + look().fontFamily
  var searchRoom = Math.max(0, (search.parentElement ? search.parentElement.clientWidth : 0) - 28)
  search.textContent = elideLeft(filterText, searchRoom, function(t) { return measure(t, searchFont) })
  search.className = panelState.filter ? "filled" : ""
}

// ActionPanel.qml sizing: min(px(360), content + searchRow + px(16)).
function panelGeometry(panelState) {
  var panel = panelState.el
  var rowsH = panelState.visible.reduce(function(acc, a, i) {
    var prev = panelState.visible[i - 1]
    var newSection = i > 0 && prev && prev.section !== a.section
    return acc + px(34) + (newSection ? px(9) : 0)
  }, 0) + px(12)
  panel.style.height = Math.min(px(360), rowsH + px(38) + px(16)) + "px"
  var footerH = px(42)
  if (panelState.placement === "bottom-right") {
    panel.style.right = (Math.round(theme.borderSpec.widths.right) + px(10)) + "px"
    panel.style.left = "auto"
    panel.style.bottom = (footerH + px(6)) + "px"
    panel.style.top = "auto"
  } else if (panelState.placement === "top-right") {
    panel.style.right = (Math.round(theme.borderSpec.widths.right) + px(10)) + "px"
    panel.style.left = "auto"
    panel.style.top = (Math.round(theme.borderSpec.widths.top) + px(66) + px(4)) + "px"
    panel.style.bottom = "auto"
  } else {
    panel.style.left = (Math.round(theme.borderSpec.widths.left) + px(10)) + "px"
    panel.style.right = "auto"
    panel.style.bottom = (footerH + px(6)) + "px"
    panel.style.top = "auto"
  }
}

function makePanel(id, placement, placeholder, onActivated) {
  return {
    el: document.getElementById(id),
    placement: placement,
    placeholder: placeholder,
    filter: "",
    selectedIndex: 0,
    actions: [],
    visible: [],
    activate: function() {
      var a = this.visible[this.selectedIndex]
      if (a) onActivated(a.id)
    },
    move: function(delta) {
      var n = this.visible.length
      if (n === 0) return
      this.selectedIndex = (this.selectedIndex + delta + n) % n
      paintPanel(this)
    },
    refilter: function() {
      var f = this.filter.trim().toLowerCase()
      this.visible = this.actions.filter(function(a) { return !f || a.title.toLowerCase().indexOf(f) >= 0 })
      paintPanel(this)
      panelGeometry(this)
    }
  }
}

var actionPanelState = makePanel("actionpanel", "bottom-right", "Search for actions…", function(id) { perform(id) })
var dropdownState = makePanel("dropdown", "top-right", "Filter…", function(id) { setRootFilter(id) })
var toastPanelState = makePanel("toastpanel", "bottom-left", "Search toast actions…", function(id) { runToastAction(id) })

// ---------------------------------------------------------------- info/alert
function renderInfoPanel() {
  el.infopanel.classList.toggle("open", W.aboutOpen)
  if (!W.aboutOpen) return
  el.infoTitle.textContent = W.selectedRow ? W.selectedRow.title : ""
  el.infoRows.innerHTML = ""
  W.aboutRows.forEach(function(r) {
    var row = document.createElement("div")
    row.className = "info-row"
    var label = document.createElement("span")
    label.className = "label"
    label.textContent = r.label
    var value = document.createElement("span")
    value.className = "value"
    value.textContent = r.value
    row.appendChild(label)
    row.appendChild(value)
    el.infoRows.appendChild(row)
  })
  // InfoPanel.qml: width px(400), height = content + px(24).
  el.infopanel.style.width = px(400) + "px"
  el.infopanel.style.height = "auto"
  el.infopanel.style.height = el.infopanel.scrollHeight + "px"
  el.infopanel.style.right = (Math.round(theme.borderSpec.widths.right) + px(10)) + "px"
  el.infopanel.style.bottom = (px(42) + px(6)) + "px"
}

function renderAlert() {
  el.alert.classList.toggle("open", !!W.alert)
  if (!W.alert) return
  var spec = W.alert.spec
  el.alertTitle.textContent = spec.title || ""
  el.alertMessage.textContent = spec.message || ""
  el.alertMessage.classList.toggle("hidden", !spec.message)
  el.alertOkTitle.textContent = spec.primary || "OK"
  el.alertOk.className = "alert-button primary" + (spec.destructive ? " danger" : "")
  keyHint("Esc", el.alertCancel.querySelector(".keyhint"))
  keyHint("↵", el.alertOk.querySelector(".keyhint"))
  el.alertBox.style.width = px(320) + "px"
  el.alertBox.style.borderRadius = Math.max(theme.style.cornerRadius, px(10)) + "px"
}

// ------------------------------------------------------------------ toast
function showToast(style, title, actions) {
  var list = (actions || []).slice()
  if (style === "failure") list.push({ id: "copy-error", title: "Copy Error Message", copy: String(title || "") })
  W.toastPanelOpen = false
  W.toast = { style: style, title: String(title || ""), actions: list }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(function() {
    if (!W.toastPanelOpen) { W.toast = null; renderFooter() }
  }, list.length ? 6000 : 2500)
  renderFooter()
  renderPanels()
}

function renderPanels() {
  actionPanelState.el.classList.toggle("open", W.actionPanelOpen)
  dropdownState.el.classList.toggle("open", W.dropdownOpen)
  toastPanelState.el.classList.toggle("open", W.toastPanelOpen)
  if (W.actionPanelOpen) { paintPanel(actionPanelState); panelGeometry(actionPanelState) }
  if (W.dropdownOpen) { paintPanel(dropdownState); panelGeometry(dropdownState) }
  if (W.toastPanelOpen) { paintPanel(toastPanelState); panelGeometry(toastPanelState) }
  renderInfoPanel()
  renderAlert()
}

function runToastAction(actionId) {
  var action = (W.toast ? W.toast.actions : []).filter(function(a) { return a.id === actionId })[0]
  W.toastPanelOpen = false
  if (!action) { renderPanels(); return }
  if (action.copy !== undefined) {
    host.copy(action.copy)
    showToast("success", "Copied to Clipboard")
    return
  }
  var r = backend.callSync(action.call.method, action.call.data)
  if (!r.ok) { showToast("failure", r.error); return }
  W.toast = null
  rebuild(false)
  if (action.done) showToast("success", action.done)
}

// renderAll: everything, in QML binding order.
function renderAll() {
  applyThemeVars()
  layout()
  renderHeader()
  renderList()
  renderFooter()
  renderPanels()
}
