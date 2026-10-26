// Bible-reference parsing and presentation. Keep this file pure so it can be
// exercised by node and imported by QML.
var BOOKS = [
  ["Genesis","genesis","GEN",["gen","ge","gn"]], ["Exodus","exodus","EXO",["exod","exo","ex"]],
  ["Leviticus","leviticus","LEV",["lev","le","lv"]], ["Numbers","numbers","NUM",["num","nu","nm","nb"]],
  ["Deuteronomy","deuteronomy","DEU",["deut","deu","dt"]], ["Joshua","joshua","JOS",["josh","jos","jsh"]],
  ["Judges","judges","JDG",["judg","jdg","jg","jgs"]], ["Ruth","ruth","RUT",["rth","ru"]],
  ["1 Samuel","1-samuel","1SA",["1 sam","1sam","1 sa","1sa","i samuel"]], ["2 Samuel","2-samuel","2SA",["2 sam","2sam","2 sa","2sa","ii samuel"]],
  ["1 Kings","1-kings","1KI",["1 kgs","1kgs","1 ki","1ki","i kings"]], ["2 Kings","2-kings","2KI",["2 kgs","2kgs","2 ki","2ki","ii kings"]],
  ["1 Chronicles","1-chronicles","1CH",["1 chron","1chron","1 chr","1chr","1 ch","1ch"]], ["2 Chronicles","2-chronicles","2CH",["2 chron","2chron","2 chr","2chr","2 ch","2ch"]],
  ["Ezra","ezra","EZR",["ezr"]], ["Nehemiah","nehemiah","NEH",["neh","ne"]], ["Esther","esther","EST",["esth","est","es"]],
  ["Job","job","JOB",[]], ["Psalms","psalms","PSA",["psalm","ps","psa","pss"]], ["Proverbs","proverbs","PRO",["prov","pro","prv","pr"]],
  ["Ecclesiastes","ecclesiastes","ECC",["eccles","eccl","ecc","ec"]], ["Song of Solomon","song-of-solomon","SNG",["song of songs","song","songs","sos","canticles"]],
  ["Isaiah","isaiah","ISA",["isa","is"]], ["Jeremiah","jeremiah","JER",["jer","je","jr"]], ["Lamentations","lamentations","LAM",["lam","la"]],
  ["Ezekiel","ezekiel","EZK",["ezek","eze","ezk"]], ["Daniel","daniel","DAN",["dan","da","dn"]], ["Hosea","hosea","HOS",["hos","ho"]],
  ["Joel","joel","JOL",["joe","jl"]], ["Amos","amos","AMO",["amo","am"]], ["Obadiah","obadiah","OBA",["obad","oba","ob"]],
  ["Jonah","jonah","JON",["jon","jnh"]], ["Micah","micah","MIC",["mic","mi"]], ["Nahum","nahum","NAM",["nah","na"]],
  ["Habakkuk","habakkuk","HAB",["hab","hb"]], ["Zephaniah","zephaniah","ZEP",["zeph","zep","zp"]], ["Haggai","haggai","HAG",["hag","hg"]],
  ["Zechariah","zechariah","ZEC",["zech","zec","zc"]], ["Malachi","malachi","MAL",["mal","ml"]], ["Matthew","matthew","MAT",["matt","mat","mt"]],
  ["Mark","mark","MRK",["mrk","mk","mr"]], ["Luke","luke","LUK",["luk","lk"]], ["John","john","JHN",["joh","jhn","jn"]],
  ["Acts","acts","ACT",["act","ac"]], ["Romans","romans","ROM",["rom","ro","rm"]],
  ["1 Corinthians","1-corinthians","1CO",["1 cor","1cor","1 co","1co","i corinthians"]], ["2 Corinthians","2-corinthians","2CO",["2 cor","2cor","2 co","2co","ii corinthians"]],
  ["Galatians","galatians","GAL",["gal","ga"]], ["Ephesians","ephesians","EPH",["eph","ep"]], ["Philippians","philippians","PHP",["phil","php","pp"]],
  ["Colossians","colossians","COL",["col","co"]], ["1 Thessalonians","1-thessalonians","1TH",["1 thess","1thess","1 thes","1thes","1 th","1th"]],
  ["2 Thessalonians","2-thessalonians","2TH",["2 thess","2thess","2 thes","2thes","2 th","2th"]], ["1 Timothy","1-timothy","1TI",["1 tim","1tim","1 ti","1ti"]],
  ["2 Timothy","2-timothy","2TI",["2 tim","2tim","2 ti","2ti"]], ["Titus","titus","TIT",["tit","ti"]], ["Philemon","philemon","PHM",["philem","phm","pm"]],
  ["Hebrews","hebrews","HEB",["heb"]], ["James","james","JAS",["jas","jm"]], ["1 Peter","1-peter","1PE",["1 pet","1pet","1 pe","1pe","1 pt","1pt"]],
  ["2 Peter","2-peter","2PE",["2 pet","2pet","2 pe","2pe","2 pt","2pt"]], ["1 John","1-john","1JN",["1 joh","1joh","1 jn","1jn"]],
  ["2 John","2-john","2JN",["2 joh","2joh","2 jn","2jn"]], ["3 John","3-john","3JN",["3 joh","3joh","3 jn","3jn"]],
  ["Jude","jude","JUD",["jud"]], ["Revelation","revelation","REV",["revelations","rev","re","apocalypse"]]
]
function normalized(value) { return String(value || "").toLowerCase().replace(/[.]/g, "").replace(/\s+/g, " ").trim() }
var BOOK_BY_NAME = {}
for (var i = 0; i < BOOKS.length; i++) {
  var names = [BOOKS[i][0]].concat(BOOKS[i][3])
  for (var j = 0; j < names.length; j++) BOOK_BY_NAME[normalized(names[j])] = BOOKS[i]
}
// eBible's study reader uses its own compact book identifiers.
var STUDY_CODES = {
  GEN:"GN", EXO:"EX", LEV:"LV", NUM:"NU", DEU:"DT", JOS:"JS", JDG:"JG", RUT:"RT",
  "1SA":"S1", "2SA":"S2", "1KI":"K1", "2KI":"K2", "1CH":"R1", "2CH":"R2",
  EZR:"ER", NEH:"NH", EST:"ET", JOB:"JB", PSA:"PS", PRO:"PR", ECC:"EC", SNG:"SS",
  ISA:"IS", JER:"JR", LAM:"LM", EZK:"EK", DAN:"DN", HOS:"HS", JOL:"JL", AMO:"AM",
  OBA:"OB", JON:"JH", MIC:"MC", NAM:"NM", HAB:"HK", ZEP:"ZP", HAG:"HG", ZEC:"ZC",
  MAL:"ML", MAT:"MT", MRK:"MK", LUK:"LK", JHN:"JN", ACT:"AC", ROM:"RM", "1CO":"C1",
  "2CO":"C2", GAL:"GL", EPH:"EP", PHP:"PP", COL:"CL", "1TH":"H1", "2TH":"H2",
  "1TI":"T1", "2TI":"T2", TIT:"TT", PHM:"PM", HEB:"HB", JAS:"JM", "1PE":"P1",
  "2PE":"P2", "1JN":"J1", "2JN":"J2", "3JN":"J3", JUD:"JD", REV:"RV"
}
// Accept one verse or a same-chapter interval. Bare chapters are rejected so
// an ordinary search such as "mark 3" does not trigger a network request.
function parseReference(input) {
  var text = normalized(input).replace(/[–—]/g, "-")
  // The book/chapter boundary may be omitted (`John3:16`, `1Cor13:4`).
  // Requiring the book portion to end in a non-digit keeps the leading book
  // number distinct from the chapter number.
  var match = /^(.*?\D)\s*(\d{1,3})\s*:\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?$/.exec(text)
  if (!match) return null
  var book = BOOK_BY_NAME[normalized(match[1])]
  if (!book) return null
  var chapter = Number(match[2]), verse = Number(match[3]), verseEnd = match[4] ? Number(match[4]) : verse
  if (chapter < 1 || verse < 1 || verseEnd < verse || verseEnd > 200) return null
  return { book: book[0], slug: book[1], code: book[2], chapter: chapter, verse: verse, verseEnd: verseEnd,
    range: verseEnd !== verse, reference: book[0] + " " + chapter + ":" + verse + (verseEnd !== verse ? "–" + verseEnd : ""),
    key: book[1] + "/" + chapter + "/" + verse + (verseEnd !== verse ? "-" + verseEnd : "") }
}
function apiUrl(ref) { return "https://api.midvash.com/v1/web/" + ref.key }
function fallbackApiUrl(ref) { return "https://bible-api.com/" + encodeURIComponent(ref.reference.replace(/–/g, "-")) + "?translation=web" }
function sourceUrl(ref) {
  return "https://ebible.org/study/?w1=bible&t1=local%3Aeng-web&v1=" + STUDY_CODES[ref.code] + ref.chapter + "_" + ref.verse
}
function result(ref, response) {
  if (!ref || !response || !response.data || !response.data.verses || !response.data.verses.length) return null
  var first = String(response.data.verses[0] || "").trim()
  return makeResult(ref, first)
}
function fallbackResult(ref, response) {
  if (!ref || !response || !response.verses || !response.verses.length) return null
  return makeResult(ref, String(response.verses[0].text || "").replace(/\s+/g, " ").trim())
}
function makeResult(ref, first) {
  if (!first) return null
  return { reference: ref.reference, text: first + (ref.range ? " …" : ""), copy: first, range: ref.range,
    sourceUrl: sourceUrl(ref), translation: "World English Bible (WEB)", cached: false }
}
if (typeof module !== "undefined") module.exports = {
  BOOKS: BOOKS, parseReference: parseReference, apiUrl: apiUrl, fallbackApiUrl: fallbackApiUrl,
  sourceUrl: sourceUrl, result: result, fallbackResult: fallbackResult
}
