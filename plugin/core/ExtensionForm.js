// Extension Form view model (Raycast @raycast/api Form, ref 03 §2.4).
// Pure: no Qt, no fs, no Intl; shared by plugin/Backend.qml and
// electron/src/backend.js, rendered by plugin/ui/ExtensionForm.qml and
// electron/ui/form.js. [D]
//
// Every field kind from the render-tree schema is available here:
// TextField, PasswordField (TextField with isSecure), TextArea, Checkbox,
// DatePicker (date | date_time), Dropdown (+Section/Item), TagPicker
// (+Item), FilePicker, Separator, Description. Common item props:
// id, title, info, error, storeValue, autoFocus, value/defaultValue
// (Controlled {value, eventCount}), onChange/onBlur/onFocus callback ids,
// placeholder.

var KINDS = [
  "TextField", "PasswordField", "TextArea", "Checkbox", "DatePicker",
  "Dropdown", "TagPicker", "FilePicker", "Separator", "Description"
]

var SUBMIT_TYPES = { TextField: "textField", PasswordField: "textField", TextArea: "textArea" }

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function controlledValue(c, fallback) {
  if (isObject(c) && "value" in c) return c.value
  if (c === undefined || c === null) return fallback
  return c
}

function eventCountOf(c) {
  return isObject(c) && typeof c.eventCount === "number" ? c.eventCount : 0
}

// Normalize one raw render-tree item into a stable shape the renderers
// can switch on. Never throws: unknown kinds become Description errors.
function normalizeItem(raw) {
  var item = isObject(raw) ? raw : { kind: "Description", text: String(raw) }
  var kind = item.kind === "PasswordField" ? "TextField" : String(item.kind || "")
  var isSecure = item.kind === "PasswordField" || item.isSecure === true
  if (KINDS.indexOf(item.kind) < 0 && !(item.kind === "PasswordField")) {
    return { id: String(item.id || "unknown"), kind: "Description", title: "",
      text: "Unsupported field kind: " + String(item.kind),
      info: "", error: "", storeValue: false, autoFocus: false }
  }
  var out = {
    id: String(item.id || ""),
    kind: String(item.kind),
    title: String(item.title || ""),
    info: String(item.info || ""),
    error: String(item.error || ""),
    storeValue: item.storeValue === true,
    autoFocus: item.autoFocus === true,
    required: item.required === true,
    onChange: item.onChange === undefined ? null : item.onChange,
    onBlur: item.onBlur === undefined ? null : item.onBlur,
    onFocus: item.onFocus === undefined ? null : item.onFocus
  }
  if (kind === "TextField") {
    out.placeholder = String(item.placeholder || "")
    out.isSecure = isSecure
    out.value = String(controlledValue(item.value, controlledValue(item.defaultValue, "")))
    out.eventCount = Math.max(eventCountOf(item.value), eventCountOf(item.defaultValue))
  } else if (out.kind === "TextArea") {
    out.placeholder = String(item.placeholder || "")
    out.enableMarkdown = item.enableMarkdown === true
    out.value = String(controlledValue(item.value, controlledValue(item.defaultValue, "")))
    out.eventCount = Math.max(eventCountOf(item.value), eventCountOf(item.defaultValue))
  } else if (out.kind === "Checkbox") {
    out.checkboxTitle = String(item.checkboxTitle || item.label || "")
    var cv = controlledValue(item.value, controlledValue(item.defaultValue, false))
    out.value = cv === true || cv === "true"
    out.eventCount = Math.max(eventCountOf(item.value), eventCountOf(item.defaultValue))
  } else if (out.kind === "DatePicker") {
    out.type = item.type === "date_time" ? "date_time" : "date"
    out.min = item.min === undefined ? null : String(item.min)
    out.max = item.max === undefined ? null : String(item.max)
    out.value = controlledValue(item.value, controlledValue(item.defaultValue, null))
    out.value = out.value === null || out.value === undefined ? null : String(out.value)
    out.eventCount = Math.max(eventCountOf(item.value), eventCountOf(item.defaultValue))
  } else if (out.kind === "Dropdown") {
    out.placeholder = String(item.placeholder || "")
    out.sections = normalizeMenu(item.menu)
    out.value = controlledValue(item.value, controlledValue(item.defaultValue, null))
    out.value = out.value === null || out.value === undefined ? null : String(out.value)
    if (out.value === null) {
      var first = firstMenuValue(out.sections)
      out.value = first === null ? "" : first
    }
    out.eventCount = Math.max(eventCountOf(item.value), eventCountOf(item.defaultValue))
  } else if (out.kind === "TagPicker") {
    out.placeholder = String(item.placeholder || "")
    out.suggestions = Array.isArray(item.suggestionValues) ? item.suggestionValues.map(function (s) {
      return { title: String(s.title || s.value || ""), value: String(s.value === undefined ? s.title : s.value) }
    }) : []
    var tv = controlledValue(item.value, controlledValue(item.defaultValue, []))
    out.value = Array.isArray(tv) ? tv.map(String) : (tv === null || tv === undefined ? [] : [String(tv)])
    out.eventCount = Math.max(eventCountOf(item.value), eventCountOf(item.defaultValue))
    out.onCreate = item.onCreate === undefined ? null : item.onCreate
  } else if (out.kind === "FilePicker") {
    out.canChooseFiles = item.canChooseFiles !== false
    out.canChooseDirectories = item.canChooseDirectories === true
    out.showHiddenFiles = item.showHiddenFiles === true
    out.allowMultipleSelection = item.allowMultipleSelection === true
    var fv = controlledValue(item.value, controlledValue(item.defaultValue, []))
    out.value = Array.isArray(fv) ? fv.map(String) : (fv === null || fv === undefined ? [] : [String(fv)])
    out.eventCount = Math.max(eventCountOf(item.value), eventCountOf(item.defaultValue))
  } else if (out.kind === "Separator") {
    // id only
  } else if (out.kind === "Description") {
    out.text = String(item.text || "")
  }
  return out
}

