#!/usr/bin/env python3
"""BimRadar PWA icons — monochrome, Trade-Republic style: a single clean white
Bim (tram) mark on pure black, with generous negative space. No colour, no gradient."""
from PIL import Image, ImageDraw

BLACK = (0, 0, 0, 255)
WHITE = (255, 255, 255, 255)
OUT = "/var/apps/eliashammer/bimradar/"

def rr(d, box, r, **kw):
    d.rounded_rectangle(box, radius=r, **kw)

def draw_tram(d, cx, cy, h):
    """Front-view Bim centered at (cx,cy), body height h. White body, black cutouts."""
    w = h * 0.56
    x0, y0, x1, y1 = cx - w/2, cy - h/2, cx + w/2, cy + h/2
    # solid white body
    rr(d, (x0, y0, x1, y1), h * 0.22, fill=WHITE)
    # windshield: a single bold black cutout near the top (the defining feature)
    m = w * 0.15
    rr(d, (x0 + m, y0 + h * 0.15, x1 - m, y0 + h * 0.44), h * 0.09, fill=BLACK)
    # thin black waistline under the windshield
    sy = y0 + h * 0.53
    rr(d, (x0 + m, sy, x1 - m, sy + h * 0.045), h * 0.02, fill=BLACK)
    # two black headlights near the bottom
    lr = h * 0.055
    ly = y1 - h * 0.15
    for lx in (x0 + w * 0.30, x1 - w * 0.30):
        d.ellipse((lx - lr, ly - lr, lx + lr, ly + lr), fill=BLACK)

def make(size, maskable=False, rounded=True):
    ss = 4
    N = size * ss
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle((0, 0, N, N), fill=BLACK)          # full-bleed for mask safe zone
        draw_tram(d, N/2, N/2, N * 0.46)
    else:
        if rounded:
            rr(d, (0, 0, N-1, N-1), N * 0.22, fill=BLACK)
        else:
            d.rectangle((0, 0, N, N), fill=BLACK)
        draw_tram(d, N/2, N/2, N * 0.60)
    return img.resize((size, size), Image.LANCZOS)

make(192).save(OUT + "icon-192.png")
make(512).save(OUT + "icon-512.png")
make(192, maskable=True).save(OUT + "icon-192-maskable.png")
make(512, maskable=True).save(OUT + "icon-512-maskable.png")
make(180).save(OUT + "icon-180.png")
make(32).save(OUT + "icon-32.png")
print("monochrome icons written")
