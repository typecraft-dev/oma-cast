// Cold-show benchmark: what happens on first show / app start.
//   cold-start — require + createBackend + start (stores, frecency load)
//   first-search — first rootSearch.search after start (decorated list build)
//   visibility — visibility(true) refresh hook
// Run: node bench/show-startup.bench.js
var path = require("path");

function freshBackend() {
  Object.keys(require.cache).forEach(function(k) {
    if (k.indexOf("electron/src") !== -1) delete require.cache[k];
  });
  var Backend = require("../electron/src/backend.js");
  var appsMod = require("../electron/src/apps.js");
  var NAMES = ["File Explorer","Notepad","Snipping Tool","Task Manager","Command Prompt",
  "Windows Powershell","Microsoft Edge","Google Chrome","Visual Studio Code","Obsidian",
  "Notion","Slack","Discord","Spotify","Steam","Adobe Photoshop","Microsoft Word",
  "Calculator","Paint","Settings","Control Panel","Terminal","PowerToys","Everything"];
  var apps = appsMod.createApps({});
  apps.entries = [];
  for (var i = 0; i < 800; i++) {
    var b = NAMES[i % NAMES.length];
    apps.entries.push({ id: "C:\\Apps\\app" + i + ".lnk",
      name: i < NAMES.length ? b : b + " " + Math.floor(i / NAMES.length),
      target: "C:\\Apps\\app" + i + ".exe", link: "C:\\Apps\\app" + i + ".lnk", keywords: [] });
  }
  apps.scanned = true;
  apps.refresh = function() { return Promise.resolve(apps.entries); };
  var dir = "/tmp/bench-show-" + process.pid;
  require("fs").mkdirSync(dir, { recursive: true });
  // Rates off: isolates CPU (start/search) from the one-per-process
  // network fetch, which is deferred and measured separately. [D]
  require("fs").writeFileSync(dir + "/config.json", JSON.stringify({ currencyRates: false }));
  var be = Backend.createBackend({ apps: apps, processes: null, fileIndex: null,
    paths: { config: dir, configFile: dir + "/config.json", db: dir, cache: dir,
      data: dir, logs: dir, state: dir }, host: {}, log: function() {} });
  return be;
}

function timed(fn) {
  var t0 = process.hrtime.bigint();
  var c0 = process.cpuUsage();
  fn();
  var c1 = process.cpuUsage(c0);
  return { wall: Number(process.hrtime.bigint() - t0) / 1e6, cpu: (c1.user + c1.system) / 1000 };
}
function stats(a, field) {
  var w = a.map(function(x) { return x[field]; }).sort(function(x, y) { return x - y; });
  return { p50: w[Math.floor(w.length / 2)], max: w[w.length - 1] };
}

var ROUNDS = 16, WARMUP = 4, cold = [], first = [], vis = [];
async function main() {
for (var r = 0; r < ROUNDS; r++) {
  var be;
  var c = timed(function() { be = freshBackend(); be.start(); });
  await new Promise(function(res) { setImmediate(res); }); // let post-start warmup run
  var f = timed(function() { be.callSync("rootSearch.search", { query: "o" }); });
  var v = timed(function() { be.visibility(true); });
  if (r >= WARMUP) { cold.push(c); first.push(f); vis.push(v); }
}
console.log(JSON.stringify({
  coldStartMs: stats(cold, "cpu"), coldStartWallMs: stats(cold, "wall"),
  firstSearchMs: stats(first, "cpu"), firstSearchWallMs: stats(first, "wall"),
  visibilityMs: stats(vis, "cpu")
}, null, 1));
}
main();
