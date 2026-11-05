#!/usr/bin/env python3
"""Reel Studio — actualizador automático desde GitHub.

Lee ~/ReelStudio/config/update.json:
    {"repo": "usuario/reel-studio", "branch": "main", "token": ""}
(token solo hace falta si el repositorio es privado).

  updater.py check   → dice si hay versión nueva (sale con código 10 si la hay)
  updater.py apply   → descarga e instala la versión nueva (no toca tus proyectos)
"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # ~/ReelStudio
CONFIG = ROOT / "config" / "update.json"
VERSION = ROOT / "VERSION"
KEEP = {"proyectos", ".venv", "logs", "config", "VERSION"}   # nunca se tocan


def cfg() -> dict:
    try:
        c = json.loads(CONFIG.read_text())
        return c if c.get("repo") else {}
    except Exception:
        return {}


def _get(url: str, c: dict, timeout=8, raw=False):
    h = {"User-Agent": "ReelStudio-updater", "Accept": "application/vnd.github+json"}
    if c.get("token"):
        h["Authorization"] = f"Bearer {c['token']}"
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    return data if raw else json.loads(data)


def current() -> str:
    try:
        return VERSION.read_text().strip()
    except Exception:
        return ""


def latest(c: dict) -> dict:
    j = _get(f"https://api.github.com/repos/{c['repo']}/commits/{c.get('branch', 'main')}", c)
    return {"sha": j["sha"], "message": j["commit"]["message"].split("\n")[0],
            "date": j["commit"]["committer"]["date"]}


def check() -> dict:
    c = cfg()
    if not c:
        return {"configured": False, "available": False, "current": current()}
    try:
        lt = latest(c)
    except Exception as ex:
        return {"configured": True, "available": False, "current": current(), "error": str(ex)}
    return {"configured": True, "available": lt["sha"] != current(), "current": current(),
            "latest": lt["sha"], "message": lt["message"], "date": lt["date"]}


def apply(log=print) -> dict:
    c = cfg()
    if not c:
        raise RuntimeError("Actualizaciones no configuradas (falta config/update.json).")
    lt = latest(c)
    if lt["sha"] == current():
        return {"updated": False, "current": current()}
    log("Descargando versión nueva…")
    blob = _get(f"https://api.github.com/repos/{c['repo']}/tarball/{lt['sha']}", c, timeout=120, raw=True)
    old_req = (ROOT / "requirements-mac.txt").read_text() if (ROOT / "requirements-mac.txt").exists() else ""
    with tempfile.TemporaryDirectory() as tmp:
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tf:
            safe = [m for m in tf.getmembers() if not (m.name.startswith("/") or ".." in Path(m.name).parts)]
            try:
                tf.extractall(tmp, members=safe, filter="data")
            except TypeError:  # Python sin filtros de seguridad
                tf.extractall(tmp, members=safe)
        top = next(Path(tmp).iterdir())
        if not (top / "app" / "server.py").exists():
            raise RuntimeError("La descarga no parece Reel Studio; no se instaló nada.")
        # copia todo menos lo del usuario; borra archivos del programa que ya no existen
        for item in ROOT.iterdir():
            if item.name not in KEEP and not (top / item.name).exists():
                shutil.rmtree(item) if item.is_dir() else item.unlink()
        for item in top.iterdir():
            if item.name in KEEP:
                continue
            dest = ROOT / item.name
            if dest.is_dir() and not dest.is_symlink():
                shutil.rmtree(dest)
            elif dest.exists():
                dest.unlink()
            shutil.copytree(item, dest) if item.is_dir() else shutil.copy2(item, dest)
    for f in list(ROOT.glob("*.sh")) + list(ROOT.glob("*.command")) + [ROOT / "app" / "reel.py"]:
        if f.exists():
            f.chmod(0o755)
    new_req = (ROOT / "requirements-mac.txt").read_text() if (ROOT / "requirements-mac.txt").exists() else ""
    pip = ROOT / ".venv" / "bin" / "pip"
    if new_req and new_req != old_req and pip.exists():
        log("Instalando componentes nuevos…")
        subprocess.run([str(pip), "install", "-q", "-r", str(ROOT / "requirements-mac.txt")], check=False)
    VERSION.write_text(lt["sha"] + "\n")
    log(f"Actualizado: {lt['message']}")
    return {"updated": True, "current": lt["sha"], "message": lt["message"]}


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "check":
        r = check()
        print(json.dumps(r, ensure_ascii=False))
        sys.exit(10 if r.get("available") else 0)
    elif cmd == "apply":
        try:
            print(json.dumps(apply(), ensure_ascii=False))
        except Exception as ex:
            print("No se pudo actualizar:", ex)
            sys.exit(1)
