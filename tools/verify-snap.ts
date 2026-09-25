// スナップが「半径内で本当に一番近い候補」を選べているかを、総当たりと突き合わせて確かめる。
// グリッド索引の走査順に引きずられて遠い図形へ吸着していないかを見るためのもの。
import { readFileSync } from 'node:fs';
import { sampleFiles } from './samples.mjs';
import { parseJww } from '../src/jww/parser.ts';
import { buildScene } from '../src/render/geometry.ts';
import { SnapIndex } from '../src/measure/snap.ts';
import type { Scene } from '../src/render/geometry.ts';

/** snap.ts と同じ重み。交点は総当たりが重いので除外する（索引側に有利な比較になる） */
const WEIGHT: Record<string, number> = {
  endpoint: 0.4,
  center: 0.45,
  midpoint: 0.95,
  online: 2.2,
};

interface Best {
  kind: string;
  score: number;
  d: number;
  x: number;
  y: number;
}

function bruteForce(scene: Scene, x: number, y: number, radius: number): Best | null {
  const pos = scene.linePos;
  const snap = scene.lineSnap;
  const r2 = radius * radius;
  let best: Best | null = null;

  const consider = (px: number, py: number, kind: string): void => {
    const dx = px - x;
    const dy = py - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) return;
    const d = Math.sqrt(d2);
    const score = d * WEIGHT[kind];
    if (!best || score < best.score) best = { kind, score, d, x: px, y: py };
  };

  for (let i = 0; i < pos.length / 4; i++) {
    if (!snap[i]) continue;
    const ax = pos[i * 4], ay = pos[i * 4 + 1];
    const bx = pos[i * 4 + 2], by = pos[i * 4 + 3];
    // まず粗く弾く
    if (Math.min(ax, bx) - radius > x || Math.max(ax, bx) + radius < x) continue;
    if (Math.min(ay, by) - radius > y || Math.max(ay, by) + radius < y) continue;

    consider(ax, ay, 'endpoint');
    consider(bx, by, 'endpoint');
    consider((ax + bx) / 2, (ay + by) / 2, 'midpoint');
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 > 1e-12) {
      let t = ((x - ax) * dx + (y - ay) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      consider(ax + dx * t, ay + dy * t, 'online');
    }
  }

  const pts = scene.snapPoint;
  for (let i = 0; i < pts.length / 2; i++) consider(pts[i * 2], pts[i * 2 + 1], 'center');

  return best;
}

const TRIALS = 120;
let totalWorse = 0;
let totalTrials = 0;
let worstGap = 0;
let worstWhere = '';

for (const file of sampleFiles()) {
  const raw = readFileSync(file);
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const scene = buildScene(parseJww(ab));
  const index = new SnapIndex(scene);

  const b = scene.fitBounds;
  const label = file.split(/[\\/]/).pop();
  console.log(`\n=== ${label}`);

  // iPhone 縦持ち相当の画面に収めたときの倍率を基準に、拡大率を変えて試す
  const cssW = 390, cssH = 844, dpr = 3;
  const fitZoom = Math.min(
    (cssW * dpr) / Math.max(b.maxX - b.minX, 1e-6),
    (cssH * dpr) / Math.max(b.maxY - b.minY, 1e-6),
  ) * 0.94;

  for (const mag of [1, 4, 16]) {
    const zoom = fitZoom * mag;
    const radius = 22 * (dpr / zoom);
    let worse = 0;
    let gapMax = 0;
    let ms = 0;

    for (let n = 0; n < TRIALS; n++) {
      // 実在する線分の端点まわりを狙う
      const seg = Math.floor((n / TRIALS) * (scene.linePos.length / 4));
      const x = scene.linePos[seg * 4] + radius * 0.35;
      const y = scene.linePos[seg * 4 + 1] - radius * 0.35;

      const t0 = performance.now();
      const got = index.query(x, y, radius);
      ms += performance.now() - t0;

      const want = bruteForce(scene, x, y, radius);
      if (!want) continue;
      totalTrials++;

      const gotD = Math.hypot(got.x - x, got.y - y);
      const gotScore = got.kind === 'free' ? Infinity : gotD * (WEIGHT[got.kind] ?? 0.55);
      // 交点は総当たりに含めていないので、索引側が勝つのは正しい
      if (gotScore > want.score * 1.0001 && got.kind !== 'intersection') {
        worse++;
        totalWorse++;
        const gap = gotD - want.d;
        if (gap > gapMax) gapMax = gap;
        if (gap > worstGap) {
          worstGap = gap;
          worstWhere = `${label} 倍率${mag}: ${got.kind} ${gotD.toFixed(3)}mm ← 本来 ${want.kind} ${want.d.toFixed(3)}mm`;
        }
      }
    }
    console.log(
      `  倍率 x${String(mag).padStart(2)}  半径 ${radius.toFixed(2)}mm  ` +
      `総当たりより悪い ${worse}/${TRIALS}  最大ずれ ${gapMax.toFixed(3)}mm  ` +
      `1 回 ${(ms / TRIALS).toFixed(2)}ms`,
    );
  }
}

console.log(`\n合計 ${totalTrials} 回中 ${totalWorse} 回が最良を外しました`);
if (worstWhere) console.log(`最悪ケース: ${worstWhere}`);
process.exit(totalWorse > 0 ? 1 : 0);
