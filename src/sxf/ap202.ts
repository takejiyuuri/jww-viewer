/**
 * P21（STEP AP202 の関連図面）を SxfDocument にする。描画に要る範囲だけを、SFC と同じ形（コード）に写す。
 *
 * SXF の P21 の対応表（『SXF 実装規約』の AP202 との対応）は公開の場所から手に入らなかったので、
 * ISO 10303-202 / 10303-46 の実体の定義と、MIT ライセンスの ezsxf（monozukuri-ai/ezsxf 0.1.2 の
 * _p21_drawing.py。実際の SXF の P21 を描くもの）のたどり方に合わせた（実データ未確認）。
 *   用紙：DRAWING_SHEET_REVISION の items。大きさは PRESENTATION_SIZE → PLANAR_BOX
 *   レイヤ：PRESENTATION_LAYER_ASSIGNMENT（出てきた順にコード 1 から）、INVISIBILITY で非表示
 *   線の属性：STYLED_ITEM（ANNOTATION_*_OCCURRENCE など）→ PRESENTATION_STYLE_ASSIGNMENT →
 *     CURVE_STYLE（線種 DRAUGHTING_PRE_DEFINED_CURVE_FONT・CURVE_STYLE_FONT、線幅、色 DRAUGHTING_PRE_DEFINED_COLOUR・COLOUR_RGB）
 *   形：POLYLINE、CIRCLE、ELLIPSE、TRIMMED_CURVE（円・楕円・直線）、COMPOSITE_CURVE、B_SPLINE_CURVE_WITH_KNOTS
 *   文字：TEXT_LITERAL_WITH_EXTENT（配置の点を基点、寄せは alignment、縦書きは path .DOWN.）
 *   複合図形：MAPPED_ITEM → (SYMBOL_)REPRESENTATION_MAP → DRAUGHTING_SUBFIGURE_REPRESENTATION・
 *     DRAUGHTING_SYMBOL_REPRESENTATION、配置は SYMBOL_TARGET（位置・向き・倍率）
 *   寸法・引出し線：DRAUGHTING_CALLOUT の仲間（LINEAR_DIMENSION など）の contents
 *   ハッチング：ANNOTATION_FILL_AREA と FILL_AREA_STYLE（_COLOUR・_HATCHING・EXTERNALLY_DEFINED_HATCH_STYLE・_TILES）
 * 部分図かどうかは P21 に印が見当たらないので、用紙に直に置いた subfigure で倍率が 1 でないものを部分図とみなす。
 * 角度は CONVERSION_BASED_UNIT に「DEGREE」があれば度、なければラジアン
 */
import { SXF_WIDTHS, USER_COLOR_BASE, USER_LINE_TYPE_BASE, predefinedColorCode, predefinedLineTypeCode } from './colors.ts';
import {
  isEnum, isRef, isTyped, type P21File, type StepEntity, type StepValue,
} from './p21.ts';
import {
  emptySxfDocument, type SxfArrow, type SxfCompositeCurve, type SxfDocument, type SxfFeature, type SxfFigure,
  type SxfHatchLine, type SxfStyle, type SxfText,
} from './types.ts';

/** 参照の深さの上限（循環や長い鎖で止まらないように） */
const MAX_REF_DEPTH = 64;

/** 用紙の大きさ（A0〜A4、横向き） */
const PAPER_MM: [number, number][] = [[1189, 841], [841, 594], [594, 420], [420, 297], [297, 210]];

/** 線の属性（コードを決める前の値） */
interface Look { color: number; ltype: number; width: number; font: number }

