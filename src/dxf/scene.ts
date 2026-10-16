/**
 * DXF の文書を Scene に書き出す。
 * レイヤは表の順に 0〜255 の番号を振る（256 を超える分は 255 にまとめる）。縮尺の枠は 1 つ（枠 0）で、
 * 縮尺は「単位を mm に直す倍率」。利用者が選んだ縮尺は画面の側で掛け直す
 */
import {
  Builder, IDENTITY, KIND, MAX_EXPANSIONS, Palette, SNAP_FLAG, TRUNCATED_WARNING, apply, compose, finishScene,
  type Scene, type Xform,
} from '../render/builder.ts';
import {
  bulgeArc, emitConic, emitFill, emitPolyline, emitRings, emitTextItem, fitPoints, hatchSegments, splinePoints,
  type Conic,
} from '../render/prim.ts';
import { TRUE_COLOR_PEN, aciLabel, aciRgb } from './aci.ts';
import { DXF_STYLE_SLOTS, dashPattern } from './ltype.ts';
import { minorAxis, ocsXform } from './ocs.ts';
import { MAX_GRID } from './parse.ts';
import { dxfUnit } from './units.ts';
import type {
  DxfCommon, DxfDocument, DxfEntity, DxfHatch, DxfLayer, DxfMText, DxfText, HatchLoop,
} from './types.ts';

/** 部品の入れ子の深さの上限 */
const MAX_DEPTH = 16;
/** ハッチングの模様の線の上限（図面全体） */
const MAX_PATTERN_SEGMENTS = 200_000;
/** 座標が OCS（押し出しの向きで決まる座標系）の図形。ほかは WCS */
const OCS_TYPES = new Set(['CIRCLE', 'ARC', 'POLYLINE', 'TEXT', 'SOLID', 'INSERT', 'HATCH']);
/** MTEXT の行の間隔（字の高さに対する比。AutoCAD の既定の 1 倍の行間） */
const MTEXT_LINE = 5 / 3;

export interface DxfSceneResult {
  scene: Scene;
  /** レイヤ番号（0〜255）ごとの名前と状態（0 は元の図面で非表示、2 は表示） */
  layers: { name: string; state: number }[];
  /** 線種番号ごとの名前 */
  lineTypeNames: string[];
  units: { name: string; toMm: number; guessed: boolean; code: number };
  counts: Record<string, number>;
  /** 寸法ごとの実測値（42）・寸法値の文字・寸法線の長さ（図面の単位。確かめるため） */
  dimensions: { measurement: number; text: string; length: number }[];
  warnings: string[];
}

/** 解決済みの色。rgb は真の色（0xRRGGBB）、なければ -1 */
interface Color { pen: number; rgb: number }

