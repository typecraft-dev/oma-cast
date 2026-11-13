"use strict"
// Extension Form DOM renderer — the port of plugin/ui/ExtensionForm.qml.
// Renders every field kind from the render-tree schema (ref 03 §2.4).
// Depends on shared globals from app.js (W, px, el) and ExtensionForm core
// injected as window.ExtensionForm (falls back to a minimal shim when the
// core script is not loaded, e.g. unit tests).

function extFormCore() {
  if (typeof window !== "undefined" && window.ExtensionForm) return window.ExtensionForm
  // The renderer runs with nodeIntegration: core modules arrive via
  // require like app.js does, not as window globals. [D]
  try {
    if (typeof require !== "undefined") return require("../../plugin/core/ExtensionForm.js")
  } catch (e) {}
  return null
}

function renderExtensionForm(container, rawForm, hooks) {
  hooks = hooks || {}
  var core = extFormCore()
  var form
  if (core) form = core.normalizeForm(rawForm)
  else {
    form = rawForm && rawForm.kind === "Form" ? rawForm : { kind: "Form", items: [] }
    if (!Array.isArray(form.items)) form.items = []
  }
  container.innerHTML = ""
  // normalizeForm already shaped every item: never normalize twice — a
  // second pass reads menu/suggestionValues off the normalized shape
  // and wipes Dropdown sections and TagPicker suggestions. [D]
  var values = core ? core.initialValues(form) : {}
  if (!core) {
    form.items.forEach(function (it) {
      if (it.kind === "Separator" || it.kind === "Description") return
      values[it.id] = it.value !== undefined ? it.value : ""
    })
  }

  function setVal(id, v) {
    values[id] = v
    if (hooks.onChange) hooks.onChange(id, v)
  }

  form.items.forEach(function (it) {
    var wrap = document.createElement("div")
    wrap.className = "form-field"
    wrap.dataset.fieldId = it.id || ""
    wrap.dataset.kind = it.kind || ""
    if (it.title && it.kind !== "Checkbox" && it.kind !== "Separator") {
      var label = document.createElement("label")
      label.className = "form-label"
      label.textContent = it.title
      wrap.appendChild(label)
    }
    var input = null
    if (it.kind === "TextField" || it.kind === "PasswordField") {
      input = document.createElement("input")
      input.type = it.isSecure ? "password" : "text"
      input.placeholder = it.placeholder || ""
      input.value = values[it.id] !== undefined ? String(values[it.id]) : ""
      input.addEventListener("input", function () { setVal(it.id, input.value) })
    } else if (it.kind === "TextArea") {
      input = document.createElement("textarea")
      input.placeholder = it.placeholder || ""
      input.value = values[it.id] !== undefined ? String(values[it.id]) : ""
      input.addEventListener("input", function () { setVal(it.id, input.value) })
    } else if (it.kind === "Checkbox") {
      input = document.createElement("input")
      input.type = "checkbox"
      input.checked = !!values[it.id]
      var lab = document.createElement("label")
      lab.className = "form-check"
      lab.appendChild(input)
      var span = document.createElement("span")
      span.textContent = it.checkboxTitle || it.title || ""
      lab.appendChild(span)
      input.addEventListener("change", function () { setVal(it.id, input.checked) })
      wrap.appendChild(lab)
    } else if (it.kind === "DatePicker") {
      input = document.createElement("input")
      input.type = it.type === "date_time" ? "datetime-local" : "date"
      if (values[it.id] != null) input.value = String(values[it.id])
      if (it.min) input.min = String(it.min)
      if (it.max) input.max = String(it.max)
      input.addEventListener("input", function () { setVal(it.id, input.value) })
    } else if (it.kind === "Dropdown") {
      input = document.createElement("select")
      ;(it.sections || []).forEach(function (s) {
        var g = document.createElement("optgroup")
        g.label = s.title || ""
        ;(s.items || []).forEach(function (opt) {
          var o = document.createElement("option")
          o.value = opt.value
          o.textContent = opt.title
          if (String(opt.value) === String(values[it.id])) o.selected = true
          g.appendChild(o)
        })
        input.appendChild(g)
      })
      input.addEventListener("change", function () { setVal(it.id, input.value) })
    } else if (it.kind === "TagPicker" || it.kind === "FilePicker") {
      input = document.createElement("input")
      input.type = "text"
      input.placeholder = it.placeholder || (it.kind === "TagPicker" ? "Comma-separated values" : "/path/to/file")
      var cur = values[it.id]
      input.value = Array.isArray(cur) ? cur.join(", ") : String(cur || "")
      if ((it.suggestions || []).length) {
        input.setAttribute("list", "tag-suggest-" + it.id)
        var dl = document.createElement("datalist")
        dl.id = "tag-suggest-" + it.id
        it.suggestions.forEach(function (s) {
          var o = document.createElement("option")
          o.value = s.value
          o.label = s.title
          dl.appendChild(o)
        })
        wrap.appendChild(dl)
      }
      input.addEventListener("input", function () {
        var arr = input.value.split(",").map(function (x) { return x.trim() }).filter(Boolean)
        setVal(it.id, arr)
      })
    } else if (it.kind === "Separator") {
      var hr = document.createElement("hr")
      hr.className = "form-sep"
      wrap.appendChild(hr)
    } else {
      var p = document.createElement("div")
      p.className = "form-desc"
      p.textContent = it.text || ""
      wrap.appendChild(p)
    }
    if (input && it.kind !== "Checkbox") wrap.appendChild(input)
    if (it.info) {
      var info = document.createElement("div")
      info.className = "form-info"
      info.textContent = it.info
      wrap.appendChild(info)
    }
    container.appendChild(wrap)
  })

  function focusFirst() {
    var first = container.querySelector("input, select, textarea")
    if (first) first.focus()
  }

  function focusNext(direction) {
    var els = Array.prototype.slice.call(container.querySelectorAll("input, select, textarea"))
    if (!els.length) return
    var at = els.indexOf(document.activeElement)
    var next = at < 0 ? (direction > 0 ? 0 : els.length - 1)
      : Math.max(0, Math.min(els.length - 1, at + direction))
    els[next].focus()
  }

  return {
    form: form,
    focusFirst: focusFirst,
    focusNext: focusNext,
    getValues: function () { return Object.assign({}, values) },
    submit: function () {
      var errs = core ? core.validateForm(values, form) : {}
      if (Object.keys(errs).length) {
        if (hooks.onError) hooks.onError(errs)
        return { ok: false, errors: errs }
      }
      var out = core ? core.unwrappedValues(values, form) : Object.assign({}, values)
      if (hooks.onSubmit) hooks.onSubmit(out)
      return { ok: true, values: out }
    }
  }
}

if (typeof module !== "undefined") module.exports = { renderExtensionForm: renderExtensionForm }
