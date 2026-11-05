"""Reel Studio — motor de edición.

Todo lo que toca archivos de video vive aquí: proyectos, transcripción,
limpieza automática, cálculo de cortes, subtítulos (ASS/SRT) y exportación.
Lo usan tanto el servidor (interfaz) como reel.py (la línea de comandos que
usa Claude), así que las dos vías editan exactamente el mismo proyecto.
"""
from __future__ import annotations

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
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

FPS_DEFAULT = 30

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock(pid: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(pid, threading.Lock())


# ---------------------------------------------------------------- herramientas

def which(name: str) -> str | None:
    exe = name + (".exe" if IS_WIN else "")
    bundled = Path(__file__).resolve().parent.parent / "runtime" / "ffmpeg" / "bin" / exe
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


def ffmpeg_major() -> int:
    try:
        out = subprocess.run([FFMPEG, "-version"], capture_output=True, text=True).stdout
        if re.search(r"ffmpeg version N-", out):   # compilación del día: la más nueva
            return 99
        m = re.search(r"ffmpeg version n?(\d+)", out)
        return int(m.group(1)) if m else 6
    except Exception:
        return 6


def has_filter(name: str) -> bool:
    try:
        out = subprocess.run([FFMPEG, "-hide_banner", "-filters"], capture_output=True, text=True).stdout
        return f" {name} " in out
    except Exception:
        return False


def has_encoder(name: str) -> bool:
    try:
        out = subprocess.run([FFMPEG, "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
        return f" {name} " in out
    except Exception:
        return False


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

DEFAULT_SETTINGS = {
    "removeSilences": True,
    "maxPause": 0.30,     # pausas más largas que esto se acortan
    "padding": 0.06,      # aire antes/después de cada palabra
    "subtitles": True,
    "format": "vertical",  # vertical | horizontal | 4:5 | cuadrado
    "fit": "llenar",       # llenar (recorta) | difuminado (fondo borroso)
    "cropX": 0.5,          # dónde cae el recorte: 0 = izquierda, 1 = derecha
    "cropY": 0.5,
}

FORMATS = {
    "vertical":   {"label": "Vertical 9:16", "w": 1080, "h": 1920},
    "horizontal": {"label": "Horizontal 16:9", "w": 1920, "h": 1080},
    "4:5":        {"label": "Feed 4:5", "w": 1080, "h": 1350},
    "cuadrado":   {"label": "Cuadrado 1:1", "w": 1080, "h": 1080},
}


def geometry(fmt: str, uhd: bool = False) -> dict:
    """Tamaño de salida y zonas seguras para los subtítulos. 'k' escala todo a partir de 1080."""
    f = FORMATS.get(fmt, FORMATS["vertical"])
    m = 2 if uhd else 1
    W, H = f["w"] * m, f["h"] * m
    k = min(W, H) / 1080
    tall = H > W
    return {"W": W, "H": H, "k": k,
            # en vertical se deja libre la zona de botones y descripción de Reels/TikTok
            "bottom": H * (0.224 if tall else 0.085), "top": H * (0.156 if tall else 0.08),
            "maxw": W - 2 * 90 * k if tall or W == H else W * 0.72}


def default_style(preset: str = "impacto") -> dict:
    s = dict(PRESETS.get(preset, PRESETS["impacto"]))
    s["preset"] = preset
    s.pop("label", None)
    s.pop("desc", None)
    return s


# ---------------------------------------------------------------- proyectos

def project_dir(pid: str) -> Path:
    if not re.fullmatch(r"[a-z0-9\-]{4,64}", pid or ""):
        raise ValueError("id de proyecto inválido")
    return PROJECTS_DIR / pid


def load(pid: str) -> dict:
    with open(project_dir(pid) / "project.json", encoding="utf-8") as f:
        p = json.load(f)
    p["settings"] = {**DEFAULT_SETTINGS, **(p.get("settings") or {})}
    return p


def save(p: dict, base_rev: int | None = None) -> dict:
    """Guarda con control de versión. Si base_rev no coincide, lanza Conflict."""
    pid = p["id"]
    with _lock(pid):
        path = project_dir(pid) / "project.json"
        if base_rev is not None and path.exists():
            cur = json.loads(path.read_text(encoding="utf-8"))
            if cur.get("rev", 0) != base_rev:
                raise Conflict(cur)
        p["rev"] = int(p.get("rev", 0)) + 1 if base_rev is None else base_rev + 1
        p["updated"] = time.time()
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(p, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, path)
        return p


def update(pid: str, fn) -> dict:
    """Lee-modifica-escribe atómico (lo usa la línea de comandos de Claude)."""
    with _lock(pid):
        p = load(pid)
        fn(p)
        p["rev"] = int(p.get("rev", 0)) + 1
        p["updated"] = time.time()
        path = project_dir(pid) / "project.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(p, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, path)
        return p


class Conflict(Exception):
    def __init__(self, current):
        super().__init__("conflict")
        self.current = current


def list_projects() -> list[dict]:
    out = []
    for d in PROJECTS_DIR.iterdir():
        f = d / "project.json"
        if f.exists():
            try:
                p = json.loads(f.read_text(encoding="utf-8"))
                out.append({
                    "id": p["id"], "name": p["name"], "created": p.get("created", 0),
                    "updated": p.get("updated", 0), "status": p.get("status"),
                    "duration": p.get("duration", 0), "outDuration": output_duration(p),
                })
            except Exception:
                pass
    return sorted(out, key=lambda x: -x["updated"])


def slug(text: str) -> str:
    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    t = re.sub(r"[^a-zA-Z0-9]+", "-", t).strip("-").lower()
    return t[:30] or "video"


def create_project(name: str, src_ext: str = ".mp4") -> tuple[dict, Path]:
    pid = f"{slug(name)}-{uuid.uuid4().hex[:6]}"
    d = project_dir(pid)
    (d / "exports").mkdir(parents=True, exist_ok=True)
    p = {
        "id": pid, "name": name, "created": time.time(), "updated": time.time(), "rev": 0,
        "source": "source" + src_ext.lower(), "status": "subiendo",
        "duration": 0, "width": 0, "height": 0, "fps": 30,
        "words": [], "settings": dict(DEFAULT_SETTINGS), "style": default_style(),
        "log": [],
    }
    (d / "project.json").write_text(json.dumps(p, ensure_ascii=False, indent=1), encoding="utf-8")
    return p, d / p["source"]


def delete_project(pid: str):
    shutil.rmtree(project_dir(pid), ignore_errors=True)


def add_log(p: dict, who: str, text: str):
    p.setdefault("log", []).append({"t": time.time(), "who": who, "text": text})
    p["log"] = p["log"][-60:]


# ---------------------------------------------------------------- medios

def probe(path: Path) -> dict:
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
        capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    v = next((s for s in j["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in j["streams"] if s["codec_type"] == "audio"), None)
    if not v:
        raise RuntimeError("El archivo no tiene video.")
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
    dur = float(j["format"].get("duration") or v.get("duration") or 0)
    trc = v.get("color_transfer", "") or ""
    return {"width": w, "height": h, "fps": round(fps, 3), "duration": dur, "hasAudio": a is not None,
            "vcodec": v.get("codec_name", ""), "pixfmt": v.get("pix_fmt", ""),
            "color": {"transfer": trc, "primaries": v.get("color_primaries", "") or "",
                      "space": v.get("color_space", "") or "", "range": v.get("color_range", "") or ""},
            "hdr": trc in ("arib-std-b67", "smpte2084")}


BROWSER_OK = {"h264", "hevc", "vp9", "av1", "vp8"}


def needs_proxy(p: dict) -> bool:
    return p.get("vcodec") not in BROWSER_OK or "10" in p.get("pixfmt", "") and p.get("vcodec") == "h264"


def make_proxy(p: dict):
    """Copia liviana para la vista previa cuando el navegador no puede abrir el original (ProRes, etc.)."""
    d = project_dir(p["id"])
    tmp, out = d / "proxy.tmp.mp4", d / "proxy.mp4"
    enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26"] if has_encoder("libx264") \
        else ["-c:v", "h264_videotoolbox", "-b:v", "3M"]
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(d / p["source"]), "-vf", "scale=-2:960",
                    *enc, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
                    str(tmp)], check=True)
    os.replace(tmp, out)


def make_previews(p: dict):
    """Tira de fotogramas, forma de onda y (si hace falta) copia para la vista previa."""
    d = project_dir(p["id"])
    if needs_proxy(p):
        try:
            make_proxy(p)
        except Exception:
            pass
    src = d / p["source"]
    dur = max(p["duration"], 0.1)
    n = 40
    try:
        subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(src), "-vf",
                        f"fps={n/dur:.5f},scale=-2:96,crop=54:96,tile={n}x1", "-frames:v", "1",
                        "-q:v", "5", str(d / "strip.jpg")], check=True)
    except Exception:
        pass
    if p.get("hasAudio", True):
        try:
            subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(src), "-filter_complex",
                            "aformat=channel_layouts=mono,showwavespic=s=2000x120:colors=#1f6f5c|#1f6f5c:scale=sqrt",
                            "-frames:v", "1", str(d / "wave.png")], check=True)
        except Exception:
            pass


