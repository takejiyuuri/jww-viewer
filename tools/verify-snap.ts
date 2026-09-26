// スナップが「半径内で本当に一番近い候補」を選べているかを、総当たりと突き合わせて確かめる。
// グリッド索引の走査順に引きずられて遠い図形へ吸着していないか、交点を取りこぼしていないか、
// 円・円弧を折った継ぎ目を端点にしていないか、円・円弧との交点が元の曲線の上に乗っているかを見る。
// 合成した図形で答えの分かっている場面を確かめたあと、引数に渡した図面でも総当たりと突き合わせる。
import { readFileSync } from 'node:fs';
import { sampleFiles } from './samples.mjs';
import { parseJww } from '../src/jww/parser.ts';
import { KIND, SNAP_FLAG, buildScene } from '../src/render/geometry.ts';
import { SnapIndex, arcMidpoint, curveIndex, onlinePoint, segmentCrossings } from '../src/measure/snap.ts';
import type { Scene } from '../src/render/geometry.ts';
import type { SnapResult } from '../src/measure/snap.ts';
import {
  emptyEntities, type JwwArc, type JwwBlockDef, type JwwDocument, type JwwEntities, type JwwLine,
} from '../src/jww/types.ts';

/** snap.ts と同じ重み */
const WEIGHT: Record<string, number> = {
  endpoint: 0.4,
  center: 0.45,
  intersection: 0.55,
  midpoint: 0.95,
  online: 2.2,
};

/** snap.ts と同じく、交点は指に近い順の先頭 60 本の組から求める */
const CROSS_MAX = 60;

let failures = 0;
const fail = (name: string, info?: unknown): void => {
  failures++;
  console.log(`NG: ${name}`, info ?? '');
};

/** 点と線分の距離の 2 乗（snap.ts と同じ計算） */
function segDist2(pos: Float32Array, i: number, x: number, y: number): number {
  const ax = pos[i * 4], ay = pos[i * 4 + 1];
  const bx = pos[i * 4 + 2], by = pos[i * 4 + 3];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 1e-12 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + dx * t - x;
  const py = ay + dy * t - y;
  return px * px + py * py;
}

/** 円弧の中点（楕円は求めるのが重いので、図形ごとに覚えておく） */
const midCache = new WeakMap<Scene, Map<number, [number, number] | null>>();
function arcMid(scene: Scene, curveOf: Int32Array, i: number): [number, number] | null {
  let m = midCache.get(scene);
  if (!m) midCache.set(scene, (m = new Map()));
  const e = scene.lineEntity[i];
  if (!m.has(e)) m.set(e, arcMidpoint(scene, curveOf, i));
  return m.get(e) ?? null;
}

interface Best {
  kind: string;
  score: number;
  d: number;
  x: number;
  y: number;
}

/** 索引を使わずに、すべての線分と点から最良の候補を求める */
function bruteForce(scene: Scene, curveOf: Int32Array, x: number, y: number, radius: number): Best | null {
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

  const near: Array<[number, number]> = [];
  for (let i = 0; i < pos.length / 4; i++) {
    if (!snap[i]) continue;
    const d2 = segDist2(pos, i, x, y);
    if (d2 > r2) continue;
    near.push([d2, i]);
    const ax = pos[i * 4], ay = pos[i * 4 + 1];
    const bx = pos[i * 4 + 2], by = pos[i * 4 + 3];
    const f = snap[i];
    if (f & SNAP_FLAG.start) consider(ax, ay, 'endpoint');
    if (f & SNAP_FLAG.end) consider(bx, by, 'endpoint');
    if (f & SNAP_FLAG.mid) consider((ax + bx) / 2, (ay + by) / 2, 'midpoint');
    const m = arcMid(scene, curveOf, i);
    if (m) consider(m[0], m[1], 'midpoint');
    const q = onlinePoint(scene, curveOf, i, x, y);
    if (q) consider(q[0], q[1], 'online');
  }

  // 交点：半径内の線分を近い順（同じ距離なら番号順）に並べた先頭の組すべて
  near.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = near.slice(0, CROSS_MAX).map((v) => v[1]);
  const hits: number[] = [];
  for (let a = 0; a < cross.length; a++) {
    for (let b = a + 1; b < cross.length; b++) {
      hits.length = 0;
      segmentCrossings(scene, curveOf, cross[a], cross[b], hits);
      for (let h = 0; h < hits.length; h += 2) consider(hits[h], hits[h + 1], 'intersection');
    }
  }

  const pts = scene.snapPoint;
  for (let i = 0; i < pts.length / 2; i++) consider(pts[i * 2], pts[i * 2 + 1], 'center');

  return best;
}

