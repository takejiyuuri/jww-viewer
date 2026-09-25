import { CURVE_STRIDE, KIND, SNAP_FLAG, type Scene } from '../render/geometry.ts';

export type SnapKind = 'endpoint' | 'center' | 'intersection' | 'midpoint' | 'online' | 'free';

/** 水平・垂直の拘束方向 */
export type Axis = 'horizontal' | 'vertical';

export interface SnapResult {
  x: number;
  y: number;
  kind: SnapKind;
  glayer: number;
  /**
   * 交点のように、どのレイヤグループの図形なのかが一意に決まらない場合に立つ。
   * 縮尺を自動で決めてしまうと計測値が何倍もずれるため、呼び出し側で避ける。
   */
  ambiguousGroup?: boolean;
}

/** 種別ごとの優先度。距離に掛けて比較するので小さいほど優先される。 */
const WEIGHT: Record<SnapKind, number> = {
  endpoint: 0.4,
  center: 0.45,
  intersection: 0.55,
  midpoint: 0.95,
  online: 2.2,
  free: 999,
};

/** 1 セルにまたがりすぎる線分は個別に持たず全件走査に回す */
const BIG_SPAN = 24;

/** 交点を求めるために掛け合わせる線分の数（指に近い順の先頭から） */
const CROSS_MAX = 60;

/**
 * 線分の端や円弧の範囲に「乗っている」とみなす隔たり（図面上の mm）。
 * 線分の座標は 32 ビットの浮動小数で持つので、ちょうど端に乗っているはずの交点もわずかにはみ出す
 * （A0 の用紙の中なら丸めはこれより小さい）。はみ出して外れても、そこには端点の候補がある
 */
const LEN_EPS = 1e-4;

/** 点と線分の距離の 2 乗 */
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

/**
 * 円・円弧・楕円（弧）の元の式。曲線上の点は (cx, cy) + (ux, uy)·cosθ + (vx, vy)·sinθ で、
 * θ は start から sweep ぶん（sweep が 2π なら一周）
 */
interface Curve {
  cx: number; cy: number;
  ux: number; uy: number;
  vx: number; vy: number;
  start: number;
  sweep: number;
}

const TAU = Math.PI * 2;

function curveAt(curves: Float64Array, k: number): Curve {
  const o = k * CURVE_STRIDE;
  return {
    cx: curves[o + 1], cy: curves[o + 2],
    ux: curves[o + 3], uy: curves[o + 4],
    vx: curves[o + 5], vy: curves[o + 6],
    start: curves[o + 7], sweep: curves[o + 8],
  };
}

function curvePoint(c: Curve, th: number): [number, number] {
  const co = Math.cos(th), si = Math.sin(th);
  return [c.cx + c.ux * co + c.vx * si, c.cy + c.uy * co + c.vy * si];
}

/**
 * 点 (x, y) を表す θ。曲線から外れた点なら、中心から見て同じ向きにある曲線上の点の θ
 * （楕円は、真円に引き伸ばしたときに同じ向きになる点）
 */
function curveAngle(c: Curve, x: number, y: number): number {
  const px = x - c.cx, py = y - c.cy;
  const det = c.ux * c.vy - c.uy * c.vx;
  return Math.atan2((c.ux * py - c.uy * px) / det, (c.vy * px - c.vx * py) / det);
}

/** 曲線の大きさ（長いほうの半径） */
function curveSize(c: Curve): number {
  return Math.max(Math.hypot(c.ux, c.uy), Math.hypot(c.vx, c.vy));
}

function isRound(c: Curve): boolean {
  const ul = Math.hypot(c.ux, c.uy), vl = Math.hypot(c.vx, c.vy);
  return Math.abs(ul - vl) <= ul * 1e-9 && Math.abs(c.ux * c.vx + c.uy * c.vy) <= ul * vl * 1e-9;
}

/**
 * θ が円弧の範囲に入っていれば、start から数えた表し方に直して返す。入っていなければ NaN。
 * 端から tol（角度）以内なら入っているとみなす
 */
function inArc(c: Curve, th: number, tol: number): number {
  const span = Math.abs(c.sweep);
  if (span >= TAU - 1e-12) return th;
  const dir = c.sweep >= 0 ? 1 : -1;
  let d = (dir * (th - c.start)) % TAU;
  if (d < 0) d += TAU;
  if (d <= span + tol) return c.start + dir * d;
  if (d >= TAU - tol) return c.start + dir * (d - TAU);
  return NaN;
}

/** θ を円弧の範囲に収める（外れていれば近いほうの端） */
function clampArc(c: Curve, th: number): number {
  const t = inArc(c, th, 0);
  if (!Number.isNaN(t)) return t;
  const dir = c.sweep >= 0 ? 1 : -1;
  let d = (dir * (th - c.start)) % TAU;
  if (d < 0) d += TAU;
  return d - Math.abs(c.sweep) < TAU - d ? c.start + c.sweep : c.start;
}

