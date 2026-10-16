/**
 * SFC（SXF の「フィーチャコメント」形式）を読む。
 * ISO-10303-21 の DATA 節にある `/*SXF #n = xxx_feature(…) SXF*\/` の注釈から図形を取り出す。
 *
 * 引数の並びは SXF Ver.3.1 の SFC の仕様（『SXF Ver.3.1 仕様書・同解説 フィーチャ仕様編』）に従うが、本文は
 * 公開の場所から手に入らなかったので、MIT ライセンスの ezsxf（monozukuri-ai/ezsxf 0.1.2、
 * 「SXF Ver.3.1 SFC の 34 種類のフィーチャ」を読むもの）の引数の並びと、公開されている実際の SFC
 * （山口県のインフラ台帳の公開データ）で確かめた。実データで確かめられたのは、線・折れ線・円・円弧・文字・
 * 複合図形（部分図・作図グループ）・複合曲線・塗り（外部定義・単色）・点・用紙・レイヤ・色・線幅・線種（既定義）。
 * 寸法・引出し線・バルーン・楕円・スプライン・クロソイド・模様のハッチング・利用者定義の線種は
 * ezsxf の並びだけによる（実データ未確認。印は「未確認」）。
 *
 * 複合図形・複合曲線・用紙は「それより前に出てきた、まだどこにも属していない図形」をまとめる
 * （sfig_org_feature・composite_curve_org_feature・drawing_sheet_feature が来た時点で、ためた図形がその中身になる）
 */
import {
  SXF_WIDTHS, predefinedColorCode, predefinedLineTypeCode,
} from './colors.ts';
import {
  emptySxfDocument, type SxfArrow, type SxfCompositeCurve, type SxfDocument, type SxfFeature, type SxfStyle,
  type SxfText,
} from './types.ts';

/** フィーチャの数の上限（壊れたファイルで際限なく積まないように） */
export const MAX_SFC_FEATURES = 5_000_000;
/** 折れ線・スプラインの頂点の上限（1 つあたり） */
export const MAX_SFC_VERTICES = 1_000_000;

/** 生の引数。文字列（\'…\' で囲んだもの）と、それ以外（'…' で囲んだ数やリスト、裸の値） */
interface Arg { s: string; quoted: boolean }

interface RawFeature { id: number; name: string; args: Arg[] }

/** バイト列を文字列に。UTF-8 で読めればそれ、読めなければ Shift_JIS */
export function decodeSxf(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start));
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

/** 注釈の中のフィーチャをすべて取り出す */
function scanFeatures(text: string, warnings: string[]): RawFeature[] {
  const out: RawFeature[] = [];
  let pos = 0;
  let broken = 0;
  for (;;) {
    const open = text.indexOf('/*SXF', pos);
    if (open < 0) break;
    // 終わりの印は SXF*/・SXF3*/・SXF3.1*/
    const close = text.indexOf('*/', open + 5);
    const end = close < 0 ? text.length : close;
    pos = close < 0 ? text.length : close + 2;
    let body = text.slice(open + 5, end);
    body = body.replace(/^3(\.1)?/, '').replace(/SXF(3(\.1)?)?\s*$/, '');
    const f = parseBody(body);
    if (f) out.push(f);
    else broken++;
    if (out.length >= MAX_SFC_FEATURES) {
      warnings.push(`フィーチャが多すぎるため、${MAX_SFC_FEATURES.toLocaleString()} 個で読むのをやめました`);
      break;
    }
  }
  if (broken) warnings.push(`読めないフィーチャを ${broken} 個読み飛ばしました`);
  return out;
}