/**
 * 「端点」「中点」と答えた吸着先が、図形の本当の端・中点か（円・円弧を折った継ぎ目や弦の真ん中でないか）。
 * 違えば理由を返す
 */
function fakeSnap(scene: Scene, curveOf: Int32Array, got: SnapResult): string | null {
  if (got.kind !== 'endpoint' && got.kind !== 'midpoint') return null;
  const pos = scene.linePos;
  const snap = scene.lineSnap;
  for (let i = 0; i < pos.length / 4; i++) {
    const f = snap[i];
    const ax = pos[i * 4], ay = pos[i * 4 + 1];
    const bx = pos[i * 4 + 2], by = pos[i * 4 + 3];
    if (got.kind === 'endpoint') {
      if ((f & SNAP_FLAG.start) && ax === got.x && ay === got.y) return null;
      if ((f & SNAP_FLAG.end) && bx === got.x && by === got.y) return null;
    } else {
      if ((f & SNAP_FLAG.mid) && (ax + bx) / 2 === got.x && (ay + by) / 2 === got.y) return null;
      const m = arcMid(scene, curveOf, i);
      if (m && m[0] === got.x && m[1] === got.y) return null;
    }
  }
  return got.kind === 'endpoint' ? '図形の端ではない所を端点にした' : '図形の中点ではない所を中点にした';
}

/** 円・円弧を折った線分の、端・中点の扱い（lineSnap のビット）が正しいか */
function checkFlags(scene: Scene, label: string): void {
  const e = scene.entities;
  const snap = scene.lineSnap;
  const ends = SNAP_FLAG.start | SNAP_FLAG.end;
  let bad = 0;
  for (let k = 0; k < e.count; k++) {
    const kind = e.kind[k];
    const s = e.lineStart[k], n = e.lineCount[k];
    for (let j = s; j < s + n; j++) {
      const f = snap[j];
      let want: number;
      if (kind === KIND.circle) want = SNAP_FLAG.on;
      else if (kind === KIND.arc) want = SNAP_FLAG.on | (j === s ? SNAP_FLAG.start : 0) | (j === s + n - 1 ? SNAP_FLAG.end : 0);
      // 寸法補助線と、円周ソリッドの円周（線として描くが、ソリッドなので吸着しない）
      else if (kind === KIND.dimAux || kind === KIND.solid) want = 0;
      else want = SNAP_FLAG.on | ends | SNAP_FLAG.mid;
      if (f !== want) bad++;
    }
  }
  if (bad) fail(`${label}: 線分の吸着の扱いが図形の種類と合わない`, { 本数: bad });
}

// ---------- 合成した図形 ----------

const common = { group: 0, penStyle: 1, penColor: 1, penWidth: 0, layer: 0, glayer: 0, flag: 0 };
const line = (x1: number, y1: number, x2: number, y2: number): JwwLine => ({ ...common, x1, y1, x2, y2 });
const arc = (
  cx: number, cy: number, radius: number, start = 0, sweep = Math.PI * 2, flatness = 1, tilt = 0,
): JwwArc => ({
  ...common, cx, cy, radius, startAngle: start, arcAngle: sweep, tilt, flatness, isCircle: sweep >= Math.PI * 2,
});

function makeDoc(parts: Partial<JwwEntities>, blockDefs = new Map<number, JwwBlockDef>()): JwwDocument {
  const layers = Array.from({ length: 16 }, () => ({ state: 2, protect: 0, name: '' }));
  return {
    header: {
      version: 600, memo: '', paperSize: 3, writeGroup: 0,
      groups: Array.from({ length: 16 }, () => ({ state: 2, writeLayer: 0, scale: 100, protect: 0, name: '', layers })),
      penColors: Array.from({ length: 10 }, () => ({ rgb: 0xffffff, width: 1 })),
      sxfColors: [], sxfColorNames: [], sxfLineTypeNames: [], zoom: 1, originX: 0, originY: 0,
    },
    entities: { ...emptyEntities(), ...parts },
    blockDefs,
    warnings: [],
  };
}

