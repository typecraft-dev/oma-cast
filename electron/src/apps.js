// Windows application library: Start Menu and Desktop shortcuts stand in
// for Omarchy's shell.appLibrary, plus Store/MSIX apps (they ship no .lnk
// anywhere — Notion from the Store was invisible until they were added).
// One PowerShell pass enumerates .lnk files (user + machine Start Menu,
// user + public Desktop) and shell:AppsFolder rows, then icons are
// extracted lazily and launches go through the shell. Async like
// DesktopEntries: `refresh()` repopulates and emits. [D]
var fs = require("fs")
var path = require("path")
var crypto = require("crypto")
var childProcess = require("child_process")

var SCAN_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  // Node decodes stdout as UTF-8; app names come back in the OEM codepage
  // otherwise. Best effort.
  "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}",
  "$shell = New-Object -ComObject WScript.Shell",
  // .lnk rows: user Start Menu, machine Start Menu, then both Desktops —
  // installers scatter shortcuts across all four. The Start Menu roots
  // (not just Programs) are walked so stray top-level links count too. [D]
  "$dirs = @()",
  "if ($env:APPDATA) { $dirs += (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu') }",
  "if ($env:ProgramData) { $dirs += (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu') }",
  "try { $d = [Environment]::GetFolderPath('Desktop'); if ($d) { $dirs += $d } } catch {}",
  "if ($env:PUBLIC) { $d = Join-Path $env:PUBLIC 'Desktop'; if (Test-Path -LiteralPath $d) { $dirs += $d } }",
  "$out = @()",
  "foreach ($d in $dirs) {",
  "  if (-not (Test-Path -LiteralPath $d)) { continue }",
  "  Get-ChildItem -LiteralPath $d -Recurse -Filter '*.lnk' -File | ForEach-Object {",
  "    try { $s = $shell.CreateShortcut($_.FullName) } catch { return }",
  "    $out += [PSCustomObject]@{ name = $_.BaseName; link = $_.FullName; target = $s.TargetPath }",
  "  }",
  "}",
  // Store / MSIX apps (AppID \"Package!App\") have no .lnk in any of those
  // folders: enumerate shell:AppsFolder so they show up too. Get-StartApps
  // when Windows ships it, the shell namespace as the in-box fallback. [D]
  "$store = @()",
  "try {",
  "  if (Get-Command Get-StartApps -ErrorAction SilentlyContinue) {",
  "    $store = @(Get-StartApps | Where-Object { $_.AppID -like '*!*' } | ForEach-Object { [PSCustomObject]@{ name = $_.Name; appid = $_.AppID } })",
  "  }",
  "} catch {}",
  "if (-not $store -or $store.Count -eq 0) {",
  "  try {",
  "    $ns = (New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder')",
  "    if ($ns) { $store = @($ns.Items() | ForEach-Object { try { if ($_.Path -like '*!*') { [PSCustomObject]@{ name = $_.Name; appid = $_.Path } } } catch {} }) }",
  "  } catch {}",
  "}",
  "foreach ($a in $store) { if ($a -and $a.name -and $a.appid) { $out += [PSCustomObject]@{ name = $a.name; link = ''; target = ''; appid = $a.appid } } }",
  // Registered exes with no shortcut anywhere (portable tools, dev-tool
  // binaries, browsers): the App Paths keys map an exe name to its full
  // path. Registry reads only — no COM — so these survive locked-down
  // PowerShells where WScript.Shell fails. Listed last so a real shortcut
  // for the same name wins the dedup. [D]
  "foreach ($hive in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths')) {",
  "  if (-not (Test-Path -LiteralPath $hive)) { continue }",
  "  Get-ChildItem -LiteralPath $hive | ForEach-Object {",
  "    try {",
  "      $p = (Get-ItemProperty -LiteralPath $_.PSPath).'(default)'",
  "      if ($p) { $p = ([string]$p).Trim().Trim([char]34).Trim() }",
  "      if ($p -and (Test-Path -LiteralPath $p -PathType Leaf)) {",
  "        $out += [PSCustomObject]@{ name = ($_.PSChildName -replace '\\.exe$', ''); link = $p; target = $p; apppaths = 1 }",
  "      }",
  "    } catch {}",
  "  }",
  "}",
  "$out | ConvertTo-Json -Compress"
].join("\n")

