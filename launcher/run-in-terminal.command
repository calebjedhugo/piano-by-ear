#!/bin/zsh
# Runs the drill or free play in this Terminal window with the computer
# keyboard as a controller (--keys). Opened by pbe.sh start when the
# "use keyboard keys" toggle is on; reads mode and user from
# ~/.piano-by-ear/keys-launch. Output is also copied to run.log.
HERE="${0:A:h}"
DATA="$HOME/.piano-by-ear"
MODE="$(sed -n 1p "$DATA/keys-launch" 2>/dev/null)"; MODE="${MODE:-drill}"
USER_="$(sed -n 2p "$DATA/keys-launch" 2>/dev/null)"; USER_="${USER_:-default}"
cd "$HERE/.." || exit 1
NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ]; then
  for c in "$HOME/.nvm/versions/node/"*/bin/node(Nn[-1]) /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && { NODE="$c"; break; }
  done
fi
[ -n "$NODE" ] || { echo "node not found"; read -k1; exit 1; }
pkill -f 'src/(main|free)\.js' 2>/dev/null; sleep 0.5
printf '\033]0;Piano by Ear (%s, computer keyboard)\007' "$MODE"
clear
if [ "$MODE" = free ]; then
  "$NODE" src/free.js --keys 2>&1 | tee "$DATA/run.log"
else
  "$NODE" src/main.js --keys --db "$DATA/profiles/$USER_.db" 2>&1 | tee "$DATA/run.log"
fi
echo; echo "ended. Close this window, or click Piano by Ear."
