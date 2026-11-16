const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

// The launcher draws ui/logo.svg and the website serves site/public/icon.svg.
// The tree may hold no symlinks, so they are two files; keep them one drawing.
const root = path.join(__dirname, "..")

test("the launcher's logo is the website's icon", () => {
  const logo = fs.readFileSync(path.join(root, "ui/logo.svg"), "utf8")
  assert.equal(logo, fs.readFileSync(path.join(root, "site/public/icon.svg"), "utf8"))
})
