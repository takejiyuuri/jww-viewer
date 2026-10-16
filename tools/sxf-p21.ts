// 検証用：SxfDocument（SFC を読んだもの）を P21（AP202）に書き直す。ap202.ts と同じ対応表で書くので、
// 「SFC と P21 で同じ図面が同じ Scene になるか」で P21 の字句・構文・対応のつながりを確かめるのに使う
// （実際の SXF の P21 の書き方と同じかは、実データで確かめるまで分からない）。文字列の日本語は \X2\…\X0\ で書く
import { SXF_COLORS, SXF_LINE_TYPES, USER_COLOR_BASE, USER_LINE_TYPE_BASE } from '../src/sxf/colors.ts';
import type { SxfCompositeCurve, SxfDocument, SxfFeature, SxfStyle, SxfText } from '../src/sxf/types.ts';

/** 数を STEP の実数に（往復で同じ値になる書き方） */
const R = (n: number): string => (Number.isInteger(n) ? `${n}.` : String(n).replace(/^(-?)\./, '$10.'));
/** 文字列を STEP に（ASCII 以外は \X2\） */
function S(s: string): string {
  let out = '';
  let wide = '';
  const flush = (): void => { if (wide) { out += `\\X2\\${wide}\\X0\\`; wide = ''; } };
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x20 && c < 0x7f) {
      flush();
      out += ch === "'" ? "''" : ch === '\\' ? '\\\\' : ch;
    } else {
      wide += c.toString(16).toUpperCase().padStart(4, '0');
    }
  }
  flush();
  return `'${out}'`;
}

const ALIGN_ROW = ['baseline', 'centre', 'top'];
const ALIGN_COL = ['left', 'centre', 'right'];

