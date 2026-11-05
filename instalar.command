#!/bin/bash
# Reel Studio — instalador para Mac. Doble clic (o clic derecho → Abrir la primera vez).
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/ReelStudio"
MODEL="mlx-community/whisper-large-v3-turbo"

paso() { printf "\n\033[1m▸ %s\033[0m\n" "$1"; }

echo "======================================"
echo "   Reel Studio — instalación"
echo "======================================"

ARCH="$(uname -m)"
if [ "$ARCH" != "arm64" ]; then
  echo "Aviso: esta Mac no tiene chip Apple (M1–M4). Funcionará, pero la transcripción será más lenta."
fi

paso "Homebrew (gestor de programas)"
if ! command -v brew >/dev/null 2>&1; then
  if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"
  else
    echo "Instalando Homebrew. Te pedirá la contraseña de tu Mac (no se ve mientras la escribes)."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)" || eval "$(/usr/local/bin/brew shellenv)"
  fi
fi
echo "ok: $(brew --version | head -1)"

paso "ffmpeg y Python"
brew list ffmpeg >/dev/null 2>&1 || brew install ffmpeg
brew list python@3.12 >/dev/null 2>&1 || brew install python@3.12
PY="$(brew --prefix python@3.12)/bin/python3.12"
echo "ok: $(ffmpeg -version | head -1 | cut -d' ' -f1-3) · $("$PY" --version)"

paso "Copiando Reel Studio a $DEST"
mkdir -p "$DEST"
if [ "$SRC" != "$DEST" ]; then
  rsync -a --delete --exclude proyectos --exclude .venv --exclude logs --exclude config --exclude VERSION "$SRC/" "$DEST/"
fi
mkdir -p "$DEST/config"
if [ ! -f "$DEST/config/update.json" ] && [ -f "$SRC/config/update.json" ]; then
  cp "$SRC/config/update.json" "$DEST/config/update.json"
fi
[ -f "$SRC/VERSION" ] && [ "$SRC" != "$DEST" ] && cp "$SRC/VERSION" "$DEST/VERSION"

paso "Actualizaciones automáticas"
if [ -f "$DEST/config/update.json" ] && grep -q '"token": ""' "$DEST/config/update.json"; then
  echo "Tu repositorio de GitHub es privado: pega aquí el token de solo lectura que creaste"
  echo "(no se ve mientras lo pegas). Si no lo tienes todavía, solo presiona Enter."
  read -r -s -p "Token: " TOKEN; echo
  if [ -n "$TOKEN" ]; then
    /usr/bin/python3 - "$DEST/config/update.json" "$TOKEN" <<'PYEOF'
import json, sys
p, t = sys.argv[1], sys.argv[2].strip()
c = json.load(open(p)); c["token"] = t
json.dump(c, open(p, "w"), indent=1)
PYEOF
    chmod 600 "$DEST/config/update.json"
    echo "ok: actualizaciones activadas"
  else
    echo "Sin token por ahora: Reel Studio funciona igual, pero no se actualizará solo."
  fi
else
  echo "ok"
fi
chmod +x "$DEST"/*.sh "$DEST"/*.command "$DEST/app/reel.py" 2>/dev/null || true
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

paso "Motor de transcripción"
[ -x "$DEST/.venv/bin/python" ] || "$PY" -m venv "$DEST/.venv"
"$DEST/.venv/bin/pip" install -q --upgrade pip
if [ "$ARCH" = "arm64" ]; then
  "$DEST/.venv/bin/pip" install -q --upgrade -r "$DEST/requirements-mac.txt"
else
  "$DEST/.venv/bin/pip" install -q --upgrade faster-whisper pillow
fi
echo "ok"

if [ "$ARCH" = "arm64" ]; then
  paso "Descargando el modelo de voz (≈1,6 GB, solo la primera vez)"
  "$DEST/.venv/bin/python" -c "from huggingface_hub import snapshot_download; snapshot_download('$MODEL')"
  echo "ok"
fi

FROM_APP=0
[ -f "$DEST/.desde-app" ] && FROM_APP=1 && rm -f "$DEST/.desde-app"
if [ -d "/Applications/Reel Studio.app/Contents/Resources/reel-studio" ] || [ "$FROM_APP" = 1 ]; then
  # Ya está la app de verdad (DMG): el lanzador viejo sobra
  OLD="$HOME/Applications/Reel Studio.app"
  [ -f "$OLD/Contents/Resources/Scripts/main.scpt" ] && rm -rf "$OLD"
else
  paso "Creando el acceso «Reel Studio»"
  mkdir -p "$HOME/Applications"
  APP="$HOME/Applications/Reel Studio.app"
  rm -rf "$APP"
  osacompile -o "$APP" -e "do shell script quoted form of \"$DEST/start.sh\" & \" > /dev/null 2>&1 &\"" >/dev/null
  cp "$DEST/assets/ReelStudio.icns" "$APP/Contents/Resources/applet.icns"
  touch "$APP"
  echo "ok: $APP (búscala en Launchpad o con Spotlight: «Reel Studio»)"
  echo "Consejo: la app con ventana propia está en Releases de tu GitHub (ReelStudio.dmg)."
fi

paso "Prueba rápida"
"$DEST/.venv/bin/python" - <<'EOF'
import subprocess, sys
sys.path.insert(0, __import__("os").path.expanduser("~/ReelStudio/app"))
import engine as E
print("ffmpeg:", E.FFMPEG)
out = subprocess.run([E.FFMPEG, "-hide_banner", "-filters"], capture_output=True, text=True).stdout
print("subtítulos (libass):", "sí" if " ass " in out else "NO — revisa ffmpeg")
print("H.264:", "libx264" if E.has_encoder("libx264") else ("VideoToolbox" if E.has_encoder("h264_videotoolbox") else "NO"))
EOF

if [ "$FROM_APP" = 1 ]; then
  "$DEST/start.sh" --sin-navegador
  echo
  echo "Listo. Ya puedes cerrar esta ventana: Reel Studio se abre en su propia ventana."
else
  "$DEST/start.sh"
  echo
  echo "Listo. Reel Studio se abrió en tu navegador."
  echo "Para abrirlo otra vez: app «Reel Studio» en Launchpad, o pídeselo a Claude."
fi
