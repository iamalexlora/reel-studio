"""Reel Studio — motor de edición (v2, multiclip).

Un proyecto tiene varios clips. Los clips "principales" forman la secuencia (con su voz),
los de "apoyo" (b-roll) se superponen encima. Encima de todo: color, transiciones, música,
línea gráfica (logo, intro, cierre) y subtítulos. Lo usan la interfaz (server.py) y la
línea de comandos de Claude (reel.py), así que las dos vías editan el mismo proyecto.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import threading
import time
import unicodedata
import uuid
from pathlib import Path

IS_WIN = os.name == "nt"
if IS_WIN:  # en Windows, que ffmpeg no abra ventanas negras de consola
    _Popen = subprocess.Popen

    class _QuietPopen(_Popen):
        def __init__(self, *a, **k):
            k.setdefault("creationflags", 0x08000000)  # CREATE_NO_WINDOW
            super().__init__(*a, **k)
    subprocess.Popen = _QuietPopen

APP_DIR = Path(__file__).resolve().parent
FONTS_DIR = APP_DIR / "fonts"
HOME = Path(os.environ.get("REEL_HOME", Path.home() / "ReelStudio"))
PROJECTS_DIR = HOME / "proyectos"
BRANDS_DIR = HOME / "marcas"
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
BRANDS_DIR.mkdir(parents=True, exist_ok=True)

FPS_DEFAULT = 30
VIDEO_EXT = (".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mts", ".mxf")
AUDIO_EXT = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".aif", ".aiff")

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock(pid: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(pid, threading.Lock())


# ---------------------------------------------------------------- herramientas

def which(name: str) -> str | None:
    exe = name + (".exe" if IS_WIN else "")
    bundled = APP_DIR.parent / "runtime" / "ffmpeg" / "bin" / exe
    if bundled.exists():          # Windows: ffmpeg viene dentro del instalador
        return str(bundled)
    p = shutil.which(name)
    if p:
        return p
    for d in ("/opt/homebrew/bin", "/usr/local/bin"):
        c = Path(d) / name
        if c.exists():
            return str(c)
    return None


FFMPEG = which("ffmpeg") or "ffmpeg"
FFPROBE = which("ffprobe") or "ffprobe"
_cache: dict = {}


def ffmpeg_major() -> int:
    if "major" not in _cache:
        try:
            out = subprocess.run([FFMPEG, "-version"], capture_output=True, text=True).stdout
            if re.search(r"ffmpeg version N-", out):
                _cache["major"] = 99
            else:
                m = re.search(r"ffmpeg version n?(\d+)", out)
                _cache["major"] = int(m.group(1)) if m else 6
        except Exception:
            _cache["major"] = 6
    return _cache["major"]


def _list(kind: str) -> str:
    if kind not in _cache:
        try:
            _cache[kind] = subprocess.run([FFMPEG, "-hide_banner", f"-{kind}"], capture_output=True, text=True).stdout
        except Exception:
            _cache[kind] = ""
    return _cache[kind]


def has_filter(name: str) -> bool:
    return f" {name} " in _list("filters")


def has_encoder(name: str) -> bool:
    return f" {name} " in _list("encoders")


def has_filter(name: str) -> bool:
    return f" {name} " in _list("filters")


def hdr_to_sdr(c: dict) -> str:
    """HDR (HLG/PQ del iPhone) a SDR con mapeo de tonos real; sin esto los colores salen lavados o pasados."""
    trc = (c.get("color") or {}).get("transfer") or "arib-std-b67"
    tin = "smpte2084" if trc == "smpte2084" else "arib-std-b67"
    if has_filter("zscale") and has_filter("tonemap"):
        return (f"zscale=tin={tin}:pin=bt2020:min=bt2020nc:t=linear:npl=203,format=gbrpf32le,"
                "zscale=p=bt709,tonemap=mobius:param=0.35:desat=0,"
                "zscale=t=bt709:m=bt709:r=tv,format=yuv420p")
    return "colorspace=all=bt709:iall=bt2020:fast=1:format=yuv420p"


def graph_args(gfile: Path) -> list[str]:
    return ["-/filter_complex", str(gfile)] if ffmpeg_major() >= 7 else ["-filter_complex_script", str(gfile)]


def run_ffmpeg(cmd: list[str], total: float = 0, progress=None, base=0.0, span=1.0, msg="Renderizando…"):
    """Corre ffmpeg leyendo su progreso. Lanza RuntimeError con el final del log si falla."""
    pre = [FFMPEG, "-hide_banner", "-y"]
    if progress and total > 0:
        pre += ["-progress", "pipe:1", "-nostats"]
    proc = subprocess.Popen(pre + cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            encoding="utf-8", errors="replace")
    tail: list[str] = []

    def read_err():
        for line in proc.stderr:
            tail.append(line)
            del tail[:-40]
    t = threading.Thread(target=read_err, daemon=True)
    t.start()
    for line in proc.stdout:
        if progress and total > 0 and (line.startswith("out_time_us=") or line.startswith("out_time_ms=")):
            try:
                us = int(line.split("=")[1])
                progress(base + span * min(1.0, us / 1e6 / total), msg)
            except ValueError:
                pass
    proc.wait()
    t.join(timeout=2)
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg falló:\n" + "".join(tail[-14:]))


# ---------------------------------------------------------------- estilos

PRESETS = {
    "impacto": {
        "label": "Impacto",
        "desc": "Mayúsculas gruesas, la palabra que suena se ilumina y crece.",
        "font": "Poppins Black", "size": 120, "uppercase": True,
        "color": "#FFFFFF", "highlight": "#FFE14D", "outline": "#000000",
        "outlineWidth": 7, "box": False, "boxColor": "#000000",
        "position": "abajo", "maxWords": 3, "mode": "resaltar",
    },
    "limpio": {
        "label": "Limpio",
        "desc": "Frase corta sobre una caja oscura; lo que aún no se dice va tenue.",
        "font": "Poppins", "size": 84, "uppercase": False,
        "color": "#FFFFFF", "highlight": "#FFFFFF", "outline": "#000000",
        "outlineWidth": 0, "box": True, "boxColor": "#111111",
        "position": "abajo", "maxWords": 6, "mode": "progresivo",
    },
    "titular": {
        "label": "Titular",
        "desc": "Una o dos palabras gigantes que entran con un golpe, al centro.",
        "font": "Anton", "size": 170, "uppercase": True,
        "color": "#FFFFFF", "highlight": "#FF5A36", "outline": "#000000",
        "outlineWidth": 6, "box": False, "boxColor": "#000000",
        "position": "centro", "maxWords": 2, "mode": "golpe",
    },
}
FONTS = ["Poppins Black", "Poppins ExtraBold", "Poppins", "Anton", "Bebas Neue"]

# Looks de color: filtros de ffmpeg (SDR) y su aproximación CSS para la vista previa en vivo.
LOOKS = {
    "natural": {"label": "Natural", "ff": "", "css": ""},
    "vivo": {"label": "Vivo", "ff": "vibrance=intensity=0.12,eq=contrast=1.04:saturation=1.05",
             "css": "saturate(1.1) contrast(1.04)"},
    "calido": {"label": "Cálido", "ff": "colortemperature=temperature=5600:mix=0.5,eq=saturation=1.06",
               "css": "sepia(.1) saturate(1.05) hue-rotate(-4deg)"},
    "frio": {"label": "Frío", "ff": "colortemperature=temperature=7600:mix=0.5,eq=contrast=1.04",
             "css": "saturate(.95) hue-rotate(10deg) brightness(1.02)"},
    "cine": {"label": "Cine", "ff": "colorbalance=rs=-0.07:bs=0.09:rh=0.08:gh=0.02:bh=-0.08,"
                                     "eq=contrast=1.08:saturation=1.04:gamma=0.97,vignette=angle=0.45",
             "css": "contrast(1.1) saturate(1.05) sepia(.12) hue-rotate(-4deg)"},
    "mate": {"label": "Mate", "ff": "curves=all='0/0.07 0.5/0.5 1/0.94',eq=saturation=0.9",
             "css": "contrast(.88) brightness(1.04) saturate(.9)"},
    "vintage": {"label": "Vintage", "ff": "curves=preset=vintage,eq=saturation=0.88,noise=alls=6:allf=t",
                "css": "sepia(.35) contrast(.95) saturate(.85)"},
    "bn": {"label": "Blanco y negro", "ff": "hue=s=0,eq=contrast=1.15", "css": "grayscale(1) contrast(1.15)"},
}

TRANSITIONS = {   # nombre en español → xfade
    "corte": None, "disolver": "fade", "negro": "fadeblack", "blanco": "fadewhite",
    "barrido": "slideleft", "zoom": "zoomin", "difuminar": "hblur",
}

DEFAULT_SETTINGS = {
    "removeSilences": True,
    "maxPause": 0.30,
    "padding": 0.06,
    "subtitles": True,
    "format": "vertical",
    "fit": "llenar",
    "cropX": 0.5,
    "cropY": 0.5,
    "pace": 2.5,               # segundos por toma de apoyo / montaje
    "transition": {"type": "corte", "dur": 0.4},
    "grade": {"look": "natural", "exposure": 0, "contrast": 0, "saturation": 0,
              "temperature": 0, "tint": 0, "vignette": 0},
    "music": {"file": "", "name": "", "volume": 0.35, "duck": True, "fadeIn": 1.0, "fadeOut": 2.0,
              "start": 0.0, "beatSync": False, "tempo": 0, "beats": [], "duration": 0},
    "brand": "",
    "maxDur": 0,
    "autoTranscribe": False,
    "clipOrder": "num-asc",
    "logo": {"on": False, "pos": "arriba-derecha", "size": 0.14, "opacity": 0.9},
    "intro": {"on": False, "text": "", "dur": 2.0},
    "outro": {"on": False, "text": "", "dur": 2.5},
}

FORMATS = {
    "vertical":   {"label": "Vertical 9:16", "w": 1080, "h": 1920},
    "horizontal": {"label": "Horizontal 16:9", "w": 1920, "h": 1080},
    "4:5":        {"label": "Feed 4:5", "w": 1080, "h": 1350},
    "5:4":        {"label": "Feed horizontal 5:4", "w": 1350, "h": 1080},
    "cuadrado":   {"label": "Cuadrado 1:1", "w": 1080, "h": 1080},
}
RESOLUTIONS = {"720": 720, "1080": 1080, "1440": 1440, "2160": 2160}


def even(x: float) -> int:
    return max(2, int(round(x / 2)) * 2)


def geometry(fmt: str, res: int = 1080) -> dict:
    """Tamaño de salida y zonas seguras. 'k' escala todo a partir de 1080 de lado corto."""
    f = FORMATS.get(fmt, FORMATS["vertical"])
    m = res / 1080
    W, H = even(f["w"] * m), even(f["h"] * m)
    k = min(W, H) / 1080
    tall = H > W * 1.05
    return {"W": W, "H": H, "k": k,
            "bottom": H * (0.224 if tall else 0.085), "top": H * (0.156 if tall else 0.08),
            "maxw": W - 2 * 90 * k if (tall or abs(W - H) < 2) else W * 0.72}


def default_style(preset: str = "impacto") -> dict:
    s = dict(PRESETS.get(preset, PRESETS["impacto"]))
    s["preset"] = preset
    s.pop("label", None)
    s.pop("desc", None)
    return s


def _deep_defaults(cur: dict, defaults: dict) -> dict:
    out = json.loads(json.dumps(defaults))
    for k, v in (cur or {}).items():
        out[k] = _deep_defaults(v, defaults[k]) if isinstance(v, dict) and isinstance(defaults.get(k), dict) else v
    return out


# ---------------------------------------------------------------- proyectos

def project_dir(pid: str) -> Path:
    if not re.fullmatch(r"[a-z0-9\-]{4,64}", pid or ""):
        raise ValueError("id de proyecto inválido")
    return PROJECTS_DIR / pid


def migrate(p: dict) -> dict:
    """Proyectos de la v1 (un solo video) pasan a tener un clip."""
    if "clips" not in p:
        src = p.get("source", "source.mp4")
        c = {"id": "c1", "file": src, "name": p.get("name", "Video"),
             "status": "listo" if p.get("status") == "listo" else p.get("status", "listo")}
        for k in ("duration", "width", "height", "fps", "hasAudio", "vcodec", "pixfmt", "color", "hdr", "engine"):
            if k in p:
                c[k] = p[k]
        c["hasVideo"] = True
        c["speech"] = bool(p.get("words"))
        p["clips"] = [c]
        p["timeline"] = [{"clip": "c1", "in": 0.0, "out": float(p.get("duration") or 0)}]
        for w in p.get("words", []):
            w["clip"] = "c1"
    p.setdefault("timeline", [])
    p.setdefault("broll", [])
    p.setdefault("requests", [])
    p.setdefault("reference", None)
    p.setdefault("anims", [])
    p.setdefault("words", [])
    p.setdefault("log", [])
    p.setdefault("style", default_style())
    return p


def load(pid: str) -> dict:
    with open(project_dir(pid) / "project.json", encoding="utf-8") as f:
        p = json.load(f)
    p = migrate(p)
    p["settings"] = _deep_defaults(p.get("settings"), DEFAULT_SETTINGS)
    p["status"] = project_status(p)
    return p


def project_status(p: dict) -> str:
    st = [c.get("status") for c in p.get("clips", [])]
    if not st:
        return "vacío"
    if any(s in ("transcribiendo", "en cola", "subiendo") for s in st):
        return "transcribiendo"
    return "listo"


class Conflict(Exception):
    def __init__(self, current):
        super().__init__("conflict")
        self.current = current


def _write(p: dict):
    path = project_dir(p["id"]) / "project.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(p, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def save(p: dict, base_rev: int | None = None) -> dict:
    with _lock(p["id"]):
        cur = load(p["id"])
        if base_rev is not None and cur.get("rev", 0) != base_rev:
            raise Conflict(cur)
        p["rev"] = int(cur.get("rev", 0)) + 1
        p["updated"] = time.time()
        p["status"] = project_status(p)
        _write(p)
        return p


def update(pid: str, fn) -> dict:
    with _lock(pid):
        p = load(pid)
        fn(p)
        p["rev"] = int(p.get("rev", 0)) + 1
        p["updated"] = time.time()
        p["status"] = project_status(p)
        _write(p)
        return p


def list_projects() -> list[dict]:
    out = []
    for d in PROJECTS_DIR.iterdir():
        if (d / "project.json").exists():
            try:
                p = load(d.name)
                out.append({"id": p["id"], "name": p["name"], "created": p.get("created", 0),
                            "updated": p.get("updated", 0), "status": p["status"], "clips": len(p["clips"]),
                            "outDuration": round(plan(p)["total"], 1),
                            "thumb": p["clips"][0]["id"] if p["clips"] else None})
            except Exception:
                pass
    return sorted(out, key=lambda x: -x["updated"])


def slug(text: str) -> str:
    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    t = re.sub(r"[^a-zA-Z0-9]+", "-", t).strip("-").lower()
    return t[:30] or "video"


def exports_root() -> Path:
    """Carpeta donde salen los videos: ~/Movies/Reel Studio (Películas en la Mac) o ~/Videos/Reel Studio en Windows."""
    if os.environ.get("REEL_EXPORTS"):
        return Path(os.environ["REEL_EXPORTS"])
    if os.environ.get("REEL_HOME"):
        return HOME / "exportados"
    return Path.home() / ("Videos" if IS_WIN else "Movies") / "Reel Studio"


def export_dirs(p: dict) -> list[Path]:
    """[carpeta actual del proyecto, carpetas anteriores…]. La primera es donde se guardan las exportaciones nuevas."""
    safe = re.sub(r'[\\/:*?"<>|]+', " ", p.get("name") or "Proyecto").strip(" .") or "Proyecto"
    out = [exports_root() / safe[:80]]
    for f in p.get("exportFolders", []):
        if Path(f) not in out:
            out.append(Path(f))
    out.append(project_dir(p["id"]) / "exports")
    return out


def find_export(p: dict, name: str) -> Path | None:
    for d in export_dirs(p):
        f = d / Path(name).name
        if f.is_file():
            return f
    return None


def create_project(name: str) -> dict:
    pid = f"{slug(name)}-{uuid.uuid4().hex[:6]}"
    d = project_dir(pid)
    for sub in ("clips", "exports", "work", "media"):
        (d / sub).mkdir(parents=True, exist_ok=True)
    p = {"id": pid, "name": name, "created": time.time(), "updated": time.time(), "rev": 0,
         "clips": [], "timeline": [], "broll": [], "words": [], "requests": [], "reference": None, "anims": [], "guide": True,
         "settings": json.loads(json.dumps(DEFAULT_SETTINGS)), "style": default_style(), "log": []}
    _write(p)
    return p


def delete_project(pid: str):
    shutil.rmtree(project_dir(pid), ignore_errors=True)


def add_log(p: dict, who: str, text: str):
    p.setdefault("log", []).append({"t": time.time(), "who": who, "text": text})
    p["log"] = p["log"][-80:]


def clip_by_id(p: dict, cid: str) -> dict | None:
    return next((c for c in p["clips"] if c["id"] == cid), None)


def clip_path(p: dict, c: dict) -> Path:
    return project_dir(p["id"]) / c["file"]


def new_clip(pid: str, filename: str) -> tuple[dict, Path]:
    """Reserva un clip nuevo; devuelve (clip, ruta donde copiar el archivo)."""
    ext = Path(filename).suffix.lower() or ".mp4"
    holder = {}

    def fn(p):
        n = 1
        ids = {c["id"] for c in p["clips"]}
        while f"c{n}" in ids:
            n += 1
        c = {"id": f"c{n}", "file": f"clips/c{n}{ext}", "name": Path(filename).stem[:60] or f"Clip {n}",
             "status": "subiendo"}
        p["clips"].append(c)
        if p["settings"].get("clipOrder", "num-asc") in ("num-asc", "num-desc", "az", "za"):
            sort_clips(p, p["settings"].get("clipOrder", "num-asc"))
        holder["c"] = c
    update(pid, fn)
    (project_dir(pid) / "clips").mkdir(exist_ok=True)
    return holder["c"], project_dir(pid) / holder["c"]["file"]


def remove_clip(p: dict, cid: str):
    c = clip_by_id(p, cid)
    if not c:
        return
    p["clips"] = [x for x in p["clips"] if x["id"] != cid]
    p["timeline"] = [t for t in p["timeline"] if t["clip"] != cid]
    p["broll"] = [b for b in p["broll"] if b["clip"] != cid]
    p["words"] = [w for w in p["words"] if w.get("clip") != cid]
    renumber(p)
    try:
        (project_dir(p["id"]) / c["file"]).unlink()
    except Exception:
        pass


def _natural(name: str):
    """IMG_1522 < IMG_1523 < IMG_10000: compara los números como números, no como texto."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name or "")]


