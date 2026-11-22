// 図面の寸法を「累進寸法」に直す計算。
// 一直線に並んだ寸法（連続寸法）をひと続きの「列」にまとめ、列ごとに起点からの累計を出す。
// 画面にも Jw_cad にも依存しない計算だけを置く（Scene から寸法を拾うのは extract.ts）。

/** 列の元になる 1 本の寸法 */
export interface DimSpan {
  /** 寸法線の両端を列の向きに投影した位置（図面座標。a < b） */
  a: number;
  b: number;
  /** 寸法値を数として読めたときの値（寸法値の単位のまま）。読めなければ null */
  value: number | null;
  /** 寸法値と図形の長さ（実寸）が合わない */
  mismatch: boolean;
  /** 元の図形（scene.entities の添字）。寸法線 */
  entity: number;
  /** 寸法値の文字（scene.texts の添字）。無ければ -1 */
  text: number;
}

/** 寸法値の書き方。累進の値も同じ書き方で出す */
export interface ValueFormat {
  /** 寸法値の単位。'm' なら 1820mm を 1.82 と書く */
  unit: 'mm' | 'm';
  /** 小数点以下の桁数 */
  decimals: number;
  /** 3 桁ごとのカンマ */
  comma: boolean;
}

/** 一直線に並んだ寸法のまとまり */
export interface Chain {
  id: number;
  /** 列の向き（単位ベクトル）。水平なら (1, 0)、垂直なら (0, 1) */
  ux: number;
  uy: number;
  /** 列の法線（向きを左に 90° 回したもの） */
  nx: number;
  ny: number;
  /** 寸法線の位置。法線方向の座標 */
  offset: number;
  /** 実寸に直す縮尺の分母 */
  scale: number;
  /** レイヤグループ */
  group: number;
  spans: DimSpan[];
  /** 寸法の端の位置（列の向きの座標）を小さい順に。累進の値を書く所 */
  stops: number[];
  /**
   * stops ごとの、最初の端から数えた実寸の累計（mm）。寸法値が読めた区間は寸法値を、
   * 読めない区間は図形の長さ × 縮尺を足していく（寸法値を書き換えた図面でも、書いてある数字どおりに累計する）
   */
  cumulative: number[];
  format: ValueFormat;
  /** 寸法値の文字の高さ（図面座標）。累進の値もこの大きさで書く */
  textHeight: number;
  /** 寸法値と図形の長さが合わない寸法がある */
  mismatch: boolean;
  /** 寸法値を寸法線のどちら側に書いてあるか（法線の向きなら 1、逆なら -1）。累進の値も同じ側に書く */
  side: 1 | -1;
}

/** 起点。図面上の点（吸着した点）で持ち、列の向きに投影して使う */
export interface Origin {
  x: number;
  y: number;
}

/** 列の向きの座標 */
export function along(c: Chain, x: number, y: number): number {
  return x * c.ux + y * c.uy;
}

/** 列の向きの座標 t にある、寸法線の上の点 */
export function onChain(c: Chain, t: number): [number, number] {
  return [c.ux * t + c.nx * c.offset, c.uy * t + c.ny * c.offset];
}

/** 列の向きの座標 t を、最初の端から数えた実寸（mm）に直す。端の外は縮尺で伸ばす */
export function realAt(c: Chain, t: number): number {
  const s = c.stops, v = c.cumulative;
  const n = s.length;
  if (n === 0) return 0;
  if (t <= s[0]) return (t - s[0]) * c.scale;
  if (t >= s[n - 1]) return v[n - 1] + (t - s[n - 1]) * c.scale;
  // 二分探索で t を挟む区間を探し、その区間の中は比例で割り振る
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= t) lo = mid;
    else hi = mid;
  }
  const w = s[hi] - s[lo];
  return w > 0 ? v[lo] + ((v[hi] - v[lo]) * (t - s[lo])) / w : v[lo];
}

/** 累進の値を書く 1 か所 */
export interface OrdinateStop {
  /** 列の向きの座標 */
  t: number;
  /** 寸法線の上の点（図面座標） */
  x: number;
  y: number;
  /** 起点からの実寸（mm）。起点より手前（列の向きの逆）なら負 */
  value: number;
  /** 起点そのもの */
  isOrigin: boolean;
}

/** 起点に揃っているとみなす隔たり（図面座標 mm） */
export const SAME_POINT = 1e-3;

/**
 * 起点から見た各端の累進の値。起点が端に乗っていなければ、起点の位置にも 0 の印を足す
 */
export function ordinates(c: Chain, origin: Origin): OrdinateStop[] {
  const t0 = along(c, origin.x, origin.y);
  const r0 = realAt(c, t0);
  const out: OrdinateStop[] = [];
  let hasOrigin = false;
  for (let i = 0; i < c.stops.length; i++) {
    const t = c.stops[i];
    const [x, y] = onChain(c, t);
    const isOrigin = Math.abs(t - t0) <= SAME_POINT;
    if (isOrigin) hasOrigin = true;
    out.push({ t, x, y, value: isOrigin ? 0 : c.cumulative[i] - r0, isOrigin });
  }
  if (!hasOrigin) {
    const [x, y] = onChain(c, t0);
    out.push({ t: t0, x, y, value: 0, isOrigin: true });
    out.sort((p, q) => p.t - q.t);
  }
  return out;
}

