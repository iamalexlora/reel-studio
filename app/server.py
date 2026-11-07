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

READY = ("listo", "sin voz", "sin transcribir")


def process_clip(pid: str, cid: str, transcribe=None):
    """Analiza un clip recién subido, prepara miniaturas y (si se pide) lo transcribe."""
    p = E.load(pid)
    if transcribe is None:
        transcribe = bool(p["settings"].get("autoTranscribe", False))
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
        if not any(i.get("clip") == cid for i in q["timeline"]) and not any(b.get("clip") == cid for b in q["broll"]):
            q["timeline"].append({"clip": cid, "in": 0.0, "out": round(info["duration"], 3)})
    E.update(pid, fn)
    j = new_job("transcribe", pid, c["name"])

    def work(prog):
        prog(0.01, f"Preparando «{c['name']}»…")
        q1 = E.load(pid)
        if not E.clip_by_id(q1, cid).get("strip") or not transcribe:
            E.make_clip_media(q1, E.clip_by_id(q1, cid))
        if not transcribe:
            stats = E.clip_stats(E.clip_path(q1, E.clip_by_id(q1, cid)))
            E.update(pid, lambda q: E.clip_by_id(q, cid).update(status="sin transcribir", job=None, stats=stats))
            return {"words": 0, "speech": None}
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


def start_music(pid: str, dest: Path, name: str) -> dict:
    d = E.project_dir(pid)
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
                m.update(file=dest.name, name=name, tempo=a["tempo"], beats=a["beats"], duration=a["duration"])
                E.add_log(p, "auto", f"Música «{m['name']}»: {a['tempo']:.0f} BPM.")
            E.update(pid, ap)
            return a
    return run_job(j, work)


def start_voice(pid: str, dest: Path, name: str) -> dict:
    """Narración (voz en off): se transcribe para los subtítulos y el video dura lo que ella."""
    j = new_job("voice", pid, "narración")

    def work(prog):
        info = E.probe(dest)
        dur = float(info.get("duration") or 0)
        E.update(pid, lambda p: p["settings"].update(voice={"file": dest.name, "name": name, "duration": round(dur, 3), "gain": 0, "status": "transcribiendo"}))
        try:
            with HEAVY:
                prog(0.05, "Transcribiendo la narración…")
                words, _ = E.transcribe_file(dest, dur, prog)
        except Exception:
            words = []  # sin transcripción igual sirve: el video se arma sobre la voz, solo sin subtítulos

        def ap(p):
            p["words"] = [w for w in p["words"] if w.get("clip") != "voz"]
            for w in words:
                w["clip"] = "voz"
            p["words"] += words
            E.renumber(p)
            p["settings"]["voice"]["status"] = "listo"
            E.add_log(p, "auto", f"Narración «{name}»: {dur:.1f} s, {len(words)} palabras.")
        E.update(pid, ap)
        return {"words": len(words), "duration": dur}
    return run_job(j, work)


def start_reference(pid: str, dest: Path, name: str) -> dict:
    E.update(pid, lambda p: p.update(reference={"file": dest.name, "name": name, "analysis": None,
                                                "prompt": (p.get("reference") or {}).get("prompt", "")}))
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
    return run_job(j, work)


