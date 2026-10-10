#!/bin/zsh
# Build the downloads friends install from:
#   packaging/build/Piano-by-Ear-mac.dmg       universal (Apple silicon + Intel)
#   packaging/build/Piano-by-Ear-windows.zip   x64
#   packaging/build/Piano-by-Ear-pianos.zip    the OPT-IN pianos (src/download-pianos.js)
#
#   packaging/build.sh
#
# The first two carry their own Node (nothing to install first), the app and
# the shareable corpus, and NO samples: most people play a keyboard with its
# own sound, so the pianos are a separate download fetched from the app (all
# three go on the GitHub release PIANOS_TAG names; the app's copy of
# download-pianos.js is stamped with that URL and the zip's SHA-256).
# What goes in is LISTED, never globbed from the repo:
# corpus/local/, scripts/, data/ and ~/.piano-by-ear (profiles, roster,
# sync.json) never ship. Inputs are cached in packaging/cache/: Node from
# nodejs.org (checked against SHASUMS256.txt) and the pianos from
# ~/.piano-by-ear/samples (run `npm run fetch-samples` first).
#
# UNSIGNED: no Apple Developer ID, so macOS asks before the first open
# (System Settings > Privacy & Security > Open Anyway), and Windows asks
# before running the .cmd.
set -euo pipefail
HERE="${0:A:h}"
REPO="${HERE:h}"
NODE_VERSION=v24.18.0
CACHE="$HERE/cache"
OUT="$HERE/build"
SRC_SAMPLES="$HOME/.piano-by-ear/samples"
SALAMANDER=SalamanderGrandPianoV3_44.1khz16bit
UPRIGHT=UprightPianoKW-SFZ+FLAC-20220221
LAYERS='v(2|6|10|14)'   # must match SALAMANDER_LAYERS in src/sampler.js
PIANOS_TAG=v1.0.0       # the release that holds Piano-by-Ear-pianos.zip
PIANOS_URL="https://github.com/calebjedhugo/piano-by-ear/releases/download/$PIANOS_TAG/Piano-by-Ear-pianos.zip"
mkdir -p "$CACHE" "$OUT"

# ---- Node, verified ---------------------------------------------------------
cd "$CACHE"
[ -f SHASUMS256.txt ] || curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
for f in node-$NODE_VERSION-darwin-arm64.tar.xz node-$NODE_VERSION-darwin-x64.tar.xz node-$NODE_VERSION-win-x64.zip; do
  [ -f "$f" ] || curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/$f"
  grep " $f\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null || { echo "checksum FAILED: $f" >&2; exit 1; }
done
for a in arm64 x64; do
  [ -d node-$NODE_VERSION-darwin-$a ] || tar -xf node-$NODE_VERSION-darwin-$a.tar.xz
done
[ -d node-$NODE_VERSION-win-x64 ] || unzip -q node-$NODE_VERSION-win-x64.zip
[ -f node-universal ] || lipo -create -output node-universal \
  node-$NODE_VERSION-darwin-arm64/bin/node node-$NODE_VERSION-darwin-x64/bin/node

# ---- Pianos: the kept Salamander layers as FLAC, the upright as published ----
GRAND="$CACHE/samples/$SALAMANDER"
if [ ! -f "$GRAND/SalamanderGrandPianoV3.sfz" ]; then
  [ -f "$SRC_SAMPLES/$SALAMANDER/SalamanderGrandPianoV3.sfz" ] || { echo "run npm run fetch-samples first" >&2; exit 1; }
  mkdir -p "$GRAND/44.1khz16bit"
  cp "$SRC_SAMPLES/$SALAMANDER/README" "$GRAND/"
  # Only the regions the sampler loads: the kept note layers and the per-key
  # hammer releases. Everything else in the file is kept as written.
  awk -v re="(${LAYERS}|rel[0-9]+)\\\\.wav" '
    /^<region>/ { if ($0 ~ re) { gsub(/\.wav/, ".flac"); print }; next }
    { print }' "$SRC_SAMPLES/$SALAMANDER/SalamanderGrandPianoV3.sfz" > "$GRAND/SalamanderGrandPianoV3.sfz"
  grep -oE 'sample=44\.1khz16bit\\[^ ]+' "$GRAND/SalamanderGrandPianoV3.sfz" | sed 's/.*\\//; s/\.flac$//' |
    xargs -P 8 -I{} flac -s -8 "$SRC_SAMPLES/$SALAMANDER/44.1khz16bit/{}.wav" -o "$GRAND/44.1khz16bit/{}.flac"
