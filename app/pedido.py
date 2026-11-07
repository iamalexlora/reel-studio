"""Lee lo que el usuario escribe en «Cuéntame cómo lo quieres» y lo convierte en ajustes del video.

Funciona sin internet: reconoce frases comunes en español (duración, ritmo, estilo, color,
transiciones, subtítulos, música, título y cierre). Devuelve qué entendió para mostrárselo.
"""
import re
import unicodedata

COLORS = {
    "amarill": "#FFD60A", "blanc": "#FFFFFF", "negr": "#111111", "roj": "#FF3B30", "verde": "#34C759",
    "azul": "#0A84FF", "celeste": "#64D2FF", "ros": "#FF2D92", "fucsia": "#FF2D92", "naranja": "#FF9F0A",
    "morad": "#AF52DE", "lila": "#BF5AF2", "violeta": "#AF52DE", "dorad": "#E5B80B", "turquesa": "#30D5C8",
}
COLOR_RX = r"(amarill\w*|blanc\w*|negr\w*|roj\w*|verdes?|azul\w*|celestes?|ros\w*|fucsia|naranjas?|morad\w*|lilas?|violetas?|dorad\w*|turquesas?)"

VIBE_WORDS = [
    ("viral", r"\bviral|tiktoker|tendencia"),
    ("energetico", r"energ|deport|gym|gimnasio|adrenalina|intens"),
    ("dinamico", r"dinamic"),
    ("elegante", r"elegant|lujo|premium|sofistic|boda"),
    ("cinematico", r"cinemat|cine\b|pelicula|epico"),
    ("corporativo", r"corporativ|empresa|institucional|profesional"),
    ("calido", r"calid[oa]\b|acogedor|familiar"),
    ("vintage", r"vintage|retro|antigu|nostalg"),
    ("bn", r"blanco y negro|b ?& ?n|byn\b|monocrom"),
    ("natural", r"\bnatural\b|sin filtro"),
]


VIBE_LABEL = {"viral": "viral", "energetico": "energético", "dinamico": "dinámico", "elegante": "elegante",
              "cinematico": "cinemático", "corporativo": "corporativo", "calido": "cálido", "vintage": "vintage",
              "bn": "blanco y negro", "natural": "natural"}


def _norm(t: str) -> str:
    t = unicodedata.normalize("NFD", t.lower())
    return "".join(ch for ch in t if unicodedata.category(ch) != "Mn")


def _color(word: str):
    for k, v in COLORS.items():
        if word.startswith(k):
            return v
    return None


def _num(s: str) -> float:
    words = {"un": 1, "una": 1, "uno": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5, "seis": 6,
             "diez": 10, "quince": 15, "veinte": 20, "treinta": 30, "cuarenta": 40, "cincuenta": 50, "sesenta": 60}
    return float(words.get(s, s.replace(",", ".")))


NUM = r"(\d+(?:[.,]\d+)?|un|una|uno|dos|tres|cuatro|cinco|seis|diez|quince|veinte|treinta|cuarenta|cincuenta|sesenta)"