# ---------------------------------------------------------------- enlaces (yt-dlp)
def import_link(pid: str, url: str, as_: str) -> dict:
    """Baja un video o audio desde un enlace (Instagram, TikTok, YouTube…) y lo trata como si lo hubieras arrastrado."""
    j = new_job("link", pid, "enlace")

    def work(prog):
        try:
            import yt_dlp
        except ImportError:
            raise RuntimeError("Falta el componente para bajar enlaces. Actualiza Reel Studio y vuelve a intentar.")
        d = E.project_dir(pid)
        tmp = d / "work" / "descargas" / uuid.uuid4().hex[:8]
        tmp.mkdir(parents=True, exist_ok=True)
        info_box = {}

        def hook(h):
            if h.get("status") == "downloading":
                tot = h.get("total_bytes") or h.get("total_bytes_estimate") or 0
                if tot:
                    prog(0.05 + 0.85 * h.get("downloaded_bytes", 0) / tot,
                         f"Bajando… {h.get('downloaded_bytes', 0) // (1 << 20)} de {tot // (1 << 20)} MB")
        audio = as_ == "musica"
        opts = {"outtmpl": str(tmp / "%(title).80B.%(ext)s"), "noplaylist": True, "quiet": True, "no_warnings": True,
                "progress_hooks": [hook], "ffmpeg_location": str(Path(E.FFMPEG).parent) if os.sep in E.FFMPEG else None,
                "format": ("bestaudio/best" if audio else
                           "bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b"),
                "merge_output_format": None if audio else "mp4"}
        opts = {k: v for k, v in opts.items() if v is not None}
        prog(0.02, "Leyendo el enlace…")
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            info_box["title"] = info.get("title") or "video"
        files = sorted([f for f in tmp.iterdir() if f.is_file() and not f.name.endswith((".part", ".ytdl"))],
                       key=lambda f: f.stat().st_size, reverse=True)
        if not files:
            raise RuntimeError("No pude bajar nada de ese enlace.")
        f = files[0]
        title = info_box["title"][:60]
        prog(0.95, "Agregando al proyecto…")
        if as_ == "musica":
            for old in d.glob("musica.*"):
                old.unlink()
            dest = d / f"musica{f.suffix.lower()}"
            shutil.move(str(f), dest)
            sub = start_music(pid, dest, title)
        elif as_ == "referencia":
            for old in d.glob("referencia.*"):
                old.unlink()
            dest = d / f"referencia{f.suffix.lower()}"
            shutil.move(str(f), dest)
            sub = start_reference(pid, dest, title)
        else:
            c, dest = E.new_clip(pid, E.slug(title)[:40] + f.suffix.lower())
            shutil.move(str(f), dest)
            sub = process_clip(pid, c["id"])
        shutil.rmtree(tmp, ignore_errors=True)
        return {"title": title, "as": as_, "job": sub["id"]}
    return run_job(j, work)


# ---------------------------------------------------------------- animaciones
def install_anims() -> dict:
    import anims as A
    for j0 in JOBS.values():
        if j0["kind"] == "anim-install" and j0["status"] == "running":
            return j0
    j = new_job("anim-install", "", "animaciones")
    return run_job(j, lambda prog: A.install(prog))


# ---------------------------------------------------------------- «Hacer mi video»
VIBES = {
    "dinamico":    {"label": "Dinámico", "preset": "impacto", "look": "vivo", "trans": "zoom", "tdur": 0.3, "pace": 1.8},
    "viral":       {"label": "Viral", "preset": "titular", "look": "vivo", "trans": "corte", "tdur": 0.3, "pace": 1.3},
    "energetico":  {"label": "Energético", "preset": "impacto", "look": "vivo", "trans": "barrido", "tdur": 0.25, "pace": 1.2},
    "elegante":    {"label": "Elegante", "preset": "limpio", "look": "cine", "trans": "disolver", "tdur": 0.5, "pace": 2.8},
    "cinematico":  {"label": "Cinemático", "preset": "limpio", "look": "mate", "trans": "negro", "tdur": 0.6, "pace": 3.2},
    "corporativo": {"label": "Corporativo", "preset": "limpio", "look": "natural", "trans": "disolver", "tdur": 0.4, "pace": 3.0},
    "calido":      {"label": "Cálido", "preset": "limpio", "look": "calido", "trans": "disolver", "tdur": 0.45, "pace": 2.6},
    "vintage":     {"label": "Vintage", "preset": "titular", "look": "vintage", "trans": "difuminar", "tdur": 0.5, "pace": 2.4},
    "bn":          {"label": "Blanco y negro", "preset": "titular", "look": "bn", "trans": "negro", "tdur": 0.5, "pace": 2.6},
    "natural":     {"label": "Natural", "preset": "limpio", "look": "natural", "trans": "corte", "tdur": 0.3, "pace": 2.5},
}


