#!/bin/zsh
# Process control for the DOWNLOADED Mac app (packaging/build.sh copies this
# into "Piano by Ear.app/Contents/Resources/"). The household launcher is
# launcher/pbe.sh; this one carries its own node and never touches sleep.
#
#   pbe.sh status        running drill|free | stopped
#   pbe.sh start [free]  start the drill, or free play (stops a running one first)
#   pbe.sh stop
#   pbe.sh sound         app | hardware (what the next start will use)
#   pbe.sh have-pianos   exit 0 if the opt-in pianos are downloaded
#   pbe.sh pianos        download them (if needed) and use them
#   pbe.sh keyboard      use the keyboard's own sound
#   pbe.sh clicks [toggle]  where the metronome comes from: keyboard | computer
set -u
HERE="${0:A:h}"
NODE="$HERE/node"
APP="$HERE/app"
DATA="$HOME/.piano-by-ear"
LOG="$DATA/run.log"
mkdir -p "$DATA/profiles"

running() { pgrep -f 'Resources/app/src/(main|free)\.js' >/dev/null; }
mode() { pgrep -f 'Resources/app/src/free\.js' >/dev/null && echo free || echo drill; }
have_pianos() { [ -f "$DATA/samples/SalamanderGrandPianoV3_44.1khz16bit/SalamanderGrandPianoV3.sfz" ]; }
# Mirrors hardwareSound() in src/midiout.js.
sound() {
  if [ -s "$DATA/sound" ]; then cat "$DATA/sound"
  elif have_pianos; then echo app
  else echo hardware; fi
}

case "${1:-status}" in
  status) running && echo "running $(mode)" || echo "stopped" ;;
  sound) sound ;;
  have-pianos) have_pianos ;;
  pianos) cd "$APP" && "$NODE" src/download-pianos.js ;;
  keyboard) cd "$APP" && "$NODE" src/download-pianos.js --keyboard ;;
  clicks) cd "$APP" && "$NODE" src/metronome.js ${2:-} ;;
  start)
    "$0" stop
    cd "$APP" || exit 1
    if [ "${2:-}" = "free" ]; then
      nohup "$NODE" "$APP/src/free.js" > "$LOG" 2>&1 &
    else
      nohup "$NODE" "$APP/src/main.js" > "$LOG" 2>&1 &
    fi
    disown
    echo started
    ;;
  stop)
    if running; then pkill -f 'Resources/app/src/(main|free)\.js'; sleep 2; echo stopped; fi
    ;;
  *) echo "usage: pbe.sh status|start [free]|stop|sound|have-pianos|pianos|keyboard|clicks [toggle]" >&2; exit 2 ;;
esac
