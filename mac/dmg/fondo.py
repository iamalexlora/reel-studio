"""Genera el fondo del DMG (660×520 y @2x) con instrucciones bien visibles."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = Path(__file__).resolve().parent
FONTS = HERE.parent.parent / "app" / "fonts"
W0, H0 = 660, 520
ICON_Y = 128  # debe coincidir con settings.py


def make(scale: int, out: Path):
    W, H = W0 * scale, H0 * scale
    s = lambda v: int(v * scale)  # noqa: E731
    # parte de arriba clara (Finder escribe los nombres de los íconos en negro) y abajo oscura
    img = Image.new("RGB", (W, H), "#0B0B0C")
    top = Image.new("RGB", (W, s(206)), "#E4E5E9")
    tg = ImageDraw.Draw(top)
    for i in range(s(206)):
        c = int(236 - 18 * i / s(206))
        tg.line([0, i, W, i], fill=(c, c, c + 4))
    img.paste(top, (0, 0))
    d = ImageDraw.Draw(img)
    F = lambda name, size: ImageFont.truetype(str(FONTS / name), s(size))  # noqa: E731
    title, head, step, stepb = F("Poppins-ExtraBold.ttf", 19), F("Poppins-ExtraBold.ttf", 16), \
        F("Poppins-SemiBold.ttf", 13), F("Poppins-ExtraBold.ttf", 13)

    def center(text, y, font, fill):
        w = d.textlength(text, font=font)
        d.text(((W - w) / 2, y), text, font=font, fill=fill)

    center("1 · Arrastra Reel Studio a Aplicaciones", s(16), title, "#1D1D1F")
    y = s(ICON_Y)
    d.line([s(250), y, s(398), y], fill="#3E6CF0", width=s(5))
    d.polygon([(s(410), y), (s(394), y - s(11)), (s(394), y + s(11))], fill="#3E6CF0")

    # recuadro amarillo muy visible
    box = [s(24), s(222), W - s(24), H - s(18)]
    d.rounded_rectangle(box, radius=s(18), fill="#1C1A10", outline="#FFE14D", width=s(2.5))
    d.rounded_rectangle([box[0], box[1], box[2], box[1] + s(42)], radius=s(18), fill="#FFE14D")
    d.rectangle([box[0], box[1] + s(24), box[2], box[1] + s(42)], fill="#FFE14D")
    tx, ty = s(46), box[1] + s(10)
    d.polygon([(tx + s(11), ty), (tx, ty + s(20)), (tx + s(22), ty + s(20))], fill="#111111")
    d.text((tx + s(9.2), ty + s(2.5)), "!", font=stepb, fill="#FFE14D")
    d.text((tx + s(32), box[1] + s(9)), "2 · LEE ESTO ANTES DE ABRIRLO POR PRIMERA VEZ", font=head, fill="#111111")
    steps = [
        ("Abre Reel Studio desde la carpeta Aplicaciones.", False),
        ("Saldrá un aviso de que no se pudo abrir: toca «Listo».", True),
        ("NO toques «Mover a la papelera».", True),
        ("Ve a Ajustes del Sistema › Privacidad y seguridad.", False),
        ("Baja hasta el final y toca «Abrir igualmente».", False),
        ("Confirma con tu contraseña o Touch ID. ¡Listo!", False),
    ]
    yy = box[1] + s(56)
    for i, (t, warn) in enumerate(steps):
        cx, cy, r = s(58), yy + s(10), s(11)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill="#FF453A" if warn else "#3E6CF0")
        n = str(i + 1)
        d.text((cx - d.textlength(n, font=stepb) / 2, cy - s(9)), n, font=stepb, fill="#FFFFFF")
        d.text((s(80), yy), t, font=stepb if warn else step, fill="#FFE14D" if warn else "#F5F5F7")
        yy += s(30)
    note = "Solo se hace una vez. Después se abre normal y se actualiza solo."
    d.text((s(80), yy + s(4)), note, font=step, fill="#9EA0A6")
    img.save(out)


if __name__ == "__main__":
    make(1, HERE / "fondo.png")
    make(2, HERE / "fondo@2x.png")
    print("ok")
