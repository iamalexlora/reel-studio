"""Reel Studio — servidor local. Abre http://localhost:8765"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import subprocess
import sys
import threading
import time
import traceback
import uuid
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import engine as E
import updater as U

PORT = int(os.environ.get("REEL_PORT", "8765"))
STATIC = E.APP_DIR / "static"
JOBS: dict[str, dict] = {}
TRANSCRIBE_LOCK = threading.Lock()   # un modelo de voz a la vez (memoria)


def new_job(kind: str, pid: str) -> dict:
    j = {"id": uuid.uuid4().hex[:10], "kind": kind, "project": pid, "status": "running",
         "progress": 0.0, "message": "En cola…", "result": None, "error": None, "started": time.time()}
    JOBS[j["id"]] = j
    return j


def run_job(j, fn):
    def prog(f, msg=""):
        j["progress"] = round(float(f), 4)
        if msg:
            j["message"] = msg
    def target():
        try:
            j["result"] = fn(prog)
            j["status"], j["progress"], j["message"] = "done", 1.0, "Listo"
        except Exception as ex:  # noqa
            traceback.print_exc()
            j["status"], j["error"] = "error", str(ex)
    threading.Thread(target=target, daemon=True).start()
    return j


def start_transcription(pid: str):
    j = new_job("transcribe", pid)

    def work(prog):
        with TRANSCRIBE_LOCK:
            p = E.load(pid)
            E.update(pid, lambda q: q.update(status="transcribiendo", job=j["id"]))
            prog(0.02, "Preparando audio…")
            words = E.transcribe(p, prog)
            def apply(q):
                q["words"] = words
                q["engine"] = p.get("engine")
                q["status"] = "listo"
                q["job"] = None
                E.autoclean(q)
                st = q.get("autoStats", {})
                E.add_log(q, "auto", f"Transcribí {len(words)} palabras y marqué "
                          f"{st.get('muletilla', 0)} muletillas, {st.get('repetición', 0)} repeticiones "
                          f"y {st.get('toma repetida', 0)} palabras de tomas repetidas.")
            E.update(pid, apply)
            return {"words": len(words)}
    def safe(prog):
        try:
            return work(prog)
        except Exception:
            E.update(pid, lambda q: q.update(status="error", job=None))
            raise
    return run_job(j, safe)


class H(BaseHTTPRequestHandler):
    server_version = "ReelStudio/1.0"

    def log_message(self, fmt, *args):
        if os.environ.get("REEL_DEBUG"):
            super().log_message(fmt, *args)

    # ------------------------------------------------------------ utilidades
    def send_json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def send_file(self, path: Path, download_name: str | None = None, cache=False):
        if not path.exists() or not path.is_file():
            return self.send_json({"error": "no existe"}, 404)
        size = path.stat().st_size
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        code = 200
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    if m.group(2):
                        end = min(int(m.group(2)), size - 1)
                elif m.group(2):
                    start = max(0, size - int(m.group(2)))
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.end_headers()
                    return
                code = 206
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if download_name:
            self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.send_header("Cache-Control", "max-age=3600" if cache else "no-cache")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            try:
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    # ------------------------------------------------------------ rutas
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        u = urlparse(self.path)
        parts = [unquote(x) for x in u.path.strip("/").split("/") if x]
        try:
            if not parts:
                return self.send_file(STATIC / "index.html")
            if parts[0] == "static" and len(parts) == 2:
                return self.send_file(STATIC / Path(parts[1]).name)
            if parts[0] == "fonts" and len(parts) == 2:
                return self.send_file(E.FONTS_DIR / Path(parts[1]).name, cache=True)
            if parts[0] == "media" and len(parts) >= 3:
                d = E.project_dir(parts[1])
                if parts[2] == "source":
                    proxy = d / "proxy.mp4"
                    return self.send_file(proxy if proxy.exists() else d / E.load(parts[1])["source"])
                if parts[2] in ("strip.jpg", "wave.png"):
                    return self.send_file(d / parts[2])
                if parts[2] == "export" and len(parts) == 4:
                    name = Path(parts[3]).name
                    dl = "dl" in parse_qs(u.query)
                    return self.send_file(d / "exports" / name, download_name=name if dl else None)
            if parts[:2] == ["api", "update"]:
                return self.send_json(U.check())
            if parts[:2] == ["api", "health"]:
                return self.send_json({"ok": True, "ffmpeg": E.FFMPEG, "engine": engine_name()})
            if parts[:2] == ["api", "meta"]:
                return self.send_json({"presets": E.PRESETS, "fonts": E.FONTS, "defaults": E.DEFAULT_SETTINGS,
                                       "formats": E.FORMATS,
                                       "home": str(E.HOME), "engine": engine_name()})
            if parts[:2] == ["api", "projects"] and len(parts) == 2:
                return self.send_json(E.list_projects())
            if parts[:2] == ["api", "projects"] and len(parts) == 3:
                p = E.load(parts[2])
                p["exports"] = list_exports(parts[2])
                return self.send_json(p)
            if parts[:2] == ["api", "projects"] and len(parts) == 4 and parts[3] == "rev":
                p = E.load(parts[2])
                return self.send_json({"rev": p.get("rev", 0), "status": p.get("status")})
            if parts[:2] == ["api", "jobs"] and len(parts) == 3:
                j = JOBS.get(parts[2])
                return self.send_json(j or {"error": "no existe"}, 200 if j else 404)
            if parts[:2] == ["api", "jobs"] and len(parts) == 2:
                return self.send_json([j for j in JOBS.values() if j["status"] == "running"])
            self.send_json({"error": "ruta no encontrada"}, 404)
        except FileNotFoundError:
            self.send_json({"error": "no existe"}, 404)
        except Exception as ex:
            traceback.print_exc()
            self.send_json({"error": str(ex)}, 500)

    def do_POST(self):
        u = urlparse(self.path)
        parts = [unquote(x) for x in u.path.strip("/").split("/") if x]
        q = parse_qs(u.query)
        try:
            if parts == ["api", "projects"]:
                return self.upload(q)
            if parts == ["api", "shutdown"]:
                self.send_json({"ok": True})
                threading.Timer(0.2, lambda: os._exit(0)).start()
                return
            if parts == ["api", "update"]:
                if any(j["status"] == "running" and j["kind"] == "export" for j in JOBS.values()):
                    return self.send_json({"error": "Espera a que termine la exportación."}, 409)
                r = U.apply(log=lambda m: None)
                self.send_json(r)
                if r.get("updated"):
                    threading.Timer(0.5, restart).start()
                return
            if parts == ["api", "import"]:
                b = self.body_json()
                src = Path(os.path.expanduser(b.get("path", "")))
                if not src.is_file():
                    return self.send_json({"error": f"No encuentro el archivo {src}"}, 400)
                p, dest = E.create_project(b.get("name") or src.stem, src.suffix or ".mp4")
                import shutil
                shutil.copyfile(src, dest)
                return self.send_json(after_import(p))
            if parts[:2] == ["api", "projects"] and len(parts) == 4:
                pid, action = parts[2], parts[3]
                if action == "autoclean":
                    def fn(p):
                        E.autoclean(p)
                        st = p.get("autoStats", {})
                        E.add_log(p, "auto", f"Limpieza automática: {st.get('muletilla', 0)} muletillas, "
                                  f"{st.get('repetición', 0)} repeticiones, {st.get('toma repetida', 0)} "
                                  f"palabras de tomas repetidas.")
                    return self.send_json(E.update(pid, fn))
                if action == "transcribe":
                    return self.send_json(start_transcription(pid))
                if action == "export":
                    opts = self.body_json()
                    j = new_job("export", pid)
                    def work(prog):
                        p = E.load(pid)
                        r = E.export(p, opts, prog)
                        E.update(pid, lambda x: E.add_log(x, "auto", f"Exporté {r['file']} · {r['size_px']} · {r['fps']} fps · {r['codec']} ({r['duration']:.1f} s)."))
                        return r
                    return self.send_json(run_job(j, work))
                if action == "reveal":
                    name = Path(self.body_json().get("file", "")).name
                    path = E.project_dir(pid) / "exports" / name
                    if sys.platform == "darwin" and path.exists():
                        subprocess.Popen(["open", "-R", str(path)])
                    elif os.name == "nt" and path.exists():
                        subprocess.Popen(["explorer", "/select,", str(path)])
                    return self.send_json({"ok": True, "path": str(path)})
            self.send_json({"error": "ruta no encontrada"}, 404)
        except Exception as ex:
            traceback.print_exc()
            self.send_json({"error": str(ex)}, 500)

    def do_PUT(self):
        parts = [unquote(x) for x in urlparse(self.path).path.strip("/").split("/") if x]
        try:
            if parts[:2] == ["api", "projects"] and len(parts) == 3:
                body = self.body_json()
                cur = E.load(parts[2])
                base = int(body.get("rev", -1))
                for k in ("words", "settings", "style", "name"):
                    if k in body:
                        cur[k] = body[k]
                try:
                    saved = E.save(cur, base_rev=base)
                except E.Conflict as c:
                    return self.send_json({"conflict": True, "current": c.current}, 409)
                return self.send_json({"rev": saved["rev"], "outDuration": E.output_duration(saved)})
            self.send_json({"error": "ruta no encontrada"}, 404)
        except Exception as ex:
            traceback.print_exc()
            self.send_json({"error": str(ex)}, 500)

    def do_DELETE(self):
        parts = [unquote(x) for x in urlparse(self.path).path.strip("/").split("/") if x]
        if parts[:2] == ["api", "projects"] and len(parts) == 3:
            E.delete_project(parts[2])
            return self.send_json({"ok": True})
        self.send_json({"error": "ruta no encontrada"}, 404)

    def upload(self, q):
        name = (q.get("name") or ["Mi reel"])[0][:80]
        filename = (q.get("filename") or ["video.mp4"])[0]
        ext = Path(filename).suffix.lower() or ".mp4"
        if ext not in (".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"):
            return self.send_json({"error": "Formato no soportado. Usa MP4 o MOV."}, 400)
        n = int(self.headers.get("Content-Length") or 0)
        p, dest = E.create_project(name, ext)
        with open(dest, "wb") as f:
            left = n
            while left > 0:
                chunk = self.rfile.read(min(1 << 20, left))
                if not chunk:
                    break
                f.write(chunk)
                left -= len(chunk)
        return self.send_json(after_import(p))


def after_import(p: dict) -> dict:
    """Analiza el archivo recién copiado y arranca la transcripción."""
    pid = p["id"]
    try:
        info = E.probe(E.project_dir(pid) / p["source"])
    except Exception as ex:
        E.delete_project(pid)
        raise RuntimeError(f"No pude leer el video: {ex}")
    def fn(q):
        q.update(info)
        q["status"] = "en cola"
        if info["width"] > info["height"] * 1.05:
            q["settings"]["format"] = "horizontal"
    p = E.update(pid, fn)
    threading.Thread(target=lambda: E.make_previews(p), daemon=True).start()
    if not info.get("hasAudio"):
        E.update(pid, lambda q: q.update(status="listo"))
        return {"project": E.load(pid), "job": None}
    j = start_transcription(pid)
    return {"project": E.load(pid), "job": j}


def list_exports(pid: str):
    d = E.project_dir(pid) / "exports"
    if not d.exists():
        return []
    files = sorted(d.iterdir(), key=lambda x: -x.stat().st_mtime)
    return [{"name": f.name, "size": f.stat().st_size, "time": f.stat().st_mtime} for f in files if f.is_file()]


def restart():
    """Reinicia el servidor con el código nuevo (mismo proceso, mismo puerto)."""
    os.chdir(str(E.APP_DIR))
    os.execv(sys.executable, [sys.executable, "server.py"])


def engine_name():
    try:
        import mlx_whisper  # noqa
        return "mlx"
    except Exception:
        try:
            import faster_whisper  # noqa
            return "faster-whisper"
        except Exception:
            return None


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    srv.daemon_threads = True
    url = f"http://localhost:{PORT}"
    print(f"Reel Studio listo en {url}  (proyectos en {E.PROJECTS_DIR})", flush=True)
    if "--open" in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
