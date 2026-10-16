/**
 * SXF の文書（SFC・P21 共通）を Scene に書き出す。
 * 座標は用紙の mm。部分図（複合図形の種類 1・2）は配置の変換で用紙に写し、部分図ごとに縮尺の枠を 1 つ持つ
 * （枠 0 は用紙で 1/1、部分図の枠の縮尺は 1 / 配置の倍率）。作図グループ・作図部品（3・4）は入っている
 * 枠のまま。レイヤはレイヤコード k を 0〜255 の k − 1 に。レイヤは受け継がない（中の図形が自分のレイヤを持つ）
 */
import {
  ARC_TOLERANCE, Builder, IDENTITY, KIND, MAX_EXPANSIONS, Palette, SNAP_FLAG, TRUNCATED_WARNING, apply, compose,
  finishScene, type Bounds, type Scene, type Xform,
} from '../render/builder.ts';
import {
  emitConic, emitRings, emitTextItem, fitPoints, hatchSegments, ringArea, splinePoints, type Conic, type PatternFamily,
} from '../render/prim.ts';
import { DXF_STYLE_SLOTS, dashPattern } from '../dxf/ltype.ts';
import { SXF_COLORS, SXF_LINE_TYPES, USER_COLOR_BASE, USER_LINE_TYPE_BASE } from './colors.ts';
import type {
  SxfArrow, SxfCompositeCurve, SxfDocument, SxfFeature, SxfStyle, SxfText,
} from './types.ts';

/** 複合図形の入れ子の深さの上限（OCF の実装規約は 10 階層） */
const MAX_DEPTH = 16;
/** ハッチングの模様の線の上限（図面全体） */
const MAX_PATTERN_SEGMENTS = 200_000;
/** 矢印の長さ（倍率 1 のとき。図形の座標）。仕様の本文で確かめられなかった値（未確認） */
const ARROW_SIZE = 3;
/** 用紙の大きさ（A0〜A4 の横の長さ × 縦の長さ、mm。横向き） */
const PAPER_MM: Record<number, [number, number]> = {
  0: [1189, 841], 1: [841, 594], 2: [594, 420], 3: [420, 297], 4: [297, 210],
};

export interface SxfSceneResult {
  scene: Scene;
  /** レイヤ番号（0〜255）ごとの名前と状態（0 は元の図面で非表示、2 は表示） */
  layers: { name: string; state: number }[];
  /** 線種番号ごとの名前 */
  lineTypeNames: string[];
  /** 縮尺の枠（0 は用紙、1 から部分図） */
  slots: { no: number; label: string; scale: number; used: boolean }[];
  /** 用紙の呼び名（A1 横、自由 700 × 400 mm など） */
  paperLabel: string;
  counts: Record<string, number>;
  /** 寸法ごとの寸法値の文字・寸法線の長さ（図形の座標）・縮尺の枠（確かめるため） */
  dimensions: { kind: string; text: string; length: number; slot: number }[];
  warnings: string[];
}

/** 色コードを線色番号に。範囲の外は白（8） */
function penOf(code: number, doc: SxfDocument): number {
  if (code >= 1 && code <= 16) return code;
  if (code >= USER_COLOR_BASE && code - USER_COLOR_BASE < doc.userColors.length) return code;
  return 8;
}

