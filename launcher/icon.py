#!/usr/bin/env python3
"""Draw the launcher icon (piano keys on a dark rounded square) as a 1024px
PNG with no dependencies beyond the standard library."""
import struct, zlib, sys

N = 1024
BG = (31, 36, 48)
WHITE = (245, 242, 235)
GAP = (120, 118, 112)
BLACK = (24, 24, 28)
TRANSPARENT = (0, 0, 0, 0)

px = bytearray(N * N * 4)

def put(x, y, c):
    i = (y * N + x) * 4
    px[i:i + 4] = bytes(c if len(c) == 4 else (*c, 255))

R = 220  # corner radius
inset = 60
def inside_rounded(x, y):
    x0, y0, x1, y1 = inset, inset, N - inset, N - inset
    if x < x0 or x >= x1 or y < y0 or y >= y1: return False
    cx = x0 + R if x < x0 + R else (x1 - R - 1 if x >= x1 - R else None)
    cy = y0 + R if y < y0 + R else (y1 - R - 1 if y >= y1 - R else None)
    if cx is None or cy is None: return True
    return (x - cx) ** 2 + (y - cy) ** 2 <= R * R

# keyboard geometry: 7 white keys across the inner area
kx0, kx1 = 150, N - 150
ky0, ky1 = 270, N - 200
kw = (kx1 - kx0) / 7
bw, bh = kw * 0.62, (ky1 - ky0) * 0.6
black_after = [0, 1, 3, 4, 5]  # black keys sit between these white keys and the next

for y in range(N):
    for x in range(N):
        if not inside_rounded(x, y):
            put(x, y, TRANSPARENT); continue
        c = BG
        if kx0 <= x < kx1 and ky0 <= y < ky1:
            k = int((x - kx0) / kw)
            c = WHITE
            if int((x - kx0) - k * kw) < 4 and k > 0: c = GAP
            for b in black_after:
                bx = kx0 + (b + 1) * kw - bw / 2
                if bx <= x < bx + bw and y < ky0 + bh: c = BLACK
        put(x, y, c)

def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
raw = b''.join(b'\x00' + bytes(px[y * N * 4:(y + 1) * N * 4]) for y in range(N))
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', N, N, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
open(sys.argv[1], 'wb').write(png)
