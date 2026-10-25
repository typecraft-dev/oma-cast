const test = require("node:test")
const assert = require("node:assert/strict")
const LT = require("../plugin/core/LargeType.js")

test("displayText keeps content exactly, including markup and accents", () => {
  assert.equal(LT.displayText("Hello, World!"), "Hello, World!")
  assert.equal(LT.displayText("<b>Hello</b>"), "<b>Hello</b>")
  assert.equal(LT.displayText("Reunião às 15h — até já!"), "Reunião às 15h — até já!")
  assert.equal(LT.displayText("a".repeat(4000)), "a".repeat(4000))
})

test("displayText trims outer whitespace only", () => {
  assert.equal(LT.displayText("  padded  "), "padded")
  assert.equal(LT.displayText("keep  inner   spacing"), "keep  inner   spacing")
})

test("displayText rejects blank input so the overlay never takes over empty", () => {
  assert.equal(LT.displayText(""), "")
  assert.equal(LT.displayText("   \t\n "), "")
  assert.equal(LT.displayText(null), "")
  assert.equal(LT.displayText(undefined), "")
})

test("fitRange is sane on a desktop-sized screen", () => {
  const fit = LT.fitRange(1920, 1080, 1)
  assert.ok(fit, "expected a range for 1920x1080")
  assert.ok(fit.min >= 1)
  assert.ok(fit.max > fit.min)
  assert.ok(fit.max <= LT.MAX_PIXEL_SIZE)
  assert.ok(fit.width < 1920 && fit.height < 1080, "text box leaves a margin")
  assert.ok(fit.width > 0 && fit.height > 0)
})

test("fitRange never returns NaN, negatives or an inverted range", () => {
  const boxes = [[0, 0, 1], [-10, 500, 1], [500, -10, 1], [1, 1, 1], [1920, 1080, 0], [1920, 1080, -2], [Number.NaN, 1080, 1], [10, Number.NaN, 1.5]]
  for (const [w, h, z] of boxes) {
    const fit = LT.fitRange(w, h, z)
    if (!fit) continue
    for (const v of [fit.min, fit.max, fit.width, fit.height])
      assert.ok(Number.isFinite(v) && v >= 1, `bad value ${v} for ${w}x${h} zoom ${z}`)
    assert.ok(fit.min <= fit.max, `inverted range for ${w}x${h}`)
  }
})

test("a tiny box collapses to a valid range instead of failing", () => {
  const fit = LT.fitRange(4, 4, 1)
  assert.ok(fit)
  assert.equal(fit.min, fit.max)
  assert.ok(fit.min >= 1)
  assert.ok(fit.width >= 1 && fit.height >= 1)
})

test("fitRange scales with uiZoom but stays bounded", () => {
  // Large enough that the absolute cap, not the screen edge, is binding.
  const a = LT.fitRange(4000, 3000, 1)
  const b = LT.fitRange(4000, 3000, 1.5)
  assert.ok(b.max > a.max)
  assert.ok(b.max <= Math.round(LT.MAX_PIXEL_SIZE * 1.5))
})