/** p·cosθ + q·sinθ = w を満たす θ（0〜2 個）を out に積む */
function solveTrig(p: number, q: number, w: number, out: number[]): void {
  const r = Math.hypot(p, q);
  if (!(r > 0)) return;
  let k = w / r;
  if (Math.abs(k) > 1) {
    // 接している所は、丸めの誤差でわずかに届かないことがある
    if (Math.abs(k) - 1 > 1e-9) return;
    k = Math.sign(k);
  }
  const phi = Math.atan2(q, p);
  const a = Math.acos(k);
  out.push(phi + a);
  if (a > 0) out.push(phi - a);
}

/** 線分 a→b と曲線の交点を out に [x, y, ...] で積む（折れ線ではなく元の曲線との交点） */
function lineCurve(ax: number, ay: number, bx: number, by: number, c: Curve, out: number[]): void {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 1e-24)) return;
  // 線の法線との内積が 0 になる θ
  const nx = -dy, ny = dx;
  const ths: number[] = [];
  solveTrig(nx * c.ux + ny * c.uy, nx * c.vx + ny * c.vy, nx * (ax - c.cx) + ny * (ay - c.cy), ths);
  const len = Math.sqrt(len2);
  const tol = LEN_EPS / curveSize(c);
  for (const t of ths) {
    const th = inArc(c, t, tol);
    if (Number.isNaN(th)) continue;
    const [x, y] = curvePoint(c, th);
    const s = ((x - ax) * dx + (y - ay) * dy) / len2;
    if (s * len < -LEN_EPS || (s - 1) * len > LEN_EPS) continue;
    out.push(x, y);
  }
}

/**
 * 水平線 y = v（horizontal でなければ垂直線 x = v）と曲線の交点の、線に沿った座標（x または y）を out に積む
 */
function axisCurve(c: Curve, horizontal: boolean, v: number, out: number[]): void {
  const ths: number[] = [];
  if (horizontal) solveTrig(c.uy, c.vy, v - c.cy, ths);
  else solveTrig(c.ux, c.vx, v - c.cx, ths);
  const tol = LEN_EPS / curveSize(c);
  for (const t of ths) {
    const th = inArc(c, t, tol);
    if (Number.isNaN(th)) continue;
    const [x, y] = curvePoint(c, th);
    out.push(horizontal ? x : y);
  }
}

/**
 * 2 つの曲線の交点を、弦どうしの交点 (x, y) から詰めて求める（ニュートン法）。
 * 収まらない、どちらかの範囲から外れる、弦の交点から reach より離れる、のどれかなら null
 */
function curveCurve(c1: Curve, c2: Curve, x: number, y: number, reach: number): [number, number] | null {
  let t1 = curveAngle(c1, x, y);
  let t2 = curveAngle(c2, x, y);
  const size = Math.max(curveSize(c1), curveSize(c2));
  // 座標の桁に見合った丸めの誤差より小さくなれば収まったとみなす
  const tiny = Math.max(size, Math.abs(c1.cx), Math.abs(c1.cy), Math.abs(c2.cx), Math.abs(c2.cy)) * 1e-12;
  for (let n = 0; ; n++) {
    const co1 = Math.cos(t1), si1 = Math.sin(t1);
    const co2 = Math.cos(t2), si2 = Math.sin(t2);
    const fx = c1.cx + c1.ux * co1 + c1.vx * si1 - (c2.cx + c2.ux * co2 + c2.vx * si2);
    const fy = c1.cy + c1.uy * co1 + c1.vy * si1 - (c2.cy + c2.uy * co2 + c2.vy * si2);
    if (Math.hypot(fx, fy) <= tiny) break;
    if (n >= 20) return null;
    // 接線の向き
    const d1x = -c1.ux * si1 + c1.vx * co1, d1y = -c1.uy * si1 + c1.vy * co1;
    const d2x = -c2.ux * si2 + c2.vx * co2, d2y = -c2.uy * si2 + c2.vy * co2;
    const det = d2x * d1y - d1x * d2y;
    if (!(Math.abs(det) > size * size * 1e-12)) return null;
    t1 += (fx * d2y - d2x * fy) / det;
    t2 += (fx * d1y - d1x * fy) / det;
  }
  if (Number.isNaN(inArc(c1, t1, LEN_EPS / curveSize(c1))) || Number.isNaN(inArc(c2, t2, LEN_EPS / curveSize(c2)))) return null;
  const p = curvePoint(c1, t1);
  return Math.hypot(p[0] - x, p[1] - y) <= reach ? p : null;
}

