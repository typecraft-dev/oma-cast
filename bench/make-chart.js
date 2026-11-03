// Generates bench/app-search.chart.svg from app-search.old/new.json.
// node bench/make-chart.js
var fs = require("fs");
var old = JSON.parse(fs.readFileSync(__dirname + "/app-search.old.json", "utf8"));
var nw = JSON.parse(fs.readFileSync(__dirname + "/app-search.new.json", "utf8"));
var queries = Object.keys(old.repeat);
var W = 900, H = 60 + queries.length * 44, left = 150, rightW = W - left - 90;
var maxV = 0;
queries.forEach(function(q) { maxV = Math.max(maxV, old.repeat[q]); });
function x(v) { return left + Math.log10(1 + v) / Math.log10(1 + maxV) * rightW; }
var s = [];
s.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" font-family="monospace">');
s.push('<rect width="' + W + '" height="' + H + '" fill="#0d1117"/>');
s.push('<text x="' + left + '" y="30" fill="#e6edf3" font-size="17">oma-cast app search: mean ms per search (800 apps, old vs new)</text>');
s.push('<text x="' + left + '" y="50" fill="#8b949e" font-size="12">repeat = identical query (filter toggle / view re-entry) — fresh = distinct keystroke</text>');
queries.forEach(function(q, i) {
  var y = 78 + i * 44;
  var r = (old.repeat[q] / nw.repeat[q]);
  s.push('<text x="10" y="' + (y + 5) + '" fill="#e6edf3" font-size="13">' + q + ' ×' + Math.round(r) + '</text>');
  s.push('<rect x="' + left + '" y="' + y + '" width="' + (x(old.repeat[q]) - left) + '" height="15" fill="#f85149"/>');
  s.push('<rect x="' + left + '" y="' + (y + 18) + '" width="' + (x(nw.repeat[q]) - left) + '" height="15" fill="#3fb950"/>');
  s.push('<text x="' + (x(old.repeat[q]) + 6) + '" y="' + (y + 12) + '" fill="#8b949e" font-size="11">' + old.repeat[q].toFixed(1) + 'ms</text>');
  s.push('<text x="' + (x(nw.repeat[q]) + 6) + '" y="' + (y + 30) + '" fill="#8b949e" font-size="11">' + nw.repeat[q].toFixed(2) + 'ms</text>');
});
s.push('<text x="' + left + '" y="' + (H - 8) + '" fill="#f85149" font-size="12">■ old (no memo, full rank per keystroke)</text>');
s.push('<text x="' + (left + 360) + '" y="' + (H - 8) + '" fill="#3fb950" font-size="12">■ new (prefilter + memos)</text>');
s.push('</svg>');
fs.writeFileSync(__dirname + "/app-search.chart.svg", s.join("\n"));
var fr = queries.map(function(q) { return old.fresh[q] / nw.fresh[q]; });
var rr = queries.map(function(q) { return old.repeat[q] / nw.repeat[q]; });
function med(a) { var t = a.slice().sort(function(x, y) { return x - y; }); return t[Math.floor(t.length / 2)]; }
console.log("fresh median x" + med(fr).toFixed(1) + " | repeat median x" + med(rr).toFixed(1) + " max x" + Math.round(Math.max.apply(null, rr)));
