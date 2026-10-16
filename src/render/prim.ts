// 形式によらない図形の書き出し（折れ線・円弧と楕円・塗り・文字）。図形の begin/end は呼び出し側で行う。
// 座標は図形の元の座標で受け取り、部品の変換 t を掛けてから Builder に積む
import { SNAP_FLAG, apply, finite4, type Builder, type Xform } from './builder.ts';

/** 円・円弧・楕円の元の式（図形の元の座標）。点は c + u·cosθ + v·sinθ（θ は start から sweep ぶん） */
export interface Conic {
  cx: number; cy: number;
  ux: number; uy: number;
  vx: number; vy: number;
  start: number;
  sweep: number;
}

/** 変換の線形の部分だけを掛ける（向きの量に使う） */
function linear(t: Xform, x: number, y: number): [number, number] {
  return [t.a * x + t.c * y, t.b * x + t.d * y];
}

/** 2 本の軸 (ux, uy)・(vx, vy) で張る楕円の半径（長いほう・短いほう）。行列 [u v] の特異値 */
export function conicAxes(ux: number, uy: number, vx: number, vy: number): [number, number] {
  const sum = ux * ux + uy * uy + vx * vx + vy * vy;
  const det = ux * vy - uy * vx;
  const root = Math.sqrt(Math.max(0, sum * sum - 4 * det * det));
  const major = Math.sqrt(Math.max(0, (sum + root) / 2));
  const minor = Math.sqrt(Math.max(0, (sum - root) / 2));
  // 真円どうしは誤差で食い違わないよう同じ値にそろえる
  return [major, Math.abs(major - minor) <= major * 1e-7 ? major : minor];
}

/**
 * 円弧・楕円弧を折れ線にして積む。ends が true なら両端を図形の端として吸着させる。
 * curve が true なら吸着用の元の式も残す（1 つの図形に式は 1 つだけ持てるので、折れ線の中の弧では残さない）。
 * 戻り値は長さと、変換後の半径（長いほう・短いほう）
 */
export function emitConic(
  b: Builder, c: Conic, t: Xform, color: number, layer: number, ends: boolean, curve: boolean,
): { length: number; major: number; minor: number } {
  const [cx, cy] = apply(t, c.cx, c.cy);
  const [ux, uy] = linear(t, c.ux, c.uy);
  const [vx, vy] = linear(t, c.vx, c.vy);
  const [major, minor] = conicAxes(ux, uy, vx, vy);
  const n = b.arcSegments(major, c.sweep);
  let px = 0, py = 0;
  let chords = 0;
  for (let i = 0; i <= n; i++) {
    const th = c.start + (c.sweep * i) / n;
    const cos = Math.cos(th), sin = Math.sin(th);
    const x = cx + ux * cos + vx * sin;
    const y = cy + uy * cos + vy * sin;
    if (i > 0) {
      const snap = SNAP_FLAG.on | (ends && i === 1 ? SNAP_FLAG.start : 0) | (ends && i === n ? SNAP_FLAG.end : 0);
      b.addSegment(px, py, x, y, color, layer, snap);
      chords += Math.hypot(x - px, y - py);
    }
    px = x;
    py = y;
  }
  if (curve) {
    b.addPoint(cx, cy, layer, color);
    b.addCurve(cx, cy, ux, uy, vx, vy, c.start, c.sweep);
  }
  return { length: conicLength(cx, cy, ux, uy, vx, vy, c.start, c.sweep, major, minor, chords), major, minor };
}

