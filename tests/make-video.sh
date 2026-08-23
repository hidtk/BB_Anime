#!/bin/sh
# Тестовый ролик для автотестов (30 секунд, VP8/WebM, без звука).
# Требуется ffmpeg. Запускать из папки tests.
ffmpeg -y -f lavfi -i testsrc=size=640x360:rate=15:duration=30 \
  -c:v libvpx -b:v 300k -g 15 -keyint_min 15 -auto-alt-ref 0 \
  -pix_fmt yuv420p -an video.webm
