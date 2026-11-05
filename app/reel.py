#!/usr/bin/env python3
"""Reel Studio — línea de comandos para que Claude edite proyectos.

Los cambios aparecen solos en la interfaz abierta (se recarga cada 2 s).

  reel.py estado                         ¿está corriendo el servidor?
  reel.py lista                          proyectos
  reel.py nuevo RUTA [--nombre N]        importa un video y lo transcribe
  reel.py esperar ID                     espera a que termine la transcripción
  reel.py texto ID [--todo]              transcripción numerada por frases
  reel.py cortar ID 12-30 41 --motivo "toma repetida"
  reel.py restaurar ID 12-30             vuelve a incluir palabras
  reel.py mantener ID 7                  protege palabras de la limpieza automática
  reel.py corregir ID 15 "Novopan"       corrige el texto de una palabra (subtítulo)
  reel.py limpiar ID                     limpieza automática
  reel.py estilo ID --preset impacto --resaltado "#FFD400" --posicion abajo ...
  reel.py ajustes ID --pausa 0.3 --margen 0.06 --silencios si
  reel.py ajustes ID --formato vertical|horizontal|4:5|cuadrado --encuadre llenar|difuminado --posx 0.4
  reel.py exportar ID [--formato horizontal] [--fps 30|60] [--4k] [--prores] [--calidad maxima|alta|liviana] [--srt]
  reel.py nota ID "texto"                deja un mensaje visible en la interfaz
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine as E  # noqa: E402

BASE = "http://127.0.0.1:8765"


def api(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


def server_up():
    try:
        return api("GET", "/api/health", timeout=6).get("ok")
    except Exception:
        return False


def parse_ranges(specs, n):
    out = set()
    for s in specs:
        for part in str(s).split(","):
            part = part.strip()
            if not part:
                continue
            if "-" in part:
                a, b = part.split("-", 1)
                out.update(range(int(a), int(b) + 1))
            else:
                out.add(int(part))
    bad = [i for i in out if i < 0 or i >= n]
    if bad:
        sys.exit(f"Índices fuera de rango: {bad[:5]} (hay {n} palabras, 0–{n - 1})")
    return sorted(out)


def fmt_t(t):
    return f"{int(t // 60)}:{t % 60:04.1f}"


def cmd_texto(p, todo=False):
    w = p["words"]
    if not w:
        print("(sin transcripción todavía; estado:", p.get("status"), ")")
        return
    print(f"# {p['name']}  id={p['id']}  original {p['duration']:.1f}s → final {E.output_duration(p):.1f}s")
    print("# [n]palabra · ~~tachada~~ (motivo) · ?posible muletilla")
    for ph in E.phrases(w):
        if not todo and all(w[i]["cut"] for i in ph):
            idx = f"{ph[0]}-{ph[-1]}"
            reasons = sorted({w[i]['reason'] for i in ph if w[i]['reason']})
            print(f"  [{idx}] (frase eliminada: {', '.join(reasons)}) " +
                  " ".join(w[i]["text"] for i in ph))
            continue
        toks = []
        for i in ph:
            x = w[i]
            t = x["text"]
            if x["cut"]:
                t = f"~~{t}~~" + (f"({x['reason']})" if x["reason"] else "")
            elif x.get("suggest"):
                t = "?" + t
            toks.append(f"[{i}]{t}")
        print(f"{fmt_t(w[ph[0]]['start'])}  " + " ".join(toks))


def main():
    ap = argparse.ArgumentParser(prog="reel.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("estado")
    sp.add_parser("lista")
    a = sp.add_parser("nuevo"); a.add_argument("ruta"); a.add_argument("--nombre")
    a = sp.add_parser("esperar"); a.add_argument("id")
    a = sp.add_parser("texto"); a.add_argument("id"); a.add_argument("--todo", action="store_true")
    a = sp.add_parser("json"); a.add_argument("id")
    for name in ("cortar", "restaurar", "mantener"):
        a = sp.add_parser(name); a.add_argument("id"); a.add_argument("rangos", nargs="+")
        a.add_argument("--motivo", default="")
    a = sp.add_parser("corregir"); a.add_argument("id"); a.add_argument("indice", type=int); a.add_argument("texto")
    a = sp.add_parser("limpiar"); a.add_argument("id")
    a = sp.add_parser("estilo"); a.add_argument("id")
    a.add_argument("--preset", choices=list(E.PRESETS)); a.add_argument("--fuente", choices=E.FONTS)
    a.add_argument("--tamano", type=int); a.add_argument("--color"); a.add_argument("--resaltado")
    a.add_argument("--borde"); a.add_argument("--posicion", choices=["arriba", "centro", "abajo"])
    a.add_argument("--palabras", type=int); a.add_argument("--mayusculas", choices=["si", "no"])
    a.add_argument("--caja", choices=["si", "no"])
    a = sp.add_parser("ajustes"); a.add_argument("id")
    a.add_argument("--pausa", type=float); a.add_argument("--margen", type=float)
    a.add_argument("--silencios", choices=["si", "no"]); a.add_argument("--subtitulos", choices=["si", "no"])
    a.add_argument("--formato", choices=list(E.FORMATS)); a.add_argument("--encuadre", choices=["llenar", "difuminado"])
    a.add_argument("--posx", type=float, help="0 = izquierda, 1 = derecha"); a.add_argument("--posy", type=float)
    a = sp.add_parser("exportar"); a.add_argument("id"); a.add_argument("--srt", action="store_true")
    a.add_argument("--sin-subtitulos", action="store_true"); a.add_argument("--sin-normalizar", action="store_true")
    a.add_argument("--calidad", choices=["maxima", "alta", "liviana"], default="alta")
    a.add_argument("--formato", choices=list(E.FORMATS)); a.add_argument("--fps", default="auto", choices=["auto", "24", "25", "30", "50", "60"])
    a.add_argument("--4k", dest="uhd", action="store_true"); a.add_argument("--prores", action="store_true")
    a = sp.add_parser("nota"); a.add_argument("id"); a.add_argument("texto")
    args = ap.parse_args()

    if args.cmd == "estado":
        print("Servidor:", "corriendo en http://localhost:8765" if server_up() else "apagado (ejecuta start.sh)")
        print("Proyectos en:", E.PROJECTS_DIR)
        return
    if args.cmd == "lista":
        for p in E.list_projects():
            print(f"{p['id']:40s} {p['status'] or '':14s} {p['duration']:6.1f}s → {p['outDuration']:6.1f}s  {p['name']}")
        return
    if args.cmd == "nuevo":
        if not server_up():
            sys.exit("El servidor no está corriendo. Ejecuta primero ~/ReelStudio/start.sh")
        r = api("POST", "/api/import", {"path": args.ruta, "name": args.nombre}, timeout=600)
        if "error" in r:
            sys.exit(r["error"])
        print("Proyecto creado:", r["project"]["id"])
        print("Abre: http://localhost:8765/#" + r["project"]["id"])
        return
    if args.cmd == "esperar":
        while True:
            p = E.load(args.id)
            if p.get("status") in ("listo", "error"):
                print("Estado:", p["status"], "·", len(p["words"]), "palabras")
                return
            time.sleep(2)

    pid = args.id
    if args.cmd == "texto":
        return cmd_texto(E.load(pid), args.todo)
    if args.cmd == "json":
        p = E.load(pid)
        print(json.dumps({"words": [{k: w[k] for k in ("id", "text", "start", "end", "cut", "reason")} for w in p["words"]]},
                         ensure_ascii=False))
        return
    if args.cmd in ("cortar", "restaurar", "mantener"):
        def fn(p):
            idx = parse_ranges(args.rangos, len(p["words"]))
            for i in idx:
                w = p["words"][i]
                if args.cmd == "cortar":
                    w.update(cut=True, reason=args.motivo or "editado por Claude", by="claude")
                elif args.cmd == "restaurar":
                    w.update(cut=False, reason="", by="keep")
                else:
                    w.update(cut=False, reason="", by="keep", suggest="")
            verb = {"cortar": "Quité", "restaurar": "Restauré", "mantener": "Protegí"}[args.cmd]
            txt = " ".join(p["words"][i]["text"] for i in idx[:12]) + ("…" if len(idx) > 12 else "")
            E.add_log(p, "claude", f"{verb} «{txt}»" + (f" — {args.motivo}" if args.motivo else ""))
            print(f"{verb} {len(idx)} palabras.")
        p = E.update(pid, fn)
        print(f"Duración final: {E.output_duration(p):.1f}s")
        return
    if args.cmd == "corregir":
        def fn(p):
            w = p["words"][args.indice]
            old = w["text"]
            w["text"] = args.texto
            E.add_log(p, "claude", f"Corregí «{old}» → «{args.texto}»")
        E.update(pid, fn)
        print("Corregido.")
        return
    if args.cmd == "limpiar":
        p = E.update(pid, E.autoclean)
        print("Limpieza:", p.get("autoStats"), f"· final {E.output_duration(p):.1f}s")
        return
    if args.cmd == "estilo":
        def fn(p):
            st = p["style"]
            if args.preset:
                st.clear(); st.update(E.default_style(args.preset))
            m = {"fuente": "font", "tamano": "size", "color": "color", "resaltado": "highlight",
                 "borde": "outline", "posicion": "position", "palabras": "maxWords"}
            for k, v in m.items():
                if getattr(args, k) is not None:
                    st[v] = getattr(args, k)
            if args.mayusculas:
                st["uppercase"] = args.mayusculas == "si"
            if args.caja:
                st["box"] = args.caja == "si"
            E.add_log(p, "claude", f"Cambié el estilo de subtítulos ({st.get('preset')}).")
        p = E.update(pid, fn)
        print(json.dumps(p["style"], ensure_ascii=False))
        return
    if args.cmd == "ajustes":
        def fn(p):
            s = p["settings"]
            if args.pausa is not None: s["maxPause"] = args.pausa
            if args.margen is not None: s["padding"] = args.margen
            if args.silencios: s["removeSilences"] = args.silencios == "si"
            if args.subtitulos: s["subtitles"] = args.subtitulos == "si"
            if args.formato: s["format"] = args.formato
            if args.encuadre: s["fit"] = args.encuadre
            if args.posx is not None: s["cropX"] = max(0, min(1, args.posx))
            if args.posy is not None: s["cropY"] = max(0, min(1, args.posy))
        p = E.update(pid, fn)
        print(json.dumps(p["settings"]), f"· final {E.output_duration(p):.1f}s")
        return
    if args.cmd == "exportar":
        p = E.load(pid)
        opts = {"srt": args.srt, "subtitles": not args.sin_subtitulos, "loudnorm": not args.sin_normalizar,
                "quality": args.calidad, "fps": args.fps, "uhd": args.uhd,
                "codec": "prores" if args.prores else "h264"}
        if args.formato:
            opts["format"] = args.formato
        last = [0]
        def prog(f, msg=""):
            if f - last[0] >= 0.1:
                last[0] = f
                print(f"  {int(f * 100)}%", flush=True)
        r = E.export(p, opts, prog)
        E.update(pid, lambda x: E.add_log(x, "claude", f"Exporté {r['file']} · {r['size_px']} · {r['fps']} fps · {r['codec']}"))
        print("Listo:", E.project_dir(pid) / "exports" / r["file"], f"({r['size_px']}, {r['fps']} fps, {r['codec']})")
        if r.get("srt"):
            print("SRT:", E.project_dir(pid) / "exports" / r["srt"])
        return
    if args.cmd == "nota":
        E.update(pid, lambda p: E.add_log(p, "claude", args.texto))
        print("Nota agregada.")


if __name__ == "__main__":
    main()