/** 寸法の匿名部品を展開しているあいだの情報 */
interface DimContext {
  /** 補助線の起点（線がこの点を通る向きなら補助線） */
  x3: number; y3: number; x4: number; y4: number;
  /** 寸法を作る図形（寸法値の文字をつなぐ先） */
  members: number[];
  /** 寸法値の文字（texts の添字） */
  text: number;
  /** 最初の寸法線の長さ */
  length: number;
}

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
  /** 寸法の中身なら、その寸法 */
  dim: DimContext | null;
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
  const visit = (list: DxfEntity[]): void => {
    for (const e of list) {
      addLayer(e.layer);
      if (e.type === 'INSERT') for (const a of e.attribs) addLayer(a.layer);
    }
  };
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

  const tol = tolerance(doc);
  const b = new Builder(new Palette({
    base: (pen) => (pen === TRUE_COLOR_PEN ? [255, 255, 255] : aciRgb(pen)),
    label: aciLabel,
  }), { arcTolerance: tol, pointRadius: () => 0 });

  // 大きな座標（測量座標など）は、図面の中ほどを原点に寄せて書き出す（Float32 で桁が落ちないように）
  const origin = originOf(doc);
  const base: Xform = origin ? { ...IDENTITY, e: -origin[0], f: -origin[1] } : IDENTITY;
  // XLINE・RAY を切る範囲（書き出す座標で）。図面の範囲を少し広げたもの
  const ext = extentsOf(doc);
  const clip = ext ? (() => {
    const m = Math.max(ext.maxX - ext.minX, ext.maxY - ext.minY, 1) * 0.05;
    const [x0, y0] = apply(base, ext.minX - m, ext.minY - m);
    const [x1, y1] = apply(base, ext.maxX + m, ext.maxY + m);
    return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
  })() : null;
  const arrowSize = doc.arrowSize > 0 ? doc.arrowSize : doc.measurement === 0 ? 0.18 : 2.5;

  const counts: Record<string, number> = {};
  const missing = new Set<string>();
  const dimensions: DxfSceneResult['dimensions'] = [];
  let patternSegments = 0;
  let patternCut = false;
  let gridCut = false;

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
  const layerByIndex = (k: number): DxfLayer => layers[k] ?? layers[0];

  const emitList = (list: DxfEntity[], ctx: Context, open: Set<string>): void => {
    if (b.truncated) return;
    if (++b.expanded > MAX_EXPANSIONS) { b.truncated = true; return; }
    for (const e of list) {
      if (b.truncated) return;
      emitEntity(e, ctx, open);
    }
  };

  const emitEntity = (e: DxfEntity, ctx: Context, open: Set<string>): void => {
    // レイヤ 0 の図形は、配置した側のレイヤに載る
    const inherit = ctx.layer !== null && e.layer === '0';
    const layer = inherit ? ctx.layer! : slotOf(e.layer);
    const layerDef = inherit ? layerByIndex(ctx.layer!) : layerAt(e.layer);
    const col = resolveColor(e, layerDef, ctx);
    const custom = col.rgb >= 0 ? colorref(col.rgb) : undefined;
    const ocs = OCS_TYPES.has(e.type) ? ocsXform(e.normal, e.elevation) : null;
    const t = ocs ? compose(ocs, ctx.t) : ctx.t;
    // 寸法の中身は寸法として数える（線や文字の数には入れない）
    if (!ctx.dim) counts[e.type] = (counts[e.type] ?? 0) + 1;

    if (e.type === 'INSERT') {
      const def = doc.blocks.get(e.block.toUpperCase());
      if (!def) {
        missing.add(e.block);
      } else if (ctx.depth < MAX_DEPTH && !open.has(def.name.toUpperCase())) {
        const rot = (e.rotation * Math.PI) / 180;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const a = e.sx * cos, bb = e.sx * sin, c = -e.sy * sin, d = e.sy * cos;
        const key = def.name.toUpperCase();
        // MINSERT は行 × 列に並べる（間隔は倍率を掛けず、回転だけ掛ける）。数は上限まで
        const cols = Math.min(e.cols, MAX_GRID);
        let rows = e.rows;
        if (e.cols > MAX_GRID) gridCut = true;
        if (cols * rows > MAX_GRID) { rows = Math.max(1, Math.floor(MAX_GRID / cols)); gridCut = true; }
        const inner: Omit<Context, 't'> = {
          layer, color: col, ltype: resolveLtype(e, layerDef, ctx), block: b.blockOf(key, () => def.name),
          depth: ctx.depth + 1, dim: ctx.dim,
        };
        open.add(key);
        for (let r = 0; r < rows && !b.truncated; r++) {
          for (let k = 0; k < cols && !b.truncated; k++) {
            const gx = k * (e.colSpacing || 0), gy = r * (e.rowSpacing || 0);
            const ox = e.x + cos * gx - sin * gy, oy = e.y + sin * gx + cos * gy;
            // 基点を原点に寄せてから倍率・回転を掛け、配置点へ動かす
            const local: Xform = { a, b: bb, c, d, e: ox - (a * def.x + c * def.y), f: oy - (bb * def.x + d * def.y) };
            emitList(def.entities, { ...inner, t: compose(local, t) }, open);
          }
        }
        open.delete(key);
      }
      // 属性は配置した側の座標で持っている
      for (const at of e.attribs) {
        emitEntity(at, ctx, open);
        if (!ctx.dim) { counts.TEXT--; counts.ATTRIB = (counts.ATTRIB ?? 0) + 1; }
      }
      return;
    }

    if (e.type === 'DIMENSION') {
      const def = doc.blocks.get(e.block.toUpperCase());
      if (!def) { missing.add(e.block); return; }
      const key = def.name.toUpperCase();
      if (ctx.depth >= MAX_DEPTH || open.has(key)) return;
      const dim: DimContext = { x3: e.x3, y3: e.y3, x4: e.x4, y4: e.y4, members: [], text: -1, length: NaN };
      open.add(key);
      // 寸法の匿名部品の中身は WCS（基点は原点）
      emitList(def.entities, {
        t: compose({ ...IDENTITY, e: -def.x, f: -def.y }, ctx.t), layer, color: col,
        ltype: resolveLtype(e, layerDef, ctx), block: ctx.block, depth: ctx.depth + 1, dim,
      }, open);
      open.delete(key);
      for (const m of dim.members) b.entText.data[m] = dim.text;
      dimensions.push({
        measurement: e.measurement,
        text: dim.text >= 0 ? b.texts[dim.text].text : '',
        length: dim.length,
      });
      return;
    }

    const dim = ctx.dim;
    const color = b.palette.entry(col.pen, custom);
    const plain = e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'POINT' || e.type === 'SOLID' || e.type === 'HATCH';
    const style = plain ? 0 : styleOf(resolveLtype(e, layerDef, ctx));
    const rgb = custom ?? -1;
    /** 図形を書き始める。寸法の中では、文字は寸法値、補助線はそのまま、ほかは寸法線にする */
    const start = (kind: number, st = style): number => {
      const k = !dim ? kind : kind === KIND.text ? KIND.dimText : kind === KIND.dimAux ? KIND.dimAux : KIND.dim;
      const ent = b.begin(k, col.pen, st, layer, color, ctx.block, rgb, 0);
      if (dim) dim.members.push(ent);
      return ent;
    };
    switch (e.type) {
      case 'LINE': {
        // 寸法の中で、補助線の起点を通る向きの線は補助線（吸着しない）
        const aux = dim !== null && (onLine(e, dim.x3, dim.y3) || onLine(e, dim.x4, dim.y4));
        start(aux ? KIND.dimAux : KIND.line);
        const [x1, y1] = apply(t, e.x1, e.y1);
        const [x2, y2] = apply(t, e.x2, e.y2);
        b.addSegment(x1, y1, x2, y2, color, layer, !aux);
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (dim && !aux && Number.isNaN(dim.length)) dim.length = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
        b.end(len);
        break;
      }
      case 'POINT': {
        // 寸法の定義点は描かない
        if (dim) break;
        start(KIND.point, 0);
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
        let st = 0;
        if (!full) {
          st = (e.start * Math.PI) / 180;
          const deg = (((e.end - e.start) % 360) + 360) % 360;
          sweep = ((deg || 360) * Math.PI) / 180;
        }
        const conic: Conic = { cx: e.x, cy: e.y, ux: e.r, uy: 0, vx: 0, vy: e.r, start: st, sweep };
        start(full ? KIND.circle : KIND.arc);
        const r = emitConic(b, conic, t, color, layer, !full, true);
        b.end(r.major, r.length, r.minor);
        break;
      }
      case 'ELLIPSE': {
        let sweep = e.end - e.start;
        while (sweep <= 0) sweep += Math.PI * 2;
        if (sweep > Math.PI * 2) sweep = Math.PI * 2;
        const full = Math.abs(sweep - Math.PI * 2) < 1e-9;
        // 短軸は、押し出しの向きと長軸の外積の向き
        const [vx, vy] = minorAxis(e.normal, e.mx, e.my, e.mz);
        const conic: Conic = {
          cx: e.x, cy: e.y, ux: e.mx, uy: e.my, vx: vx * e.ratio, vy: vy * e.ratio, start: e.start, sweep,
        };
        start(full ? KIND.circle : KIND.arc);
        const r = emitConic(b, conic, t, color, layer, !full, true);
        b.end(r.major, r.length, r.minor);
        break;
      }
      case 'POLYLINE': {
        start(KIND.polyline);
        const length = emitPolyline(b, e.xy, e.bulge, e.closed, t, color, layer);
        b.end(length, length);
        break;
      }
      case 'TEXT': {
        const p = placeText(e);
        if (!p) break;
        const ent = start(KIND.text, 0);
        const index = emitTextItem(b, e.text, p.x, p.y, p.width, p.height, p.rotation, t, color, layer, ent);
        b.entText.data[ent] = index;
        if (dim && dim.text < 0) dim.text = index;
        b.end(index >= 0 ? b.texts[index].height : 0);
        break;
      }
      case 'MTEXT': {
        const items = layoutMtext(e);
        if (!items.length) break;
        const ent = start(KIND.text, 0);
        let first = -1;
        for (const it of items) {
          const index = emitTextItem(b, it.text, it.x, it.y, it.width, it.height, e.rotation, t, color, layer, ent);
          if (first < 0) first = index;
        }
        b.entText.data[ent] = first;
        if (dim && dim.text < 0) dim.text = first;
        b.end(first >= 0 ? b.texts[first].height : 0);
        break;
      }
      case 'SOLID': {
        start(KIND.solid, 0);
        emitFill(b, e.pts, t, color, layer);
        b.end();
        break;
      }
      case '3DFACE': {
        start(KIND.polyline);
        let length = 0;
        for (let k = 0; k < 4; k++) {
          if (e.hidden & (1 << k)) continue;
          const m = (k + 1) % 4;
          const [x1, y1] = apply(t, e.pts[k * 2], e.pts[k * 2 + 1]);
          const [x2, y2] = apply(t, e.pts[m * 2], e.pts[m * 2 + 1]);
          if (x1 === x2 && y1 === y2) continue;
          b.addSegment(x1, y1, x2, y2, color, layer, true);
          length += Math.hypot(x2 - x1, y2 - y1);
        }
        b.end(length, length);
        break;
      }
      case 'SPLINE': {
        const pts = e.ctrl.length >= 4
          ? splinePoints(e.degree, e.ctrl, e.knots, e.weights, tol)
          : fitPoints(e.fit, e.closed);
        if (pts.length < 4) break;
        start(KIND.spline);
        const length = emitPath(pts, t, color, layer, !e.closed);
        b.end(length, length);
        break;
      }
      case 'LEADER': {
        const pts = e.spline && e.xy.length >= 6 ? fitPoints(e.xy, false) : e.xy;
        start(KIND.polyline);
        const length = emitPath(pts, t, color, layer, true);
        if (e.arrow) {
          // 矢印は始めの点に、始めの辺の向きで（寸法の矢印の大きさ）
          const ux = e.xy[0] - e.xy[2], uy = e.xy[1] - e.xy[3];
          const l = Math.hypot(ux, uy);
          if (l > arrowSize) {
            const dx = ux / l, dy = uy / l;
            const bx = e.xy[0] - dx * arrowSize, by = e.xy[1] - dy * arrowSize;
            const w = arrowSize / 6;
            emitFill(b, [e.xy[0], e.xy[1], bx - dy * w, by + dx * w, bx + dy * w, by - dx * w], t, color, layer);
          }
        }
        b.end(length, length);
        break;
      }
      case 'XLINE':
      case 'RAY': {
        if (!clip) break;
        const [px, py] = apply(t, e.x, e.y);
        const [qx, qy] = apply(t, e.x + e.dx, e.y + e.dy);
        const seg = clipLine(px, py, qx - px, qy - py, e.type === 'RAY', clip);
        if (!seg) break;
        start(KIND.line);
        // 切った端は図形の端ではないので、端点にしない（RAY の始点だけは本当の端）
        const startFlag = e.type === 'RAY' && seg[4] === 0 ? SNAP_FLAG.start : 0;
        b.addSegment(seg[0], seg[1], seg[2], seg[3], color, layer, SNAP_FLAG.on | startFlag);
        b.end(Math.hypot(seg[2] - seg[0], seg[3] - seg[1]));
        break;
      }
      case 'HATCH': {
        emitHatch(e, t, color, layer, start);
        break;
      }
    }
  };

  /** 点列を折れ線として積む。ends が true なら両端を端点にする。長さを返す */
  const emitPath = (pts: ArrayLike<number>, t: Xform, color: number, layer: number, ends: boolean): number => {
    const n = pts.length >> 1;
    let length = 0;
    let [px, py] = apply(t, pts[0], pts[1]);
    for (let i = 1; i < n; i++) {
      const [x, y] = apply(t, pts[i * 2], pts[i * 2 + 1]);
      const snap = SNAP_FLAG.on | (ends && i === 1 ? SNAP_FLAG.start : 0) | (ends && i === n - 1 ? SNAP_FLAG.end : 0);
      b.addSegment(px, py, x, y, color, layer, snap);
      length += Math.hypot(x - px, y - py) || 0;
      px = x; py = y;
    }
    return length;
  };

  /** HATCH。塗りは穴を抜いて三角形に、模様は線（吸着しない）に。entities.size は塗った面積 */
  const emitHatch = (e: DxfHatch, t: Xform, color: number, layer: number, start: (kind: number, st?: number) => number): void => {
    const rings = e.loops.map((l) => loopRing(l, b, tol)).filter((r) => r.length >= 6);
    if (!rings.length) return;
    start(KIND.hatch, 0);
    let area = 0;
    if (e.solid) {
      area = emitRings(b, rings, t, color, layer);
    } else if (e.pattern.length) {
      const left = MAX_PATTERN_SEGMENTS - patternSegments;
      if (left <= 0) {
        patternCut = true;
      } else {
        const { segs, cut } = hatchSegments(rings, e.pattern, left);
        if (cut) patternCut = true;
        patternSegments += segs.length / 4;
        for (let i = 0; i < segs.length; i += 4) {
          const [x1, y1] = apply(t, segs[i], segs[i + 1]);
          const [x2, y2] = apply(t, segs[i + 2], segs[i + 3]);
          b.addSegment(x1, y1, x2, y2, color, layer, false);
        }
      }
    }
    b.end(area);
  };

  emitList(doc.entities, {
    t: base, layer: null, color: { pen: 7, rgb: -1 }, ltype: 'CONTINUOUS', block: -1, depth: 0, dim: null,
  }, new Set());
  if (b.truncated) warnings.push(TRUNCATED_WARNING);
  if (missing.size) warnings.push(`見つからない部品があります（${missing.size} 種類）`);
  if (gridCut) warnings.push(`MINSERT の繰り返しが多すぎるため、${MAX_GRID} 個までにしました`);
  if (patternCut) warnings.push('ハッチングの模様の線が多すぎるため、一部を省きました');
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
    dimensions,
    warnings,
  };
}