def parse(text: str) -> dict:
    """→ {"make": {...opciones de Hacer mi video}, "settings": {...}, "style": {...}, "music": {...},
          "transition": str|None, "order": str|None, "understood": [frases]}"""
    raw = (text or "").strip()
    t = _norm(raw)
    out = {"make": {}, "settings": {}, "style": {}, "music": {}, "transition": None, "order": None, "understood": []}
    if not t:
        return out
    say = out["understood"].append
    mk, st, sty, mus = out["make"], out["settings"], out["style"], out["music"]

    # --- duración
    m = re.search(r"\b(\d{1,2}):(\d{2})\b", t)
    secs = None
    if m:
        secs = int(m.group(1)) * 60 + int(m.group(2))
    else:
        mm = re.search(NUM + r"\s*(?:min\b|mins\b|minutos?)", t)
        ss = re.search(NUM + r"\s*(?:s\b|seg\b|segs\b|segundos?)", t)
        if "medio minuto" in t:
            secs = 30
        elif mm or ss:
            secs = (_num(mm.group(1)) * 60 if mm else 0) + (_num(ss.group(1)) if ss else 0)
            if mm and re.search(r"minutos? y medio|min y medio", t):
                secs += 30
    if secs and 3 <= secs <= 1800:
        mk["maxDur"] = int(secs)
        say(f"dura {int(secs) // 60}:{int(secs) % 60:02d}" if secs >= 60 else f"dura {int(secs)} s")

    # --- formato
    if re.search(r"horizontal|youtube|16:9|apaisad", t):
        mk["format"] = "horizontal"; say("formato horizontal")
    elif re.search(r"cuadrad|1:1", t):
        mk["format"] = "cuadrado"; say("formato cuadrado")
    elif re.search(r"4:5|feed", t):
        mk["format"] = "4:5"; say("formato feed 4:5")
    elif re.search(r"vertical|reel|tiktok|historia|story|stories|shorts|9:16", t):
        mk["format"] = "vertical"

    # --- estilo general
    for key, rx in VIBE_WORDS:
        if re.search(rx, t):
            mk["style"] = key
            say("estilo " + VIBE_LABEL[key])
            break

    # --- ritmo
    if re.search(r"(ritmo|cortes|tomas|edicion)\s+(muy\s+)?(rapid|agil|dinamic|cort)|rapidit|acelerad|muchos cortes", t):
        st["paceMul"] = 0.55 if "muy" in t else 0.72; say("ritmo rápido")
    elif re.search(r"(ritmo|cortes|tomas|edicion)\s+(muy\s+)?(lent|tranquil|calmad|pausad|larg|suave)|relajad|sin prisa|\b(tranquil|calmad|lent)[oa]\b", t):
        st["paceMul"] = 1.8 if "muy" in t else 1.45; say("ritmo tranquilo")

    # --- transiciones
    if re.search(r"sin transicion|solo cortes|cortes secos|corte seco", t):
        out["transition"] = "corte"; say("solo cortes, sin transiciones")
    elif re.search(r"transiciones? variad|varias transiciones|distintas transiciones", t):
        out["transition"] = "variado"; say("transiciones variadas")
    else:
        for key, rx, lbl in (("disolver", r"disolv|fundid|suaves? transic", "disolvencias"),
                             ("zoom", r"transic\w* (de |con )?zoom|zoom entre", "transiciones con zoom"),
                             ("barrido", r"barrid|desliz", "barridos"),
                             ("negro", r"a negro|fundido negro", "fundidos a negro"),
                             ("blanco", r"flash", "flashes blancos"),
                             ("difuminar", r"desenfoq|blur|difumin", "desenfoques")):
            if re.search(rx, t):
                out["transition"] = key; say(lbl); break

    # --- subtítulos
    if re.search(r"sin (subtitulos|textos?|letras|captions)|no (pongas|quiero) (subtitulos|textos?)", t):
        mk["subtitles"] = False; say("sin subtítulos")
    else:
        if re.search(r"(con|pon|ponle|agrega) (los )?subtitulos", t):
            mk["subtitles"] = True; say("con subtítulos")
        m = re.search(r"(subtitulos?|letras?|textos?)\s+(?:de color\s+|en\s+|color\s+)?" + COLOR_RX, t)
        if m and _color(m.group(2)):
            sty["color"] = _color(m.group(2)); say(f"subtítulos {m.group(2)}")
        m = re.search(r"(resalt\w*|destac\w*|palabra clave\w*)\s+(?:de color\s+|en\s+|color\s+)?" + COLOR_RX, t)
        if m and _color(m.group(2)):
            sty["highlight"] = _color(m.group(2)); say(f"resaltado {m.group(2)}")
        m = re.search(r"(subtitulos?|letras?|textos?)\s+(?:\w+\s+){0,3}(arriba|al centro|en el centro|centrad\w*|abajo)", t)
        if m:
            pos = {"arriba": "arriba", "abajo": "abajo"}.get(m.group(2), "centro")
            sty["position"] = pos; say(f"subtítulos {pos}")
        if re.search(r"mayuscula", t):
            sty["uppercase"] = True; say("en mayúsculas")
        elif re.search(r"minuscula", t):
            sty["uppercase"] = False; say("en minúsculas")
        if re.search(r"(subtitulos?|letras?|textos?)\s+(mas\s+)?(grandes?|enormes?|gigantes?)", t):
            sty["sizeMul"] = 1.25; say("letra grande")
        elif re.search(r"(subtitulos?|letras?|textos?)\s+(mas\s+)?(pequen\w*|chic\w*|discret\w*)", t):
            sty["sizeMul"] = 0.8; say("letra pequeña")
        if re.search(r"(caja|fondo|recuadro) (detras|en|para|de) (los |las )?(subtitulos|letras|textos?)", t):
            sty["box"] = True; say("caja detrás del texto")
        m = re.search(r"(\d)\s+palabras?", t)
        if m and 1 <= int(m.group(1)) <= 8:
            sty["maxWords"] = int(m.group(1)); say(f"{m.group(1)} palabras por pantalla")

    # --- color (si no lo dio ya el estilo)
    if "style" not in mk or mk["style"] in ("dinamico", "viral", "energetico", "corporativo"):
        for look, rx, lbl in (("bn", r"blanco y negro|monocrom", "blanco y negro"),
                              ("calido", r"(colores?|tonos?|look)\s+calid|calidez|dorad[oa]s? tonos", "colores cálidos"),
                              ("frio", r"(colores?|tonos?|look)\s+fri|azulad", "colores fríos"),
                              ("vintage", r"vintage|retro", "look vintage"),
                              ("vivo", r"colores? (vivos?|intensos?|saturad)|colorid|muy colorido", "colores vivos"),
                              ("mate", r"\bmate\b|colores? (apagad|suaves?|lavad)", "colores suaves"),
                              ("cine", r"look de cine|tonos de cine|teal", "look de cine"),
                              ("natural", r"colores? natural|sin filtro", "colores naturales")):
            if re.search(rx, t):
                st["look"] = look; say(lbl); break

    # --- música y audio
    if re.search(r"sin musica|no (pongas|quiero) musica", t):
        mus["off"] = True; say("sin música")
    elif re.search(r"musica\s+(\w+\s+)?(suave|baja|bajita|tenue|de fondo|ligera)", t):
        mus["volume"] = 0.22; say("música suave de fondo")
    elif re.search(r"musica\s+(\w+\s+)?(fuerte|alta|a tope|protagonista|potente)", t):
        mus["volume"] = 1.0; say("música fuerte")
    if re.search(r"(al ritmo|a tiempo|sincroniz\w*) (de|con) la musica|cortes? (al|con el) ritmo|al compas", t):
        mus["beatSync"] = True; say("cortes al ritmo de la música")
    if re.search(r"sin (el )?(audio|sonido) (de los|del|original)|silencia\w* (los )?videos|quita\w* el audio", t):
        mk["videoAudio"] = False; say("sin el audio de los videos")
    elif re.search(r"(con|deja|mant\w*) (el )?(audio|sonido) (de los|del|original)", t):
        mk["videoAudio"] = True; say("con el audio de los videos")
    if re.search(r"(no|sin) (cortes? |quitar |quites )?(los )?silencios|deja los silencios", t):
        mk["clean"] = False; say("sin quitar silencios")
    elif re.search(r"(quita|corta|elimina)\w* (los )?(silencios|muletillas|errores|pausas)", t):
        mk["clean"] = True; say("quitar silencios y muletillas")

    # --- otros
    if re.search(r"sin animacion|no (pongas|quiero) animacion", t):
        mk["anims"] = False; say("sin animaciones")
    if re.search(r"sin zoom|no hagas zoom|sin acercamiento", t):
        st["punchIn"] = False; say("sin acercamientos")
    if re.search(r"\blogo\b", t) and not re.search(r"sin (el |mi )?logo", t):
        st["logo"] = True; say("con tu logo")
    if re.search(r"al reves|orden inverso|del ultimo al primero|de atras para adelante", t):
        out["order"] = "num-desc"; say("orden al revés")
    elif re.search(r"orden alfabetic|por nombre", t):
        out["order"] = "az"; say("orden por nombre")

    # --- título y cierre (texto entre comillas tiene prioridad)
    def quoted(after_rx):
        m0 = re.search(after_rx + r"[^\"“”«»']{0,25}[\"“«']([^\"”»']{2,300})[\"”»']", raw, re.I)
        return m0.groups()[-1].strip() if m0 else None
    title = quoted(r"(t[ií]tulo|empie[cz]\w*|inicio|al principio|portada)")
    if not title:
        m = re.search(r"t[ií]tulo\s*:\s*([^.\n,;]{2,300})", raw, re.I)
        title = m.group(1).strip() if m else None
    if title:
        mk["title"] = title; say(f"título «{title}»")
    cta = quoted(r"(cierre|cierra|final|termina|al final|despedida|llamada)")
    if not cta:
        m = re.search(r"(?:cierre|final)\s*:\s*([^.\n;]{2,300})", raw, re.I)
        cta = m.group(1).strip() if m else None
    if not cta:
        if re.search(r"(invit\w*|pide\w*|pedir) (a )?(seguirme|que me sigan|seguir)|sigueme|siganme", t):
            cta = "Sígueme para más"
        elif re.search(r"(invit\w*|pide\w*) (a )?(seguirnos|que nos sigan)|siguenos", t):
            cta = "Síguenos para más"
        elif re.search(r"(invit\w*) (a )?(comprar|que compren)|compra ahora", t):
            cta = "¡Compra ahora!"
        elif re.search(r"(invit\w*) (a )?(escribir|contactar|mensaje)|escribenos|contactanos", t):
            cta = "Escríbenos"
        elif re.search(r"(invit\w*) (a )?(comentar)|comenta", t):
            cta = "Comenta qué opinas"
        elif re.search(r"(invit\w*) (a )?(compartir)|comparte", t):
            cta = "Compártelo con alguien"
    if cta:
        mk["cta"] = cta; say(f"cierre «{cta}»")
    return out


def apply(q: dict, pr: dict, vibe_pace: float):
    """Aplica al proyecto lo que no pasa por las opciones de Hacer mi video (después del estilo)."""
    st, sty = q["settings"], q["style"]
    s = pr["settings"]
    if s.get("paceMul"):
        st["pace"] = round(max(0.6, min(6.0, vibe_pace * s["paceMul"])), 2)
    if s.get("look"):
        st["grade"]["look"] = s["look"]
    if "punchIn" in s:
        st["punchIn"] = s["punchIn"]
    if s.get("logo"):
        st.setdefault("logo", {})["on"] = True
    ps = dict(pr["style"])
    mul = ps.pop("sizeMul", None)
    if mul and sty.get("size"):
        sty["size"] = int(sty["size"] * mul)
    sty.update(ps)
    m = pr["music"]
    if m.get("off"):
        st["music"].update(file="", name="", beats=[], tempo=0, beatSync=False)
    if "volume" in m:
        st["music"]["volume"] = m["volume"]
        st["music"]["userVol"] = True
    if m.get("beatSync"):
        st["music"]["beatSync"] = True
