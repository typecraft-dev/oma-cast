#!/usr/bin/env python3
"""Tells Superwhisper where the launcher's card is, so its recording glow (or
pill) draws on the launcher rather than on the window under it.

stdin takes one line per change: "1 <monitor> <x> <y> <width> <height>" while
the launcher is open (logical pixels from the monitor's top left), "0" when it
closes. While open this owns com.superwhisper.ShellOverlay and publishes the
card as the Frame property (siiii) of com.superwhisper.ShellOverlay at
/com/superwhisper/ShellOverlay. Exits when stdin closes, releasing the name.
"""
import os
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

NAME = INTERFACE = "com.superwhisper.ShellOverlay"
PATH = "/com/superwhisper/ShellOverlay"
XML = f"""<node><interface name="{INTERFACE}">
<property name="Frame" type="(siiii)" access="read"/>
</interface></node>"""
EMPTY = ("", 0, 0, 0, 0)

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
loop = GLib.MainLoop()
frame = EMPTY
owner = 0
pending = b""


def value():
    return GLib.Variant("(siiii)", frame)


def get_property(*_):
    return value()


def apply(line):
    global frame, owner
    words = line.split()
    if words[:1] == ["1"] and len(words) == 6:
        try:
            new = (words[1], *(int(float(w)) for w in words[2:]))
        except ValueError:
            return
    else:
        new = EMPTY
    if new != frame:
        frame = new
        bus.emit_signal(None, PATH, "org.freedesktop.DBus.Properties", "PropertiesChanged",
                        GLib.Variant("(sa{sv}as)", (INTERFACE, {"Frame": value()}, [])))
    if frame != EMPTY and not owner:
        owner = Gio.bus_own_name_on_connection(bus, NAME, Gio.BusNameOwnerFlags.NONE, None, None)
    elif frame == EMPTY and owner:
        Gio.bus_unown_name(owner)
        owner = 0


def command(fd, _condition):
    global pending
    data = os.read(fd, 4096)
    if not data:
        loop.quit()
        return False
    *lines, pending = (pending + data).split(b"\n")
    if lines:
        apply(lines[-1].decode(errors="replace"))
    return True


info = Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0]
bus.register_object(PATH, info, None, get_property, None)
GLib.io_add_watch(sys.stdin.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP, command)
loop.run()