def sort_clips(p: dict, mode: str = "num-asc") -> None:
    """Ordena los videos subidos (y la línea de tiempo) por número o por letra."""
    if mode not in ("num-asc", "num-desc", "az", "za"):
        return
    if mode.startswith("num"):
        nums = lambda c: [x for x in _natural(c.get("name", "")) if isinstance(x, int)]  # noqa: E731
        con = sorted([c for c in p["clips"] if nums(c)], key=lambda c: (nums(c), _natural(c.get("name", ""))),
                     reverse=(mode == "num-desc"))
        p["clips"] = con + [c for c in p["clips"] if not nums(c)]  # los que no tienen número van al final
    else:
        p["clips"].sort(key=lambda c: (c.get("name", "") or "").lower(), reverse=(mode == "za"))
    order = {c["id"]: i for i, c in enumerate(p["clips"])}
    p["timeline"].sort(key=lambda t: order.get(t.get("clip"), 999))
    p["settings"]["clipOrder"] = mode
    renumber(p)


def renumber(p: dict):
    order = {c["id"]: i for i, c in enumerate(p["clips"])}
    p["words"].sort(key=lambda w: (order.get(w.get("clip"), 999), w["start"]))
    for i, w in enumerate(p["words"]):
        w["id"] = i


# ---------------------------------------------------------------- medios

def probe(path: Path) -> dict:
    out = subprocess.run([FFPROBE, "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
                         capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    v = next((s for s in j["streams"] if s["codec_type"] == "video" and
              not (s.get("disposition") or {}).get("attached_pic")), None)
    a = next((s for s in j["streams"] if s["codec_type"] == "audio"), None)
    dur = float(j["format"].get("duration") or (v or a or {}).get("duration") or 0)
    if not v:
        return {"duration": dur, "hasAudio": a is not None, "hasVideo": False}
    w, h = int(v["width"]), int(v["height"])
    rot = 0
    try:
        rot = int(v.get("tags", {}).get("rotate", 0))
    except Exception:
        pass
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(float(sd["rotation"]))
    if abs(rot) % 180 == 90:
        w, h = h, w
    fps = 30.0
    try:
        n, d = v.get("avg_frame_rate", "30/1").split("/")
        fps = float(n) / float(d) if float(d) else 30.0
    except Exception:
        pass
    trc = v.get("color_transfer", "") or ""
    return {"width": w, "height": h, "fps": round(fps, 3), "duration": dur, "hasAudio": a is not None,
            "hasVideo": True, "vcodec": v.get("codec_name", ""), "pixfmt": v.get("pix_fmt", ""),
            "color": {"transfer": trc, "primaries": v.get("color_primaries", "") or "",
                      "space": v.get("color_space", "") or ""},
            "hdr": trc in ("arib-std-b67", "smpte2084")}


BROWSER_OK = {"h264", "hevc", "vp9", "av1", "vp8"}


def needs_proxy(c: dict) -> bool:
    return c.get("vcodec") not in BROWSER_OK or ("10" in c.get("pixfmt", "") and c.get("vcodec") == "h264")


def make_clip_media(p: dict, c: dict):
    """Tira de fotogramas, miniatura, forma de onda y, si hace falta, copia para la vista previa."""
    d = project_dir(p["id"]) / "media"
    d.mkdir(exist_ok=True)
    src = clip_path(p, c)
    dur = max(c.get("duration", 1), 0.1)
    n = 24
    for args in (
        ["-i", str(src), "-vf", f"fps={n / dur:.5f},scale=-2:120,crop='min(iw,96)':120,tile={n}x1",
         "-frames:v", "1", "-q:v", "5", str(d / f"{c['id']}_strip.jpg")],
        ["-ss", f"{min(1.0, dur / 3):.2f}", "-i", str(src), "-frames:v", "1", "-vf", "scale=-2:360",
         "-q:v", "4", str(d / f"{c['id']}_thumb.jpg")],
    ):
        subprocess.run([FFMPEG, "-v", "error", "-y"] + args, capture_output=True)
    if c.get("hasAudio"):
        subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(src), "-filter_complex",
                        "aformat=channel_layouts=mono,showwavespic=s=1600x100:colors=#9A9AA0|#9A9AA0:scale=sqrt",
                        "-frames:v", "1", str(d / f"{c['id']}_wave.png")], capture_output=True)
    if needs_proxy(c):
        tmp, out = d / f"{c['id']}_proxy.tmp.mp4", d / f"{c['id']}_proxy.mp4"
        enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19"] if has_encoder("libx264") \
            else ["-c:v", "h264_videotoolbox", "-b:v", "14M"]
        r = subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(src), "-vf", "scale=-2:'min(ih,1920)'", *enc,
                            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
                            str(tmp)], capture_output=True)
        if r.returncode == 0:
            os.replace(tmp, out)


def clip_stats(path: Path) -> dict:
    """Brillo, saturación, contraste y temperatura promedio (1 fotograma por segundo)."""
    r = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", str(path), "-an", "-vf",
                        "fps=1,scale=160:-2,format=yuv420p,signalstats,metadata=print", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    vals: dict[str, list[float]] = {}
    for k, v in re.findall(r"lavfi\.signalstats\.(YAVG|SATAVG|UAVG|VAVG|YLOW|YHIGH)=([\d.]+)", r.stderr):
        vals.setdefault(k, []).append(float(v))
    if not vals.get("YAVG"):
        return {}
    avg = {k: sum(v) / len(v) for k, v in vals.items()}
    return {"y": round(avg["YAVG"], 1), "sat": round(avg.get("SATAVG", 0), 1),
            "warm": round(avg.get("VAVG", 128) - avg.get("UAVG", 128), 1),
            "contrast": round(avg.get("YHIGH", 235) - avg.get("YLOW", 16), 1)}


# ---------------------------------------------------------------- transcripción

INITIAL_PROMPT = ("Eh, bueno, mmm... este, o sea, a ver. Hola, ¿qué tal? "
                  "Transcribe todo tal cual, con muletillas y repeticiones.")


def _nvidia_dll_dirs():
    import site
    out = []
    for sp in site.getsitepackages() + [site.getusersitepackages()]:
        base = Path(sp) / "nvidia"
        if base.exists():
            out += [x for x in base.glob("*/bin") if x.is_dir()]
    return out


