# Camera preview

An optional Omarchy shell plugin with an **Open camera** command in oma-cast.
It opens a mirrored live preview of the default camera. If multiple cameras
are connected, a selector lets you choose another one. Escape or closing the
window stops capture and releases the camera. There is no audio or recording.
Close the preview before joining a meeting.

This uses Omarchy's existing plugin and menu extension APIs. It does not
require oma-cast's planned Raycast extension runtime, a desktop application
entry, mpv, or a background camera process.

## Install

Requires Omarchy 4 and Qt Multimedia, including a working camera backend
and the QtMultimedia QML module. On Arch Linux, install `qt6-multimedia`
and a backend such as `qt6-multimedia-ffmpeg`.
Run these commands from the oma-cast checkout, which must remain in place:

```sh
mkdir -p ~/.config/omarchy/plugins
ln -s "$PWD/addons/camera-preview" ~/.config/omarchy/plugins/oma-cast.camera-preview
omarchy-shell shell rescanPlugins
omarchy plugin enable oma-cast.camera-preview
```

Merge the object in `menu-entry.json` into
`~/.config/omarchy/extensions/omarchy-menu.jsonc`, preserving your existing
entries. Create the file and its parent directory if needed. oma-cast picks
up menu extensions automatically. Search for **Open camera** and press Enter.

To test the plugin directly:

```sh
omarchy-shell shell summon oma-cast.camera-preview '{}'
```

## Remove

Remove the `camera-preview` entry from your menu extension file, then run:

```sh
omarchy plugin disable oma-cast.camera-preview
rm ~/.config/omarchy/plugins/oma-cast.camera-preview
omarchy-shell shell rescanPlugins
```

No connected cameras or a capture failure displays an error in the preview.
Camera permissions and whether another application can share the camera are
managed by the system's Qt Multimedia backend.