/** 点 (x, y) が線分の延長の上にあるか（線分の長さに対して十分近いか） */
function onLine(e: { x1: number; y1: number; x2: number; y2: number }, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return false;
  return Math.abs((x - e.x1) * dy - (y - e.y1) * dx) / len <= len * 1e-6 + 1e-9;
}

/**
 * 直線（ray なら半直線）を矩形で切る。[x1, y1, x2, y2, 始まりの媒介変数] を返す（矩形と交わらなければ null）。
 * 点は (px, py) + s·(dx, dy)
 */
function clipLine(
  px: number, py: number, dx: number, dy: number, ray: boolean,
  r: { minX: number; minY: number; maxX: number; maxY: number },
): [number, number, number, number, number] | null {
  if (!(Math.hypot(dx, dy) > 0) || !Number.isFinite(px + py + dx + dy)) return null;
  let lo = ray ? 0 : -Infinity, hi = Infinity;
  const axis = (p: number, d: number, min: number, max: number): boolean => {
    if (Math.abs(d) < 1e-300) return p >= min && p <= max;
    let a = (min - p) / d, c = (max - p) / d;
    if (a > c) [a, c] = [c, a];
    lo = Math.max(lo, a); hi = Math.min(hi, c);
    return true;
  };
  if (!axis(px, dx, r.minX, r.maxX) || !axis(py, dy, r.minY, r.maxY) || !(hi > lo)) return null;
  return [px + dx * lo, py + dy * lo, px + dx * hi, py + dy * hi, lo];
}

