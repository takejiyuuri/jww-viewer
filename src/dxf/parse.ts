/**
 * DXF（ASCII）を読む。段は HEADER・TABLES（LAYER・LTYPE）・BLOCKS・ENTITIES だけを見る。
 * 図形は LINE・POINT・CIRCLE・ARC・ELLIPSE・LWPOLYLINE・POLYLINE（2 次元）・TEXT・SOLID・INSERT を読み、
 * ほかの種類は数だけ数えて読み飛ばす
 */
import { decodeDxf, tokenize, type DxfPairs } from './tokenize.ts';
import type {
  DxfBlock, DxfCommon, DxfDocument, DxfEntity, DxfLayer, DxfLineType,
} from './types.ts';

/** 黙って読み飛ばす種類（描くものがない、または別の図形の一部） */
const SILENT = new Set(['VIEWPORT', 'ATTRIB', 'SEQEND', 'VERTEX', 'ENDBLK']);

/** 数として読む。読めなければ NaN（座標なら Builder が捨てる） */
function num(v: string): number {
  return Number.parseFloat(v);
}

/** 整数として読む。読めなければ fallback */
function int(v: string, fallback: number): number {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * TEXT の文字列の制御記号を直す。%%c（直径）・%%d（度）・%%p（±）・%%%、
 * 下線・上線の切り替え（%%u・%%o）は外す。\U+XXXX は Unicode の文字
 */
export function decodeText(s: string): string {
  return s
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/%%([cCdDpPuUoO%]|\d{3})/g, (_, c: string) => {
      switch (c.toLowerCase()) {
        case 'c': return 'Ø';
        case 'd': return '°';
        case 'p': return '±';
        case '%': return '%';
        case 'u': case 'o': return '';
        default: return String.fromCharCode(Number.parseInt(c, 10));
      }
    });
}

export function parseDxf(buffer: ArrayBuffer): DxfDocument {
  const { text, encoding } = decodeDxf(buffer);
  const p = tokenize(text);
  const doc: DxfDocument = {
    version: '', encoding, insunits: 0, measurement: -1, extents: null,
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
    }
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
    for (let i = start; i < end;) {
      const j = this.next(i, end);
      if (this.code(i) !== 0) { i = j; continue; }
      const type = this.value(i).trim();
      const common = this.common(i, j);
      if (common.paper) {
        if (top) this.doc.paperSpace++;
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
            ...c, type, x: f(10), y: f(20), mx: f(11), my: f(21), ratio: f(40, 1),
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
          const f = this.fields(i, j);
          out.push({
            ...c, type, x: f(10), y: f(20), height: f(40), rotation: f(50, 0), widthFactor: f(41, 1),
            text: decodeText(this.fieldText(i, j, 1) ?? ''),
          });
          break;
        }
        case 'SOLID': {
          const f = this.fields(i, j);
          // SOLID の 3 点目と 4 点目は外周の順と逆に並ぶ。3 角形では 4 点目が 3 点目と同じ
          const pts = [f(10), f(20), f(11), f(21), f(13, f(12)), f(23, f(22)), f(12), f(22)];
          out.push({ ...c, type, pts });
          break;
        }
        case 'INSERT': {
          const f = this.fields(i, j);
          if (f(70, 1) > 1 || f(71, 1) > 1) this.skip('MINSERT の繰り返し');
          out.push({
            ...c, type, block: this.fieldText(i, j, 2)?.trim() ?? '', x: f(10), y: f(20),
            sx: f(41, 1), sy: f(42, 1), rotation: f(50, 0),
          });
          break;
        }
        default:
          if (!SILENT.has(type)) this.skip(type);
      }
      i = j;
    }
    return out;
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
    const c: DxfCommon = { layer: '0', ltype: 'BYLAYER', color: 256, trueColor: -1, flip: false };
    let paper = false;
    for (let k = i + 1; k < j; k++) {
      const v = this.value(k);
      switch (this.code(k)) {
        case 8: c.layer = v.trim() || '0'; break;
        case 6: c.ltype = v.trim(); break;
        case 62: c.color = int(v, 256); break;
        case 420: c.trueColor = int(v, -1) & 0xffffff; break;
        case 67: paper = int(v, 0) === 1; break;
        case 230: c.flip = num(v) < 0; break;
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