def make_video(pid: str, o: dict) -> dict:
    """Un solo botón: limpia, arma, iguala color, pone estilo, subtítulos, animaciones y deja la vista previa."""
    import anims as A
    j = new_job("make", pid, "Hacer mi video")

    import pedido as PD
    pr = PD.parse(o.get("prompt") or "")
    o.update(pr["make"])  # lo que pidió por escrito manda sobre las opciones marcadas

    def work(prog):
        prog(0.02, "Esperando que terminen de procesarse tus clips…")
        if o.get("videoAudio") is False:  # sin el audio de los videos no hay nada que transcribir ni limpiar
            o["clean"] = False
        need_t = o.get("videoAudio") is not False and bool(o.get("subtitles", True) or o.get("clean", True))
        if need_t:
            for _ in range(600):  # que primero terminen de prepararse, luego transcribir lo pendiente
                q = E.load(pid)
                if not any(c.get("status") == "en cola" and not c.get("job") for c in q["clips"]):
                    break
                time.sleep(0.5)
            for c in E.load(pid)["clips"]:
                if c.get("status") == "sin transcribir":
                    process_clip(pid, c["id"], True)
        for _ in range(1800):
            p = E.load(pid)
            busy = [c for c in p["clips"] if c.get("status") not in (("listo", "sin voz") if need_t else READY)]
            if (p["settings"].get("voice") or {}).get("status") == "transcribiendo":
                busy = busy or [{"voz": 1}]
            ref = p.get("reference") or {}
            if any(j0["kind"] in ("music", "voice") and j0["project"] == pid and j0["status"] == "running"
                   for j0 in JOBS.values()):
                busy = busy or [{"musica": 1}]
            if ref.get("file") and not ref.get("analysis") and any(
                    j0["kind"] == "reference" and j0["project"] == pid and j0["status"] == "running" for j0 in JOBS.values()):
                busy = busy or [ref]
            if not busy:
                break
            prog(0.02, f"Procesando clips ({len(p['clips']) - len(busy)} de {len(p['clips'])} listos)…")
            time.sleep(1)
        p = E.load(pid)
        if not p["clips"]:
            raise RuntimeError("Primero agrega tus videos.")
        vibe = VIBES.get(o.get("style"), VIBES["dinamico"])

        def setup(q):
            st = q["settings"]
            if o.get("format") in E.FORMATS:
                st["format"] = o["format"]
            q["guide"] = False
            st["pace"] = vibe["pace"]
            if o.get("videoAudio") is not None:
                for cc in q["clips"]:
                    cc["muted"] = not o.get("videoAudio")
            if o.get("maxDur") is not None:
                st["maxDur"] = max(0, int(o.get("maxDur") or 0))
            st["subtitles"] = bool(o.get("subtitles", True))
            st["removeSilences"] = bool(o.get("clean", True))
            st["transition"] = {"type": vibe["trans"], "dur": vibe["tdur"]}
            st["vibe"] = o.get("style") if o.get("style") in VIBES else "dinamico"
            st["grade"]["look"] = vibe["look"]
            if o.get("brand") is not None:
                st["brand"] = o.get("brand") or ""
            keep = {k: q["style"].get(k) for k in ("font",) if (E.load_brand(st.get("brand", "")) or {}).get("fontFile")}
            q["style"] = E.default_style(vibe["preset"])
            q["style"].update({k: v for k, v in keep.items() if v})
            if pr["order"]:
                st["clipOrder"] = pr["order"]
                E.sort_clips(q, pr["order"])
            PD.apply(q, pr, vibe["pace"])
            if pr["transition"] and pr["transition"] != "variado":
                st["transition"]["type"] = pr["transition"]
            q["madeNotes"] = {"prompt": (o.get("prompt") or "").strip(), "understood": pr["understood"]}
            if o.get("clean", True):
                E.autoclean(q)
            msg = E.auto_assemble(q)
            vz = q["settings"].get("voice") or {}
            if vz.get("file") and vz.get("duration"):
                # con narración: todos los videos en montaje, repetidos si hace falta, hasta cubrir la voz
                ready = [c for c in q["clips"] if c.get("hasVideo", True) and c.get("status") in READY]
                tl, tot, k = [], 0.0, 0
                while ready and tot < vz["duration"] + 1.5 + len(tl) * vibe["tdur"] and k < 300:
                    c = ready[k % len(ready)]
                    rnd = k // len(ready)
                    seg = min(c["duration"], max(1.5, float(st.get("pace", vibe["pace"])) * 1.2))
                    a0 = round((rnd * seg) % max(0.01, c["duration"] - seg), 2)
                    tl.append({"clip": c["id"], "in": a0, "out": round(min(c["duration"], a0 + seg), 2)})
                    tot += seg; k += 1
                q["timeline"], q["broll"] = tl, []
                msg = f"Armé {len(tl)} tomas sobre tu narración de {vz['duration']:.0f} s."
            else:
                # montaje (sin nadie hablando): se llena hasta la duración elegida o lo que dura la música
                ready = [c for c in q["clips"] if c.get("hasVideo", True) and c.get("status") in READY]
                talking = any(c.get("speech") and not c.get("muted") for c in ready)
                mus = st.get("music") or {}
                target = float(st.get("maxDur") or 0)
                if not target and mus.get("file") and mus.get("duration"):
                    target = min(180.0, float(mus["duration"]))
                if ready and not talking and target > 0:
                    pace = float(st.get("pace", vibe["pace"]))
                    step = max(0.6, pace - (0.3 if st["transition"]["type"] != "corte" else 0.1))
                    tl, tot, k = [], 0.0, 0
                    while tot < target * 1.35 + 2 and k < 800:
                        c = ready[k % len(ready)]
                        rnd = k // len(ready)
                        seg = min(c["duration"], max(2.0, pace * 1.6))
                        room = max(0.01, c["duration"] - seg)
                        a0 = round(((rnd * 0.618) % 1.0) * room, 2)  # cada vuelta, otra parte del video
                        tl.append({"clip": c["id"], "in": a0, "out": round(min(c["duration"], a0 + seg), 2)})
                        tot += min(seg, step); k += 1
                    q["timeline"], q["broll"] = tl, []
                    while len(q["timeline"]) > 2 and E.plan(q)["total"] > target + pace:  # sobra: se quitan las últimas
                        q["timeline"].pop()
                    msg = f"Armé {len(q['timeline'])} tomas para {int(target // 60)}:{int(target % 60):02d}."
            if (st.get("music") or {}).get("file") and (st.get("music") or {}).get("beats"):
                st["music"]["beatSync"] = True
            if not pr["transition"] or pr["transition"] == "variado":
                E.vary_transitions(q, o.get("style") or "dinamico", vibe["tdur"])
            else:
                for it0 in q["timeline"]:
                    it0.pop("transition", None)
            E.add_log(q, "auto", f"Hacer mi video ({vibe['label']}): {msg}")
        prog(0.08, "Limpiando y armando…")
        E.update(pid, setup)
        if len([c for c in p["clips"] if c.get("hasVideo", True)]) > 1:
            prog(0.12, "Igualando el color entre clips…")
            with HEAVY:
                q = E.load(pid)
                n = E.match_clips_color(q, lambda f, m="": prog(0.12 + 0.08 * f, "Igualando el color…"))
                stats = {c["id"]: (c.get("stats"), c.get("adjust")) for c in q["clips"]}

                def ap(q2):
                    for c in q2["clips"]:
                        if c["id"] in stats:
                            c["stats"], c["adjust"] = stats[c["id"]][0], stats[c["id"]][1] or {}
                E.update(pid, ap)
        if o.get("anims", True):
            prog(0.22, "Proponiendo animaciones…")

            def an(q):
                pl = E.plan(q)
                q["anims"] = A.auto_anims(q, pl, title=(o.get("title") or "").strip(),
                                          cta=(o.get("cta") or "").strip(), highlight=bool(o.get("highlight", True)))
            E.update(pid, an)
            if not A.status()["ready"]:
                A.install(lambda f, m="": prog(0.25 + 0.25 * f, "Activando animaciones (solo la primera vez)… " + m))
        else:
            E.update(pid, lambda q: q.update(anims=[]))
        prog(0.5, "Haciendo la vista previa…")
        r = E.render(E.load(pid), {"preview": True}, lambda f, m="": prog(0.5 + 0.5 * f, m))
        return {"preview": r, "style": vibe["label"]}
    return run_job(j, work)


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
            if parts[:2] == ["api", "anims"]:
                import anims as A
                return self.send_json({**A.status(), "kinds": A.KINDS, "vibes": {k: v["label"] for k, v in VIBES.items()}})
            if parts[0] == "anim" and len(parts) == 4:
                return self.anim_page(parts[1], parts[2], parts[3], q)
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
                                       "fontEm": E.FONT_EM, "home": str(E.HOME), "engine": engine_name(),
                                       "exportsRoot": str(E.exports_root())})
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

    def anim_page(self, pid, aid, name, q):
        import anims as A
        folder = E.project_dir(pid) / "work" / "anim-preview" / Path(aid).name
        if name == "index.html":
            p = E.load(pid)
            a = next((x for x in (p.get("anims") or []) if x.get("id") == aid), None)
            if not a:
                return self.send_json({"error": "no existe"}, 404)
            kit = E.load_brand(p["settings"].get("brand", "")) or {}
            A.write_page(p, a, E.geometry(p["settings"].get("format", "vertical"), 1080), kit, folder)
        return self.send_file(folder / Path(name).name)

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
        if kind == "voice" and len(parts) == 3:
            f = (E.load(pid)["settings"].get("voice") or {}).get("file")
            return self.send_file(d / f) if f else self.send_json({"error": "no hay"}, 404)
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
            f = E.find_export(E.load(pid), name) or (d / "exports" / Path(name).name)
            return self.send_file(f, download_name=Path(name).name if "dl" in q else None)
        return self.send_json({"error": "no existe"}, 404)

    # ------------------------------------------------------------ POST
    def do_POST(self):
        parts, q = self.parts()
        try:
            if parts == ["api", "shutdown"]:
                self.send_json({"ok": True})
                threading.Timer(0.2, lambda: os._exit(0)).start()
                return
            if parts == ["api", "anims", "install"]:
                return self.send_json(install_anims())
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
            return self.send_json(start_music(pid, dest, Path(fn).stem))
        if action == "voice":
            fn = (q.get("filename") or ["narracion.m4a"])[0]
            ext = Path(fn).suffix.lower()
            if ext not in E.AUDIO_EXT + E.VIDEO_EXT:
                return self.send_json({"error": "Usa un archivo de audio (MP3, WAV, M4A)."}, 400)
            d = E.project_dir(pid)
            for old in d.glob("narracion.*"):
                old.unlink()
            dest = d / f"narracion{ext}"
            receive(self, dest)
            return self.send_json(start_voice(pid, dest, Path(fn).stem))
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
            return self.send_json(start_reference(pid, dest, Path(fn).stem))
        if action == "vary":
            def vf(p):
                st = p["settings"]
                if st.get("music", {}).get("file") and st["music"].get("beats"):
                    st["music"]["beatSync"] = True
                E.vary_transitions(p, st.get("vibe") or "dinamico", float(st["transition"].get("dur", 0.4)))
            return self.send_json(E.update(pid, vf))
        if action == "sort":
            mode = self.body_json().get("mode", "num-asc")
            return self.send_json(E.update(pid, lambda p: E.sort_clips(p, mode)))
        if action == "link":
            b = self.body_json()
            url = (b.get("url") or "").strip()
            if not re.match(r"^https?://", url):
                return self.send_json({"error": "Pega un enlace que empiece con https://"}, 400)
            return self.send_json(import_link(pid, url, b.get("as") or "clip"))
        if action == "make":
            for j0 in JOBS.values():
                if j0["project"] == pid and j0["kind"] == "make" and j0["status"] == "running":
                    return self.send_json(j0)
            return self.send_json(make_video(pid, self.body_json()))
        if action == "anims" and rest == ["auto"]:
            import anims as A
            b = self.body_json()

            def fn(p):
                p["anims"] = A.auto_anims(p, E.plan(p), title=b.get("title", ""), cta=b.get("cta", ""),
                                          highlight=b.get("highlight", True))
                E.add_log(p, "auto", f"Propuse {len(p['anims'])} animaciones.")
            return self.send_json(E.update(pid, fn))
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
            if rest[0] == "todos":
                p = E.load(pid)
                js = [process_clip(pid, c["id"], True) for c in p["clips"] if c.get("status") == "sin transcribir"]
                return self.send_json({"jobs": [j0["id"] for j0 in js]})
            return self.send_json(process_clip(pid, rest[0], True))
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

            import pedido as PD
            for_make = body.get("forMake")

            def fn(p):
                if for_make:  # lo aplica «Hacer mi video» ahora mismo
                    got = PD.parse(text)["understood"]
                    for r0 in p["requests"]:  # el mismo pedido que había quedado pendiente antes
                        if r0.get("status") == "pendiente" and r0.get("text", "").endswith(text.strip()):
                            r0["status"] = "hecho"; r0["note"] = "Aplicado con «Hacer mi video»."
                else:
                    got = PD.apply_now(p, text)
                    if got:
                        E.add_log(p, "auto", "Pedido aplicado: " + ", ".join(got) + ".")
                p["requests"].append({"id": uuid.uuid4().hex[:6], "text": text, "t": time.time(),
                                      "status": "hecho" if got else "pendiente",
                                      "note": ("Aplicado: " + ", ".join(got) + ".") if got else
                                      "No reconocí una instrucción concreta; queda para revisarlo con Claude en el chat."})
            return self.send_json(E.update(pid, fn))
        if action == "reveal":
            name = Path(self.body_json().get("file", "")).name
            path = E.find_export(E.load(pid), name) or (E.project_dir(pid) / "exports" / name)
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
                for k in ("words", "settings", "style", "name", "timeline", "broll", "requests", "reference", "anims", "guide"):
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
            if parts[:2] == ["api", "projects"] and len(parts) == 4 and parts[3] in ("music", "reference", "voice"):
                def fn(p):
                    if parts[3] == "voice":
                        p["settings"]["voice"] = {}
                        p["words"] = [w for w in p["words"] if w.get("clip") != "voz"]
                    elif parts[3] == "music":
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
    files, seen = [], set()
    for d in E.export_dirs(E.load(pid)):
        if d.exists():
            for f in d.iterdir():
                if f.is_file() and ".tmp" not in f.name and f.name not in seen and not f.name.startswith("."):
                    seen.add(f.name)
                    files.append(f)
    files.sort(key=lambda x: -x.stat().st_mtime)
    return [{"name": f.name, "size": f.stat().st_size, "time": f.stat().st_mtime, "folder": str(f.parent)}
            for f in files]


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