/** 既定の起点（列の最初の端） */
/**
 * 起点が寸法線の範囲（最初の端〜最後の端）の外にあるとき、寸法線を起点まで伸ばして見せる区間。
 * from は近いほうの寸法線の端、to は起点を寸法線に投影した位置（どちらも列の向きの座標 t）。範囲の中なら null。
 * 画面に描くだけで、図面の図形は変えない
 */
export function chainExtension(c: Chain, origin: Origin): { from: number; to: number } | null {
  if (c.stops.length === 0) return null;
  const lo = c.stops[0];
  const hi = c.stops[c.stops.length - 1];
  const t = along(c, origin.x, origin.y);
  const eps = Math.max(1e-9, (hi - lo) * 1e-9);
  if (t < lo - eps) return { from: lo, to: t };
  if (t > hi + eps) return { from: hi, to: t };
  return null;
}

export function defaultOrigin(c: Chain): Origin {
  const [x, y] = onChain(c, c.stops[0] ?? 0);
  return { x, y };
}

/** 実寸（mm）を寸法値の書き方で文字にする。負の値は、signed でなければ符号を付けない */
export function formatValue(mm: number, f: ValueFormat, signed = false): string {
  let v = f.unit === 'm' ? mm / 1000 : mm;
  const neg = v < 0;
  v = Math.abs(v);
  let s = v.toFixed(f.decimals);
  // 0.000 のような値は 0 にそろえる
  if (Number(s) === 0) return '0';
  if (f.comma) {
    const [int, frac] = s.split('.');
    s = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '');
  }
  return neg && signed ? `-${s}` : s;
}

/**
 * 寸法値の文字を数として読む。全角の数字・カンマ・空白を受け付け、
 * 半径（R）・直径（φ）・角度（°）など長さ以外のものや、数字でない文字が混ざるものは null
 */
export function parseDimValue(raw: string): { value: number; decimals: number; comma: boolean } | null {
  let s = raw.replace(/[０-９．，]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/[\s　]/g, '');
  const comma = s.includes(',');
  s = s.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const dot = s.indexOf('.');
  return { value: Number(s), decimals: dot < 0 ? 0 : s.length - dot - 1, comma };
}

/** 列にまとめる前の 1 本の寸法 */
export interface DimInput {
  /** 寸法線の両端（図面座標） */
  x1: number; y1: number;
  x2: number; y2: number;
  /** 寸法値の文字列（無ければ空） */
  text: string;
  /** 寸法値の文字の高さ（図面座標） */
  textHeight: number;
  scale: number;
  group: number;
  entity: number;
  textIndex: number;
  /** 寸法値の文字の中ほど（図面座標）。分からなければ省く */
  tx?: number;
  ty?: number;
}

/** 同じ向きとみなす角度の差（rad） */
const ANGLE_TOL = 1e-4;
/** 同じ寸法線の上とみなす法線方向の隔たり（図面座標 mm） */
const OFFSET_TOL = 0.05;
/** 端どうしがつながっているとみなす隔たり（図面座標 mm） */
const JOIN_TOL = 0.05;

/** 向きを [0, π) に収めた角度。水平は 0、垂直は π/2 */
function direction(d: DimInput): number {
  let th = Math.atan2(d.y2 - d.y1, d.x2 - d.x1);
  if (th < 0) th += Math.PI;
  if (th >= Math.PI - ANGLE_TOL) th -= Math.PI;
  return th;
}

/**
 * 寸法を列にまとめる。向き・寸法線の位置・縮尺が同じで、端がつながっている（重なっている）寸法をひとつの列にする。
 * minSpans より少ない寸法の列（単独の寸法・全体寸法など）は返さない
 */
export function buildChains(dims: DimInput[], minSpans = 2): Chain[] {
  const items = dims
    .filter((d) => Math.hypot(d.x2 - d.x1, d.y2 - d.y1) > JOIN_TOL)
    .map((d) => ({ d, th: direction(d) }));
  // 向きでまとめる（近い角度を続けて拾う）
  items.sort((p, q) => p.th - q.th);
  const byAngle: (typeof items)[] = [];
  for (const it of items) {
    const last = byAngle[byAngle.length - 1];
    if (last && it.th - last[last.length - 1].th <= ANGLE_TOL) last.push(it);
    else byAngle.push([it]);
  }
  // 0 付近と π 付近は同じ向き（direction で π 付近は 0 に寄せてある）

  const chains: Chain[] = [];
  for (const bucket of byAngle) {
    const th = bucket.reduce((s, it) => s + it.th, 0) / bucket.length;
    const ux = snapUnit(Math.cos(th)), uy = snapUnit(Math.sin(th));
    const nx = -uy, ny = ux;
    // 寸法線の位置と縮尺でまとめる
    const rows = bucket.map(({ d }) => ({
      d,
      off: d.x1 * nx + d.y1 * ny,
      a: Math.min(d.x1 * ux + d.y1 * uy, d.x2 * ux + d.y2 * uy),
      b: Math.max(d.x1 * ux + d.y1 * uy, d.x2 * ux + d.y2 * uy),
    }));
    rows.sort((p, q) => p.d.group - q.d.group || p.off - q.off);
    const lines: (typeof rows)[] = [];
    for (const r of rows) {
      const last = lines[lines.length - 1];
      const prev = last?.[last.length - 1];
      if (prev && prev.d.group === r.d.group && r.off - prev.off <= OFFSET_TOL) last.push(r);
      else lines.push([r]);
    }
    for (const line of lines) {
      // 列の向きに並べ、つながっているところで切り分ける
      line.sort((p, q) => p.a - q.a || p.b - q.b);
      let run: typeof line = [];
      let end = -Infinity;
      const flush = (): void => {
        if (run.length >= minSpans) chains.push(makeChain(chains.length, run, ux, uy, nx, ny));
        run = [];
      };
      for (const r of line) {
        if (r.a > end + JOIN_TOL) flush();
        run.push(r);
        end = Math.max(end, r.b);
      }
      flush();
    }
  }
  return chains;
}

