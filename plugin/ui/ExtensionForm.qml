import QtQuick
import QtQuick.Controls
import "../core/ExtensionForm.js" as ExtForm

// Extension Form view: renders every field kind from the render-tree
// schema (ref 03 §2.4) — TextField, PasswordField, TextArea, Checkbox,
// DatePicker, Dropdown, TagPicker, FilePicker, Separator, Description.
// Pure shaping lives in core/ExtensionForm.js; this file only lays out
// controls and emits {fieldId: value} through onSubmit/onChange.
Column {
  id: root
  property var form: ({ kind: "Form", items: [] })
  property var values: ({})
  property var errors: ({})
  // Loaded field controls (those with forceActiveFocus), in item order,
  // for focusFirst/focusNext keyboard flow.
  property var inputs: []
  signal submitted(var values)
  signal fieldChanged(string fieldId, var value)

  function setForm(raw) {
    root.inputs = []
    root.form = ExtForm.normalizeForm(raw)
    var v = ExtForm.initialValues(root.form)
    var out = {}
    for (var k in v) out[k] = v[k]
    root.values = out
    root.errors = {}
  }

  function setField(id, value) {
    var v = {}
    for (var k in root.values) v[k] = root.values[k]
    v[id] = value
    root.values = v
  }

  // Typing reached the window with no field focused (card background was
  // clicked): put it in the first text field instead of dropping it. [D]
  function typeIntoFirst(text) {
    var first = null
    for (var i = 0; i < root.form.items.length; i++) {
      var it = root.form.items[i]
      if (it.kind === "TextField" || it.kind === "PasswordField" || it.kind === "TextArea") { first = it; break }
    }
    if (!first) return
    setField(first.id, String(root.values[first.id] || "") + String(text))
    focusFirst()
  }

  function chompFirst() {
    for (var i = 0; i < root.form.items.length; i++) {
      var it = root.form.items[i]
      if (it.kind === "TextField" || it.kind === "PasswordField" || it.kind === "TextArea") {
        setField(it.id, String(root.values[it.id] || "").slice(0, -1))
        focusFirst()
        return
      }
    }
  }

  function focusFirst() {
    if (root.inputs.length) root.inputs[0].forceActiveFocus()
  }

  function focusNext(direction) {
    if (!root.inputs.length) return
    var at = -1
    for (var i = 0; i < root.inputs.length; i++) {
      if (root.inputs[i].activeFocus) { at = i; break }
    }
    var next = at < 0 ? (direction > 0 ? 0 : root.inputs.length - 1)
      : Math.max(0, Math.min(root.inputs.length - 1, at + direction))
    root.inputs[next].forceActiveFocus()
  }

  function fieldError(id) {
    return (root.errors && root.errors[id]) || ""
  }

  function submit() {
    var errs = ExtForm.validateForm(root.values, root.form)
    var out = {}
    for (var k in errs) out[k] = errs[k]
    root.errors = out
    if (Object.keys(errs).length === 0) root.submitted(ExtForm.unwrappedValues(root.values, root.form))
  }

  spacing: 10
  Repeater {
    id: repeater
    model: root.form.items || []
    delegate: Loader {
      width: root.width
      property var field: modelData
      // Ternary chain: binding scripts cannot use return statements. [D]
      sourceComponent: (modelData && (modelData.kind === "TextField" || modelData.kind === "PasswordField")) ? textFieldComp
        : (modelData && modelData.kind === "TextArea") ? textAreaComp
        : (modelData && modelData.kind === "Checkbox") ? checkboxComp
        : (modelData && modelData.kind === "DatePicker") ? datePickerComp
        : (modelData && modelData.kind === "Dropdown") ? dropdownComp
        : (modelData && modelData.kind === "TagPicker") ? tagPickerComp
        : (modelData && modelData.kind === "FilePicker") ? filePickerComp
        : (modelData && modelData.kind === "Separator") ? separatorComp
        : descriptionComp
      onLoaded: {
        if (item) {
          item.field = field
          var next = root.inputs.slice()
          if (item.focusTarget) next.push(item.focusTarget)
          root.inputs = next
        }
      }
    }
  }

  Component {
    id: textFieldComp
    Column {
      property var field
      property var focusTarget: input
      spacing: 2
      Text { text: (field && field.title) || ""; textFormat: Text.PlainText }
      TextField {
        id: input
        objectName: "addFormField"
        width: parent.width
        placeholderText: (field && field.placeholder) || ""
        echoMode: (field && field.isSecure) ? TextInput.Password : TextInput.Normal
        text: (field && root.values[field.id] !== undefined) ? String(root.values[field.id]) : ""
        onTextChanged: if (field && text !== String(root.values[field.id] || "")) { root.setField(field.id, text); root.fieldChanged(field.id, text) }
        onAccepted: root.submit()
      }
      Text { visible: !!root.fieldError(field ? field.id : ""); text: root.fieldError(field ? field.id : ""); textFormat: Text.PlainText }
    }
  }
  Component {
    id: textAreaComp
    Column {
      property var field
      property var focusTarget: input
      spacing: 2
      Text { text: (field && field.title) || ""; textFormat: Text.PlainText }
      TextArea {
        id: input
        objectName: "addFormField"
        width: parent.width
        placeholderText: (field && field.placeholder) || ""
        text: (field && root.values[field.id] !== undefined) ? String(root.values[field.id]) : ""
        onTextChanged: if (field && text !== String(root.values[field.id] || "")) { root.setField(field.id, text); root.fieldChanged(field.id, text) }
      }
    }
  }
  Component {
    id: checkboxComp
    CheckBox {
      property var field
      property var focusTarget: box
      id: box
      objectName: "addFormField"
      text: (field && (field.checkboxTitle || field.title)) || ""
      checked: !!(field && root.values[field.id])
      onToggled: if (field) { root.setField(field.id, checked); root.fieldChanged(field.id, checked) }
    }
  }
  Component {
    id: datePickerComp
    Column {
      property var field
      property var focusTarget: input
      spacing: 2
      Text { text: (field && field.title) || ""; textFormat: Text.PlainText }
      TextField {
        id: input
        objectName: "addFormField"
        width: parent.width
        // Plain text, not a mask: stored and displayed text stay
        // identical, and the core flags bad shapes on submit. [D]
        placeholderText: "YYYY-MM-DD"
        text: (field && root.values[field.id] != null) ? String(root.values[field.id]) : ""
        onTextChanged: if (field && text !== String(root.values[field.id] || "")) { root.setField(field.id, text); root.fieldChanged(field.id, text) }
        onAccepted: root.submit()
      }
      Text { visible: !!root.fieldError(field ? field.id : ""); text: root.fieldError(field ? field.id : ""); textFormat: Text.PlainText }
    }
  }
  Component {
    id: dropdownComp
    Column {
      property var field
      property var focusTarget: combo
      spacing: 2
      Text { text: (field && field.title) || ""; textFormat: Text.PlainText }
      ComboBox {
        id: combo
        objectName: "addFormField"
        width: parent.width
        function titles() {
          var out = []
          var secs = (field && field.sections) || []
          for (var i = 0; i < secs.length; i++) for (var j = 0; j < secs[i].items.length; j++) out.push(secs[i].items[j].title)
          return out
        }
        function optionValues() {
          var vals = []
          var secs = (field && field.sections) || []
          for (var i = 0; i < secs.length; i++) for (var j = 0; j < secs[i].items.length; j++) vals.push(String(secs[i].items[j].value))
          return vals
        }
        model: titles()
        Component.onCompleted: {
          if (!field) return
          var at = optionValues().indexOf(String(root.values[field.id]))
          if (at >= 0) currentIndex = at
        }
        onActivated: {
          if (!field) return
          var vals = optionValues()
          if (index >= 0 && index < vals.length) { root.setField(field.id, vals[index]); root.fieldChanged(field.id, vals[index]) }
        }
      }
    }
  }
  Component {
    id: tagPickerComp
    Column {
      property var field
      property var focusTarget: input
      spacing: 2
      Text { text: (field && field.title) || ""; textFormat: Text.PlainText }
      TextField {
        id: input
        objectName: "addFormField"
        width: parent.width
        placeholderText: (field && field.placeholder) || "Comma-separated values"
        text: (field && Array.isArray(root.values[field.id])) ? root.values[field.id].join(", ") : ""
        onTextChanged: {
          if (!field) return
          var arr = text.split(",").map(function (s) { return s.trim() }).filter(function (s) { return s !== "" })
          // Content compare: typing "a, " parses back to ["a"], and
          // rewriting the field would eat the separator mid-typing. [D]
          var cur = Array.isArray(root.values[field.id]) ? root.values[field.id] : []
          if (String(arr) !== String(cur)) { root.setField(field.id, arr); root.fieldChanged(field.id, arr) }
        }
        onAccepted: root.submit()
      }
    }
  }
  Component {
    id: filePickerComp
    Column {
      property var field
      property var focusTarget: input
      spacing: 2
      Text { text: (field && field.title) || ""; textFormat: Text.PlainText }
      TextField {
        id: input
        objectName: "addFormField"
        width: parent.width
        placeholderText: "/path/to/file"
        text: (field && Array.isArray(root.values[field.id])) ? root.values[field.id].join(", ") : ""
        onTextChanged: {
          if (!field) return
          var arr = text.split(",").map(function (s) { return s.trim() }).filter(function (s) { return s !== "" })
          root.setField(field.id, arr)
          root.fieldChanged(field.id, arr)
        }
        onAccepted: root.submit()
      }
    }
  }
  Component { id: separatorComp; Rectangle { property var field; property var focusTarget: null; height: 1; width: parent.width; opacity: 0.3 } }
  Component {
    id: descriptionComp
    Column {
      property var field
      property var focusTarget: null
      Text { text: (field && field.title) || ""; textFormat: Text.PlainText; font.bold: true }
      Text { text: (field && field.text) || ""; textFormat: Text.PlainText; wrapMode: Text.Wrap }
    }
  }
}
