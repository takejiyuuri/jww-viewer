/**
 * DXF（ASCII）を読む。段は HEADER・TABLES（LAYER・LTYPE）・BLOCKS・ENTITIES だけを見る。
 * 図形は LINE・POINT・CIRCLE・ARC・ELLIPSE・LWPOLYLINE・POLYLINE（2 次元）・TEXT・MTEXT・ATTRIB・ATTDEF（定数）・
 * SOLID・TRACE・3DFACE・INSERT（MINSERT）・DIMENSION・SPLINE・HATCH・LEADER・XLINE・RAY を読み、
 * ほかの種類は数だけ数えて読み飛ばす
 */
import { decodeDxf, tokenize, type DxfPairs } from './tokenize.ts';
import { decodeText, parseMtext } from './mtext.ts';
import type {
  DxfBlock, DxfCommon, DxfDocument, DxfEntity, DxfHatch, DxfInsert, DxfLayer, DxfLineType, DxfText, HatchEdge,
  HatchLoop, HatchPatternLine,
} from './types.ts';

export { decodeText };

/** 黙って読み飛ばす種類（描くものがない、または別の図形の一部） */
const SILENT = new Set(['VIEWPORT', 'SEQEND', 'VERTEX', 'ENDBLK', 'ATTDEF']);

/** MINSERT の行 × 列の上限 */
export const MAX_GRID = 10_000;
/** SPLINE の制御点の上限 */
export const MAX_SPLINE_POINTS = 10_000;
/** HATCH の境界の頂点の上限（図面全体） */
export const MAX_HATCH_VERTICES = 1_000_000;

/** 数として読む。読めなければ NaN（座標なら Builder が捨てる） */
function num(v: string): number {
  return Number.parseFloat(v);
}