/** HATCH の境界の 1 周を点列 [x, y, ...] にする（OCS のまま） */
function loopRing(loop: HatchLoop, b: Builder, tol: number): number[] {
  const out: number[] = [];
  const push = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const n = out.length;
    if (n >= 2 && Math.abs(out[n - 2] - x) <= 1e-12 * (1 + Math.abs(x)) && Math.abs(out[n - 1] - y) <= 1e-12 * (1 + Math.abs(y))) return;
    out.push(x, y);
  };
  const conic = (cx: number, cy: number, ux: number, uy: number, vx: number, vy: number, from: number, sweep: number): void => {
    const n = b.arcSegments(Math.max(Math.hypot(ux, uy), Math.hypot(vx, vy)), sweep);
    for (let i = 0; i <= n; i++) {
      const th = from + (sweep * i) / n;
      push(cx + ux * Math.cos(th) + vx * Math.sin(th), cy + uy * Math.cos(th) + vy * Math.sin(th));
    }
  };
  /** 角度（度）の区間を、向きに合わせた開始角と円弧角（ラジアン）に。時計回りの辺の角度は x 軸で裏返して持っている */
  const span = (s: number, e: number, ccw: boolean): [number, number] => {
    const deg = (((e - s) % 360) + 360) % 360 || 360;
    return ccw ? [(s * Math.PI) / 180, (deg * Math.PI) / 180] : [(-s * Math.PI) / 180, (-deg * Math.PI) / 180];
  };
  if (loop.poly) {
    const { xy, bulge } = loop.poly;
    const n = xy.length >> 1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      push(xy[i * 2], xy[i * 2 + 1]);
      const arc = bulgeArc(xy[i * 2], xy[i * 2 + 1], xy[j * 2], xy[j * 2 + 1], bulge[i] ?? 0);
      if (arc) conic(arc.cx, arc.cy, arc.ux, arc.uy, arc.vx, arc.vy, arc.start, arc.sweep);
    }
  }
  for (const e of loop.edges ?? []) {
    switch (e.kind) {
      case 'line': push(e.x1, e.y1); push(e.x2, e.y2); break;
      case 'arc': {
        const [s, w] = span(e.start, e.end, e.ccw);
        conic(e.cx, e.cy, e.r, 0, 0, e.r, s, w);
        break;
      }
      case 'ellipse': {
        const [s, w] = span(e.start, e.end, e.ccw);
        conic(e.cx, e.cy, e.mx, e.my, -e.my * e.ratio, e.mx * e.ratio, s, w);
        break;
      }
      case 'spline': {
        const pts = e.ctrl.length >= 4 ? splinePoints(e.degree, e.ctrl, e.knots, e.weights, tol) : fitPoints(e.fit, false);
        for (let i = 0; i + 1 < pts.length; i += 2) push(pts[i], pts[i + 1]);
        break;
      }
    }
  }
  // 閉じた点（最初と同じ点）は外す
  const n = out.length;
  if (n >= 4 && out[0] === out[n - 2] && out[1] === out[n - 1]) out.length = n - 2;
  return out;
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

