#!/usr/bin/env python3
"""Genera las imágenes de arranque de iPhone (apple-touch-startup-image) con el logo centrado sobre el fondo de la app,
y escribe las etiquetas <link> en web/splash/links.html (se pegan en index.html)."""
from PIL import Image, ImageChops
import os
root = os.path.join(os.path.dirname(__file__), "..")
logo = Image.open(os.path.join(root, "design", "logo.webp")).convert("RGB")
out = os.path.join(root, "web", "splash")
os.makedirs(out, exist_ok=True)
BG = (9, 10, 12)
# (ancho css, alto css, factor de pantalla)
DEVICES = [(440, 956, 3), (402, 874, 3), (430, 932, 3), (393, 852, 3), (428, 926, 3), (390, 844, 3),
           (375, 812, 3), (414, 896, 3), (414, 896, 2), (414, 736, 3), (375, 667, 2)]
links = []
for w, h, r in DEVICES:
    W, H = w * r, h * r
    img = Image.new("RGB", (W, H), BG)
    lw = int(min(0.72 * w, 330) * r)               # igual que la pantalla de carga de la app
    lh = int(logo.height * lw / logo.width)
    l = logo.resize((lw, lh), Image.LANCZOS)
    pos = ((W - lw) // 2, (H - lh) // 2)
    region = img.crop((pos[0], pos[1], pos[0] + lw, pos[1] + lh))
    img.paste(ImageChops.screen(region, l), pos)    # "screen": el negro del logo se funde con el fondo
    name = f"splash-{W}x{H}.png"
    img.save(os.path.join(out, name), optimize=True)
    links.append(f'  <link rel="apple-touch-startup-image" href="/splash/{name}" media="(device-width: {w}px) and (device-height: {h}px) and (-webkit-device-pixel-ratio: {r}) and (orientation: portrait)">')
open(os.path.join(out, "links.html"), "w").write("\n".join(links) + "\n")
print(len(DEVICES), "imágenes creadas")