/** 整数として読む。読めなければ fallback */
function int(v: string, fallback: number): number {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function parseDxf(buffer: ArrayBuffer): DxfDocument {
  const { text, encoding } = decodeDxf(buffer);
  const p = tokenize(text);
  const doc: DxfDocument = {
    version: '', encoding, insunits: 0, measurement: -1, extents: null, arrowSize: NaN,
    layers: [], ltypes: new Map(), blocks: new Map(), entities: [],
    skipped: new Map(), paperSpace: 0, warnings: [],
  };
  const reader = new Reader(p, doc);
  let sections = 0;
  let i = 0;
  while (i < p.count) {
    if (p.codes[i] === 0 && p.values[i].trim() === 'SECTION') {
      const name = p.codes[i + 1] === 2 ? p.values[i + 1].trim() : '';
      let end = i + 1;
      while (end < p.count && !(p.codes[end] === 0 && p.values[end].trim() === 'ENDSEC')) end++;
      sections++;
      if (name === 'HEADER') reader.header(i + 2, end);
      else if (name === 'TABLES') reader.tables(i + 2, end);
      else if (name === 'BLOCKS') reader.blocks(i + 2, end);
      else if (name === 'ENTITIES') doc.entities = reader.entities(i + 2, end, true);
      i = end + 1;
      continue;
    }
    if (p.codes[i] === 0 && p.values[i].trim() === 'EOF') break;
    i++;
  }
  if (sections === 0) throw new Error('DXF の形式が読めません');
  return doc;
}

class Reader {
  private p: DxfPairs;
  private doc: DxfDocument;
  /** 読んだ HATCH の境界の頂点の数（図面全体） */
  private hatchVertices = 0;

  constructor(p: DxfPairs, doc: DxfDocument) {
    this.p = p;
    this.doc = doc;
  }

  private code(i: number): number {
    return this.p.codes[i];
  }

  private value(i: number): string {
    return this.p.values[i];
  }

  /** i の次の、コード 0 の位置（図形・表の項目の終わり） */
  private next(i: number, end: number): number {
    let j = i + 1;
    while (j < end && this.p.codes[j] !== 0) j++;
    return j;
  }

  header(start: number, end: number): void {
    const doc = this.doc;
    let name = '';
    let minX = NaN, minY = NaN, maxX = NaN, maxY = NaN;
    let dimasz = NaN, dimscale = 1;
    for (let i = start; i < end; i++) {
      const c = this.code(i);
      const v = this.value(i).trim();
      if (c === 9) { name = v; continue; }
      if (name === '$ACADVER' && c === 1) doc.version = v;
      else if (name === '$INSUNITS' && c === 70) doc.insunits = int(v, 0);
      else if (name === '$MEASUREMENT' && c === 70) doc.measurement = int(v, -1);
      else if (name === '$EXTMIN' && c === 10) minX = num(v);
      else if (name === '$EXTMIN' && c === 20) minY = num(v);
      else if (name === '$EXTMAX' && c === 10) maxX = num(v);
      else if (name === '$EXTMAX' && c === 20) maxY = num(v);
      else if (name === '$DIMASZ' && c === 40) dimasz = num(v);
      else if (name === '$DIMSCALE' && c === 40) dimscale = num(v) > 0 ? num(v) : 1;
    }
    if (dimasz > 0) doc.arrowSize = dimasz * dimscale;
    // 図形のない図面では $EXTMIN が $EXTMAX より大きい（1e20 と -1e20）ので使わない
    if (minX <= maxX && minY <= maxY && Math.abs(minX) < 1e15 && Math.abs(maxX) < 1e15) {
      doc.extents = { minX, minY, maxX, maxY };
    }
  }

  tables(start: number, end: number): void {
    for (let i = start; i < end;) {
      const j = this.next(i, end);
      if (this.code(i) === 0) {
        const kind = this.value(i).trim();
        if (kind === 'LAYER') this.layer(i, j);
        else if (kind === 'LTYPE') this.ltype(i, j);
      }
      i = j;
    }
  }

  private layer(i: number, j: number): void {
    const l: DxfLayer = { name: '', color: 7, trueColor: -1, ltype: 'CONTINUOUS', frozen: false };
    for (let k = i + 1; k < j; k++) {
      const v = this.value(k);
      switch (this.code(k)) {
        case 2: l.name = v.trim(); break;
        case 62: l.color = int(v, 7); break;
        case 420: l.trueColor = int(v, -1) & 0xffffff; break;
        case 6: l.ltype = v.trim(); break;
        case 70: l.frozen = (int(v, 0) & 1) !== 0; break;
      }
    }
    if (l.name && !this.doc.layers.some((x) => x.name.toUpperCase() === l.name.toUpperCase())) this.doc.layers.push(l);
  }

  private ltype(i: number, j: number): void {
    const t: DxfLineType = { name: '', description: '', pattern: [] };
    for (let k = i + 1; k < j; k++) {
      const v = this.value(k);
      switch (this.code(k)) {
        case 2: t.name = v.trim(); break;
        case 3: t.description = v.trim(); break;
        case 49: t.pattern.push(num(v)); break;
      }
    }
    if (t.name) this.doc.ltypes.set(t.name.toUpperCase(), t);
  }

  blocks(start: number, end: number): void {
    for (let i = start; i < end;) {
      const j = this.next(i, end);
      if (this.code(i) === 0 && this.value(i).trim() === 'BLOCK') {
        const b: DxfBlock = { name: '', x: 0, y: 0, entities: [] };
        let xref = false;
        for (let k = i + 1; k < j; k++) {
          const v = this.value(k);
          switch (this.code(k)) {
            case 2: b.name = v.trim(); break;
            case 10: b.x = num(v); break;
            case 20: b.y = num(v); break;
            case 70: xref = (int(v, 0) & 4) !== 0; break;
          }
        }
        // 中身は ENDBLK まで
        let e = j;
        while (e < end && !(this.code(e) === 0 && this.value(e).trim() === 'ENDBLK')) e++;
        if (!xref) b.entities = this.entities(j, e, false);
        if (b.name) this.doc.blocks.set(b.name.toUpperCase(), b);
        i = e;
        continue;
      }
      i = j;
    }
  }

  /** start〜end の図形を読む。top はモデル空間の図形の一覧か（ペーパー空間の図形を数える） */
  entities(start: number, end: number, top: boolean): DxfEntity[] {
    const out: DxfEntity[] = [];
    /** 直前の INSERT（続く ATTRIB をつなぐ先）。ほかの図形が来たら切る */
    let lastInsert: DxfInsert | null = null;
    for (let i = start; i < end;) {
      const j = this.next(i, end);
      if (this.code(i) !== 0) { i = j; continue; }
      const type = this.value(i).trim();
      if (type !== 'ATTRIB' && type !== 'SEQEND') lastInsert = null;
      const common = this.common(i, j);
      if (common.paper) {
        if (top && type !== 'ATTRIB' && type !== 'SEQEND') this.doc.paperSpace++;
        i = type === 'POLYLINE' ? this.skipSeq(j, end) : j;
        continue;
      }
      const c = common.c;
      switch (type) {
        case 'LINE': {
          const f = this.fields(i, j);
          out.push({ ...c, type, x1: f(10), y1: f(20), x2: f(11), y2: f(21) });
          break;
        }
        case 'POINT': {
          const f = this.fields(i, j);
          out.push({ ...c, type, x: f(10), y: f(20) });
          break;
        }
        case 'CIRCLE': {
          const f = this.fields(i, j);
          out.push({ ...c, type, x: f(10), y: f(20), r: f(40) });
          break;
        }
        case 'ARC': {
          const f = this.fields(i, j);
          out.push({ ...c, type, x: f(10), y: f(20), r: f(40), start: f(50, 0), end: f(51, 360) });
          break;
        }
        case 'ELLIPSE': {
          const f = this.fields(i, j);
          out.push({
            ...c, type, x: f(10), y: f(20), mx: f(11), my: f(21), mz: f(31, 0), ratio: f(40, 1),
            start: f(41, 0), end: f(42, Math.PI * 2),
          });
          break;
        }
        case 'LWPOLYLINE': {
          const xy: number[] = [];
          const bulge: number[] = [];
          let closed = false;
          for (let k = i + 1; k < j; k++) {
            const v = this.value(k);
            switch (this.code(k)) {
              case 70: closed = (int(v, 0) & 1) !== 0; break;
              case 10: xy.push(num(v), NaN); bulge.push(0); break;
              case 20: if (xy.length) xy[xy.length - 1] = num(v); break;
              case 42: if (bulge.length) bulge[bulge.length - 1] = num(v); break;
            }
          }
          if (xy.length >= 4) out.push({ ...c, type: 'POLYLINE', xy, bulge, closed });
          break;
        }
        case 'POLYLINE': {
          const flags = int(this.fieldText(i, j, 70) ?? '0', 0);
          const xy: number[] = [];
          const bulge: number[] = [];
          let k = j;
          // 続く VERTEX を SEQEND まで読む
          while (k < end && this.code(k) === 0 && this.value(k).trim() === 'VERTEX') {
            const kj = this.next(k, end);
            const f = this.fields(k, kj);
            const vflags = f(70, 0);
            // スプラインの制御点（16）と多面体の面（128 で座標のないもの）は頂点ではない
            if (!(vflags & 16) && !((vflags & 128) && !(vflags & 64))) {
              xy.push(f(10), f(20));
              bulge.push(f(42, 0));
            }
            k = kj;
          }
          if (k < end && this.code(k) === 0 && this.value(k).trim() === 'SEQEND') k = this.next(k, end);
          if (flags & (16 | 64)) {
            // 3 次元のメッシュ・多面体は描かない
            this.skip('POLYLINE（メッシュ）');
          } else if (xy.length >= 4) {
            out.push({ ...c, type, xy, bulge, closed: (flags & 1) !== 0 });
          }
          i = k;
          continue;
        }
        case 'TEXT': {
          out.push(this.text(i, j, c, 73));
          break;
        }
        case 'ATTRIB': {
          // 見えない属性（70 の 1）は描かない
          const t = this.text(i, j, c, 74);
          if (lastInsert && !(int(this.fieldText(i, j, 70) ?? '0', 0) & 1)) lastInsert.attribs.push(t);
          break;
        }
        case 'ATTDEF': {
          // 定数の属性（70 の 2）だけは部品の中の文字として描く。ほかは配置のときの ATTRIB が描く
          const flags = int(this.fieldText(i, j, 70) ?? '0', 0);
          if ((flags & 2) && !(flags & 1)) out.push(this.text(i, j, c, 74));
          break;
        }
        case 'MTEXT': {
          const f = this.fields(i, j);
          let raw = '';
          let last = '';
          for (let k = i + 1; k < j; k++) {
            if (this.code(k) === 3) raw += this.value(k);
            else if (this.code(k) === 1) last = this.value(k);
          }
          raw += last;
          const height = f(40, 1);
          const dx = f(11), dy = f(21);
          const rotation = Number.isFinite(dx) && Number.isFinite(dy) && (dx !== 0 || dy !== 0)
            ? (Math.atan2(dy, dx) * 180) / Math.PI
            : f(50, 0);
          out.push({
            ...c, type, x: f(10), y: f(20), height, width: f(41, 0), attach: f(71, 1), rotation,
            spacing: f(44, 1), lines: parseMtext(raw, height),
          });
          break;
        }
        case 'SOLID':
        case 'TRACE': {
          const f = this.fields(i, j);
          // SOLID の 3 点目と 4 点目は外周の順と逆に並ぶ。3 角形では 4 点目が 3 点目と同じ
          const pts = [f(10), f(20), f(11), f(21), f(13, f(12)), f(23, f(22)), f(12), f(22)];
          out.push({ ...c, type: 'SOLID', pts });
          break;
        }
        case '3DFACE': {
          const f = this.fields(i, j);
          const pts = [f(10), f(20), f(11), f(21), f(12), f(22), f(13, f(12)), f(23, f(22))];
          out.push({ ...c, type, pts, hidden: f(70, 0) });
          break;
        }
        case 'INSERT': {
          const f = this.fields(i, j);
          const ins: DxfInsert = {
            ...c, type, block: this.fieldText(i, j, 2)?.trim() ?? '', x: f(10), y: f(20),
            sx: f(41, 1), sy: f(42, 1), rotation: f(50, 0),
            cols: Math.max(1, Math.floor(f(70, 1))), rows: Math.max(1, Math.floor(f(71, 1))),
            colSpacing: f(44, 0), rowSpacing: f(45, 0), attribs: [],
          };
          out.push(ins);
          lastInsert = ins;
          break;
        }
        case 'DIMENSION': {
          const f = this.fields(i, j);
          out.push({
            ...c, type, block: this.fieldText(i, j, 2)?.trim() ?? '', x: f(10), y: f(20),
            x3: f(13), y3: f(23), x4: f(14), y4: f(24), measurement: f(42), dimType: f(70, 0) & 7,
            text: this.fieldText(i, j, 1) ?? '',
          });
          break;
        }
        case 'SPLINE': {
          const f = this.fields(i, j);
          const knots: number[] = [], weights: number[] = [], ctrl: number[] = [], fit: number[] = [];
          for (let k = i + 1; k < j; k++) {
            const v = num(this.value(k));
            switch (this.code(k)) {
              case 40: knots.push(v); break;
              case 41: weights.push(v); break;
              case 10: ctrl.push(v, NaN); break;
              case 20: if (ctrl.length) ctrl[ctrl.length - 1] = v; break;
              case 11: fit.push(v, NaN); break;
              case 21: if (fit.length) fit[fit.length - 1] = v; break;
            }
          }
          if (ctrl.length / 2 > MAX_SPLINE_POINTS || fit.length / 2 > MAX_SPLINE_POINTS) {
            this.skip('SPLINE（制御点が多すぎる）');
            break;
          }
          out.push({ ...c, type, degree: f(71, 3), closed: (f(70, 0) & 1) !== 0, knots, weights, ctrl, fit });
          break;
        }
        case 'HATCH': {
          const h = this.hatch(i, j, c);
          if (h) out.push(h);
          break;
        }
        case 'LEADER': {
          const f = this.fields(i, j);
          const xy: number[] = [];
          for (let k = i + 1; k < j; k++) {
            if (this.code(k) === 10) xy.push(num(this.value(k)), NaN);
            else if (this.code(k) === 20 && xy.length) xy[xy.length - 1] = num(this.value(k));
          }
          if (xy.length >= 4) out.push({ ...c, type, xy, arrow: f(71, 1) !== 0, spline: f(72, 0) === 1 });
          break;
        }
        case 'XLINE':
        case 'RAY': {
          const f = this.fields(i, j);
          out.push({ ...c, type, x: f(10), y: f(20), dx: f(11), dy: f(21) });
          break;
        }
        default:
          if (!SILENT.has(type)) this.skip(type);
      }
      i = j;
    }
    return out;
  }

  /** TEXT・ATTRIB・ATTDEF。vcode は縦の寄せのコード（TEXT は 73、属性は 74） */
  private text(i: number, j: number, c: DxfCommon, vcode: number): DxfText {
    const f = this.fields(i, j);
    return {
      ...c, type: 'TEXT', x: f(10), y: f(20), height: f(40), rotation: f(50, 0), widthFactor: f(41, 1),
      text: decodeText(this.fieldText(i, j, 1) ?? ''),
      halign: f(72, 0), valign: f(vcode, 0), x2: f(11), y2: f(21),
    };
  }

  /** HATCH を読む。境界と模様の線はコードの並びの順に読む */
  private hatch(i: number, j: number, c: DxfCommon): DxfHatch | null {
    let k = i + 1;
    let solid = false;
    // 境界の数（91）まで
    let loopsLeft = 0;
    for (; k < j; k++) {
      const code = this.code(k);
      if (code === 70) solid = int(this.value(k), 0) === 1;
      else if (code === 91) { loopsLeft = int(this.value(k), 0); k++; break; }
    }
    const at = (n: number): number => num(this.value(n));
    const loops: HatchLoop[] = [];
    let vertices = 0;
    while (loopsLeft-- > 0 && k < j) {
      while (k < j && this.code(k) !== 92) k++;
      if (k >= j) break;
      const flags = int(this.value(k), 0);
      k++;
      if (flags & 2) {
        // 折れ線の境界：72 ふくらみの有無、73 閉じ、93 頂点の数、10/20(/42)
        const xy: number[] = [], bulge: number[] = [];
        let count = 0;
        for (; k < j; k++) {
          const code = this.code(k);
          if (code === 93) count = int(this.value(k), 0);
          else if (code === 10) { if (xy.length / 2 >= count) break; xy.push(at(k), NaN); bulge.push(0); }
          else if (code === 20) { if (xy.length) xy[xy.length - 1] = at(k); }
          else if (code === 42) { if (bulge.length) bulge[bulge.length - 1] = at(k); }
          else if (code !== 72 && code !== 73) break;
        }
        vertices += xy.length / 2;
        loops.push({ poly: { xy, bulge } });
      } else {
        // 辺の並び：93 辺の数、辺ごとに 72 種類
        let count = 0;
        if (this.code(k) === 93) { count = int(this.value(k), 0); k++; }
        const edges: HatchEdge[] = [];
        for (let e = 0; e < count && k < j; e++) {
          if (this.code(k) !== 72) break;
          const kind = int(this.value(k), 0);
          k++;
          /** 決まった数の組を読んでコードごとに引く */
          const take = (n: number): ((code: number, fb?: number) => number) => {
            const m = new Map<number, number>();
            for (let q = 0; q < n && k < j; q++, k++) if (!m.has(this.code(k))) m.set(this.code(k), at(k));
            return (code, fb = NaN) => m.get(code) ?? fb;
          };
          if (kind === 1) {
            const g = take(4);
            edges.push({ kind: 'line', x1: g(10), y1: g(20), x2: g(11), y2: g(21) });
          } else if (kind === 2) {
            const g = take(6);
            edges.push({ kind: 'arc', cx: g(10), cy: g(20), r: g(40), start: g(50, 0), end: g(51, 360), ccw: g(73, 1) !== 0 });
          } else if (kind === 3) {
            const g = take(8);
            edges.push({
              kind: 'ellipse', cx: g(10), cy: g(20), mx: g(11), my: g(21), ratio: g(40, 1),
              start: g(50, 0), end: g(51, 360), ccw: g(73, 1) !== 0,
            });
          } else if (kind === 4) {
            const edge = this.hatchSpline(k, j);
            k = edge.k;
            vertices += edge.edge.ctrl.length / 2 + edge.edge.fit.length / 2;
            edges.push(edge.edge);
          } else {
            break;
          }
        }
        vertices += edges.length;
        loops.push({ edges });
      }
      // 元の図形への参照（97 の数だけ 330）
      if (k < j && this.code(k) === 97) {
        k++;
        while (k < j && this.code(k) === 330) k++;
      }
    }
    // 模様の線（53 角度、43/44 基点、45/46 ずれ、49 破線）
    const pattern: HatchPatternLine[] = [];
    let cur: HatchPatternLine | null = null;
    for (; k < j; k++) {
      const code = this.code(k);
      if (code === 98) break;
      if (code === 53) { cur = { angle: at(k), x: 0, y: 0, dx: 0, dy: 0, dashes: [] }; pattern.push(cur); continue; }
      if (!cur) continue;
      if (code === 43) cur.x = at(k);
      else if (code === 44) cur.y = at(k);
      else if (code === 45) cur.dx = at(k);
      else if (code === 46) cur.dy = at(k);
      else if (code === 49) cur.dashes.push(at(k));
    }
    this.hatchVertices += vertices;
    if (this.hatchVertices > MAX_HATCH_VERTICES) {
      this.skip('HATCH（境界の頂点が多すぎる）');
      return null;
    }
    return { ...c, type: 'HATCH', solid, loops, pattern };
  }

  /** HATCH の境界のスプラインの辺（94 次数、73 有理、74 周期、95 節点の数、96 制御点の数、40、10/20(/42)、97 通過点） */
  private hatchSpline(k: number, j: number): { k: number; edge: Extract<HatchEdge, { kind: 'spline' }> } {
    const edge: Extract<HatchEdge, { kind: 'spline' }> = { kind: 'spline', degree: 3, knots: [], weights: [], ctrl: [], fit: [] };
    let nk = 0, nc = 0;
    for (; k < j; k++) {
      const code = this.code(k);
      const v = num(this.value(k));
      if (code === 94) edge.degree = v;
      else if (code === 73 || code === 74) continue;
      else if (code === 95) nk = v;
      else if (code === 96) nc = v;
      else if (code === 40 && edge.knots.length < nk) edge.knots.push(v);
      else if (code === 10 && edge.ctrl.length / 2 < nc) edge.ctrl.push(v, NaN);
      else if (code === 20 && edge.ctrl.length) edge.ctrl[edge.ctrl.length - 1] = v;
      else if (code === 42) edge.weights.push(v);
      else break;
    }
    // 通過点（R2010 から。97 のあとが 11 なら通過点、0 なら数だけ）
    if (k < j && this.code(k) === 97 && (this.code(k + 1) === 11 || (int(this.value(k), -1) === 0 && this.code(k + 1) === 97))) {
      k++;
      for (; k < j; k++) {
        const code = this.code(k);
        const v = num(this.value(k));
        if (code === 11) edge.fit.push(v, NaN);
        else if (code === 21 && edge.fit.length) edge.fit[edge.fit.length - 1] = v;
        else if (code !== 12 && code !== 22 && code !== 13 && code !== 23) break;
      }
    }
    if (edge.ctrl.length / 2 > MAX_SPLINE_POINTS) { edge.ctrl = []; edge.fit = []; }
    return { k, edge };
  }

  /** 読み飛ばした種類を数える */
  private skip(type: string): void {
    this.doc.skipped.set(type, (this.doc.skipped.get(type) ?? 0) + 1);
  }

  /** POLYLINE に続く VERTEX・SEQEND を飛ばす */
  private skipSeq(j: number, end: number): number {
    let k = j;
    while (k < end && this.code(k) === 0 && this.value(k).trim() === 'VERTEX') k = this.next(k, end);
    if (k < end && this.code(k) === 0 && this.value(k).trim() === 'SEQEND') k = this.next(k, end);
    return k;
  }

  /** 図形に共通の属性 */
  private common(i: number, j: number): { c: DxfCommon; paper: boolean } {
    const c: DxfCommon = { layer: '0', ltype: 'BYLAYER', color: 256, trueColor: -1, normal: [0, 0, 1], elevation: 0 };
    let paper = false;
    let elevation = false;
    for (let k = i + 1; k < j; k++) {
      const v = this.value(k);
      switch (this.code(k)) {
        case 8: c.layer = v.trim() || '0'; break;
        case 6: c.ltype = v.trim(); break;
        case 62: c.color = int(v, 256); break;
        case 420: c.trueColor = int(v, -1) & 0xffffff; break;
        case 67: paper = int(v, 0) === 1; break;
        case 210: c.normal = [num(v), c.normal[1], c.normal[2]]; break;
        case 220: c.normal = [c.normal[0], num(v), c.normal[2]]; break;
        case 230: c.normal = [c.normal[0], c.normal[1], num(v)]; break;
        case 30: case 38: if (!elevation) { c.elevation = num(v) || 0; elevation = true; } break;
      }
    }
    return { c, paper };
  }

  /** 数の項目を引く関数（同じコードが何度もあれば最初のもの） */
  private fields(i: number, j: number): (code: number, fallback?: number) => number {
    const map = new Map<number, number>();
    for (let k = i + 1; k < j; k++) {
      const c = this.code(k);
      if (!map.has(c)) map.set(c, num(this.value(k)));
    }
    return (code, fallback = NaN) => {
      const v = map.get(code);
      return v === undefined || Number.isNaN(v) ? fallback : v;
    };
  }

  /** 文字の項目（最初のもの） */
  private fieldText(i: number, j: number, code: number): string | undefined {
    for (let k = i + 1; k < j; k++) if (this.code(k) === code) return this.value(k);
    return undefined;
  }
}