fi
[ -d "$CACHE/samples/$UPRIGHT" ] || cp -R "$SRC_SAMPLES/$UPRIGHT" "$CACHE/samples/"
# Rebuilt only when missing: its SHA-256 is baked into every app that can
# fetch it, so the zip on the release must stay byte-for-byte this file.
PIANOS="$OUT/Piano-by-Ear-pianos.zip"
if [ ! -f "$PIANOS" ]; then
  cp "$HERE/PIANOS-CREDITS.txt" "$CACHE/samples/CREDITS.txt"
  (cd "$CACHE/samples" && zip -qr -X -0 "$PIANOS" CREDITS.txt "$SALAMANDER" "$UPRIGHT" -x '*.DS_Store')
fi
PIANOS_SHA="$(shasum -a 256 "$PIANOS" | cut -d' ' -f1)"

# ---- The app, platform-neutral ---------------------------------------------
STAGE="$OUT/stage"
rm -rf "$STAGE"; mkdir -p "$STAGE/app/corpus"
cp -R "$REPO/src" "$REPO/package.json" "$STAGE/app/"
cp "$REPO"/corpus/{phrases,poly,trios,hymns}.json "$REPO/corpus/README.md" "$STAGE/app/corpus/"
cp -R "$REPO/node_modules" "$STAGE/app/"
sed -i '' "s|@@PIANOS_URL@@|$PIANOS_URL|; s|@@PIANOS_SHA256@@|$PIANOS_SHA|" "$STAGE/app/src/download-pianos.js"
cp "$HERE/How to play.txt" "$HERE/NOTICE.txt" "$STAGE/"
rm -rf "$STAGE/app/node_modules/@julusian/midi/"{src-cpp,vendor} "$STAGE/app/node_modules/.package-lock.json"
find "$STAGE/app" -name .DS_Store -delete

# Per platform: keep only that platform's native modules.
prune() { # dir, keep-regex
  for f in "$1"/node_modules/@julusian/midi/prebuilds/* "$1"/node_modules/node-web-audio-api/*.node; do
    [[ "${f:t}" =~ $2 ]] || rm -rf "$f"
  done
}

# ---- Mac --------------------------------------------------------------------
MAC="$OUT/mac"
APPB="$MAC/Piano by Ear.app"
rm -rf "$MAC"; mkdir -p "$MAC"
osacompile -o "$APPB" "$HERE/mac/launcher.applescript"
R="$APPB/Contents/Resources"
cp -R "$STAGE/app" "$R/app"
prune "$R/app" 'darwin'
cp "$CACHE/node-universal" "$R/node"
cp "$CACHE/node-$NODE_VERSION-darwin-arm64/LICENSE" "$R/node-LICENSE"
cp "$HERE/mac/pbe.sh" "$R/pbe.sh"; chmod +x "$R/pbe.sh" "$R/node"
TMPI="$(mktemp -d)"
python3 "$REPO/launcher/icon.py" "$TMPI/icon.png"
mkdir -p "$TMPI/icon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMPI/icon.png" --out "$TMPI/icon.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s*2)); sips -z $d $d "$TMPI/icon.png" --out "$TMPI/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$TMPI/icon.iconset" -o "$R/applet.icns"
rm -rf "$TMPI"
# Ad-hoc signatures only (Apple silicon will not run unsigned native code).
# node keeps the OpenJS Foundation's own signature, slice by slice.
find "$R/app" -name '*.node' -exec codesign --force --sign - {} \;
codesign --force --sign - "$APPB"
cp "$STAGE/How to play.txt" "$STAGE/NOTICE.txt" "$MAC/"
ln -s /Applications "$MAC/Applications"
rm -f "$OUT/Piano-by-Ear-mac.dmg"
hdiutil create -quiet -volname "Piano by Ear" -srcfolder "$MAC" -fs HFS+ -format UDZO "$OUT/Piano-by-Ear-mac.dmg"

# ---- Windows ----------------------------------------------------------------
WIN="$OUT/win/Piano by Ear"
rm -rf "$OUT/win"; mkdir -p "$WIN/node"
cp -R "$STAGE/app" "$WIN/app"
prune "$WIN/app" 'win32-x64'
cp "$CACHE/node-$NODE_VERSION-win-x64/node.exe" "$CACHE/node-$NODE_VERSION-win-x64/LICENSE" "$WIN/node/"
for f in "$HERE"/windows/*.cmd "$STAGE/How to play.txt" "$STAGE/NOTICE.txt"; do
  sed 's/\r$//; s/$/\r/' "$f" > "$WIN/${f:t}"   # CRLF, or cmd.exe misreads them
done
rm -f "$OUT/Piano-by-Ear-windows.zip"
(cd "$OUT/win" && zip -qr -X "$OUT/Piano-by-Ear-windows.zip" "Piano by Ear")

rm -rf "$STAGE"
ls -lh "$OUT"/*.dmg "$OUT"/*.zip
