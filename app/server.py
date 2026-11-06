"""Reel Studio — servidor local. Abre http://localhost:8765"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import engine as E
import updater as U
_UPD = {"t": 0.0, "r": None}

PORT = int(os.environ.get("REEL_PORT", "8765"))
STATIC = E.APP_DIR / "static"
JOBS: dict[str, dict] = {}
HEAVY = threading.Lock()     # transcripción y análisis pesados, uno a la vez


def new_job(kind: str, pid: str, label: str = "") -> dict:
    j = {"id": uuid.uuid4().hex[:10], "kind": kind, "project": pid, "label": label, "status": "running",
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


# ---------------------------------------------------------------- trabajos de clips

def process_clip(pid: str, cid: str):
    """Analiza un clip recién subido, prepara miniaturas y lo transcribe."""
    p = E.load(pid)
    c = E.clip_by_id(p, cid)
    try:
        info = E.probe(E.clip_path(p, c))
    except Exception as ex:
        E.update(pid, lambda q: E.remove_clip(q, cid))
        raise RuntimeError(f"No pude leer «{c['name']}»: {ex}")
    if not info.get("hasVideo"):
        E.update(pid, lambda q: E.remove_clip(q, cid))
        raise RuntimeError(f"«{c['name']}» no tiene imagen. Para música usa el apartado Audio.")

    def fn(q):
        cc = E.clip_by_id(q, cid)
        cc.update(info)
        cc["status"] = "en cola"
        if not q["timeline"] and not q["broll"] and len(q["clips"]) == 1 and info["width"] > info["height"] * 1.05:
            q["settings"]["format"] = "horizontal"
        q["timeline"].append({"clip": cid, "in": 0.0, "out": round(info["duration"], 3)})
    E.update(pid, fn)
    j = new_job("transcribe", pid, c["name"])

    def work(prog):
        prog(0.01, f"Preparando «{c['name']}»…")
        q1 = E.load(pid)
        E.make_clip_media(q1, E.clip_by_id(q1, cid))
        with HEAVY:
            E.update(pid, lambda q: E.clip_by_id(q, cid).update(status="transcribiendo", job=j["id"]))
            q0 = E.load(pid)
            c0 = E.clip_by_id(q0, cid)
            words, eng = ([], None)
            if c0.get("hasAudio"):
                prog(0.02, f"Transcribiendo «{c0['name']}»…")
                words, eng = E.transcribe_file(E.clip_path(q0, c0), c0["duration"], prog)
            speech = E.looks_like_speech(words, c0["duration"])
            prog(0.98, "Midiendo color…")
            stats = E.clip_stats(E.clip_path(q0, c0))

            def apply(q):
                cc = E.clip_by_id(q, cid)
                if not cc:
                    return
                q["words"] = [w for w in q["words"] if w.get("clip") != cid]
                for w in words:
                    w["clip"] = cid
                q["words"] += words
                E.renumber(q)
                cc.update(status="listo" if speech else "sin voz", speech=speech, engine=eng, job=None, stats=stats)
                E.autoclean(q)
                st = q.get("autoStats", {})
                if speech:
                    E.add_log(q, "auto", f"«{cc['name']}»: {len(words)} palabras; marqué {st.get('muletilla', 0)} "
                                         f"muletillas y {st.get('toma repetida', 0)} palabras de tomas repetidas.")
                else:
                    E.add_log(q, "auto", f"«{cc['name']}» no tiene voz: lo traté como toma de imagen.")
            E.update(pid, apply)
            return {"words": len(words), "speech": speech}

    def safe(prog):
        try:
            return work(prog)
        except Exception:
            E.update(pid, lambda q: (E.clip_by_id(q, cid) or {}).update(status="sin voz", speech=False, job=None))
            raise
    return run_job(j, safe)


def receive(handler, dest: Path):
    n = int(handler.headers.get("Content-Length") or 0)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with open(dest, "wb") as f:
        left = n
        while left > 0:
            chunk = handler.rfile.read(min(1 << 20, left))
            if not chunk:
                break
            f.write(chunk)
            left -= len(chunk)


class H(BaseHTTPRequestHandler):
    server_version = "ReelStudio/2.0"

    def log_message(self, fmt, *args):
        if os.environ.get("REEL_DEBUG"):
            super().log_message(fmt, *args)

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
        if path.suffix.lower() in (".otf", ".ttf"):
            ctype = "font/" + path.suffix[1:].lower()
        rng = self.headers.get("Range")
        start, end, code = 0, size - 1, 200
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
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    def parts(self):
        u = urlparse(self.path)
        return [unquote(x) for x in u.path.strip("/").split("/") if x], parse_qs(u.query)

    # ------------------------------------------------------------ GET
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parts, q = self.parts()
        try:
            if not parts:
                return self.send_file(STATIC / "index.html")
            if parts[0] == "static" and len(parts) == 2:
                return self.send_file(STATIC / Path(parts[1]).name)
            if parts[0] == "fonts" and len(parts) == 2:
                return self.send_file(E.FONTS_DIR / Path(parts[1]).name, cache=True)
            if parts[0] == "brand" and len(parts) == 3:
                return self.send_file(E.brand_dir(parts[1]) / Path(parts[2]).name)
            if parts[0] == "media" and len(parts) >= 3:
                return self.media(parts, q)
            if parts[:2] == ["api", "update"]:
                now = time.time()
                if now - _UPD["t"] > 50 or "force" in q:
                    _UPD.update(t=now, r=U.check())
                return self.send_json(_UPD["r"])
            if parts[:2] == ["api", "health"]:
                return self.send_json({"ok": True, "ffmpeg": E.FFMPEG, "engine": engine_name(), "version": 2})
            if parts[:2] == ["api", "meta"]:
                looks = {k: {"label": v["label"], "css": v["css"]} for k, v in E.LOOKS.items()}
                return self.send_json({"presets": E.PRESETS, "fonts": E.FONTS, "defaults": E.DEFAULT_SETTINGS,
                                       "formats": E.FORMATS, "looks": looks, "transitions": list(E.TRANSITIONS),
                                       "fontEm": E.FONT_EM, "home": str(E.HOME), "engine": engine_name()})
            if parts[:2] == ["api", "brands"]:
                return self.send_json(E.list_brands())
            if parts[:2] == ["api", "projects"] and len(parts) == 2:
                return self.send_json(E.list_projects())
            if parts[:2] == ["api", "projects"] and len(parts) == 3:
                p = E.load(parts[2])
                p["exports"] = list_exports(parts[2])
                p["plan"] = E.plan(p)
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

    def media(self, parts, q):
        pid = parts[1]
        d = E.project_dir(pid)
        kind = parts[2]
        if kind == "clip" and len(parts) == 4:
            p = E.load(pid)
            c = E.clip_by_id(p, parts[3])
            if not c:
                return self.send_json({"error": "no existe"}, 404)
            proxy = d / "media" / f"{c['id']}_proxy.mp4"
            return self.send_file(proxy if proxy.exists() else E.clip_path(p, c))
        if kind == "source":   # compatibilidad v1
            p = E.load(pid)
            c = p["clips"][0]
            return self.send_file(E.clip_path(p, c))
        if kind in ("music", "reference") and len(parts) == 3:
            p = E.load(pid)
            f = p["settings"]["music"].get("file") if kind == "music" else (p.get("reference") or {}).get("file")
            return self.send_file(d / f) if f else self.send_json({"error": "no hay"}, 404)
        if kind == "file" and len(parts) == 4:
            return self.send_file(d / "media" / Path(parts[3]).name)
        if kind == "card" and len(parts) == 4:
            p = E.load(pid)
            out = d / "media" / f"card_{parts[3]}.jpg"
            E.render_card(p, "intro" if parts[3] == "intro" else "outro", E.geometry(p["settings"]["format"], 540), out)
            return self.send_file(out)
        if kind == "export" and len(parts) == 4:
            name = Path(parts[3]).name
            return self.send_file(d / "exports" / name, download_name=name if "dl" in q else None)
        return self.send_json({"error": "no existe"}, 404)

    # ------------------------------------------------------------ POST
    def do_POST(self):
        parts, q = self.parts()
        try:
            if parts == ["api", "shutdown"]:
                self.send_json({"ok": True})
                threading.Timer(0.2, lambda: os._exit(0)).start()
                return
            if parts == ["api", "update"]:
                if any(j["status"] == "running" and j["kind"] in ("export", "preview") for j in JOBS.values()):
                    return self.send_json({"error": "Espera a que termine la exportación."}, 409)
                r = U.apply(log=lambda m: None)
                self.send_json(r)
                if r.get("updated"):
                    threading.Timer(0.5, restart).start()
                return
            if parts == ["api", "projects"]:
                name = (q.get("name") or [""])[0] or self.body_json().get("name") or "Proyecto nuevo"
                p = E.create_project(name[:80])
                if "filename" in q:   # compatibilidad: subir y crear en un paso
                    c, dest = E.new_clip(p["id"], q["filename"][0])
                    receive(self, dest)
                    j = process_clip(p["id"], c["id"])
                    return self.send_json({"project": E.load(p["id"]), "job": j})
                return self.send_json({"project": p})
            if parts == ["api", "import"]:
                b = self.body_json()
                src = Path(os.path.expanduser(b.get("path", "")))
                if not src.is_file():
                    return self.send_json({"error": f"No encuentro el archivo {src}"}, 400)
                pid = b.get("project") or E.create_project(b.get("name") or src.stem)["id"]
                c, dest = E.new_clip(pid, src.name)
                shutil.copyfile(src, dest)
                j = process_clip(pid, c["id"])
                return self.send_json({"project": E.load(pid), "job": j})
            if parts == ["api", "brands"]:
                return self.send_json(E.save_brand(self.body_json()))
            if parts[:2] == ["api", "brands"] and len(parts) == 4:
                return self.brand_upload(parts[2], parts[3], q)
            if parts[:2] == ["api", "projects"] and len(parts) >= 4:
                return self.project_action(parts[2], parts[3], parts[4:], q)
            self.send_json({"error": "ruta no encontrada"}, 404)
        except Exception as ex:
            traceback.print_exc()
            self.send_json({"error": str(ex)}, 500)

    def brand_upload(self, bid, what, q):
        kit = E.load_brand(bid)
        if not kit:
            return self.send_json({"error": "marca no existe"}, 404)
        fn = (q.get("filename") or ["archivo"])[0]
        ext = Path(fn).suffix.lower()
        d = E.brand_dir(bid)
        if what == "logo":
            if ext not in (".png", ".jpg", ".jpeg", ".webp", ".svg"):
                return self.send_json({"error": "El logo debe ser PNG (mejor con fondo transparente) o JPG."}, 400)
            tmp = d / f"logo-subida{ext}"
            receive(self, tmp)
            from PIL import Image
            Image.open(tmp).convert("RGBA").save(d / "logo.png")
            tmp.unlink()
            kit["logo"] = "logo.png"
        elif what == "font":
            if ext not in (".ttf", ".otf"):
                return self.send_json({"error": "La letra debe ser un archivo .ttf u .otf."}, 400)
            for old in d.glob("letra.*"):
                old.unlink()
            dest = d / f"letra{ext}"
            receive(self, dest)
            kit["fontFile"] = dest.name
            kit["fontName"] = Path(fn).stem
            kit["fontEm"] = E.brand_font_em(dest)
        else:
            return self.send_json({"error": "no existe"}, 404)
        return self.send_json(E.save_brand(kit))

    def project_action(self, pid, action, rest, q):
        if action == "clips" and not rest:
            fn = (q.get("filename") or ["video.mp4"])[0]
            if Path(fn).suffix.lower() not in E.VIDEO_EXT:
                return self.send_json({"error": "Formato no soportado. Usa MP4, MOV o similar."}, 400)
            c, dest = E.new_clip(pid, fn)
            receive(self, dest)
            j = process_clip(pid, c["id"])
            return self.send_json({"clip": c, "job": j})
        if action == "music":
            fn = (q.get("filename") or ["musica.mp3"])[0]
            ext = Path(fn).suffix.lower()
            if ext not in E.AUDIO_EXT + E.VIDEO_EXT:
                return self.send_json({"error": "Usa un archivo de audio (MP3, WAV, M4A)."}, 400)
            d = E.project_dir(pid)
            for old in d.glob("musica.*"):
                old.unlink()
            dest = d / f"musica{ext}"
            receive(self, dest)
            j = new_job("music", pid, "música")

            def work(prog):
                with HEAVY:
                    prog(0.2, "Escuchando el ritmo…")
                    a = E.analyze_audio_beats(dest)
                    subprocess.run([E.FFMPEG, "-v", "error", "-y", "-i", str(dest), "-filter_complex",
                                    "aformat=channel_layouts=mono,showwavespic=s=2400x90:colors=#0A84FF|#0A84FF:scale=sqrt",
                                    "-frames:v", "1", str(d / "media" / "music_wave.png")], capture_output=True)

                    def ap(p):
                        m = p["settings"]["music"]
                        m.update(file=dest.name, name=Path(fn).stem, tempo=a["tempo"], beats=a["beats"],
                                 duration=a["duration"])
                        E.add_log(p, "auto", f"Música «{m['name']}»: {a['tempo']:.0f} BPM.")
                    E.update(pid, ap)
                    return a
            return self.send_json(run_job(j, work))
        if action == "reference":
            fn = (q.get("filename") or ["referencia.mp4"])[0]
            ext = Path(fn).suffix.lower()
            if ext not in E.VIDEO_EXT:
                return self.send_json({"error": "La referencia debe ser un video."}, 400)
            d = E.project_dir(pid)
            for old in d.glob("referencia.*"):
                old.unlink()
            dest = d / f"referencia{ext}"
            receive(self, dest)
            E.update(pid, lambda p: p.update(reference={"file": dest.name, "name": Path(fn).stem, "analysis": None}))
            j = new_job("reference", pid, "referencia")

            def work(prog):
                with HEAVY:
                    a = E.analyze_reference(E.load(pid), prog)

                    def ap(p):
                        p["reference"]["analysis"] = a
                        E.add_log(p, "auto", f"Referencia analizada: {a['shots']} tomas de {a['avgShot']:.1f} s, "
                                             f"look {E.LOOKS[a['look']]['label'].lower()}.")
                    E.update(pid, ap)
                    return a
            return self.send_json(run_job(j, work))
        if action == "apply-reference":
            def fn(p):
                done = E.apply_reference(p)
                E.add_log(p, "auto", "Apliqué el estilo de la referencia: " + ", ".join(done) + ".")
            return self.send_json(E.update(pid, fn))
        if action == "assemble":
            def fn(p):
                E.add_log(p, "auto", E.auto_assemble(p))
            return self.send_json(E.update(pid, fn))
        if action == "match-color":
            j = new_job("match", pid, "color")

            def work(prog):
                with HEAVY:
                    p = E.load(pid)
                    n = E.match_clips_color(p, prog)
                    stats = {c["id"]: (c.get("stats"), c.get("adjust")) for c in p["clips"]}

                    def ap(q2):
                        for c in q2["clips"]:
                            if c["id"] in stats:
                                c["stats"], c["adjust"] = stats[c["id"]][0], stats[c["id"]][1] or {}
                        E.add_log(q2, "auto", f"Igualé el color de {n} clips.")
                    E.update(pid, ap)
                    return {"clips": n}
            return self.send_json(run_job(j, work))
        if action == "autoclean":
            def fn(p):
                E.autoclean(p)
                st = p.get("autoStats", {})
                E.add_log(p, "auto", f"Limpieza automática: {st.get('muletilla', 0)} muletillas, "
                                     f"{st.get('repetición', 0)} repeticiones, {st.get('toma repetida', 0)} "
                                     f"palabras de tomas repetidas.")
            return self.send_json(E.update(pid, fn))
        if action == "transcribe" and rest:
            return self.send_json(process_clip(pid, rest[0]))
        if action in ("export", "preview"):
            opts = self.body_json()
            if action == "preview":
                opts["preview"] = True
                for j0 in JOBS.values():
                    if j0["project"] == pid and j0["kind"] == "preview" and j0["status"] == "running":
                        return self.send_json(j0)
            j = new_job(action, pid)

            def work(prog):
                r = E.render(E.load(pid), opts, prog)
                if action == "export":
                    E.update(pid, lambda x: E.add_log(x, "auto", f"Exporté {r['file']} · {r['size_px']} · {r['fps']} fps "
                                                                 f"· {r['codec']} ({r['duration']:.1f} s)."))
                return r
            return self.send_json(run_job(j, work))
        if action == "requests":
            body = self.body_json()
            text = (body.get("text") or "").strip()
            if body.get("kind") == "referencia":
                text = "[Armar con la referencia] " + text
            if not text:
                return self.send_json({"error": "Escribe el pedido."}, 400)

            def fn(p):
                p["requests"].append({"id": uuid.uuid4().hex[:6], "text": text[:2000], "status": "pendiente",
                                      "t": time.time(), "note": ""})
            return self.send_json(E.update(pid, fn))
        if action == "reveal":
            name = Path(self.body_json().get("file", "")).name
            path = E.project_dir(pid) / "exports" / name
            if sys.platform == "darwin" and path.exists():
                subprocess.Popen(["open", "-R", str(path)])
            elif os.name == "nt" and path.exists():
                subprocess.Popen(["explorer", "/select,", str(path)])
            return self.send_json({"ok": True, "path": str(path)})
        return self.send_json({"error": "ruta no encontrada"}, 404)

    # ------------------------------------------------------------ PUT / DELETE
    def do_PUT(self):
        parts, _ = self.parts()
        try:
            if parts[:2] == ["api", "projects"] and len(parts) == 3:
                body = self.body_json()
                cur = E.load(parts[2])
                base = int(body.get("rev", -1))
                for k in ("words", "settings", "style", "name", "timeline", "broll", "requests", "reference"):
                    if k in body:
                        cur[k] = body[k]
                if "clips" in body:   # solo campos editables de cada clip
                    edits = {c["id"]: c for c in body["clips"]}
                    for c in cur["clips"]:
                        e = edits.get(c["id"])
                        if e:
                            for k in ("name", "adjust", "gain", "fit", "cropX", "cropY", "speech", "muted"):
                                if k in e:
                                    c[k] = e[k]
                try:
                    saved = E.save(cur, base_rev=base)
                except E.Conflict as c:
                    return self.send_json({"conflict": True, "current": c.current}, 409)
                return self.send_json({"rev": saved["rev"]})
            if parts[:2] == ["api", "brands"] and len(parts) == 3:
                kit = self.body_json()
                kit["id"] = parts[2]
                return self.send_json(E.save_brand(kit))
            self.send_json({"error": "ruta no encontrada"}, 404)
        except Exception as ex:
            traceback.print_exc()
            self.send_json({"error": str(ex)}, 500)

    def do_DELETE(self):
        parts, _ = self.parts()
        try:
            if parts[:2] == ["api", "projects"] and len(parts) == 3:
                E.delete_project(parts[2])
                return self.send_json({"ok": True})
            if parts[:2] == ["api", "projects"] and len(parts) == 5 and parts[3] == "clips":
                return self.send_json(E.update(parts[2], lambda p: E.remove_clip(p, parts[4])))
            if parts[:2] == ["api", "projects"] and len(parts) == 4 and parts[3] in ("music", "reference"):
                def fn(p):
                    if parts[3] == "music":
                        p["settings"]["music"].update(file="", name="", beats=[], tempo=0, beatSync=False)
                    else:
                        p["reference"] = None
                return self.send_json(E.update(parts[2], fn))
            if parts[:2] == ["api", "brands"] and len(parts) == 3:
                E.delete_brand(parts[2])
                return self.send_json({"ok": True})
            self.send_json({"error": "ruta no encontrada"}, 404)
        except Exception as ex:
            traceback.print_exc()
            self.send_json({"error": str(ex)}, 500)


def list_exports(pid: str):
    d = E.project_dir(pid) / "exports"
    if not d.exists():
        return []
    files = sorted(d.iterdir(), key=lambda x: -x.stat().st_mtime)
    return [{"name": f.name, "size": f.stat().st_size, "time": f.stat().st_mtime}
            for f in files if f.is_file() and ".tmp" not in f.name]


def restart():
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