def extract_audio(p: dict) -> Path:
    d = project_dir(p["id"])
    wav = d / "audio.wav"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(d / p["source"]), "-vn", "-ac", "1",
                    "-ar", "16000", "-c:a", "pcm_s16le", str(wav)], check=True)
    return wav


# ---------------------------------------------------------------- transcripción

INITIAL_PROMPT = ("Eh, bueno, mmm... este, o sea, a ver. Hola, ¿qué tal? "
                  "Transcribe todo tal cual, con muletillas y repeticiones.")


def transcribe(p: dict, progress=lambda f, msg="": None, language="es") -> list[dict]:
    wav = extract_audio(p)
    dur = max(p.get("duration", 1), 1)
    words: list[dict] = []
    engine_used = None
    try:
        import mlx_whisper  # Apple Silicon (M1–M4)
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
    out = []
    for i, w in enumerate(words):
        t = w["text"].strip()
        if not t:
            continue
        e = max(w["end"], w["start"] + 0.04)
        out.append({"id": len(out), "text": t, "orig": t, "start": round(w["start"], 3),
                    "end": round(e, 3), "prob": round(w["prob"], 3), "cut": False,
                    "reason": "", "by": "", "suggest": ""})
    # Las palabras no deben solaparse (whisper a veces lo hace)
    for a, b in zip(out, out[1:]):
        if b["start"] < a["end"]:
            mid = (a["end"] + b["start"]) / 2
            a["end"], b["start"] = round(max(a["start"] + 0.02, mid), 3), round(mid, 3)
    try:
        wav.unlink()
    except Exception:
        pass
    p["engine"] = engine_used
    return out


