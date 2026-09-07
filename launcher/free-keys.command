#!/bin/zsh
# Free play in a Terminal window, playable from the computer keyboard (and
# MIDI too). Opened by the launcher's "Free play (computer keys)".
HERE="${0:A:h}"
"$HERE/pbe.sh" stop >/dev/null 2>&1
cd "$HERE/.." || exit 1
NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ]; then
  for c in "$HOME/.nvm/versions/node/"*/bin/node(Nn[-1]) /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && { NODE="$c"; break; }
  done
fi
[ -n "$NODE" ] || { echo "node not found"; read -k1; exit 1; }
printf '\033]0;Piano by Ear: free play\007'
clear
"$NODE" src/free.js --keys
echo; echo "free play ended. Close this window, or click Piano by Ear to start the drill."
