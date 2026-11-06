#!/usr/bin/env python3
"""Reel Studio — línea de comandos para que Claude edite proyectos (v2, multiclip).
Los cambios aparecen solos en la app abierta (se recarga cada 2 s).

PROYECTO
  estado | lista | marcas
  nuevo RUTA [--proyecto ID] [--nombre N]    importa un video (a un proyecto nuevo o existente)
  esperar ID                                 espera a que terminen las transcripciones
  clips ID                                   clips, secuencia, apoyos, música, referencia
  pedidos [ID]                               pedidos pendientes que el usuario escribió en la app
  hecho ID PEDIDO "nota"                     marca un pedido como resuelto (la nota la ve el usuario)
  nota ID "texto"                            mensaje visible en la pestaña Actividad

TEXTO (clips con voz)
  texto ID [--todo]                          transcripción numerada por frases y clips
  cortar ID 12-30 41 --motivo "toma repetida" | restaurar ID 12-30 | mantener ID 7
  corregir ID 15 "Novopan"                   corrige cómo se escribe en el subtítulo
  limpiar ID                                 limpieza automática

SECUENCIA
  armar ID                                   armado automático (voz principal + apoyos encima / montaje)
  orden ID c3 c1 c2                          orden de los clips principales
  recorte ID c2 --entrada 1.5 --salida 7     qué parte del clip se usa
  rol ID c4 principal|apoyo|fuera            mueve un clip entre la secuencia, los apoyos o fuera
  silenciar ID c2 si|no                      quita o devuelve el audio original de un clip
  apoyo ID c4 --en 6.5 --dur 2.5 [--desde 1] agrega/ajusta una toma de apoyo (segundos del video final)
  quitar-apoyo ID APOYO
  transicion ID --tipo disolver --dur 0.4 [--clip c3]   corte|disolver|negro|blanco|barrido|zoom|difuminar

LOOK
  color ID --look cine --exposicion 0.1 --contraste 0.2 --saturacion -0.1 --temperatura 0.3 --tinte 0 --vineta 0.3 [--clip c2]
  igualar-color ID
  estilo ID --preset impacto --resaltado "#FFD400" --posicion abajo --palabras 3 ...  (subtítulos)
  ajustes ID --formato vertical|horizontal|4:5|5:4|cuadrado --encuadre llenar|difuminado --posx 0.4
            --pausa 0.3 --margen 0.06 --ritmo-tomas 2.5 --subtitulos si|no
  musica ID --volumen 0.3 --bajar si|no --entrada 1 --salida 2 --inicio 12 --ritmo si|no
  marca ID --marca ID|ninguna --logo si|no --pos arriba-derecha --tam 0.14 --opacidad 0.9
           --intro "Texto"|no --cierre "Texto"|no
  referencia ID | aplicar-referencia ID

SALIDA
  exportar ID [--formato F] [--res 720|1080|1440|2160] [--fps 24|30|60] [--calidad maxima|alta|liviana]
              [--prores] [--srt] [--sin-subtitulos]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine as E  # noqa: E402

BASE = "http://127.0.0.1:8765"


def api(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=timeout) as r:
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


def si(v):
    return None if v is None else v == "si"


def cmd_clips(p):
    pl = E.plan(p)
    print(f"# {p['name']}  id={p['id']}  formato={p['settings']['format']}  duración final {pl['total']:.1f}s")
    print("CLIPS:")
    for c in p["clips"]:
        print(f"  {c['id']}  {c.get('status', ''):10s} {'voz' if c.get('speech') else 'imagen':6s} "
              f"{c.get('duration', 0):6.1f}s {c.get('width', '?')}x{c.get('height', '?')} {c.get('fps', '')}fps "
              f"{'HDR ' if c.get('hdr') else ''}«{c['name']}»" + (f" ajuste={c['adjust']}" if c.get("adjust") else ""))
    print("SECUENCIA (en orden):")
    for itm in pl["items"]:
        lab = itm.get("clip") or itm.get("card")
        print(f"  {itm['start']:6.1f}s  {lab:6s} dura {itm['dur']:.1f}s  entra con {itm.get('ttype', 'corte')}")
    if p["broll"]:
        print("APOYOS (encima, segundos desde el inicio del contenido):")
        for b in p["broll"]:
            print(f"  [{b['id']}] {b['clip']} en {b['at']:.1f}s durante {b['dur']:.1f}s (desde {b.get('srcIn', 0):.1f}s del clip)")
    m = p["settings"]["music"]
    if m.get("file"):
        print(f"MÚSICA: «{m['name']}» {m.get('tempo', 0):.0f} BPM vol {m['volume']} bajar={m['duck']} ritmo={m['beatSync']}")
    ref = (p.get("reference") or {}).get("analysis")
    if ref:
        print(f"REFERENCIA: {ref['format']} · {ref['shots']} tomas de {ref['avgShot']}s · look {ref['look']} · {ref.get('tempo', 0)} BPM")
    g = p["settings"]["grade"]
    print(f"COLOR: {g}  TRANSICIÓN: {p['settings']['transition']}  MARCA: {p['settings'].get('brand') or 'ninguna'}")


def cmd_texto(p, todo=False):
    w = p["words"]
    if not w:
        print("(sin transcripción)")
        return
    print(f"# {p['name']}  id={p['id']}  final {E.plan(p)['total']:.1f}s")
    print("# [n]palabra · ~~tachada~~(motivo) · ?posible muletilla")
    order = [t["clip"] for t in p["timeline"]] + [c["id"] for c in p["clips"]]
    seen = []
    for cid in order:
        if cid in seen:
            continue
        seen.append(cid)
        c = E.clip_by_id(p, cid)
        if not c or not c.get("speech"):
            continue
        role = "principal" if any(t["clip"] == cid for t in p["timeline"]) else "fuera de la secuencia"
        print(f"\n== {cid} «{c['name']}» ({role})")
        idx = [i for i, x in enumerate(w) if x.get("clip") == cid]
        sub = [w[i] for i in idx]
        for ph in E.phrases(sub):
            ids = [idx[i] for i in ph]
            if not todo and all(w[i]["cut"] for i in ids):
                reasons = sorted({w[i]["reason"] for i in ids if w[i]["reason"]})
                print(f"  [{ids[0]}-{ids[-1]}] (eliminada: {', '.join(reasons)}) " + " ".join(w[i]["text"] for i in ids))
                continue
            toks = []
            for i in ids:
                x = w[i]
                t = x["text"]
                if x["cut"]:
                    t = f"~~{t}~~" + (f"({x['reason']})" if x["reason"] else "")
                elif x.get("suggest"):
                    t = "?" + t
                toks.append(f"[{i}]{t}")
            print(f"{fmt_t(w[ids[0]]['start'])}  " + " ".join(toks))


def main():
    ap = argparse.ArgumentParser(prog="reel.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    for n in ("estado", "lista", "marcas"):
        sp.add_parser(n)
    a = sp.add_parser("nuevo"); a.add_argument("ruta"); a.add_argument("--nombre"); a.add_argument("--proyecto")
    for n in ("esperar", "clips", "limpiar", "armar", "igualar-color", "referencia", "aplicar-referencia"):
        sp.add_parser(n).add_argument("id")
    a = sp.add_parser("pedidos"); a.add_argument("id", nargs="?")
    a = sp.add_parser("hecho"); a.add_argument("id"); a.add_argument("pedido"); a.add_argument("nota")
    a = sp.add_parser("nota"); a.add_argument("id"); a.add_argument("texto")
    a = sp.add_parser("texto"); a.add_argument("id"); a.add_argument("--todo", action="store_true")
    for n in ("cortar", "restaurar", "mantener"):
        a = sp.add_parser(n); a.add_argument("id"); a.add_argument("rangos", nargs="+"); a.add_argument("--motivo", default="")
    a = sp.add_parser("corregir"); a.add_argument("id"); a.add_argument("indice", type=int); a.add_argument("texto")
    a = sp.add_parser("orden"); a.add_argument("id"); a.add_argument("clips", nargs="+")
    a = sp.add_parser("recorte"); a.add_argument("id"); a.add_argument("clip")
    a.add_argument("--entrada", type=float); a.add_argument("--salida", type=float); a.add_argument("--completo", choices=["si", "no"])
    a = sp.add_parser("silenciar"); a.add_argument("id"); a.add_argument("clip"); a.add_argument("estado", choices=["si", "no"])
    a = sp.add_parser("rol"); a.add_argument("id"); a.add_argument("clip"); a.add_argument("rol", choices=["principal", "apoyo", "fuera"])
    a = sp.add_parser("apoyo"); a.add_argument("id"); a.add_argument("clip")
    a.add_argument("--en", type=float, required=True); a.add_argument("--dur", type=float, default=2.5)
    a.add_argument("--desde", type=float, default=0.3)
    a = sp.add_parser("quitar-apoyo"); a.add_argument("id"); a.add_argument("apoyo")
    a = sp.add_parser("transicion"); a.add_argument("id"); a.add_argument("--tipo", choices=list(E.TRANSITIONS))
    a.add_argument("--dur", type=float); a.add_argument("--clip")
    a = sp.add_parser("color"); a.add_argument("id"); a.add_argument("--look", choices=list(E.LOOKS)); a.add_argument("--clip")
    for k in ("exposicion", "contraste", "saturacion", "temperatura", "tinte", "vineta"):
        a.add_argument("--" + k, type=float)
    a = sp.add_parser("estilo"); a.add_argument("id")
    a.add_argument("--preset", choices=list(E.PRESETS)); a.add_argument("--fuente", choices=E.FONTS + ["marca"])
    a.add_argument("--tamano", type=int); a.add_argument("--color"); a.add_argument("--resaltado")
    a.add_argument("--borde"); a.add_argument("--posicion", choices=["arriba", "centro", "abajo"])
    a.add_argument("--palabras", type=int); a.add_argument("--mayusculas", choices=["si", "no"]); a.add_argument("--caja", choices=["si", "no"])
    a = sp.add_parser("ajustes"); a.add_argument("id")
    a.add_argument("--pausa", type=float); a.add_argument("--margen", type=float); a.add_argument("--ritmo-tomas", type=float)
    a.add_argument("--silencios", choices=["si", "no"]); a.add_argument("--subtitulos", choices=["si", "no"])
    a.add_argument("--formato", choices=list(E.FORMATS)); a.add_argument("--encuadre", choices=["llenar", "difuminado"])
    a.add_argument("--posx", type=float); a.add_argument("--posy", type=float)
    a = sp.add_parser("musica"); a.add_argument("id")
    a.add_argument("--volumen", type=float); a.add_argument("--bajar", choices=["si", "no"]); a.add_argument("--entrada", type=float)
    a.add_argument("--salida", type=float); a.add_argument("--inicio", type=float); a.add_argument("--ritmo", choices=["si", "no"])
    a = sp.add_parser("marca"); a.add_argument("id"); a.add_argument("--marca"); a.add_argument("--logo", choices=["si", "no"])
    a.add_argument("--pos", choices=["arriba-izquierda", "arriba-centro", "arriba-derecha", "abajo-izquierda", "abajo-centro", "abajo-derecha"])
    a.add_argument("--tam", type=float); a.add_argument("--opacidad", type=float); a.add_argument("--intro"); a.add_argument("--cierre")
    a = sp.add_parser("exportar"); a.add_argument("id"); a.add_argument("--srt", action="store_true")
    a.add_argument("--sin-subtitulos", action="store_true"); a.add_argument("--sin-normalizar", action="store_true")
    a.add_argument("--calidad", choices=["maxima", "alta", "liviana"], default="alta"); a.add_argument("--formato", choices=list(E.FORMATS))
    a.add_argument("--fps", default="auto", choices=["auto", "24", "25", "30", "50", "60"])
    a.add_argument("--res", default="1080", choices=list(E.RESOLUTIONS)); a.add_argument("--4k", dest="uhd", action="store_true")
    a.add_argument("--prores", action="store_true")
    args = ap.parse_args()
    cmd = args.cmd

    if cmd == "estado":
        print("Servidor:", "corriendo en http://localhost:8765" if server_up() else "apagado (abre la app Reel Studio)")
        print("Proyectos en:", E.PROJECTS_DIR)
        return
    if cmd == "lista":
        for p in E.list_projects():
            print(f"{p['id']:40s} {p['status']:14s} {p['clips']} clips → {p['outDuration']:6.1f}s  {p['name']}")
        return
    if cmd == "marcas":
        for k in E.list_brands():
            print(f"{k['id']:30s} {k['name']}  colores={k['colors']}  letra={k.get('fontName') or k.get('font')}  logo={'sí' if k.get('logo') else 'no'}")
        return
    if cmd == "nuevo":
        if not server_up():
            sys.exit("Reel Studio no está abierto. Ábrelo (o ejecuta ~/ReelStudio/start.sh) y repite.")
        r = api("POST", "/api/import", {"path": args.ruta, "name": args.nombre, "project": args.proyecto}, timeout=900)
        if "error" in r:
            sys.exit(r["error"])
        print("Proyecto:", r["project"]["id"])
        return
    if cmd == "pedidos":
        ids = [args.id] if args.id else [p["id"] for p in E.list_projects()]
        n = 0
        for pid in ids:
            p = E.load(pid)
            for r in p["requests"]:
                if r["status"] == "pendiente":
                    n += 1
                    print(f"{pid}  [{r['id']}]  {time.strftime('%d/%m %H:%M', time.localtime(r['t']))}  {r['text']}")
        if not n:
            print("No hay pedidos pendientes.")
        return

    pid = args.id
    if cmd == "esperar":
        while True:
            p = E.load(pid)
            if p["status"] != "transcribiendo":
                print("Listo:", ", ".join(f"{c['id']}={c.get('status')}" for c in p["clips"]))
                return
            time.sleep(2)
    if cmd == "clips":
        return cmd_clips(E.load(pid))
    if cmd == "texto":
        return cmd_texto(E.load(pid), args.todo)
    if cmd == "referencia":
        p = E.load(pid)
        ref = (p.get("reference") or {})
        if not ref.get("analysis"):
            sys.exit("Este proyecto no tiene referencia analizada.")
        print(json.dumps(ref["analysis"], ensure_ascii=False, indent=1))
        print("Hoja de fotogramas:", E.project_dir(pid) / "media" / "ref_sheet.jpg")
        return
    if cmd == "igualar-color":
        p = E.load(pid)
        n = E.match_clips_color(p)
        res = {c["id"]: (c.get("stats"), c.get("adjust")) for c in p["clips"]}

        def fn(q):
            for c in q["clips"]:
                if c["id"] in res:
                    c["stats"], c["adjust"] = res[c["id"]][0], res[c["id"]][1] or {}
            E.add_log(q, "claude", f"Igualé el color de {n} clips.")
        E.update(pid, fn)
        print(f"Igualé {n} clips.")
        return
    if cmd == "exportar":
        p = E.load(pid)
        opts = {"srt": args.srt, "subtitles": not args.sin_subtitulos, "loudnorm": not args.sin_normalizar,
                "quality": args.calidad, "fps": args.fps, "res": 2160 if args.uhd else int(args.res),
                "codec": "prores" if args.prores else "h264"}
        if args.formato:
            opts["format"] = args.formato
        last = [0.0]

        def prog(f, msg=""):
            if f - last[0] >= 0.1:
                last[0] = f
                print(f"  {int(f * 100)}% {msg}", flush=True)
        r = E.render(p, opts, prog)
        E.update(pid, lambda x: E.add_log(x, "claude", f"Exporté {r['file']} · {r['size_px']} · {r['fps']} fps · {r['codec']}"))
        print("Listo:", E.project_dir(pid) / "exports" / r["file"])
        return

    msg = []

    def fn(p):
        W = p["words"]
        if cmd in ("cortar", "restaurar", "mantener"):
            idx = parse_ranges(args.rangos, len(W))
            for i in idx:
                if cmd == "cortar":
                    W[i].update(cut=True, reason=args.motivo or "editado por Claude", by="claude")
                else:
                    W[i].update(cut=False, reason="", by="keep", **({"suggest": ""} if cmd == "mantener" else {}))
            verb = {"cortar": "Quité", "restaurar": "Restauré", "mantener": "Protegí"}[cmd]
            txt = " ".join(W[i]["text"] for i in idx[:12]) + ("…" if len(idx) > 12 else "")
            E.add_log(p, "claude", f"{verb} «{txt}»" + (f" — {args.motivo}" if args.motivo else ""))
            msg.append(f"{verb} {len(idx)} palabras.")
        elif cmd == "corregir":
            old = W[args.indice]["text"]
            W[args.indice]["text"] = args.texto
            E.add_log(p, "claude", f"Corregí «{old}» → «{args.texto}»")
        elif cmd == "limpiar":
            E.autoclean(p)
            msg.append(f"Limpieza: {p.get('autoStats')}")
        elif cmd == "armar":
            r = E.auto_assemble(p)
            E.add_log(p, "claude", r)
            msg.append(r)
        elif cmd == "aplicar-referencia":
            done = E.apply_reference(p)
            E.add_log(p, "claude", "Apliqué el estilo de la referencia: " + ", ".join(done))
            msg.append(", ".join(done))
        elif cmd == "orden":
            items = {t["clip"]: t for t in p["timeline"]}
            missing = [c for c in args.clips if c not in items]
            if missing:
                sys.exit(f"No están en la secuencia: {missing}. Usa 'rol ID CLIP principal' primero.")
            p["timeline"] = [items[c] for c in args.clips] + [t for t in p["timeline"] if t["clip"] not in args.clips]
            E.add_log(p, "claude", "Cambié el orden: " + " → ".join(args.clips))
        elif cmd == "recorte":
            t = next((t for t in p["timeline"] if t["clip"] == args.clip), None)
            if not t:
                sys.exit("Ese clip no está en la secuencia.")
            if args.entrada is not None:
                t["in"] = max(0.0, args.entrada)
            if args.salida is not None:
                t["out"] = args.salida
            if args.completo is not None:
                t["full"] = args.completo == "si"
            E.add_log(p, "claude", f"Recorté {args.clip}: {t['in']:.1f}–{t['out']:.1f}s")
        elif cmd == "rol":
            c = E.clip_by_id(p, args.clip)
            if not c:
                sys.exit("No existe ese clip.")
            p["timeline"] = [t for t in p["timeline"] if t["clip"] != args.clip]
            p["broll"] = [b for b in p["broll"] if b["clip"] != args.clip]
            if args.rol == "principal":
                p["timeline"].append({"clip": args.clip, "in": 0.0, "out": c.get("duration", 0)})
            elif args.rol == "apoyo":
                p["broll"].append({"id": uuid.uuid4().hex[:6], "clip": args.clip, "at": 2.0,
                                   "dur": round(min(2.5, c.get("duration", 2) - 0.3), 2), "srcIn": 0.3})
            E.add_log(p, "claude", f"{c['name']}: ahora es {args.rol}.")
        elif cmd == "apoyo":
            c = E.clip_by_id(p, args.clip)
            if not c:
                sys.exit("No existe ese clip.")
            p["broll"].append({"id": uuid.uuid4().hex[:6], "clip": args.clip, "at": args.en, "dur": args.dur,
                               "srcIn": args.desde})
            E.add_log(p, "claude", f"Puse «{c['name']}» de apoyo en {args.en:.1f}s ({args.dur:.1f}s).")
        elif cmd == "silenciar":
            c = E.clip_by_id(p, args.clip)
            if not c:
                sys.exit("No existe ese clip.")
            c["muted"] = args.estado == "si"
            E.add_log(p, "claude", f"{'Quité' if c['muted'] else 'Devolví'} el audio de «{c['name']}».")
        elif cmd == "quitar-apoyo":
            p["broll"] = [b for b in p["broll"] if b["id"] != args.apoyo]
        elif cmd == "transicion":
            if args.clip:
                t = next((t for t in p["timeline"] if t["clip"] == args.clip), None)
                if not t:
                    sys.exit("Ese clip no está en la secuencia.")
                t["transition"] = {k: v for k, v in (("type", args.tipo), ("dur", args.dur)) if v is not None}
            else:
                if args.tipo:
                    p["settings"]["transition"]["type"] = args.tipo
                if args.dur is not None:
                    p["settings"]["transition"]["dur"] = args.dur
            E.add_log(p, "claude", f"Transición: {args.tipo or ''} {args.dur or ''}" + (f" en {args.clip}" if args.clip else ""))
        elif cmd == "color":
            keys = {"exposicion": "exposure", "contraste": "contrast", "saturacion": "saturation",
                    "temperatura": "temperature", "tinte": "tint", "vineta": "vignette"}
            if args.clip:
                c = E.clip_by_id(p, args.clip)
                tgt = c.setdefault("adjust", {})
            else:
                tgt = p["settings"]["grade"]
                if args.look:
                    tgt["look"] = args.look
            for k, v in keys.items():
                if getattr(args, k) is not None:
                    tgt[v] = max(-1.0, min(1.0, getattr(args, k)))
            E.add_log(p, "claude", f"Color{' de ' + args.clip if args.clip else ''}: {tgt}")
        elif cmd == "estilo":
            st = p["style"]
            if args.preset:
                st.clear(); st.update(E.default_style(args.preset))
            for k, v in {"fuente": "font", "tamano": "size", "color": "color", "resaltado": "highlight",
                         "borde": "outline", "posicion": "position", "palabras": "maxWords"}.items():
                if getattr(args, k) is not None:
                    st[v] = getattr(args, k)
            if args.mayusculas:
                st["uppercase"] = args.mayusculas == "si"
            if args.caja:
                st["box"] = args.caja == "si"
            E.add_log(p, "claude", f"Cambié el estilo de subtítulos ({st.get('preset')}).")
        elif cmd == "ajustes":
            s = p["settings"]
            for k, v in {"pausa": "maxPause", "margen": "padding", "ritmo_tomas": "pace", "formato": "format",
                         "encuadre": "fit", "posx": "cropX", "posy": "cropY"}.items():
                if getattr(args, k) is not None:
                    s[v] = getattr(args, k)
            if args.silencios:
                s["removeSilences"] = args.silencios == "si"
            if args.subtitulos:
                s["subtitles"] = args.subtitulos == "si"
        elif cmd == "musica":
            m = p["settings"]["music"]
            if not m.get("file"):
                sys.exit("El proyecto no tiene música. Que el usuario la suba en la pestaña Audio.")
            for k, v in {"volumen": "volume", "entrada": "fadeIn", "salida": "fadeOut", "inicio": "start"}.items():
                if getattr(args, k) is not None:
                    m[v] = getattr(args, k)
            if args.bajar:
                m["duck"] = args.bajar == "si"
            if args.ritmo:
                m["beatSync"] = args.ritmo == "si"
        elif cmd == "marca":
            s = p["settings"]
            if args.marca:
                s["brand"] = "" if args.marca == "ninguna" else args.marca
            lg = s["logo"]
            if args.logo:
                lg["on"] = args.logo == "si"
            for k, v in {"pos": "pos", "tam": "size", "opacidad": "opacity"}.items():
                if getattr(args, k) is not None:
                    lg[v] = getattr(args, k)
            for k, key in (("intro", "intro"), ("cierre", "outro")):
                v = getattr(args, k)
                if v is not None:
                    s[key]["on"] = v != "no"
                    if v != "no":
                        s[key]["text"] = v
        elif cmd == "hecho":
            r = next((r for r in p["requests"] if r["id"] == args.pedido), None)
            if not r:
                sys.exit("No existe ese pedido.")
            r.update(status="hecho", note=args.nota, done=time.time())
            E.add_log(p, "claude", f"Pedido resuelto: {args.nota}")
        elif cmd == "nota":
            E.add_log(p, "claude", args.texto)
    p = E.update(pid, fn)
    for m in msg:
        print(m)
    print(f"OK · duración final {E.plan(p)['total']:.1f}s")


if __name__ == "__main__":
    main()
