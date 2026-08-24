#!/usr/bin/env python3
"""Генерация иконок расширения. Требуется Pillow: pip install pillow
Запуск из корня репозитория: python3 tools/make-icons.py"""
import os
from PIL import Image, ImageDraw

S = 1024                      # рисуем крупно и уменьшаем — так чище края
NAVY = (26, 33, 56, 255)      # корпус плеера
BLUE = (61, 107, 255, 255)    # акцент
WHITE = (255, 255, 255, 255)
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'extension', 'icons')


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def build_large():
    """Версия для 48 px и крупнее: рамка, треугольник, две строки субтитров."""
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    rounded(d, [40, 40, S - 40, S - 40], 210, NAVY)
    d.rounded_rectangle([40, 40, S - 40, S - 40], radius=210, outline=BLUE, width=34)

    cx, cy, r = S // 2, 400, 150
    d.polygon([(cx - r * 0.62, cy - r), (cx - r * 0.62, cy + r), (cx + r * 0.9, cy)], fill=BLUE)

    rounded(d, [190, 640, S - 190, 716], 38, WHITE)
    rounded(d, [300, 770, S - 300, 846], 38, (255, 255, 255, 210))
    return img


def build_small():
    """Версия для 16-32 px: деталей меньше, контраст выше — иначе каша."""
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    rounded(d, [10, 10, S - 10, S - 10], 190, NAVY)

    cx, cy, r = S // 2, 400, 210
    d.polygon([(cx - r * 0.60, cy - r), (cx - r * 0.60, cy + r), (cx + r * 0.92, cy)], fill=BLUE)

    rounded(d, [150, 700, S - 150, 830], 65, WHITE)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    large, small = build_large(), build_small()
    for size in (16, 32, 48, 128):
        base = small if size <= 32 else large
        base.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, 'icon%d.png' % size))
        print('icon%d.png' % size)
    large.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, 'icon512.png'))
    print('icon512.png (для витрины/README)')


if __name__ == '__main__':
    main()