def gpu_ready(progress=lambda f, msg="": None) -> bool:
    """Windows/Linux con tarjeta NVIDIA: prepara CUDA la primera vez. En Mac no aplica."""
    if os.environ.get("REEL_NO_GPU"):
        return False
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() < 1:
            return False
    except Exception:
        return False
    if IS_WIN and not _nvidia_dll_dirs():
        marker = HOME / "logs" / "gpu-intento.txt"
        if marker.exists():
            return False
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("1")
        progress(0.02, "Activando tu tarjeta NVIDIA (solo la primera vez, ≈1 GB)…")
        import sys
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--no-warn-script-location",
                        "nvidia-cublas-cu12", "nvidia-cudnn-cu12==9.*"], capture_output=True)
    if IS_WIN:
        for d in _nvidia_dll_dirs():
            try:
                os.add_dll_directory(str(d))
                os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")
            except Exception:
                pass
    return True


def transcribe_file(path: Path, duration: float, progress=lambda f, msg="": None,
                    language="es") -> tuple[list, str]:
    work = path.parent.parent / "work"
    work.mkdir(exist_ok=True)
    wav = work / f"audio-{uuid.uuid4().hex[:6]}.wav"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000",
                    "-c:a", "pcm_s16le", str(wav)], check=True, capture_output=True)
    dur = max(duration, 1)
    words: list[dict] = []
    try:
        import mlx_whisper  # Apple Silicon
        engine_used = "mlx"
        model = os.environ.get("REEL_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
        progress(0.05, "Transcribiendo con el chip de tu Mac…")
        res = mlx_whisper.transcribe(str(wav), path_or_hf_repo=model, language=language,
                                     word_timestamps=True, initial_prompt=INITIAL_PROMPT,
                                     condition_on_previous_text=False, verbose=None)
        for seg in res.get("segments", []):
            for w in seg.get("words", []) or []:
                words.append({"text": w["word"], "start": float(w["start"]), "end": float(w["end"]),
                              "prob": float(w.get("probability", 1))})
    except ImportError:
        from faster_whisper import WhisperModel
        engine_used = "faster-whisper"
        model = os.environ.get("REEL_WHISPER_MODEL", "large-v3-turbo")
        progress(0.03, "Cargando modelo de voz (la primera vez se descarga, ≈1,6 GB)…")
        m = None
        if gpu_ready(progress):
            try:
                m = WhisperModel(model, device="cuda", compute_type="float16")
                engine_used = "faster-whisper-cuda"
            except Exception:
                m = None
        if m is None:
            m = WhisperModel(model, device="cpu", compute_type="int8")
        progress(0.06, "Transcribiendo…")
        import wave
        import numpy as np
        with wave.open(str(wav), "rb") as wf:
            audio = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        segs, _info = m.transcribe(audio, language=language, word_timestamps=True,
                                   initial_prompt=INITIAL_PROMPT, condition_on_previous_text=False,
                                   vad_filter=False)
        for seg in segs:
            for w in seg.words or []:
                words.append({"text": w.word, "start": float(w.start), "end": float(w.end),
                              "prob": float(w.probability)})
            progress(min(0.97, seg.end / dur), "Transcribiendo…")
    try:
        wav.unlink()
    except Exception:
        pass
    out = []
    for w in words:
        t = w["text"].strip()
        if not t:
            continue
        e = max(w["end"], w["start"] + 0.04)
        out.append({"text": t, "orig": t, "start": round(w["start"], 3), "end": round(e, 3),
                    "prob": round(w["prob"], 3), "cut": False, "reason": "", "by": "", "suggest": ""})
    out = drop_hallucinations(out)
    for a, b in zip(out, out[1:]):
        if b["start"] < a["end"]:
            mid = (a["end"] + b["start"]) / 2
            a["end"], b["start"] = round(max(a["start"] + 0.02, mid), 3), round(mid, 3)
    return out, engine_used


HALLUCINATIONS = ["subtitulos por la comunidad de amara", "subtitulos realizados por la comunidad de amara",
                  "gracias por ver el video", "gracias por ver", "suscribete al canal", "amaraorg"]


def drop_hallucinations(words: list) -> list:
    """Frases que Whisper inventa en silencio o ruido (créditos de subtítulos, despedidas)."""
    keep = [True] * len(words)
    n = [norm(w["text"]) for w in words]
    for pat in HALLUCINATIONS:
        pw = pat.split()
        L = len(pw)
        for i in range(len(words) - L + 1):
            if all(n[i + k] == pw[k] for k in range(L)):
                for k in range(L):
                    keep[i + k] = False
                if i + L < len(words) and n[i + L] in ("org", "amaraorg"):
                    keep[i + L] = False
    return [w for w, k in zip(words, keep) if k]


def looks_like_speech(words: list, duration: float) -> bool:
    """Whisper a veces 'escucha' palabras en ruido o música: exige densidad y confianza."""
    if len(words) < 4 or duration <= 0:
        return False
    density = len(words) / duration
    conf = sum(w["prob"] for w in words) / len(words)
    return density >= 1.0 and conf >= 0.5


# ---------------------------------------------------------------- limpieza

FILLERS_SURE = {"eh", "ehh", "ehhh", "ehm", "em", "emm", "mm", "mmm", "mmmm", "hmm", "ah", "ahh",
                "um", "umm", "uh", "mhm", "eeh", "eem", "aah", "ehmm", "mmh"}
FILLERS_MAYBE = {"este", "bueno", "pues", "tipo", "osea", "digamos", "entonces", "nada"}


def norm(t: str) -> str:
    t = unicodedata.normalize("NFKD", t.lower()).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", t)


def phrases(words: list[dict], gap=0.55) -> list[list[int]]:
    out, cur = [], []
    for i, w in enumerate(words):
        if cur:
            prev = words[cur[-1]]
            if (w.get("clip") != prev.get("clip") or w["start"] - prev["end"] > gap
                    or re.search(r"[.?!…]$", prev["text"])):
                out.append(cur)
                cur = []
        cur.append(i)
    if cur:
        out.append(cur)
    return out


def autoclean(p: dict, who="auto") -> dict:
    """Marca muletillas, palabras repetidas y arranques en falso (solo en clips con voz).
    Respeta lo que el usuario o Claude ya decidieron a mano."""
    speech = {c["id"] for c in p["clips"] if c.get("speech")}
    words = p["words"]
    for w in words:
        if w.get("by") == "auto":
            w["cut"], w["reason"], w["by"] = False, "", ""
        w["suggest"] = ""
    stats = {"muletilla": 0, "repetición": 0, "toma repetida": 0}

    def cut(i, reason):
        w = words[i]
        if w.get("by") in ("user", "claude", "keep") or w.get("clip") not in speech:
            return
        if not w["cut"]:
            stats[reason] = stats.get(reason, 0) + 1
        w["cut"], w["reason"], w["by"] = True, reason, "auto"

    n = [norm(w["text"]) for w in words]
    for i, w in enumerate(words):
        same_next = i + 1 < len(words) and words[i + 1].get("clip") == w.get("clip")
        if n[i] in FILLERS_SURE:
            cut(i, "muletilla")
        elif n[i] in FILLERS_MAYBE:
            gap_after = words[i + 1]["start"] - w["end"] if same_next else 1
            gap_before = w["start"] - words[i - 1]["end"] if i and words[i - 1].get("clip") == w.get("clip") else 1
            if re.search(r"[,.…]$", w["text"]) or gap_after > 0.25 or gap_before > 0.25:
                w["suggest"] = "posible muletilla"
        if same_next and n[i] and n[i] == n[i + 1] and len(n[i]) > 1 and words[i + 1]["start"] - w["end"] < 0.8:
            cut(i, "repetición")
    for i in range(len(words) - 1):
        if n[i] == "o" and n[i + 1] == "sea" and words[i].get("clip") == words[i + 1].get("clip"):
            words[i]["suggest"] = words[i + 1]["suggest"] = "posible muletilla"
    ph = phrases(words)
    for k, a in enumerate(ph):
        ka = [n[i] for i in a if n[i] and n[i] not in FILLERS_SURE]
        if len(ka) < 2:
            continue
        for b in ph[k + 1:k + 3]:
            kb = [n[i] for i in b if n[i] and n[i] not in FILLERS_SURE]
            m = min(3, len(ka), len(kb))
            if m >= 2 and ka[:m] == kb[:m] and len(ka) <= len(kb) + 2:
                for i in a:
                    cut(i, "toma repetida")
                break
    p["autoStats"] = stats
    return p


# ---------------------------------------------------------------- secuencia

def item_segments(p: dict, item: dict) -> list[list[float]]:
    """Tramos (en tiempo del clip) que se usan de un elemento de la secuencia principal."""
    c = clip_by_id(p, item["clip"])
    if not c:
        return []
    cin = max(0.0, float(item.get("in", 0)))
    cout = min(float(item.get("out") or c.get("duration", 0)), float(c.get("duration") or 1e9))
    if cout - cin < 0.1:
        return []
    if not c.get("speech"):
        return [[round(cin, 3), round(cout, 3)]]
    st = p["settings"]
    pad = float(st.get("padding", 0.06))
    max_pause = float(st.get("maxPause", 0.3)) if st.get("removeSilences", True) else 1e9
    W = [w for w in p["words"] if w.get("clip") == c["id"] and w["end"] > cin and w["start"] < cout]
    segs: list[list[float]] = []
    prev_kept = None
    for i, w in enumerate(W):
        if w["cut"]:
            continue
        s, e = w["start"] - pad, w["end"] + pad
        if i > 0 and W[i - 1]["cut"]:
            s = max(s, W[i - 1]["end"])
        if i + 1 < len(W) and W[i + 1]["cut"]:
            e = min(e, W[i + 1]["start"])
        s, e = max(cin, s), min(cout, e)
        adjacent = prev_kept is not None and prev_kept == i - 1
        if segs and adjacent and (w["start"] - W[i - 1]["end"]) <= max_pause:
            segs[-1][1] = max(segs[-1][1], e)
        elif segs and s <= segs[-1][1]:
            segs[-1][1] = max(segs[-1][1], e)
        else:
            segs.append([s, e])
        prev_kept = i
    return [[round(a, 3), round(b, 3)] for a, b in segs if b - a > 0.04]


def snap(segs, fps=FPS_DEFAULT):
    out = []
    for a, b in segs:
        a2, b2 = math.floor(a * fps) / fps, math.ceil(b * fps) / fps
        if out and a2 <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b2)
        elif b2 - a2 >= 2 / fps:
            out.append([a2, b2])
    return out


def time_mapper(segs):
    cum, acc = [], 0.0
    for a, b in segs:
        cum.append(acc)
        acc += b - a

    def f(t):
        for (a, b), c in zip(segs, cum):
            if t < a:
                return c
            if t <= b:
                return c + (t - a)
        return acc
    return f, acc