export function writeP21(doc: SxfDocument): Uint8Array {
  const lines: string[] = [];
  let next = 1;
  const add = (body: string): string => { const id = `#${next++}`; lines.push(`${id}=${body};`); return id; };
  const reserve = (): string => `#${next++}`;
  const put = (id: string, body: string): void => { lines.push(`${id}=${body};`); };

  add("CONVERSION_BASED_UNIT('DEGREE',$)");
  const ctx = add("GEOMETRIC_REPRESENTATION_CONTEXT('','2D',2)");
  const origin = add(`AXIS2_PLACEMENT_2D('',${add(`CARTESIAN_POINT('',(0.,0.))`)},${add(`DIRECTION('',(1.,0.))`)})`);
  const userColors = doc.userColors.map((c) => add(`COLOUR_RGB('',${c.map((v) => R(v / 255)).join(',')})`));
  const userFonts = doc.userLineTypes.map((t) => {
    const pats: string[] = [];
    for (let k = 0; k + 1 < t.pitch.length; k += 2) pats.push(add(`CURVE_STYLE_FONT_PATTERN(${R(Math.abs(t.pitch[k]))},${R(Math.abs(t.pitch[k + 1]))})`));
    return add(`CURVE_STYLE_FONT(${S(t.name)},(${pats.join(',')}))`);
  });
  const colorCache = new Map<number, string>();
  const colour = (code: number): string => {
    let id = colorCache.get(code);
    if (!id) {
      id = code >= USER_COLOR_BASE ? userColors[code - USER_COLOR_BASE]
        : add(`DRAUGHTING_PRE_DEFINED_COLOUR(${S(SXF_COLORS[(code >= 1 && code <= 16 ? code : 8) - 1].name)})`);
      colorCache.set(code, id);
    }
    return id;
  };
  const fontCache = new Map<number, string>();
  const curveFont = (code: number): string => {
    let id = fontCache.get(code);
    if (!id) {
      id = code >= USER_LINE_TYPE_BASE ? userFonts[code - USER_LINE_TYPE_BASE]
        : add(`DRAUGHTING_PRE_DEFINED_CURVE_FONT(${S(SXF_LINE_TYPES[(code >= 1 && code <= 15 ? code : 1) - 1].name)})`);
      fontCache.set(code, id);
    }
    return id;
  };
  const curveStyle = (color: number, ltype: number, width: number): string =>
    add(`CURVE_STYLE('',${curveFont(ltype)},POSITIVE_LENGTH_MEASURE(${R(doc.widths.get(width) ?? 0.25)}),${colour(color)})`);
  const psaCurve = (s: SxfStyle): string => add(`PRESENTATION_STYLE_ASSIGNMENT((${curveStyle(s.color, s.ltype, s.width)}))`);
  const psaText = (s: SxfStyle): string => add(`PRESENTATION_STYLE_ASSIGNMENT((${add(`TEXT_STYLE('',${add(`TEXT_STYLE_FOR_DEFINED_FONT(${colour(s.color)})`)})`)}))`);
  const psaSymbol = (s: SxfStyle): string => add(`PRESENTATION_STYLE_ASSIGNMENT((${add(`SYMBOL_STYLE('',${add(`SYMBOL_COLOUR(${colour(s.color)})`)})`)}))`);
  const pt = (x: number, y: number): string => add(`CARTESIAN_POINT('',(${R(x)},${R(y)}))`);
  const dirOf = (x: number, y: number): string => add(`DIRECTION('',(${R(x)},${R(y)}))`);
  const axis = (x: number, y: number, deg: number): string => {
    const a = (deg * Math.PI) / 180;
    return add(`AXIS2_PLACEMENT_2D('',${pt(x, y)},${dirOf(deg === 0 ? 1 : Math.cos(a), deg === 0 ? 0 : Math.sin(a))})`);
  };
  const polyline = (xy: number[]): string => {
    const ps: string[] = [];
    for (let i = 0; i + 1 < xy.length; i += 2) ps.push(pt(xy[i], xy[i + 1]));
    return add(`POLYLINE('',(${ps.join(',')}))`);
  };
  const trimmed = (basis: string, start: number, end: number, dir: number): string =>
    add(`TRIMMED_CURVE('',${basis},(PARAMETER_VALUE(${R(start)})),(PARAMETER_VALUE(${R(end)})),${dir === 1 ? '.F.' : '.T.'},.PARAMETER.)`);
  /** 形（曲線）。描かない種類は null */
  const curve = (f: SxfFeature): string | null => {
    switch (f.t) {
      case 'line': return polyline([f.x1, f.y1, f.x2, f.y2]);
      case 'polyline': return polyline(f.xy);
      case 'circle': return add(`CIRCLE('',${axis(f.x, f.y, 0)},${R(f.r)})`);
      case 'ellipse': return add(`ELLIPSE('',${axis(f.x, f.y, f.rot)},${R(f.rx)},${R(f.ry)})`);
      case 'arc': return trimmed(add(`CIRCLE('',${axis(f.x, f.y, 0)},${R(f.r)})`), f.start, f.end, f.dir);
      case 'ellipseArc': return trimmed(add(`ELLIPSE('',${axis(f.x, f.y, f.rot)},${R(f.rx)},${R(f.ry)})`), f.start, f.end, f.dir);
      default: return null;
    }
  };
  const textLiteral = (t: SxfText): string => {
    const font = add(`EXTERNALLY_DEFINED_TEXT_FONT(${S(doc.fonts[t.font - 1] ?? '')},$)`);
    const row = Math.min(2, Math.max(0, Math.floor((t.bpnt - 1) / 3))), col = ((t.bpnt - 1) % 3 + 3) % 3;
    return add(`TEXT_LITERAL_WITH_EXTENT('',${S(t.text)},${axis(t.x, t.y, t.angle)},'${ALIGN_ROW[row]} ${ALIGN_COL[col]}',`
      + `${t.direction === 2 ? '.DOWN.' : '.RIGHT.'},${font},${add(`PLANAR_EXTENT('',${R(t.width)},${R(t.height)})`)})`);
  };
  const composite = (c: SxfCompositeCurve): string => {
    const segs = c.members.map(curve).filter((x): x is string => !!x)
      .map((m) => add(`COMPOSITE_CURVE_SEGMENT(.CONTINUOUS.,.T.,${m})`));
    return add(`COMPOSITE_CURVE('',(${segs.join(',')}),.F.)`);
  };

  // レイヤごとの置いたもの
  const layered: string[][] = doc.layers.map(() => []);
  const onLayer = (id: string, code: number): string => { if (code >= 1 && code <= layered.length) layered[code - 1].push(id); return id; };

  const reps = new Map<string, string>();
  const items = (list: SxfFeature[]): string[] => list.flatMap((f) => item(f));
  const item = (f: SxfFeature): string[] => {
    switch (f.t) {
      case 'text':
        return [onLayer(add(`ANNOTATION_TEXT_OCCURRENCE('',(${psaText(f.s)}),${textLiteral(f.text)})`), f.s.layer)];
      case 'point':
      case 'symbol': {
        const def = f.t === 'point' ? add("PRE_DEFINED_POINT_MARKER_SYMBOL('dot')") : add(`EXTERNALLY_DEFINED_SYMBOL(${S(f.name)},$)`);
        const target = add(`SYMBOL_TARGET('',${axis(f.x, f.y, f.angle)},${R(f.scale)},${R(f.scale)})`);
        return [onLayer(add(`ANNOTATION_SYMBOL_OCCURRENCE('',(${psaSymbol(f.s)}),${add(`DEFINED_SYMBOL('',${def},${target})`)})`), f.s.layer)];
      }
      case 'locate': {
        const fig = doc.figures.get(f.name);
        if (!fig) return [];
        let rep = reps.get(f.name);
        if (!rep) {
          rep = reserve();
          reps.set(f.name, rep);
          const inner = items(fig.features);
          put(rep, `${fig.kind === 4 ? 'DRAUGHTING_SYMBOL_REPRESENTATION' : 'DRAUGHTING_SUBFIGURE_REPRESENTATION'}(${S(fig.name)},(${inner.join(',')}),${ctx})`);
        }
        const map = add(`SYMBOL_REPRESENTATION_MAP(${origin},${rep})`);
        const target = add(`SYMBOL_TARGET('',${axis(f.x, f.y, f.angle)},${R(f.rx)},${R(f.ry)})`);
        return [onLayer(add(`MAPPED_ITEM('',${map},${target})`), f.layer)];
      }
      case 'dim': {
        const psa = psaCurve(f.s);
        const contents: string[] = [];
        const leader = f.kind === 'label' || f.kind === 'balloon';
        let main = '';
        if (f.line) main = add(`${leader ? 'LEADER_CURVE' : 'DIMENSION_CURVE'}('',(${psa}),${polyline(f.line)})`);
        if (f.arc) {
          main = add(`DIMENSION_CURVE('',(${psa}),${trimmed(add(`CIRCLE('',${axis(f.arc.x, f.arc.y, 0)},${R(f.arc.r)})`), f.arc.start, f.arc.end, 0)})`);
        }
        if (main) contents.push(main);
        if (f.circle) contents.push(add(`ANNOTATION_CURVE_OCCURRENCE('',(${psa}),${add(`CIRCLE('',${axis(f.circle.x, f.circle.y, 0)},${R(f.circle.r)})`)})`));
        for (const a of f.aux) contents.push(add(`PROJECTION_CURVE('',(${psa}),${polyline(a)})`));
        for (const ar of f.arrows) {
          const target = add(`SYMBOL_TARGET('',${add(`AXIS2_PLACEMENT_2D('',${pt(ar.x, ar.y)},${dirOf(ar.ux, ar.uy)})`)},${R(ar.scale)},${R(ar.scale)})`);
          const sym = add(`DEFINED_SYMBOL('',${add("PRE_DEFINED_TERMINATOR_SYMBOL('open arrow')")},${target})`);
          contents.push(add(`${leader ? 'LEADER_TERMINATOR' : 'DIMENSION_CURVE_TERMINATOR'}('',(${psa}),${sym},${main || '$'},.DIMENSION_VALUE_PLACEMENT.)`));
        }
        if (f.text) contents.push(add(`ANNOTATION_TEXT_OCCURRENCE('',(${psaText(f.s)}),${textLiteral(f.text)})`));
        const type = { linear: 'LINEAR_DIMENSION', curve: 'CURVE_DIMENSION', angular: 'ANGULAR_DIMENSION', radius: 'RADIUS_DIMENSION', diameter: 'DIAMETER_DIMENSION', label: 'LEADER_DIRECTED_CALLOUT', balloon: 'LEADER_DIRECTED_CALLOUT' }[f.kind];
        return [onLayer(add(`${type}('',(${contents.join(',')}))`), f.s.layer)];
      }
      case 'hatch': {
        const out: string[] = [];
        // 見える境界は、同じ複合曲線を線として置く
        for (const c of [f.outer, ...f.holes]) {
          if (c.visible) out.push(onLayer(add(`ANNOTATION_CURVE_OCCURRENCE('',(${psaCurve({ layer: f.s.layer, color: c.color, ltype: c.ltype, width: c.width })}),${composite(c)})`), f.s.layer));
        }
        const bounds = [f.outer, ...f.holes].map(composite);
        let styles: string[] = [];
        if (f.kind === 'fill') styles = [add(`FILL_AREA_STYLE_COLOUR('',${colour(f.s.color)})`)];
        else if (f.kind === 'pattern') {
          styles = f.lines.map((l) => {
            const a = (l.angle * Math.PI) / 180;
            const repeat = add(`ONE_DIRECTION_REPEAT_FACTOR('',${add(`VECTOR('',${dirOf(-Math.sin(a), Math.cos(a))},${R(l.spacing)})`)})`);
            const p = pt(l.x, l.y);
            return add(`FILL_AREA_STYLE_HATCHING('',${curveStyle(l.color, l.ltype, l.width)},${repeat},${p},${p},${R(l.angle)})`);
          });
        } else if (f.kind === 'external') styles = [add(`EXTERNALLY_DEFINED_HATCH_STYLE(${S(f.name)},$)`)];
        else styles = [add("FILL_AREA_STYLE_TILES('',(),1.)")];
        const fas = add(`FILL_AREA_STYLE('',(${styles.join(',')}))`);
        const area = add(`ANNOTATION_FILL_AREA('',(${bounds.join(',')}))`);
        out.push(onLayer(add(`ANNOTATION_FILL_AREA_OCCURRENCE('',(${add(`PRESENTATION_STYLE_ASSIGNMENT((${fas}))`)}),${area})`), f.s.layer));
        return out;
      }
      default: {
        const c = curve(f);
        if (!c || !('s' in f)) return [];
        return [onLayer(add(`ANNOTATION_CURVE_OCCURRENCE('',(${psaCurve(f.s)}),${c})`), f.s.layer)];
      }
    }
  };

  const top = items(doc.sheetFeatures);
  const sheet = add(`DRAWING_SHEET_REVISION(${S(doc.sheetName)},(${top.join(',')}),${ctx},'1')`);
  if (doc.sheet) {
    const size = [0, 1, 2, 3, 4].includes(doc.sheet.type)
      ? ([[1189, 841], [841, 594], [594, 420], [420, 297], [297, 210]][doc.sheet.type])
      : [doc.sheet.x, doc.sheet.y];
    const [w, h] = doc.sheet.type <= 4 && doc.sheet.orientation === 0 ? [size[1], size[0]] : size;
    add(`PRESENTATION_SIZE(${sheet},${add(`PLANAR_BOX('',${R(w)},${R(h)},${origin})`)})`);
  }
  const layerIds = doc.layers.map((l, k) => add(`PRESENTATION_LAYER_ASSIGNMENT(${S(l.name)},'',(${layered[k].join(',')}))`));
  const hidden = layerIds.filter((_, k) => !doc.layers[k].visible);
  if (hidden.length) add(`INVISIBILITY((${hidden.join(',')}))`);

  const text = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('SCADEC level2 AP202 mode'),'2;1');",
    "FILE_NAME('synth.p21','2026-10-16T12:00:00',(''),(''),'SCADEC_API_Ver3.30$$3.1','sxf-p21','');",
    "FILE_SCHEMA(('ASSOCIATIVE_DRAUGHTING'));",
    'ENDSEC;',
    'DATA;',
    ...lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\r\n');
  return new TextEncoder().encode(text);
}