def _nvidia_dll_dirs():
    import site
    out = []
    for sp in site.getsitepackages() + [site.getusersitepackages()]:
        base = Path(sp) / "nvidia"
        if base.exists():
            out += [p for p in base.glob("*/bin") if p.is_dir()]
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
            if w["start"] - prev["end"] > gap or re.search(r"[.?!…]$", prev["text"]):
                out.append(cur)
                cur = []
        cur.append(i)
    if cur:
        out.append(cur)
    return out


def autoclean(p: dict, who="auto") -> dict:
    """Marca muletillas, palabras repetidas y arranques en falso.
    Respeta lo que el usuario o Claude ya decidieron a mano."""
    words = p["words"]
    for w in words:
        if w.get("by") == "auto":
            w["cut"], w["reason"], w["by"] = False, "", ""
        w["suggest"] = ""
    stats = {"muletilla": 0, "repetición": 0, "toma repetida": 0}

    def cut(i, reason):
        w = words[i]
        if w.get("by") in ("user", "claude", "keep"):
            return
        if not w["cut"]:
            stats[reason] = stats.get(reason, 0) + 1
        w["cut"], w["reason"], w["by"] = True, reason, "auto"

    n = [norm(w["text"]) for w in words]
    for i, w in enumerate(words):
        if n[i] in FILLERS_SURE:
            cut(i, "muletilla")
        elif n[i] in FILLERS_MAYBE:
            gap_after = words[i + 1]["start"] - w["end"] if i + 1 < len(words) else 1
            gap_before = w["start"] - words[i - 1]["end"] if i else 1
            if re.search(r"[,.…]$", w["text"]) or gap_after > 0.25 or gap_before > 0.25:
                w["suggest"] = "posible muletilla"
        if i + 1 < len(words) and n[i] and n[i] == n[i + 1] and len(n[i]) > 1 \
                and words[i + 1]["start"] - w["end"] < 0.8:
            cut(i, "repetición")
    # "o sea"
    for i in range(len(words) - 1):
        if n[i] == "o" and n[i + 1] == "sea":
            words[i]["suggest"] = words[i + 1]["suggest"] = "posible muletilla"

    # Arranques en falso: una frase que empieza igual que una de las dos siguientes
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


# ---------------------------------------------------------------- cortes