def plan(p: dict, fps: int = FPS_DEFAULT) -> dict:
    """La secuencia final: elementos con sus tramos, dónde empieza cada uno y cuánto dura todo.
    Las transiciones solapan elementos consecutivos (como xfade). La interfaz replica este cálculo."""
    st = p["settings"]
    tr = st.get("transition", {})
    mus = st.get("music", {})
    beats = mus.get("beats") or []
    beat_sync = bool(mus.get("beatSync") and beats and mus.get("file"))
    pace = max(0.6, float(st.get("pace", 2.5)))
    items = []
    if st.get("intro", {}).get("on"):
        items.append({"kind": "card", "card": "intro", "segs": [],
                      "dur": round(float(st["intro"].get("dur", 2.0)) * fps) / fps})
    clock = items[0]["dur"] if items else 0.0
    for ti, it in enumerate(p.get("timeline", [])):
        c = clip_by_id(p, it["clip"])
        if not c or c.get("status") not in ("listo", "sin voz", "sin transcribir") or not c.get("hasVideo", True):
            continue
        segs = item_segments(p, it)
        if not segs:
            continue
        if items:  # la transición solapa: el elemento empieza antes (así los cortes caen en el tiempo)
            t0 = (it.get("transition") or {}).get("type") or tr.get("type", "corte")
            if TRANSITIONS.get(t0):
                clock -= float((it.get("transition") or {}).get("dur") or tr.get("dur", 0.4))
        if not c.get("speech"):
            a, b = segs[0]
            want = b - a if it.get("full") else min(b - a, pace)
            if beat_sync:
                # que el centro de la transición siguiente caiga justo en el tiempo de la música
                nx = p["timeline"][ti + 1] if ti + 1 < len(p["timeline"]) else {}
                t1 = (nx.get("transition") or {}).get("type") or tr.get("type", "corte")
                half = float((nx.get("transition") or {}).get("dur") or tr.get("dur", 0.4)) / 2 if nx and TRANSITIONS.get(t1) else 0
                mt = clock - half - float(mus.get("start", 0))
                cand = [x - mt for x in beats if 0.6 <= x - mt <= b - a]
                if cand:
                    want = min(cand, key=lambda x: abs(x - want))
            segs = [[a, a + want]]
        segs = snap(segs, fps)
        if not segs:
            continue
        dur = round(sum(b - a for a, b in segs), 4)
        items.append({"kind": "clip", "clip": c["id"], "segs": segs, "dur": dur,
                      "speech": bool(c.get("speech")), "trans": it.get("transition"), "ti": ti})
        clock += dur
    if st.get("outro", {}).get("on"):
        items.append({"kind": "card", "card": "outro", "segs": [],
                      "dur": round(float(st["outro"].get("dur", 2.5)) * fps) / fps})
    # Duración máxima elegida por el usuario: recorta los clips (intro y cierre se respetan)
    maxd = float(st.get("maxDur") or 0)
    voz = st.get("voice") or {}
    vdur = float(voz.get("duration") or 0) if voz.get("file") else 0
    if vdur:
        fit = vdur + 0.4 + sum(i["dur"] for i in items if i["kind"] == "card")
        maxd = min(maxd, fit) if maxd > 0 else fit
    if maxd > 0:
        budget = maxd - sum(i["dur"] for i in items if i["kind"] == "card")
        keep = []
        for itm in items:
            if itm["kind"] == "card":
                keep.append(itm)
                continue
            if budget < 0.5:
                continue
            if itm["dur"] > budget:
                left, segs = budget, []
                for a0, b0 in itm["segs"]:
                    take = min(b0 - a0, left)
                    if take > 0.05:
                        segs.append([a0, round(a0 + take, 4)])
                    left -= take
                    if left <= 0:
                        break
                itm = dict(itm, segs=segs, dur=round(sum(b - a for a, b in segs), 4))
            budget -= itm["dur"]
            if any(k["kind"] == "clip" for k in keep):  # la transición solapa: ese tramo no suma duración
                t0 = (itm.get("trans") or {}).get("type") or tr.get("type", "corte")
                if TRANSITIONS.get(t0):
                    budget += min(float((itm.get("trans") or {}).get("dur") or tr.get("dur", 0.4)), itm["dur"] * 0.4)
            keep.append(itm)
        items = keep
    start = 0.0
    for j, itm in enumerate(items):
        d = 0.0
        itm["ttype"] = "corte"
        if j > 0:
            ttype = (itm.get("trans") or {}).get("type") or tr.get("type", "corte")
            if ttype == "corte" and (itm["kind"] == "card" or items[j - 1]["kind"] == "card"):
                ttype = "disolver"
            if TRANSITIONS.get(ttype):
                d = min(float((itm.get("trans") or {}).get("dur") or tr.get("dur", 0.4)),
                        itm["dur"] * 0.4, items[j - 1]["dur"] * 0.4)
                d = round(d * fps) / fps
            if d > 0:
                itm["ttype"] = ttype
            start -= d
        itm["tdur"] = d
        itm["start"] = round(start, 4)
        start += itm["dur"]
    total = max(0.0, start)
    main0 = 0.0
    if items and items[0]["kind"] == "card":
        main0 = items[1]["start"] if len(items) > 1 else items[0]["dur"]
    return {"items": items, "total": round(total, 3), "fps": fps, "mainStart": round(main0, 4), "voiceDur": vdur}


def output_duration(p: dict) -> float:
    try:
        return plan(p)["total"]
    except Exception:
        return 0


def word_mapper(pl: dict):
    """(clip, t0, t1) → (inicio, fin) en el video final, o None si esa parte no sale."""
    maps = []
    for itm in pl["items"]:
        if itm["kind"] == "clip" and itm["speech"]:
            f, _ = time_mapper(itm["segs"])
            maps.append((itm, f))

    voz_dur = pl.get("voiceDur") or 0

    def m(clip, t0, t1):
        if clip == "voz":
            if voz_dur and t0 < voz_dur:
                return pl["mainStart"] + t0, pl["mainStart"] + min(t1, voz_dur)
            return None
        for itm, f in maps:
            if itm["clip"] != clip:
                continue
            s, e = f(t0), f(t1)
            if e - s >= 0.02:
                return itm["start"] + s, itm["start"] + e
        return None
    return m


# ---------------------------------------------------------------- subtítulos

FONT_FILES = {"Poppins Black": "Poppins-Black.ttf", "Poppins ExtraBold": "Poppins-ExtraBold.ttf",
              "Poppins": "Poppins-Bold.ttf", "Anton": "Anton-Regular.ttf", "Bebas Neue": "BebasNeue-Regular.ttf"}
FONT_EM = {"Poppins Black": 0.568, "Poppins ExtraBold": 0.568, "Poppins": 0.568, "Anton": 0.577, "Bebas Neue": 0.769}
LINE_H = 1.12


def font_file(p: dict, name: str) -> tuple[str, float]:
    """Archivo y factor em de una fuente; 'marca' usa la fuente subida en la línea gráfica."""
    if name == "marca":
        kit = load_brand(p["settings"].get("brand", ""))
        if kit and kit.get("fontFile"):
            f = BRANDS_DIR / kit["id"] / kit["fontFile"]
            if f.exists():
                return str(f), float(kit.get("fontEm", 0.6))
        name = "Poppins Black"
    return str(FONTS_DIR / FONT_FILES.get(name, "Poppins-Black.ttf")), FONT_EM.get(name, 0.568)


def caption_groups(p: dict, pl: dict) -> list[list[dict]]:
    st = p["style"]
    m = word_mapper(pl)
    kept = []
    for w in p["words"]:
        if w["cut"]:
            continue
        r = m(w.get("clip"), w["start"], w["end"])
        if r:
            kept.append({"text": w["text"], "s": r[0], "e": r[1]})
    kept.sort(key=lambda x: x["s"])
    max_words = max(1, int(st.get("maxWords", 3)))
    max_chars = 16 if st.get("size", 80) >= 150 else (34 if st.get("box") else 26)
    if p["settings"].get("format") in ("horizontal", "5:4"):
        max_chars = int(max_chars * 1.6)
    groups, cur = [], []
    for w in kept:
        if cur:
            chars = sum(len(x["text"]) + 1 for x in cur) + len(w["text"])
            if (len(cur) >= max_words or chars > max_chars or w["s"] - cur[-1]["e"] > 0.6
                    or re.search(r"[.?!…]$", cur[-1]["text"])):
                groups.append(cur)
                cur = []
        cur.append(w)
    if cur:
        groups.append(cur)
    return groups


def clean_caption_text(t: str, upper: bool) -> str:
    t = t.strip()
    t = re.sub(r"[,;:]+$", "", t)
    t = re.sub(r"\.$", "", t) if not t.endswith("...") else t
    return t.upper() if upper else t


def build_srt(p: dict, pl: dict) -> str:
    groups = caption_groups(p, pl)

    def ts(t):
        ms = int(round(t * 1000))
        h, ms = divmod(ms, 3600000)
        m, ms = divmod(ms, 60000)
        s, ms = divmod(ms, 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
    out = []
    for i, g in enumerate(groups, 1):
        txt = " ".join(clean_caption_text(w["text"], False) for w in g)
        end = g[-1]["e"] + 0.15
        if i < len(groups):
            end = max(g[-1]["e"], min(end, groups[i][0]["s"]))
        out.append(f"{i}\n{ts(g[0]['s'])} --> {ts(end)}\n{txt}\n")
    return "\n".join(out)


def _hex_rgba(h: str, a: float = 1.0):
    h = (h or "#FFFFFF").lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), int(round(255 * a)))


