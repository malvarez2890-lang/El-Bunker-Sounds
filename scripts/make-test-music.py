#!/usr/bin/env python3
"""Crea música de prueba (tonos con ffmpeg + carátulas con Pillow) con la misma estructura que la carpeta real:
Artista/<Artista>/{Albums,EPs,Singles}/<Álbum>/NN. Título.wav + PORTADA.png + CONTRAPORTADA.png
Uso: python3 scripts/make-test-music.py <carpeta_destino> [segundos_por_cancion]"""
import math, os, random, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

dest = sys.argv[1]
secs = sys.argv[2] if len(sys.argv) > 2 else "6"
root = os.path.join(dest, "Artista")

# (artista, tipo, carpeta de álbum, [títulos], con_portada)
LIBRARY = [
    ("PIÙ VELOCE", "Albums", "01. Musica per te",
     ["Che Livello!", "Neon", "Modello Ideale!", "Non Era Nei Piani", "Resta Ancora Un Po", "Calore Nella Pelle",
      "Questa Notte Rimarrà", "Cioccolata Calda", "Cartoline Senza Indirizzo", "Più Veloce & Carlo D'Oliva",
      "Fammi Ballare", "Vicino A Me", "Orizzonte Elettrico", "Balla Con Me", "Birreria Più Veloce"], True),
    ("PIÙ VELOCE", "Albums", "02. Neon, Fumo e Promesse",
     ["Luci Accese", "Velocità", "Corpi Elettrici", "Parlami Piano", "Amici Per Caso", "Ancora Un Drink", "Febbre",
      "Tutto Gira", "3.17", "Ansia BLu", "Ancora Una Volta", "Prima Del Sole"], True),
    ("PIÙ VELOCE", "Albums", "03. Lasciati Andare",
     ["Il Matto", "Nessuna Risposta", "La Luna È Storta", "Aspetta", "Donna Di Pace", "Piccolo Universo", "Nei Meandri",
      "Piccole Cose Gigante", "La Torre", "Ho Perso La Pazienza"], True),
    ("PIÙ VELOCE", "Albums", "06. Scusa... Sono Io", ["Pista Uno", "Pista Due", "Pista Tres"], False),
    ("El MAS LENTO", "EPs", "Più Lento",
     ["01. ENTRE LOS ÁRBOLES", "02. DONDE TERMINA LA TARDE", "03. SOMBRAS DE NEÓN", "Mañana", "Waracverso"], False),
]
PALETTES = [((236, 72, 153), (40, 12, 60)), ((255, 160, 40), (50, 20, 10)), ((60, 190, 200), (8, 30, 50)),
            ((130, 90, 255), (20, 10, 55)), ((240, 90, 60), (50, 10, 15))]

def font(size):
    for p in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"]:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def cover(path, seed, title, back=False, tracks=()):
    rnd = random.Random(seed)
    hi, lo = PALETTES[seed % len(PALETTES)]
    n = 1024
    img = Image.new("RGB", (n, n), lo)
    d = ImageDraw.Draw(img)
    for y in range(n):  # degradado vertical
        t = y / n
        d.line([(0, y), (n, y)], fill=tuple(int(lo[i] * (1 - t * 0.6) + hi[i] * t * 0.25) for i in range(3)))
    cx, cy = n // 2, int(n * 0.42)
    for r in range(380, 40, -34):  # círculos concéntricos
        k = r / 380
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 203, 36), width=3, fill=tuple(int(hi[i] * (1 - k * 0.5)) for i in range(3)) if r == 380 else None)
    d.ellipse([cx - 230, cy - 230, cx + 230, cy + 230], fill=hi)
    d.polygon([(0, n), (0, 760), (250, 560), (470, 760), (640, 650), (n, 800), (n, n)], fill=(15, 10, 20))
    f = font(54)
    d.text((48, 48), title[:26], font=f, fill=(243, 240, 233))
    if back:
        img = Image.new("RGB", (n, n), (20, 22, 25))
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, n, 12], fill=(255, 203, 36))
        d.text((60, 70), title[:28], font=font(60), fill=(255, 203, 36))
        for i, t in enumerate(tracks[:16]):
            d.text((60, 190 + i * 46), f"{i + 1:02d}  {t[:34]}", font=font(30), fill=(243, 240, 233))
    img.save(path)

def tone(path, freq, secs):
    af = f"sine=frequency={freq}:duration={secs}:sample_rate=48000"
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", af,
                    "-af", "tremolo=f=3:d=0.4,volume=0.35,pan=stereo|c0=c0|c1=c0", "-c:a", "pcm_s16le", path], check=True)

count = 0
for idx, (artist, kind, album, titles, has_cover) in enumerate(LIBRARY):
    folder = os.path.join(root, artist, kind, album)
    os.makedirs(folder, exist_ok=True)
    for i, t in enumerate(titles):
        name = t if (t[:2].isdigit() and t[2:4] == ". ") or kind == "EPs" and not t[:2].isdigit() else f"{i + 1:02d}. {t}"
        tone(os.path.join(folder, name + ".wav"), 220 + 25 * ((idx * 7 + i) % 14), secs)
        count += 1
    if has_cover:
        pretty = album.split(". ", 1)[-1]
        cover(os.path.join(folder, "PORTADA.png"), idx, pretty)
        cover(os.path.join(folder, "CONTRAPORTADA.png"), idx + 1, pretty, back=True, tracks=titles)
# carpetas vacías y un sencillo suelto, como en la carpeta real
for a, k in [("El MAS LENTO", "Albums"), ("El MAS LENTO", "Singles"), ("PIÙ VELOCE", "EPs"), ("PIÙ VELOCE", "Singles")]:
    os.makedirs(os.path.join(root, a, k), exist_ok=True)
tone(os.path.join(root, "El MAS LENTO", "Singles", "Sola En La Noche.wav"), 330, secs)
count += 1
print(f"{count} canciones creadas en {root}")
