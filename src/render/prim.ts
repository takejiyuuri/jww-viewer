// 形式によらない図形の書き出し（折れ線・円弧と楕円・塗り・穴のある塗り・ハッチングの模様・スプライン・文字）。図形の begin/end は呼び出し側で行う。
// 座標は図形の元の座標で受け取り、部品の変換 t を掛けてから Builder に積む
import earcut from 'earcut';
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
 * curve が true なら吸着用の元の式も残す（この呼び出しで積んだ線分の範囲と一緒に。1 つの図形に複数あってよい）。
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
  const from = b.lineCount;
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
    b.addCurve(cx, cy, ux, uy, vx, vy, c.start, c.sweep, from);
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
      // 弧の上の吸着は元の式で（中心も吸着点にする）
      length += emitConic(b, arc, t, color, layer, true, true).length;
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

/** 多角形の符号付きの面積（左回りが正）。ring は [x, y, ...] */
export function ringArea(ring: ArrayLike<number>): number {
  const n = ring.length >> 1;
  let s = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) s += (ring[j * 2] - ring[i * 2]) * (ring[j * 2 + 1] + ring[i * 2 + 1]);
  return s / 2;
}

/** 点が多角形の内側か（偶奇の規則） */
function inside(ring: ArrayLike<number>, x: number, y: number): boolean {
  const n = ring.length >> 1;
  let hit = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], yi = ring[i * 2 + 1], xj = ring[j * 2], yj = ring[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * 複数の輪（[x, y, ...]。変換済みの座標）を、入れ子の深さで外周と穴に分ける。
 * 深さが偶数の輪が外周、その直下（深さ + 1）の輪が穴（偶奇の規則で塗るのと同じ）
 */
export function nestRings(rings: number[][]): { outer: number[]; holes: number[][] }[] {
  const list = rings
    .filter((r) => r.length >= 6 && r.every(Number.isFinite))
    .map((r) => ({ r, area: Math.abs(ringArea(r)) }))
    .filter((x) => x.area > 0)
    .sort((a, b) => b.area - a.area);
  const parent = new Array<number>(list.length).fill(-1);
  const depth = new Array<number>(list.length).fill(0);
  for (let i = 0; i < list.length; i++) {
    const r = list[i].r;
    // 輪の代表点は最初の辺の中点（頂点はほかの輪の上に乗りやすい）
    const px = (r[0] + r[2]) / 2, py = (r[1] + r[3]) / 2;
    // 面積の大きい順に並べてあるので、含む輪のうち最後に見つかったものがいちばん内側
    for (let k = 0; k < i; k++) {
      if (inside(list[k].r, px, py)) { depth[i]++; parent[i] = k; }
    }
  }
  const out: { outer: number[]; holes: number[][] }[] = [];
  const index = new Map<number, number>();
  list.forEach((x, i) => {
    if (depth[i] % 2 === 0) { index.set(i, out.length); out.push({ outer: x.r, holes: [] }); }
  });
  list.forEach((x, i) => {
    if (depth[i] % 2 === 1 && parent[i] >= 0) {
      const o = index.get(parent[i]);
      if (o !== undefined) out[o].holes.push(x.r);
    }
  });
  return out;
}

/**
 * 穴のある多角形を塗る。rings は図形の元の座標の輪（[x, y, ...]）の並びで、入れ子の深さで外周と穴を決める。
 * 三角形に分けるのは earcut（ISC）。塗った面積（変換後）を返す
 */
export function emitRings(b: Builder, rings: number[][], t: Xform, color: number, layer: number): number {
  const moved = rings.map((r) => {
    const out: number[] = [];
    for (let i = 0; i + 1 < r.length; i += 2) {
      const [x, y] = apply(t, r[i], r[i + 1]);
      out.push(x, y);
    }
    return out;
  });
  let area = 0;
  for (const poly of nestRings(moved)) {
    const data = [...poly.outer];
    const holes: number[] = [];
    for (const h of poly.holes) {
      holes.push(data.length >> 1);
      data.push(...h);
    }
    const tri = earcut(data, holes);
    for (let i = 0; i + 2 < tri.length; i += 3) {
      const a = tri[i] * 2, c = tri[i + 1] * 2, d = tri[i + 2] * 2;
      b.addTriangle(data[a], data[a + 1], data[c], data[c + 1], data[d], data[d + 1], color, layer);
      area += Math.abs((data[c] - data[a]) * (data[d + 1] - data[a + 1]) - (data[d] - data[a]) * (data[c + 1] - data[a + 1])) / 2;
    }
  }
  return area;
}

/** ハッチングの模様の線の族。角度は度、(x, y) は基点、(dx, dy) は隣の線へのずれ、dashes は破線（正は線、負は空き） */
export interface PatternFamily {
  angle: number;
  x: number; y: number;
  dx: number; dy: number;
  dashes: number[];
}

/**
 * 輪で囲まれた範囲（偶奇の規則）に模様の線を引いた線分 [x1, y1, x2, y2, ...] を返す（図形の元の座標）。
 * limit 本を超えたら打ち切り、cut を true にする。点（長さ 0 の破線）は描かない
 */
export function hatchSegments(
  rings: number[][], families: PatternFamily[], limit: number,
): { segs: number[]; cut: boolean } {
  const segs: number[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let edges = 0;
  for (const r of rings) {
    edges += r.length >> 1;
    for (let i = 0; i + 1 < r.length; i += 2) {
      minX = Math.min(minX, r[i]); maxX = Math.max(maxX, r[i]);
      minY = Math.min(minY, r[i + 1]); maxY = Math.max(maxY, r[i + 1]);
    }
  }
  if (!Number.isFinite(minX + minY + maxX + maxY)) return { segs, cut: false };
  /** 線と辺の交わりを調べる回数の上限（巨大な境界と細かい模様で止まらないように） */
  let work = 20_000_000;
  const ts: number[] = [];
  for (const f of families) {
    const a = (f.angle * Math.PI) / 180;
    const ux = Math.cos(a), uy = Math.sin(a);
    const nx = -uy, ny = ux;
    const spacing = f.dx * nx + f.dy * ny;
    if (!(Math.abs(spacing) > 1e-12) || !Number.isFinite(spacing) || !Number.isFinite(f.x + f.y)) continue;
    // 範囲の四隅を法線へ写して、引く線の番号の範囲を決める
    let lo = Infinity, hi = -Infinity;
    for (const [cx, cy] of [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]]) {
      const h = ((cx - f.x) * nx + (cy - f.y) * ny) / spacing;
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    const period = f.dashes.reduce((s, v) => s + Math.abs(v), 0);
    for (let k = Math.ceil(lo); k <= Math.floor(hi); k++) {
      if (segs.length / 4 >= limit || work <= 0) return { segs, cut: true };
      work -= edges;
      const px = f.x + f.dx * k, py = f.y + f.dy * k;
      ts.length = 0;
      for (const r of rings) {
        const n = r.length >> 1;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const h1 = (r[j * 2] - px) * nx + (r[j * 2 + 1] - py) * ny;
          const h2 = (r[i * 2] - px) * nx + (r[i * 2 + 1] - py) * ny;
          // 頂点の上を通るときに二度数えないよう、片側を閉じて数える
          if ((h1 > 0) === (h2 > 0)) continue;
          const s = h1 / (h1 - h2);
          const qx = r[j * 2] + (r[i * 2] - r[j * 2]) * s, qy = r[j * 2 + 1] + (r[i * 2 + 1] - r[j * 2 + 1]) * s;
          ts.push((qx - px) * ux + (qy - py) * uy);
        }
      }
      ts.sort((p, q) => p - q);
      for (let m = 0; m + 1 < ts.length; m += 2) {
        const t0 = ts[m], t1 = ts[m + 1];
        if (!(t1 > t0)) continue;
        if (!(period > 0) || f.dashes.length === 0) {
          segs.push(px + ux * t0, py + uy * t0, px + ux * t1, py + uy * t1);
          continue;
        }
        // 破線は基点から周期で並べる
        let s = Math.floor(t0 / period) * period;
        while (s < t1 && segs.length / 4 < limit) {
          for (const d of f.dashes) {
            const len = Math.abs(d);
            if (d > 0) {
              const a0 = Math.max(s, t0), a1 = Math.min(s + len, t1);
              if (a1 > a0) segs.push(px + ux * a0, py + uy * a0, px + ux * a1, py + uy * a1);
            }
            s += len;
            if (s >= t1) break;
          }
        }
      }
    }
  }
  return { segs, cut: false };
}

/** 節点の列が使えなければ、両端を固定した一様な節点を作る */
function clampedKnots(n: number, p: number): number[] {
  const knots: number[] = [];
  for (let i = 0; i <= n + p; i++) knots.push(i <= p ? 0 : i >= n ? n - p : i - p);
  return knots;
}

/**
 * B スプライン（有理も）の点列 [x, y, ...] を de Boor の算法で求める。
 * 弦と曲線の隔たりが tol 以内になるまで区間を分ける。ctrl は [x, y, ...]、weights は無ければ 1
 */
export function splinePoints(
  degree: number, ctrl: ArrayLike<number>, knotsIn: ArrayLike<number>, weights: ArrayLike<number>, tol: number,
): number[] {
  const n = ctrl.length >> 1;
  if (n < 2) return [];
  const p = Math.max(1, Math.min(n - 1, Math.floor(degree) || 3));
  let knots = Array.from(knotsIn);
  let ok = knots.length === n + p + 1 && knots.every(Number.isFinite);
  for (let i = 1; ok && i < knots.length; i++) if (knots[i] < knots[i - 1]) ok = false;
  if (!ok || !(knots[n] > knots[p])) knots = clampedKnots(n, p);
  const w = (i: number): number => (weights.length === n && weights[i] > 0 ? weights[i] : 1);
  const lo = knots[p], hi = knots[n];
  const dx = new Float64Array(p + 1), dy = new Float64Array(p + 1), dw = new Float64Array(p + 1);
  const at = (u: number): [number, number] => {
    let k = p;
    while (k < n - 1 && u >= knots[k + 1]) k++;
    for (let j = 0; j <= p; j++) {
      const i = k - p + j;
      const wi = w(i);
      dx[j] = ctrl[i * 2] * wi; dy[j] = ctrl[i * 2 + 1] * wi; dw[j] = wi;
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const den = knots[i + p - r + 1] - knots[i];
        const a = den > 0 ? (u - knots[i]) / den : 0;
        dx[j] = (1 - a) * dx[j - 1] + a * dx[j];
        dy[j] = (1 - a) * dy[j - 1] + a * dy[j];
        dw[j] = (1 - a) * dw[j - 1] + a * dw[j];
      }
    }
    return [dx[p] / dw[p], dy[p] / dw[p]];
  };
  const out: number[] = [];
  const first = at(lo);
  out.push(first[0], first[1]);
  /** 区間 [u0, u1] を、真ん中の点が弦から tol 以内になるまで分ける */
  const refine = (u0: number, x0: number, y0: number, u1: number, x1: number, y1: number, depth: number): void => {
    const um = (u0 + u1) / 2;
    const [xm, ym] = at(um);
    const len = Math.hypot(x1 - x0, y1 - y0);
    const dev = len > 0
      ? Math.abs((xm - x0) * (y1 - y0) - (ym - y0) * (x1 - x0)) / len
      : Math.hypot(xm - x0, ym - y0);
    if (depth < 12 && out.length < 400_000 && (dev > tol || depth < 1)) {
      refine(u0, x0, y0, um, xm, ym, depth + 1);
      refine(um, xm, ym, u1, x1, y1, depth + 1);
    } else {
      out.push(x1, y1);
    }
  };
  // 節点の区間ごとに分ける（区間の中は多項式なので、区間をまたがずに詰める）
  let u0 = lo, x0 = first[0], y0 = first[1];
  for (let i = p + 1; i <= n; i++) {
    const u1 = Math.min(knots[i], hi);
    if (!(u1 > u0)) continue;
    // 終わりの点は区間の外から求められないので、ほんの少し手前で求める
    const [x1, y1] = at(u1 >= hi ? hi - (hi - lo) * 1e-12 : u1);
    refine(u0, x0, y0, u1, x1, y1, 0);
    u0 = u1; x0 = x1; y0 = y1;
  }
  return out;
}

/** 通過点だけのスプラインは、通過点を結ぶ Catmull-Rom の曲線で近似する */
export function fitPoints(fit: ArrayLike<number>, closed: boolean, steps = 16): number[] {
  const n = fit.length >> 1;
  if (n < 2) return [];
  const P = (i: number): [number, number] => {
    const k = closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
    return [fit[k * 2], fit[k * 2 + 1]];
  };
  const out: number[] = [fit[0], fit[1]];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const [x0, y0] = P(i - 1), [x1, y1] = P(i), [x2, y2] = P(i + 1), [x3, y3] = P(i + 2);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      out.push(
        0.5 * (2 * x1 + (-x0 + x2) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (-x0 + 3 * x1 - 3 * x2 + x3) * t3),
        0.5 * (2 * y1 + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3),
      );
    }
  }
  return out;
}