class CaptionPainter:
    def __init__(self, p: dict, geo: dict, hdr: bool = False):
        from PIL import ImageFont
        st = p["style"]
        self.st, self.geo, self.hdr = st, geo, hdr
        self.fontfile, em = font_file(p, st.get("font"))
        self.px = float(st.get("size", 100)) * em * geo["k"]
        self._fonts = {}
        self.ImageFont = ImageFont
        self.base = self.font(1.0)

    def font(self, scale: float):
        k = round(scale, 3)
        if k not in self._fonts:
            self._fonts[k] = self.ImageFont.truetype(self.fontfile, max(4, int(round(self.px * k))))
        return self._fonts[k]

    def color(self, hexc, a=1.0):
        r, g, b, al = _hex_rgba(hexc, a)
        if self.hdr:
            r, g, b = int(r * 0.75), int(g * 0.75), int(b * 0.75)
        return (r, g, b, al)

    def paint(self, words: list[str], j: int, scale: float):
        from PIL import Image, ImageDraw
        st, geo, mode = self.st, self.geo, self.st.get("mode", "resaltar")
        W, H, k = geo["W"], geo["H"], geo["k"]
        upper = bool(st.get("uppercase"))
        col, hi = st.get("color", "#FFFFFF"), st.get("highlight", "#FFE14D")
        items = []
        for n, w in enumerate(words):
            t = clean_caption_text(w, upper)
            if mode == "resaltar":
                items.append((t, scale if n == j else 1.0, self.color(hi if n == j else col)))
            elif mode == "progresivo":
                items.append((t, 1.0, self.color(hi if n == j else col, 1.0 if n <= j else 0.44)))
            else:
                if n > j:
                    continue
                items.append((t, scale if n == j else 1.0, self.color(hi if n == j else col)))
        if not items:
            return None
        space = self.base.getlength(" ") + 0.08 * self.px
        lines, cur, curw = [], [], 0.0
        for it in items:
            w = self.font(it[1]).getlength(it[0])
            add = w + (space if cur else 0)
            if cur and curw + add > geo["maxw"]:
                lines.append((cur, curw))
                cur, curw, add = [], 0.0, w
            cur.append((it, w))
            curw += add
        if cur:
            lines.append((cur, curw))
        lh = self.px * LINE_H
        asc, desc = self.base.getmetrics()
        block = lh * len(lines)
        pos = st.get("position", "abajo")
        top = (H - geo["bottom"] - block) if pos == "abajo" else (geo["top"] if pos == "arriba" else (H - block) / 2)
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ow = 0 if st.get("box") else int(round(float(st.get("outlineWidth", 0)) * k))
        olc = self.color(st.get("outline", "#000000"))
        for li, (ws, width) in enumerate(lines):
            y0 = top + li * lh
            base_y = y0 + (lh - (asc + desc)) / 2 + asc
            x = (W - width) / 2
            if st.get("box"):
                ImageDraw.Draw(img).rounded_rectangle(
                    [x - 18 * k, y0 - 6 * k, x + width + 18 * k, y0 + lh + 6 * k], radius=int(0.18 * self.px),
                    fill=self.color(st.get("boxColor", "#111111"), 0.75))
            for (t, sc, rgba), w in ws:
                layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
                ImageDraw.Draw(layer).text((x, base_y), t, font=self.font(sc), anchor="ls",
                                           fill=rgba[:3] + (255,), stroke_width=int(round(ow * sc)),
                                           stroke_fill=olc)
                if rgba[3] < 255:
                    layer.putalpha(layer.getchannel("A").point(lambda v, m=rgba[3]: v * m // 255))
                img.alpha_composite(layer)
                x += w + space
        return img


def build_caption_track(p: dict, pl: dict, work: Path, geo: dict, fps: int, hdr: bool) -> Path:
    from PIL import Image
    st = p["style"]
    groups = caption_groups(p, pl)
    total_frames = int(round(pl["total"] * fps))
    painter = CaptionPainter(p, geo, hdr)
    mode = st.get("mode", "resaltar")
    n_anim = max(2, round(0.09 * fps))
    anim = {"resaltar": (1.0, 1.12), "golpe": (0.7, 1.0)}.get(mode)
    states = []
    for gi, g in enumerate(groups):
        g_end = g[-1]["e"] + 0.25
        if gi + 1 < len(groups):
            g_end = min(g_end, groups[gi + 1][0]["s"])
        g_end = max(g_end, g[-1]["e"])
        texts = tuple(w["text"] for w in g)
        for j, w in enumerate(g):
            s = g[0]["s"] if j == 0 else w["s"]
            e = g[j + 1]["s"] if j + 1 < len(g) else g_end
            fs, fe = int(round(s * fps)), int(round(e * fps))
            if fe <= fs:
                continue
            if anim:
                a, b = anim
                for i in range(n_anim):
                    if fs + i >= fe:
                        break
                    states.append((fs + i, fs + i + 1, (texts, j, round(a + (b - a) * (i + 1) / (n_anim + 1), 3))))
                if fs + n_anim < fe:
                    states.append((fs + n_anim, fe, (texts, j, b)))
            else:
                states.append((fs, fe, (texts, j, 1.0)))
    for old in work.glob("cap_*.png"):
        old.unlink()
    blank = work / "cap_blank.png"
    Image.new("RGBA", (geo["W"], geo["H"]), (0, 0, 0, 0)).save(blank)
    cache: dict = {}
    lines = ["ffconcat version 1.0"]
    cur = 0

    def add(path, frames):
        if frames > 0:
            lines.append(f"file '{path.name}'")
            lines.append(f"duration {frames / fps:.6f}")

    for fs, fe, key in sorted(states, key=lambda s: (s[0], s[1])):
        fs, fe = max(fs, cur), min(fe, total_frames)
        if fe <= fs:
            continue
        add(blank, fs - cur)
        if key not in cache:
            img = painter.paint(list(key[0]), key[1], key[2])
            path = work / f"cap_{len(cache):04d}.png"
            (img or Image.new("RGBA", (geo["W"], geo["H"]), (0, 0, 0, 0))).save(path, compress_level=1)
            cache[key] = path
        add(cache[key], fe - fs)
        cur = fe
    add(blank, total_frames - cur + fps)
    lines.append(f"file '{blank.name}'")
    f = work / "captions.ffconcat"
    f.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return f


# ---------------------------------------------------------------- línea gráfica (marcas)

def brand_dir(bid: str) -> Path:
    if not re.fullmatch(r"[a-z0-9\-]{3,64}", bid or ""):
        raise ValueError("marca inválida")
    return BRANDS_DIR / bid


def list_brands() -> list[dict]:
    out = []
    for d in BRANDS_DIR.iterdir():
        k = d / "kit.json"
        if k.exists():
            try:
                out.append(json.loads(k.read_text(encoding="utf-8")))
            except Exception:
                pass
    return sorted(out, key=lambda x: x.get("name", "").lower())


def load_brand(bid: str) -> dict | None:
    if not bid:
        return None
    try:
        return json.loads((brand_dir(bid) / "kit.json").read_text(encoding="utf-8"))
    except Exception:
        return None


BRAND_BASE = {"name": "Mi marca", "colors": {"primary": "#111111", "secondary": "#F2F2F2", "accent": "#0A84FF",
                                             "text": "#FFFFFF"}, "font": "Poppins Black", "fontFile": "",
              "fontName": "", "fontEm": 0.6, "logo": ""}


def save_brand(kit: dict) -> dict:
    if not kit.get("id"):
        kit["id"] = f"{slug(kit.get('name') or 'marca')}-{uuid.uuid4().hex[:5]}"
    d = brand_dir(kit["id"])
    d.mkdir(parents=True, exist_ok=True)
    kit = _deep_defaults(kit, BRAND_BASE)
    (d / "kit.json").write_text(json.dumps(kit, ensure_ascii=False, indent=1), encoding="utf-8")
    return kit


def delete_brand(bid: str):
    shutil.rmtree(brand_dir(bid), ignore_errors=True)


def brand_font_em(path: Path) -> float:
    from PIL import ImageFont
    f = ImageFont.truetype(str(path), 1000)
    a, d = f.getmetrics()
    return round(1000 / max(1, a + d), 4)


def render_card(p: dict, which_: str, geo: dict, out: Path):
    """Placa de intro o cierre con los colores, letra y logo de la marca."""
    from PIL import Image, ImageDraw, ImageFont
    st = p["settings"]
    kit = load_brand(st.get("brand", "")) or dict(BRAND_BASE)
    colors = kit.get("colors", {})
    bg = _hex_rgba(colors.get("primary", "#111111"))
    fg = _hex_rgba(colors.get("text", "#FFFFFF"))
    acc = _hex_rgba(colors.get("accent", "#0A84FF"))
    W, H, k = geo["W"], geo["H"], geo["k"]
    img = Image.new("RGBA", (W, H), bg)
    d = ImageDraw.Draw(img)
    text = (st.get(which_, {}).get("text") or "").strip()
    logo_path = brand_dir(kit["id"]) / kit["logo"] if kit.get("id") and kit.get("logo") else None
    has_logo = bool(logo_path and logo_path.exists())
    y_text = H / 2
    if has_logo:
        lg = Image.open(logo_path).convert("RGBA")
        lw = int(min(W, H) * (0.36 if not text else 0.26))
        lg = lg.resize((lw, max(1, int(lg.height * lw / lg.width))), Image.LANCZOS)
        ly = int(H / 2 - lg.height / 2 - (70 * k if text else 0))
        img.alpha_composite(lg, (int(W / 2 - lg.width / 2), ly))
        y_text = ly + lg.height + 110 * k
    if text:
        fname = "marca" if kit.get("fontFile") else kit.get("font", "Poppins Black")
        ff, em = font_file(p, fname)
        size = int(200 * em * k * (1.0 if len(text) < 16 else 0.7))
        f = ImageFont.truetype(ff, size)
        lines, cur = [], ""
        for wd in text.split():
            t = (cur + " " + wd).strip()
            if f.getlength(t) > W * 0.8 and cur:
                lines.append(cur)
                cur = wd
            else:
                cur = t
        lines.append(cur)
        lh = size * 1.18
        y0 = y_text if has_logo else H / 2 - lh * (len(lines) - 1) / 2 + size * 0.35
        for i, ln in enumerate(lines):
            d.text((W / 2, y0 + i * lh), ln, font=f, fill=fg, anchor="ms")
        yb = y0 + (len(lines) - 1) * lh + size * 0.45
        d.rounded_rectangle([W / 2 - 60 * k, yb, W / 2 + 60 * k, yb + 8 * k], radius=int(4 * k), fill=acc)
    img.convert("RGB").save(out, quality=95)


# ---------------------------------------------------------------- análisis: música y referencia

def analyze_audio_beats(path: Path) -> dict:
    """Tempo y pulsos (flujo espectral + autocorrelación)."""
    import numpy as np
    sr = 22050
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype=np.float32)
    dur = len(x) / sr
    if len(x) < sr * 3:
        return {"tempo": 0, "beats": [], "duration": round(dur, 2)}
    n, hop = 1024, 512
    frames = 1 + (len(x) - n) // hop
    win = np.hanning(n).astype(np.float32)
    flux = np.zeros(frames, dtype=np.float32)
    prev = None
    step = 2048
    for s0 in range(0, frames, step):
        idx = np.arange(n)[None, :] + hop * np.arange(s0, min(frames, s0 + step))[:, None]
        spec = np.log1p(np.abs(np.fft.rfft(x[idx] * win, axis=1)) * 10)
        if prev is not None:
            spec_full = np.vstack([prev[None, :], spec])
        else:
            spec_full = np.vstack([spec[:1], spec])
        flux[s0:s0 + spec.shape[0]] = np.maximum(0, np.diff(spec_full, axis=0)).sum(axis=1)
        prev = spec[-1]
    flux = flux - np.convolve(flux, np.ones(16) / 16, mode="same")
    flux = np.maximum(flux, 0)
    if flux.max() <= 0:
        return {"tempo": 0, "beats": [], "duration": round(dur, 2)}
    flux /= flux.max()
    fr = sr / hop
    lags = np.arange(int(fr * 60 / 180), int(fr * 60 / 60) + 1)
    ac = np.array([float(np.dot(flux[:-l], flux[l:])) for l in lags])
    bpm = 60 * fr / lags
    ac = ac * np.exp(-0.5 * (np.log2(bpm / 115) / 0.9) ** 2)
    k = int(np.argmax(ac))
    lag = int(lags[k])
    lagf = float(lag)
    if 0 < k < len(ac) - 1:   # interpolación parabólica: tempo con decimales, sin deriva
        a0, a1, a2 = ac[k - 1], ac[k], ac[k + 1]
        den = a0 - 2 * a1 + a2
        if den != 0:
            lagf = lag + 0.5 * (a0 - a2) / den
    # afinar periodo y fase juntos: la rejilla de pulsos que mejor cae sobre los golpes en toda la canción
    best = (-1.0, lagf, 0)
    for c in np.linspace(lagf - 0.8, lagf + 0.8, 65):
        nb = int((len(flux) - 1) / c)
        base = c * np.arange(nb)
        for o in range(int(c) + 1):
            ix = np.rint(o + base).astype(int)
            ix = ix[ix < len(flux)]
            sc = float(flux[ix].sum())
            if sc > best[0]:
                best = (sc, float(c), o)
    _, lagf, phase = best
    beats = [round(float(t) + n / sr / 2, 3) for t in (phase + lagf * np.arange(int((len(flux) - 1 - phase) / lagf) + 1)) / fr]
    return {"tempo": round(float(60 * fr / lagf), 1), "beats": beats, "duration": round(dur, 2)}


def analyze_reference(p: dict, progress=lambda f, m="": None) -> dict:
    d = project_dir(p["id"])
    path = d / p["reference"]["file"]
    info = probe(path)
    dur = max(info.get("duration", 1), 0.5)
    progress(0.1, "Detectando cortes…")
    r = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", str(path), "-an", "-vf",
                        "scale=320:-2,select='gt(scene,0.32)',showinfo", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    cuts = [float(t) for t in re.findall(r"pts_time:([\d.]+)", r.stderr)]
    cuts = [c for i, c in enumerate(cuts) if i == 0 or c - cuts[i - 1] > 0.25]
    shots = len(cuts) + 1
    progress(0.5, "Midiendo el color…")
    stats = clip_stats(path)
    progress(0.75, "Escuchando el ritmo…")
    tempo = 0
    if info.get("hasAudio"):
        try:
            tempo = analyze_audio_beats(path).get("tempo", 0)
        except Exception:
            tempo = 0
    n = 8
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(path), "-vf",
                    f"fps={n / dur:.5f},scale=-2:220,tile={n}x1", "-frames:v", "1", "-q:v", "4",
                    str(d / "media" / "ref_sheet.jpg")], capture_output=True)
    w, h = info.get("width", 1080), info.get("height", 1920)
    ratio = w / max(h, 1)
    fmt = min(FORMATS, key=lambda f: abs(FORMATS[f]["w"] / FORMATS[f]["h"] - ratio))
    look = "natural"
    if stats:
        if stats["sat"] < 6:
            look = "bn"
        elif stats["warm"] > 9:
            look = "calido"
        elif stats["warm"] < -6:
            look = "frio"
        elif stats["contrast"] > 205 and stats["sat"] > 30:
            look = "vivo"
        elif stats["contrast"] < 175:
            look = "mate"
    return {"duration": round(dur, 2), "width": w, "height": h, "fps": info.get("fps"), "format": fmt,
            "shots": shots, "avgShot": round(dur / shots, 2), "cuts": [round(c, 2) for c in cuts[:200]],
            "tempo": tempo, "stats": stats, "look": look, "hasAudio": info.get("hasAudio")}


def apply_reference(p: dict) -> list[str]:
    """Lleva formato, ritmo y color del proyecto hacia los de la referencia."""
    ref = (p.get("reference") or {}).get("analysis")
    if not ref:
        return []
    st = p["settings"]
    done = []
    st["format"] = ref["format"]
    done.append(f"formato {FORMATS[ref['format']]['label']}")
    st["pace"] = round(min(6.0, max(0.8, ref["avgShot"])), 2)
    done.append(f"tomas de {st['pace']:.1f} s")
    st["transition"]["type"] = "corte" if ref["avgShot"] < 2.2 else "disolver"
    done.append(f"transición {st['transition']['type']}")
    g = st["grade"]
    g["look"] = ref.get("look", "natural")
    rs = ref.get("stats") or {}
    cs = [c.get("stats") for c in p["clips"] if c.get("stats")]
    if rs and cs:
        avg = {k: sum(s[k] for s in cs) / len(cs) for k in ("y", "sat", "warm", "contrast")}
        g["exposure"] = round(max(-0.25, min(0.25, 0.5 * (rs["y"] - avg["y"]) / 60)), 2)
        g["saturation"] = round(max(-0.2, min(0.2, 0.5 * (rs["sat"] - avg["sat"]) / max(avg["sat"], 8))), 2)
        g["temperature"] = round(max(-0.2, min(0.2, 0.5 * (rs["warm"] - avg["warm"]) / 14)), 2)
        g["contrast"] = round(max(-0.2, min(0.2, 0.5 * (rs["contrast"] - avg["contrast"]) / 80)), 2)
    done.append(f"color {LOOKS[g['look']]['label'].lower()}")
    if ref.get("tempo") and st["music"].get("file"):
        st["music"]["beatSync"] = True
        done.append("cortes al ritmo de la música")
    return done


