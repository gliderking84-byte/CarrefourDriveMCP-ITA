#!/bin/sh
# Start the virtual screen the login windows live on, then the given node command.
#
# Xvfb is the display, fluxbox gives windows a frame, x11vnc exports the screen
# on 127.0.0.1 only: the only way in is the server's passphrase-protected /desk.
set -e

if [ "${CARREFOUR_DESK:-1}" = "1" ] && command -v Xvfb >/dev/null 2>&1; then
  export DISPLAY="${DISPLAY:-:99}"
  Xvfb "$DISPLAY" -screen 0 "${DESK_GEOMETRY:-1366x900}x24" -nolisten tcp >/dev/null 2>&1 &
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -e "/tmp/.X11-unix/X${DISPLAY#:}" ] && break
    sleep 0.3
  done
  fluxbox >/dev/null 2>&1 &
  x11vnc -display "$DISPLAY" -localhost -rfbport "${VNC_PORT:-5900}" -forever -shared -nopw -quiet >/dev/null 2>&1 &
fi

exec node "$@"