def segments(p: dict) -> list[list[float]]:
    """Tramos del video original que se conservan, en orden."""
    words, st = p["words"], p["settings"]
    dur = p.get("duration", 0) or 1e9
    pad = float(st.get("padding", 0.06))
    max_pause = float(st.get("maxPause", 0.3)) if st.get("removeSilences", True) else 1e9
    segs: list[list[float]] = []
    prev_kept = None
    for i, w in enumerate(words):
        if w["cut"]:
            continue
        s, e = w["start"] - pad, w["end"] + pad
        if i > 0 and words[i - 1]["cut"]:
            s = max(s, words[i - 1]["end"])
        if i + 1 < len(words) and words[i + 1]["cut"]:
            e = min(e, words[i + 1]["start"])
        s, e = max(0.0, s), min(dur, e)
        adjacent = prev_kept is not None and prev_kept == i - 1
        if segs and adjacent and (w["start"] - words[i - 1]["end"]) <= max_pause:
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


def output_duration(p: dict) -> float:
    try:
        return round(sum(b - a for a, b in segments(p)), 2)
    except Exception:
        return 0


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


# ---------------------------------------------------------------- subtítulos

FONT_FILES = {"Poppins Black": "Poppins-Black.ttf", "Poppins ExtraBold": "Poppins-ExtraBold.ttf",
              "Poppins": "Poppins-Bold.ttf", "Anton": "Anton-Regular.ttf", "Bebas Neue": "BebasNeue-Regular.ttf"}
# Tamaño "estilo ASS" (altura de celda) → em real de cada letra; la vista previa usa lo mismo.
FONT_EM = {"Poppins Black": 0.568, "Poppins ExtraBold": 0.568, "Poppins": 0.568, "Anton": 0.577, "Bebas Neue": 0.769}
LINE_H = 1.12


def caption_groups(p: dict, segs) -> list[list[dict]]:
    st = p["style"]
    fmap, _total = time_mapper(segs)
    kept = []
    for w in p["words"]:
        if w["cut"]:
            continue
        s, e = fmap(w["start"]), fmap(w["end"])
        if e - s < 0.02:
            continue
        kept.append({"text": w["text"], "s": s, "e": e})
    max_words = max(1, int(st.get("maxWords", 3)))
    max_chars = 16 if st.get("size", 80) >= 150 else (34 if st.get("box") else 26)
    if p["settings"].get("format") == "horizontal":
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


def build_srt(p: dict, segs) -> str:
    groups = caption_groups(p, segs)

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
    """Dibuja cada estado del subtítulo como PNG transparente del tamaño del video."""

    def __init__(self, st: dict, geo: dict, hdr: bool = False):
        from PIL import ImageFont
        self.st, self.geo, self.hdr = st, geo, hdr
        self.fontfile = str(FONTS_DIR / FONT_FILES.get(st.get("font"), "Poppins-Black.ttf"))
        self.px = float(st.get("size", 100)) * FONT_EM.get(st.get("font"), 0.568) * geo["k"]
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
        if self.hdr:  # en HLG, el blanco de referencia es ~75 %: así no deslumbra
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


def build_caption_track(p: dict, segs, work: Path, geo: dict, fps: int, hdr: bool) -> Path:
    """Imágenes de subtítulo + lista ffconcat cuadrada a la cuadrícula de fotogramas."""
    from PIL import Image
    st = p["style"]
    groups = caption_groups(p, segs)
    total_frames = int(round(sum(b - a for a, b in segs) * fps))
    painter = CaptionPainter(st, geo, hdr)
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
    blank = work / "cap_blank.png"
    Image.new("RGBA", (geo["W"], geo["H"]), (0, 0, 0, 0)).save(blank)
    cache: dict = {}
    lines = ["ffconcat version 1.0"]
    cur = 0

    def add(path, frames):
        if frames > 0:
            lines.append(f"file '{path.name}'")
            lines.append(f"duration {frames / fps:.6f}")

    for fs, fe, key in states:
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


# ---------------------------------------------------------------- exportar

QUALITY = {
    #           x264/x265 preset, crf, audio, bits/píxel para VideoToolbox
    "maxima":  ("slow", 16, "320k", 0.22),
    "alta":    ("medium", 18, "256k", 0.15),
    "liviana": ("veryfast", 22, "192k", 0.08),
}


def pick_fps(p: dict, want) -> int:
    if want in (24, 25, 30, 50, 60, "24", "25", "30", "50", "60"):
        return int(want)
    src = float(p.get("fps") or 30)
    return min((24, 25, 30, 50, 60), key=lambda f: abs(f - src))


def even(x: float) -> int:
    return max(2, int(round(x / 2)) * 2)


