"""Animaciones (títulos, textos, nombres, llamadas a la acción, datos) hechas con HyperFrames.

Cada animación es una página HTML con GSAP. La misma página se usa para:
  - la vista previa en vivo dentro de Reel Studio (un iframe que se adelanta al tiempo del video), y
  - el render final: HyperFrames la graba con fondo transparente (ProRes 4444) y ffmpeg la pone encima.

HyperFrames necesita Node 22 y un Chrome sin ventana. Reel Studio los descarga solo, una vez,
dentro de ~/ReelStudio/runtime/anim (nada se instala en el resto de la computadora).
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import platform
import shutil
import subprocess
import tarfile
import tempfile
import threading
import urllib.request
from pathlib import Path

import engine as E

HF_VERSION = "0.9.18"
NODE_DIST = "https://nodejs.org/dist/latest-v22.x/"
RUNTIME = E.HOME / "runtime" / "anim"
STATIC = E.APP_DIR / "static"
_install_lock = threading.Lock()

KINDS = {
    "titulo":  {"label": "Título", "dur": 3.0, "pos": "centro", "text": "Tu título aquí", "sub": ""},
    "frase":   {"label": "Frase destacada", "dur": 2.5, "pos": "arriba", "text": "Dato clave", "sub": ""},
    "nombre":  {"label": "Nombre y cargo", "dur": 4.0, "pos": "abajo", "text": "Tu nombre", "sub": "Lo que haces"},
    "llamada": {"label": "Llamada a la acción", "dur": 3.5, "pos": "abajo", "text": "Sígueme para más", "sub": ""},
    "dato":    {"label": "Número que sube", "dur": 3.0, "pos": "centro", "text": "100", "sub": "clientes felices"},
    "ubicacion": {"label": "Ubicación", "dur": 3.5, "pos": "arriba", "text": "Tu ciudad", "sub": "Referencia del lugar"},
    "marcador": {"label": "Pin en la toma", "dur": 4.0, "pos": "centro", "text": "Tu lugar", "sub": "Referencia"},
}
POSITIONS = ("arriba", "centro", "abajo")


# ---------------------------------------------------------------- instalación (una sola vez)
def _node_candidates():
    yield RUNTIME / "node" / "bin" / "node"
    yield RUNTIME / "node" / "node.exe"
    sysnode = shutil.which("node")
    if sysnode:
        yield Path(sysnode)


def node_bin() -> Path | None:
    for n in _node_candidates():
        if n.exists():
            try:
                v = subprocess.run([str(n), "-v"], capture_output=True, text=True, timeout=10).stdout.strip()
                if int(v.lstrip("v").split(".")[0]) >= 22:
                    return n
            except Exception:
                pass
    return None


def hf_cli() -> Path:
    return RUNTIME / "hf" / "node_modules" / "hyperframes" / "bin" / "hyperframes.mjs"


def status() -> dict:
    ok = (RUNTIME / "ok.json").exists() and hf_cli().exists() and node_bin() is not None
    return {"ready": ok, "installing": _install_lock.locked(), "version": HF_VERSION}


def _env() -> dict:
    env = dict(os.environ)
    n = node_bin()
    if n:
        env["PATH"] = str(n.parent) + os.pathsep + env.get("PATH", "")
    env.update(HYPERFRAMES_FFMPEG_PATH=E.FFMPEG, HYPERFRAMES_FFPROBE_PATH=E.FFPROBE, HYPERFRAMES_SKIP_SKILLS="1",
               DO_NOT_TRACK="1", HYPERFRAMES_TELEMETRY="0", HYPERFRAMES_RENDER_LOCK="off")
    return env


def _download(url: str, dest: Path, progress=None, base=0.0, span=0.0, msg=""):
    req = urllib.request.Request(url, headers={"User-Agent": "ReelStudio"})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        got = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if progress and total:
                progress(base + span * got / total, f"{msg} {got // (1 << 20)} de {total // (1 << 20)} MB")


def _node_platform() -> str:
    m = platform.machine().lower()
    arch = "arm64" if m in ("arm64", "aarch64") else "x64"
    if os.sys.platform == "darwin":
        return f"darwin-{arch}"
    if os.name == "nt":
        return f"win-{arch}"
    return f"linux-{arch}"


def install(progress=lambda f, m="": None) -> dict:
    """Descarga Node 22 (si hace falta), HyperFrames y su Chrome dentro de runtime/anim."""
    with _install_lock:
        if status()["ready"]:
            return status()
        RUNTIME.mkdir(parents=True, exist_ok=True)
        if node_bin() is None:
            plat = _node_platform()
            ext = ".zip" if plat.startswith("win") else ".tar.gz"
            progress(0.02, "Buscando Node…")
            sums = urllib.request.urlopen(NODE_DIST + "SHASUMS256.txt", timeout=30).read().decode()
            line = next(l for l in sums.splitlines() if l.endswith(f"-{plat}{ext}"))
            sha, name = line.split()
            with tempfile.TemporaryDirectory(dir=RUNTIME) as tmp:
                arc = Path(tmp) / name
                _download(NODE_DIST + name, arc, progress, 0.03, 0.3, "Descargando Node…")
                if hashlib.sha256(arc.read_bytes()).hexdigest() != sha:
                    raise RuntimeError("La descarga de Node llegó dañada. Intenta de nuevo.")
                progress(0.34, "Descomprimiendo…")
                if ext == ".zip":
                    import zipfile
                    zipfile.ZipFile(arc).extractall(tmp)
                else:
                    with tarfile.open(arc) as tf:
                        try:
                            tf.extractall(tmp, filter="data")
                        except TypeError:
                            tf.extractall(tmp)
                top = next(p for p in Path(tmp).iterdir() if p.is_dir())
                shutil.rmtree(RUNTIME / "node", ignore_errors=True)
                shutil.move(str(top), str(RUNTIME / "node"))
        n = node_bin()
        if n is None:
            raise RuntimeError("No pude preparar Node para las animaciones.")
        npm = n.parent.parent / "lib" / "node_modules" / "npm" / "bin" / "npm-cli.js"
        if not npm.exists():
            npm = n.parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
        hf = RUNTIME / "hf"
        hf.mkdir(exist_ok=True)
        (hf / "package.json").write_text('{"name":"reelstudio-anim","private":true}\n')
        progress(0.4, "Instalando HyperFrames…")
        cmd = [str(n), str(npm)] if npm.exists() else ["npm"]
        r = subprocess.run(cmd + ["install", f"hyperframes@{HF_VERSION}", "--no-audit", "--no-fund",
                                  "--loglevel=error"], cwd=hf, env=_env(), capture_output=True, text=True)
        if r.returncode != 0 or not hf_cli().exists():
            raise RuntimeError("No se pudo instalar HyperFrames: " + (r.stderr or r.stdout)[-400:])
        subprocess.run([str(n), str(hf_cli()), "telemetry", "disable"], cwd=hf, env=_env(), capture_output=True)
        if not os.environ.get("HYPERFRAMES_BROWSER_PATH"):
            progress(0.7, "Descargando el motor de dibujo (Chrome sin ventana)…")
            r = subprocess.run([str(n), str(hf_cli()), "browser", "ensure"], cwd=hf, env=_env(),
                               capture_output=True, text=True)
            if r.returncode != 0:
                raise RuntimeError("No se pudo descargar Chrome para las animaciones: " + (r.stderr or r.stdout)[-400:])
        (RUNTIME / "ok.json").write_text(json.dumps({"hyperframes": HF_VERSION}))
        progress(1.0, "Animaciones listas")
        return status()


# ---------------------------------------------------------------- plantillas
def _accent(p: dict, kit: dict) -> str:
    return ((kit.get("colors") or {}).get("accent") or p.get("style", {}).get("highlight") or "#FFE14D")


def _ink_on(hexcol: str) -> str:
    h = hexcol.lstrip("#")
    try:
        r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    except Exception:
        return "#111"
    return "#111111" if (0.299 * r + 0.587 * g + 0.114 * b) > 150 else "#FFFFFF"


def _fonts(kit: dict) -> tuple[str, list[tuple[Path, str]]]:
    """CSS @font-face y archivos a copiar. Marca con letra propia → esa; si no, Poppins."""
    files = []
    css = ""
    if kit.get("id") and kit.get("fontFile"):
        f = E.brand_dir(kit["id"]) / kit["fontFile"]
        if f.exists():
            files.append((f, "marca" + f.suffix))
            css += f"@font-face{{font-family:'Marca';src:url('marca{f.suffix}');}}\n"
            return css + ":root{--fd:'Marca';--fb:'Marca';--wd:400;--wb:400}", files
    for fam, fn, w in (("Poppins", "Poppins-Black.ttf", 900), ("Poppins", "Poppins-ExtraBold.ttf", 800),
                       ("Poppins", "Poppins-SemiBold.ttf", 600)):
        files.append((E.FONTS_DIR / fn, fn))
        css += f"@font-face{{font-family:'{fam}';src:url('{fn}');font-weight:{w};}}\n"
    return css + ":root{--fd:'Poppins';--fb:'Poppins';--wd:900;--wb:600}", files


def anim_defaults(kind: str) -> dict:
    k = KINDS.get(kind, KINDS["titulo"])
    return {"kind": kind if kind in KINDS else "titulo", "text": k["text"], "sub": k["sub"],
            "dur": k["dur"], "pos": k["pos"], "start": 0.0, "on": True}


def build_html(p: dict, a: dict, geo: dict, kit: dict) -> tuple[str, list[tuple[Path, str]]]:
    W, H, k = geo["W"], geo["H"], geo["k"]
    s = lambda v: f"{v * k:.1f}px"  # noqa: E731
    kind = a.get("kind", "titulo")
    dur = max(0.8, float(a.get("dur") or KINDS.get(kind, KINDS["titulo"])["dur"]))
    text = html.escape(str(a.get("text") or ""))
    sub = html.escape(str(a.get("sub") or ""))
    acc = _accent(p, kit)
    ink = _ink_on(acc)
    pos = a.get("pos") if a.get("pos") in POSITIONS else KINDS.get(kind, KINDS["titulo"])["pos"]
    tall = H > W * 1.05
    y = {"arriba": geo["top"] + (110 * k if tall else 60 * k),
         "centro": H * 0.44,
         "abajo": H - geo["bottom"] - (150 * k if tall else 80 * k)}[pos]
    font_css, files = _fonts(kit)
    maxw = W - 2 * 90 * k if tall else W * 0.72
    words = "".join(f'<span class="w"><span>{w}</span></span> ' for w in text.split())
    out = dur - 0.45

    if kind == "titulo":
        body = f'''<div id="a" class="c" style="top:{y:.0f}px"><div class="t">{words}</div><div class="bar"></div>
          {f'<div class="s">{sub}</div>' if sub else ''}</div>'''
        css = f'''.c{{position:absolute;left:50%;transform:translate(-50%,-50%);width:{maxw:.0f}px;text-align:center}}
        .t{{font-family:var(--fd);font-weight:var(--wd);font-size:{s(118)};line-height:1.02;letter-spacing:-.025em;color:#fff;
            text-shadow:0 {s(6)} {s(28)} rgba(0,0,0,.45)}}
        .w{{display:inline-block;overflow:hidden;vertical-align:top;padding:0 {s(2)} {s(8)}}} .w>span{{display:inline-block}}
        .bar{{height:{s(14)};width:{s(220)};margin:{s(18)} auto 0;border-radius:{s(8)};background:{acc};transform-origin:0 50%}}
        .s{{margin-top:{s(20)};font-family:var(--fb);font-weight:var(--wb);font-size:{s(46)};color:#fff;opacity:.92;
            text-shadow:0 {s(3)} {s(14)} rgba(0,0,0,.5)}}'''
        js = f'''tl.from("#a .w>span",{{yPercent:115,rotate:6,opacity:0,filter:"blur(10px)",duration:.62,ease:"power4.out",stagger:.07}},.05)
          .from("#a .bar",{{scaleX:0,duration:.55,ease:"expo.out"}},.3)
          .from("#a .s",{{y:{24 * k:.0f},opacity:0,duration:.5,ease:"power3.out"}},.45)
          .to("#a",{{opacity:0,y:-{30 * k:.0f},filter:"blur(8px)",duration:.42,ease:"power2.in"}},{out:.2f});'''
    elif kind == "frase":
        body = f'<div id="a" class="c" style="top:{y:.0f}px"><div class="box">{text}</div></div>'
        css = f'''.c{{position:absolute;left:50%;transform:translate(-50%,-50%);width:{maxw:.0f}px;text-align:center}}
        .box{{display:inline-block;padding:{s(18)} {s(34)} {s(22)};border-radius:{s(26)};background:{acc};color:{ink};
             font-family:var(--fd);font-weight:var(--wd);font-size:{s(86)};line-height:1.05;letter-spacing:-.02em;
             box-shadow:0 {s(18)} {s(50)} rgba(0,0,0,.35);transform:rotate(-2deg)}}'''
        js = f'''tl.from("#a .box",{{scale:.55,rotate:-9,opacity:0,duration:.6,ease:"back.out(2.4)"}},.02)
          .to("#a .box",{{scale:1.035,duration:.5,ease:"sine.inOut",yoyo:true,repeat:1}},.7)
          .to("#a .box",{{scale:.75,opacity:0,rotate:3,duration:.35,ease:"power2.in"}},{out + 0.1:.2f});'''
    elif kind == "nombre":
        x = 90 * k if tall else W * 0.08
        body = f'''<div id="a" class="c" style="top:{y:.0f}px;left:{x:.0f}px"><div class="bar"></div>
          <div class="txt"><div class="n"><span>{text}</span></div>{f'<div class="r"><span>{sub}</span></div>' if sub else ''}</div></div>'''
        css = f'''.c{{position:absolute;transform:translateY(-50%);display:flex;align-items:stretch;gap:{s(22)};
            padding:{s(22)} {s(34)} {s(24)} {s(24)};border-radius:{s(26)};background:rgba(12,12,14,.62)}}
        .bar{{width:{s(10)};border-radius:{s(6)};background:{acc};transform-origin:50% 100%}}
        .n,.r{{overflow:hidden}} .n>span,.r>span{{display:inline-block}}
        .n{{font-family:var(--fd);font-weight:var(--wd);font-size:{s(62)};color:#fff;letter-spacing:-.02em;line-height:1.1}}
        .r{{font-family:var(--fb);font-weight:var(--wb);font-size:{s(38)};color:#fff;opacity:.78;margin-top:{s(4)}}}'''
        js = f'''tl.from("#a",{{x:-{60 * k:.0f},opacity:0,duration:.55,ease:"power3.out"}},0)
          .from("#a .bar",{{scaleY:0,duration:.5,ease:"expo.out"}},.15)
          .from("#a .n>span",{{yPercent:110,duration:.55,ease:"power4.out"}},.22)
          .from("#a .r>span",{{yPercent:110,duration:.55,ease:"power4.out"}},.34)
          .to("#a",{{x:-{50 * k:.0f},opacity:0,duration:.4,ease:"power2.in"}},{out:.2f});'''
    elif kind == "llamada":
        body = f'''<div id="a" class="c" style="top:{y:.0f}px"><div class="pill"><span class="ic">
          <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="{ink}" stroke-width="3.2" stroke-linecap="round"/></svg></span>
          <span class="tx">{text}</span></div></div>'''
        css = f'''.c{{position:absolute;left:50%;transform:translate(-50%,-50%)}}
        .pill{{display:flex;align-items:center;gap:{s(20)};padding:{s(16)} {s(40)} {s(16)} {s(16)};border-radius:{s(999)};
              background:#fff;box-shadow:0 {s(20)} {s(60)} rgba(0,0,0,.4);white-space:nowrap}}
        .ic{{width:{s(76)};height:{s(76)};border-radius:50%;background:{acc};display:grid;place-items:center}}
        .ic svg{{width:{s(40)};height:{s(40)}}}
        .tx{{font-family:var(--fd);font-weight:var(--wd);font-size:{s(52)};color:#111;letter-spacing:-.015em}}'''
        js = f'''tl.from("#a .pill",{{y:{120 * k:.0f},scale:.6,opacity:0,duration:.75,ease:"back.out(1.9)"}},.02)
          .from("#a .ic",{{rotate:-180,scale:0,duration:.6,ease:"back.out(2)"}},.25)
          .from("#a .tx",{{x:-{20 * k:.0f},opacity:0,duration:.45,ease:"power3.out"}},.35)
          .to("#a .ic",{{scale:1.14,duration:.32,ease:"sine.inOut",yoyo:true,repeat:3}},1.0)
          .to("#a .pill",{{y:{80 * k:.0f},opacity:0,scale:.85,duration:.4,ease:"power2.in"}},{out:.2f});'''
    elif kind == "ubicacion":
        body = f'''<div id="a" class="c" style="top:{y:.0f}px"><div class="card">
          <div class="pinw"><div class="ring"></div><svg class="pin" viewBox="0 0 24 32">
            <path d="M12 0C5.4 0 0 5.3 0 11.9 0 20.8 12 32 12 32s12-11.2 12-20.1C24 5.3 18.6 0 12 0z" fill="{acc}"/>
            <circle cx="12" cy="11.6" r="4.6" fill="{ink}"/></svg></div>
          <div class="txt"><div class="n"><span>{text}</span></div>{f'<div class="r"><span>{sub}</span></div>' if sub else ''}</div>
        </div></div>'''
        css = f'''.c{{position:absolute;left:50%;transform:translate(-50%,-50%)}}
        .card{{display:flex;align-items:center;gap:{s(26)};padding:{s(22)} {s(44)} {s(22)} {s(26)};border-radius:{s(40)};
              background:rgba(12,12,14,.66);box-shadow:0 {s(20)} {s(60)} rgba(0,0,0,.4);white-space:nowrap;overflow:hidden}}
        .pinw{{position:relative;width:{s(84)};height:{s(108)};flex:none}}
        .pin{{position:absolute;inset:0;width:100%;height:100%;transform-origin:50% 100%;filter:drop-shadow(0 {s(8)} {s(10)} rgba(0,0,0,.35))}}
        .ring{{position:absolute;left:50%;bottom:{s(-6)};width:{s(80)};height:{s(26)};margin-left:{s(-40)};border-radius:50%;
              border:{s(5)} solid {acc}}}
        .n,.r{{overflow:hidden}} .n>span,.r>span{{display:inline-block}}
        .n{{font-family:var(--fd);font-weight:var(--wd);font-size:{s(76)};color:#fff;letter-spacing:-.02em;line-height:1.05}}
        .r{{font-family:var(--fb);font-weight:var(--wb);font-size:{s(40)};color:#fff;opacity:.85;margin-top:{s(6)}}}'''
        js = f'''tl.from("#a .card",{{scale:.4,opacity:0,duration:.5,ease:"back.out(2.2)"}},0)
          .from("#a .pin",{{y:-{140 * k:.0f},opacity:0,duration:.5,ease:"bounce.out"}},.12)
          .fromTo("#a .ring",{{scale:.2,opacity:1}},{{scale:1.6,opacity:0,duration:.7,ease:"power2.out"}},.55)
          .from("#a .n>span",{{yPercent:110,duration:.55,ease:"power4.out"}},.35)
          .from("#a .r>span",{{yPercent:110,duration:.55,ease:"power4.out"}},.5)
          .to("#a .pin",{{y:-{10 * k:.0f},duration:.45,ease:"sine.inOut",yoyo:true,repeat:3}},1.1)
          .to("#a .card",{{scale:.7,opacity:0,y:-{40 * k:.0f},duration:.4,ease:"power2.in"}},{out:.2f});'''
    elif kind == "marcador":
        # pin que cae sobre un punto de la toma (x, y de 0 a 1), ondas y una etiqueta unida por una línea
        px = W * min(0.9, max(0.1, float(a.get("x", 0.5))))
        py = H * min(0.92, max(0.25, float(a.get("y", 0.6))))
        ly = py - 420 * k
        lx = min(max(px, W * 0.5 - 0), W * 0.5)  # la etiqueta va centrada; la línea sube desde el pin
        body = f'''<div id="a">
          <div class="rg r1" style="left:{px:.0f}px;top:{py:.0f}px"></div><div class="rg r2" style="left:{px:.0f}px;top:{py:.0f}px"></div>
          <div class="sh" style="left:{px:.0f}px;top:{py:.0f}px"></div>
          <svg class="pin" style="left:{px:.0f}px;top:{py:.0f}px" viewBox="0 0 24 32">
            <path d="M12 0C5.4 0 0 5.3 0 11.9 0 20.8 12 32 12 32s12-11.2 12-20.1C24 5.3 18.6 0 12 0z" fill="{acc}"/>
            <circle cx="12" cy="11.6" r="4.6" fill="{ink}"/></svg>
          <div class="ln" style="left:{px:.0f}px;top:{ly:.0f}px;height:{py - ly - 120 * k:.0f}px"></div>
          <div class="card" style="left:{lx:.0f}px;top:{ly:.0f}px"><div class="bar"></div>
            <div class="n"><span>{text}</span></div>{f'<div class="r"><span>{sub}</span></div>' if sub else ''}</div>
        </div>'''
        css = f'''.rg{{position:absolute;width:{s(170)};height:{s(60)};margin:{s(-30)} 0 0 {s(-85)};border-radius:50%;border:{s(6)} solid {acc}}}
        .sh{{position:absolute;width:{s(70)};height:{s(22)};margin:{s(-11)} 0 0 {s(-35)};border-radius:50%;background:rgba(0,0,0,.45);filter:blur({s(4)})}}
        .pin{{position:absolute;width:{s(92)};height:{s(122)};margin:{s(-122)} 0 0 {s(-46)};transform-origin:50% 100%;
              filter:drop-shadow(0 {s(6)} {s(10)} rgba(0,0,0,.4))}}
        .ln{{position:absolute;width:{s(5)};margin-left:{s(-2.5)};background:linear-gradient(#fff,rgba(255,255,255,.2));transform-origin:50% 100%;border-radius:{s(3)}}}
        .card{{position:absolute;transform:translate(-50%,-100%);padding:{s(24)} {s(44)} {s(26)};border-radius:{s(34)};
              background:rgba(12,12,14,.7);box-shadow:0 {s(20)} {s(60)} rgba(0,0,0,.45);text-align:center;white-space:nowrap;overflow:hidden}}
        .bar{{height:{s(8)};width:{s(120)};margin:0 auto {s(14)};border-radius:{s(6)};background:{acc};transform-origin:50% 50%}}
        .n,.r{{overflow:hidden}} .n>span,.r>span{{display:inline-block}}
        .n{{font-family:var(--fd);font-weight:var(--wd);font-size:{s(84)};color:#fff;letter-spacing:-.02em;line-height:1.05}}
        .r{{font-family:var(--fb);font-weight:var(--wb);font-size:{s(42)};color:#fff;opacity:.88;margin-top:{s(8)}}}'''
        js = f'''tl.from("#a .pin",{{y:-{420 * k:.0f},opacity:0,duration:.55,ease:"bounce.out"}},0)
          .from("#a .sh",{{scale:0,opacity:0,duration:.4,ease:"power2.out"}},.2)
          .fromTo("#a .r1",{{scale:.1,opacity:1}},{{scale:1.8,opacity:0,duration:1.1,ease:"power2.out",repeat:2}},.5)
          .fromTo("#a .r2",{{scale:.1,opacity:1}},{{scale:1.8,opacity:0,duration:1.1,ease:"power2.out",repeat:2}},1.05)
          .from("#a .ln",{{scaleY:0,duration:.45,ease:"power3.out"}},.6)
          .from("#a .card",{{scale:.5,opacity:0,y:{30 * k:.0f},duration:.55,ease:"back.out(2)"}},.9)
          .from("#a .bar",{{scaleX:0,duration:.5,ease:"expo.out"}},1.1)
          .from("#a .n>span",{{yPercent:110,duration:.55,ease:"power4.out"}},1.05)
          .from("#a .r>span",{{yPercent:110,duration:.55,ease:"power4.out"}},1.2)
          .to("#a",{{opacity:0,y:-{30 * k:.0f},duration:.4,ease:"power2.in"}},{out:.2f});'''
    else:  # dato
        raw = str(a.get("text") or "0")
        digits = "".join(ch for ch in raw if ch.isdigit() or ch in ".,")
        num = float(digits.replace(",", "")) if digits.replace(",", "").replace(".", "", 1).isdigit() else 0
        pre = html.escape(raw[:raw.find(digits[0])] if digits else "")
        suf = html.escape(raw[raw.rfind(digits[-1]) + 1:] if digits else raw)
        dec = 1 if (num != int(num)) else 0
        body = f'''<div id="a" class="c" style="top:{y:.0f}px"><div class="num">{pre}<span id="n">0</span>{suf}</div>
          {f'<div class="s">{sub}</div>' if sub else ''}</div>'''
        css = f'''.c{{position:absolute;left:50%;transform:translate(-50%,-50%);width:{maxw:.0f}px;text-align:center}}
        .num{{font-family:var(--fd);font-weight:var(--wd);font-size:{s(210)};line-height:1;color:{acc};letter-spacing:-.04em;
             text-shadow:0 {s(10)} {s(40)} rgba(0,0,0,.45);font-variant-numeric:tabular-nums}}
        .s{{margin-top:{s(10)};font-family:var(--fb);font-weight:var(--wb);font-size:{s(54)};color:#fff;
            text-shadow:0 {s(3)} {s(14)} rgba(0,0,0,.5)}}'''
        js = f'''const o={{v:0}}, el=document.getElementById("n");
          const fmt=v=>v.toLocaleString("es",{{minimumFractionDigits:{dec},maximumFractionDigits:{dec}}});
          tl.from("#a",{{scale:.7,opacity:0,duration:.5,ease:"back.out(2)"}},0)
            .to(o,{{v:{num},duration:{min(1.6, dur * 0.55):.2f},ease:"power2.out",onUpdate:()=>{{el.textContent=fmt(o.v)}}}},.1)
            .from("#a .s",{{y:{24 * k:.0f},opacity:0,duration:.45,ease:"power3.out"}},.5)
            .to("#a",{{opacity:0,scale:.9,duration:.4,ease:"power2.in"}},{out:.2f});
          el.textContent=fmt(0);'''

    page = f'''<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width={W}, height={H}">
<script src="gsap.min.js"></script>
<style>{font_css}
html,body{{margin:0;width:{W}px;height:{H}px;overflow:hidden;background:transparent}}
#root{{position:relative;width:{W}px;height:{H}px;overflow:hidden}}
{css}
</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="{dur:.3f}" data-width="{W}" data-height="{H}">
<div id="layer" class="clip" data-start="0" data-duration="{dur:.3f}" data-track-index="0" style="position:absolute;inset:0">{body}</div>
</div>
<script>
window.__timelines = window.__timelines || {{}};
const tl = gsap.timeline({{paused:true}});
{js}
tl.set({{}},{{}},{dur:.3f});
window.__timelines["main"] = tl; tl.seek(0);
</script></body></html>'''
    files.append((STATIC / "gsap.min.js", "gsap.min.js"))
    return page, files


def anim_key(p: dict, a: dict, geo: dict, fps: int, kit: dict) -> str:
    raw = json.dumps([a.get(x) for x in ("kind", "text", "sub", "dur", "pos", "x", "y")] +
                     [geo["W"], geo["H"], fps, _accent(p, kit), kit.get("fontFile"), kit.get("id"), HF_VERSION, 2],
                     sort_keys=True, default=str)
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def write_page(p: dict, a: dict, geo: dict, kit: dict, folder: Path) -> Path:
    page, files = build_html(p, a, geo, kit)
    folder.mkdir(parents=True, exist_ok=True)
    for src, name in files:
        dst = folder / name
        if src.exists() and (not dst.exists() or dst.stat().st_size != src.stat().st_size):
            shutil.copy2(src, dst)
    (folder / "index.html").write_text(page, encoding="utf-8")
    return folder / "index.html"


def render_anim(p: dict, a: dict, geo: dict, fps: int, kit: dict, out: Path):
    """Graba la animación con fondo transparente (MOV ProRes 4444)."""
    n = node_bin()
    if not n or not hf_cli().exists():
        raise RuntimeError("Las animaciones aún no están activadas.")
    folder = out.parent / (out.stem + "_src")
    write_page(p, a, geo, kit, folder)
    tmp = out.with_name(out.stem + ".tmp.mov")
    r = subprocess.run([str(n), str(hf_cli()), "render", str(folder), "--format", "mov", "--fps", str(fps),
                        "-o", str(tmp), "--quiet"], cwd=folder, env=_env(), capture_output=True, text=True,
                       timeout=900)
    if r.returncode != 0 or not tmp.exists():
        raise RuntimeError("No se pudo dibujar la animación «" + str(a.get("text", ""))[:40] + "»: "
                           + (r.stderr or r.stdout)[-300:])
    os.replace(tmp, out)
    shutil.rmtree(folder, ignore_errors=True)


# ---------------------------------------------------------------- automáticas
def auto_anims(p: dict, pl: dict, title: str = "", cta: str = "", highlight: bool = True) -> list[dict]:
    """Propone animaciones: título al inicio, frases clave en el medio y llamada a la acción al final."""
    import uuid
    total = pl["total"]
    res = []
    if not title:
        kept = [w for w in p.get("words", []) if not w.get("cut")]
        title = " ".join(w["text"] for w in kept[:6]).strip(" ,.;:¿?¡!")
        if len(kept) > 6:
            title += "…"
    if title:
        a = anim_defaults("titulo")
        a.update(id=uuid.uuid4().hex[:6], text=title[:60], start=round(pl["mainStart"] + 0.2, 2), pos="arriba")
        a["dur"] = min(3.0, max(1.6, total * 0.25))
        res.append(a)
    if highlight and total > 12:
        mapper = E.word_mapper(pl)
        groups = E.phrases(p.get("words", []))
        cands = []
        keys = ("importante", "secreto", "clave", "nunca", "siempre", "error", "tip", "truco", "gratis", "mejor", "primer")
        for g in groups:
            ws = [p["words"][i] for i in g if not p["words"][i].get("cut")]
            if 2 <= len(ws) <= 9:
                txt = " ".join(w["text"] for w in ws)
                score = sum(any(c.isdigit() for c in w["text"]) for w in ws) * 2 + sum(
                    E.norm(w["text"]) in keys for w in ws) * 3
                if score:
                    m = mapper(ws[0].get("clip"), ws[0]["start"], ws[0]["end"])
                    if m:
                        cands.append((score, m[0], txt))
        cands.sort(key=lambda c: -c[0])
        used = [r["start"] for r in res]
        for score, t0, txt in cands:
            if len([r for r in res if r["kind"] == "frase"]) >= 2:
                break
            if t0 < 3.5 or t0 > total - 5 or any(abs(t0 - u) < 4 for u in used):
                continue
            short = " ".join(txt.split()[:5]).strip(" ,.;:")
            a = anim_defaults("frase")
            a.update(id=uuid.uuid4().hex[:6], text=short, start=round(t0, 2))
            res.append(a)
            used.append(t0)
    if cta:
        a = anim_defaults("llamada")
        dur = min(3.0, max(2.0, total * 0.2))
        a.update(id=uuid.uuid4().hex[:6], text=cta[:40], dur=dur, start=round(max(0.0, total - dur - 0.1), 2))
        res.append(a)
    return sorted(res, key=lambda r: r["start"])
