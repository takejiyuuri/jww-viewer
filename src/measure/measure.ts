import type { SnapKind } from './snap.ts';

export interface MeasurePoint {
  /** 図面座標 */
  x: number;
  y: number;
  glayer: number;
  kind: SnapKind;
  /**
   * この点が乗っている図形のレイヤグループの縮尺分母。
   * 何もない場所や、縮尺の違う 2 本の交点のように決め手がない場合は null。
   */
  scale: number | null;
}

export const SNAP_LABEL: Record<SnapKind, string> = {
  endpoint: '端点',
  center: '中心・点',
  intersection: '交点',
  midpoint: '中点',
  online: '線上',
  free: '任意点',
};

/**
 * 図面座標の距離を実寸(mm)に直す。
 * JWW の座標は用紙上の mm なので、レイヤグループの縮尺分母を掛けると実寸になる。
 */
export function toReal(drawingDist: number, scale: number): number {
  return drawingDist * scale;
}

/**
 * 実寸 mm を読みやすい文字列にする。
 * 単位を切り替えるかは mm で丸めた後の値で決める（999.96 mm を「1000.0 mm」ではなく「1.000 m」にする）
 */
export function formatLength(mm: number): string {
  if (Math.abs(Number(mm.toFixed(1))) >= 1000) {
    return `${(mm / 1000).toFixed(3)} m`;
  }
  return `${mm.toFixed(1)} mm`;
}

export interface Measured {
  /** 区間ごとの実寸(mm) */
  segments: number[];
  /** 区間ごとに使った縮尺の分母 */
  scales: number[];
  total: number;
  /** 縮尺の異なるレイヤグループをまたいでいる */
  mixed: boolean;
}

/**
 * 区間ごとに、その両端が乗っているレイヤグループの縮尺で実寸に直す。
 * 図面には縮尺の違う図が同居しているので、全区間を一つの縮尺で通すと桁が狂う。
 * fixed なら、利用者が選んだ縮尺 fallback ですべての区間を測る。
 */
export function measureLengths(points: MeasurePoint[], fallback: number, fixed = false): Measured {
  const segments: number[] = [];
  const scales: number[] = [];
  let mixed = false;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const raw = Math.hypot(b.x - a.x, b.y - a.y);
    let scale: number;
    if (fixed) {
      scale = fallback;
    } else if (a.scale != null && b.scale != null) {
      if (a.scale === b.scale) {
        scale = a.scale;
      } else {
        scale = fallback;
        mixed = true;
      }
    } else {
      scale = a.scale ?? b.scale ?? fallback;
    }
    segments.push(raw * scale);
    scales.push(scale);
  }
  return { segments, scales, total: segments.reduce((x, y) => x + y, 0), mixed };
}

/**
 * 計測の種類。距離は点を結んだ長さ、面積は点で囲んだ範囲、体積はその面積に高さを掛けたもの、
 * 角度は結んだ線が頂点（途中の点）でなす角
 */
export type MeasureMode = 'length' | 'area' | 'volume' | 'angle';

export const MEASURE_MODES: MeasureMode[] = ['length', 'area', 'volume', 'angle'];

/**
 * 頂点 v で、v→a と v→b のなす角（度、0〜180）。どちらかの辺の長さが 0 なら null。
 * 角度は縮尺によらない（図面の縮尺は縦横同じ倍率なので）
 */
export function angleAt(a: { x: number; y: number }, v: { x: number; y: number }, b: { x: number; y: number }): number | null {
  const ux = a.x - v.x, uy = a.y - v.y;
  const wx = b.x - v.x, wy = b.y - v.y;
  const lu = Math.hypot(ux, uy), lw = Math.hypot(wx, wy);
  const tiny = 1e-12 * Math.max(1, Math.abs(v.x), Math.abs(v.y));
  if (!(lu > tiny && lw > tiny)) return null;
  // 小さな角でも崩れないよう、外積と内積から求める
  return (Math.atan2(Math.abs(ux * wy - uy * wx), ux * wx + uy * wy) * 180) / Math.PI;
}

/** 点を結んだ線の、途中の点（頂点）ごとの角（度）。1 番目の頂点は 2 点目 */
export function measureAngles(points: ReadonlyArray<{ x: number; y: number }>): Array<number | null> {
  const out: Array<number | null> = [];
  for (let i = 1; i + 1 < points.length; i++) out.push(angleAt(points[i - 1], points[i], points[i + 1]));
  return out;
}