/** `#n = name(args)` を読む */
function parseBody(body: string): RawFeature | null {
  const m = /^\s*#(\d+)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(body);
  if (!m) return null;
  const args: Arg[] = [];
  let i = m[0].length;
  const n = body.length;
  while (i < n) {
    const c = body[i];
    if (c === ')') return { id: Number(m[1]), name: m[2].toLowerCase(), args };
    if (c === ',' || c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '\\' && body[i + 1] === "'") {
      // 文字列は \'…\' で囲む。中の \\ は \ 。閉じの \' がなければ、, か ) の前の ' で閉じる
      let s = '';
      let j = i + 2;
      for (; j < n; j++) {
        if (body[j] === '\\' && body[j + 1] === "'") { j += 2; break; }
        if (body[j] === '\\' && body[j + 1] === '\\') { s += '\\'; j++; continue; }
        if (body[j] === "'" && /^\s*[,)]/.test(body.slice(j + 1, j + 8))) { j++; break; }
        s += body[j];
      }
      args.push({ s, quoted: true });
      i = j;
      continue;
    }
    if (c === "'") {
      const j = body.indexOf("'", i + 1);
      if (j < 0) return null;
      args.push({ s: body.slice(i + 1, j), quoted: false });
      i = j + 1;
      continue;
    }
    // 裸の値（引用なしで書く実装もある）
    let j = i;
    let depth = 0;
    while (j < n && (depth > 0 || (body[j] !== ',' && body[j] !== ')'))) {
      if (body[j] === '(') depth++;
      else if (body[j] === ')') depth--;
      j++;
    }
    args.push({ s: body.slice(i, j).trim(), quoted: false });
    i = j;
  }
  return null;
}

/** 引数を読む道具 */
class Args {
  readonly a: Arg[];
  constructor(a: Arg[]) { this.a = a; }
  get length(): number { return this.a.length; }
  num(i: number): number {
    const v = this.a[i];
    return v ? Number.parseFloat(v.s) : NaN;
  }
  int(i: number, fallback = 0): number {
    const n = Math.round(this.num(i));
    return Number.isFinite(n) ? n : fallback;
  }
  str(i: number): string {
    return this.a[i]?.s ?? '';
  }
  /** '(1,2,3)' の形の数のリスト */
  list(i: number): number[] {
    const s = this.a[i]?.s ?? '';
    const body = s.replace(/^\s*\(/, '').replace(/\)\s*$/, '');
    if (!body.trim()) return [];
    return body.split(',').slice(0, MAX_SFC_VERTICES).map((v) => Number.parseFloat(v));
  }
  style(): SxfStyle {
    return { layer: this.int(0), color: this.int(1), ltype: this.int(2), width: this.int(3) };
  }
  /** 文字の 12 個（flag, font, str, x, y, 高さ, 幅, 間隔, 角度, スラント, 基点, 向き）。flag が 1 でなければ null */
  featureText(i: number): SxfText | null {
    if (this.int(i) !== 1) return null;
    return {
      font: this.int(i + 1), text: this.str(i + 2), x: this.num(i + 3), y: this.num(i + 4),
      height: this.num(i + 5), width: this.num(i + 6), spacing: this.num(i + 7), angle: this.num(i + 8),
      slant: this.num(i + 9), bpnt: this.int(i + 10, 1), direction: this.int(i + 11, 1),
    };
  }
  /** 補助線の 7 個（flag, 基点, 始点, 終点）。flag が 1 なら [始点, 終点] */
  ext(i: number): number[] | null {
    if (this.int(i) !== 1) return null;
    return [this.num(i + 3), this.num(i + 4), this.num(i + 5), this.num(i + 6)];
  }
}

/** 向き (vx, vy) の単位ベクトル（長さ 0 なら null） */
function unit(vx: number, vy: number): [number, number] | null {
  const l = Math.hypot(vx, vy);
  return l > 0 && Number.isFinite(l) ? [vx / l, vy / l] : null;
}

/**
 * 矢印の 5 個（code, 向き, x, y, 倍率）。(vx, vy) は向きの flag が 2 のときの矢の向き（1 なら逆、0 なら描かない）。
 * 向きの意味は ezsxf の描き方に合わせた（未確認）
 */
