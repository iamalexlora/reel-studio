#!/bin/bash
# Apaga el servidor de Reel Studio.
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$DIR/logs/servidor.pid" ]; then
  kill "$(cat "$DIR/logs/servidor.pid")" 2>/dev/null && echo "Reel Studio apagado."
  rm -f "$DIR/logs/servidor.pid"
else
  echo "No estaba corriendo."
fi