TRANS_POOLS = {  # transiciones por estilo: [fuertes (inicio de frase musical), suaves (resto)]
    "dinamico": (["zoom", "barrido", "blanco", "difuminar"], ["corte", "corte", "zoom", "corte"]),
    "viral": (["zoom", "blanco", "barrido"], ["corte"]),
    "energetico": (["barrido", "zoom", "blanco", "difuminar"], ["corte", "barrido", "corte"]),
    "elegante": (["disolver", "difuminar", "negro"], ["disolver", "corte", "disolver"]),
    "cinematico": (["negro", "difuminar", "disolver"], ["disolver", "corte"]),
    "corporativo": (["barrido", "disolver", "zoom"], ["disolver", "corte"]),
    "calido": (["difuminar", "disolver", "zoom"], ["disolver", "corte"]),
    "vintage": (["difuminar", "negro", "blanco"], ["disolver", "difuminar"]),
    "bn": (["negro", "blanco", "difuminar"], ["disolver", "corte"]),
    "natural": (["disolver", "difuminar", "barrido"], ["corte", "corte", "disolver"]),
}


def vary_transitions(p: dict, style: str, base_dur: float) -> int:
    """Pone una transición distinta en cada unión según el estilo y la música:
    las fuertes caen al inicio de cada frase musical (cada 8 tiempos), las medianas cada compás."""
    strong, soft = TRANS_POOLS.get(style, TRANS_POOLS["dinamico"])
    mus = p["settings"].get("music") or {}
    beats = mus.get("beats") or [] if mus.get("file") else []
    tempo = float(mus.get("tempo") or 0) if beats else 0
    dur = base_dur
    if tempo:  # que dure medio tiempo o un tiempo de la canción
        beat = 60 / tempo
        dur = beat / 2 if base_dur < beat * 0.75 else beat
        dur = round(min(0.7, max(0.2, dur)), 3)
    tl = p.get("timeline", [])
    for it in tl:
        it.pop("transition", None)
    pl = plan(p)
    clips = [i for i in pl["items"] if i["kind"] == "clip"]
    ms = float(mus.get("start", 0))
    k_s = k_w = 0
    n = 0
    for idx, itm in enumerate(clips[1:], 1):
        if itm.get("speech") and clips[idx - 1].get("speech") and clips[idx - 1]["clip"] == itm["clip"]:
            continue
        if beats:
            t = itm["start"] + ms
            bi = min(range(len(beats)), key=lambda b: abs(beats[b] - t))
            level = 2 if bi % 8 == 0 else (1 if bi % 4 == 0 else 0)
        else:
            level = 2 if idx % 4 == 0 else (1 if idx % 2 == 0 else 0)
        if level == 2:
            ty = strong[k_s % len(strong)]; k_s += 1
        elif level == 1:
            ty = (strong[(k_s + 1) % len(strong)] if len(soft) == 1 else soft[(k_w + 1) % len(soft)]); k_w += 1
        else:
            ty = soft[k_w % len(soft)]; k_w += 1
        ti = itm.get("ti")
        if ti is None or ti >= len(tl):
            continue
        tl[ti]["transition"] = {"type": ty, "dur": dur if ty != "corte" else 0.3}
        n += 1
    return n


def match_clips_color(p: dict, progress=lambda f, m="": None) -> int:
    """Iguala brillo, saturación y temperatura de los clips hacia el promedio."""
    clips = [c for c in p["clips"] if c.get("status") in ("listo", "sin voz", "sin transcribir") and c.get("hasVideo", True)]
    for i, c in enumerate(clips):
        if not c.get("stats"):
            progress(i / max(1, len(clips)), f"Midiendo {c['name']}…")
            c["stats"] = clip_stats(clip_path(p, c))
    clips = [c for c in clips if c.get("stats")]
    if len(clips) < 2:
        return 0
    ty = sum(c["stats"]["y"] for c in clips) / len(clips)
    tw = sum(c["stats"]["warm"] for c in clips) / len(clips)
    ts = sum(c["stats"]["sat"] for c in clips) / len(clips)
    for c in clips:
        adj = c.setdefault("adjust", {})
        # suave: solo acerca la mitad del camino y con topes chicos (antes se pasaba y dañaba los colores)
        adj["exposure"] = round(max(-0.2, min(0.2, 0.5 * (ty - c["stats"]["y"]) / 60)), 2)
        adj["temperature"] = round(max(-0.15, min(0.15, 0.5 * (tw - c["stats"]["warm"]) / 14)), 2)
        adj["saturation"] = round(max(-0.12, min(0.12, 0.5 * (ts - c["stats"]["sat"]) / max(ts, 8))), 2)
    return len(clips)


# ---------------------------------------------------------------- armar automáticamente

def auto_assemble(p: dict) -> str:
    """Primer armado: clips con voz en orden como principales; los demás, como apoyo o montaje."""
    ready = [c for c in p["clips"] if c.get("status") in ("listo", "sin voz", "sin transcribir") and c.get("hasVideo", True)]
    speech = [c for c in ready if c.get("speech")]
    other = [c for c in ready if not c.get("speech")]
    if (p.get("reference") or {}).get("analysis"):
        apply_reference(p)
    pace = float(p["settings"].get("pace", 2.5))
    p["broll"] = []
    if not speech:
        p["timeline"] = [{"clip": c["id"], "in": round(min(0.5, c["duration"] * 0.1), 2),
                          "out": round(c["duration"], 2)} for c in other]
        return f"Armé un montaje con {len(other)} clips (tomas de {pace:.1f} s)."
    p["timeline"] = [{"clip": c["id"], "in": 0.0, "out": round(c["duration"], 2)} for c in speech]
    if not other:
        return f"Uní {len(speech)} clips con voz."
    pl = plan(p)
    main = pl["total"] - pl["mainStart"]
    # Las tomas de apoyo tapan los cortes dentro de un mismo video (así no se nota el salto)
    cuts = [c0 - pl["mainStart"] for c0 in jump_cuts(pl)]
    used_at, end_prev, k = [], -9.0, 0
    uses = {c["id"]: 0 for c in other}
    for cut in cuts:
        if cut - end_prev < 0.6 or cut < 0.8 or cut > main - 0.8:
            continue
        c = other[k % len(other)]; k += 1
        dur = round(min(max(1.4, pace * 0.8), c["duration"] - 0.3, 3.0), 2)
        if dur < 0.8:
            continue
        at = max(end_prev + 0.1, cut - dur * 0.45)
        src_in = round((uses[c["id"]] * (dur + 0.3)) % max(0.1, c["duration"] - dur), 2)
        uses[c["id"]] += 1
        p["broll"].append({"id": uuid.uuid4().hex[:6], "clip": c["id"], "at": round(at, 2), "dur": dur, "srcIn": src_in})
        end_prev = at + dur
        used_at.append(at)
    # si sobran tomas de apoyo, se reparten en los tramos largos sin cortes
    gap = max(3.5, (main - 2.5) / (len(other) + 1))
    t = 2.5
    for c in other:
        if uses[c["id"]]:
            continue
        dur = round(min(max(1.2, pace), c["duration"] - 0.4, 4.0), 2)
        while t + dur < main - 0.8 and any(abs(t - u) < 3 for u in used_at):
            t += 1.0
        if dur < 0.8 or t + dur > main - 0.8:
            continue
        p["broll"].append({"id": uuid.uuid4().hex[:6], "clip": c["id"], "at": round(t, 2), "dur": dur,
                           "srcIn": round(min(0.4, c["duration"] * 0.1), 2)})
        used_at.append(t); t += gap
    p["broll"].sort(key=lambda b: b["at"])
    return f"Uní {len(speech)} clips con voz y puse {len(p['broll'])} tomas de apoyo, tapando los cortes."


def jump_cuts(pl: dict) -> list[float]:
    """Momentos (en el video final) donde un mismo clip salta de una parte a otra."""
    out = []
    for it in pl["items"]:
        if it.get("kind") == "clip" and len(it.get("segs") or []) > 1:
            acc = 0.0
            for a, b in it["segs"][:-1]:
                acc += b - a
                out.append(it["start"] + acc)
    return out


# ---------------------------------------------------------------- color

def grade_filters(p: dict, c: dict, sdr_from_hdr: bool) -> str:
    g = p["settings"].get("grade", {})
    adj = dict((c or {}).get("adjust", {}) or {})
    for k, lim in (("exposure", 0.2), ("temperature", 0.15), ("saturation", 0.12)):  # proyectos viejos con ajustes exagerados
        if k in adj:
            adj[k] = max(-lim, min(lim, float(adj[k])))
    parts = []
    if sdr_from_hdr:
        parts.append(hdr_to_sdr(c or {}))
    look = LOOKS.get(g.get("look", "natural"), LOOKS["natural"])["ff"]
    if look:
        parts.append(look)
    ex = float(g.get("exposure", 0)) + float(adj.get("exposure", 0))
    co = float(g.get("contrast", 0))
    sa = float(g.get("saturation", 0)) + float(adj.get("saturation", 0))
    if abs(ex) > 0.005 or abs(co) > 0.005 or abs(sa) > 0.005:
        parts.append(f"eq=brightness={ex * 0.03:.3f}:gamma={1 + ex * 0.25:.3f}:contrast={1 + co * 0.25:.3f}"
                     f":saturation={max(0, 1 + sa * 0.5):.3f}")
    te = float(g.get("temperature", 0)) + float(adj.get("temperature", 0))
    if abs(te) > 0.01:
        parts.append(f"colortemperature=temperature={int(6500 - te * 2000)}:mix=0.6")
    ti = float(g.get("tint", 0))
    if abs(ti) > 0.01:
        parts.append(f"colorbalance=gm={-ti * 0.08:.3f}:gs={-ti * 0.05:.3f}")
    vi = float(g.get("vignette", 0))
    if vi > 0.01:
        parts.append(f"vignette=angle={0.2 + vi * 0.5:.3f}")
    return ",".join(parts)


def grading_active(p: dict) -> bool:
    g = p["settings"].get("grade", {})
    if g.get("look", "natural") != "natural":
        return True
    if any(abs(float(g.get(k, 0))) > 0.005 for k in ("exposure", "contrast", "saturation", "temperature", "tint", "vignette")):
        return True
    return any(any(abs(float(v)) > 0.005 for v in (c.get("adjust") or {}).values()) for c in p["clips"])


# ---------------------------------------------------------------- render

QUALITY = {
    "maxima":  ("slow", 16, "320k", 0.22),
    "alta":    ("medium", 18, "256k", 0.15),
    "liviana": ("veryfast", 22, "192k", 0.08),
    "borrador": ("ultrafast", 30, "128k", 0.05),
    "vista": ("veryfast", 19, "160k", 0.12),
}


CHUNK = 12


def xfade_chain(g: list, seq) -> str:
    """Une [p0]..[pn] con sus transiciones (xfade) o cortes; devuelve la etiqueta final."""
    cur, acc = "[p0]", seq[0][1]
    for j in range(1, len(seq)):
        _, d, td, ty = seq[j]
        lab = f"[q{j}]"
        if td > 0:
            g.append(f"{cur}[p{j}]xfade=transition={TRANSITIONS[ty]}:duration={td:.4f}:offset={acc - td:.4f}{lab}")
        else:
            g.append(f"{cur}[p{j}]concat=n=2:v=1:a=0{lab}")
        acc += d - td
        cur = lab
    return cur


def assemble_seq(seq, work: Path, fps: int, work_fmt: str, hdr: bool, level: int = 0) -> Path:
    """Une una secuencia larga en bloques de CHUNK y luego une los bloques (con la transición de su borde)."""
    blocks = []
    for b, i0 in enumerate(range(0, len(seq), CHUNK)):
        part = seq[i0:i0 + CHUNK]
        out = work / f"seq{level}_{b}.mp4"
        g, cmd = [], []
        for i, (f, *_r) in enumerate(part):
            cmd += ["-i", f]
            g.append(f"[{i}:v]fps={fps},settb=AVTB,setpts=PTS-STARTPTS,format={work_fmt}[p{i}]")
        first = (part[0][0], part[0][1], 0, None)
        cur = xfade_chain(g, [first] + part[1:])
        g.append(f"{cur}format={work_fmt}[v]")
        gf = work / f"seq{level}_{b}.txt"
        gf.write_text(";\n".join(g), encoding="utf-8")
        dur = sum(x[1] for x in part) - sum(x[2] for x in part[1:])
        run_ffmpeg(cmd + graph_args(gf) + ["-map", "[v]", "-an"] + _enc_piece(hdr, False)
                   + ["-r", str(fps), "-t", f"{dur:.4f}", str(out)])
        blocks.append((str(out), dur, part[0][2] if i0 else 0, part[0][3]))
    if len(blocks) > CHUNK:
        return assemble_seq(blocks, work, fps, work_fmt, hdr, level + 1)
    if len(blocks) == 1:
        return Path(blocks[0][0])
    out = work / f"seq{level}_all.mp4"
    g, cmd = [], []
    for i, (f, *_r) in enumerate(blocks):
        cmd += ["-i", f]
        g.append(f"[{i}:v]fps={fps},settb=AVTB,setpts=PTS-STARTPTS,format={work_fmt}[p{i}]")
    cur = xfade_chain(g, blocks)
    g.append(f"{cur}format={work_fmt}[v]")
    gf = work / f"seq{level}_all.txt"
    gf.write_text(";\n".join(g), encoding="utf-8")
    dur = sum(x[1] for x in blocks) - sum(x[2] for x in blocks[1:])
    run_ffmpeg(cmd + graph_args(gf) + ["-map", "[v]", "-an"] + _enc_piece(hdr, False)
               + ["-r", str(fps), "-t", f"{dur:.4f}", str(out)])
    return out