/**
 * TEXT の左下の位置・長さ・高さ・角度。寄せ（72/73）があれば 2 つ目の点（11/21）を基準にする。
 * 両端揃え（3）は 2 点の間に収まるよう高さも変え、フィット（5）は長さだけ合わせる。
 * 縦の「下」（1）は基線（0）と同じに扱う
 */
function placeText(e: DxfText): { x: number; y: number; width: number; height: number; rotation: number } | null {
  if (!e.text || !(e.height > 0)) return null;
  const wf = e.widthFactor > 0 ? e.widthFactor : 1;
  let height = e.height;
  let rotation = e.rotation;
  let width = textWidth(e.text, height) * wf;
  const aligned = (e.halign !== 0 || e.valign !== 0) && Number.isFinite(e.x2) && Number.isFinite(e.y2);
  if (!aligned) return { x: e.x, y: e.y, width, height, rotation };
  if (e.halign === 3 || e.halign === 5) {
    const dx = e.x2 - e.x, dy = e.y2 - e.y;
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      rotation = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (e.halign === 3 && width > 0) height *= len / width;
      width = len;
    }
    return { x: e.x, y: e.y, width, height, rotation };
  }
  const fx = e.halign === 1 || e.halign === 4 ? 0.5 : e.halign === 2 ? 1 : 0;
  const fy = e.halign === 4 ? 0.5 : e.valign === 2 ? 0.5 : e.valign === 3 ? 1 : 0;
  const a = (rotation * Math.PI) / 180;
  const ox = -fx * width, oy = -fy * height;
  return {
    x: e.x2 + Math.cos(a) * ox - Math.sin(a) * oy,
    y: e.y2 + Math.sin(a) * ox + Math.cos(a) * oy,
    width, height, rotation,
  };
}

