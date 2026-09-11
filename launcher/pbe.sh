#!/bin/zsh
# piano-by-ear process control, shared by the macOS launcher app and the
# /piano-by-ear skill. Profiles are one SQLite file each under
# ~/.piano-by-ear/profiles/<name>.db; the current one is named in
# ~/.piano-by-ear/current-user. "Guest" is always offered and always starts
# empty: its history is deleted every time the drill starts as Guest. Sleep
# handling (pmset) lives in the app / the skill, not here, because it needs
# an admin dialog.
#
#   pbe.sh status            running <user> drill|free | stopped <user>
#   pbe.sh users             one profile name per line
#   pbe.sh current           the current user's name
#   pbe.sh mode              drill | free (what a running process is; drill if none)
#   pbe.sh sound [app|hardware]  print, or set, which box makes the sound
#   pbe.sh start [user] [free]   start the drill, or free play (stops a running one first)
#   pbe.sh stop              stop whatever is running
#
# "sound hardware" is for a keyboard with its own sound engine (a digital
# piano rather than a mute controller): the instrument voices its own keys and
# plays the call on its own channel, and only the clicks stay in the app. It
# is read at startup, so a change needs a restart.
set -u
PROJ="${0:A:h:h}"
DATA="$HOME/.piano-by-ear"
PROFILES="$DATA/profiles"
LOG="$DATA/run.log"
CURRENT="$DATA/current-user"
SOUND="$DATA/sound"
GUEST="Guest"
mkdir -p "$PROFILES"

current() { [ -s "$CURRENT" ] && cat "$CURRENT" || echo "default"; }
sound() { [ -s "$SOUND" ] && cat "$SOUND" || echo "app"; }
# The launcher app runs us with a bare PATH; find node the way a login shell would.
find_node() {
  command -v node 2>/dev/null && return
  local c
  for c in "$HOME/.nvm/versions/node/"*/bin/node(Nn[-1]) /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  return 1
}
running() { pgrep -f 'src/(main|free)\.js' >/dev/null; }
mode() { pgrep -f 'src/free\.js' >/dev/null && echo free || echo drill; }
valid() { [[ "$1" =~ '^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$' ]]; }

case "${1:-status}" in
  status)  running && echo "running $(current) $(mode)" || echo "stopped $(current)" ;;
  current) current ;;
  mode)    mode ;;
  sound)
    if [ $# -ge 2 ]; then
      case "$2" in
        app|hardware) echo "$2" > "$SOUND"; echo "$2" ;;
        *) echo "usage: pbe.sh sound [app|hardware]" >&2; exit 2 ;;
      esac
    else sound; fi
    ;;
  users)   for f in "$PROFILES"/*.db(N); do [ "${f:t:r}" = "$GUEST" ] || echo "${f:t:r}"; done; echo "$GUEST" ;;
  start)
    user="${2:-$(current)}"
    valid "$user" || { echo "bad user name: $user" >&2; exit 2; }
    "$0" stop
    [ "$user" = "$GUEST" ] && rm -f "$PROFILES/$GUEST.db" "$PROFILES/$GUEST.db-wal" "$PROFILES/$GUEST.db-shm"
    echo "$user" > "$CURRENT"
    cd "$PROJ" || exit 1
    NODE="$(find_node)" || { echo "node not found (install node or nvm)" | tee "$LOG" >&2; exit 1; }
    if [ "${3:-}" = "free" ]; then
      nohup "$NODE" src/free.js > "$LOG" 2>&1 &
    else
      nohup "$NODE" src/main.js --db "$PROFILES/$user.db" > "$LOG" 2>&1 &
    fi
    disown
    sleep 4
    echo "started as $user ($([ "${3:-}" = free ] && echo free play || echo drill))"
    tail -4 "$LOG"
    ;;
  stop)
    if running; then pkill -f 'src/(main|free)\.js'; sleep 1; echo "stopped"; fi
    ;;
  *) echo "usage: pbe.sh status|users|current|mode|sound [app|hardware]|start [user] [free]|stop" >&2; exit 2 ;;
esac