/** 0・±1 にごく近い成分は丸める（水平・垂直の列が誤差で少し傾かないように） */
function snapUnit(v: number): number {
  if (Math.abs(v) < 1e-9) return 0;
  if (Math.abs(Math.abs(v) - 1) < 1e-9) return Math.sign(v);
  return v;
}

function makeChain(
  id: number,
  run: Array<{ d: DimInput; off: number; a: number; b: number }>,
  ux: number, uy: number, nx: number, ny: number,
): Chain {
  const scale = run[0].d.scale || 1;
  const group = run[0].d.group;
  const offset = run.reduce((s, r) => s + r.off, 0) / run.length;

  // 寸法値の書き方と単位。寸法値 ÷ 実寸がおよそ 1/1000 なら m で書いてある
  let decimals = 0, comma = false, mmVotes = 0, mVotes = 0;
  const parsed = run.map((r) => {
    const p = parseDimValue(r.d.text);
    if (!p) return null;
    decimals = Math.max(decimals, p.decimals);
    comma ||= p.comma;
    const real = (r.b - r.a) * scale;
    if (real > 0) {
      const ratio = p.value / real;
      if (Math.abs(Math.log10(ratio)) < Math.abs(Math.log10(ratio * 1000))) mmVotes++;
      else mVotes++;
    }
    return p;
  });
  const unit: 'mm' | 'm' = mVotes > mmVotes ? 'm' : 'mm';
  const toMm = unit === 'm' ? 1000 : 1;

  const spans: DimSpan[] = run.map((r, i) => {
    const p = parsed[i];
    const real = (r.b - r.a) * scale;
    const value = p ? p.value : null;
    // 寸法値の丸め（最小の桁の半分）と 0.5% のどちらか大きいほうまでは合っているとみなす
    const tol = Math.max((0.5 * toMm) / 10 ** (p?.decimals ?? 0), real * 0.005, 0.5);
    const mismatch = value !== null && Math.abs(value * toMm - real) > tol;
    return { a: r.a, b: r.b, value, mismatch, entity: r.d.entity, text: r.d.textIndex };
  });

  // 端の位置（近いものはひとつにまとめる）
  const ends = spans.flatMap((s) => [s.a, s.b]).sort((p, q) => p - q);
  const stops: number[] = [];
  for (const t of ends) {
    if (stops.length && t - stops[stops.length - 1] <= JOIN_TOL) continue;
    stops.push(t);
  }
  const near = (p: number, q: number): boolean => Math.abs(p - q) <= JOIN_TOL;
  const cumulative: number[] = [0];
  for (let i = 1; i < stops.length; i++) {
    // ちょうどこの区間だけを測っている寸法があれば、その寸法値を使う
    const exact = spans.find((s) => s.value !== null && near(s.a, stops[i - 1]) && near(s.b, stops[i]));
    const len = exact ? exact.value! * toMm : (stops[i] - stops[i - 1]) * scale;
    cumulative.push(cumulative[i - 1] + len);
  }

  // 寸法値を書いた側。文字の中ほどが寸法線から法線のどちらへずれているかの多数決
  let sideVote = 0;
  for (const r of run) {
    if (r.d.tx === undefined || r.d.ty === undefined) continue;
    sideVote += Math.sign(r.d.tx * nx + r.d.ty * ny - r.off);
  }
  const side: 1 | -1 = sideVote < 0 ? -1 : 1;

  const heights = run.map((r) => r.d.textHeight).filter((h) => h > 0);
  const textHeight = heights.length ? heights.reduce((s, h) => s + h, 0) / heights.length : 2.5;

  return {
    id, ux, uy, nx, ny, offset, scale, group, spans, stops, cumulative,
    format: { unit, decimals, comma }, textHeight,
    mismatch: spans.some((s) => s.mismatch),
    side,
  };
}

/** 2 つの列が平行か（起点をそろえるときに使う） */
export function parallel(p: Chain, q: Chain): boolean {
  return Math.abs(p.ux * q.uy - p.uy * q.ux) <= 1e-6;
}
