import QtQuick
import Quickshell.Io

// Compatibility stand-in for qs.Commons.ShellIpc on Omarchy 4.0.x, which lacks
// it (and the IpcRegistry socket it registers with). A plain IpcHandler is
// still reached by omarchy-shell through `qs ipc`. Launcher imports qs.Commons
// explicitly, so Omarchy's own ShellIpc wins once it ships.
IpcHandler {}