// PowerShell single-quoted string literal.
function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

// Users search system apps by alias — "files" for File Explorer (its title
// holds no "s"), "screenshot" for the Snipping Tool, "notes" for Notepad —
// and the strict root ranker (the exact Raycast port) won't bridge that gap.
// The aliases live here as keywords, so the app still ranks when the name
// alone doesn't match. Add rows sparingly: title substrings and prefixes
// already match without help. [D]
var APP_KEYWORDS = {
  "file explorer": ["files", "file manager", "this pc"],
  "snipping tool": ["screenshot", "screenshots", "snip"],
  "notepad": ["notes", "text editor"],
  "task manager": ["taskmgr"],
  "remote desktop connection": ["remote desktop", "rdp", "mstsc"],
  "command prompt": ["cmd", "command line"],
  "windows powershell": ["powershell"]
}

function keywordsFor(name) {
  var hit = APP_KEYWORDS[String(name || "").toLowerCase()]
  return hit ? hit.slice() : []
}

// Icon extraction: 32px associated icon → PNG in the icon cache.
// The two paths are interpolated (PowerShell-quoted) rather than passed as
// arguments after -Command: powershell.exe joins everything following
// -Command into one command string, so trailing arguments were appended to
// the last statement, the script failed, and every app row rendered with
// no icon at all. Start Menu .lnk links resolve to their target first —
// ExtractAssociatedIcon on the link itself often yields nothing. [D]
var ICON_SCRIPT = [
  "$src = {{src}}",
  "$out = {{out}}",
  "Add-Type -AssemblyName System.Drawing",
  "if (-not (Test-Path -LiteralPath $src)) { exit 1 }",
  "$file = $src",
  "if ([System.IO.Path]::GetExtension($src) -eq '.lnk') {",
  "  try { $t = (New-Object -ComObject WScript.Shell).CreateShortcut($src).TargetPath; if ($t) { $file = $t } } catch {}",
  "}",
  "$icon = $null",
  "try { $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($file) } catch {}",
  "if (-not $icon) { try { $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($src) } catch {} }",
  "if (-not $icon) { exit 1 }",
  "$bmp = $icon.ToBitmap()",
  "$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)",
  "$bmp.Dispose(); $icon.Dispose()"
].join("\n")

