import QtQuick
import Quickshell
import Quickshell.Io
import "../core/Bookmarks.js" as Bookmarks

Item {
  id: source

  property var candidates: []
  property var candidatesById: ({})
  property int revision: 0
  property string bookmarksPath: ""
  property string configDir: (Quickshell.env("XDG_CONFIG_HOME") || (Quickshell.env("HOME") + "/.config"))
  readonly property string effectivePath: bookmarksPath ? bookmarksPath : activePath
  property string activePath: ""
  property string activeBrowser: ""

  Component.onCompleted: {
    if (!bookmarksPath) scanner.running = true
  }

  Process {
    id: scanner
    command: ["bash", "-c",
      'cfg="' + source.configDir + '"; ' +
      'for p in ' +
      '"$cfg/BraveSoftware/Brave-Browser/Default/Bookmarks:Brave" ' +
      '"$cfg/google-chrome/Default/Bookmarks:Chrome" ' +
      '"$cfg/chromium/Default/Bookmarks:Chromium" ' +
      '"$cfg/vivaldi/Default/Bookmarks:Vivaldi" ' +
      '"$cfg/microsoft-edge/Default/Bookmarks:Edge"; do ' +
      '  f="${p%%:*}"; b="${p##*:}"; ' +
      '  if [[ -f "$f" ]]; then printf "%s:%s\\n" "$f" "$b"; break; fi; ' +
      'done; :'
    ]
    stdout: StdioCollector {
      onStreamFinished: {
        var line = text.trim()
        if (line) {
          var idx = line.lastIndexOf(":")
          if (idx > 0) {
            source.activePath = line.slice(0, idx)
            source.activeBrowser = line.slice(idx + 1)
          }
        }
      }
    }
  }

  FileView {
    id: fileView
    path: source.effectivePath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try {
        var raw = text()
        var list = Bookmarks.candidates(raw, source.activeBrowser)
        var map = ({})
        for (var i = 0; i < list.length; i++) {
          map[list[i].id] = list[i]
        }
        source.candidates = list
        source.candidatesById = map
        source.revision++
      } catch (e) {
        // Ignored unreadable bookmarks
      }
    }
    onLoadFailed: function(error) {
      source.candidates = []
      source.candidatesById = ({})
    }
  }
}
