/**
 * DXF の文書を Scene に書き出す。
 * レイヤは表の順に 0〜255 の番号を振る（256 を超える分は 255 にまとめる）。縮尺の枠は 1 つ（枠 0）で、
 * 縮尺は「単位を mm に直す倍率」。利用者が選んだ縮尺は画面の側で掛け直す
 */
import {
  Builder, IDENTITY, KIND, MAX_EXPANSIONS, Palette, TRUNCATED_WARNING, apply, compose, finishScene,
  type Scene, type Xform,
} from '../render/builder.ts';
import { emitConic, emitFill, emitPolyline, emitTextItem, type Conic } from '../render/prim.ts';
import { TRUE_COLOR_PEN, aciLabel, aciRgb } from './aci.ts';
import { DXF_STYLE_SLOTS, dashPattern } from './ltype.ts';
import { dxfUnit } from './units.ts';
import type { DxfCommon, DxfDocument, DxfEntity, DxfLayer } from './types.ts';

/** 部品の入れ子の深さの上限 */
const MAX_DEPTH = 16;

/** 裏返しの OCS（押し出しの向きの z が負）。x を反転する */
const MIRROR: Xform = { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export interface DxfSceneResult {
  scene: Scene;
  /** レイヤ番号（0〜255）ごとの名前と状態（0 は元の図面で非表示、2 は表示） */
  layers: { name: string; state: number }[];
  /** 線種番号ごとの名前 */
  lineTypeNames: string[];
  units: { name: string; toMm: number; guessed: boolean; code: number };
  counts: Record<string, number>;
  warnings: string[];
}

/** 解決済みの色。rgb は真の色（0xRRGGBB）、なければ -1 */
interface Color { pen: number; rgb: number }

/** 部品の中身を書き出すときの、配置した側から受け継ぐもの */
interface Context {
  t: Xform;
  /** レイヤ 0 の図形が受け継ぐレイヤ（いちばん外側では null） */
  layer: number | null;
  /** BYBLOCK の色と線種 */
  color: Color;
  ltype: string;
  block: number;
  depth: number;
}

export function buildDxfScene(doc: DxfDocument): DxfSceneResult {
  const warnings = [...doc.warnings];

  // レイヤ。表にないレイヤを使う図形があれば、出てきた順に後ろへ足す
  const layers: DxfLayer[] = [...doc.layers];
  const byName = new Map<string, number>();
  layers.forEach((l, i) => byName.set(l.name.toUpperCase(), i));
  const addLayer = (name: string): void => {
    const key = name.toUpperCase();
    if (byName.has(key)) return;
    byName.set(key, layers.length);
    layers.push({ name, color: 7, trueColor: -1, ltype: 'CONTINUOUS', frozen: false });
  };
  addLayer('0');
  const visit = (list: DxfEntity[]): void => { for (const e of list) addLayer(e.layer); };
  visit(doc.entities);
  for (const b of doc.blocks.values()) visit(b.entities);
  const overflow = layers.length > 256;
  if (overflow) warnings.push(`レイヤが ${layers.length} 個あるため、256 個目からは「その他のレイヤ」にまとめました`);
  /** レイヤ名の番号（0〜255） */
  const slotOf = (name: string): number => Math.min(255, byName.get(name.toUpperCase()) ?? 0);
  const layerAt = (name: string): DxfLayer => layers[byName.get(name.toUpperCase()) ?? 0];

  const outLayers = layers.slice(0, 256).map((l) => ({ name: l.name, state: l.color < 0 || l.frozen ? 0 : 2 }));
  if (overflow) outLayers[255] = { name: `その他のレイヤ（${layers.length - 255} 個）`, state: 2 };

  // 線種。使われたものから順に番号を振る
  const styleByName = new Map<string, number>();
  const lineTypeNames: string[] = [];
  const dashes = new Uint32Array(64 * 2);
  let nextSlot = 0;
  const styleOf = (name: string): number => {
    const key = name.toUpperCase();
    const hit = styleByName.get(key);
    if (hit !== undefined) return hit;
    let style = 0;
    const lt = doc.ltypes.get(key);
    const pat = lt ? dashPattern(lt) : null;
    if (pat && nextSlot < DXF_STYLE_SLOTS.length) {
      style = DXF_STYLE_SLOTS[nextSlot++];
      dashes[style * 2] = pat[0];
      dashes[style * 2 + 1] = pat[1];
      lineTypeNames[style] = lt?.name ?? name;
    }
    styleByName.set(key, style);
    return style;
  };
  lineTypeNames[0] = '実線';

  const b = new Builder(new Palette({
    base: (pen) => (pen === TRUE_COLOR_PEN ? [255, 255, 255] : aciRgb(pen)),
    label: aciLabel,
  }), { arcTolerance: tolerance(doc), pointRadius: () => 0 });

  // 大きな座標（測量座標など）は、図面の中ほどを原点に寄せて書き出す（Float32 で桁が落ちないように）
  const origin = originOf(doc);
  const base: Xform = origin ? { ...IDENTITY, e: -origin[0], f: -origin[1] } : IDENTITY;

  const counts: Record<string, number> = {};
  const missing = new Set<string>();

  const resolveColor = (c: DxfCommon, layer: DxfLayer, ctx: Context): Color => {
    if (c.trueColor >= 0) return { pen: TRUE_COLOR_PEN, rgb: c.trueColor };
    if (c.color === 0) return ctx.color;
    if (c.color >= 1 && c.color <= 255) return { pen: c.color, rgb: -1 };
    // BYLAYER（256）とそのほか
    if (layer.trueColor >= 0) return { pen: TRUE_COLOR_PEN, rgb: layer.trueColor };
    const n = Math.abs(layer.color);
    return { pen: n >= 1 && n <= 255 ? n : 7, rgb: -1 };
  };
  const resolveLtype = (c: DxfCommon, layer: DxfLayer, ctx: Context): string => {
    const u = c.ltype.toUpperCase();
    if (u === 'BYLAYER' || u === '') return layer.ltype;
    if (u === 'BYBLOCK') return ctx.ltype;
    return c.ltype;
  };

  const emitList = (list: DxfEntity[], ctx: Context, open: Set<string>): void => {
    if (b.truncated) return;
    if (++b.expanded > MAX_EXPANSIONS) { b.truncated = true; return; }
    for (const e of list) {
      if (b.truncated) return;
      // レイヤ 0 の図形は、配置した側のレイヤに載る
      const inherit = ctx.layer !== null && e.layer === '0';
      const layer = inherit ? ctx.layer! : slotOf(e.layer);
      const layerDef = inherit ? layerByIndex(ctx.layer!) : layerAt(e.layer);
      const col = resolveColor(e, layerDef, ctx);
      const custom = col.rgb >= 0 ? colorref(col.rgb) : undefined;
      const t = e.flip && e.type !== 'ELLIPSE' && e.type !== 'LINE' && e.type !== 'POINT' ? compose(MIRROR, ctx.t) : ctx.t;
      counts[e.type] = (counts[e.type] ?? 0) + 1;

      if (e.type === 'INSERT') {
        const def = doc.blocks.get(e.block.toUpperCase());
        if (!def) { missing.add(e.block); continue; }
        if (ctx.depth >= MAX_DEPTH || open.has(def.name.toUpperCase())) continue;
        const rot = (e.rotation * Math.PI) / 180;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const a = e.sx * cos, bb = e.sx * sin, c = -e.sy * sin, d = e.sy * cos;
        // 基点を原点に寄せてから倍率・回転を掛け、配置点へ動かす
        const local: Xform = { a, b: bb, c, d, e: e.x - (a * def.x + c * def.y), f: e.y - (bb * def.x + d * def.y) };
        const key = def.name.toUpperCase();
        open.add(key);
        emitList(def.entities, {
          t: compose(local, t),
          layer,
          color: col,
          ltype: resolveLtype(e, layerDef, ctx),
          block: b.blockOf(key, () => def.name),
          depth: ctx.depth + 1,
        }, open);
        open.delete(key);
        continue;
      }

      const color = b.palette.entry(col.pen, custom);
      const style = e.type === 'TEXT' || e.type === 'POINT' || e.type === 'SOLID' ? 0 : styleOf(resolveLtype(e, layerDef, ctx));
      const rgb = custom ?? -1;
      switch (e.type) {
        case 'LINE': {
          b.begin(KIND.line, col.pen, style, layer, color, ctx.block, rgb, 0);
          const [x1, y1] = apply(t, e.x1, e.y1);
          const [x2, y2] = apply(t, e.x2, e.y2);
          b.addSegment(x1, y1, x2, y2, color, layer, true);
          b.end(Math.hypot(x2 - x1, y2 - y1));
          break;
        }
        case 'POINT': {
          b.begin(KIND.point, col.pen, 0, layer, color, ctx.block, rgb, 0);
          const [x, y] = apply(t, e.x, e.y);
          b.addPoint(x, y, layer, color);
          b.addDot(x, y, 0, color, layer);
          b.end();
          b.track(x, y);
          break;
        }
        case 'CIRCLE':
        case 'ARC': {
          const full = e.type === 'CIRCLE';
          let sweep = Math.PI * 2;
          let start = 0;
          if (!full) {
            start = (e.start * Math.PI) / 180;
            const deg = (((e.end - e.start) % 360) + 360) % 360;
            sweep = ((deg || 360) * Math.PI) / 180;
          }
          const conic: Conic = { cx: e.x, cy: e.y, ux: e.r, uy: 0, vx: 0, vy: e.r, start, sweep };
          b.begin(full ? KIND.circle : KIND.arc, col.pen, style, layer, color, ctx.block, rgb, 0);
          const r = emitConic(b, conic, t, color, layer, !full, true);
          b.end(r.major, r.length, r.minor);
          break;
        }
        case 'ELLIPSE': {
          let sweep = e.end - e.start;
          while (sweep <= 0) sweep += Math.PI * 2;
          if (sweep > Math.PI * 2) sweep = Math.PI * 2;
          const full = Math.abs(sweep - Math.PI * 2) < 1e-9;
          // 短軸は、押し出しの向き（z）と長軸の外積の向き。裏返しなら逆を向く
          const s = e.flip ? -1 : 1;
          const conic: Conic = {
            cx: e.x, cy: e.y, ux: e.mx, uy: e.my, vx: -e.my * e.ratio * s, vy: e.mx * e.ratio * s,
            start: e.start, sweep,
          };
          b.begin(full ? KIND.circle : KIND.arc, col.pen, style, layer, color, ctx.block, rgb, 0);
          const r = emitConic(b, conic, t, color, layer, !full, true);
          b.end(r.major, r.length, r.minor);
          break;
        }
        case 'POLYLINE': {
          b.begin(KIND.polyline, col.pen, style, layer, color, ctx.block, rgb, 0);
          const length = emitPolyline(b, e.xy, e.bulge, e.closed, t, color, layer);
          b.end(length, length);
          break;
        }
        case 'TEXT': {
          if (!e.text || !(e.height > 0)) break;
          const ent = b.begin(KIND.text, col.pen, 0, layer, color, ctx.block, rgb, 0);
          const width = textWidth(e.text, e.height) * (e.widthFactor > 0 ? e.widthFactor : 1);
          const index = emitTextItem(b, e.text, e.x, e.y, width, e.height, e.rotation, t, color, layer, ent);
          b.entText.data[ent] = index;
          b.end(index >= 0 ? b.texts[index].height : 0);
          break;
        }
        case 'SOLID': {
          b.begin(KIND.solid, col.pen, 0, layer, color, ctx.block, rgb, 0);
          emitFill(b, e.pts, t, color, layer);
          b.end();
          break;
        }
      }
    }
  };
  const layerByIndex = (k: number): DxfLayer => layers[k] ?? layers[0];

  emitList(doc.entities, { t: base, layer: null, color: { pen: 7, rgb: -1 }, ltype: 'CONTINUOUS', block: -1, depth: 0 }, new Set());
  if (b.truncated) warnings.push(TRUNCATED_WARNING);
  if (missing.size) warnings.push(`見つからない部品があります（${missing.size} 種類）`);
  if (doc.paperSpace) warnings.push(`ペーパー空間の図形（${doc.paperSpace} 個）は表示していません`);
  if (doc.skipped.size) {
    const list = [...doc.skipped].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`);
    warnings.push(`まだ表示できない図形を読み飛ばしました（${list.join('、')}）`);
  }

  const { unit, guessed } = dxfUnit(doc.insunits);
  const scales = new Float64Array(16).fill(unit.toMm);
  const scene = finishScene(b, { paper: null, dashes, scales, origin: origin ?? undefined });
  return {
    scene,
    layers: outLayers,
    lineTypeNames,
    units: { name: unit.name, toMm: unit.toMm, guessed, code: guessed ? 0 : unit.code },
    counts,
    warnings,
  };
}

/** 0xRRGGBB を Jw_cad と同じ COLORREF（0xBBGGRR）に */
function colorref(rgb: number): number {
  return ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);
}

/** 文字列のおよその長さ。全角は高さと同じ、半角はその半分とみなす */
function textWidth(text: string, height: number): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    w += c < 0x100 || (c >= 0xff61 && c <= 0xff9f) ? 0.5 : 1;
  }
  return w * height;
}

/** 図形の範囲（$EXTMIN・$EXTMAX、なければモデル空間の図形の代表点から） */
function extentsOf(doc: DxfDocument): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (doc.extents) return doc.extents;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e12 || Math.abs(y) > 1e12) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const e of doc.entities) {
    switch (e.type) {
      case 'LINE': add(e.x1, e.y1); add(e.x2, e.y2); break;
      case 'POLYLINE': for (let i = 0; i < e.xy.length; i += 2) add(e.xy[i], e.xy[i + 1]); break;
      case 'SOLID': add(e.pts[0], e.pts[1]); break;
      default: add(e.x, e.y);
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** 円弧を折るときの許容誤差。図面の範囲の 10 万分の 1（単位の分からない図面でも見た目がそろうように） */
function tolerance(doc: DxfDocument): number {
  const ext = extentsOf(doc);
  const size = ext ? Math.max(ext.maxX - ext.minX, ext.maxY - ext.minY) : 0;
  return size > 0 && Number.isFinite(size) ? size * 1e-5 : 0.02;
}

/** 座標を寄せる量。図面が原点から大きさの 4 倍以上離れているときだけ寄せる */
function originOf(doc: DxfDocument): [number, number] | null {
  const ext = extentsOf(doc);
  if (!ext) return null;
  const cx = (ext.minX + ext.maxX) / 2;
  const cy = (ext.minY + ext.maxY) / 2;
  const size = Math.max(ext.maxX - ext.minX, ext.maxY - ext.minY, 1);
  if (Math.hypot(cx, cy) < size * 4 || Math.hypot(cx, cy) < 1e4) return null;
  return [Math.round(cx), Math.round(cy)];
}
