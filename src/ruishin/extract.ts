// Scene から累進寸法の材料になる寸法を拾う。
// 1. 寸法図形（JWW の CDataSunpou、DXF の DIMENSION）：寸法線と寸法値の組がそのまま分かる
// 2. 寸法図形にしていない寸法：線と、その線の上に平行に書いた数字の文字の組。
//    数字が線の長さ（実寸）と合うものだけを寸法とみなす（たまたま線の近くにある数字を拾わないように）
import { KIND, type Scene, type SceneText } from '../render/geometry.ts';
import { plainText } from '../render/textlayer.ts';
import { buildChains, parseDimValue, type Chain, type DimInput } from './ordinate.ts';

/** 文字の中ほど（始点は左下なので、進む向きに幅の半分、上に高さの半分） */
function textCenter(t: SceneText): [number, number] {
  const a = (t.angle * Math.PI) / 180;
  const co = Math.cos(a), si = Math.sin(a);
  return [t.x + co * t.width / 2 - si * t.height / 2, t.y + si * t.width / 2 + co * t.height / 2];
}

/** 線と文字が平行とみなす角度の差（rad） */
const PARALLEL_TOL = 0.002;

/** 寸法図形を拾う */
function dimEntities(scene: Scene): DimInput[] {
  const { entities: e, linePos: pos, texts } = scene;
  const out: DimInput[] = [];
  for (let i = 0; i < e.count; i++) {
    if (e.kind[i] !== KIND.dim || e.lineCount[i] < 1) continue;
    const s = e.lineStart[i];
    const ti = e.text[i];
    const t = ti >= 0 ? texts[ti] : undefined;
    const c = t ? textCenter(t) : undefined;
    out.push({
      tx: c?.[0], ty: c?.[1],
      x1: pos[s * 4], y1: pos[s * 4 + 1], x2: pos[s * 4 + 2], y2: pos[s * 4 + 3],
      text: t ? plainText(t.text) : '',
      textHeight: t?.height ?? 0,
      scale: scene.scales[e.group[i]] || 1,
      group: e.group[i],
      entity: i,
      textIndex: ti,
    });
  }
  return out;
}

/** 文字の向き（[0, π)）。線の向きと比べるため */
function textDirection(deg: number): number {
  let th = (deg * Math.PI) / 180;
  th %= Math.PI;
  if (th < 0) th += Math.PI;
  if (th >= Math.PI - PARALLEL_TOL) th -= Math.PI;
  return th;
}

