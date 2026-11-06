#!/bin/bash
# Construye "Reel Studio.app" y ReelStudio.dmg. Necesita una Mac (lo corre GitHub Actions).
set -euo pipefail
cd "$(dirname "$0")/.."
SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"
REPO="${GITHUB_REPOSITORY:-iamalexlora/reel-studio}"
VERSION="1.$(git rev-list --count HEAD)"
rm -rf build dist && mkdir -p build dist

APP="build/Reel Studio.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/reel-studio"

echo "▸ Compilando"
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12.0" -o "build/ReelStudio-$arch" mac/ReelStudio.swift \
    -framework Cocoa -framework WebKit
done
lipo -create -output "$APP/Contents/MacOS/ReelStudio" build/ReelStudio-arm64 build/ReelStudio-x86_64

echo "▸ Armando la app"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/${SHA:0:7}/" mac/Info.plist > "$APP/Contents/Info.plist"
cp assets/ReelStudio.icns "$APP/Contents/Resources/ReelStudio.icns"
git archive HEAD | tar -x -C "$APP/Contents/Resources/reel-studio"
echo "$SHA" > "$APP/Contents/Resources/reel-studio/VERSION"
mkdir -p "$APP/Contents/Resources/reel-studio/config"
printf '{\n "repo": "%s",\n "branch": "main",\n "token": "%s"\n}\n' "$REPO" "${UPDATE_TOKEN:-}" \
  > "$APP/Contents/Resources/reel-studio/config/update.json"
plutil -lint "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

echo "▸ Creando el DMG"
mkdir -p build/dmg
cp -R "$APP" build/dmg/
ln -s /Applications build/dmg/Aplicaciones
hdiutil create -volname "Reel Studio" -srcfolder build/dmg -ov -format UDZO dist/ReelStudio.dmg
ls -la dist