// file:/// URL for a cache PNG (encoded, so paths with spaces work).
function fileUrl(p) {
  return "file:///" + encodeURI(String(p).replace(/\\/g, "/")).replace(/#/g, "%23")
}

// The app library's disk cache ({ v, at, entries }, slim rows): the scan
// is an async PowerShell pass that takes seconds on a cold boot, and
// without it the first shows searched commands/files/fallbacks but zero
// apps. Slim rows ({id,name,target,link}) rebuild icon/keywords on load,
// so the cache stays forward-compatible. [D]
var APPS_CACHE_VERSION = 1

function createApps(opts) {
  opts = opts || {}
  var execFile = opts.execFile || childProcess.execFile
  var cachePath = opts.cachePath || ""
  function log(level, message, metadata) {
    if (opts.log) { try { opts.log(level, message, metadata) } catch (e) {} }
  }
  var apps = {
    entries: [],
    loading: false,
    // Latch: the first enumeration has completed (even empty, e.g. when
    // PowerShell is missing). The Files section stays hidden until this
    // flips, so files can never beat apps to the screen on a cold show.
    // Stubs in tests have no such field and read as already-scanned. [D]
    scanned: false,
    iconDir: opts.iconDir || "",
    _listeners: { changed: [] },
    _icons: {}
  }
  apps.on = function(event, cb) { apps._listeners[event].push(cb) }
  function emit() { (apps._listeners.changed || []).forEach(function(cb) { cb() }) }
  // Throttle the Start Menu scan: backend.visibility() fires on every
  // show, and each scan spawns PowerShell + rebuilds while the user is
  // already typing. Re-scan at most every 30 s (or when empty); the
  // window paints from cache first. [D]
  var lastScanAt = 0
  var SCAN_THROTTLE_MS = 30000
  // Typing gate: while the user is actively typing, icon extractions
  // (a PowerShell spawn each) stay queued so they never contend with
  // the next keystroke's search+render. keys.js calls setTyping. [D]
  var typing = false
  apps.setTyping = function(active) {
    typing = !!active
    if (!typing) pumpIcons()
  }
  // Icon extractions spawn PowerShell per uncached .lnk: cap concurrency
  // so the first show (100+ app rows) doesn't fork 100 processes at once
  // and starve the renderer. Extra rows queue. [D]
  var iconQueue = []
  var iconRunning = 0
  var ICON_CONCURRENCY = 4
  apps._pendingIcons = {}
  function pumpIcons() {
    if (typing) return
    while (iconRunning < ICON_CONCURRENCY && iconQueue.length > 0) {
      var job = iconQueue.shift()
      iconRunning++
      runIconExtraction(job)
    }
  }
  function runIconExtraction(job) {
    var script = ICON_SCRIPT.replace("{{src}}", psQuote(job.linkPath)).replace("{{out}}", psQuote(job.png))
    try { fs.mkdirSync(apps.iconDir, { recursive: true }) } catch (e) {}
    childProcess.execFile("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 15000, windowsHide: true },
      function(err) {
        iconRunning--
        var url = (!err && fs.existsSync(job.png)) ? fileUrl(job.png) : ""
        apps._icons[job.linkPath] = url
        delete apps._pendingIcons[job.linkPath]
        job.resolve(url)
        pumpIcons()
      })
  }

  function buildEntry(row) {
    if (!row || !row.name) return null
    var link = String(row.link || "")
    var appid = String(row.appid || "")
    if (!link && !appid) return null
    var id = link || ("uwp:" + appid)
    return {
      id: id,
      name: String(row.name),
      icon: id,
      target: String(row.target || ""),
      link: link,
      genericName: "",
      keywords: keywordsFor(row.name),
      noDisplay: false
    }
  }
  function slimEntry(e) {
    return { id: e.id, name: e.name, target: e.target, link: e.link }
  }
  function loadCache() {
    if (!cachePath) return false
    try {
      var doc = JSON.parse(fs.readFileSync(cachePath, "utf8"))
      if (doc && doc.v === APPS_CACHE_VERSION && Array.isArray(doc.entries) && doc.entries.length > 0) {
        var rows = doc.entries.map(function(r) {
          var e = buildEntry(r)
          return e && e.id && e.name ? e : null
        }).filter(Boolean)
        if (rows.length > 0) {
          rows.sort(function(a, b) { return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) })
          apps.entries = rows
          apps.scanned = true
          return true
        }
      }
    } catch (e) {}
    return false
  }
  function saveCache() {
    if (!cachePath || apps.entries.length === 0) return
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true })
      var tmp = cachePath + ".tmp"
      fs.writeFileSync(tmp, JSON.stringify({ v: APPS_CACHE_VERSION, at: Date.now(), entries: apps.entries.map(slimEntry) }))
      fs.renameSync(tmp, cachePath)
    } catch (e) {}
  }
  // Preload synchronously: the file is ~100 KB next to the 9 MB
  // file-index cache (which stays background-loaded), so the first show
  // paints cached apps instead of an empty Applications section. [D]
  try { loadCache() } catch (e) {}

  function runPowerShell(script, timeoutMs) {
    return new Promise(function(resolve) {
      execFile("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { timeout: timeoutMs || 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        function(err, stdout) { resolve({ error: err, stdout: String(stdout || "") }) })
    })
  }

  // One enumeration pass; user-scope links win over machine-scope on name
  // collisions (Windows resolves the same way for Start Menu entries).
  apps.refresh = function(force) {
    if (apps.loading) return Promise.resolve(apps.entries)
    if (!force && apps.entries.length > 0 && Date.now() - lastScanAt < SCAN_THROTTLE_MS) return Promise.resolve(apps.entries)
    apps.loading = true
    return runPowerShell(SCAN_SCRIPT).then(function(res) {
      apps.loading = false
      // Harden the parse: PowerShell can emit a BOM (the es.exe path
      // already strips \uFEFF for this reason) or stray blank lines, and
      // either one used to throw here and silently empty the whole library
      // — a cold show then searched everything except apps. [D]
      var text = String(res.stdout || "").replace(/^\uFEFF/, "").trim()
      var parsed = []
      try { parsed = (text ? JSON.parse(text) : []) || [] } catch (e) { parsed = [] }
      if (!Array.isArray(parsed)) parsed = [parsed]
      var seen = {}
      var seenTargets = {}
      var out = []
      // Script order: user Start Menu, machine Start Menu, Desktops, then
      // the Store rows, then App Paths — keep the first of each name (a
      // .lnk beats a Store row: it has a real icon) and drop nameless
      // rows. App Paths rows are a safety net, so one whose exe is already
      // covered by a shortcut row is skipped (WINWORD must not double
      // Word); the shortcut rows record their targets for that. [D]
      for (var i = 0; i < parsed.length; i++) {
        var row = parsed[i]
        var entry = buildEntry(row)
        if (!entry) continue
        var key = entry.name.toLowerCase()
        if (seen[key]) continue
        var normTarget = entry.target.toLowerCase().replace(/\//g, "\\")
        if (row.apppaths) {
          if (normTarget && seenTargets[normTarget]) continue
        } else if (entry.link && normTarget) {
          seenTargets[normTarget] = true
        }
        seen[key] = true
        out.push(entry)
      }
      out.sort(function(a, b) { return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) })
      // An empty scan is a failed scan, never a real library: Windows
      // always has registered exes. Keep the previous (or cached) entries
      // so one bad pass cannot wipe apps until the next show, and never
      // persist the empty result over a good cache. [D]
      if (out.length === 0 && apps.entries.length > 0) {
        log("warning", "app scan returned 0 rows, keeping " + apps.entries.length + " cached", null)
        apps.scanned = true
        return apps.entries
      }
      apps.entries = out
      lastScanAt = Date.now()
      apps.scanned = true
      saveCache()
      emit()
      return out
    }, function() { apps.loading = false; apps.scanned = true; return apps.entries })
  }

  // Lazy icon extraction, cached under iconDir. Resolves to a file:// URL
  // or "" (rows without icons just show the glyph slot empty). [D]
  apps.iconSource = function(linkPath) {
    if (!linkPath) return Promise.resolve("")
    // Store/MSIX rows point at nothing on disk: answer \"\" at once so the
    // row falls back to the generic window glyph instead of spawning a
    // doomed extraction attempt per row. [D]
    if (String(linkPath).indexOf("uwp:") === 0) return Promise.resolve("")
    if (apps._icons[linkPath] !== undefined) return Promise.resolve(apps._icons[linkPath])
    if (!apps.iconDir) return Promise.resolve("")
    var hash = crypto.createHash("sha1").update(String(linkPath)).digest("hex").slice(0, 16)
    var png = path.join(apps.iconDir, hash + ".png")
    if (fs.existsSync(png)) {
      apps._icons[linkPath] = fileUrl(png)
      return Promise.resolve(apps._icons[linkPath])
    }
    // Coalesce: one extraction per path even when every rebuild re-asks
    // while the first is still in flight (per-keystroke rebuilds did). [D]
    if (apps._pendingIcons[linkPath]) return apps._pendingIcons[linkPath]
    var pending = new Promise(function(resolve) {
      iconQueue.push({ linkPath: linkPath, png: png, resolve: resolve })
      pumpIcons()
    })
    apps._pendingIcons[linkPath] = pending
    return pending
  }

  // Launch through the shell (ShellExecute on the .lnk): UAC-aware, runs
  // the shortcut's target with its arguments and working directory.
  // What explorer.exe gets: the .lnk itself (ShellExecute, UAC-aware), or
  // a Store/MSIX app's AppsFolder path — \"shell:AppsFolder\\<AppID>\". [D]
  apps.launch = function(linkPath) {
    return new Promise(function(resolve) {
      childProcess.execFile("explorer.exe", [launchArg(linkPath)], { windowsHide: true }, function(err) {
        resolve(err ? String(err.message || err) : "")
      })
    })
  }

  return apps
}

function launchArg(id) {
  var s = String(id || "")
  return s.indexOf("uwp:") === 0 ? "shell:AppsFolder\\" + s.slice(4) : s
}

if (typeof module !== "undefined") {
  module.exports = { createApps: createApps, SCAN_SCRIPT: SCAN_SCRIPT, ICON_SCRIPT: ICON_SCRIPT, psQuote: psQuote, fileUrl: fileUrl, launchArg: launchArg, APP_KEYWORDS: APP_KEYWORDS, keywordsFor: keywordsFor, APPS_CACHE_VERSION: APPS_CACHE_VERSION }
}