/** 再現できる乱数 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** (x, y) を中心に半径 r の円の中の一様な点 */
const around = (random: () => number, x: number, y: number, r: number): [number, number] => {
  const a = random() * Math.PI * 2;
  const d = r * Math.sqrt(random());
  return [x + d * Math.cos(a), y + d * Math.sin(a)];
};

const dist = (p: { x: number; y: number }, x: number, y: number): number => Math.hypot(p.x - x, p.y - y);

{
  const before = failures;
  const random = rng(1);

  // 1. 柱（半径 5 の円）と壁の交点。縮尺 1/100、用紙 1mm が 5 CSS px のとき、吸着半径 22px = 4.4mm、交点から 6px 以内を押す
  {
    const scene = buildScene(makeDoc({ lines: [line(-10, 1.5, 10, 1.5)], arcs: [arc(0, 0, 5)] }));
    checkFlags(scene, '柱と壁');
    const index = new SnapIndex(scene);
    const curveOf = curveIndex(scene);
    const ix = Math.sqrt(25 - 1.5 * 1.5), iy = 1.5;
    const tally: Record<string, number> = {};
    let errSum = 0;
    let exact = 0;
    const N = 4000;
    for (let n = 0; n < N; n++) {
      const [x, y] = around(random, ix, iy, 1.2);
      const got = index.query(x, y, 4.4);
      tally[got.kind] = (tally[got.kind] ?? 0) + 1;
      errSum += dist(got, ix, iy);
      if (got.kind === 'intersection' && dist(got, ix, iy) < 1e-9) exact++;
      if (got.kind === 'intersection' && dist(got, ix, iy) >= 1e-9) fail('柱と壁の交点が真の交点からずれる', { got, ix, iy });
      if (got.kind === 'online' && Math.abs(got.y - 1.5) > 1e-9 && Math.abs(Math.hypot(got.x, got.y) - 5) > 1e-9) {
        fail('線上が円にも線にも乗っていない', got);
      }
      const why = fakeSnap(scene, curveOf, got);
      if (why) { fail(`柱と壁: ${why}`, got); break; }
    }
    if (tally.endpoint || tally.midpoint) fail('柱と壁の交点のそばで、円の継ぎ目に吸着した', tally);
    if (exact < N * 0.4) fail('柱と壁の交点に吸着する割合が少ない', tally);
    console.log(`柱と壁の交点: ${JSON.stringify(tally)}  交点からのずれ 平均 ${((errSum / N) * 100).toFixed(1)}mm（実寸）`);
  }

  // 2. 小さな円（杭、半径 1.5）の中心のそばを押すと、円周の継ぎ目ではなく中心に吸着する
  {
    const scene = buildScene(makeDoc({ arcs: [arc(20, 0, 1.5)] }));
    const index = new SnapIndex(scene);
    let center = 0;
    for (let n = 0; n < 4000; n++) {
      const [x, y] = around(random, 20, 0, 1.2);
      if (index.query(x, y, 4.4).kind === 'center') center++;
    }
    if (center !== 4000) fail('小さな円の中心のそばで中心以外に吸着した', { 中心: center });
    console.log(`小さな円の中心: ${center}/4000`);
  }

  // 3. 円弧：両端は端点、真ん中は中点、途中の継ぎ目は線上（曲線の上）
  {
    const scene = buildScene(makeDoc({ arcs: [arc(0, 30, 10, 0, Math.PI / 2)] }));
    checkFlags(scene, '円弧');
    const index = new SnapIndex(scene);
    const curveOf = curveIndex(scene);
    const end = index.query(10.05, 30.05, 1);
    if (end.kind !== 'endpoint' || dist(end, 10, 30) > 1e-6) fail('円弧の端が端点にならない', end);
    const mx = 10 * Math.SQRT1_2, my = 30 + 10 * Math.SQRT1_2;
    // 円弧の外側へ少し離れた所（線上よりも中点のほうが優先される所）を押す
    const mid = index.query(mx + 0.03, my + 0.02, 1);
    if (mid.kind !== 'midpoint' || dist(mid, mx, my) > 1e-9) fail('円弧の中点が円弧の上の真ん中にならない', mid);
    // 継ぎ目（折れ線の頂点）のすぐ外側を押す
    const pos = scene.linePos;
    const s = scene.entities.lineStart[0];
    let seams = 0;
    for (let j = s + 1; j < s + scene.entities.lineCount[0] - 1; j++) {
      const vx = pos[j * 4], vy = pos[j * 4 + 1];
      const a = Math.atan2(vy - 30, vx);
      const got = index.query(vx + 0.01 * Math.cos(a), vy + 0.01 * Math.sin(a), 0.5);
      // 円弧の中点のそばでは中点に吸着してよい
      if (got.kind === 'midpoint' && dist(got, mx, my) < 1e-9) continue;
      seams++;
      if (got.kind !== 'online' || Math.abs(Math.hypot(got.x, got.y - 30) - 10) > 1e-9) {
        fail('円弧の継ぎ目のそばで、曲線の上の線上にならない', got);
        break;
      }
      const why = fakeSnap(scene, curveOf, got);
      if (why) { fail(`円弧: ${why}`, got); break; }
    }
    console.log(`円弧の端・中点・継ぎ目: ${seams} か所の継ぎ目を確認`);
  }

  // 4. 円どうしの交点（半径 5 の円を 6 離して置くと (3, ±4) で交わる）
  {
    const scene = buildScene(makeDoc({ arcs: [arc(0, -40, 5), arc(6, -40, 5)] }));
    const index = new SnapIndex(scene);
    const got = index.query(3.001, -35.99, 1);
    if (got.kind !== 'intersection' || dist(got, 3, -36) > 1e-9) fail('円どうしの交点が真の交点にならない', got);
  }

  // 5. 楕円（扁平率と傾き）と、部品として縦横の倍率を変えて置いた円（楕円になる）と、線の交点。
  //    線を楕円の軸の向きに直して 2 次式を解いた答えと比べる
  {
    const a = 8, b = 4, tilt = Math.PI / 6;
    const circleDef: JwwBlockDef = { no: 1, referred: true, time: 0, name: 'p', entities: { ...emptyEntities(), arcs: [arc(0, 0, 4)] } };
    const ref = { ...common, x: 60, y: 0, scaleX: 2, scaleY: 1, angle: Math.PI / 6, defNo: 1 };
    const scene = buildScene(makeDoc(
      { arcs: [arc(30, 0, a, 0, Math.PI * 2, b / a, tilt)], lines: [line(20, 1, 45, 3), line(50, -1, 70, 2)], blocks: [ref] },
      new Map([[1, circleDef]]),
    ));
    const index = new SnapIndex(scene);
    // 線 p + s·d と、中心 c・半径 (ra, rb)・傾き t の楕円が交わる s（0〜1）
    const solve = (px: number, py: number, dx: number, dy: number, cx: number, cy: number, ra: number, rb: number, t: number) => {
      const co = Math.cos(t), si = Math.sin(t);
      const lx = (px - cx) * co + (py - cy) * si, ly = -(px - cx) * si + (py - cy) * co;
      const ex = dx * co + dy * si, ey = -dx * si + dy * co;
      const A = (ex * ex) / (ra * ra) + (ey * ey) / (rb * rb);
      const B = 2 * ((lx * ex) / (ra * ra) + (ly * ey) / (rb * rb));
      const C = (lx * lx) / (ra * ra) + (ly * ly) / (rb * rb) - 1;
      const D = Math.sqrt(B * B - 4 * A * C);
      return [(-B + D) / (2 * A), (-B - D) / (2 * A)].filter((s) => s >= 0 && s <= 1);
    };
    const at = (px: number, py: number, dx: number, dy: number) => (s: number) => [px + dx * s, py + dy * s];
    // 部品の円は、置いた側で見ると x 方向に 2 倍してから 30° 回した楕円。
    // 線を部品の中の座標に戻して円と交わらせる（線の上の割合 s は座標を変えても同じ）
    const co = Math.cos(ref.angle), si = Math.sin(ref.angle);
    const back = (x: number, y: number): [number, number] => [(x * co + y * si) / ref.scaleX, (-x * si + y * co) / ref.scaleY];
    const [lx, ly] = back(50 - ref.x, -1 - ref.y);
    const [ex, ey] = back(20, 3);
    const want = [
      ...solve(20, 1, 25, 2, 30, 0, a, b, tilt).map(at(20, 1, 25, 2)),
      ...solve(lx, ly, ex, ey, 0, 0, 4, 4, 0).map(at(50, -1, 20, 3)),
    ];
    if (want.length !== 4) fail('楕円の検査の前提が崩れている', want);
    for (const [wx, wy] of want) {
      const got = index.query(wx + 0.05, wy - 0.04, 1);
      if (got.kind !== 'intersection' || dist(got, wx, wy) > 1e-9) fail('楕円と線の交点が真の交点にならない', { got, wx, wy });
    }
  }

  // 6. 直交の拘束線と円の交点。円の上端近くを横切っても、弦ではなく円そのものとの交点になる
  {
    const scene = buildScene(makeDoc({ arcs: [arc(0, 0, 5)] }));
    const index = new SnapIndex(scene);
    for (const y of [0, 3, 4.95, 4.98, 4.999]) {
      const x = -Math.sqrt(25 - y * y);
      const got = index.queryOnAxis(-10, y, 'horizontal', x + 0.02, y, 1);
      if (got.kind !== 'intersection' || got.y !== y || Math.abs(got.x - x) > 1e-9) fail('水平の拘束線と円の交点', { y, got, x });
      const v = index.queryOnAxis(y, -10, 'vertical', y, x + 0.02, 1);
      if (v.kind !== 'intersection' || v.x !== y || Math.abs(v.y - x) > 1e-9) fail('垂直の拘束線と円の交点', { y, v, x });
    }
  }

  // 7. 通り芯どうしの交差のそばに短い線（ハッチ）が多くても、交点を取りこぼさない
  {
    const hatch: JwwLine[] = [];
    while (hatch.length < 150) {
      const [x, y] = around(random, 500, 350, 2.5);
      if (Math.hypot(x - 500, y - 350) >= 1) hatch.push(line(x, y, x + 0.15, y + 0.15));
    }
    // ハッチを先に、通り芯を後に書き出す（索引のセルの中で通り芯が後ろに並ぶ）。通り芯の中点は交差から離しておく
    const scene = buildScene(makeDoc({ lines: [...hatch, line(0, 350, 1200, 350), line(500, 0, 500, 900)] }));
    const index = new SnapIndex(scene);
    const got = index.query(500.18, 350.17, 3);
    if (got.kind !== 'intersection' || dist(got, 500, 350) > 1e-9) fail('通り芯の交点を取りこぼした', got);
  }

  // 8. 指の下の行に線が詰まっていても、指の行を見ずに打ち切らない
  //    （壁は短くして、索引のセルに載せる。長い線は別扱いで必ず見るので）
  {
    const hatch: JwwLine[] = [];
    for (let n = 0; n < 24000; n++) {
      const x = -8 + random() * 16, y = -7 + random() * 2;
      hatch.push(line(x, y, x + 0.05, y));
    }
    const scene = buildScene(makeDoc({ lines: [...hatch, line(0, 0, 1, 0), line(0, 0, 0, 1)] }));
    const index = new SnapIndex(scene);
    const got = index.query(0.3, 0.3, 10);
    if (got.kind !== 'endpoint' || dist(got, 0, 0) > 1e-9) fail('密な行の上にある壁の角に吸着しない', got);
    const near = index.nearestLine(0.3, 0.3, 10);
    const ent = near.index >= 0 ? scene.lineEntity[near.index] : -1;
    if (ent < 24000 || Math.abs(near.dist - 0.3) > 1e-6) fail('密な行の上にある壁を拾わない', near);
  }

  console.log(`合成した図形: ${failures === before ? 'OK' : 'NG'}`);
}