const STYLED = [
  'ANNOTATION_CURVE_OCCURRENCE', 'ANNOTATION_TEXT_OCCURRENCE', 'ANNOTATION_FILL_AREA_OCCURRENCE',
  'ANNOTATION_SYMBOL_OCCURRENCE', 'ANNOTATION_OCCURRENCE', 'DRAUGHTING_ANNOTATION_OCCURRENCE', 'STYLED_ITEM',
  'OVER_RIDING_STYLED_ITEM', 'DIMENSION_CURVE', 'PROJECTION_CURVE', 'LEADER_CURVE', 'DIMENSION_CURVE_TERMINATOR',
  'LEADER_TERMINATOR', 'TERMINATOR_SYMBOL', 'ANNOTATION_SUBFIGURE_OCCURRENCE',
];
const CALLOUTS: Record<string, Extract<SxfFeature, { t: 'dim' }>['kind']> = {
  LINEAR_DIMENSION: 'linear', CURVE_DIMENSION: 'curve', ANGULAR_DIMENSION: 'angular', RADIUS_DIMENSION: 'radius',
  DIAMETER_DIMENSION: 'diameter', LEADER_DIRECTED_CALLOUT: 'label', DRAUGHTING_CALLOUT: 'label',
  DIMENSION_CURVE_DIRECTED_CALLOUT: 'linear', LEADER_DIRECTED_DIMENSION: 'radius', ORDINATE_DIMENSION: 'linear',
  STRUCTURED_DIMENSION_CALLOUT: 'linear',
};