/** 線 a–b の傾き（水平から左回りの角度、0 以上 180 未満）。長さが 0 なら null */
export function inclination(a: { x: number; y: number }, b: { x: number; y: number }): number | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (!(Math.hypot(dx, dy) > 1e-12 * Math.max(1, Math.abs(a.x), Math.abs(a.y)))) return null;
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (deg < 0) deg += 180;
  if (deg >= 180) deg -= 180;
  // 丸めると 180 になる（ほぼ水平で左向き）ものは 0 とする
  return Math.round(deg * 100) / 100 >= 180 ? 0 : deg;
}

/** 角度を読みやすい文字列にする（0.01° まで。末尾の 0 は付けない） */
export function formatAngle(deg: number): string {
  const v = Math.round(deg * 100) / 100;
  return `${Object.is(v, -0) ? 0 : v}°`;
}

export interface AreaMeasured {
  /** 実寸の面積(mm²)。3 点未満なら 0 */
  area: number;
  /** 外周(mm)。最後の点から最初の点へ戻る辺を含む（2 点なら往復せず 1 辺だけ） */
  perimeter: number;
  /** 辺ごとの実寸(mm)。3 点以上なら最後は最後の点から最初の点へ戻る辺 */
  edges: number[];
  /** 使った縮尺の分母。面積は図形全体を一つの縮尺で測る */
  scale: number;
  /** 縮尺の異なるレイヤグループの点が混じっている */
  mixed: boolean;
  /** 辺どうしが交差している（面積が意図した範囲と違う） */
  crossing: boolean;
}

/**
 * 点で囲んだ範囲の面積と外周。
 * 面積は辺ごとに縮尺を変えられないので、点が乗った図形の縮尺が一つにそろっていればそれを、
 * 分からなければ fallback を使う。縮尺の違う点が混じっていれば fallback で測って mixed にする。
 * fixed なら、利用者が選んだ縮尺 fallback で測る。
 */
export function measureArea(points: MeasurePoint[], fallback: number, fixed = false): AreaMeasured {
  let scale = fallback;
  let mixed = false;
  if (!fixed) {
    const known = new Set<number>();
    for (const p of points) if (p.scale != null) known.add(p.scale);
    if (known.size === 1) scale = [...known][0];
    else if (known.size > 1) mixed = true;
  }
  const n = points.length;
  const edges: number[] = [];
  const count = n >= 3 ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    edges.push(Math.hypot(b.x - a.x, b.y - a.y) * scale);
  }
  // 靴ひもの公式。図面座標のまま求め、縮尺の 2 乗を掛けて実寸にする
  let twice = 0;
  if (n >= 3) {
    // 座標が大きくても桁落ちしないよう、最初の点を原点にして足す
    const ox = points[0].x;
    const oy = points[0].y;
    for (let i = 1; i + 1 < n; i++) {
      const ax = points[i].x - ox, ay = points[i].y - oy;
      const bx = points[i + 1].x - ox, by = points[i + 1].y - oy;
      twice += ax * by - bx * ay;
    }
  }
  return {
    area: (Math.abs(twice) / 2) * scale * scale,
    perimeter: edges.reduce((x, y) => x + y, 0),
    edges,
    scale,
    mixed,
    crossing: n >= 4 && edgesCross(points),
  };
}

/**
 * 閉じた多角形の、隣り合わない辺どうしが交わっているか。
 * 頂点がちょうど別の辺（や別の頂点）の上に乗り、そこを突き抜けて反対側へ抜ける交わり方（8 の字）も含める
 */
