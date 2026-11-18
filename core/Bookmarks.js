// Browser Bookmarks provider for omacast (Chromium-family: Brave, Chrome, Chromium, Vivaldi, Edge)

function cleanUrl(url) {
  return String(url || "")
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "")
}

function extractDomain(url) {
  try {
    var match = String(url || "").match(/^https?:\/\/(?:www\.)?([^\/:]+)/i)
    if (match && match[1]) {
      var host = match[1].toLowerCase()
      var parts = host.split(".")
      if (parts.length >= 2) {
        var sld = parts[parts.length - 2]
        if (parts.length >= 3 && ["co", "com", "gov", "edu", "org", "net"].indexOf(sld) >= 0) {
          return parts[parts.length - 3]
        }
        return sld
      }
      return host
    }
  } catch (e) {}
  return ""
}

function parseBookmarks(jsonText, browserName) {
  if (!jsonText || typeof jsonText !== "string") return []
  var data
  try {
    data = JSON.parse(jsonText)
  } catch (e) {
    return []
  }
  var list = []
  function walk(node, folderPath) {
    if (!node) return
    var currentFolder = folderPath
    if (node.type === "folder" && node.name) {
      currentFolder = folderPath ? folderPath + " › " + node.name : node.name
    }
    if (node.type === "url" && node.url && node.name) {
      list.push({
        title: node.name,
        url: node.url,
        folder: currentFolder || "",
        browser: browserName || "Browser"
      })
    }
    if (node.children && Array.isArray(node.children)) {
      for (var i = 0; i < node.children.length; i++) {
        walk(node.children[i], currentFolder)
      }
    }
  }
  if (data.roots) {
    for (var key in data.roots) {
      walk(data.roots[key], "")
    }
  }
  return list
}

function candidate(item) {
  var title = String(item.title || item.url || "Untitled Bookmark").trim()
  var url = String(item.url || "").trim()
  var clean = cleanUrl(url)
  var domain = extractDomain(url)
  var browser = item.browser || "Browser"
  var alternates = []
  if (domain && domain.toLowerCase() !== title.toLowerCase()) alternates.push(domain)
  if (clean && clean !== title) alternates.push(clean)

  var subtitle = clean
  if (item.folder) subtitle = item.folder + " · " + clean

  return {
    id: "bookmark:" + url,
    type: "quicklink",
    kind: "bookmark",
    title: title,
    subtitle: subtitle,
    url: url,
    alternateTitles: alternates,
    keywords: [],
    typeLabel: "Bookmark",
    glyph: "\uf02e", // nf-fa-bookmark 
    glyphFont: "",
    rootSearch: { when: "searching" }
  }
}

function candidates(jsonText, browserName) {
  var items = parseBookmarks(jsonText, browserName)
  var seen = {}
  var out = []
  for (var i = 0; i < items.length; i++) {
    var item = items[i]
    if (!item.url || seen[item.url]) continue
    seen[item.url] = true
    out.push(candidate(item))
  }
  return out
}

function knownPaths(configDir) {
  var base = String(configDir || "").replace(/\/$/, "")
  return [
    { browser: "Brave", path: base + "/BraveSoftware/Brave-Browser/Default/Bookmarks" },
    { browser: "Chrome", path: base + "/google-chrome/Default/Bookmarks" },
    { browser: "Chromium", path: base + "/chromium/Default/Bookmarks" },
    { browser: "Vivaldi", path: base + "/vivaldi/Default/Bookmarks" },
    { browser: "Edge", path: base + "/microsoft-edge/Default/Bookmarks" },
    { browser: "Opera", path: base + "/opera/Bookmarks" }
  ]
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    cleanUrl: cleanUrl,
    extractDomain: extractDomain,
    parseBookmarks: parseBookmarks,
    candidate: candidate,
    candidates: candidates,
    knownPaths: knownPaths
  }
}