export function ap202ToSxf(file: P21File): SxfDocument {
  const doc = emptySxfDocument('p21');
  doc.version = file.description;
  doc.warnings.push(...file.warnings);
  const ents = file.entities;
  for (let k = 0; k < SXF_WIDTHS.length; k++) doc.widths.set(k + 1, SXF_WIDTHS[k]);

  const get = (v: StepValue | undefined): StepEntity | undefined => (isRef(v) ? ents.get(v.ref) : undefined);
  const rec = (e: StepEntity | undefined, type: string): StepValue[] | undefined => e?.records.get(type);
  const recOf = (e: StepEntity | undefined, types: string[]): [string, StepValue[]] | null => {
    if (!e) return null;
    for (const t of types) { const r = e.records.get(t); if (r) return [t, r]; }
    return null;
  };
  /** 数（型付きの値 LENGTH_MEASURE(1.) なども） */
  const num = (v: StepValue | undefined): number => {
    if (typeof v === 'number') return v;
    if (isTyped(v)) return num(v.args[0]);
    if (Array.isArray(v)) return num(v[0]);
    return NaN;
  };
  const str = (v: StepValue | undefined): string => (typeof v === 'string' ? v : '');
  const refs = (v: StepValue | undefined): StepEntity[] => {
    if (!Array.isArray(v)) { const e = get(v); return e ? [e] : []; }
    return v.map(get).filter((e): e is StepEntity => !!e);
  };

  // 角度の単位
  let degrees = false;
  for (const e of ents.values()) {
    const u = rec(e, 'CONVERSION_BASED_UNIT');
    if (u && /degree/i.test(str(u[0]))) { degrees = true; break; }
  }
  const toDeg = (v: number): number => (degrees ? v : (v * 180) / Math.PI);

  // 色・線種の表（ファイルの順に。SFC の利用者定義と同じく 17・16 から）
  const userColor = new Map<number, number>();
  const userLtype = new Map<number, number>();
  for (const e of ents.values()) {
    const rgb = rec(e, 'COLOUR_RGB');
    if (rgb) {
      userColor.set(e.id, USER_COLOR_BASE + doc.userColors.length);
      doc.userColors.push([0, 1, 2].map((k) => clamp255(num(rgb[k + 1]) * 255)) as [number, number, number]);
    }
    const font = rec(e, 'CURVE_STYLE_FONT');
    if (font) {
      userLtype.set(e.id, USER_LINE_TYPE_BASE + doc.userLineTypes.length);
      const pitch: number[] = [];
      for (const p of refs(font[1])) {
        const r = rec(p, 'CURVE_STYLE_FONT_PATTERN');
        if (r) pitch.push(Math.abs(num(r[0])), -Math.abs(num(r[1])));
      }
      doc.userLineTypes.push({ name: str(font[0]), pitch });
    }
  }
  const fontCodes = new Map<string, number>();
  const fontCode = (name: string): number => {
    if (!name) return 0;
    let c = fontCodes.get(name);
    if (c === undefined) { doc.fonts.push(name); c = doc.fonts.length; fontCodes.set(name, c); }
    return c;
  };
  let userWidth = 10;
  const widthCode = (w: number): number => {
    if (!Number.isFinite(w)) return 0;
    const k = SXF_WIDTHS.findIndex((v) => Math.abs(v - w) < 1e-6);
    if (k >= 0) return k + 1;
    for (const [c, v] of doc.widths) if (Math.abs(v - w) < 1e-9) return c;
    doc.widths.set(++userWidth, w);
    return userWidth;
  };

  // レイヤ
  const layerOfItem = new Map<number, number>();
  const layerIds: number[] = [];
  for (const e of ents.values()) {
    const r = rec(e, 'PRESENTATION_LAYER_ASSIGNMENT');
    if (!r || doc.layers.length >= 256) continue;
    doc.layers.push({ name: str(r[0]), visible: true });
    layerIds.push(e.id);
    for (const it of refs(r[2])) if (!layerOfItem.has(it.id)) layerOfItem.set(it.id, doc.layers.length);
  }
  for (const e of ents.values()) {
    const r = rec(e, 'INVISIBILITY');
    if (!r) continue;
    for (const it of refs(r[0])) {
      const k = layerIds.indexOf(it.id);
      if (k >= 0) doc.layers[k].visible = false;
    }
  }

  /** 色 */
  const colorOf = (e: StepEntity | undefined): number => {
    if (!e) return 0;
    const pre = rec(e, 'DRAUGHTING_PRE_DEFINED_COLOUR') ?? rec(e, 'PRE_DEFINED_COLOUR');
    if (pre) return predefinedColorCode(str(pre[0]));
    return userColor.get(e.id) ?? 0;
  };
  /** 線の属性を集める（スタイルの入れ物をたどる） */
  const lookOf = (styles: StepValue | undefined): Look => {
    const look: Look = { color: 0, ltype: 1, width: 0, font: 0 };
    const seen = new Set<number>();
    const visit = (e: StepEntity | undefined, depth: number): void => {
      if (!e || seen.has(e.id) || depth > MAX_REF_DEPTH) return;
      seen.add(e.id);
      const curve = rec(e, 'CURVE_STYLE');
      if (curve) {
        const f = get(curve[1]);
        const pre = rec(f, 'DRAUGHTING_PRE_DEFINED_CURVE_FONT') ?? rec(f, 'PRE_DEFINED_CURVE_FONT');
        if (pre) look.ltype = predefinedLineTypeCode(str(pre[0])) || 1;
        else if (f && userLtype.has(f.id)) look.ltype = userLtype.get(f.id)!;
        const w = isRef(curve[2]) ? num(rec(get(curve[2]), 'LENGTH_MEASURE_WITH_UNIT')?.[0]) : num(curve[2]);
        look.width = widthCode(w);
        look.color = colorOf(get(curve[3]));
        return;
      }
      const colourOnly = rec(e, 'TEXT_STYLE_FOR_DEFINED_FONT') ?? rec(e, 'SYMBOL_COLOUR');
      if (colourOnly) { look.color = colorOf(get(colourOnly[0])); return; }
      const fill = rec(e, 'FILL_AREA_STYLE_COLOUR');
      if (fill) { look.color = colorOf(get(fill[1])); return; }
      for (const [type, params] of e.records) {
        if (type === 'COLOUR_RGB' || type.endsWith('PRE_DEFINED_COLOUR')) { look.color = colorOf(e); return; }
        for (const p of params) for (const r of refs(p)) visit(r, depth + 1);
        if (Array.isArray(params)) {
          for (const p of params) if (Array.isArray(p)) for (const q of p) for (const r of refs(q)) visit(r, depth + 1);
        }
      }
    };
    for (const r of refs(styles)) visit(r, 0);
    return look;
  };
  const styleOf = (look: Look, layer: number): SxfStyle => ({ layer, color: look.color, ltype: look.ltype, width: look.width });

  // 点・向き・配置
  const point = (e: StepEntity | undefined): [number, number] => {
    const r = rec(e, 'CARTESIAN_POINT');
    const c = r?.[1];
    return Array.isArray(c) ? [num(c[0]), num(c[1])] : [NaN, NaN];
  };
  const direction = (e: StepEntity | undefined): [number, number] => {
    const r = rec(e, 'DIRECTION');
    const c = r?.[1];
    if (!Array.isArray(c)) return [1, 0];
    const x = num(c[0]), y = num(c[1]);
    const l = Math.hypot(x, y);
    if (!(l > 0)) return [1, 0];
    // すでに単位の長さなら割らない（SFC と同じ値のまま描けるように）
    return Math.abs(l - 1) < 1e-12 ? [x, y] : [x / l, y / l];
  };
  /** AXIS2_PLACEMENT_2D の位置と x 軸の向き */
  const axis = (e: StepEntity | undefined): { x: number; y: number; ux: number; uy: number } => {
    const r = rec(e, 'AXIS2_PLACEMENT_2D') ?? rec(e, 'AXIS2_PLACEMENT_3D');
    if (!r) return { x: 0, y: 0, ux: 1, uy: 0 };
    const [x, y] = point(get(r[1]));
    const d = r.length > 2 && r[2] !== null ? direction(get(r[r.length > 3 ? 3 : 2])) : [1, 0];
    return { x, y, ux: d[0], uy: d[1] };
  };
  const angleOf = (ux: number, uy: number): number => (uy === 0 && ux > 0 ? 0 : (Math.atan2(uy, ux) * 180) / Math.PI);

  /** 曲線を図形に。合成曲線は部材ごとに */
  const curveFeatures = (e: StepEntity | undefined, s: SxfStyle, depth = 0): SxfFeature[] => {
    if (!e || depth > MAX_REF_DEPTH) return [];
    const poly = rec(e, 'POLYLINE');
    if (poly) {
      const xy: number[] = [];
      for (const p of refs(poly[1])) xy.push(...point(p));
      if (xy.length === 4) return [{ t: 'line', s, x1: xy[0], y1: xy[1], x2: xy[2], y2: xy[3] }];
      return xy.length >= 4 ? [{ t: 'polyline', s, xy }] : [];
    }
    const circle = rec(e, 'CIRCLE');
    if (circle) {
      const a = axis(get(circle[1]));
      return [{ t: 'circle', s, x: a.x, y: a.y, r: num(circle[2]) }];
    }
    const ellipse = rec(e, 'ELLIPSE');
    if (ellipse) {
      const a = axis(get(ellipse[1]));
      return [{ t: 'ellipse', s, x: a.x, y: a.y, rx: num(ellipse[2]), ry: num(ellipse[3]), rot: angleOf(a.ux, a.uy) }];
    }
    const trimmed = rec(e, 'TRIMMED_CURVE');
    if (trimmed) {
      const basis = get(trimmed[1]);
      const sense = isEnum(trimmed[4]) ? trimmed[4].enum !== 'F' : true;
      const param = (v: StepValue | undefined): number => {
        const list = Array.isArray(v) ? v : [v];
        for (const x of list) if (isTyped(x) || typeof x === 'number') return num(x);
        return NaN;
      };
      const pt = (v: StepValue | undefined): [number, number] | null => {
        const list = Array.isArray(v) ? v : [v];
        for (const x of list) if (isRef(x) && rec(get(x), 'CARTESIAN_POINT')) return point(get(x));
        return null;
      };
      const c = rec(basis, 'CIRCLE');
      const el = rec(basis, 'ELLIPSE');
      if (c || el) {
        const a = axis(get((c ?? el)![1]));
        const rot = angleOf(a.ux, a.uy);
        let start = toDeg(param(trimmed[2])), end = toDeg(param(trimmed[3]));
        const dir = sense ? 0 : 1;
        if (c) {
          start += rot; end += rot;
          return [{ t: 'arc', s, x: a.x, y: a.y, r: num(c[2]), dir, start, end }];
        }
        return [{ t: 'ellipseArc', s, x: a.x, y: a.y, rx: num(el![2]), ry: num(el![3]), dir, rot, start, end }];
      }
      const line = rec(basis, 'LINE');
      if (line) {
        let p1 = pt(trimmed[2]), p2 = pt(trimmed[3]);
        if (!p1 || !p2) {
          const [ox, oy] = point(get(line[1]));
          const v = rec(get(line[2]), 'VECTOR');
          const [dx, dy] = direction(get(v?.[1]));
          const m = num(v?.[2]);
          const at = (t: number): [number, number] => [ox + dx * m * t, oy + dy * m * t];
          p1 = p1 ?? at(param(trimmed[2]));
          p2 = p2 ?? at(param(trimmed[3]));
        }
        return [{ t: 'line', s, x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1] }];
      }
      return curveFeatures(basis, s, depth + 1);
    }
    const composite = rec(e, 'COMPOSITE_CURVE');
    if (composite) {
      const out: SxfFeature[] = [];
      for (const seg of refs(composite[1])) {
        const r = rec(seg, 'COMPOSITE_CURVE_SEGMENT') ?? rec(seg, 'REPARAMETRISED_COMPOSITE_CURVE_SEGMENT');
        if (r) out.push(...curveFeatures(get(r[2]), s, depth + 1));
      }
      return out;
    }
    const bs = rec(e, 'B_SPLINE_CURVE_WITH_KNOTS');
    const base = rec(e, 'B_SPLINE_CURVE');
    if (bs || base) {
      // 単純なインスタンスは (名前, 次数, 制御点, 形, 閉じ, 自己交差, 重複度, 節点, 節点の種類)。複合インスタンスは型ごとに分かれる
      const simple = bs && bs.length >= 9;
      const deg = num(simple ? bs[1] : base?.[0]);
      const ctrlRefs = refs(simple ? bs[2] : base?.[1]);
      const mults = (simple ? bs[6] : bs?.[0]) as StepValue[] | undefined;
      const knotVals = (simple ? bs[7] : bs?.[1]) as StepValue[] | undefined;
      const knots: number[] = [];
      if (Array.isArray(mults) && Array.isArray(knotVals)) {
        mults.forEach((m, k) => { for (let j = 0; j < Math.min(1000, num(m)); j++) knots.push(num(knotVals[k])); });
      }
      const w = rec(e, 'RATIONAL_B_SPLINE_CURVE')?.[0];
      const ctrl: number[] = [];
      for (const p of ctrlRefs.slice(0, 10_000)) ctrl.push(...point(p));
      return ctrl.length >= 4 ? [{
        t: 'bspline', s, degree: deg, ctrl, knots, weights: Array.isArray(w) ? w.map(num) : [],
      }] : [];
    }
    return [];
  };

  /** 文字 */
  const textOf = (e: StepEntity | undefined): SxfText | null => {
    const r = rec(e, 'TEXT_LITERAL_WITH_EXTENT') ?? rec(e, 'TEXT_LITERAL');
    if (!r) return null;
    const a = axis(get(r[2]));
    const ext = rec(get(r[6]), 'PLANAR_EXTENT');
    const fontEnt = get(r[5]);
    const fontName = str(rec(fontEnt, 'EXTERNALLY_DEFINED_TEXT_FONT')?.[0])
      || str(rec(fontEnt, 'DRAUGHTING_PRE_DEFINED_TEXT_FONT')?.[0]) || str(rec(fontEnt, 'PRE_DEFINED_TEXT_FONT')?.[0]);
    return {
      font: fontCode(fontName), text: str(r[1]), x: a.x, y: a.y,
      height: num(ext?.[2]), width: num(ext?.[1]), spacing: 0, angle: angleOf(a.ux, a.uy), slant: 0,
      bpnt: alignment(str(r[3])), direction: isEnum(r[4]) && r[4].enum === 'DOWN' ? 2 : 1,
    };
  };

  /** 記号（DEFINED_SYMBOL）の位置・向き・倍率と種類 */
  const symbolOf = (e: StepEntity | undefined): { kind: string; name: string; x: number; y: number; ux: number; uy: number; scale: number } | null => {
    const r = rec(e, 'DEFINED_SYMBOL');
    if (!r) return null;
    const def = get(r[1]);
    const t = rec(get(r[2]), 'SYMBOL_TARGET');
    const a = axis(get(t?.[1]));
    const kind = def ? [...def.records.keys()][0] : '';
    const name = def ? str([...def.records.values()][0][0]) : '';
    return { kind, name, x: a.x, y: a.y, ux: a.ux, uy: a.uy, scale: num(t?.[2]) };
  };

  // 複合図形（表現の番号ごとに 1 つ）
  const figureOfRep = new Map<number, SxfFigure>();
  const usedNames = new Set<string>();

  /** 置かれた表現を複合図形にする（中身は一度だけ写す） */
  const figureFor = (rep: StepEntity, kind: number, depth: number): SxfFigure => {
    let fig = figureOfRep.get(rep.id);
    if (fig) return fig;
    const r = [...rep.records.values()][0];
    let name = str(r?.[0]) || `#${rep.id}`;
    if (usedNames.has(name)) name = `${name}#${rep.id}`;
    usedNames.add(name);
    fig = { name, kind, features: [] };
    figureOfRep.set(rep.id, fig);
    doc.figures.set(name, fig);
    // 入れ子の深すぎる表現は中身を写さない（スタックを使い果たさないように）
    if (depth < MAX_REF_DEPTH) for (const it of refs(r?.[1])) convert(it, fig.features, false, 0, depth + 1);
    return fig;
  };

  /**
   * 置かれたもの（styled item・mapped item・callout）を図形にして out に積む。
   * top は用紙に直に置いたもの、layer は外側から受けたレイヤ
   */
  const convert = (e: StepEntity, out: SxfFeature[], top: boolean, layer: number, depth: number): void => {
    if (depth > MAX_REF_DEPTH) return;
    const own = layerOfItem.get(e.id) ?? layer;

    const mapped = rec(e, 'MAPPED_ITEM');
    if (mapped) {
      const map = get(mapped[1]);
      const mr = rec(map, 'SYMBOL_REPRESENTATION_MAP') ?? rec(map, 'REPRESENTATION_MAP');
      const rep = get(mr?.[1]);
      if (!rep) return;
      const origin = axis(get(mr?.[0]));
      const target = get(mapped[2]);
      const st = rec(target, 'SYMBOL_TARGET');
      const ta = axis(st ? get(st[1]) : target);
      const sx = st ? num(st[2]) : 1, sy = st ? num(st[3]) : 1;
      // 置く変換 = 目標の配置 ∘ 倍率 ∘ 元の配置の逆
      const kind = rep.records.has('DRAUGHTING_SYMBOL_REPRESENTATION') || rep.records.has('SYMBOL_REPRESENTATION')
        ? 4 : top && (Math.abs(sx - 1) > 1e-12 || Math.abs(sy - 1) > 1e-12) ? 1 : 3;
      const fig = figureFor(rep, kind, depth);
      const a = ta.ux * sx, b = ta.uy * sx, c = -ta.uy * sy, d = ta.ux * sy;
      // 元の配置の逆を掛ける（ふつうは原点・x 軸そのままなので何もしない）
      let x = ta.x, y = ta.y, ang = angleOf(ta.ux, ta.uy);
      if (origin.x !== 0 || origin.y !== 0 || origin.ux !== 1 || origin.uy !== 0) {
        const ox = origin.x * origin.ux + origin.y * origin.uy, oy = -origin.x * origin.uy + origin.y * origin.ux;
        x = ta.x - (a * ox + c * oy);
        y = ta.y - (b * ox + d * oy);
        ang -= angleOf(origin.ux, origin.uy);
      }
      out.push({ t: 'locate', layer: own, name: fig.name, x, y, angle: ang, rx: sx, ry: sy });
      return;
    }

    const callout = recOf(e, Object.keys(CALLOUTS));
    if (callout) {
      out.push(...calloutOf(e, callout[0], callout[1], own));
      return;
    }

    const set = rec(e, 'GEOMETRIC_CURVE_SET') ?? rec(e, 'GEOMETRIC_SET');
    if (set) {
      for (const it of refs(set[1])) out.push(...curveFeatures(it, styleOf(lookOf(undefined), own)));
      return;
    }

    const styled = recOf(e, STYLED);
    if (styled) {
      const [, p] = styled;
      const look = lookOf(p[1]);
      const item = get(p[2]);
      if (!item) return;
      const s = styleOf(look, own);
      const text = textOf(item);
      if (text) { out.push({ t: 'text', s, text }); return; }
      const fill = rec(item, 'ANNOTATION_FILL_AREA');
      if (fill) { const h = hatchOf(fill, p[1], own); if (h) out.push(h); return; }
      const sym = symbolOf(item);
      if (sym) {
        if (/EXTERNALLY_DEFINED/.test(sym.kind)) {
          out.push({ t: 'symbol', s, name: sym.name, x: sym.x, y: sym.y, angle: angleOf(sym.ux, sym.uy), scale: sym.scale });
        } else {
          out.push({ t: 'point', s, x: sym.x, y: sym.y, marker: markerCode(sym.name), angle: angleOf(sym.ux, sym.uy), scale: sym.scale });
        }
        return;
      }
      if (item.records.has('MAPPED_ITEM')) { convert(item, out, top, own, depth + 1); return; }
      out.push(...curveFeatures(item, s));
      return;
    }
    // 形だけ（属性なし）
    out.push(...curveFeatures(e, styleOf(lookOf(undefined), own)));
  };

  /** 寸法・引出し線 */
  const calloutOf = (e: StepEntity, type: string, params: StepValue[], layer: number): SxfFeature[] => {
    let kind = CALLOUTS[type];
    let s: SxfStyle | null = null;
    let line: number[] | null = null;
    let arc: Extract<SxfFeature, { t: 'dim' }>['arc'] = null;
    let circle: Extract<SxfFeature, { t: 'dim' }>['circle'] = null;
    const aux: number[][] = [];
    const arrows: SxfArrow[] = [];
    let text: SxfText | null = null;
    let lay = layer;
    for (const c of refs(params[1])) {
      const styled = recOf(c, STYLED);
      if (!styled) continue;
      const [ctype, p] = styled;
      if (!layerOfItem.has(e.id) && layerOfItem.has(c.id) && lay === layer) lay = layerOfItem.get(c.id)!;
      const item = get(p[2]);
      const t = textOf(item);
      if (t) { text = t; continue; }
      const sym = symbolOf(item);
      if (sym) {
        arrows.push({ code: 1, x: sym.x, y: sym.y, ux: sym.ux, uy: sym.uy, scale: sym.scale });
        continue;
      }
      const geo = curveFeatures(item, { layer, color: 0, ltype: 1, width: 0 });
      if (!geo.length) continue;
      const g = geo[0];
      if (ctype === 'PROJECTION_CURVE') {
        if (g.t === 'line') aux.push([g.x1, g.y1, g.x2, g.y2]);
        continue;
      }
      if (g.t === 'circle' && line) { circle = { x: g.x, y: g.y, r: g.r }; kind = 'balloon'; continue; }
      if (line || arc) continue;
      s = styleOf(lookOf(p[1]), layer);
      if (g.t === 'line') line = [g.x1, g.y1, g.x2, g.y2];
      else if (g.t === 'polyline') line = g.xy;
      else if (g.t === 'arc') arc = { x: g.x, y: g.y, r: g.r, start: g.dir === 1 ? g.end : g.start, end: g.dir === 1 ? g.start : g.end };
    }
    if (!s) return [];
    s.layer = lay;
    return [{ t: 'dim', kind, s, line, arc, aux, arrows, text, circle }];
  };

  /** ハッチング（ANNOTATION_FILL_AREA と FILL_AREA_STYLE） */
  const hatchOf = (fill: StepValue[], styles: StepValue | undefined, layer: number): SxfFeature | null => {
    const bounds = refs(fill[1]).map((b): SxfCompositeCurve => ({
      color: 0, ltype: 0, width: 0, visible: false, members: curveFeatures(b, { layer: 0, color: 0, ltype: 0, width: 0 }),
    }));
    if (!bounds.length) return null;
    let kind: 'external' | 'fill' | 'pattern' | 'tiles' = 'external';
    let color = 0;
    let name = '';
    const lines: SxfHatchLine[] = [];
    const seen = new Set<number>();
    const visit = (e: StepEntity | undefined, depth: number): void => {
      if (!e || seen.has(e.id) || depth > 8) return;
      seen.add(e.id);
      const c = rec(e, 'FILL_AREA_STYLE_COLOUR');
      if (c) { kind = 'fill'; color = colorOf(get(c[1])); return; }
      const h = rec(e, 'FILL_AREA_STYLE_HATCHING');
      if (h) {
        kind = 'pattern';
        const look = lookOf(h[1]);
        const repeat = rec(get(h[2]), 'ONE_DIRECTION_REPEAT_FACTOR');
        const vec = rec(get(repeat?.[1]), 'VECTOR');
        const [x, y] = point(get(h[3]));
        lines.push({ color: look.color, ltype: look.ltype, width: look.width, x, y, spacing: num(vec?.[2]), angle: toDeg(num(h[5])) });
        return;
      }
      const ext = rec(e, 'EXTERNALLY_DEFINED_HATCH_STYLE');
      if (ext) { name = str(ext[0]); return; }
      if (e.records.has('FILL_AREA_STYLE_TILES')) { kind = 'tiles'; return; }
      for (const params of e.records.values()) {
        for (const p of params) {
          for (const r of refs(p)) visit(r, depth + 1);
          if (Array.isArray(p)) for (const q of p) if (Array.isArray(q)) for (const r of refs(q)) visit(r, depth + 1);
        }
      }
    };
    for (const r of refs(styles)) visit(r, 0);
    return {
      t: 'hatch', kind, s: { layer, color, ltype: 1, width: 0 }, name,
      outer: bounds[0], holes: bounds.slice(1), lines,
    };
  };

  // 用紙
  let sheet: StepEntity | undefined;
  for (const e of ents.values()) if (e.records.has('DRAWING_SHEET_REVISION')) { sheet = e; break; }
  if (!sheet) {
    doc.warnings.push('用紙（DRAWING_SHEET_REVISION）が見つかりません');
    return doc;
  }
  const sr = rec(sheet, 'DRAWING_SHEET_REVISION')!;
  doc.sheetName = str(sr[0]);
  for (const e of ents.values()) {
    const ps = rec(e, 'PRESENTATION_SIZE');
    if (!ps || !isRef(ps[0]) || ps[0].ref !== sheet.id) continue;
    const box = rec(get(ps[1]), 'PLANAR_BOX');
    const w = num(box?.[1]), h = num(box?.[2]);
    if (w > 0 && h > 0) {
      const k = PAPER_MM.findIndex(([a, b]) => (Math.abs(a - w) < 0.5 && Math.abs(b - h) < 0.5) || (Math.abs(a - h) < 0.5 && Math.abs(b - w) < 0.5));
      doc.sheet = k >= 0 ? { type: k, orientation: w >= h ? 1 : 0, x: w, y: h } : { type: 9, orientation: 1, x: w, y: h };
    }
    break;
  }
  for (const it of refs(sr[1])) convert(it, doc.sheetFeatures, true, 0, 0);
  return doc;
}

/** AP202 の寄せ（'baseline left'、'centre centre'、'top right' など）を SXF の基点 1〜9 に */
export function alignment(name: string): number {
  const w = name.toLowerCase().split(/[\s_]+/).filter(Boolean);
  const vWord = w.length >= 2 ? w[0] : 'baseline';
  const hWord = w.length >= 2 ? w[1] : w[0] ?? 'left';
  const row = /top|cap/.test(vWord) ? 2 : /cent|middle|half/.test(vWord) ? 1 : 0;
  const col = /right/.test(hWord) ? 2 : /cent|middle/.test(hWord) ? 1 : 0;
  return row * 3 + col + 1;
}

/** 点の記号の名前を番号に（描き分けはしないので、見分けられれば何でもよい） */
function markerCode(name: string): number {
  const list = ['dot', 'x', 'plus', 'asterisk', 'ring', 'square', 'triangle'];
  return list.indexOf(name.toLowerCase()) + 1;
}

function clamp255(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 0;
}