def framing_chain(p: dict, geo: dict, hdr: bool) -> str:
    st = p["settings"]
    W, H = geo["W"], geo["H"]
    cx = min(1, max(0, float(st.get("cropX", 0.5))))
    cy = min(1, max(0, float(st.get("cropY", 0.5))))
    sw, sh = p.get("width") or W, p.get("height") or H
    same = abs(sw / sh - W / H) < 0.01
    if same or st.get("fit", "llenar") == "llenar":
        return (f"scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,"
                f"crop={W}:{H}:(iw-ow)*{cx:.4f}:(ih-oh)*{cy:.4f},setsar=1")
    bw, bh = even(W / 8), even(H / 8)
    tone = "" if hdr else ",eq=brightness=-0.05:saturation=1.08"
    return (f"split=2[fg][bg];[bg]scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},"
            f"gblur=sigma=5{tone},scale={W}:{H}:flags=bicubic[bgb];"
            f"[fg]scale={W}:{H}:force_original_aspect_ratio=decrease:flags=lanczos[fgs];"
            f"[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1")


def audio_chain(segs) -> list[str]:
    n = len(segs)
    out = [f"[0:a]asetpts=PTS-STARTPTS,aresample=48000,asplit={n}" + "".join(f"[as{i}]" for i in range(n))]
    for i, (a, b) in enumerate(segs):
        dd = b - a
        fade = min(0.012, dd / 4)
        out.append(f"[as{i}]atrim=start={a:.4f}:end={b:.4f},asetpts=PTS-STARTPTS,"
                   f"afade=t=in:d={fade:.4f},afade=t=out:st={dd - fade:.4f}:d={fade:.4f}[a{i}]")
    out.append("".join(f"[a{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1[acat]")
    return out


def graph_args(gfile: Path) -> list[str]:
    return ["-/filter_complex", str(gfile)] if ffmpeg_major() >= 7 else ["-filter_complex_script", str(gfile)]


def measure_loudness(src: Path, segs, work: Path) -> dict | None:
    """Primera pasada de loudnorm (solo audio, rápida) para normalizar con precisión."""
    g = audio_chain(segs) + ["[acat]loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json[aout]"]
    gf = work / "loud.txt"
    gf.write_text(";\n".join(g), encoding="utf-8")
    r = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-vn", "-i", str(src), *graph_args(gf),
                        "-map", "[aout]", "-f", "null", "-"], capture_output=True, text=True)
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr, re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
        if d.get("input_i") in ("-inf", None):
            return None
        return d
    except Exception:
        return None


