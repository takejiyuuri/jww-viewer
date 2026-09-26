// 描画結果を PNG に焼いて目視確認するための検証スクリプト（ブラウザ非依存）
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { parseJww } from '../src/jww/parser.ts';
import { buildScene } from '../src/render/geometry.ts';
import { BACKGROUND_RGB, buildPalette, type DisplaySettings } from '../src/render/theme.ts';

const W = 1400;
const H = 1000;

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const file = args[0];
const out = args[1] ?? 'preview.png';
// --light で白背景、--mono で単色、--hide=1,2 で指定した線色を隠す
const display: DisplaySettings = {
  background: process.argv.includes('--light') ? 'light' : 'dark',
  mono: process.argv.includes('--mono'),
};
const hidePens = new Set(
  (process.argv.find((a) => a.startsWith('--hide='))?.slice(7) ?? '')
    .split(',').filter(Boolean).map(Number),
);

const raw = readFileSync(file);
const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
const doc = parseJww(ab);
const scene = buildScene(doc);
const hidden = new Set<number>();
scene.groups.forEach((g, i) => { if (hidePens.has(g.penColor)) hidden.add(i); });
const palette = buildPalette(scene.colors, scene.colorGroup, hidden, display);
const bg = BACKGROUND_RGB[display.background];

const b = scene.fitBounds;
const zoom = Math.min(W / Math.max(b.maxX - b.minX, 1e-6), H / Math.max(b.maxY - b.minY, 1e-6)) * 0.96;
const cx = (b.minX + b.maxX) / 2;
const cy = (b.minY + b.maxY) / 2;

const px = new Uint8Array(W * H * 3);
for (let i = 0; i < px.length; i += 3) {
  px[i] = bg[0]; px[i + 1] = bg[1]; px[i + 2] = bg[2];
}

const sx = (x: number): number => Math.round((x - cx) * zoom + W / 2);
const sy = (y: number): number => Math.round(H / 2 - (y - cy) * zoom);

function plot(x: number, y: number, r: number, g: number, bl: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = r; px[i + 1] = g; px[i + 2] = bl;
}

function line(x0: number, y0: number, x1: number, y1: number, r: number, g: number, bl: number): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const stepX = x0 < x1 ? 1 : -1;
  const stepY = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let guard = 0;
  for (;;) {
    plot(x0, y0, r, g, bl);
    if ((x0 === x1 && y0 === y1) || guard++ > 8000) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += stepX; }
    if (e2 <= dx) { err += dx; y0 += stepY; }
  }
}

// 塗り三角形（スキャンライン）
const tri = scene.triPos;
for (let i = 0; i < tri.length; i += 6) {
  const xs = [sx(tri[i]), sx(tri[i + 2]), sx(tri[i + 4])];
  const ys = [sy(tri[i + 1]), sy(tri[i + 3]), sy(tri[i + 5])];
  // 塗りの色はパレットの後ろの半分（buildPalette 参照）
  const e = (scene.triColor[(i / 6) * 3] + scene.colorGroup.length) * 4;
  if (palette[e + 3] === 0) continue;
  const r = palette[e], g = palette[e + 1], bl = palette[e + 2];
  const y0 = Math.max(0, Math.min(...ys));
  const y1 = Math.min(H - 1, Math.max(...ys));
  for (let y = y0; y <= y1; y++) {
    const hits: number[] = [];
    for (let e = 0; e < 3; e++) {
      const ax = xs[e], ay = ys[e], bx = xs[(e + 1) % 3], by = ys[(e + 1) % 3];
      if ((ay <= y && by > y) || (by <= y && ay > y)) {
        hits.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
    }
    if (hits.length < 2) continue;
    hits.sort((p, q) => p - q);
    for (let x = Math.max(0, Math.round(hits[0])); x <= Math.min(W - 1, Math.round(hits[1])); x++) {
      plot(x, y, r, g, bl);
    }
  }
}

const pos = scene.linePos;
for (let i = 0; i < pos.length / 4; i++) {
  const e = scene.lineColor[i] * 4;
  if (palette[e + 3] === 0) continue;
  line(
    sx(pos[i * 4]), sy(pos[i * 4 + 1]),
    sx(pos[i * 4 + 2]), sy(pos[i * 4 + 3]),
    palette[e], palette[e + 1], palette[e + 2],
  );
}

// PNG 書き出し
const rowBytes = W * 3;
const rawImg = Buffer.alloc((rowBytes + 1) * H);
for (let y = 0; y < H; y++) {
  rawImg[y * (rowBytes + 1)] = 0;
  Buffer.from(px.buffer, y * rowBytes, rowBytes).copy(rawImg, y * (rowBytes + 1) + 1);
}

function chunk(tag: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(tag, 'ascii'), data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crcBuf]);
}

let table: number[] | null = null;
function crc32(buf: Buffer): number {
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table.push(c);
    }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2;

writeFileSync(out, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(rawImg, { level: 6 })),
  chunk('IEND', Buffer.alloc(0)),
]));

console.log(`${out}: 線 ${pos.length / 4} / 三角 ${tri.length / 6} / 文字 ${scene.texts.length}`);
console.log(`範囲 X ${b.minX.toFixed(1)}..${b.maxX.toFixed(1)}  Y ${b.minY.toFixed(1)}..${b.maxY.toFixed(1)}`);