/** 寸法図形にしていない寸法（線と、その上の数字）を拾う */
function looseDims(scene: Scene, used: Set<number>, vis: Visibility): DimInput[] {
  const { entities: e, linePos: pos, texts } = scene;

  // 数字の文字
  const nums: Array<{ ti: number; value: number; th: number; cx: number; cy: number; h: number }> = [];
  for (let ti = 0; ti < texts.length; ti++) {
    if (used.has(ti)) continue;
    const t = texts[ti];
    if (e.kind[t.entity] !== KIND.text) continue;
    if (vis.text && !vis.text(ti)) continue;
    const p = parseDimValue(plainText(t.text));
    if (!p || p.value <= 0) continue;
    const [cx, cy] = textCenter(t);
    nums.push({ ti, value: p.value, th: textDirection(t.angle), h: t.height, cx, cy });
  }
  if (nums.length === 0) return [];

  // 線分を、向きと位置でおおまかに引けるようにしておく
  const CELL = 2;
  const buckets = new Map<string, number[]>();
  const keyOf = (th: number, off: number): string => `${Math.round(th / PARALLEL_TOL)}:${Math.floor(off / CELL)}`;
  for (let i = 0; i < e.count; i++) {
    if (e.kind[i] !== KIND.line || e.lineCount[i] !== 1) continue;
    if (vis.entity && !vis.entity(i)) continue;
    const s = e.lineStart[i];
    const x1 = pos[s * 4], y1 = pos[s * 4 + 1], x2 = pos[s * 4 + 2], y2 = pos[s * 4 + 3];
    let th = Math.atan2(y2 - y1, x2 - x1);
    if (th < 0) th += Math.PI;
    if (th >= Math.PI - PARALLEL_TOL) th -= Math.PI;
    const off = -Math.sin(th) * x1 + Math.cos(th) * y1;
    const k = keyOf(th, off);
    let list = buckets.get(k);
    if (!list) buckets.set(k, (list = []));
    list.push(i);
  }

  // 文字ごとに、平行で、文字のすぐ下（または上）にあり、長さが数字と合う線を探す
  const best = new Map<number, { ti: number; score: number; text: (typeof nums)[number] }>();
  for (const n of nums) {
    const ux = Math.cos(n.th), uy = Math.sin(n.th);
    const nx = -uy, ny = ux;
    const off = n.cx * nx + n.cy * ny;
    const reach = n.h * 1.6;
    const thKey = Math.round(n.th / PARALLEL_TOL);
    for (let dk = -1; dk <= 1; dk++) {
      for (let c = Math.floor((off - reach) / CELL); c <= Math.floor((off + reach) / CELL); c++) {
        const list = buckets.get(`${thKey + dk}:${c}`);
        if (!list) continue;
        for (const i of list) {
          const s = e.lineStart[i];
          const x1 = pos[s * 4], y1 = pos[s * 4 + 1], x2 = pos[s * 4 + 2], y2 = pos[s * 4 + 3];
          const lo = x1 * nx + y1 * ny;
          const gap = Math.abs(off - lo);
          if (gap > reach) continue;
          // 文字の中ほどが線の範囲の中にある
          const a = Math.min(x1 * ux + y1 * uy, x2 * ux + y2 * uy);
          const b = Math.max(x1 * ux + y1 * uy, x2 * ux + y2 * uy);
          const mid = n.cx * ux + n.cy * uy;
          if (mid < a || mid > b) continue;
          const real = (b - a) * (scene.scales[e.group[i]] || 1);
          if (!(real > 0)) continue;
          // mm で書いた寸法値か m で書いた寸法値のどちらかと合う
          const err = Math.min(Math.abs(n.value - real), Math.abs(n.value * 1000 - real));
          if (err > Math.max(0.5, real * 0.002)) continue;
          const score = gap + err;
          const prev = best.get(i);
          if (!prev || score < prev.score) best.set(i, { ti: n.ti, score, text: n });
        }
      }
    }
  }

  // 1 つの文字を 2 本の線に使わない（近いほうの線に）
  const byText = new Map<number, { line: number; score: number }>();
  for (const [line, b] of best) {
    const prev = byText.get(b.ti);
    if (!prev || b.score < prev.score) byText.set(b.ti, { line, score: b.score });
  }
  const out: DimInput[] = [];
  for (const [ti, { line: i }] of byText) {
    const s = e.lineStart[i];
    const t = texts[ti];
    const [tx, ty] = textCenter(t);
    out.push({
      tx, ty,
      x1: pos[s * 4], y1: pos[s * 4 + 1], x2: pos[s * 4 + 2], y2: pos[s * 4 + 3],
      text: plainText(t.text),
      textHeight: t.height,
      scale: scene.scales[e.group[i]] || 1,
      group: e.group[i],
      entity: i,
      textIndex: ti,
    });
  }
  return out;
}

/** いま図面に見えているか（隠したレイヤ・色の図形と文字は拾わない）。省けばすべて見えているものとする */
export interface Visibility {
  /** 図形（scene.entities の添字） */
  entity?: (i: number) => boolean;
  /** 文字（scene.texts の添字） */
  text?: (ti: number) => boolean;
}

export interface ExtractOptions extends Visibility {
  /** 寸法図形にしていない寸法（線と数字）も拾う */
  loose?: boolean;
  /** これより少ない寸法の列は返さない */
  minSpans?: number;
}

/**
 * 図面の寸法を拾って列にまとめる。
 * 図面に見えていない寸法（隠したレイヤや色の寸法線・寸法値）は使わない
 * （見えない寸法が列に混ざったり、見えない所に累進の値が出たりしないように）
 */
export function extractChains(scene: Scene, opts: ExtractOptions = {}): Chain[] {
  const all = dimEntities(scene);
  const dims = all.filter((d) => (!opts.entity || opts.entity(d.entity)) && (d.textIndex < 0 || !opts.text || opts.text(d.textIndex)));
  if (opts.loose ?? true) {
    // 隠した寸法図形の寸法値も、線と数字の寸法には使わない
    const used = new Set(all.map((d) => d.textIndex).filter((t) => t >= 0));
    dims.push(...looseDims(scene, used, opts));
  }
  return buildChains(dims, opts.minSpans ?? 2);
}
