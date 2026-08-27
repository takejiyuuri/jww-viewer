"""アイコン PNG を標準ライブラリだけで生成する"""
import struct, zlib, math

BG = (11, 12, 16)
FG = (53, 208, 127)
GRAY = (150, 158, 172)


def blend(dst, color, a):
    return tuple(int(dst[i] * (1 - a) + color[i] * a) for i in range(3))


def draw(size):
    px = [[BG for _ in range(size)] for _ in range(size)]
    s = size / 512.0

    def dist_seg(x, y, x1, y1, x2, y2):
        dx, dy = x2 - x1, y2 - y1
        L = dx * dx + dy * dy
        t = 0 if L == 0 else max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / L))
        return math.hypot(x - (x1 + dx * t), y - (y1 + dy * t))

    segs = []
    # 図面の輪郭（グレー）
    segs += [(80, 150, 260, 150, GRAY, 12), (260, 150, 260, 300, GRAY, 12),
             (260, 300, 432, 300, GRAY, 12), (432, 300, 432, 430, GRAY, 12),
             (432, 430, 80, 430, GRAY, 12), (80, 430, 80, 150, GRAY, 12)]
    # 計測線（緑）
    segs += [(120, 96, 400, 96, FG, 16)]
    # 寸法の端部
    segs += [(120, 70, 120, 122, FG, 14), (400, 70, 400, 122, FG, 14)]

    for cy in range(size):
        for cx in range(size):
            x, y = cx / s, cy / s
            best = None
            for (x1, y1, x2, y2, col, w) in segs:
                d = dist_seg(x, y, x1, y1, x2, y2) - w / 2
                if best is None or d < best[0]:
                    best = (d, col)
            d, col = best
            if d < 0.5:
                a = min(1.0, max(0.0, 0.5 - d))
                px[cy][cx] = blend(px[cy][cx], col, min(1.0, a * 2))
    return px


def write_png(path, px):
    size = len(px)
    raw = b''.join(b'\x00' + b''.join(bytes(p) for p in row) for row in px)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    open(path, 'wb').write(png)
    print(path, size, 'x', size)


for n in (180, 192, 512):
    write_png(f'public/icon-{n}.png', draw(n))
