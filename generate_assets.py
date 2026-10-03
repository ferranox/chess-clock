#!/usr/bin/env python3
"""Generate all PNG icons and favicons for the Tempo chess-clock PWA.
Design: rounded dark square, warm accent chess-clock face with two hands,
subtle "two dial" chess-clock motif. No external assets.
Run: python3 generate_assets.py
"""
import math
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))

BG_TOP = (26, 30, 38)        # deep slate
BG_BOT = (16, 18, 24)
ACCENT = (232, 168, 74)      # warm amber (wood/brass feel)
ACCENT_2 = (245, 245, 240)   # ivory
DIAL = (240, 236, 228)       # ivory dial
DIAL_RING = (44, 48, 58)
HAND = (26, 30, 38)


def _rounded_bg(size):
    """Vertical gradient rounded-square background."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.new("RGBA", (size, size))
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t)
        g = int(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t)
        b = int(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t)
        for x in range(size):
            grad.putpixel((x, y), (r, g, b, 255))
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    radius = int(size * 0.22)
    md.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)
    return img


def _draw_hand(draw, cx, cy, length, angle_deg, width, color):
    a = math.radians(angle_deg - 90)  # 0deg = 12 o'clock
    x2 = cx + length * math.cos(a)
    y2 = cy + length * math.sin(a)
    draw.line([(cx, cy), (x2, y2)], fill=color, width=width)


def make_icon(size):
    scale = 4
    S = size * scale
    img = _rounded_bg(S)
    draw = ImageDraw.Draw(img)

    # top brass "bell" buttons hint (two small rounded rects) for chess-clock feel
    btn_w = int(S * 0.14)
    btn_h = int(S * 0.06)
    btn_y = int(S * 0.11)
    for bx in (int(S * 0.30), int(S * 0.70)):
        draw.rounded_rectangle(
            [bx - btn_w // 2, btn_y - btn_h // 2, bx + btn_w // 2, btn_y + btn_h // 2],
            radius=btn_h // 2, fill=ACCENT,
        )

    # main clock face
    cx, cy = S // 2, int(S * 0.56)
    R = int(S * 0.32)
    # outer ring
    draw.ellipse([cx - R, cy - R, cx + R, cy + R], fill=ACCENT)
    inner = int(R * 0.86)
    draw.ellipse([cx - inner, cy - inner, cx + inner, cy + inner], fill=DIAL)
    # tick marks
    for i in range(12):
        ang = math.radians(i * 30 - 90)
        r1 = inner * 0.82
        r2 = inner * 0.96
        w = int(S * 0.012) if i % 3 else int(S * 0.02)
        draw.line(
            [
                (cx + r1 * math.cos(ang), cy + r1 * math.sin(ang)),
                (cx + r2 * math.cos(ang), cy + r2 * math.sin(ang)),
            ],
            fill=DIAL_RING, width=max(1, w),
        )
    # hands (10:10 classic + a chess tempo look)
    _draw_hand(draw, cx, cy, inner * 0.55, 300, max(2, int(S * 0.028)), HAND)  # hour ~10
    _draw_hand(draw, cx, cy, inner * 0.78, 60, max(2, int(S * 0.020)), HAND)   # minute ~2
    # center cap
    cap = int(S * 0.03)
    draw.ellipse([cx - cap, cy - cap, cx + cap, cy + cap], fill=ACCENT)

    img = img.resize((size, size), Image.LANCZOS)
    return img


def make_favicon_png(size):
    return make_icon(size)


def main():
    os.makedirs(os.path.join(HERE, "icons"), exist_ok=True)
    # PWA icons
    make_icon(192).save(os.path.join(HERE, "icons", "icon-192.png"))
    make_icon(512).save(os.path.join(HERE, "icons", "icon-512.png"))
    make_icon(180).save(os.path.join(HERE, "icons", "apple-touch-icon.png"))
    # favicons
    make_favicon_png(16).save(os.path.join(HERE, "favicon-16.png"))
    make_favicon_png(32).save(os.path.join(HERE, "favicon-32.png"))
    # multi-size .ico
    ico = make_icon(64)
    ico.save(
        os.path.join(HERE, "favicon.ico"),
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64)],
    )
    print("Assets generated:")
    for p in ["icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
              "favicon-16.png", "favicon-32.png", "favicon.ico"]:
        fp = os.path.join(HERE, p)
        print(f"  {p}: {os.path.getsize(fp)} bytes")


if __name__ == "__main__":
    main()
