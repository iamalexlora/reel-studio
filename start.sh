#!/bin/bash
# Abre Reel Studio: arranca el servidor local si no está corriendo y abre el navegador.
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8765
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
PY="$DIR/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

mkdir -p "$DIR/logs"
running() { curl -s -m 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; }

# Actualización automática (si está configurada en config/update.json)
if [ -f "$DIR/config/update.json" ]; then
  "$PY" "$DIR/app/updater.py" check >/dev/null 2>&1
  if [ $? -eq 10 ]; then
    if "$PY" "$DIR/app/updater.py" apply >> "$DIR/logs/actualizaciones.log" 2>&1 && running; then
      kill "$(cat "$DIR/logs/servidor.pid" 2>/dev/null)" 2>/dev/null
      for i in $(seq 1 20); do running || break; sleep 0.25; done
    fi
  fi
fi

if ! running; then
  cd "$DIR/app"
  nohup "$PY" server.py >> "$DIR/logs/servidor.log" 2>&1 &
  echo $! > "$DIR/logs/servidor.pid"
  for i in $(seq 1 40); do
    running && break
    sleep 0.25
  done
fi

if [ "$1" != "--sin-navegador" ]; then
  open "http://localhost:$PORT/" 2>/dev/null || xdg-open "http://localhost:$PORT/" 2>/dev/null
fi
echo "Reel Studio en http://localhost:$PORT"