/** 弧の長さ。真円なら半径 × 角度、楕円は細かく分けて足し合わせる */
function conicLength(
  cx: number, cy: number, ux: number, uy: number, vx: number, vy: number,
  start: number, sweep: number, major: number, minor: number, chords: number,
): number {
  if (major === minor) return major * Math.abs(sweep);
  const steps = 2048;
  let length = 0;
  let px = 0, py = 0;
  for (let i = 0; i <= steps; i++) {
    const th = start + (sweep * i) / steps;
    const x = cx + ux * Math.cos(th) + vx * Math.sin(th);
    const y = cy + uy * Math.cos(th) + vy * Math.sin(th);
    if (i > 0) length += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return Number.isFinite(length) ? length : chords;
}

/**
 * ふくらみ（bulge）付きの辺の円弧。ふくらみ b は円弧の角 θ = 4·atan(b)（正なら左回り）。
 * 直線（b がほぼ 0）なら null
 */
export function bulgeArc(x1: number, y1: number, x2: number, y2: number, bulge: number): Conic | null {
  if (!(Math.abs(bulge) > 1e-9) || !Number.isFinite(bulge)) return null;
  const dx = x2 - x1, dy = y2 - y1;
  if (!(dx * dx + dy * dy > 0)) return null;
  // 弦の中点から、弦に垂直に (1/b − b)/4 × 弦 だけずらした所が中心
  const k = (1 / bulge - bulge) / 4;
  const cx = (x1 + x2) / 2 - dy * k;
  const cy = (y1 + y2) / 2 + dx * k;
  const r = Math.hypot(x1 - cx, y1 - cy);
  return { cx, cy, ux: r, uy: 0, vx: 0, vy: r, start: Math.atan2(y1 - cy, x1 - cx), sweep: 4 * Math.atan(bulge) };
}

/**
 * 折れ線を積む。xy は [x, y, ...]、bulge は頂点ごとのふくらみ（その頂点から次の頂点への辺。なければ直線）。
 * 頂点は図形の端として吸着させる（直線の辺は真ん中にも）。長さを返す
 */
export function emitPolyline(
  b: Builder, xy: ArrayLike<number>, bulge: ArrayLike<number> | null, closed: boolean,
  t: Xform, color: number, layer: number,
): number {
  const n = xy.length >> 1;
  const edges = closed ? n : n - 1;
  let length = 0;
  for (let i = 0; i < edges; i++) {
    const j = (i + 1) % n;
    const x1 = xy[i * 2], y1 = xy[i * 2 + 1], x2 = xy[j * 2], y2 = xy[j * 2 + 1];
    const arc = bulge ? bulgeArc(x1, y1, x2, y2, bulge[i] ?? 0) : null;
    if (arc) {
      length += emitConic(b, arc, t, color, layer, true, false).length;
      continue;
    }
    const [ax, ay] = apply(t, x1, y1);
    const [bx, by] = apply(t, x2, y2);
    b.addSegment(ax, ay, bx, by, color, layer, true);
    if (finite4(ax, ay, bx, by)) length += Math.hypot(bx - ax, by - ay);
  }
  return length;
}

/** 凸な多角形（ソリッドの 3・4 角形）を扇に分けて塗る。pts は [x, y, ...] */
export function emitFill(b: Builder, pts: ArrayLike<number>, t: Xform, color: number, layer: number): void {
  const n = pts.length >> 1;
  if (n < 3) return;
  const [ox, oy] = apply(t, pts[0], pts[1]);
  let [px, py] = apply(t, pts[2], pts[3]);
  for (let i = 2; i < n; i++) {
    const [qx, qy] = apply(t, pts[i * 2], pts[i * 2 + 1]);
    b.addTriangle(ox, oy, px, py, qx, qy, color, layer);
    px = qx; py = qy;
  }
}

/**
 * 文字をひとつ積む。(x, y) は文字列の左下、angle は度、width は文字列の長さ（どれも図形の元の座標）。
 * texts の添字を返す（出さなければ -1）
 */
export function emitTextItem(
  b: Builder, text: string, x: number, y: number, width: number, height: number, angle: number,
  t: Xform, color: number, layer: number, entity: number,
): number {
  if (!text) return -1;
  const a = (angle * Math.PI) / 180;
  const [x1, y1] = apply(t, x, y);
  // 進む向きと高さの向きをそれぞれ変換して、変換後の長さと角度を求める（部品の回転・倍率もこれで入る）
  const [wx, wy] = linear(t, Math.cos(a) * width, Math.sin(a) * width);
  const [hx, hy] = linear(t, -Math.sin(a) * height, Math.cos(a) * height);
  const w = Math.hypot(wx, wy);
  const h = Math.hypot(hx, hy);
  if (!finite4(x1, y1, w, h) || !(h > 0)) return -1;
  const deg = w > 1e-12 ? (Math.atan2(wy, wx) * 180) / Math.PI : angle;
  const index = b.texts.length;
  b.texts.push({ x: x1, y: y1, width: w, height: h, angle: deg, text, color, layer, entity });
  b.track(x1, y1);
  b.track(x1 + wx, y1 + wy);
  b.track(x1 + hx, y1 + hy);
  return index;
}
