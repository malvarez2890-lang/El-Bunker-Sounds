#!/usr/bin/env python3
"""Genera iconos de la app y el logo liviano a partir de los archivos originales en design/."""
from PIL import Image
import os
root = os.path.join(os.path.dirname(__file__), "..")
icon = Image.open(os.path.join(root, "design", "icono-app.webp")).convert("RGB")
logo = Image.open(os.path.join(root, "design", "logo.webp")).convert("RGB")
out = os.path.join(root, "web", "icons")
os.makedirs(out, exist_ok=True)
W = icon.width

def crop(img, margin):
    m = int(img.width * margin)
    return img.crop((m, m, img.width - m, img.height - m))

# Iconos normales: se recorta el margen negro para que el cuadrado ámbar llene el icono.
tight = crop(icon, 0.045)
tight.resize((512, 512), Image.LANCZOS).save(os.path.join(out, "icon-512.png"), optimize=True)
tight.resize((192, 192), Image.LANCZOS).save(os.path.join(out, "icon-192.png"), optimize=True)
tight.resize((180, 180), Image.LANCZOS).save(os.path.join(out, "apple-touch-icon.png"), optimize=True)
tight.resize((32, 32), Image.LANCZOS).save(os.path.join(out, "favicon-32.png"), optimize=True)
# Icono "maskable" (Android): el dibujo debe caber en el 80 % central.
canvas = Image.new("RGB", (512, 512), (0, 0, 0))
inner = icon.resize((410, 410), Image.LANCZOS)
canvas.paste(inner, (51, 51))
canvas.save(os.path.join(out, "icon-maskable-512.png"), optimize=True)
# Logo para pantallas (se mezcla con el fondo oscuro mediante CSS).
lw = 900
logo.resize((lw, int(logo.height * lw / logo.width)), Image.LANCZOS).save(os.path.join(root, "web", "img", "logo.webp"), quality=88)
mark = icon.resize((360, 360), Image.LANCZOS)
mark.save(os.path.join(root, "web", "img", "mark.webp"), quality=90)
print("iconos listos")
