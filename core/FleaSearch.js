var MAX_QUERY_LENGTH = 256
var MAX_REPLY_LENGTH = 8 * 1024 * 1024

function entries(candidates, fold) {
  function strings(values) {
    return Array.isArray(values) ? values.map(function(value) { return fold(String(value || "")) }) : []
  }
  return candidates.map(function(c) {
    return {
      title: fold(String(c.title || "")), subtitle: fold(String(c.subtitle || "")),
      alternateTitles: strings(c.alternateTitles), keywords: strings(c.keywords), bundleId: fold(String(c.bundleId || ""))
    }
  })
}

// Replies look like {id: 7, hits: [{index: 0, title: 4000000, alternate: null, subtitle: null, keyword: null}]}.
function reply(line) {
  if (line.length > MAX_REPLY_LENGTH) throw new Error("Search reply exceeds the size limit")
  var data = JSON.parse(line)
  if (!data || !Number.isSafeInteger(data.id)) throw new Error("Search reply has no request id")
  return data
}

function hits(data, ids) {
  if (!Array.isArray(data.hits)) throw new Error("Search reply has no hits")
  var out = Object.create(null)
  for (var i = 0; i < data.hits.length; i++) {
    var hit = data.hits[i]
    if (!hit || !Number.isInteger(hit.index) || hit.index < 0 || hit.index >= ids.length)
      throw new Error("Search reply has an invalid entry index")
    var id = ids[hit.index]
    if (Object.prototype.hasOwnProperty.call(out, id)) throw new Error("Search reply repeats an entry")
    var scores = [hit.title, hit.alternate, hit.subtitle, hit.keyword]
    for (var j = 0; j < scores.length; j++) {
      var score = scores[j]
      if (score !== null && (!Number.isInteger(score) || score <= 0 || score > 5000000))
        throw new Error("Search reply has an invalid score")
    }
    if (scores.every(function(score) { return score === null })) throw new Error("Search reply contains an empty hit")
    out[id] = hit
  }
  return out
}

if (typeof module !== "undefined") module.exports = { MAX_QUERY_LENGTH, entries, reply, hits }
