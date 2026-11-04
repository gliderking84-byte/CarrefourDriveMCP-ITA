#!/bin/sh
# Start the virtual screen the login windows live on, then the given node command.
#
# Xvfb is the display, fluxbox gives windows a frame, x11vnc exports the screen
# on 127.0.0.1 only: the only way in is the server's passphrase-protected /desk.
set -e

if [ "${CARREFOUR_DESK:-1}" = "1" ] && command -v Xvfb >/dev/null 2>&1; then
  export DISPLAY="${DISPLAY:-:99}"
  n="${DISPLAY#:}"
  n="${n%%.*}"
  # A container that restarts (not recreated) keeps /tmp: the previous Xvfb's lock and socket
  # make the new Xvfb refuse to start ("Server is already active for display"), and then
  # x11vnc (the desk) and the login browser have no screen. Nothing else uses them here.
  rm -f "/tmp/.X${n}-lock" "/tmp/.X11-unix/X${n}"
  Xvfb "$DISPLAY" -screen 0 "${DESK_GEOMETRY:-1366x900}x24" -nolisten tcp >/tmp/xvfb.log 2>&1 &
  xvfb_pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    [ -e "/tmp/.X11-unix/X${n}" ] && break
    sleep 0.3
  done
  if kill -0 "$xvfb_pid" 2>/dev/null && [ -e "/tmp/.X11-unix/X${n}" ]; then
    fluxbox >/dev/null 2>&1 &
    x11vnc -display "$DISPLAY" -localhost -rfbport "${VNC_PORT:-5900}" -forever -shared -nopw -quiet >/tmp/x11vnc.log 2>&1 &
    echo "[carrefour-it] desk: virtual screen $DISPLAY ready, VNC on 127.0.0.1:${VNC_PORT:-5900}" >&2
  else
    echo "[carrefour-it] WARNING: the virtual screen (Xvfb $DISPLAY) did not start: no desk and no login window. Xvfb said:" >&2
    tail -n 5 /tmp/xvfb.log >&2 || true
  fi
fi

exec node "$@"