def pick_fps(p: dict, want) -> int:
    if str(want) in ("24", "25", "30", "50", "60"):
        return int(want)
    fpss = [float(c.get("fps") or 30) for c in p["clips"] if c.get("hasVideo", True)] or [30]
    src = max(fpss)
    return min((24, 25, 30, 50, 60), key=lambda f: abs(f - src))


def framing_chain(c: dict, st: dict, geo: dict, hdr: bool) -> str:
    W, H = geo["W"], geo["H"]
    cx = min(1, max(0, float(c.get("cropX", st.get("cropX", 0.5)))))
    cy = min(1, max(0, float(c.get("cropY", st.get("cropY", 0.5)))))
    sw, sh = c.get("width") or W, c.get("height") or H
    same = abs(sw / sh - W / H) < 0.01
    fit = c.get("fit") or st.get("fit", "llenar")
    if same or fit == "llenar":
        return (f"scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,"
                f"crop={W}:{H}:(iw-ow)*{cx:.4f}:(ih-oh)*{cy:.4f},setsar=1")
    bw, bh = even(W / 8), even(H / 8)
    tone = "" if hdr else ",eq=brightness=-0.05:saturation=1.08"
    return (f"split=2[fg][bg];[bg]scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},"
            f"gblur=sigma=5{tone},scale={W}:{H}:flags=bicubic[bgb];"
            f"[fg]scale={W}:{H}:force_original_aspect_ratio=decrease:flags=lanczos[fgs];"
            f"[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1")


def _enc_piece(fmt10: bool, draft: bool) -> list[str]:
    if has_encoder("libx264"):
        e = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "17" if draft else "12"]
        return e + (["-profile:v", "high10", "-pix_fmt", "yuv420p10le"] if fmt10 else ["-pix_fmt", "yuv420p"])
    return ["-c:v", "h264_videotoolbox", "-b:v", "24M" if draft else "60M", "-pix_fmt", "yuv420p"]


