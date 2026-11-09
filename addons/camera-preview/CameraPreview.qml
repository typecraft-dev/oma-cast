import QtQuick
import QtQuick.Controls
import Quickshell
import QtMultimedia
import qs.Commons as Commons

Item {
  id: root
  property var shell: null
  property var manifest: null
  property bool opened: false

  function open(payload) {
    root.opened = true
    preview.visible = true
  }

  function close() {
    root.opened = false
    preview.visible = false
  }

  function dismiss() {
    root.close()
    if (root.shell) root.shell.hide(root.manifest.id)
  }

  Commons.Translations { id: strings; directory: Qt.resolvedUrl("i18n") }
  MediaDevices { id: devices }
  readonly property var camera: cameraLoader.item
  Loader {
    id: cameraLoader
    active: root.opened && devices.videoInputs.length > 0
    sourceComponent: Component {
      Camera {
        cameraDevice: devices.defaultVideoInput
        active: true
      }
    }
  }
  CaptureSession {
    camera: root.camera
    videoOutput: video
  }

  FloatingWindow {
    id: preview
    property bool wasVisible: false
    visible: false
    implicitWidth: 960
    implicitHeight: 600
    title: strings.t("title", "Camera preview")
    color: Commons.Color.background
    onVisibleChanged: {
      if (visible) wasVisible = true
      else if (wasVisible && root.opened) root.dismiss()
    }

    Item {
      anchors.fill: parent
      focus: true
      Keys.onEscapePressed: root.dismiss()

      ComboBox {
        id: selector
        anchors.top: parent.top
        anchors.horizontalCenter: parent.horizontalCenter
        visible: devices.videoInputs.length > 1
        model: devices.videoInputs
        textRole: "description"
        contentItem: Text {
          text: selector.displayText
          textFormat: Text.PlainText
          color: Commons.Color.foreground
          verticalAlignment: Text.AlignVCenter
        }
        delegate: ItemDelegate {
          required property var modelData
          width: selector.width
          contentItem: Text {
            text: modelData.description
            textFormat: Text.PlainText
            color: Commons.Color.foreground
          }
        }
        onActivated: { if (root.camera) root.camera.cameraDevice = devices.videoInputs[currentIndex] }
      }

      VideoOutput {
        id: video
        anchors.top: selector.visible ? selector.bottom : parent.top
        anchors.bottom: parent.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        fillMode: VideoOutput.PreserveAspectFit
        mirrored: true
      }

      Text {
        anchors.centerIn: parent
        width: parent.width - 48
        horizontalAlignment: Text.AlignHCenter
        wrapMode: Text.Wrap
        color: Commons.Color.foreground
        textFormat: Text.PlainText
        visible: devices.videoInputs.length === 0 || (root.camera && root.camera.error !== Camera.NoError)
        text: devices.videoInputs.length === 0 ? strings.t("noCamera", "No camera found. Connect a camera and try again.") : strings.t("cameraError", "Could not open the camera. Close any meeting app using it and try again.\n%1").arg(root.camera ? root.camera.errorString : "")
      }
    }
  }
}