/**
 * MTEXT を行ごとの文字に並べる（左下の位置は図形の元の座標）。
 * 基点（71）の 1〜3 は上、4〜6 は中、7〜9 は下、左・中・右の順。幅（41）があれば文字の見積もりで折り返す
 */
export function layoutMtext(e: DxfMText): { text: string; x: number; y: number; width: number; height: number }[] {
  if (!(e.height > 0)) return [];
  const rows: { text: string; height: number; width: number }[] = [];
  for (const line of e.lines) {
    const h = line.height > 0 ? line.height : e.height;
    for (const text of wrap(line.text, h, e.width)) rows.push({ text, height: h, width: textWidth(text, h) });
  }
  if (!rows.some((r) => r.text)) return [];
  const spacing = e.spacing > 0 ? e.spacing : 1;
  // 1 行目の上端を 0 として、各行の基線の高さ
  const base: number[] = [];
  let y = -rows[0].height;
  rows.forEach((r, i) => {
    if (i > 0) y -= r.height * MTEXT_LINE * spacing;
    base.push(y);
  });
  const total = -y;
  const attach = e.attach >= 1 && e.attach <= 9 ? e.attach : 1;
  const row = Math.floor((attach - 1) / 3), col = (attach - 1) % 3;
  const shift = row === 0 ? 0 : row === 1 ? total / 2 : total;
  const a = (e.rotation * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const out: { text: string; x: number; y: number; width: number; height: number }[] = [];
  rows.forEach((r, i) => {
    if (!r.text) return;
    const ox = col === 0 ? 0 : col === 1 ? -r.width / 2 : -r.width;
    const oy = base[i] + shift;
    out.push({ text: r.text, x: e.x + cos * ox - sin * oy, y: e.y + sin * ox + cos * oy, width: r.width, height: r.height });
  });
  return out;
}

/** 見積もりの長さが width を超える行を折り返す（空白で切れればそこで、なければ字の間で） */
function wrap(text: string, height: number, width: number): string[] {
  if (!(width > 0) || textWidth(text, height) <= width * 1.001) return [text];
  const out: string[] = [];
  let rest = Array.from(text);
  while (rest.length) {
    let w = 0, k = 0;
    while (k < rest.length) {
      const c = rest[k].codePointAt(0) ?? 0;
      const cw = (c < 0x100 || (c >= 0xff61 && c <= 0xff9f) ? 0.5 : 1) * height;
      if (k > 0 && w + cw > width * 1.001) break;
      w += cw;
      k++;
    }
    if (k < rest.length) {
      const space = rest.lastIndexOf(' ', k);
      if (space > 0) k = space + 1;
    }
    out.push(rest.slice(0, k).join('').trimEnd());
    rest = rest.slice(k);
    while (rest[0] === ' ') rest.shift();
  }
  return out;
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
  const addAll = (xy: ArrayLike<number>): void => { for (let i = 0; i + 1 < xy.length; i += 2) add(xy[i], xy[i + 1]); };
  for (const e of doc.entities) {
    switch (e.type) {
      case 'LINE': add(e.x1, e.y1); add(e.x2, e.y2); break;
      case 'POLYLINE': case 'LEADER': addAll(e.xy); break;
      case 'SOLID': case '3DFACE': add(e.pts[0], e.pts[1]); break;
      case 'SPLINE': addAll(e.ctrl.length ? e.ctrl : e.fit); break;
      case 'HATCH':
        for (const l of e.loops) {
          if (l.poly) addAll(l.poly.xy);
          for (const g of l.edges ?? []) {
            if (g.kind === 'line') { add(g.x1, g.y1); add(g.x2, g.y2); }
            else if (g.kind === 'spline') addAll(g.ctrl);
            else add(g.cx, g.cy);
          }
        }
        break;
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
