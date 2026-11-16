// omacast.site: the scroll-driven bits. The launcher itself is launcher.js. No framework.
(function () {
  "use strict"
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  var $ = function (sel, root) { return (root || document).querySelector(sel) }
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)) }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] }) }

  // ------------------------------------------------------------ scroll reveal

  function stagger(container) {
    $$(".reveal", container).forEach(function (el, i) { if (!el.style.getPropertyValue("--i")) el.style.setProperty("--i", i % 6) })
  }
  $$(".grid, .road ul, .keys, .shots, .steps, .stats").forEach(stagger)

  var onReveal = {}
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return
      revealNow(e.target)
    })
  }, { rootMargin: "0px 0px -12% 0px", threshold: 0.12 })
  function revealNow(el) {
    if (el.classList.contains("in")) return
    el.classList.add("in")
    io.unobserve(el)
    var hook = el.getAttribute("data-on")
    if (hook && onReveal[hook]) onReveal[hook](el)
  }
  // Hooks are defined below; with reduced motion they run once everything is set up.
  var revealable = $$(".reveal, [data-on]")
  revealable.forEach(function (el) {
    if (!reduced) { io.observe(el); return }
    setTimeout(function () { revealNow(el) })
  })
  // At the end of the page nothing more can scroll into view (a tall screen
  // can hold the last section inside the observer's margin), so show the rest.
  function revealAtEnd() {
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) revealable.forEach(revealNow)
  }

  // ------------------------------------------------------------ counters

  onReveal.count = function (el) {
    var target = Number(el.getAttribute("data-to")), prefix = el.getAttribute("data-prefix") || "", suffix = el.getAttribute("data-suffix") || ""
    if (reduced) { el.textContent = prefix + target + suffix; return }
    var start = performance.now(), dur = 1400
    ;(function tick(now) {
      var p = Math.min(1, (now - start) / dur), eased = 1 - Math.pow(1 - p, 3)
      el.textContent = prefix + Math.round(target * eased) + suffix
      if (p < 1) requestAnimationFrame(tick)
    })(start)
  }

  // ------------------------------------------------------------ calculator rows type themselves

  onReveal.calc = async function (box) {
    var rows = $$(".crow", box)
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i], q = $(".q", row), text = q.getAttribute("data-q"), cap = q.getAttribute("data-c")
      rows.forEach(function (r) { r.classList.toggle("sel", r === row) })
      if (reduced) { q.innerHTML = esc(text) + "<small>" + esc(cap) + "</small>"; row.classList.add("done"); continue }
      for (var c = 1; c <= text.length; c++) { q.textContent = text.slice(0, c); await sleep(28) }
      q.innerHTML = esc(text) + "<small>" + esc(cap) + "</small>"
      row.classList.add("done")
      await sleep(160)
    }
    rows.forEach(function (r) { r.classList.remove("sel") })
    if (rows[0]) rows[0].classList.add("sel")
  }

  // ------------------------------------------------------------ install commands type in

  onReveal.type = async function (pre) {
    var text = pre.getAttribute("data-text")
    if (reduced) { pre.textContent = text; return }
    pre.classList.add("typed")
    for (var c = 1; c <= text.length; c++) { pre.textContent = text.slice(0, c); await sleep(16) }
    await sleep(500)
    pre.classList.remove("typed")
  }

  // ------------------------------------------------------------ section connectors (typecraft.dev's dashed line)

  var connectors = $$(".connector")
  function drawConnectors() {
    var vh = window.innerHeight
    connectors.forEach(function (c) {
      var r = $(".track", c).getBoundingClientRect()
      // 0 when the track's top reaches 85% of the viewport, 1 when its bottom reaches 55%.
      var p = Math.max(0, Math.min(1, (vh * 0.85 - r.top) / (r.height + vh * 0.3)))
      c.style.setProperty("--p", p.toFixed(3))
      c.classList.toggle("lit", p >= 1)
    })
  }
  if (reduced) connectors.forEach(function (c) { c.style.setProperty("--p", 1); c.classList.add("lit") })
  else {
    var ticking = false
    var onScroll = function () {
      if (ticking) return
      ticking = true
      requestAnimationFrame(function () { drawConnectors(); revealAtEnd(); ticking = false })
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onScroll)
    onScroll()
  }

  // ------------------------------------------------------------ keycaps press themselves now and then

  var keyGrid = $(".keys")
  if (keyGrid && !reduced) {
    var caps = $$("kbd", keyGrid), seen = false
    new IntersectionObserver(function (es) { seen = es[0].isIntersecting }).observe(keyGrid)
    setInterval(function () {
      if (!seen || document.hidden) return
      var row = caps[Math.floor(Math.random() * caps.length)].parentNode
      var group = $$("kbd", row)
      group.forEach(function (k, i) { setTimeout(function () { k.classList.add("pressed") }, i * 70) })
      setTimeout(function () { group.forEach(function (k) { k.classList.remove("pressed") }) }, 420 + group.length * 70)
    }, 900)
  }

  // ------------------------------------------------------------ copy buttons

  $$(".copy").forEach(function (button) {
    button.addEventListener("click", function () {
      var pre = button.parentElement.querySelector("pre")
      var text = pre.getAttribute("data-text") || pre.innerText
      navigator.clipboard.writeText(text).then(function () {
        button.textContent = "Copied ✓"; button.classList.add("done")
        setTimeout(function () { button.textContent = "Copy"; button.classList.remove("done") }, 1500)
      }).catch(function () {})
    })
  })
})()