/** 円弧の中点（長さで二等分する点）の θ */
function arcMidAngle(c: Curve): number {
  // 真円なら角度の真ん中。楕円は細かく刻んで長さを足し、半分になる所を探す
  if (isRound(c)) return c.start + c.sweep / 2;
  const steps = 512;
  const acc = new Float64Array(steps + 1);
  let [px, py] = curvePoint(c, c.start);
  for (let k = 1; k <= steps; k++) {
    const [x, y] = curvePoint(c, c.start + (c.sweep * k) / steps);
    acc[k] = acc[k - 1] + Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  const half = acc[steps] / 2;
  let k = 1;
  while (k < steps && acc[k] < half) k++;
  const f = acc[k] > acc[k - 1] ? (half - acc[k - 1]) / (acc[k] - acc[k - 1]) : 0;
  return c.start + (c.sweep * (k - 1 + f)) / steps;
}

/** 図形ごとの元の式の番号（Scene.curves の何件目か）。円・円弧・楕円でなければ -1 */
export function curveIndex(scene: Scene): Int32Array {
  const out = new Int32Array(scene.entities.count).fill(-1);
  const curves = scene.curves;
  for (let k = 0; k < curves.length / CURVE_STRIDE; k++) out[curves[k * CURVE_STRIDE]] = k;
  return out;
}

/**
 * 線分 i の上で (x, y) にいちばん近い点。円・円弧を折った線分なら、元の曲線の上に移した点。
 * 長さのない線分なら null
 */
export function onlinePoint(scene: Scene, curveOf: Int32Array, i: number, x: number, y: number): [number, number] | null {
  const pos = scene.linePos;
  const ax = pos[i * 4], ay = pos[i * 4 + 1];
  const dx = pos[i * 4 + 2] - ax, dy = pos[i * 4 + 3] - ay;
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 1e-12)) return null;
  let t = ((x - ax) * dx + (y - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t, qy = ay + dy * t;
  const k = curveOf[scene.lineEntity[i]];
  if (k < 0) return [qx, qy];
  // 弦は曲線より内側を通るので、弦の上の点を曲線の上へ移す
  const c = curveAt(scene.curves, k);
  return curvePoint(c, clampArc(c, curveAngle(c, qx, qy)));
}

/** 線分 i が円弧（両端のある曲線）の一部なら、その円弧の中点。そうでなければ null */
export function arcMidpoint(scene: Scene, curveOf: Int32Array, i: number): [number, number] | null {
  const e = scene.lineEntity[i];
  const k = curveOf[e];
  if (k < 0 || scene.entities.kind[e] !== KIND.arc) return null;
  const c = curveAt(scene.curves, k);
  if (Math.abs(c.sweep) >= TAU - 1e-12) return null;
  return curvePoint(c, arcMidAngle(c));
}

/**
 * 線分 i と j の交点を out に [x, y, ...] で積む。
 * 円・円弧・楕円を折った線分は、折れ線ではなく元の曲線との交点にする。
 * 同じ図形の線分どうし（円を折った継ぎ目）は交点にしない。
 * solved を渡すと、同じ直線と曲線の組は二度解かない（どの弦から辿っても答えは同じなので）
 */
export function segmentCrossings(
  scene: Scene, curveOf: Int32Array, i: number, j: number, out: number[], solved?: Set<number>,
): void {
  const ei = scene.lineEntity[i], ej = scene.lineEntity[j];
  if (ei === ej) return;
  const pos = scene.linePos;
  const ci = curveOf[ei], cj = curveOf[ej];
  if (ci < 0 && cj < 0) {
    const p = intersect(
      pos[i * 4], pos[i * 4 + 1], pos[i * 4 + 2], pos[i * 4 + 3],
      pos[j * 4], pos[j * 4 + 1], pos[j * 4 + 2], pos[j * 4 + 3],
    );
    if (p) out.push(p[0], p[1]);
    return;
  }
  if (ci < 0 || cj < 0) {
    const line = ci < 0 ? i : j;
    const k = ci < 0 ? cj : ci;
    if (solved) {
      const key = line * (curveOf.length + 1) + k;
      if (solved.has(key)) return;
      solved.add(key);
    }
    lineCurve(pos[line * 4], pos[line * 4 + 1], pos[line * 4 + 2], pos[line * 4 + 3], curveAt(scene.curves, k), out);
    return;
  }
  // 曲線どうし：弦の交点を手がかりに、両方の曲線の上に乗るまで詰める。詰められなければ弦の交点のまま
  const ax = pos[i * 4], ay = pos[i * 4 + 1], bx = pos[i * 4 + 2], by = pos[i * 4 + 3];
  const cx = pos[j * 4], cy = pos[j * 4 + 1], dx = pos[j * 4 + 2], dy = pos[j * 4 + 3];
  const p = intersect(ax, ay, bx, by, cx, cy, dx, dy);
  if (!p) return;
  const reach = Math.max(Math.hypot(bx - ax, by - ay), Math.hypot(dx - cx, dy - cy));
  const q = curveCurve(curveAt(scene.curves, ci), curveAt(scene.curves, cj), p[0], p[1], reach);
  out.push(...(q ?? p));
}

/**
 * 線分と単独点の一様グリッド索引。
 * TypedArray の CSR 形式で持ち、タップ位置周辺だけを走査する。
 */
export class SnapIndex {
  private cell: number;
  private gw: number;
  private gh: number;
  private minX: number;
  private minY: number;
  private offsets: Int32Array;
  private items: Int32Array;
  private big: Int32Array;

  private pOffsets: Int32Array;
  private pItems: Int32Array;
  private scene: Scene;
  /**
   * 色番号ごとに吸着させるかどうか。null なら全部。
   * 画面で隠している色の線に吸着すると、見えない所に点が乗って混乱するため。
   */
  private visibleColor: Uint8Array | null = null;
  /** レイヤ（0〜255）ごとに吸着させるかどうか。null なら全部 */
  private visibleLayer: Uint8Array | null = null;
  /** 図形ごとの元の式の番号（円・円弧・楕円でなければ -1） */
  private curveOf: Int32Array;
  /** 求めた円弧の中点（元の式の番号ごと） */
  private arcMid = new Map<number, [number, number] | null>();
  /** 線分ごとに、最後に見た回の番号（いくつものセルに載った線分を一度だけ見るため） */
  private visited: Uint32Array;
  private visit = 0;

  constructor(scene: Scene) {
    this.scene = scene;
    this.curveOf = curveIndex(scene);
    const { bounds } = scene;
    const w = Math.max(bounds.maxX - bounds.minX, 1e-6);
    const h = Math.max(bounds.maxY - bounds.minY, 1e-6);
    const segCount = scene.linePos.length / 4;
    this.visited = new Uint32Array(segCount);

    // 1 セルあたり数本になるようにセル数を決める
    const targetCells = Math.max(64, Math.min(1 << 18, segCount));
    this.cell = Math.max(Math.sqrt((w * h) / targetCells), 1e-6);
    this.gw = Math.max(1, Math.ceil(w / this.cell));
    this.gh = Math.max(1, Math.ceil(h / this.cell));
    this.minX = bounds.minX;
    this.minY = bounds.minY;

    const cells = this.gw * this.gh;
    const counts = new Int32Array(cells);
    const bigList: number[] = [];

    const pos = scene.linePos;

    // 1 パス目: セルごとの件数を数える。
    // 吸着先にしない線（寸法の補助線）も、タップで図形を拾うときのために載せておく
    for (let i = 0; i < segCount; i++) {
      const r = this.cellRange(pos[i * 4], pos[i * 4 + 1], pos[i * 4 + 2], pos[i * 4 + 3]);
      if ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) > BIG_SPAN) {
        bigList.push(i);
        continue;
      }
      for (let gy = r.y0; gy <= r.y1; gy++) {
        for (let gx = r.x0; gx <= r.x1; gx++) counts[gy * this.gw + gx]++;
      }
    }

    this.offsets = new Int32Array(cells + 1);
    for (let i = 0; i < cells; i++) this.offsets[i + 1] = this.offsets[i] + counts[i];
    this.items = new Int32Array(this.offsets[cells]);

    // 2 パス目: 実際に詰める
    const cursor = this.offsets.slice(0, cells);
    for (let i = 0; i < segCount; i++) {
      const r = this.cellRange(pos[i * 4], pos[i * 4 + 1], pos[i * 4 + 2], pos[i * 4 + 3]);
      if ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) > BIG_SPAN) continue;
      for (let gy = r.y0; gy <= r.y1; gy++) {
        for (let gx = r.x0; gx <= r.x1; gx++) {
          const c = gy * this.gw + gx;
          this.items[cursor[c]++] = i;
        }
      }
    }
    this.big = Int32Array.from(bigList);

    // 単独点も同じグリッドに載せる
    const pts = scene.snapPoint;
    const pCount = pts.length / 2;
    const pCounts = new Int32Array(cells);
    for (let i = 0; i < pCount; i++) {
      pCounts[this.cellOf(pts[i * 2], pts[i * 2 + 1])]++;
    }
    this.pOffsets = new Int32Array(cells + 1);
    for (let i = 0; i < cells; i++) this.pOffsets[i + 1] = this.pOffsets[i] + pCounts[i];
    this.pItems = new Int32Array(this.pOffsets[cells]);
    const pCursor = this.pOffsets.slice(0, cells);
    for (let i = 0; i < pCount; i++) {
      const c = this.cellOf(pts[i * 2], pts[i * 2 + 1]);
      this.pItems[pCursor[c]++] = i;
    }
  }

  /** 色番号ごとの表示状態（1 なら表示）を渡す。隠した色には吸着しなくなる */
  setVisibleColors(visible: Uint8Array | null): void {
    this.visibleColor = visible;
  }

  /** レイヤ（0〜255）ごとの表示状態（1 なら表示）を渡す。隠したレイヤには吸着しなくなる */
  setVisibleLayers(visible: Uint8Array | null): void {
    this.visibleLayer = visible;
  }

  private pointVisible(i: number): boolean {
    const v = this.visibleColor;
    const l = this.visibleLayer;
    return (!v || v[this.scene.snapPointColor[i]] === 1)
      && (!l || l[this.scene.snapPointLayer[i]] === 1);
  }

  /** 線分が見えているか（色とレイヤの両方で表示になっているか） */
  lineVisible(i: number): boolean {
    const v = this.visibleColor;
    const l = this.visibleLayer;
    return (!v || v[this.scene.lineColor[i]] === 1)
      && (!l || l[this.scene.lineLayer[i]] === 1);
  }

  private clampGx(v: number): number {
    return v < 0 ? 0 : v >= this.gw ? this.gw - 1 : v;
  }

  private clampGy(v: number): number {
    return v < 0 ? 0 : v >= this.gh ? this.gh - 1 : v;
  }

  private cellOf(x: number, y: number): number {
    const gx = this.clampGx(Math.floor((x - this.minX) / this.cell));
    const gy = this.clampGy(Math.floor((y - this.minY) / this.cell));
    return gy * this.gw + gx;
  }

  private cellRange(x1: number, y1: number, x2: number, y2: number) {
    return {
      x0: this.clampGx(Math.floor((Math.min(x1, x2) - this.minX) / this.cell)),
      x1: this.clampGx(Math.floor((Math.max(x1, x2) - this.minX) / this.cell)),
      y0: this.clampGy(Math.floor((Math.min(y1, y2) - this.minY) / this.cell)),
      y1: this.clampGy(Math.floor((Math.max(y1, y2) - this.minY) / this.cell)),
    };
  }

  /**
   * 半径 r 以内の線分のうち、タップ位置に近いものから最大 limit 本を、近い順に並べて返す
   * （距離が同じなら線分の番号の小さい順）。
   * グリッドの走査順や本数で打ち切ると、指の真下の線分が候補から漏れて遠い線分に吸着してしまう。
   * そこで行は指のいる行から外へ向かって見ていき、まだ見ていない行がどれも limit 番目より遠いと
   * 分かった所でだけやめる。
   * pickable が true なら、吸着先にしない線（寸法の補助線）も含める
   */
  private nearbySegments(x: number, y: number, r: number, limit: number, pickable = false): number[] {
    const snap = this.scene.lineSnap;
    const gx0 = this.clampGx(Math.floor((x - r - this.minX) / this.cell));
    const gx1 = this.clampGx(Math.floor((x + r - this.minX) / this.cell));
    const gy0 = this.clampGy(Math.floor((y - r - this.minY) / this.cell));
    const gy1 = this.clampGy(Math.floor((y + r - this.minY) / this.cell));
    const visited = this.visited;
    if (++this.visit === 0xffffffff) {
      visited.fill(0);
      this.visit = 1;
    }
    const visit = this.visit;
    const pos = this.scene.linePos;
    const r2 = r * r;
    // 近い limit 本を、いちばん遠いものが先頭に来るヒープで持つ
    const hd: number[] = [];
    const hi: number[] = [];
    const farther = (d: number, i: number, k: number): boolean => d > hd[k] || (d === hd[k] && i > hi[k]);
    const swap = (a: number, b: number): void => {
      const d = hd[a]; hd[a] = hd[b]; hd[b] = d;
      const i = hi[a]; hi[a] = hi[b]; hi[b] = i;
    };
    const add = (i: number): void => {
      if (visited[i] === visit) return;
      visited[i] = visit;
      if (!pickable && !snap[i]) return;
      if (!this.lineVisible(i)) return;
      const d2 = segDist2(pos, i, x, y);
      if (d2 > r2) return;
      if (hd.length < limit) {
        hd.push(d2);
        hi.push(i);
        for (let k = hd.length - 1; k > 0;) {
          const p = (k - 1) >> 1;
          if (!farther(hd[k], hi[k], p)) break;
          swap(k, p);
          k = p;
        }
        return;
      }
      // 満杯なら、いちばん遠いものより近いときだけ入れ替える
      if (limit === 0 || !(d2 < hd[0] || (d2 === hd[0] && i < hi[0]))) return;
      hd[0] = d2;
      hi[0] = i;
      for (let k = 0; ;) {
        const l = k * 2 + 1, rr = l + 1;
        let m = k;
        if (l < hd.length && farther(hd[l], hi[l], m)) m = l;
        if (rr < hd.length && farther(hd[rr], hi[rr], m)) m = rr;
        if (m === k) break;
        swap(k, m);
        k = m;
      }
    };
    const row = (gy: number): void => {
      for (let gx = gx0; gx <= gx1; gx++) {
        const c = gy * this.gw + gx;
        for (let k = this.offsets[c]; k < this.offsets[c + 1]; k++) add(this.items[k]);
      }
    };

    // 長い線分（通り芯や外形線）はセルに載せていないので必ず合流させる
    for (let k = 0; k < this.big.length; k++) add(this.big[k]);
    const gc = this.clampGy(Math.floor((y - this.minY) / this.cell));
    let lo = gc;
    let up = gc;
    row(gc);
    for (;;) {
      // まだ見ていない行の線分は、どれもその行までの縦の隔たりより遠い
      const below = lo > gy0 ? y - (this.minY + lo * this.cell) : Infinity;
      const above = up < gy1 ? this.minY + (up + 1) * this.cell - y : Infinity;
      const gap = Math.min(below, above);
      if (gap === Infinity) break;
      if (hd.length >= limit && gap > 0 && gap * gap > hd[0]) break;
      if (below <= above) row(--lo);
      else row(++up);
    }

    const order = hd.map((_, k) => k);
    order.sort((a, b) => hd[a] - hd[b] || hi[a] - hi[b]);
    return order.map((k) => hi[k]);
  }

  /**
   * タップ位置に最も相応しいスナップ点を返す。
   * radius は図面座標での許容半径。
   */
  query(x: number, y: number, radius: number): SnapResult {
    const pos = this.scene.linePos;
    // 縮尺の判定に使うレイヤグループは、レイヤ番号の上位 4 ビット
    // 実寸に直すときのレイヤグループ（寸法は寸法そのもののグループ）
    const { lineEntity, entities } = this.scene;
    const group = (i: number): number => entities.group[lineEntity[i]];
    const r2 = radius * radius;

    let best: SnapResult = { x, y, kind: 'free', glayer: 0 };
    let bestScore = Infinity;

    const consider = (
      px: number, py: number, kind: SnapKind, glayer: number, ambiguous = false,
    ): void => {
      const dx = px - x;
      const dy = py - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) return;
      const score = Math.sqrt(d2) * WEIGHT[kind];
      if (score < bestScore) {
        bestScore = score;
        best = ambiguous
          ? { x: px, y: py, kind, glayer, ambiguousGroup: true }
          : { x: px, y: py, kind, glayer };
      }
    };

    // 単独点（円中心・実点）
    const pts = this.scene.snapPoint;
    const pointEntity = this.scene.snapPointEntity;
    const pg = (i: number): number => this.scene.entities.group[pointEntity[i]];
    const gx0 = this.clampGx(Math.floor((x - radius - this.minX) / this.cell));
    const gx1 = this.clampGx(Math.floor((x + radius - this.minX) / this.cell));
    const gy0 = this.clampGy(Math.floor((y - radius - this.minY) / this.cell));
    const gy1 = this.clampGy(Math.floor((y + radius - this.minY) / this.cell));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const c = gy * this.gw + gx;
        for (let k = this.pOffsets[c]; k < this.pOffsets[c + 1]; k++) {
          const i = this.pItems[k];
          if (!this.pointVisible(i)) continue;
          consider(pts[i * 2], pts[i * 2 + 1], 'center', pg(i));
        }
      }
    }

    const segs = this.nearbySegments(x, y, radius, 400);
    const snap = this.scene.lineSnap;

    for (const i of segs) {
      const ax = pos[i * 4], ay = pos[i * 4 + 1];
      const bx = pos[i * 4 + 2], by = pos[i * 4 + 3];
      const g = group(i);
      // 円・円弧を折った線分の継ぎ目や弦の真ん中は、端点・中点にしない（SNAP_FLAG）
      const f = snap[i];
      if (f & SNAP_FLAG.start) consider(ax, ay, 'endpoint', g);
      if (f & SNAP_FLAG.end) consider(bx, by, 'endpoint', g);
      if (f & SNAP_FLAG.mid) consider((ax + bx) / 2, (ay + by) / 2, 'midpoint', g);
      // 円弧の中点は元の式から求める（図形ごとに一度だけ）
      const k = this.curveOf[lineEntity[i]];
      if (k >= 0 && !this.arcMid.has(k)) this.arcMid.set(k, arcMidpoint(this.scene, this.curveOf, i));
      const m = k >= 0 ? this.arcMid.get(k) : null;
      if (m) consider(m[0], m[1], 'midpoint', g);

      // 線上の最近点（円・円弧なら曲線そのものの上）
      const q = onlinePoint(this.scene, this.curveOf, i, x, y);
      if (q) consider(q[0], q[1], 'online', g);
    }

    // 交点は組み合わせが増えるので、指に近い順に並んだ先頭だけを掛け合わせる
    const cross = segs.length > CROSS_MAX ? segs.slice(0, CROSS_MAX) : segs;
    const curved = cross.map((i) => this.curveOf[lineEntity[i]] >= 0);
    const hits: number[] = [];
    const solved = new Set<number>();
    for (let a = 0; a < cross.length; a++) {
      const i = cross[a];
      const ax = pos[i * 4], ay = pos[i * 4 + 1];
      const bx = pos[i * 4 + 2], by = pos[i * 4 + 3];
      for (let b = a + 1; b < cross.length; b++) {
        const j = cross[b];
        hits.length = 0;
        if (!curved[a] && !curved[b]) {
          // 直線どうしがほとんどなので、ここは直に解く
          if (lineEntity[i] === lineEntity[j]) continue;
          const p = intersect(ax, ay, bx, by, pos[j * 4], pos[j * 4 + 1], pos[j * 4 + 2], pos[j * 4 + 3]);
          if (!p) continue;
          hits.push(p[0], p[1]);
        } else {
          segmentCrossings(this.scene, this.curveOf, i, j, hits, solved);
          if (hits.length === 0) continue;
        }
        // 交わる 2 本のレイヤグループが違うと、どちらの縮尺で測るべきか決まらない。
        // 近い方を採ったうえで、決め手がないことを呼び出し側に伝える。
        const gi = group(i);
        const gj = group(j);
        for (let h = 0; h < hits.length; h += 2) {
          if (gi === gj) {
            consider(hits[h], hits[h + 1], 'intersection', gi);
          } else {
            const near = segDist2(pos, i, x, y) <= segDist2(pos, j, x, y) ? gi : gj;
            const sameScale = this.scene.scales[gi] === this.scene.scales[gj];
            consider(hits[h], hits[h + 1], 'intersection', near, !sameScale);
          }
        }
      }
    }

    return best;
  }

  /**
   * 見えている線分のうち、指の位置にいちばん近いもの。半径内になければ index は -1。
   * 属性の取得（タップした図形を調べる）に使う。
   */
  nearestLine(x: number, y: number, radius: number): { index: number; dist: number } {
    const [index = -1] = this.nearbySegments(x, y, radius, 1, true);
    return { index, dist: index >= 0 ? Math.sqrt(segDist2(this.scene.linePos, index, x, y)) : Infinity };
  }

  /** 見えている単独点（実点・円の中心）のうち、半径内でいちばん近いもの。なければ -1 */
  nearestPoint(x: number, y: number, radius: number): number {
    const pts = this.scene.snapPoint;
    const r2 = radius * radius;
    const gx0 = this.clampGx(Math.floor((x - radius - this.minX) / this.cell));
    const gx1 = this.clampGx(Math.floor((x + radius - this.minX) / this.cell));
    const gy0 = this.clampGy(Math.floor((y - radius - this.minY) / this.cell));
    const gy1 = this.clampGy(Math.floor((y + radius - this.minY) / this.cell));
    let index = -1;
    let best = r2;
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const c = gy * this.gw + gx;
        for (let k = this.pOffsets[c]; k < this.pOffsets[c + 1]; k++) {
          const i = this.pItems[k];
          if (!this.pointVisible(i)) continue;
          const dx = pts[i * 2] - x;
          const dy = pts[i * 2 + 1] - y;
          const d = dx * dx + dy * dy;
          if (d <= best) {
            best = d;
            index = i;
          }
        }
      }
    }
    return index;
  }

  /**
   * 基準点から水平（または垂直）に伸ばした線の上だけで吸着先を探す。
   * 「この面から真横に、あの壁まで」のような測り方をするための経路で、
   * 拘束線と図形が交わる位置、拘束線の近くにある点、の順に優先する。
   */
  queryOnAxis(
    originX: number, originY: number, axis: Axis,
    targetX: number, targetY: number, radius: number,
  ): SnapResult {
    const horizontal = axis === 'horizontal';
    // 拘束線に落とした位置。ここが基準になる
    const px = horizontal ? targetX : originX;
    const py = horizontal ? originY : targetY;

    const pos = this.scene.linePos;
    // 縮尺の判定に使うレイヤグループは、レイヤ番号の上位 4 ビット
    // 実寸に直すときのレイヤグループ（寸法は寸法そのもののグループ）
    const { lineEntity, entities } = this.scene;
    const group = (i: number): number => entities.group[lineEntity[i]];

    let best: SnapResult = { x: px, y: py, kind: 'free', glayer: 0 };
    let bestScore = Infinity;

    /** 拘束線に沿った向きでの隔たり（この距離が近いほど良い） */
    const along = (x: number, y: number): number =>
      Math.abs(horizontal ? x - targetX : y - targetY);

    const consider = (x: number, y: number, kind: SnapKind, glayer: number, ambiguous = false): void => {
      const d = along(x, y);
      if (d > radius) return;
      const score = d * WEIGHT[kind];
      if (score < bestScore) {
        bestScore = score;
        best = ambiguous
          ? { x, y, kind, glayer, ambiguousGroup: true }
          : { x, y, kind, glayer };
      }
    };

    const snap = this.scene.lineSnap;
    const hits: number[] = [];
    /** 交点を求め終えた曲線（元の式の番号） */
    const solved = new Set<number>();
    for (const i of this.nearbySegments(px, py, radius, 400)) {
      const ax = pos[i * 4], ay = pos[i * 4 + 1];
      const bx = pos[i * 4 + 2], by = pos[i * 4 + 3];
      const f = snap[i];

      // 円・円弧・楕円は、折れ線ではなく元の曲線と拘束線との交点にする（曲線ごとに一度だけ）
      const k = this.curveOf[lineEntity[i]];
      if (k >= 0) {
        if (solved.has(k)) continue;
        solved.add(k);
        hits.length = 0;
        axisCurve(curveAt(this.scene.curves, k), horizontal, horizontal ? originY : originX, hits);
        for (const v of hits) consider(horizontal ? v : originX, horizontal ? originY : v, 'intersection', group(i));
        continue;
      }

      if (horizontal) {
        // 拘束線と平行な線分とは交点が定まらないので、端点だけを見る
        if (ay === by) {
          if (Math.abs(ay - originY) <= 1e-9) {
            if (f & SNAP_FLAG.start) consider(ax, ay, 'endpoint', group(i));
            if (f & SNAP_FLAG.end) consider(bx, by, 'endpoint', group(i));
          }
          continue;
        }
        if ((ay - originY) * (by - originY) > 0) continue;
        const t = (originY - ay) / (by - ay);
        consider(ax + (bx - ax) * t, originY, 'intersection', group(i));
      } else {
        if (ax === bx) {
          if (Math.abs(ax - originX) <= 1e-9) {
            if (f & SNAP_FLAG.start) consider(ax, ay, 'endpoint', group(i));
            if (f & SNAP_FLAG.end) consider(bx, by, 'endpoint', group(i));
          }
          continue;
        }
        if ((ax - originX) * (bx - originX) > 0) continue;
        const t = (originX - ax) / (bx - ax);
        consider(originX, ay + (by - ay) * t, 'intersection', group(i));
      }
    }

    // 円の中心や実点は、拘束線の近くにあれば拾う（真上に乗ることは稀なため）
    const pts = this.scene.snapPoint;
    const pointEntity = this.scene.snapPointEntity;
    const pg = (i: number): number => this.scene.entities.group[pointEntity[i]];
    const near = radius * 0.25;
    const gx0 = this.clampGx(Math.floor((px - radius - this.minX) / this.cell));
    const gx1 = this.clampGx(Math.floor((px + radius - this.minX) / this.cell));
    const gy0 = this.clampGy(Math.floor((py - radius - this.minY) / this.cell));
    const gy1 = this.clampGy(Math.floor((py + radius - this.minY) / this.cell));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const c = gy * this.gw + gx;
        for (let k = this.pOffsets[c]; k < this.pOffsets[c + 1]; k++) {
          const i = this.pItems[k];
          if (!this.pointVisible(i)) continue;
          const x = pts[i * 2];
          const y = pts[i * 2 + 1];
          const off = horizontal ? Math.abs(y - originY) : Math.abs(x - originX);
          if (off > near) continue;
          // 拘束線上に落として使う
          consider(horizontal ? x : originX, horizontal ? originY : y, 'center', pg(i));
        }
      }
    }

    return best;
  }
}

/** 2 線分の交点。交差しなければ null */
function intersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): [number, number] | null {
  const r0 = bx - ax, r1 = by - ay;
  const s0 = dx - cx, s1 = dy - cy;
  const denom = r0 * s1 - r1 * s0;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((cx - ax) * s1 - (cy - ay) * s0) / denom;
  const u = ((cx - ax) * r1 - (cy - ay) * r0) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [ax + r0 * t, ay + r1 * t];
}
