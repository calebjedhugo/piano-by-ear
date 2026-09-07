#!/bin/zsh
# piano-by-ear process control, shared by the macOS launcher app and the
# /piano-by-ear skill. Profiles are one SQLite file each under
# ~/.piano-by-ear/profiles/<name>.db; the current one is named in
# ~/.piano-by-ear/current-user. Sleep handling (pmset) lives in the app /
# the skill, not here, because it needs an admin dialog.
#
#   pbe.sh status            running <user> | stopped <user>
#   pbe.sh users             one profile name per line
#   pbe.sh current           the current user's name
#   pbe.sh start [user]      start the drill (stops a running one first)
#   pbe.sh stop              stop the drill
set -u
PROJ="${0:A:h:h}"
DATA="$HOME/.piano-by-ear"
PROFILES="$DATA/profiles"
LOG="$DATA/run.log"
CURRENT="$DATA/current-user"
mkdir -p "$PROFILES"

current() { [ -s "$CURRENT" ] && cat "$CURRENT" || echo "default"; }
# The launcher app runs us with a bare PATH; find node the way a login shell would.
find_node() {
  command -v node 2>/dev/null && return
  local c
  for c in "$HOME/.nvm/versions/node/"*/bin/node(Nn[-1]) /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  return 1
}
running() { pgrep -f 'node src/main.js' >/dev/null; }
valid() { [[ "$1" =~ '^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$' ]]; }

case "${1:-status}" in
  status)  running && echo "running $(current)" || echo "stopped $(current)" ;;
  current) current ;;
  users)   for f in "$PROFILES"/*.db(N); do echo "${f:t:r}"; done ;;
  start)
    user="${2:-$(current)}"
    valid "$user" || { echo "bad user name: $user" >&2; exit 2; }
    "$0" stop
    echo "$user" > "$CURRENT"
    cd "$PROJ" || exit 1
    NODE="$(find_node)" || { echo "node not found (install node or nvm)" | tee "$LOG" >&2; exit 1; }
    nohup "$NODE" src/main.js --db "$PROFILES/$user.db" > "$LOG" 2>&1 &
    disown
    sleep 4
    echo "started as $user"
    tail -4 "$LOG"
    ;;
  stop)
    if running; then pkill -f 'node src/main.js'; sleep 1; echo "stopped"; fi
    ;;
  *) echo "usage: pbe.sh status|users|current|start [user]|stop" >&2; exit 2 ;;
esac
