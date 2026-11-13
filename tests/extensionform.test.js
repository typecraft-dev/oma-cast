var t = require("node:test")
var assert = require("node:assert/strict")
var F = require("../plugin/core/ExtensionForm.js")

t.test("every field kind normalizes", function () {
  var form = F.normalizeForm({ items: [
    { kind: "TextField", id: "a", placeholder: "Name" },
    { kind: "PasswordField", id: "b" },
    { kind: "TextArea", id: "c" },
    { kind: "Checkbox", id: "d", checkboxTitle: "OK" },
    { kind: "DatePicker", id: "e", type: "date_time" },
    { kind: "Dropdown", id: "f", menu: { sections: [{ id: "s", items: [{ id: "x", title: "X" }] }] } },
    { kind: "TagPicker", id: "g", suggestionValues: [{ title: "T", value: "t" }] },
    { kind: "FilePicker", id: "h", allowMultipleSelection: true },
    { kind: "Separator", id: "sep" },
    { kind: "Description", id: "desc", text: "hi" }
  ] })
  assert.equal(form.items.length, 10)
  assert.equal(form.items[1].kind, "PasswordField")
  assert.equal(form.items[1].isSecure, true)
  assert.equal(form.items[4].type, "date_time")
  assert.equal(form.items[5].value, "x")
})

t.test("submit unwraps text vs date vs default", function () {
  var form = F.normalizeForm({ items: [
    { kind: "TextField", id: "a" }, { kind: "DatePicker", id: "e" }, { kind: "Checkbox", id: "d" }
  ] })
  var p = F.submitPayload({ a: "hi", e: "2026-01-01", d: true }, form)
  assert.equal(p.a.type, "textField")
  assert.equal(p.e.type, "date")
  assert.equal(p.d.type, "default")
  assert.deepEqual(F.unwrappedValues({ a: "hi", e: "2026-01-01", d: true }, form), { a: "hi", e: "2026-01-01", d: true })
})

t.test("validation catches required/invalid/min-max", function () {
  var form = F.normalizeForm({ items: [
    { kind: "TextField", id: "a", required: true },
    { kind: "Dropdown", id: "f", menu: { sections: [{ id: "s", items: [{ id: "x", title: "X", value: "x" }] }] } },
    { kind: "DatePicker", id: "e", min: "2026-01-02", max: "2026-01-03" }
  ] })
  var errs = F.validateForm({ a: "", f: "nope", e: "2026-01-01" }, form)
  assert.equal(errs.a, "Required")
  assert.equal(errs.f, "Invalid option")
  assert.equal(errs.e, "Too early")
  assert.deepEqual(F.validateForm({ a: "ok", f: "x", e: "2026-01-02" }, form), {})
})

t.test("controlled values and applyChange", function () {
  assert.equal(F.controlledValue({ value: "v", eventCount: 3 }, "d"), "v")
  var form = F.normalizeForm({ items: [{ kind: "Checkbox", id: "d" }] })
  var r = F.applyChange({ d: false }, form.items[0], true)
  assert.equal(r.values.d, true)
})