function arrowAt(a: Args, i: number, vx: number, vy: number): SxfArrow | null {
  const code = a.int(i);
  const flag = a.int(i + 1);
  if (code === 0 || flag === 0) return null;
  const u = unit(vx, vy);
  if (!u) return null;
  const sign = flag === 1 ? -1 : 1;
  return { code, x: a.num(i + 2), y: a.num(i + 3), ux: u[0] * sign, uy: u[1] * sign, scale: a.num(i + 4) };
}

/** 折れ線の頂点 [x, y, ...]。x と y の数が違えば短いほうに合わせる */
function zipXY(xs: number[], ys: number[]): number[] {
  const n = Math.min(xs.length, ys.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(xs[i], ys[i]);
  return out;
}

/** 部材から図形を作る（作らない種類なら null） */
function toFeature(f: RawFeature): SxfFeature | null {
  const a = new Args(f.args);
  switch (f.name) {
    case 'line_feature':
      if (a.length < 8) return null;
      return { t: 'line', s: a.style(), x1: a.num(4), y1: a.num(5), x2: a.num(6), y2: a.num(7) };
    case 'polyline_feature': {
      if (a.length < 7) return null;
      const xy = zipXY(a.list(5), a.list(6));
      return xy.length >= 4 ? { t: 'polyline', s: a.style(), xy } : null;
    }
    case 'circle_feature':
      if (a.length < 7) return null;
      return { t: 'circle', s: a.style(), x: a.num(4), y: a.num(5), r: a.num(6) };
    case 'arc_feature':
      if (a.length < 10) return null;
      return {
        t: 'arc', s: a.style(), x: a.num(4), y: a.num(5), r: a.num(6), dir: a.int(7), start: a.num(8), end: a.num(9),
      };
    case 'ellipse_feature':
      // 未確認（ezsxf の並び）
      if (a.length < 9) return null;
      return { t: 'ellipse', s: a.style(), x: a.num(4), y: a.num(5), rx: a.num(6), ry: a.num(7), rot: a.num(8) };
    case 'ellipse_arc_feature':
      // 未確認（ezsxf の並び）
      if (a.length < 12) return null;
      return {
        t: 'ellipseArc', s: a.style(), x: a.num(4), y: a.num(5), rx: a.num(6), ry: a.num(7), dir: a.int(8),
        rot: a.num(9), start: a.num(10), end: a.num(11),
      };
    case 'text_string_feature':
      if (a.length < 13) return null;
      return {
        t: 'text', s: { layer: a.int(0), color: a.int(1), ltype: 1, width: 0 },
        text: {
          font: a.int(2), text: a.str(3), x: a.num(4), y: a.num(5), height: a.num(6), width: a.num(7),
          spacing: a.num(8), angle: a.num(9), slant: a.num(10), bpnt: a.int(11, 1), direction: a.int(12, 1),
        },
      };
    case 'spline_feature': {
      // 未確認（ezsxf の並び）。open_close は 1 が閉じた曲線とみなす
      if (a.length < 8) return null;
      const xy = zipXY(a.list(6), a.list(7));
      return xy.length >= 4 ? { t: 'spline', s: a.style(), closed: a.int(4) === 1, xy } : null;
    }
    case 'clothoid_feature':
      // 未確認（ezsxf の並び）
      if (a.length < 11) return null;
      return {
        t: 'clothoid', s: a.style(), x: a.num(4), y: a.num(5), a: a.num(6), dir: a.int(7), angle: a.num(8),
        l0: a.num(9), l1: a.num(10),
      };
    case 'point_marker_feature':
      if (a.length < 7) return null;
      return {
        t: 'point', s: { layer: a.int(0), color: a.int(1), ltype: 1, width: 0 },
        x: a.num(2), y: a.num(3), marker: a.int(4), angle: a.num(5), scale: a.num(6),
      };
    case 'sfig_locate_feature':
      if (a.length < 7) return null;
      return {
        t: 'locate', layer: a.int(0), name: a.str(1), x: a.num(2), y: a.num(3), angle: a.num(4),
        rx: a.num(5), ry: a.num(6),
      };
    case 'externally_defined_symbol_feature':
    case 'symbol_externally_defined_feature':
      if (a.length < 8) return null;
      return {
        t: 'symbol', s: { layer: a.int(0), color: a.int(2), ltype: 1, width: 0 }, name: a.str(3),
        x: a.num(4), y: a.num(5), angle: a.num(6), scale: a.num(7),
      };
    case 'linear_dim_feature': {
      // 未確認（ezsxf の並び）
      if (a.length < 44) return null;
      const x1 = a.num(4), y1 = a.num(5), x2 = a.num(6), y2 = a.num(7);
      return {
        t: 'dim', kind: 'linear', s: a.style(), line: [x1, y1, x2, y2], arc: null,
        aux: [a.ext(8), a.ext(15)].filter((v): v is number[] => v !== null),
        arrows: [arrowAt(a, 22, x2 - x1, y2 - y1), arrowAt(a, 27, x1 - x2, y1 - y2)].filter((v): v is SxfArrow => v !== null),
        text: a.featureText(32), circle: null,
      };
    }
    case 'curve_dim_feature':
    case 'angular_dim_feature': {
      // 未確認（ezsxf の並び）。寸法線は中心・半径・開始角から終了角へ左回り
      if (a.length < 45) return null;
      const cx = a.num(4), cy = a.num(5);
      const tangent = (i: number, sign: number): [number, number] => {
        const rx = a.num(i + 2) - cx, ry = a.num(i + 3) - cy;
        return [-ry * sign, rx * sign];
      };
      const [t1x, t1y] = tangent(23, 1);
      const [t2x, t2y] = tangent(28, -1);
      return {
        t: 'dim', kind: f.name === 'curve_dim_feature' ? 'curve' : 'angular', s: a.style(), line: null,
        arc: { x: cx, y: cy, r: a.num(6), start: a.num(7), end: a.num(8) },
        aux: [a.ext(9), a.ext(16)].filter((v): v is number[] => v !== null),
        arrows: [arrowAt(a, 23, t1x, t1y), arrowAt(a, 28, t2x, t2y)].filter((v): v is SxfArrow => v !== null),
        text: a.featureText(33), circle: null,
      };
    }
    case 'radius_dim_feature': {
      // 未確認（ezsxf の並び）
      if (a.length < 25) return null;
      const x1 = a.num(4), y1 = a.num(5), x2 = a.num(6), y2 = a.num(7);
      return {
        t: 'dim', kind: 'radius', s: a.style(), line: [x1, y1, x2, y2], arc: null, aux: [],
        arrows: [arrowAt(a, 8, x1 - x2, y1 - y2)].filter((v): v is SxfArrow => v !== null),
        text: a.featureText(13), circle: null,
      };
    }
    case 'diameter_dim_feature': {
      // 未確認（ezsxf の並び）
      if (a.length < 30) return null;
      const x1 = a.num(4), y1 = a.num(5), x2 = a.num(6), y2 = a.num(7);
      return {
        t: 'dim', kind: 'diameter', s: a.style(), line: [x1, y1, x2, y2], arc: null, aux: [],
        arrows: [arrowAt(a, 8, x2 - x1, y2 - y1), arrowAt(a, 13, x1 - x2, y1 - y2)].filter((v): v is SxfArrow => v !== null),
        text: a.featureText(18), circle: null,
      };
    }
    case 'label_feature':
    case 'balloon_feature': {
      // 未確認（ezsxf の並び）。矢印は最初の頂点に、2 つ目の頂点から離れる向き
      const balloon = f.name === 'balloon_feature';
      if (a.length < (balloon ? 24 : 21)) return null;
      const xy = zipXY(a.list(5), a.list(6));
      if (xy.length < 4) return null;
      const k = balloon ? 10 : 7;
      const u = unit(xy[0] - xy[2], xy[1] - xy[3]);
      const code = a.int(k);
      const arrows: SxfArrow[] = code !== 0 && u ? [{ code, x: xy[0], y: xy[1], ux: u[0], uy: u[1], scale: a.num(k + 1) }] : [];
      return {
        t: 'dim', kind: balloon ? 'balloon' : 'label', s: a.style(), line: xy, arc: null, aux: [], arrows,
        text: a.featureText(balloon ? 12 : 9),
        circle: balloon ? { x: a.num(7), y: a.num(8), r: a.num(9) } : null,
      };
    }
    default:
      return null;
  }
}

/** ハッチングの、あとで複合曲線をつなぐもの */
interface HatchFix { feature: Extract<SxfFeature, { t: 'hatch' }>; out: number; holes: number[] }

function toHatch(f: RawFeature): HatchFix | null {
  const a = new Args(f.args);
  const empty = (): SxfCompositeCurve => ({ color: 0, ltype: 0, width: 0, visible: false, members: [] });
  const make = (kind: 'external' | 'fill' | 'pattern' | 'tiles', s: SxfStyle, name: string, out: number, holes: number[]): HatchFix => ({
    feature: { t: 'hatch', kind, s, name, outer: empty(), holes: [], lines: [] }, out, holes,
  });
  switch (f.name) {
    case 'externally_defined_hatch_feature':
      if (a.length < 5) return null;
      return make('external', { layer: a.int(0), color: 0, ltype: 1, width: 0 }, a.str(1), a.int(2), a.list(4));
    case 'fill_area_style_colour_feature':
      if (a.length < 5) return null;
      return make('fill', { layer: a.int(0), color: a.int(1), ltype: 1, width: 0 }, '', a.int(2), a.list(3 + 1));
    case 'fill_area_style_hatching_feature': {
      // 未確認（ezsxf の並び）：layer, 模様の数 n, 模様 n 個（色, 線種, 線幅, x, y, 間隔, 角度）, out_id, 穴の数, 穴
      const n = a.int(1);
      if (n < 0 || a.length < 2 + n + 3) return null;
      const h = make('pattern', { layer: a.int(0), color: 0, ltype: 1, width: 0 }, '', a.int(2 + n), a.list(2 + n + 2));
      for (let k = 0; k < n; k++) {
        const v = a.list(2 + k);
        if (v.length < 7) continue;
        h.feature.lines.push({
          color: Math.round(v[0]), ltype: Math.round(v[1]), width: Math.round(v[2]), x: v[3], y: v[4], spacing: v[5], angle: v[6],
        });
      }
      return h;
    }
    case 'fill_area_style_tiles_feature':
    case 'fill_area_style_tiles_hatching_feature':
      if (a.length < 15) return null;
      return make('tiles', { layer: a.int(0), color: a.int(2), ltype: 1, width: 0 }, a.str(1), a.int(12), a.list(14));
    default:
      return null;
  }
}

export function parseSfc(buffer: ArrayBuffer): SxfDocument {
  const doc = emptySxfDocument('sfc');
  const text = decodeSxf(buffer);
  const desc = /FILE_DESCRIPTION\s*\(\s*\(\s*'([^']*)'/i.exec(text.slice(0, 4096));
  doc.version = desc ? desc[1] : '';
  const raw = scanFeatures(text, doc.warnings);

  // 定義の表（置き場所によらず、出てきた順にコードを振る。レイヤは用紙の後ろに書く実装もある）
  let userWidth = 10;
  for (let k = 0; k < SXF_WIDTHS.length; k++) doc.widths.set(k + 1, SXF_WIDTHS[k]);
  for (const f of raw) {
    const a = new Args(f.args);
    switch (f.name) {
      case 'layer_feature':
        if (doc.layers.length < 256) doc.layers.push({ name: a.str(0), visible: a.int(1, 1) !== 0 });
        break;
      case 'user_defined_colour_feature':
        doc.userColors.push([clamp255(a.num(0)), clamp255(a.num(1)), clamp255(a.num(2))]);
        break;
      case 'user_defined_font_feature':
        // 未確認（ezsxf の並び）：名前, 区切りの数, ピッチのリスト
        doc.userLineTypes.push({ name: a.str(0), pitch: a.list(2).map((v, i) => (i % 2 === 0 ? Math.abs(v) : -Math.abs(v))) });
        break;
      case 'width_feature': {
        const w = a.num(0);
        const k = SXF_WIDTHS.findIndex((v) => Math.abs(v - w) < 1e-6);
        if (k < 0 && Number.isFinite(w)) doc.widths.set(++userWidth, w);
        break;
      }
      case 'text_font_feature':
        doc.fonts.push(a.str(0));
        break;
      case 'drawing_sheet_feature':
        doc.sheetName = a.str(0);
        doc.sheet = { type: a.int(1, 9), orientation: a.int(2, 1), x: a.num(3), y: a.num(4) };
        break;
      case 'pre_defined_colour_feature':
        if (!predefinedColorCode(a.str(0))) doc.warnings.push(`知らない既定義色「${a.str(0)}」`);
        break;
      case 'pre_defined_font_feature':
        if (!predefinedLineTypeCode(a.str(0))) doc.warnings.push(`知らない既定義線種「${a.str(0)}」`);
        break;
    }
  }

  // 図形を、複合図形・複合曲線・用紙にまとめる
  let buffer2: SxfFeature[] = [];
  const curves: SxfCompositeCurve[] = [];
  const hatches: HatchFix[] = [];
  let sheetSeen = false;
  const count = (k: string): void => { doc.counts[k] = (doc.counts[k] ?? 0) + 1; };
  for (const f of raw) {
    switch (f.name) {
      case 'sfig_org_feature': {
        const a = new Args(f.args);
        const name = a.str(0);
        if (!doc.figures.has(name)) doc.figures.set(name, { name, kind: a.int(1, 3), features: buffer2 });
        buffer2 = [];
        continue;
      }
      case 'composite_curve_org_feature':
      case 'composite_curve_feature': {
        const a = new Args(f.args);
        curves.push({ color: a.int(0), ltype: a.int(1), width: a.int(2), visible: a.int(3) === 1, members: buffer2 });
        buffer2 = [];
        continue;
      }
      case 'drawing_sheet_feature':
        if (!sheetSeen) { doc.sheetFeatures = buffer2; buffer2 = []; sheetSeen = true; }
        continue;
    }
    const h = toHatch(f);
    if (h) {
      hatches.push(h);
      buffer2.push(h.feature);
      count(f.name);
      continue;
    }
    const g = toFeature(f);
    if (g) {
      buffer2.push(g);
      count(f.name);
    } else if (!DEFINITIONS.has(f.name)) {
      doc.skipped.set(f.name, (doc.skipped.get(f.name) ?? 0) + 1);
    }
  }
  // 用紙より後ろの図形や、用紙のないファイルの図形も用紙に置く
  if (buffer2.length) doc.sheetFeatures.push(...buffer2);

  // ハッチングの境界（複合曲線のコードは出てきた順に 1 から）
  let missing = 0;
  for (const h of hatches) {
    const out = curves[h.out - 1];
    if (!out) { missing++; continue; }
    h.feature.outer = out;
    h.feature.holes = h.holes.map((c) => curves[c - 1]).filter((c): c is SxfCompositeCurve => !!c);
  }
  if (missing) doc.warnings.push(`境界の見つからないハッチングがあります（${missing} 個）`);
  return doc;
}

/** 図形ではない（表を作るだけの）フィーチャ */
const DEFINITIONS = new Set([
  'layer_feature', 'pre_defined_font_feature', 'user_defined_font_feature', 'pre_defined_colour_feature',
  'user_defined_colour_feature', 'width_feature', 'text_font_feature', 'drawing_attribute_feature',
  'attribute_feature',
]);

function clamp255(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 0;
}
