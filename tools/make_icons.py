"""アイコン PNG を元の絵 tools/icon-source.webp から作る（Pillow と numpy を使う）

元の絵は角を丸めた黒い板で、まわりは透明になっている。これを使い道に合わせて 3 通りに切り出す。
- icon-180.png（apple-touch-icon）: iPhone は自分で角を丸めるので、角まで板の背景で埋めた正方形にする。
  角が透明のままだと、元の丸みが iPhone の丸みより大きいぶん、角に板の縁が見えてしまう
- icon-192.png / icon-512.png（purpose: any）: 元の角丸のまま、角は透明にする
- icon-maskable-512.png（purpose: maskable）: Android は円などに切り抜くので、
  絵と文字が中央の円（直径 80%）に収まるまで縮め、無地の背景（manifest の background_color）に載せる

python tools/make_icons.py
"""
import math

import numpy as np
from PIL import Image, ImageFilter

SOURCE = 'tools/icon-source.webp'
# manifest.webmanifest の background_color
BACKGROUND = np.array([0x0b, 0x0c, 0x10]) / 255


def push_pull(col, a):
    """重み a の低い所を、まわりの色でなめらかに埋める（粗い段から順に補う）"""
    h, w = a.shape
    if a.min() >= 1.0 or max(h, w) <= 1:
        return col
    ph, pw = h + (h & 1), w + (w & 1)
    cp = np.zeros((ph, pw, 3))
    ap = np.zeros((ph, pw))
    cp[:h, :w] = col
    ap[:h, :w] = a
    s_ca = (cp * ap[..., None]).reshape(ph // 2, 2, pw // 2, 2, 3).sum(axis=(1, 3))
    s_a = ap.reshape(ph // 2, 2, pw // 2, 2).sum(axis=(1, 3))
    coarse = push_pull(s_ca / np.maximum(s_a, 1e-9)[..., None], np.minimum(s_a, 1.0))
    up = np.stack(
        [np.asarray(Image.fromarray(coarse[..., i].astype(np.float32), 'F').resize((pw, ph), Image.BILINEAR))
         for i in range(3)],
        axis=-1,
    )[:h, :w]
    return col * a[..., None] + up * (1 - a[..., None])


src = np.asarray(Image.open(SOURCE).convert('RGBA')).astype(np.float64) / 255
rgb = src[..., :3]
# 板の中は不透明度が 252 前後なので 1 にそろえ、まわりのごく薄い影は落とす
alpha = np.clip((src[..., 3] - 12 / 255) / ((250 - 12) / 255), 0, 1)
# 板の縁には、背景を抜いたときの灰色のにじみが残っている。縁から 2px 内側までの色は使わない
inside = src[..., 3] > 250 / 255
solid = np.asarray(Image.fromarray(inside.astype(np.uint8) * 255).filter(ImageFilter.MinFilter(5))) > 0

ys, xs = np.nonzero(inside)
x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
side = int(max(x1 - x0, y1 - y0))

# 板の背景（絵と文字を除いた暗い所）を、絵と文字の下や縁・角まで延ばしたもの
backdrop = push_pull(rgb, (solid & (rgb.max(axis=-1) < 60 / 255)).astype(np.float64))
# 角まで板の背景で埋めた板
tile = np.where(solid[..., None], rgb, backdrop)
# 絵と文字だけ（板の背景との差）
art = tile - backdrop

# 絵と文字（明るい所・色の付いた所）が中心からどこまで広がっているか
ay, ax = np.nonzero(solid & (rgb.max(axis=-1) > 90 / 255))
reach = float(np.sqrt((ax + 0.5 - cx) ** 2 + (ay + 0.5 - cy) ** 2).max())


def crop(arr, size):
    """板の中心を真ん中にして size 四方を切り出す（元の絵の外は 0）"""
    left, top = int(round(cx - size / 2)), int(round(cy - size / 2))
    out = np.zeros((size, size) + arr.shape[2:])
    sx0, sy0 = max(left, 0), max(top, 0)
    sx1, sy1 = min(left + size, arr.shape[1]), min(top + size, arr.shape[0])
    out[sy0 - top:sy1 - top, sx0 - left:sx1 - left] = arr[sy0:sy1, sx0:sx1]
    return out


def to_image(c, a=None):
    arr = np.clip(np.rint(c * 255), 0, 255).astype(np.uint8)
    if a is None:
        return Image.fromarray(arr, 'RGB')
    return Image.fromarray(np.dstack([arr, np.clip(np.rint(a * 255), 0, 255).astype(np.uint8)]), 'RGBA')


def save(im, size, path):
    im.resize((size, size), Image.LANCZOS).save(path, optimize=True)
    print(path, size, 'x', size)


save(to_image(crop(tile, side)), 180, 'public/icon-180.png')
rounded = to_image(crop(tile, side), crop(alpha, side))
save(rounded, 192, 'public/icon-192.png')
save(rounded, 512, 'public/icon-512.png')

# 切り抜かれても欠けない円は直径 80%。少し余裕を見て 76% に収める
mask_size = max(side, math.ceil(reach / 0.38))
save(to_image(BACKGROUND + crop(art, mask_size)), 512, 'public/icon-maskable-512.png')
print(f'tile {x1 - x0}x{y1 - y0}, art radius {reach:.0f}, maskable scale {side / mask_size:.0%}')