// ---------- 図面 ----------

const TRIALS = 120;
let totalWorse = 0;
let totalBetter = 0;
let totalTrials = 0;
let worstGap = 0;
let worstWhere = '';

for (const file of sampleFiles()) {
  const raw = readFileSync(file);
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const scene = buildScene(parseJww(ab));
  const index = new SnapIndex(scene);
  const curveOf = curveIndex(scene);
  const random = rng(7);

  const b = scene.fitBounds;
  const label = file.split(/[\\/]/).pop();
  console.log(`\n=== ${label}`);
  checkFlags(scene, label ?? '');

  // 円・円弧の継ぎ目（折れ線の途中の頂点）
  const seams: Array<[number, number]> = [];
  const e = scene.entities;
  for (let k = 0; k < e.count; k++) {
    if ((e.kind[k] !== KIND.arc && e.kind[k] !== KIND.circle) || e.lineCount[k] < 3) continue;
    const j = e.lineStart[k] + (e.lineCount[k] >> 1);
    seams.push([scene.linePos[j * 4], scene.linePos[j * 4 + 1]]);
  }

  // iPhone 縦持ち相当の画面に収めたときの倍率を基準に、拡大率を変えて試す
  const cssW = 390, cssH = 844, dpr = 3;
  const fitZoom = Math.min(
    (cssW * dpr) / Math.max(b.maxX - b.minX, 1e-6),
    (cssH * dpr) / Math.max(b.maxY - b.minY, 1e-6),
  ) * 0.94;

  for (const mag of [0.5, 1, 4, 16]) {
    const zoom = fitZoom * mag;
    const radius = 22 * (dpr / zoom);
    let worse = 0;
    let better = 0;
    let gapMax = 0;
    let ms = 0;
    let fake = 0;
    const kinds: Record<string, number> = {};

    for (let n = 0; n < TRIALS; n++) {
      // 実在する線分の端点のそば、図面の中の無作為な位置、円・円弧の継ぎ目のすぐそばを 1/3 ずつ
      let x: number, y: number;
      if (n % 3 === 0) {
        const seg = Math.floor((n / TRIALS) * (scene.linePos.length / 4));
        x = scene.linePos[seg * 4] + radius * 0.35;
        y = scene.linePos[seg * 4 + 1] - radius * 0.35;
      } else if (n % 3 === 1 || seams.length === 0) {
        x = b.minX + random() * (b.maxX - b.minX);
        y = b.minY + random() * (b.maxY - b.minY);
      } else {
        const s = seams[Math.floor(random() * seams.length)];
        [x, y] = around(random, s[0], s[1], radius * 0.1);
      }

      const t0 = performance.now();
      const got = index.query(x, y, radius);
      ms += performance.now() - t0;
      kinds[got.kind] = (kinds[got.kind] ?? 0) + 1;

      const why = fakeSnap(scene, curveOf, got);
      if (why) {
        fake++;
        if (fake === 1) fail(`${label} 倍率${mag}: ${why}`, got);
      }

      const want = bruteForce(scene, curveOf, x, y, radius);
      if (!want) {
        if (got.kind !== 'free') fail(`${label} 倍率${mag}: 総当たりでは候補がないのに吸着した`, got);
        continue;
      }
      totalTrials++;

      const gotD = Math.hypot(got.x - x, got.y - y);
      const gotScore = got.kind === 'free' ? Infinity : gotD * WEIGHT[got.kind];
      if (gotScore > want.score * 1.0001 + 1e-12) {
        worse++;
        totalWorse++;
        const gap = gotD - want.d;
        if (gap > gapMax) gapMax = gap;
        if (gap > worstGap || !worstWhere) {
          worstGap = Math.max(gap, worstGap);
          worstWhere = `${label} 倍率${mag}: ${got.kind} ${gotD.toFixed(3)}mm ← 本来 ${want.kind} ${want.d.toFixed(3)}mm`;
        }
      } else if (gotScore < want.score * 0.9999 - 1e-12) {
        // 総当たりにない候補を索引が出した
        better++;
        totalBetter++;
        if (better === 1) fail(`${label} 倍率${mag}: 総当たりにない吸着先`, { got, want });
      }
    }
    console.log(
      `  倍率 x${String(mag).padStart(3)}  半径 ${radius.toFixed(2)}mm  ` +
      `総当たりより悪い ${worse}/${TRIALS}  最大ずれ ${gapMax.toFixed(3)}mm  ` +
      `1 回 ${(ms / TRIALS).toFixed(2)}ms  ${JSON.stringify(kinds)}`,
    );
  }
}

console.log(`\n合計 ${totalTrials} 回中 ${totalWorse} 回が最良を外し、${totalBetter} 回が総当たりと食い違いました`);
if (worstWhere) console.log(`最悪ケース: ${worstWhere}`);
if (failures) console.log(`ほかの検査で ${failures} 件の NG`);
process.exit(totalWorse > 0 || failures > 0 ? 1 : 0);
