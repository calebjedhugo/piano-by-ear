#!/bin/zsh
# piano-by-ear process control, shared by the macOS launcher app and the
# /piano-by-ear skill. Sleep handling (pmset) lives in the app / the skill,
# not here, because it needs an admin dialog.
#
# THERE IS NO LONGER A USER TO START AS. Since 2026-09-19 the player names
# himself from the keyboard -- his chord opens his profile (src/lobby.js) --
# so this script starts one process and asks it who is loaded rather than
# telling it. `current` is therefore a REPORT, written by the running drill
# into ~/.piano-by-ear/current-user, and it is empty when nobody is logged in.
# Profiles are one SQLite file each under ~/.piano-by-ear/profiles/<name>.db,
# merged with the pi as they open and close (src/sync.js); the chords live in
# ~/.piano-by-ear/roster.json and travel with them.
#
#   pbe.sh status            running <user|nobody> drill|free | stopped
#   pbe.sh users             one live profile name per line (from the roster)
#   pbe.sh current           who is loaded right now, or "nobody"
#   pbe.sh mode              drill | free (what a running process is; drill if none)
#   pbe.sh sound [app|hardware]  print, or set, which box makes the sound
#   pbe.sh start [free]      start the drill, or free play (stops a running one first)
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
ROSTER="$DATA/roster.json"
SOUND="$DATA/sound"
mkdir -p "$PROFILES"

# Who the RUNNING drill says is loaded. Nobody is a normal state: the drill
# sits in the lobby until someone plays their chord.
current() { running && [ -s "$CURRENT" ] && cat "$CURRENT" || echo "nobody"; }
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

case "${1:-status}" in
  status)  running && echo "running $(current) $(mode)" || echo "stopped" ;;
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
  users)
    if [ -s "$ROSTER" ]; then
      "$(find_node)" -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const p of r.profiles)if(!p.retiredAt)console.log(p.name)' "$ROSTER"
    fi
    ;;
  start)
    "$0" stop
    : > "$CURRENT"
    cd "$PROJ" || exit 1
    NODE="$(find_node)" || { echo "node not found (install node or nvm)" | tee "$LOG" >&2; exit 1; }
    if [ "${2:-}" = "free" ]; then
      nohup "$NODE" src/free.js > "$LOG" 2>&1 &
    else
      nohup "$NODE" src/main.js --profiles "$PROFILES" > "$LOG" 2>&1 &
    fi
    disown
    sleep 4
    echo "started ($([ "${2:-}" = free ] && echo free play || echo drill))"
    tail -4 "$LOG"
    ;;
  stop)
    if running; then pkill -f 'src/(main|free)\.js'; sleep 2; : > "$CURRENT"; echo "stopped"; fi
    ;;
  *) echo "usage: pbe.sh status|users|current|mode|sound [app|hardware]|start [free]|stop" >&2; exit 2 ;;
esac