function normalizeMenu(menu) {
  var sections = menu && Array.isArray(menu.sections) ? menu.sections : []
  return sections.map(function (s, si) {
    var items = Array.isArray(s.items) ? s.items : []
    return {
      id: String(s.id || ("section-" + si)),
      title: String(s.title || ""),
      items: items.map(function (it, ii) {
        return { id: String(it.id || ("item-" + ii)), title: String(it.title || it.value || ""),
          value: String(it.value === undefined ? it.id : it.value) }
      })
    }
  })
}

function firstMenuValue(sections) {
  for (var i = 0; i < sections.length; i++) {
    if (sections[i].items.length) return sections[i].items[0].value
  }
  return null
}

function menuValues(sections) {
  var vals = []
  sections.forEach(function (s) { s.items.forEach(function (it) { vals.push(it.value) }) })
  return vals
}

// Whole Form payload: {kind:"Form", navigationTitle?, isLoading,
// enableDrafts, searchBarAccessory?, items:[...]}.
function normalizeForm(raw) {
  var form = isObject(raw) ? raw : {}
  var items = Array.isArray(form.items) ? form.items : []
  return {
    kind: "Form",
    navigationTitle: String(form.navigationTitle || ""),
    isLoading: form.isLoading === true,
    enableDrafts: form.enableDrafts === true,
    searchBarAccessory: form.searchBarAccessory === undefined ? null : form.searchBarAccessory,
    items: items.map(normalizeItem)
  }
}

// Initial editable values keyed by field id.
function initialValues(form) {
  var values = {}
  var normalized = form && form.kind === "Form" ? form : normalizeForm(form)
  normalized.items.forEach(function (it) {
    if (it.kind === "Separator" || it.kind === "Description") return
    values[it.id] = it.value
  })
  return values
}

// Apply one field edit; returns {values, changed} without mutating input.
function applyChange(values, item, next) {
  var copy = {}
  Object.keys(values || {}).forEach(function (k) { copy[k] = values[k] })
  var v = next
  if (item.kind === "Checkbox") v = v === true || v === "true"
  else if (item.kind === "TagPicker" || item.kind === "FilePicker") v = Array.isArray(v) ? v.map(String) : [String(v)]
  else if (item.kind === "TextField" || item.kind === "TextArea") v = String(v)
  else if (item.kind === "Dropdown" || item.kind === "DatePicker") v = v === null ? null : String(v)
  copy[item.id] = v
  return { values: copy, changed: values ? values[item.id] !== v : true }
}

// Submit-form unwrapping (ref 03 §3.2): the API unwraps
// {id: {type, value}} to {id: value} with Date objects for dates.
// Plain-object dates stay ISO strings here; the worker revives them.
function submitPayload(values, form) {
  var normalized = form && form.kind === "Form" ? form : normalizeForm(form)
  var byId = {}
  normalized.items.forEach(function (it) { byId[it.id] = it })
  var out = {}
  Object.keys(values || {}).forEach(function (id) {
    var item = byId[id]
    var v = values[id]
    if (!item) { out[id] = { type: "default", value: v }; return }
    if (item.kind === "DatePicker") out[id] = { type: "date", value: v === null ? null : String(v) }
    else if (SUBMIT_TYPES[item.kind]) out[id] = { type: SUBMIT_TYPES[item.kind], value: v }
    else out[id] = { type: "default", value: v }
  })
  return out
}

function unwrappedValues(values, form) {
  var payload = submitPayload(values, form)
  var out = {}
  Object.keys(payload).forEach(function (id) { out[id] = payload[id].value })
  return out
}

// Validation: required text-like fields must be non-empty, dropdown values
// must be in the menu, dates must respect min/max. Returns {id: message}.
function validateForm(values, form) {
  var normalized = form && form.kind === "Form" ? form : normalizeForm(form)
  var errors = {}
  normalized.items.forEach(function (it) {
    if (it.kind === "Separator" || it.kind === "Description") return
    var v = values ? values[it.id] : undefined
    if (it.required === true || itemRequired(it)) {
      if (it.kind === "Checkbox") { if (v !== true) errors[it.id] = "Required" }
      else if (Array.isArray(v)) { if (!v.length) errors[it.id] = "Required" }
      else if (v === null || v === undefined || String(v) === "") errors[it.id] = "Required"
    }
    if (it.kind === "Dropdown" && v !== null && v !== undefined && String(v) !== "") {
      if (menuValues(it.sections).indexOf(String(v)) < 0) errors[it.id] = "Invalid option"
    }
    if (it.kind === "DatePicker" && v !== null && v !== undefined && String(v) !== "") {
      var t = Date.parse(String(v))
      if (isNaN(t)) errors[it.id] = "Invalid date"
      else {
        if (it.min && !isNaN(Date.parse(it.min)) && t < Date.parse(it.min)) errors[it.id] = "Too early"
        if (it.max && !isNaN(Date.parse(it.max)) && t > Date.parse(it.max)) errors[it.id] = "Too late"
      }
    }
  })
  return errors
}

function itemRequired(it) {
  return it.required === true
}

if (typeof module !== "undefined") {
  module.exports = {
    KINDS: KINDS, normalizeItem: normalizeItem, normalizeForm: normalizeForm,
    normalizeMenu: normalizeMenu, initialValues: initialValues,
    applyChange: applyChange, submitPayload: submitPayload,
    unwrappedValues: unwrappedValues, validateForm: validateForm,
    controlledValue: controlledValue
  }
}