function edgesCross(p: MeasurePoint[]): boolean {
  const n = p.length;
  const side = (a: MeasurePoint, b: MeasurePoint, c: MeasurePoint): number =>
    Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      // 最初の辺と最後の辺は隣どうし
      if (i === 0 && j === n - 1) continue;
      const c = p[j], d = p[(j + 1) % n];
      const s1 = side(a, b, c), s2 = side(a, b, d);
      const s3 = side(c, d, a), s4 = side(c, d, b);
      // 端が相手の辺にちょうど乗っている場合は、下で突き抜けているかを見る
      if (s1 * s2 < 0 && s3 * s4 < 0) return true;
    }
  }

  const at = (k: number): MeasurePoint => p[((k % n) + n) % n];
  const same = (a: MeasurePoint, b: MeasurePoint): boolean => a.x === b.x && a.y === b.y;
  /** 頂点 k から dir の向きに辿って、直線 ab の上にない最初の点がどちらの側にあるか（なければ 0） */
  const away = (a: MeasurePoint, b: MeasurePoint, k: number, dir: number): number => {
    for (let s = 1; s < n; s++) {
      const v = side(a, b, at(k + dir * s));
      if (v !== 0) return v;
    }
    return 0;
  };
  /** 同じ位置にある頂点 k と m で、2 回の通り道が互いを横切っているか（前後の辺の向きが交互に並ぶか） */
  const passes = (k: number, m: number): boolean => {
    const v = p[k];
    const ends = [at(k - 1), at(k + 1), at(m - 1), at(m + 1)];
    if (ends.some((q) => same(q, v))) return false;
    const dirs = ends.map((q) => Math.atan2(q.y - v.y, q.x - v.x));
    // 辺が重なっている（向きが同じ）ときは決めない
    if (new Set(dirs).size < 4) return false;
    const turn = (t: number): number => (((t - dirs[0]) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const width = turn(dirs[1]);
    return (turn(dirs[2]) < width) !== (turn(dirs[3]) < width);
  };
  for (let k = 0; k < n; k++) {
    const v = p[k];
    for (let i = 0; i < n; i++) {
      // 頂点 k を端に持つ辺は除く
      if (i === k || (i + 1) % n === k) continue;
      const a = p[i], b = at(i + 1);
      if (side(a, b, v) !== 0) continue;
      if (v.x < Math.min(a.x, b.x) || v.x > Math.max(a.x, b.x) || v.y < Math.min(a.y, b.y) || v.y > Math.max(a.y, b.y)) continue;
      if (same(v, a) || same(v, b)) {
        if (passes(k, same(v, a) ? i : (i + 1) % n)) return true;
        continue;
      }
      // 辺の途中に乗った頂点の前後が辺の反対側にあれば、そこで突き抜けている（接するだけなら同じ側）
      if (away(a, b, k, -1) * away(a, b, k, 1) < 0) return true;
    }
  }
  return false;
}

/** 面積の重心（ラベルを置く場所）。面積がほとんどなければ点の平均 */
export function polygonCenter(points: ReadonlyArray<{ x: number; y: number }>): { x: number; y: number } {
  const n = points.length;
  let sx = 0, sy = 0;
  for (const p of points) { sx += p.x; sy += p.y; }
  const mean = { x: sx / Math.max(n, 1), y: sy / Math.max(n, 1) };
  if (n < 3) return mean;
  const ox = points[0].x, oy = points[0].y;
  let a2 = 0, cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    const ax = points[i].x - ox, ay = points[i].y - oy;
    const b = points[(i + 1) % n];
    const bx = b.x - ox, by = b.y - oy;
    const cross = ax * by - bx * ay;
    a2 += cross;
    cx += (ax + bx) * cross;
    cy += (ay + by) * cross;
  }
  // 周の長さに比べて面積がほとんどない（一直線に並んでいる）ときは、重心が遠くへ飛ぶので使わない
  let per = 0;
  for (let i = 0; i < n; i++) {
    const b = points[(i + 1) % n];
    per += Math.hypot(b.x - points[i].x, b.y - points[i].y);
  }
  if (!(Math.abs(a2) > per * per * 1e-6)) return mean;
  const c = { x: ox + cx / (3 * a2), y: oy + cy / (3 * a2) };
  // 辺が交差して面積が打ち消し合うと、重心が点の範囲の外へ飛ぶことがある。そのときも点の平均にする
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return c.x >= minX && c.x <= maxX && c.y >= minY && c.y <= maxY ? c : mean;
}

/** 実寸 mm² を読みやすい文字列にする（0.01 m² 以上は m²。境目は mm² で丸めた後の値で決める） */
export function formatArea(mm2: number): string {
  if (Math.abs(Number(mm2.toFixed(1))) >= 1e4) return `${(mm2 / 1e6).toFixed(3)} m²`;
  return `${mm2.toFixed(1)} mm²`;
}

/**
 * 実寸 mm³ を読みやすい文字列にする（0.01 m³ 以上は m³、それより小さければ cm³。境目は cm³ で丸めた後の値で決める）。
 * 面積と同じく 0.01 で区切る（m³ の小数 3 桁では、0.01 m³ 未満は有効数字が 1 桁になってしまう）
 */
export function formatVolume(mm3: number): string {
  if (Math.abs(Number((mm3 / 1e3).toFixed(1))) >= 1e4) return `${(mm3 / 1e9).toFixed(3)} m³`;
  return `${(mm3 / 1e3).toFixed(1)} cm³`;
}

/**
 * 入力された長さ（mm）を数にする。桁区切りのカンマや全角の数字も受け付ける。
 * 0 以下や大きすぎる値（10 km 以上）は null
 */
export function parseLength(text: string): number | null {
  const s = text
    .replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,，\s]/g, '')
    .replace(/mm$/i, '');
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) && v > 0 && v < 1e7 ? v : null;
}
