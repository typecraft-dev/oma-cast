// App-search benchmark: end-to-end backend rootSearch.search over a
// realistic 800-entry Windows app library.
//   fresh  — 14 distinct queries per round (per-keystroke typing)
//   repeat — same query 30x per round (filter toggle / view re-entry)
// Reports per-query mean ms over the rounds + overall speedup.
// Run: node bench/app-search.bench.js   (writes app-search.<new|old>.json)
var Backend = require("../electron/src/backend.js");
var appsMod = require("../electron/src/apps.js");

var NAMES = ["File Explorer","Notepad","Snipping Tool","Task Manager","Command Prompt",
"Windows Powershell","Microsoft Edge","Google Chrome","Visual Studio Code","Obsidian",
"Notion","Slack","Discord","Spotify","Steam","Adobe Photoshop","Microsoft Word",
"Calculator","Paint","Settings","Control Panel","Terminal","PowerToys","Everything"];
var QUERIES = ["files","notes","screenshot","zxqv","obsidian","taskmgr","word","vpn client","photo","calc","o","e","a","er"];

function buildBackend() {
  var apps = appsMod.createApps({});
  apps.entries = [];
  for (var i = 0; i < 800; i++) {
    var b = NAMES[i % NAMES.length];
    var n = i < NAMES.length ? b : b + " " + Math.floor(i / NAMES.length);
    apps.entries.push({ id: "C:\\Apps\\app" + i + ".lnk", name: n,
      target: "C:\\Apps\\app" + i + ".exe", link: "C:\\Apps\\app" + i + ".lnk", keywords: [] });
  }
  apps.scanned = true;
  var be = Backend.createBackend({ apps: apps, processes: null, fileIndex: null,
    paths: { config: "/tmp/bench-oma", configFile: "/tmp/bench-oma/config.json",
      db: "/tmp/bench-oma", cache: "/tmp/bench-oma", data: "/tmp/bench-oma",
      logs: "/tmp/bench-oma", state: "/tmp/bench-oma" }, host: {}, log: function() {} });
  be.start();
  apps.refresh = function() { return Promise.resolve(apps.entries); };
  return be;
}

function timed(fn) { var t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; }

var be = buildBackend();
be.callSync("rootSearch.search", { query: "warmup" });

var ROUNDS = 5, fresh = {}, repeat = {};
QUERIES.forEach(function(q) { fresh[q] = []; repeat[q] = []; });
for (var r = 0; r < ROUNDS; r++) {
  QUERIES.forEach(function(q) {
    fresh[q].push(timed(function() { be.callSync("rootSearch.search", { query: q }); }));
  });
  QUERIES.forEach(function(q) {
    be.callSync("rootSearch.search", { query: q });
    repeat[q].push(timed(function() {
      for (var k = 0; k < 30; k++) be.callSync("rootSearch.search", { query: q });
    }) / 30);
  });
}
function mean(a) { return a.reduce(function(x, y) { return x + y; }, 0) / a.length; }
var out = { fresh: {}, repeat: {} };
QUERIES.forEach(function(q) { out.fresh[q] = +mean(fresh[q]).toFixed(3); out.repeat[q] = +mean(repeat[q]).toFixed(3); });
var tag = process.argv[2] === "old" ? "old" : "new";
console.log(JSON.stringify(out));
require("fs").writeFileSync(__dirname + "/app-search." + tag + ".json", JSON.stringify(out) + "\n");
