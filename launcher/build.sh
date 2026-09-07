#!/bin/zsh
# Build "Piano by Ear.app" into /Applications (or $1): compiles the
# AppleScript with this checkout's pbe.sh path baked in, and sets the icon.
set -e
HERE="${0:A:h}"
DEST="${1:-/Applications}"
APP="$DEST/Piano by Ear.app"
TMP="$(mktemp -d)"
sed "s|@@PBE@@|$HERE/pbe.sh|" "$HERE/PianoByEar.applescript" > "$TMP/PianoByEar.applescript"
rm -rf "$APP"
osacompile -o "$APP" "$TMP/PianoByEar.applescript"
python3 "$HERE/icon.py" "$TMP/icon.png"
mkdir -p "$TMP/icon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon.png" --out "$TMP/icon.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s*2)); sips -z $d $d "$TMP/icon.png" --out "$TMP/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$TMP/icon.iconset" -o "$APP/Contents/Resources/applet.icns"
codesign --force --deep --sign - "$APP" 2>/dev/null || true  # re-seal after swapping the icon
touch "$APP"
rm -rf "$TMP"
echo "built: $APP"