def render_piece(p: dict, segs, c: dict, ctx: dict, out: Path, with_audio: bool):
    """Un elemento de la secuencia (o una toma de apoyo) normalizado: tamaño, fps, color, audio PCM."""
    fps, geo, hdr_out = ctx["fps"], ctx["geo"], ctx["hdr"]
    src = clip_path(p, c)
    sel = "+".join(f"between(t,{a:.4f},{b - 0.0005:.4f})" for a, b in segs)
    dur = sum(b - a for a, b in segs)
    work_fmt = "yuv420p10le" if hdr_out else "yuv420p"
    punch = with_audio and len(segs) > 1 and p["settings"].get("punchIn", True)
    fr = framing_chain(c, p["settings"], geo, hdr_out)
    if punch:
        # cortes dentro del mismo video: cada tramo alterna un acercamiento leve (como hacen los editores)
        n, z = len(segs), 1.12
        W, H = geo["W"], geo["H"]
        zw, zh = int(round(W * z / 2) * 2), int(round(H * z / 2) * 2)
        parts = [f"[0:v]setpts=PTS-STARTPTS,fps={fps},split={n}" + "".join(f"[vs{i}]" for i in range(n))]
        for i, (a, b) in enumerate(segs):
            zz = f",scale={zw}:{zh},crop={W}:{H},setsar=1" if i % 2 else ",setsar=1"
            parts.append(f"[vs{i}]trim=start={a:.4f}:end={b:.4f},setpts=PTS-STARTPTS,{fr}{zz}[vt{i}]")
        parts.append("".join(f"[vt{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0,setpts=N/{fps}/TB[vcat]")
        v = ";".join(parts) + ";[vcat]null"
    else:
        v = f"[0:v]setpts=PTS-STARTPTS,fps={fps},select='{sel}',setpts=N/{fps}/TB," + fr
    if not hdr_out:
        gf = grade_filters(p, c, sdr_from_hdr=bool(c.get("hdr")))
        if gf:
            v += "," + gf
    v += f",format={work_fmt}[v]"
    graph = [v]
    cmd = ["-i", str(src)]
    if with_audio and c.get("hasAudio") and not c.get("muted"):
        n = len(segs)
        gain = float(c.get("gain", 0))
        graph.append(f"[0:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,asplit={n}"
                     + "".join(f"[s{i}]" for i in range(n)))
        for i, (a, b) in enumerate(segs):
            fade = min(0.012, (b - a) / 4)
            graph.append(f"[s{i}]atrim=start={a:.4f}:end={b:.4f},asetpts=PTS-STARTPTS,"
                         f"afade=t=in:d={fade:.4f},afade=t=out:st={b - a - fade:.4f}:d={fade:.4f}[x{i}]")
        graph.append("".join(f"[x{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1,volume={gain}dB,"
                     f"apad=whole_dur={dur:.4f}[a]")
    else:
        cmd += ["-f", "lavfi", "-t", f"{dur:.4f}", "-i", "anullsrc=r=48000:cl=stereo"]
        graph.append("[1:a]anull[a]")
    gfile = out.with_suffix(".txt")
    gfile.write_text(";\n".join(graph), encoding="utf-8")
    cmd += graph_args(gfile) + ["-map", "[v]", "-map", "[a]"] + _enc_piece(hdr_out, ctx["draft"])
    cmd += ["-r", str(fps), "-c:a", "pcm_s16le", "-ar", "48000", "-t", f"{dur:.4f}", str(out)]
    run_ffmpeg(cmd)


def render_card_piece(p: dict, which_: str, dur: float, ctx: dict, out: Path):
    img = out.with_suffix(".jpg")
    render_card(p, which_, ctx["geo"], img)
    fmt = "yuv420p10le" if ctx["hdr"] else "yuv420p"
    run_ffmpeg(["-loop", "1", "-framerate", str(ctx["fps"]), "-t", f"{dur:.4f}", "-i", str(img),
                "-f", "lavfi", "-t", f"{dur:.4f}", "-i", "anullsrc=r=48000:cl=stereo",
                "-vf", f"scale={ctx['geo']['W']}:{ctx['geo']['H']},format={fmt}", "-map", "0:v", "-map", "1:a",
                *_enc_piece(ctx["hdr"], ctx["draft"]), "-r", str(ctx["fps"]), "-c:a", "pcm_s16le",
                "-t", f"{dur:.4f}", str(out)])


def _piece_key(*parts) -> str:
    return hashlib.sha1(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()[:16]


def measure_loudness(path: Path) -> dict | None:
    r = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", str(path), "-af",
                        "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr, re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
        return None if d.get("input_i") in ("-inf", None) else d
    except Exception:
        return None


def render(p: dict, opts: dict, progress=lambda f, msg="": None) -> dict:
    """Arma y renderiza el video completo. opts: format, res, fps, quality, codec, subtitles, srt,
    loudnorm, preview (borrador rápido de baja resolución)."""
    d = project_dir(p["id"])
    preview = bool(opts.get("preview"))
    st = p["settings"]
    fmt = opts.get("format") or st.get("format", "vertical")
    p = dict(p, settings=dict(st, format=fmt))
    st = p["settings"]
    res = int(opts.get("res") or (2160 if opts.get("uhd") else 1080))
    if preview:
        res = 1080  # vista previa nítida (antes 540): en la M4 sigue siendo rápida
    geo = geometry(fmt, res)
    fps = pick_fps(p, opts.get("fps", "auto"))
    if preview:
        fps = min(fps, 30)
    q = "vista" if preview else (opts.get("quality") if opts.get("quality") in QUALITY else "alta")
    preset, crf, abr, bpp = QUALITY[q]
    codec = "h264" if preview else opts.get("codec", "h264")
    used = [clip_by_id(p, it["clip"]) for it in p["timeline"]] + [clip_by_id(p, b["clip"]) for b in p["broll"]]
    used = [c for c in used if c]
    anim_list = [a for a in (p.get("anims") or []) if a.get("on", True) and str(a.get("text", "")).strip()]
    hdr = bool(used) and all(c.get("hdr") for c in used) and not grading_active(p) and not preview and not anim_list
    trc = next(((c.get("color") or {}).get("transfer") for c in used if c.get("hdr")), "arib-std-b67")
    ctx = {"fps": fps, "geo": geo, "hdr": hdr, "draft": preview}

    pl = plan(p, fps)
    items = pl["items"]
    if not items or pl["total"] <= 0.1:
        raise RuntimeError("La secuencia está vacía: agrega clips o restaura palabras tachadas.")
    total = pl["total"]
    work = d / "work"
    pieces_dir = work / "pieces"
    pieces_dir.mkdir(parents=True, exist_ok=True)
    (d / "media").mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    tag = {"vertical": "9x16", "horizontal": "16x9", "4:5": "4x5", "5:4": "5x4", "cuadrado": "1x1"}.get(fmt, fmt)
    exp = export_dirs(p)[0]
    exp.mkdir(parents=True, exist_ok=True)
    if not preview and str(exp) not in p.get("exportFolders", []):
        def _remember(q, folder=str(exp)):
            q.setdefault("exportFolders", [])
            if folder not in q["exportFolders"]:
                q["exportFolders"].append(folder)
        update(p["id"], _remember)
    if preview:
        out_file = d / "media" / "preview.mp4"
    else:
        ext = ".mov" if codec == "prores" else ".mp4"
        out_file = exp / f"{slug(p['name'])}-{tag}-{min(geo['W'], geo['H'])}p-{fps}fps-{stamp}{ext}"
    tmp_out = out_file.with_name(out_file.stem + ".tmp" + out_file.suffix)

    # 1. Piezas (caché: si nada cambió en un clip, no se vuelve a renderizar)
    base_key = [geo, fps, hdr, preview, st.get("fit"), st.get("cropX"), st.get("cropY"), st.get("grade"), st.get("punchIn", True), 4]
    broll_jobs = []
    for b in p["broll"]:
        c = clip_by_id(p, b["clip"])
        if not c or c.get("status") not in ("listo", "sin voz", "sin transcribir"):
            continue
        at = pl["mainStart"] + float(b["at"])
        dur = min(float(b["dur"]), max(0.0, total - at), float(c.get("duration", 0)) - float(b.get("srcIn", 0)))
        if dur < 0.3:
            continue
        a0 = float(b.get("srcIn", 0))
        segs = snap([[a0, a0 + dur]], fps)
        if segs:
            broll_jobs.append((c, at, segs))
    n_jobs = len(items) + len(broll_jobs)
    piece_files, used_keys = [], set()
    kit = load_brand(st.get("brand", "")) or {}
    for i, itm in enumerate(items):
        progress(0.02 + 0.5 * i / max(1, n_jobs), f"Preparando parte {i + 1} de {n_jobs}…")
        if itm["kind"] == "card":
            key = _piece_key(base_key, "card", itm["card"], itm["dur"], st.get(itm["card"]), kit)
            f = pieces_dir / f"{key}.mov"
            if not f.exists():
                render_card_piece(p, itm["card"], itm["dur"], ctx, f)
        else:
            c = clip_by_id(p, itm["clip"])
            src = clip_path(p, c)
            key = _piece_key(base_key, "clip", c["id"], src.stat().st_mtime, itm["segs"], c.get("adjust"),
                             c.get("gain"), c.get("fit"), c.get("cropX"), c.get("cropY"), c.get("muted"))
            f = pieces_dir / f"{key}.mov"
            if not f.exists():
                render_piece(p, itm["segs"], c, ctx, f, with_audio=True)
        used_keys.add(f.name)
        piece_files.append(f)
    broll_files = []
    for i, (c, at, segs) in enumerate(broll_jobs):
        progress(0.02 + 0.5 * (len(items) + i) / max(1, n_jobs), f"Preparando apoyo {i + 1}…")
        src = clip_path(p, c)
        key = _piece_key(base_key, "broll", c["id"], src.stat().st_mtime, segs, c.get("adjust"),
                         c.get("fit"), c.get("cropX"), c.get("cropY"))
        f = pieces_dir / f"{key}.mov"
        if not f.exists():
            render_piece(p, segs, c, ctx, f, with_audio=False)
        used_keys.add(f.name)
        broll_files.append((f, at, sum(y - x for x, y in segs)))

    # 1b. Animaciones (HyperFrames): se graban con fondo transparente y se guardan en caché
    anim_files = []
    if anim_list:
        import anims as A
        if not A.status()["ready"]:
            A.install(lambda f, m="": progress(0.5, "Preparando animaciones (solo la primera vez)… " + m))
        for i, a in enumerate(anim_list):
            at = max(0.0, min(float(a.get("start", 0)), total - 0.5))
            ad = min(float(a.get("dur", 3)), total - at)
            if ad < 0.5:
                continue
            a2 = dict(a, dur=round(ad, 3))
            key = "anim-" + A.anim_key(p, a2, geo, fps, kit)
            f = pieces_dir / f"{key}.mov"
            progress(0.52, f"Dibujando animación {i + 1} de {len(anim_list)}…")
            if not f.exists():
                A.render_anim(p, a2, geo, fps, kit, f)
            used_keys.add(f.name)
            anim_files.append((f, at, ad))

    for old in pieces_dir.glob("*.mov"):
        if old.name not in used_keys and time.time() - old.stat().st_mtime > 6 * 3600:
            old.unlink()

    # 2. Audio: voces con sus cruces + música que baja sola cuando alguien habla
    progress(0.55, "Mezclando audio…")
    mus = st.get("music", {})
    music_path = d / mus["file"] if mus.get("file") else None
    if music_path and not music_path.exists():
        music_path = None
    ag, acmd = [], []
    for f in piece_files:
        acmd += ["-i", str(f)]
    cur = "[0:a]"
    for j in range(1, len(items)):
        td = items[j]["tdur"]
        lab = f"[ac{j}]"
        if td > 0:
            ag.append(f"{cur}[{j}:a]acrossfade=d={td:.4f}:c1=tri:c2=tri{lab}")
        else:
            ag.append(f"{cur}[{j}:a]concat=n=2:v=0:a=1{lab}")
        cur = lab
    has_voice = any(itm.get("speech") and not (clip_by_id(p, itm.get("clip")) or {}).get("muted") for itm in items)
    voz = st.get("voice") or {}
    voz_path = d / voz["file"] if voz.get("file") else None
    if voz_path and voz_path.exists():
        vi = len(piece_files) + (1 if music_path else 0)
        ms0 = int(pl["mainStart"] * 1000)
        ag.append(f"[{vi}:a]aresample=48000,aformat=channel_layouts=stereo,volume={float(voz.get('gain', 0)):.1f}dB,"
                  f"adelay={ms0}|{ms0},apad,atrim=end={total:.4f}[vzx]")
        ag.append(f"{cur}[vzx]amix=inputs=2:duration=first:normalize=0[vzm]")
        cur = "[vzm]"
        has_voice = True
    else:
        voz_path = None
    if music_path:
        mi = len(piece_files)
        acmd += ["-stream_loop", "-1", "-i", str(music_path)]
    if voz_path:
        acmd += ["-i", str(voz_path)]
    if music_path:
        vol = float(mus.get("volume", 0.35))
        if not has_voice:  # sin voces, la música es el audio principal: va a volumen completo
            vol = max(vol, 1.0)
        fi, fo = float(mus.get("fadeIn", 1)), float(mus.get("fadeOut", 2))
        mchain = (f"[{mi}:a]aresample=48000,aformat=channel_layouts=stereo,"
                  f"atrim=start={float(mus.get('start', 0)):.3f},asetpts=PTS-STARTPTS,"
                  f"atrim=end={total:.4f},volume={vol:.3f}")
        if fi > 0:
            mchain += f",afade=t=in:d={fi:.2f}"
        if fo > 0:
            mchain += f",afade=t=out:st={max(0, total - fo):.3f}:d={fo:.2f}"
        ag.append(mchain + "[mus]")
        if has_voice and mus.get("duck", True):
            ag.append(f"{cur}asplit=2[vo][vsc]")
            ag.append("[mus][vsc]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=400[mud]")
            ag.append("[vo][mud]amix=inputs=2:duration=first:normalize=0[mix]")
        else:
            ag.append(f"{cur}[mus]amix=inputs=2:duration=first:normalize=0[mix]")
    else:
        ag.append(f"{cur}anull[mix]")
    agf = work / "audio.txt"
    agf.write_text(";\n".join(ag), encoding="utf-8")
    mix = work / "mix.wav"
    run_ffmpeg(acmd + graph_args(agf) + ["-map", "[mix]", "-t", f"{total:.4f}", "-c:a", "pcm_s24le",
                                         "-ar", "48000", str(mix)])
    loud = None
    if opts.get("loudnorm", True) and not preview:
        progress(0.6, "Midiendo el volumen…")
        loud = measure_loudness(mix)

    # 3. Subtítulos
    cap_track = None
    if opts.get("subtitles", st.get("subtitles", True)) and (any(i.get("speech") for i in items)
                                                             or any(w.get("clip") == "voz" for w in p.get("words", []))):
        progress(0.62, "Dibujando subtítulos…")
        cap_track = build_caption_track(p, pl, work, geo, fps, hdr)

    # 4. Video final: transiciones, apoyos, logo, subtítulos
    if codec == "prores":
        work_fmt, afmt, ofmt = "yuv422p10le", "yuva422p10le", "yuv422p10"
    elif hdr:
        work_fmt, afmt, ofmt = "yuv420p10le", "yuva420p10le", "yuv420p10"
    else:
        work_fmt, afmt, ofmt = "yuv420p", "yuva420p", "yuv420"
    cmd, g = [], []
    seq = [(str(f), itm["dur"], itm["tdur"], itm.get("ttype")) for f, itm in zip(piece_files, items)]
    if len(seq) > CHUNK:
        # videos largos: se arma por bloques (si no, ffmpeg abre todo a la vez y se queda sin memoria)
        progress(0.63, "Uniendo las tomas…")
        seq = [(str(assemble_seq(seq, work, fps, work_fmt, work_fmt != "yuv420p")), sum(x[1] for x in seq) - sum(x[2] for x in seq[1:]), 0, None)]
    for i, (f, *_r) in enumerate(seq):
        cmd += ["-i", f]
        g.append(f"[{i}:v]fps={fps},settb=AVTB,setpts=PTS-STARTPTS,format={work_fmt}[p{i}]")
    cur = xfade_chain(g, seq)
    nxt = len(seq)
    for k, (f, at, bd) in enumerate(broll_files):
        cmd += ["-i", str(f)]
        g.append(f"[{nxt}:v]fps={fps},format={work_fmt},setpts=PTS-STARTPTS+{at:.4f}/TB[b{k}]")
        g.append(f"{cur}[b{k}]overlay=0:0:eof_action=pass:enable='between(t,{at:.4f},{at + bd - 0.001:.4f})'[ob{k}]")
        cur = f"[ob{k}]"
        nxt += 1
    lg = st.get("logo", {})
    logo_path = brand_dir(kit["id"]) / kit["logo"] if kit.get("id") and kit.get("logo") else None
    if lg.get("on") and logo_path and logo_path.exists():
        cmd += ["-loop", "1", "-t", f"{total:.3f}", "-i", str(logo_path)]
        lw = even(geo["W"] * float(lg.get("size", 0.14)))
        mg = int(48 * geo["k"])
        pos = lg.get("pos", "arriba-derecha")
        side = pos.split("-")[1] if "-" in pos else "derecha"
        x = {"izquierda": f"{mg}", "centro": "(W-w)/2", "derecha": f"W-w-{mg}"}.get(side, f"W-w-{mg}")
        tall = geo["H"] > geo["W"] * 1.05
        y = f"{int(geo['top'] * 0.5) if tall else mg}" if pos.startswith("arriba") else \
            f"H-h-{int(geo['bottom'] * 0.45) if tall else mg}"
        g.append(f"[{nxt}:v]scale={lw}:-2,format=rgba,colorchannelmixer=aa={float(lg.get('opacity', 0.9)):.2f}[lg]")
        g.append(f"{cur}[lg]overlay={x}:{y}:format={ofmt}:eof_action=pass[olg]")
        cur = "[olg]"
        nxt += 1
    for k_, (f, at, ad) in enumerate(anim_files):
        cmd += ["-i", str(f)]
        g.append(f"[{nxt}:v]fps={fps},format={afmt},setpts=PTS-STARTPTS+{at:.4f}/TB[an{k_}]")
        g.append(f"{cur}[an{k_}]overlay=0:0:eof_action=pass:format={ofmt}:enable='between(t,{at:.4f},{at + ad - 0.001:.4f})'[oan{k_}]")
        cur = f"[oan{k_}]"
        nxt += 1
    if cap_track is not None:
        cmd += ["-f", "concat", "-safe", "0", "-i", str(cap_track)]
        matrix = "bt2020" if hdr else "bt709"
        g.append(f"[{nxt}:v]fps={fps},format=rgba,scale=out_color_matrix={matrix}:out_range=tv,format={afmt}[cap]")
        g.append(f"{cur}[cap]overlay=0:0:eof_action=pass:format={ofmt}[ocap]")
        cur = "[ocap]"
        nxt += 1
    g.append(f"{cur}format={work_fmt}[v]")
    cmd += ["-i", str(mix)]
    if loud:
        g.append(f"[{nxt}:a]loudnorm=I=-14:TP=-1.5:LRA=11:measured_I={loud['input_i']}:measured_TP={loud['input_tp']}"
                 f":measured_LRA={loud['input_lra']}:measured_thresh={loud['input_thresh']}"
                 f":offset={loud['target_offset']}:linear=true,aresample=48000[a]")
    elif opts.get("loudnorm", True):  # la vista previa también se oye al volumen de redes
        g.append(f"[{nxt}:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]")
    else:
        g.append(f"[{nxt}:a]anull[a]")
    gfile = work / "final.txt"
    gfile.write_text(";\n".join(g), encoding="utf-8")
    cmd += graph_args(gfile) + ["-map", "[v]", "-map", "[a]"]

    color = (["-color_primaries", "bt2020", "-color_trc", trc, "-colorspace", "bt2020nc", "-color_range", "tv"] if hdr
             else ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"])
    vt_rate = f"{max(2, int(geo['W'] * geo['H'] * fps * bpp / 1e6))}M"
    result = {"fps": fps, "size_px": f"{geo['W']}x{geo['H']}", "hdr": hdr, "duration": round(total, 2)}
    if codec == "prores":
        cmd += ["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", "-pix_fmt", "yuv422p10le"]
        result["codec"] = "ProRes 422 HQ"
    elif hdr:
        if has_encoder("libx265"):
            cmd += ["-c:v", "libx265", "-preset", preset, "-crf", str(crf), "-x265-params",
                    f"colorprim=bt2020:transfer={trc}:colormatrix=bt2020nc:range=limited:log-level=error"]
        else:
            cmd += ["-c:v", "hevc_videotoolbox", "-profile:v", "main10", "-b:v", vt_rate]
        cmd += ["-pix_fmt", "yuv420p10le", "-tag:v", "hvc1"]
        result["codec"] = "HEVC 10-bit HDR"
    else:
        if has_encoder("libx264"):
            cmd += ["-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-profile:v", "high",
                    "-x264-params", "aq-mode=3"]
        else:
            cmd += ["-c:v", "h264_videotoolbox", "-b:v", vt_rate, "-profile:v", "high"]
        cmd += ["-pix_fmt", "yuv420p"]
        result["codec"] = "H.264"
    cmd += color + ["-r", str(fps), "-t", f"{total:.4f}"]
    cmd += (["-c:a", "pcm_s24le"] if codec == "prores" else ["-c:a", "aac", "-b:a", abr]) + ["-ar", "48000"]
    if out_file.suffix == ".mp4":
        cmd += ["-movflags", "+faststart"]
    cmd += [str(tmp_out)]
    progress(0.65, "Renderizando…")
    try:
        run_ffmpeg(cmd, total=total, progress=progress, base=0.65, span=0.34)
    except Exception:
        try:
            tmp_out.unlink()
        except Exception:
            pass
        raise
    os.replace(tmp_out, out_file)
    result.update(file=out_file.name, mp4=out_file.name, size=out_file.stat().st_size)
    if opts.get("srt") and not preview:
        srt = exp / (out_file.stem + ".srt")
        srt.write_text(build_srt(p, pl), encoding="utf-8")
        result["srt"] = srt.name
    return result


def export(p: dict, opts: dict, progress=lambda f, msg="": None) -> dict:
    return render(p, opts, progress)
