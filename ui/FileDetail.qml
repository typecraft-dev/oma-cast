import QtQuick
import Quickshell.Io
import qs.Commons

// The Search Files detail pane (ref 04 App. A file-search, "list + detail
// with preview"): a preview on top, then the file's details as label and
// value rows. detail comes from the files.details backend method.
Item {
  id: pane

  property var detail: null
  property var look: null
  property real zoom: 1
  function px(v) { return Math.round(Style.space(v) * pane.zoom) }

  readonly property string preview: pane.detail ? pane.detail.preview : ""
  // A file URL with each path segment encoded, so "#" or "?" in a name
  // stays part of the path.
  readonly property string fileUrl: pane.detail
    ? "file://" + pane.detail.path.split("/").map(encodeURIComponent).join("/") : ""

  // The head of a text file. FileView reads the file once per selection;
  // core/FileSearch.js keeps files over 1 MB out of this path.
  // The text is kept with the path it came from, so a file that loads
  // before or after the selection changes never shows under another name.
  property string textHead: ""
  property string textPath: ""
  // Point the reader at the selected file. The same file again keeps the
  // text already read: a forced reload() of an unchanged file empties it,
  // and watchChanges below keeps an edited file current.
  function loadText() {
    if (!pane.detail || pane.detail.preview !== "text") return
    if (textFile.path !== pane.detail.path) textFile.path = pane.detail.path
    else if (pane.textPath !== pane.detail.path) textFile.reload()
  }
  onDetailChanged: pane.loadText()
  Component.onCompleted: pane.loadText()

  FileView {
    id: textFile
    printErrors: false
    watchChanges: true
    onFileChanged: reload()
    onLoaded: { pane.textHead = text().slice(0, 4000); pane.textPath = path }
    onLoadFailed: { pane.textHead = ""; pane.textPath = path }
  }

  Item {
    id: previewBox
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    height: Math.round(parent.height * 0.52)

    Image {
      anchors.fill: parent
      anchors.margins: pane.px(12)
      visible: pane.preview === "image"
      source: visible ? pane.fileUrl : ""
      fillMode: Image.PreserveAspectFit
      asynchronous: true
      cache: false
      sourceSize.width: width * 2
      sourceSize.height: height * 2
    }

    Rectangle {
      anchors.fill: parent
      anchors.margins: pane.px(8)
      visible: pane.preview === "text"
      radius: Math.max(Style.cornerRadius, pane.px(6))
      color: Util.alpha(pane.look.foreground, 0.04)
      clip: true

      Text {
        anchors.fill: parent
        anchors.margins: pane.px(10)
        textFormat: Text.PlainText
        text: pane.detail && pane.textPath === pane.detail.path ? pane.textHead : ""
        color: pane.look.foreground
        opacity: 0.8
        font.family: pane.look.fontFamily
        font.pixelSize: Math.round(Style.font.caption * pane.zoom)
        wrapMode: Text.NoWrap
        elide: Text.ElideRight
        maximumLineCount: 200
      }
    }

    Text {
      anchors.centerIn: parent
      visible: pane.preview === "glyph"
      textFormat: Text.PlainText
      text: pane.detail ? pane.detail.glyph : ""
      color: pane.look.foreground
      opacity: 0.35
      font.family: pane.look.fontFamily
      font.pixelSize: pane.px(64)
    }
  }

  Rectangle {
    id: divider
    anchors.top: previewBox.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    height: 1
    color: Util.alpha(pane.look.foreground, 0.12)
  }

  Column {
    anchors.top: divider.bottom
    anchors.topMargin: pane.px(10)
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.leftMargin: pane.px(12)
    anchors.rightMargin: pane.px(12)
    spacing: pane.px(7)

    Repeater {
      model: pane.detail ? [
        { label: "Name", value: pane.detail.name },
        { label: "Where", value: pane.detail.where },
        { label: "Type", value: pane.detail.type },
        { label: "Size", value: pane.detail.size },
        { label: "Modified", value: pane.detail.modified }
      ].filter(function(r) { return r.value }) : []

      delegate: Item {
        required property var modelData
        width: parent.width
        height: valueText.implicitHeight

        Text {
          id: labelText
          anchors.left: parent.left
          textFormat: Text.PlainText
          text: modelData.label
          color: pane.look.foreground
          opacity: 0.5
          font.family: pane.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * pane.zoom)
        }
        Text {
          id: valueText
          anchors.right: parent.right
          width: Math.min(implicitWidth, parent.width - labelText.implicitWidth - pane.px(16))
          horizontalAlignment: Text.AlignRight
          textFormat: Text.PlainText
          text: modelData.value
          color: pane.look.foreground
          font.family: pane.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * pane.zoom)
          elide: Text.ElideMiddle
        }
      }
    }
  }
}