def export(p: dict, opts: dict, progress=lambda f, msg="": None) -> dict:
    d = project_dir(p["id"])
    src = d / p["source"]
    st = p["settings"]
    fmt = opts.get("format") or st.get("format", "vertical")
    p = dict(p, settings=dict(st, format=fmt))
    uhd = bool(opts.get("uhd"))
    geo = geometry(fmt, uhd)
    W, H = geo["W"], geo["H"]
    fps = pick_fps(p, opts.get("fps", "auto"))
    q = opts.get("quality", "alta")
    if q not in QUALITY:
        q = "alta"
    preset, crf, abr, bpp = QUALITY[q]
    codec = opts.get("codec", "h264")
    hdr = bool(p.get("hdr"))
    trc = (p.get("color") or {}).get("transfer") or "arib-std-b67"

    segs = snap(segments(p), fps)
    if not segs:
        raise RuntimeError("No quedó nada del video: todas las palabras están tachadas.")
    total = sum(b - a for a, b in segs)
    exp = d / "exports"
    exp.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    tag = {"vertical": "9x16", "horizontal": "16x9", "4:5": "4x5", "cuadrado": "1x1"}.get(fmt, fmt)
    base = f"{slug(p['name'])}-{tag}-{fps}fps-{stamp}"
    ext = ".mov" if codec == "prores" else ".mp4"
    out_file = exp / f"{base}{ext}"
    work = d / "work"
    work.mkdir(exist_ok=True)
    for old in work.glob("cap_*.png"):
        old.unlink()

    result = {"file": out_file.name, "mp4": out_file.name, "duration": round(total, 2), "fps": fps,
              "size_px": f"{W}x{H}", "hdr": hdr}
    if opts.get("srt"):
        srt = exp / f"{base}.srt"
        srt.write_text(build_srt(p, segs), encoding="utf-8")
        result["srt"] = srt.name

    subs = opts.get("subtitles", st.get("subtitles", True)) and any(not w["cut"] for w in p["words"])
    cap_track = None
    if subs:
        progress(0.005, "Dibujando subtítulos…")
        cap_track = build_caption_track(p, segs, work, geo, fps, hdr)

    has_audio = p.get("hasAudio", True)
    loud = None
    if has_audio and opts.get("loudnorm", True):
        progress(0.01, "Midiendo el volumen…")
        loud = measure_loudness(src, segs, work)

    if codec == "prores":
        work_fmt, afmt, ofmt = "yuv422p10le", "yuva422p10le", "yuv422p10"
    elif hdr:
        work_fmt, afmt, ofmt = "yuv420p10le", "yuva420p10le", "yuv420p10"
    else:
        work_fmt, afmt, ofmt = "yuv420p", "yuva420p", "yuv420"
    sel = "+".join(f"between(t,{a:.4f},{b - 0.0005:.4f})" for a, b in segs)
    v = (f"[0:v]setpts=PTS-STARTPTS,fps={fps},select='{sel}',setpts=N/{fps}/TB,"
         + framing_chain(p, geo, hdr))
    graph = []
    if cap_track is not None:
        matrix = "bt2020" if hdr else "bt709"
        graph.append(v + f",format={work_fmt}[base]")
        graph.append(f"[1:v]fps={fps},format=rgba,scale=out_color_matrix={matrix}:out_range=tv,format={afmt}[cap]")
        graph.append(f"[base][cap]overlay=0:0:eof_action=pass:format={ofmt},format={work_fmt}[v]")
    else:
        graph.append(v + f",format={work_fmt}[v]")
    if has_audio:
        graph += audio_chain(segs)
        if loud:
            graph.append(f"[acat]loudnorm=I=-14:TP=-1.5:LRA=11:measured_I={loud['input_i']}:"
                         f"measured_TP={loud['input_tp']}:measured_LRA={loud['input_lra']}:"
                         f"measured_thresh={loud['input_thresh']}:offset={loud['target_offset']}:linear=true,"
                         f"aresample=48000[a]")
        elif opts.get("loudnorm", True):
            graph.append("[acat]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]")
        else:
            graph.append("[acat]anull[a]")
    gfile = work / "graph.txt"
    gfile.write_text(";\n".join(graph), encoding="utf-8")

    cmd = [FFMPEG, "-hide_banner", "-y", "-i", str(src)]
    if cap_track is not None:
        cmd += ["-f", "concat", "-safe", "0", "-i", str(cap_track)]
    cmd += graph_args(gfile) + ["-map", "[v]"] + (["-map", "[a]"] if has_audio else [])

    if hdr:
        color = ["-color_primaries", "bt2020", "-color_trc", trc, "-colorspace", "bt2020nc", "-color_range", "tv"]
    else:
        color = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"]
    vt_rate = f"{max(4, int(W * H * fps * bpp / 1e6))}M"
    if codec == "prores":
        cmd += ["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", "-pix_fmt", "yuv422p10le"]
        result["codec"] = "ProRes 422 HQ"
    elif hdr:
        if has_encoder("libx265"):
            x265p = f"colorprim=bt2020:transfer={trc}:colormatrix=bt2020nc:range=limited"
            cmd += ["-c:v", "libx265", "-preset", preset, "-crf", str(crf), "-x265-params", x265p]
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
    cmd += color + ["-r", str(fps)]
    if has_audio:
        cmd += (["-c:a", "pcm_s24le"] if codec == "prores" else ["-c:a", "aac", "-b:a", abr]) + ["-ar", "48000"]
    if ext == ".mp4":
        cmd += ["-movflags", "+faststart"]
    cmd += ["-progress", "pipe:1", "-nostats", str(out_file)]

    progress(0.02, "Renderizando…")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    err_tail: list[str] = []

    def read_err():
        for line in proc.stderr:
            err_tail.append(line)
            del err_tail[:-40]
    t = threading.Thread(target=read_err, daemon=True)
    t.start()
    for line in proc.stdout:
        if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
            try:
                us = int(line.split("=")[1])
                progress(min(0.99, 0.02 + 0.97 * us / 1e6 / max(total, 0.1)), "Renderizando…")
            except ValueError:
                pass
    proc.wait()
    t.join(timeout=2)
    if proc.returncode != 0:
        try:
            out_file.unlink()
        except Exception:
            pass
        raise RuntimeError("ffmpeg falló:\n" + "".join(err_tail[-15:]))
    result["size"] = out_file.stat().st_size
    return result
