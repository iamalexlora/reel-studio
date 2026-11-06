"""Genera el fondo del DMG (660×440 y @2x) con las instrucciones de instalación."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = Path(__file__).resolve().parent
FONTS = HERE.parent.parent / "app" / "fonts"


def make(scale: int, out: Path):
    W, H = 660 * scale, 440 * scale
    s = lambda v: int(v * scale)  # noqa: E731
    img = Image.new("RGB", (W, H), "#0B0B0C")
    # degradado suave y brillo azul/violeta
    glow = Image.new("RGB", (W, H), "#0B0B0C")
    g = ImageDraw.Draw(glow)
    g.ellipse([s(-120), s(-220), s(420), s(220)], fill="#13213F")
    g.ellipse([s(300), s(-240), s(820), s(200)], fill="#1D1838")
    glow = glow.filter(ImageFilter.GaussianBlur(s(90)))
    img = Image.blend(img, glow, 0.9)
    d = ImageDraw.Draw(img)
    bold = ImageFont.truetype(str(FONTS / "Poppins-ExtraBold.ttf"), s(22))
    semi = ImageFont.truetype(str(FONTS / "Poppins-SemiBold.ttf"), s(12.5))
    body = ImageFont.truetype(str(FONTS / "HankenGrotesk.ttf"), s(12))
    small = ImageFont.truetype(str(FONTS / "HankenGrotesk.ttf"), s(11))

    def center(text, y, font, fill):
        w = d.textlength(text, font=font)
        d.text(((W - w) / 2, y), text, font=font, fill=fill)

    center("Arrastra Reel Studio a Aplicaciones", s(26), bold, "#F5F5F7")
    # flecha entre los dos íconos (íconos en x=170 y x=490, y=165)
    y = s(165)
    d.line([s(250), y, s(398), y], fill="#3E6CF0", width=s(5))
    d.polygon([(s(410), y), (s(394), y - s(11)), (s(394), y + s(11))], fill="#3E6CF0")
    # recuadro de instrucciones
    box = [s(36), s(262), W - s(36), H - s(24)]
    d.rounded_rectangle(box, radius=s(16), fill="#1A1A1D", outline="#2C2C31", width=max(1, s(1)))
    d.text((s(56), s(278)), "Primera vez que lo abres", font=semi, fill="#F5F5F7")
    steps = [
        "1.  Abre Reel Studio desde la carpeta Aplicaciones.",
        "2.  Si la Mac dice que no puede abrirlo, entra a Ajustes del Sistema › Privacidad y seguridad.",
        "3.  Baja hasta el final y toca «Abrir igualmente». Confirma con tu contraseña o Touch ID.",
        "4.  Listo: desde ahí se abre normal y se actualiza solo.",
    ]
    for i, t in enumerate(steps):
        d.text((s(56), s(304) + i * s(22)), t, font=body, fill="#C9CBD0")
    img.save(out)


if __name__ == "__main__":
    make(1, HERE / "fondo.png")
    make(2, HERE / "fondo@2x.png")
    print("ok")
