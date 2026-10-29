import QtQuick
import Quickshell
import "plugin/services"

ShellRoot {
  id: root
  property bool expectFallback: Quickshell.env("OMA_CAST_EXPECT_FALLBACK") === "1"
  property int at: 0
  property string failureMessage: ""
  property string expectedFailure: Quickshell.env("OMA_CAST_EXPECT_FAILURE") || ""
  property var queries: ["chormium", "cafe", "lcok"]
  property var expected: ["chrome", "cafe", "lock"]

  function next() {
    if (root.at === root.queries.length) {
      console.log("NATIVE-SEARCH-PASS")
      Qt.quit()
      return
    }
    search.search(root.queries[root.at], "medium", function(hits) {
      var okay = root.expectFallback ? hits === null && !!root.failureMessage : hits && hits[root.expected[root.at]]
      if (root.expectedFailure && root.failureMessage.indexOf(root.expectedFailure) < 0) okay = false
      if (!okay) { console.error("NATIVE-SEARCH-FAIL", root.queries[root.at]); Qt.exit(1); return }
      root.at++
      Qt.callLater(root.next)
    })
  }

  NativeSearch {
    id: search
    onFailed: function(message) { root.failureMessage = message; console.log("NATIVE-SEARCH-FAILURE", message) }
    ids: ["chrome", "cafe", "lock"]
    entries: [{title: "Chromium"}, {title: "Cafe"}, {title: "Lock"}]
  }

  Component.onCompleted: {
    var override = Quickshell.env("OMA_CAST_TEST_HELPER")
    if (override) search.executable = override
    Qt.callLater(root.next)
  }
}