export function buildSxfScene(doc: SxfDocument): SxfSceneResult {
  const warnings = [...doc.warnings];
  const counts: Record<string, number> = {};
  const dimensions: SxfSceneResult['dimensions'] = [];

  // レイヤ。コード 0（指定なし）や表にないコードの図形は「（レイヤなし）」に
  const layers = doc.layers.slice(0, 256).map((l) => ({ name: l.name, state: l.visible ? 2 : 0 }));
  let noLayer = -1;
  const layerOf = (code: number): number => {
    if (code >= 1 && code <= layers.length) return code - 1;
    if (noLayer < 0) {
      noLayer = Math.min(255, layers.length);
      if (noLayer === layers.length) layers.push({ name: '（レイヤなし）', state: 2 });
    }
    return noLayer;
  };

  // 線種。使われたものから順に番号を振る（実線は 0）
  const dashes = new Uint32Array(64 * 2);
  const lineTypeNames: string[] = ['実線'];
  const styleByCode = new Map<number, number>();
  let nextSlot = 0;
  const styleOf = (code: number): number => {
    const hit = styleByCode.get(code);
    if (hit !== undefined) return hit;
    let name = '';
    let pitch: number[] = [];
    if (code >= 1 && code <= 15) {
      name = SXF_LINE_TYPES[code - 1].ja;
      pitch = SXF_LINE_TYPES[code - 1].pitch;
    } else if (code >= USER_LINE_TYPE_BASE) {
      // 利用者定義は 16 から（合わなければ 17 から数える実装に合わせる）
      const u = doc.userLineTypes[code - USER_LINE_TYPE_BASE] ?? doc.userLineTypes[code - USER_LINE_TYPE_BASE - 1];
      if (u) { name = u.name; pitch = u.pitch; }
    }
    let style = 0;
    const pat = pitch.length ? dashPattern({ name, pattern: pitch } as never) : null;
    if (pat && nextSlot < DXF_STYLE_SLOTS.length) {
      style = DXF_STYLE_SLOTS[nextSlot++];
      dashes[style * 2] = pat[0];
      dashes[style * 2 + 1] = pat[1];
      lineTypeNames[style] = name;
    }
    styleByCode.set(code, style);
    return style;
  };

  const b = new Builder(new Palette({
    base: (pen) => (pen >= 1 && pen <= 16
      ? SXF_COLORS[pen - 1].rgb
      : doc.userColors[pen - USER_COLOR_BASE] ?? [255, 255, 255]),
    label: (pen) => {
      if (pen >= 1 && pen <= 16) return SXF_COLORS[pen - 1].ja;
      const c = doc.userColors[pen - USER_COLOR_BASE];
      return c ? `利用者定義色 ${pen}（${c.join(', ')}）` : `色 ${pen}`;
    },
  }), { arcTolerance: ARC_TOLERANCE, pointRadius: () => 0 });

  // 縮尺の枠
  const slots: SxfSceneResult['slots'] = [{ no: 0, label: '用紙', scale: 1, used: false }];
  let slotCut = false;

  let patternSegments = 0;
  let patternCut = false;
  const missing = new Set<string>();
  let tiles = 0;
  let symbols = 0;

  interface Ctx { t: Xform; slot: number; block: number; depth: number }

  const count = (k: string): void => { counts[k] = (counts[k] ?? 0) + 1; };

  /** 線の図形を書き始める */
  const begin = (kind: number, s: SxfStyle, ctx: Ctx, styled = true): { color: number; layer: number; ent: number } => {
    const pen = penOf(s.color, doc);
    const color = b.palette.entry(pen);
    const layer = layerOf(s.layer);
    const ent = b.begin(kind, pen, styled ? styleOf(s.ltype) : 0, layer, color, ctx.block, -1, ctx.slot);
    slots[ctx.slot].used = true;
    return { color, layer, ent };
  };

  /** 点列を折れ線として積む。ends が true なら両端を端点に、vertices が true なら途中の頂点も端点に。長さを返す */
  const emitPath = (pts: ArrayLike<number>, t: Xform, color: number, layer: number, ends: boolean, vertices: boolean, closed = false): number => {
    const n = pts.length >> 1;
    if (n < 2) return 0;
    let length = 0;
    const m = closed ? n + 1 : n;
    let [px, py] = apply(t, pts[0], pts[1]);
    for (let i = 1; i < m; i++) {
      const k = i % n;
      const [x, y] = apply(t, pts[k * 2], pts[k * 2 + 1]);
      const snap = vertices
        ? (SNAP_FLAG.on | SNAP_FLAG.start | SNAP_FLAG.end | SNAP_FLAG.mid)
        : SNAP_FLAG.on | (ends && i === 1 ? SNAP_FLAG.start : 0) | (ends && i === m - 1 ? SNAP_FLAG.end : 0);
      b.addSegment(px, py, x, y, color, layer, snap);
      length += Math.hypot(x - px, y - py) || 0;
      px = x; py = y;
    }
    return length;
  };

  /** 円弧の式（左回りにそろえる）。dir 1 は右回り。角度は度 */
  const arcConic = (x: number, y: number, rx: number, ry: number, rot: number, dir: number, s: number, e: number): Conic => {
    const r = (rot * Math.PI) / 180;
    const cos = Math.cos(r), sin = Math.sin(r);
    let from = dir === 1 ? e : s;
    const to = dir === 1 ? s : e;
    let deg = (((to - from) % 360) + 360) % 360;
    if (deg < 1e-9) deg = 360;
    from = (from * Math.PI) / 180;
    return { cx: x, cy: y, ux: rx * cos, uy: rx * sin, vx: -ry * sin, vy: ry * cos, start: from, sweep: (deg * Math.PI) / 180 };
  };

  /** 円弧・楕円弧の点列（図形の座標） */
  const conicPoints = (c: Conic, reverse: boolean): number[] => {
    const n = b.arcSegments(Math.max(Math.hypot(c.ux, c.uy), Math.hypot(c.vx, c.vy)), c.sweep);
    const out: number[] = [];
    for (let i = 0; i <= n; i++) {
      const th = c.start + (c.sweep * (reverse ? n - i : i)) / n;
      out.push(c.cx + c.ux * Math.cos(th) + c.vx * Math.sin(th), c.cy + c.uy * Math.cos(th) + c.vy * Math.sin(th));
    }
    return out;
  };

  /** クロソイドの点列（図形の座標）。原点から長さ l0〜l1 の区間 */
  const clothoidPoints = (f: Extract<SxfFeature, { t: 'clothoid' }>): number[] => {
    const a = Math.abs(f.a);
    const l0 = Math.max(0, Math.min(f.l0, f.l1)), l1 = Math.max(f.l0, f.l1);
    if (!(a > 0) || !(l1 > l0) || !Number.isFinite(a + l0 + l1)) return [];
    const sign = f.dir === 1 ? -1 : 1;
    const rot = (f.angle * Math.PI) / 180;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    // 細かく積分して、長さ 0.5 % ごとくらいに点を拾う
    const steps = Math.min(20000, Math.max(64, Math.ceil((l1 / a) * 400)));
    const ds = l1 / steps;
    const out: number[] = [];
    let x = 0, y = 0;
    const pick = Math.max(1, Math.floor(steps / 512));
    for (let i = 0; i <= steps; i++) {
      const s = i * ds;
      if (s >= l0 - ds / 2 && (i % pick === 0 || i === steps)) {
        out.push(f.x + cos * x - sin * y, f.y + sin * x + cos * y);
      }
      const mid = s + ds / 2;
      const th = (sign * mid * mid) / (2 * a * a);
      x += Math.cos(th) * ds;
      y += Math.sin(th) * ds;
    }
    return out;
  };

  /** 複合曲線の部材の点列（図形の座標） */
  const memberPoints = (f: SxfFeature): number[] => {
    switch (f.t) {
      case 'line': return [f.x1, f.y1, f.x2, f.y2];
      case 'polyline': return f.xy;
      case 'arc': return conicPoints(arcConic(f.x, f.y, f.r, f.r, 0, f.dir, f.start, f.end), f.dir === 1);
      case 'ellipseArc': return conicPoints(arcConic(f.x, f.y, f.rx, f.ry, f.rot, f.dir, f.start, f.end), f.dir === 1);
      case 'circle': return conicPoints(arcConic(f.x, f.y, f.r, f.r, 0, 0, 0, 360), false);
      case 'ellipse': return conicPoints(arcConic(f.x, f.y, f.rx, f.ry, f.rot, 0, 0, 360), false);
      case 'spline': return fitPoints(f.xy, f.closed);
      case 'bspline': return splinePoints(f.degree, f.ctrl, f.knots, f.weights, ARC_TOLERANCE);
      case 'clothoid': return clothoidPoints(f);
      default: return [];
    }
  };

  /** 複合曲線を 1 周の点列に（部材の向きがそろっていなければ裏返してつなぐ） */
  const curveRing = (c: SxfCompositeCurve): number[] => {
    const out: number[] = [];
    const near = (x1: number, y1: number, x2: number, y2: number): boolean =>
      Math.abs(x1 - x2) <= 1e-6 * (1 + Math.abs(x1)) && Math.abs(y1 - y2) <= 1e-6 * (1 + Math.abs(y1));
    for (const m of c.members) {
      let p = memberPoints(m);
      if (p.length < 2) continue;
      if (out.length >= 2) {
        const lx = out[out.length - 2], ly = out[out.length - 1];
        const n = p.length;
        if (!near(lx, ly, p[0], p[1]) && near(lx, ly, p[n - 2], p[n - 1])) {
          const r: number[] = [];
          for (let i = n - 2; i >= 0; i -= 2) r.push(p[i], p[i + 1]);
          p = r;
        }
        if (near(lx, ly, p[0], p[1])) p = p.slice(2);
      }
      for (const v of p) out.push(v);
    }
    const n = out.length;
    if (n >= 4 && near(out[0], out[1], out[n - 2], out[n - 1])) out.length = n - 2;
    return out.filter(Number.isFinite).length === out.length ? out : [];
  };

  /** 文字。b_pnt で寄せ、縦書きは 1 字ずつ上から下へ並べる */
  const emitText = (tx: SxfText, s: SxfStyle, ctx: Ctx, kind: number): { ent: number; index: number } => {
    const { color, layer, ent } = begin(kind, s, ctx, false);
    let index = -1;
    const h = tx.height;
    if (tx.text && h > 0 && Number.isFinite(h)) {
      const col = ((tx.bpnt - 1) % 3 + 3) % 3;
      const row = Math.min(2, Math.max(0, Math.floor((tx.bpnt - 1) / 3)));
      const fx = col / 2, fy = row / 2;
      const a = (tx.angle * Math.PI) / 180;
      const cos = Math.cos(a), sin = Math.sin(a);
      const at = (u: number, v: number): [number, number] => [tx.x + cos * u - sin * v, tx.y + sin * u + cos * v];
      const vertical = tx.direction === 2 || (doc.fonts[tx.font - 1] ?? '').startsWith('@');
      const chars = Array.from(tx.text);
      if (!vertical) {
        const w = tx.width > 0 && Number.isFinite(tx.width) ? tx.width : textWidth(tx.text, h);
        const [x0, y0] = at(-fx * w, -fy * h);
        index = emitTextItem(b, tx.text, x0, y0, w, h, tx.angle, ctx.t, color, layer, ent);
      } else {
        // 縦書き：幅 h の列を、長さ L の上から下へ。基点は列の箱（横 h × 縦 L）で寄せる
        const L = tx.width > 0 && Number.isFinite(tx.width) ? tx.width : chars.length * h;
        const pitch = L / chars.length;
        chars.forEach((ch, i) => {
          const cw = textWidth(ch, Math.min(h, pitch));
          const u = -fx * h + (h - cw) / 2;
          const v = -fy * L + L - (i + 1) * pitch;
          const [x0, y0] = at(u, v);
          const k = emitTextItem(b, ch, x0, y0, cw, Math.min(h, pitch), tx.angle, ctx.t, color, layer, ent);
          if (index < 0) index = k;
        });
      }
    }
    b.entText.data[ent] = index;
    b.end(index >= 0 ? b.texts[index].height : 0);
    return { ent, index };
  };

  /** 矢印（開いた矢じりの 2 本の線。吸着しない）。大きさは倍率 × ARROW_SIZE、用紙の上で 0.5〜10 mm に収まらなければ 2.5 mm */
  const emitArrow = (ar: SxfArrow, t: Xform, color: number, layer: number): void => {
    const [tx, ty] = apply(t, ar.x, ar.y);
    const [ex, ey] = apply(t, ar.x - ar.ux, ar.y - ar.uy);
    const ux = tx - ex, uy = ty - ey;
    const l = Math.hypot(ux, uy);
    if (!(l > 0)) return;
    const dx = ux / l, dy = uy / l;
    let size = (ar.scale > 0 ? ar.scale : 1) * ARROW_SIZE * l;
    if (!(size >= 0.5 && size <= 10)) size = 2.5;
    const w = size * 0.3;
    const bx = tx - dx * size, by = ty - dy * size;
    b.addSegment(tx, ty, bx - dy * w, by + dx * w, color, layer, false);
    b.addSegment(tx, ty, bx + dy * w, by - dx * w, color, layer, false);
  };

  const emitList = (list: SxfFeature[], ctx: Ctx, open: Set<string>): void => {
    if (b.truncated) return;
    if (++b.expanded > MAX_EXPANSIONS) { b.truncated = true; return; }
    for (const f of list) {
      if (b.truncated) return;
      emitFeature(f, ctx, open);
    }
  };

  const emitFeature = (f: SxfFeature, ctx: Ctx, open: Set<string>): void => {
    const t = ctx.t;
    switch (f.t) {
      case 'line': {
        count('line');
        const { color, layer } = begin(KIND.line, f.s, ctx);
        const [x1, y1] = apply(t, f.x1, f.y1);
        const [x2, y2] = apply(t, f.x2, f.y2);
        b.addSegment(x1, y1, x2, y2, color, layer, true);
        b.end(Math.hypot(x2 - x1, y2 - y1));
        break;
      }
      case 'polyline': {
        count('polyline');
        const { color, layer } = begin(KIND.polyline, f.s, ctx);
        const length = emitPath(f.xy, t, color, layer, true, true);
        b.end(length, length);
        break;
      }
      case 'circle':
      case 'ellipse': {
        count(f.t);
        const c = f.t === 'circle' ? arcConic(f.x, f.y, f.r, f.r, 0, 0, 0, 360) : arcConic(f.x, f.y, f.rx, f.ry, f.rot, 0, 0, 360);
        const { color, layer } = begin(KIND.circle, f.s, ctx);
        const r = emitConic(b, c, t, color, layer, false, true);
        b.end(r.major, r.length, r.minor);
        break;
      }
      case 'arc':
      case 'ellipseArc': {
        count(f.t);
        const c = f.t === 'arc'
          ? arcConic(f.x, f.y, f.r, f.r, 0, f.dir, f.start, f.end)
          : arcConic(f.x, f.y, f.rx, f.ry, f.rot, f.dir, f.start, f.end);
        const { color, layer } = begin(KIND.arc, f.s, ctx);
        const r = emitConic(b, c, t, color, layer, true, true);
        b.end(r.major, r.length, r.minor);
        break;
      }
      case 'spline':
      case 'bspline':
      case 'clothoid': {
        count(f.t === 'bspline' ? 'spline' : f.t);
        const pts = memberPoints(f);
        if (pts.length < 4) break;
        const { color, layer } = begin(KIND.spline, f.s, ctx);
        const length = emitPath(pts, t, color, layer, f.t !== 'spline' || !f.closed, false);
        b.end(length, length);
        break;
      }
      case 'point':
      case 'symbol': {
        count(f.t);
        if (f.t === 'symbol') symbols++;
        const { color, layer } = begin(KIND.point, f.s, ctx, false);
        const [x, y] = apply(t, f.x, f.y);
        b.addPoint(x, y, layer, color);
        b.addDot(x, y, 0, color, layer);
        b.track(x, y);
        b.end();
        break;
      }
      case 'text': {
        count('text');
        emitText(f.text, f.s, ctx, KIND.text);
        break;
      }
      case 'locate': {
        count('locate');
        const fig = doc.figures.get(f.name);
        if (!fig) { missing.add(f.name); break; }
        if (ctx.depth >= MAX_DEPTH || open.has(f.name)) break;
        const r = (f.angle * Math.PI) / 180;
        const cos = Math.cos(r), sin = Math.sin(r);
        const rx = Number.isFinite(f.rx) && f.rx !== 0 ? f.rx : 1;
        const ry = Number.isFinite(f.ry) && f.ry !== 0 ? f.ry : rx;
        const local: Xform = { a: rx * cos, b: rx * sin, c: -ry * sin, d: ry * cos, e: f.x, f: f.y };
        if (!Object.values(local).every(Number.isFinite)) break;
        let slot = ctx.slot;
        let block = ctx.block;
        if (fig.kind === 1 || fig.kind === 2) {
          // 部分図は縮尺の枠を 1 つ持つ（縮尺 = 1 / 倍率）
          if (slots.length < 256) {
            slot = slots.length;
            const k = Math.sqrt(Math.abs(rx * ry));
            slots.push({ no: slot, label: fig.name || `部分図 ${slot}`, scale: k > 0 ? 1 / k : 1, used: false });
          } else {
            slot = 255;
            slotCut = true;
          }
          block = -1;
        } else {
          block = b.blockOf(f.name, () => f.name);
        }
        open.add(f.name);
        emitList(fig.features, { t: compose(local, t), slot, block, depth: ctx.depth + 1 }, open);
        open.delete(f.name);
        break;
      }
      case 'dim': {
        count(f.kind === 'label' || f.kind === 'balloon' ? f.kind : 'dim');
        emitDim(f, ctx);
        break;
      }
      case 'hatch': {
        count(`hatch:${f.kind}`);
        emitHatch(f, ctx);
        break;
      }
    }
  };

  /** 寸法・引出し線・バルーン。寸法線は KIND.dim、補助線は dimAux、寸法値は dimText にして entText でつなぐ */
  const emitDim = (f: Extract<SxfFeature, { t: 'dim' }>, ctx: Ctx): void => {
    const t = ctx.t;
    const leader = f.kind === 'label' || f.kind === 'balloon';
    const members: number[] = [];
    const { color, layer, ent } = begin(leader ? KIND.polyline : KIND.dim, f.s, ctx);
    members.push(ent);
    let length = 0;
    let localLength = NaN;
    if (f.line && f.line.length >= 4) {
      length = emitPath(f.line, t, color, layer, true, leader);
      localLength = 0;
      for (let i = 2; i + 1 < f.line.length; i += 2) localLength += Math.hypot(f.line[i] - f.line[i - 2], f.line[i + 1] - f.line[i - 1]);
    }
    if (f.arc) {
      const c = arcConic(f.arc.x, f.arc.y, f.arc.r, f.arc.r, 0, 0, f.arc.start, f.arc.end);
      length = emitConic(b, c, t, color, layer, true, true).length;
      localLength = f.kind === 'angular' ? (c.sweep * 180) / Math.PI : Math.abs(f.arc.r * c.sweep);
    }
    if (f.circle) {
      const c = arcConic(f.circle.x, f.circle.y, f.circle.r, f.circle.r, 0, 0, 0, 360);
      emitConic(b, c, t, color, layer, false, true);
    }
    for (const ar of f.arrows) emitArrow(ar, t, color, layer);
    b.end(length, length);
    for (const a of f.aux) {
      const aux = begin(KIND.dimAux, f.s, ctx);
      members.push(aux.ent);
      const [x1, y1] = apply(t, a[0], a[1]);
      const [x2, y2] = apply(t, a[2], a[3]);
      b.addSegment(x1, y1, x2, y2, aux.color, aux.layer, false);
      b.end(Math.hypot(x2 - x1, y2 - y1));
    }
    let text = '';
    if (f.text) {
      const r = emitText(f.text, f.s, ctx, leader ? KIND.text : KIND.dimText);
      if (r.index >= 0) {
        text = b.texts[r.index].text;
        for (const m of members) b.entText.data[m] = r.index;
      }
    }
    if (!leader) dimensions.push({ kind: f.kind, text, length: localLength, slot: ctx.slot });
  };

  /** ハッチング。塗りは穴を抜いて三角形に、模様は線（吸着しない）に。境界は flag が 1 のときだけ線で描く */
  const emitHatch = (f: Extract<SxfFeature, { t: 'hatch' }>, ctx: Ctx): void => {
    const t = ctx.t;
    const curves = [f.outer, ...f.holes];
    // 見える境界
    for (const c of curves) {
      if (!c.visible || !c.members.length) continue;
      const { color, layer } = begin(KIND.polyline, { layer: f.s.layer, color: c.color, ltype: c.ltype, width: c.width }, ctx);
      let length = 0;
      for (const m of c.members) length += emitPath(memberPoints(m), t, color, layer, true, m.t === 'polyline' || m.t === 'line');
      b.end(length, length);
    }
    const rings = curves.map(curveRing).filter((r) => r.length >= 6);
    if (!rings.length) return;
    if (f.kind === 'fill') {
      const { color, layer } = begin(KIND.hatch, f.s, ctx, false);
      const area = emitRings(b, rings, t, color, layer);
      b.end(area);
      return;
    }
    if (f.kind === 'tiles') tiles++;
    if (f.kind !== 'pattern') return;
    let first = true;
    for (const line of f.lines) {
      const a = (line.angle * Math.PI) / 180;
      const fam: PatternFamily = {
        angle: line.angle, x: line.x, y: line.y, dx: -Math.sin(a) * line.spacing, dy: Math.cos(a) * line.spacing, dashes: [],
      };
      const left = MAX_PATTERN_SEGMENTS - patternSegments;
      if (left <= 0) { patternCut = true; break; }
      const { segs, cut } = hatchSegments(rings, [fam], left);
      if (cut) patternCut = true;
      patternSegments += segs.length / 4;
      const { color, layer } = begin(KIND.hatch, { layer: f.s.layer, color: line.color, ltype: line.ltype, width: line.width }, ctx);
      for (let i = 0; i < segs.length; i += 4) {
        const [x1, y1] = apply(t, segs[i], segs[i + 1]);
        const [x2, y2] = apply(t, segs[i + 2], segs[i + 3]);
        b.addSegment(x1, y1, x2, y2, color, layer, false);
      }
      // 面積は最初の族の図形にだけ持たせる（変換後の外周 − 穴）
      b.end(first ? hatchArea(rings, t) : 0);
      first = false;
    }
  };

  emitList(doc.sheetFeatures, { t: IDENTITY, slot: 0, block: -1, depth: 0 }, new Set());

  if (b.truncated) warnings.push(TRUNCATED_WARNING);
  if (missing.size) warnings.push(`見つからない複合図形があります（${missing.size} 種類）`);
  if (slotCut) warnings.push('部分図が多すぎるため、255 個目からは同じ縮尺の枠にまとめました');
  if (patternCut) warnings.push('ハッチングの模様の線が多すぎるため、一部を省きました');
  if (tiles) warnings.push(`タイルのハッチング（${tiles} 個）は模様を描いていません`);
  if (symbols) warnings.push(`外部定義シンボル（${symbols} 個）は位置だけを点で示しています`);
  if (doc.skipped.size) {
    const list = [...doc.skipped].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`);
    warnings.push(`まだ表示できない図形を読み飛ばしました（${list.join('、')}）`);
  }

  const { paper, label } = paperOf(doc);
  // 縮尺は枠の数だけ（古い経路が layer >> 4 で引いても壊れないよう、16 個より短くはしない）
  const scales = new Float64Array(Math.max(16, slots.length)).fill(1);
  slots.forEach((s, i) => { scales[i] = s.scale; });
  const scene = finishScene(b, { paper, dashes, scales });
  return { scene, layers, lineTypeNames, slots, paperLabel: label, counts, dimensions, warnings };
}

/** 変換後の外周 − 穴の面積（いちばん大きな輪を外周、ほかを穴とみなす） */
function hatchArea(rings: number[][], t: Xform): number {
  const areas = rings.map((r) => {
    const moved: number[] = [];
    for (let i = 0; i + 1 < r.length; i += 2) moved.push(...apply(t, r[i], r[i + 1]));
    return Math.abs(ringArea(moved));
  }).sort((a, c) => c - a);
  return areas.length ? Math.max(0, areas[0] - areas.slice(1).reduce((s, v) => s + v, 0)) : 0;
}

/** 用紙の矩形と呼び名 */
function paperOf(doc: SxfDocument): { paper: Bounds | null; label: string } {
  const s = doc.sheet;
  if (!s) return { paper: null, label: '' };
  let w: number, h: number, label: string;
  const size = PAPER_MM[s.type];
  if (size) {
    [w, h] = s.orientation === 0 ? [size[1], size[0]] : size;
    label = `A${s.type} ${s.orientation === 0 ? '縦' : '横'}`;
  } else {
    w = s.x; h = s.y;
    label = `自由 ${w} × ${h} mm`;
  }
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w + h)) return { paper: null, label: '' };
  return { paper: { minX: 0, minY: 0, maxX: w, maxY: h }, label };
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

