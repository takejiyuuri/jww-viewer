import type {
  JwwArc, JwwBlockDef, JwwCommon, JwwDim, JwwDocument, JwwEntities, JwwHeader, JwwLine, JwwSolid, JwwText,
} from '../jww/types.ts';

/**
 * 描画・計測用に平坦化したシーン。
 * 線分は「1 線分 = 4 float + 色番号 + レイヤ」のインスタンス配列として持ち、
 * GPU 側では単位クアッドのインスタンス描画で一括して描く。
 *
 * 色は RGB を直接持たず、パレットの添字（色番号）で持つ。
 * レイヤは「上位 4 ビットがレイヤグループ、下位 4 ビットがレイヤ」の 0〜255 で持つ。
 * 背景の白黒・色ごとやレイヤごとの表示非表示は、どれも線のデータを作り直さずに切り替えられる。
 */
export interface Scene {
  /** 全図形を含む範囲 */
  bounds: Bounds;
  /** 用紙外に散らばった図形を外れ値として除いた、初期表示に使う範囲 */
  fitBounds: Bounds;
  /** 線分 [x1,y1,x2,y2, ...] */
  linePos: Float32Array;
  /** 線分ごとの色番号（colors の添字） */
  lineColor: Uint16Array;
  /** 線分ごとのレイヤ（0〜255）。縮尺の判定には上位 4 ビットのレイヤグループを使う */
  lineLayer: Uint8Array;
  /** 線分ごとのスナップ可否（寸法の補助線などは対象外） */
  lineSnap: Uint8Array;
  /** 線分ごとの、元になった図形の番号（entities の添字） */
  lineEntity: Uint32Array;
  /** 塗り三角形の頂点 */
  triPos: Float32Array;
  /** 三角形の頂点ごとの色番号 */
  triColor: Uint16Array;
  /** 三角形の頂点ごとのレイヤ */
  triLayer: Uint8Array;
  /** 三角形ごと（頂点ごとではない）の元の図形の番号 */
  triEntity: Uint32Array;
  /** 文字（Canvas2D で描画） */
  texts: SceneText[];
  /** 円・円弧の中心、実点などの単独スナップ点 [x,y,...] */
  snapPoint: Float32Array;
  snapPointLayer: Uint8Array;
  /** 単独スナップ点の色番号。隠した色の点には吸着させない */
  snapPointColor: Uint16Array;
  snapPointEntity: Uint32Array;
  /** レイヤグループごとの縮尺分母 */
  scales: Float64Array;
  /** 色番号ごとの元の色（図面に保存されている画面色）RGB */
  colors: Uint8Array;
  /** 色番号ごとの所属する色グループ（groups の添字） */
  colorGroup: Uint16Array;
  /** 表示・非表示を切り替える単位。Jw_cad の線色ごとにひとつ */
  groups: ColorGroup[];
  /** レイヤ（0〜255）ごとの図形の数 */
  layerCounts: Uint32Array;
  /** 元の図形ごとの属性。属性の取得（タップした図形の情報）に使う */
  entities: SceneEntities;
  /** 部品（ブロック）の名前。entities.block の添字 */
  blockNames: string[];
}

export interface ColorGroup {
  /** Jw_cad の線色番号。任意色は 10、SXF 拡張色は 100 以上 */
  penColor: number;
  label: string;
  /** 見本に使う元の色 */
  rgb: [number, number, number];
  /** この色で描かれている図形の数 */
  count: number;
}

export interface Bounds {
  minX: number; minY: number; maxX: number; maxY: number;
}

export interface SceneText {
  x: number; y: number;
  /** 文字列の進行方向の長さ（図面座標） */
  width: number;
  height: number;
  /** 度 */
  angle: number;
  text: string;
  /** 色番号 */
  color: number;
  /** レイヤ（0〜255） */
  layer: number;
  /** 元の図形の番号 */
  entity: number;
}

/** 図形の種類 */
export const KIND = {
  line: 0,
  arc: 1,
  circle: 2,
  text: 3,
  solid: 4,
  point: 5,
  /** 寸法線 */
  dim: 6,
  /** 寸法値 */
  dimText: 7,
  /** 寸法の補助線（引出線） */
  dimAux: 8,
} as const;

/**
 * 元の図形ごとの属性を、図形の数だけ並べた配列の束で持つ。
 * 図面によっては数万個あるので、オブジェクトの配列にせず Worker から丸ごと受け渡せる形にしている。
 */
export interface SceneEntities {
  count: number;
  kind: Uint8Array;
  /** レイヤ（0〜255） */
  layer: Uint8Array;
  /** Jw_cad の線色番号 */
  pen: Uint16Array;
  /** Jw_cad の線種番号。文字では基点位置を兼ねるので属性表示には使わない */
  style: Uint16Array;
  /** 色番号（パレットの添字） */
  color: Uint16Array;
  /** 部品名（blockNames の添字）。部品の外なら -1 */
  block: Int32Array;
  lineStart: Uint32Array;
  lineCount: Uint32Array;
  /** 三角形単位の範囲 */
  triStart: Uint32Array;
  triCount: Uint32Array;
  /**
   * 実寸に直すときに使うレイヤグループ。ふつうは layer の上位 4 ビットと同じだが、
   * 寸法は寸法線・補助線・寸法値が別のグループに載っていることがあるので、寸法そのもののグループにそろえる
   */
  group: Uint8Array;
  /** 対応する文字（texts の添字）。寸法線では寸法値の文字。なければ -1 */
  text: Int32Array;
  /** 線・寸法の長さ、円・円弧の半径（楕円なら長いほう）、文字の高さ（図面座標） */
  size: Float32Array;
  /** 円・円弧の短いほうの半径。真円なら size と同じ。ほかの図形では 0 */
  size2: Float32Array;
  /** 円弧の長さ（図面座標） */
  length: Float32Array;
  /** 任意色の COLORREF。任意色でなければ -1 */
  rgb: Int32Array;
}

/** 2x3 アフィン変換 */
interface Xform {
  a: number; b: number; c: number; d: number; e: number; f: number;
}

const IDENTITY: Xform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function apply(t: Xform, x: number, y: number): [number, number] {
  return [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
}

/** p を適用した後に q を適用する合成変換 */
function compose(p: Xform, q: Xform): Xform {
  return {
    a: p.a * q.a + p.b * q.c,
    b: p.a * q.b + p.b * q.d,
    c: p.c * q.a + p.d * q.c,
    d: p.c * q.b + p.d * q.d,
    e: p.e * q.a + p.f * q.c + q.e,
    f: p.e * q.b + p.f * q.d + q.f,
  };
}

/** 線分 300 万本 / 三角形 100 万枚を超えたら打ち切る（実データは数万〜20 万本） */
const MAX_LINE_FLOATS = 3_000_000 * 4;
const MAX_TRI_FLOATS = 1_000_000 * 6;

/**
 * 円弧を折れ線にするときの許容誤差（図面上の mm）。
 * 弦と弧の最大の隔たりがこれ以内になるように分割数を決める。
 */
const ARC_TOLERANCE = 0.02;

/** 許容誤差を満たす分割数。小さな円は粗く、大きな円は細かくなる */
function arcSegments(radius: number, sweep: number): number {
  const r = Math.abs(radius);
  const abs = Math.abs(sweep);
  if (!(abs > 0)) return 1;
  if (!(r > ARC_TOLERANCE)) return Math.max(3, Math.min(8, Math.ceil(abs / (Math.PI / 2))));
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - ARC_TOLERANCE / r)));
  if (!(step > 1e-6)) return 720;
  return Math.max(4, Math.min(720, Math.ceil(abs / step)));
}

function finite4(a: number, b: number, c: number, d: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d);
}

/** COLORREF (0x00BBGGRR) を RGB に分解 */
function colorref(v: number): [number, number, number] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
}

/** 図形のレイヤ（0〜255）。ブロックの中身は配置した側のレイヤを引き継ぐ */
function layerOf(c: JwwCommon, inherit: number | null): number {
  return inherit ?? (((c.glayer & 15) << 4) | (c.layer & 15));
}

/** 変換で長さが何倍になるか（ブロックの倍率）。縦横で違えば平均を取る */
function lengthScale(t: Xform): number {
  const sx = Math.hypot(t.a, t.b);
  const sy = Math.hypot(t.c, t.d);
  return (sx + sy) / 2 || 1;
}

/** 色番号は Uint16 で持つので、これを超える種類の色は最後の番号にまとめる */
const MAX_COLORS = 65535;

/**
 * 線色番号（と任意色の RGB）ごとに色番号を払い出す。
 * 色番号は描画色の単位、グループは表示・非表示の単位。
 * ソリッドの任意色は RGB ごとに別の色番号を持つが、グループは「任意色」ひとつにまとめる。
 */
class Palette {
  private header: JwwHeader;
  private byKey = new Map<string, number>();
  private groupByPen = new Map<number, number>();
  readonly rgb: number[] = [];
  readonly entryGroup: number[] = [];
  readonly groups: ColorGroup[] = [];

  constructor(header: JwwHeader) {
    this.header = header;
  }

  /** 図面に保存されている、その線色の画面色 */
  private baseColor(penColor: number): [number, number, number] {
    if (penColor >= 100) {
      const e = this.header.sxfColors[penColor - 100];
      return e ? colorref(e.rgb) : [255, 255, 255];
    }
    const e = this.header.penColors[penColor];
    return e ? colorref(e.rgb) : [255, 255, 255];
  }

  private label(penColor: number): string {
    if (penColor >= 1 && penColor <= 8) return `線色${penColor}`;
    if (penColor === 9) return '補助線色';
    if (penColor === 10) return '任意色';
    if (penColor >= 100) {
      const name = (this.header.sxfColorNames[penColor - 100] ?? '').trim();
      return name ? `SXF ${name}` : `SXF色 ${penColor - 100}`;
    }
    return `色番号 ${penColor}`;
  }

  private groupOf(penColor: number, rgb: [number, number, number]): number {
    const hit = this.groupByPen.get(penColor);
    if (hit !== undefined) return hit;
    const g = this.groups.length;
    this.groups.push({ penColor, label: this.label(penColor), rgb, count: 0 });
    this.groupByPen.set(penColor, g);
    return g;
  }

  /**
   * 色番号を返す。custom は任意色（COLORREF）。
   * 呼ぶたびにその色のグループの図形数を 1 増やすかどうかを tally で選ぶ。
   */
  entry(penColor: number, custom?: number, tally = true): number {
    const rgb = penColor === 10 && custom !== undefined ? colorref(custom) : this.baseColor(penColor);
    const key = penColor === 10 && custom !== undefined ? `10:${custom}` : String(penColor);
    let e = this.byKey.get(key);
    if (e === undefined) {
      if (this.entryGroup.length >= MAX_COLORS) {
        e = MAX_COLORS - 1;
      } else {
        e = this.entryGroup.length;
        this.rgb.push(rgb[0], rgb[1], rgb[2]);
        this.entryGroup.push(this.groupOf(penColor, rgb));
      }
      this.byKey.set(key, e);
    }
    if (tally) this.groups[this.entryGroup[e]].count++;
    return e;
  }
}

type Typed = Float32Array | Uint8Array | Uint16Array | Uint32Array | Int32Array;

/** 伸びる型付き配列 */
class Buf<T extends Typed> {
  data: T;
  len = 0;
  private readonly make: (n: number) => T;

  constructor(make: (n: number) => T) {
    this.make = make;
    this.data = make(1 << 12);
  }

  push(...vals: number[]): void {
    if (this.len + vals.length > this.data.length) this.grow(vals.length);
    for (let i = 0; i < vals.length; i++) this.data[this.len++] = vals[i];
  }

  private grow(need: number): void {
    let size = this.data.length * 2;
    while (size < this.len + need) size *= 2;
    const next = this.make(size);
    next.set(this.data);
    this.data = next;
  }

  trim(): T {
    return this.data.slice(0, this.len) as T;
  }
}

const f32 = (n: number) => new Float32Array(n);
const u8 = (n: number) => new Uint8Array(n);
const u16 = (n: number) => new Uint16Array(n);
const u32 = (n: number) => new Uint32Array(n);
const i32 = (n: number) => new Int32Array(n);

class Builder {
  linePos = new Buf(f32);
  lineColor = new Buf(u16);
  lineLayer = new Buf(u8);
  lineSnap = new Buf(u8);
  lineEntity = new Buf(u32);
  triPos = new Buf(f32);
  triColor = new Buf(u16);
  triLayer = new Buf(u8);
  triEntity = new Buf(u32);
  texts: SceneText[] = [];
  snapPoint = new Buf(f32);
  snapPointLayer = new Buf(u8);
  snapPointColor = new Buf(u16);
  snapPointEntity = new Buf(u32);
  layerCounts = new Uint32Array(256);

  // 図形ごとの属性
  entKind = new Buf(u8);
  entLayer = new Buf(u8);
  entGroup = new Buf(u8);
  entPen = new Buf(u16);
  entStyle = new Buf(u16);
  entColor = new Buf(u16);
  entBlock = new Buf(i32);
  entLineStart = new Buf(u32);
  entLineCount = new Buf(u32);
  entTriStart = new Buf(u32);
  entTriCount = new Buf(u32);
  entText = new Buf(i32);
  entSize = new Buf(f32);
  entSize2 = new Buf(f32);
  entLength = new Buf(f32);
  entRgb = new Buf(i32);
  blockNames: string[] = [];
  private blockIndex = new Map<number, number>();
  /** いま書き出している図形の番号 */
  private cur = 0;

  /**
   * 初期表示の範囲を決めるための代表点。
   * 線分ごとに取ると円弧の分割数で点の数が変わり、
   * 同じ図面でも表示範囲が動いてしまうため、図形ごとに数点だけ入れる。
   */
  boundsPts = new Buf(f32);
  minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
  /** 壊れたファイルで際限なく膨らむのを防ぐための打ち切り */
  truncated = false;

  readonly palette: Palette;
  readonly blockDefs: Map<number, JwwBlockDef>;

  constructor(palette: Palette, blockDefs: Map<number, JwwBlockDef>) {
    this.palette = palette;
    this.blockDefs = blockDefs;
  }

  /** 部品名の番号。Ver.4.10 以降の名前に付く "@@SfigorgFlag@@..." は取り除く */
  blockOf(defNo: number): number {
    const hit = this.blockIndex.get(defNo);
    if (hit !== undefined) return hit;
    const raw = this.blockDefs.get(defNo)?.name ?? '';
    const name = raw.split('@@SfigorgFlag@@')[0].trim() || `部品 ${defNo}`;
    const i = this.blockNames.length;
    this.blockNames.push(name);
    this.blockIndex.set(defNo, i);
    return i;
  }

  /**
   * 図形をひとつ書き始める。以後の線分・三角形・文字はこの図形に属する。
   * group は実寸に直すときのレイヤグループ（寸法以外はレイヤのグループそのもの）
   */
  begin(
    kind: number, pen: number, style: number, layer: number, color: number, block: number,
    rgb = -1, group = layer >> 4,
  ): number {
    this.cur = this.entKind.len;
    this.entKind.push(kind);
    this.entLayer.push(layer);
    this.entGroup.push(group);
    this.entPen.push(pen);
    this.entStyle.push(style);
    this.entColor.push(color);
    this.entBlock.push(block);
    this.entLineStart.push(this.lineLayer.len);
    this.entTriStart.push(this.triEntity.len);
    this.entText.push(-1);
    this.entRgb.push(rgb);
    this.layerCounts[layer]++;
    return this.cur;
  }

  /** 書き始めた図形を閉じる */
  end(size = 0, length = 0, size2 = 0): void {
    const i = this.cur;
    this.entLineCount.push(this.lineLayer.len - this.entLineStart.data[i]);
    this.entTriCount.push(this.triEntity.len - this.entTriStart.data[i]);
    this.entSize.push(size);
    this.entSize2.push(size2);
    this.entLength.push(length);
  }

  /** 表示範囲の候補として 1 点覚える */
  sample(x: number, y: number): void {
    if (Number.isFinite(x) && Number.isFinite(y)) this.boundsPts.push(x, y);
  }

  track(x: number, y: number): void {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  }

  addSegment(
    x1: number, y1: number, x2: number, y2: number,
    color: number, layer: number, snap: boolean,
  ): void {
    // 壊れたファイルでは座標が NaN や Infinity になりうる。
    // そのまま入れると範囲計算も索引も総崩れになるので、ここで落とす。
    if (!finite4(x1, y1, x2, y2)) return;
    if (this.linePos.len >= MAX_LINE_FLOATS) { this.truncated = true; return; }
    this.linePos.push(x1, y1, x2, y2);
    this.lineColor.push(color);
    this.lineLayer.push(layer);
    this.lineSnap.push(snap ? 1 : 0);
    this.lineEntity.push(this.cur);
    this.track(x1, y1);
    this.track(x2, y2);
  }

  addTriangle(
    x1: number, y1: number, x2: number, y2: number, x3: number, y3: number,
    color: number, layer: number,
  ): void {
    if (!finite4(x1, y1, x2, y2) || !finite4(x3, y3, 0, 0)) return;
    if (this.triPos.len >= MAX_TRI_FLOATS) { this.truncated = true; return; }
    this.triPos.push(x1, y1, x2, y2, x3, y3);
    this.triColor.push(color, color, color);
    this.triLayer.push(layer, layer, layer);
    this.triEntity.push(this.cur);
    this.track(x1, y1);
    this.track(x2, y2);
    this.track(x3, y3);
  }

  addPoint(x: number, y: number, layer: number, color: number): void {
    if (!finite4(x, y, 0, 0)) return;
    this.snapPoint.push(x, y);
    this.snapPointLayer.push(layer);
    this.snapPointColor.push(color);
    this.snapPointEntity.push(this.cur);
  }
}

/** 線分をひとつ出す（図形の begin/end は呼び出し側）。長さを返す */
function lineSegment(b: Builder, l: JwwLine, t: Xform, snap: boolean, color: number, layer: number): number {
  const [x1, y1] = apply(t, l.x1, l.y1);
  const [x2, y2] = apply(t, l.x2, l.y2);
  b.addSegment(x1, y1, x2, y2, color, layer, snap);
  b.sample(x1, y1);
  b.sample(x2, y2);
  return Math.hypot(x2 - x1, y2 - y1);
}

function emitLine(b: Builder, l: JwwLine, t: Xform, inherit: number | null, block: number): void {
  const layer = layerOf(l, inherit);
  const color = b.palette.entry(l.penColor);
  b.begin(KIND.line, l.penColor, l.penStyle, layer, color, block);
  const len = lineSegment(b, l, t, true, color, layer);
  b.end(len);
}

/** 円弧を折れ線に展開する。扁平率と傾きを考慮した楕円弧。 */
function emitArc(b: Builder, a: JwwArc, t: Xform, inherit: number | null, block: number): void {
  const layer = layerOf(a, inherit);
  const sweep = a.isCircle ? Math.PI * 2 : a.arcAngle;
  const n = arcSegments(a.radius, sweep);
  const color = b.palette.entry(a.penColor);
  const cos = Math.cos(a.tilt);
  const sin = Math.sin(a.tilt);
  const ry = a.radius * (a.flatness || 1);

  b.begin(a.isCircle ? KIND.circle : KIND.arc, a.penColor, a.penStyle, layer, color, block);
  let px = 0, py = 0;
  let length = 0;
  for (let i = 0; i <= n; i++) {
    const th = a.startAngle + (sweep * i) / n;
    const lx = a.radius * Math.cos(th);
    const ly = ry * Math.sin(th);
    const [x, y] = apply(t, a.cx + lx * cos - ly * sin, a.cy + lx * sin + ly * cos);
    if (i > 0) {
      b.addSegment(px, py, x, y, color, layer, true);
      length += Math.hypot(x - px, y - py);
    }
    // 代表点は始点・中間・終点だけにして、分割数に左右されないようにする
    if (i === 0 || i === n || i * 2 === n) b.sample(x, y);
    px = x;
    py = y;
  }
  const [cx, cy] = apply(t, a.cx, a.cy);
  b.addPoint(cx, cy, layer, color);
  const [major, minor] = ellipseAxes(t, a.radius, ry, a.tilt);
  b.end(major, arcLength(a, t, sweep, ry, cos, sin, major, minor, length), minor);
}

/**
 * 変換後の楕円の半径（長いほう・短いほう）。
 * 半径 (rx, ry) を傾き tilt で回した楕円に、ブロックの変換 t を掛けたものの特異値になる。
 */
function ellipseAxes(t: Xform, rx: number, ry: number, tilt: number): [number, number] {
  const c = Math.cos(tilt), s = Math.sin(tilt);
  // M = [[t.a, t.c], [t.b, t.d]] に R(tilt)·diag(rx, ry) を掛けた 2x2 行列
  const m00 = (t.a * c + t.c * s) * rx, m01 = (-t.a * s + t.c * c) * ry;
  const m10 = (t.b * c + t.d * s) * rx, m11 = (-t.b * s + t.d * c) * ry;
  const sum = m00 * m00 + m01 * m01 + m10 * m10 + m11 * m11;
  const det = m00 * m11 - m01 * m10;
  const root = Math.sqrt(Math.max(0, sum * sum - 4 * det * det));
  const major = Math.sqrt(Math.max(0, (sum + root) / 2));
  const minor = Math.sqrt(Math.max(0, (sum - root) / 2));
  // 真円どうしは誤差で食い違わないよう同じ値にそろえる
  return [major, Math.abs(major - minor) <= major * 1e-7 ? major : minor];
}

/**
 * 円弧の長さ。描画用に分割した折れ線の長さは弦の和なので実際より短い。
 * 真円なら半径 × 角度で正確に、楕円はずっと細かく分けて足し合わせる。
 */
function arcLength(
  a: JwwArc, t: Xform, sweep: number, ry: number, cos: number, sin: number,
  major: number, minor: number, chords: number,
): number {
  if (major === minor) return major * Math.abs(sweep);
  const steps = 2048;
  let length = 0;
  let px = 0, py = 0;
  for (let i = 0; i <= steps; i++) {
    const th = a.startAngle + (sweep * i) / steps;
    const lx = a.radius * Math.cos(th);
    const ly = ry * Math.sin(th);
    const [x, y] = apply(t, a.cx + lx * cos - ly * sin, a.cy + lx * sin + ly * cos);
    if (i > 0) length += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return Number.isFinite(length) ? length : chords;
}

function emitSolid(b: Builder, s: JwwSolid, t: Xform, inherit: number | null, block: number): void {
  const layer = layerOf(s, inherit);
  const custom = s.penColor === 10 ? s.rgb : undefined;
  const color = b.palette.entry(s.penColor, custom);
  b.begin(KIND.solid, s.penColor, s.penStyle, layer, color, block, custom ?? -1);

  if (s.penStyle >= 101) {
    // 円系ソリッド。CDataSolid を流用しており各点の意味が異なる。
    //   p1=中心, p4=(半径, 扁平率), p2=(傾き角, 開始角), p3=(円弧角, 種別)
    const cx = s.x1, cy = s.y1;
    const radius = s.x4;
    const flat = s.y4 || 1;
    const tilt = s.x2;
    const start = s.y2;
    const kind = s.y3;
    const sweep = kind === 100 ? Math.PI * 2 : s.x3;
    const n = arcSegments(radius, sweep);
    const cos = Math.cos(tilt), sin = Math.sin(tilt);
    // 円環ソリッドでは p3.y が内側の半径
    const inner = (s.penStyle === 105 || s.penStyle === 106) ? kind : 0;

    const pt = (th: number, rr: number): [number, number] => {
      const lx = rr * Math.cos(th);
      const ly = rr * flat * Math.sin(th);
      return apply(t, cx + lx * cos - ly * sin, cy + lx * sin + ly * cos);
    };

    if (inner > 0) {
      let [ax, ay] = pt(start, radius);
      let [bx, by] = pt(start, inner);
      for (let i = 1; i <= n; i++) {
        const th = start + (sweep * i) / n;
        const [cx2, cy2] = pt(th, radius);
        const [dx2, dy2] = pt(th, inner);
        b.addTriangle(ax, ay, bx, by, cx2, cy2, color, layer);
        b.addTriangle(bx, by, dx2, dy2, cx2, cy2, color, layer);
        ax = cx2; ay = cy2; bx = dx2; by = dy2;
      }
    } else {
      const [ox, oy] = apply(t, cx, cy);
      let [px, py] = pt(start, radius);
      for (let i = 1; i <= n; i++) {
        const th = start + (sweep * i) / n;
        const [qx, qy] = pt(th, radius);
        b.addTriangle(ox, oy, px, py, qx, qy, color, layer);
        px = qx; py = qy;
      }
    }
    const [ox, oy] = apply(t, cx, cy);
    b.addPoint(ox, oy, layer, color);
    b.sample(ox - radius, oy - radius);
    b.sample(ox + radius, oy + radius);
    b.end(Math.abs(radius) * lengthScale(t));
    return;
  }

  const [x1, y1] = apply(t, s.x1, s.y1);
  const [x2, y2] = apply(t, s.x2, s.y2);
  const [x3, y3] = apply(t, s.x3, s.y3);
  const [x4, y4] = apply(t, s.x4, s.y4);
  b.addTriangle(x1, y1, x2, y2, x3, y3, color, layer);
  b.addTriangle(x1, y1, x3, y3, x4, y4, color, layer);
  b.sample(x1, y1);
  b.sample(x2, y2);
  b.sample(x3, y3);
  b.sample(x4, y4);
  b.end();
}

/** 文字をひとつ出す（図形の begin/end は呼び出し側）。texts の添字を返す。出さなければ -1 */
function textItem(b: Builder, m: JwwText, t: Xform, color: number, layer: number, entity: number): number {
  if (!m.text) return -1;
  const [x1, y1] = apply(t, m.x1, m.y1);
  const [x2, y2] = apply(t, m.x2, m.y2);
  if (!finite4(x1, y1, x2, y2) || !Number.isFinite(m.sizeY)) return -1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const width = Math.hypot(dx, dy);
  // 始終点から実際の描画角度を得る（ブロックの回転もこれで反映される）
  const angle = width > 1e-9 ? (Math.atan2(dy, dx) * 180) / Math.PI : m.angle;
  const sy = Math.hypot(t.c, t.d) || 1;
  const index = b.texts.length;
  b.texts.push({
    x: x1, y: y1,
    width: width || m.sizeX * m.text.length,
    height: m.sizeY * sy,
    angle,
    text: m.text,
    color,
    layer,
    entity,
  });
  b.track(x1, y1);
  b.track(x2, y2);
  b.sample(x1, y1);
  b.sample(x2, y2);
  return index;
}

function emitText(b: Builder, m: JwwText, t: Xform, inherit: number | null, block: number): void {
  if (!m.text) return;
  const layer = layerOf(m, inherit);
  const color = b.palette.entry(m.penColor);
  // 文字の penStyle は線種ではなく基点位置なので、線種としては持たない
  const e = b.begin(KIND.text, m.penColor, 0, layer, color, block);
  const index = textItem(b, m, t, color, layer, e);
  b.entText.data[e] = index;
  b.end(m.sizeY * (Math.hypot(t.c, t.d) || 1));
}

/**
 * 寸法。寸法線（と補助線）と寸法値は、それぞれ自分のレイヤで表示が決まる。
 * 実際の図面では寸法線だけが非表示の補助線レイヤにあり、値は見えている、ということがある。
 * そのため寸法線と寸法値は別の図形として扱い、互いに参照できるようにしておく。
 */
function emitDim(b: Builder, d: JwwDim, t: Xform, inherit: number | null, block: number): void {
  // 寸法線と寸法値が縮尺の違うグループに載っていることがある。寸法値と合うのは寸法そのもののグループ
  const group = layerOf(d, inherit) >> 4;
  const lineLayer = layerOf(d.line, inherit);
  const lineColor = b.palette.entry(d.line.penColor);
  const lineEnt = b.begin(KIND.dim, d.line.penColor, d.line.penStyle, lineLayer, lineColor, block, -1, group);
  const len = lineSegment(b, d.line, t, true, lineColor, lineLayer);
  b.end(len);
  const members = [lineEnt];
  if (d.extras) {
    // 補助線は計測の吸着先にしない。レイヤと線色はそれぞれが持つものに従うので、図形としても分けておく
    for (const aux of [d.extras.aux1, d.extras.aux2]) {
      const auxLayer = layerOf(aux, inherit);
      const auxColor = b.palette.entry(aux.penColor, undefined, false);
      members.push(b.begin(KIND.dimAux, aux.penColor, aux.penStyle, auxLayer, auxColor, block, -1, group));
      b.end(lineSegment(b, aux, t, false, auxColor, auxLayer));
    }
  }

  if (!d.text.text) return;
  const textLayer = layerOf(d.text, inherit);
  const textColor = b.palette.entry(d.text.penColor);
  const textEnt = b.begin(KIND.dimText, d.text.penColor, 0, textLayer, textColor, block, -1, group);
  const index = textItem(b, d.text, t, textColor, textLayer, textEnt);
  b.entText.data[textEnt] = index;
  for (const m of members) b.entText.data[m] = index;
  b.end(len);
}

function emitEntities(
  b: Builder, e: JwwEntities, t: Xform, depth: number,
  open: Set<number>, inherit: number | null, block: number,
): void {
  for (const l of e.lines) emitLine(b, l, t, inherit, block);
  for (const a of e.arcs) emitArc(b, a, t, inherit, block);
  for (const s of e.solids) emitSolid(b, s, t, inherit, block);
  for (const m of e.texts) emitText(b, m, t, inherit, block);

  for (const p of e.points) {
    if (p.temporary) continue;
    const [x, y] = apply(t, p.x, p.y);
    const layer = layerOf(p, inherit);
    // 実点は線として描かないので、色の図形数には数えない
    const color = b.palette.entry(p.penColor, undefined, false);
    b.begin(KIND.point, p.penColor, 0, layer, color, block);
    b.addPoint(x, y, layer, color);
    b.end();
    b.track(x, y);
    b.sample(x, y);
  }

  for (const d of e.dims) emitDim(b, d, t, inherit, block);

  if (depth >= 16) return;
  for (const ref of e.blocks) {
    // 自分や祖先を参照し返すブロックがあると際限なく展開されるので、
    // 展開中の定義番号を覚えておいて、戻る辺を捨てる。
    if (open.has(ref.defNo)) continue;
    const def = b.blockDefs.get(ref.defNo);
    if (!def) continue;
    const cos = Math.cos(ref.angle);
    const sin = Math.sin(ref.angle);
    const local: Xform = {
      a: ref.scaleX * cos, b: ref.scaleX * sin,
      c: -ref.scaleY * sin, d: ref.scaleY * cos,
      e: ref.x, f: ref.y,
    };
    open.add(ref.defNo);
    // 部品の中身は、いちばん外側で配置したレイヤに従って表示・非表示が決まる。
    // 部品の名前は、その図形をじかに含んでいる部品のものを使う。
    emitEntities(
      b, def.entities, compose(local, t), depth + 1, open,
      inherit ?? layerOf(ref, null), b.blockOf(ref.defNo),
    );
    open.delete(ref.defNo);
  }
}

export function buildScene(doc: JwwDocument): Scene {
  const b = new Builder(new Palette(doc.header), doc.blockDefs);
  emitEntities(b, doc.entities, IDENTITY, 0, new Set(), null, -1);
  if (b.truncated) {
    doc.warnings.push('図形が多すぎたため、描画データを途中で打ち切りました');
  }

  const scales = new Float64Array(16);
  for (let i = 0; i < 16; i++) scales[i] = doc.header.groups[i]?.scale || 1;

  const paper = paperRect(doc.header.paperSize);
  const empty = !Number.isFinite(b.minX);
  const bounds: Bounds = empty
    ? { minX: 0, minY: 0, maxX: 100, maxY: 100 }
    : { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };

  return {
    bounds,
    fitBounds: unite(robustBounds(b.boundsPts.trim(), bounds), paper),
    linePos: b.linePos.trim(),
    lineColor: b.lineColor.trim(),
    lineLayer: b.lineLayer.trim(),
    lineSnap: b.lineSnap.trim(),
    lineEntity: b.lineEntity.trim(),
    triPos: b.triPos.trim(),
    triColor: b.triColor.trim(),
    triLayer: b.triLayer.trim(),
    triEntity: b.triEntity.trim(),
    texts: b.texts,
    snapPoint: b.snapPoint.trim(),
    snapPointLayer: b.snapPointLayer.trim(),
    snapPointColor: b.snapPointColor.trim(),
    snapPointEntity: b.snapPointEntity.trim(),
    scales,
    colors: Uint8Array.from(b.palette.rgb),
    colorGroup: Uint16Array.from(b.palette.entryGroup),
    // 並び替えると colorGroup の添字とずれるので、払い出し順のまま渡す（並べるのは表示側）
    groups: b.palette.groups,
    layerCounts: b.layerCounts,
    entities: {
      count: b.entKind.len,
      kind: b.entKind.trim(),
      layer: b.entLayer.trim(),
      group: b.entGroup.trim(),
      pen: b.entPen.trim(),
      style: b.entStyle.trim(),
      color: b.entColor.trim(),
      block: b.entBlock.trim(),
      lineStart: b.entLineStart.trim(),
      lineCount: b.entLineCount.trim(),
      triStart: b.entTriStart.trim(),
      triCount: b.entTriCount.trim(),
      text: b.entText.trim(),
      size: b.entSize.trim(),
      size2: b.entSize2.trim(),
      length: b.entLength.trim(),
      rgb: b.entRgb.trim(),
    },
    blockNames: b.blockNames,
  };
}

/**
 * 用紙の寸法（mm）。JWW の座標は用紙中心を原点に取る。
 * 0〜4:A0〜A4、8〜11:2A〜5A、12〜14:10m/50m/100m
 */
const PAPER_SIZES: Record<number, [number, number]> = {
  0: [1189, 841],
  1: [841, 594],
  2: [594, 420],
  3: [420, 297],
  4: [297, 210],
  8: [1682, 1189],
  9: [2378, 1682],
  10: [3364, 2378],
  11: [4756, 3364],
  12: [10000, 7071],
  13: [50000, 35355],
  14: [100000, 70711],
};

function paperRect(paperSize: number): Bounds | null {
  const size = PAPER_SIZES[paperSize];
  if (!size) return null;
  return { minX: -size[0] / 2, maxX: size[0] / 2, minY: -size[1] / 2, maxY: size[1] / 2 };
}

/**
 * 図形から求めた範囲に用紙の枠を合わせる。
 * 用紙に収まっている図面では Jw_cad と同じく用紙全体が見えるようにする。
 * ただし用紙だけが極端に大きい図面（作図済みなのは一部だけ）では、
 * 用紙に合わせると図面が豆粒になるので図形の範囲を優先する。
 */
function unite(a: Bounds, b: Bounds | null): Bounds {
  if (!b) return a;
  const shape = Math.hypot(a.maxX - a.minX, a.maxY - a.minY);
  const paper = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
  if (paper > shape * 1.6) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/**
 * 図面の主要部分を囲む範囲。
 * Jw_cad の図面には用紙の外に離れた図形が残っていることがあり、
 * 全体を収めると本体が豆粒になってしまうため、端の数 % を切り捨てる。
 */
function robustBounds(pts: Float32Array, fallback: Bounds): Bounds {
  const count = pts.length / 2;
  if (count < 50) return fallback;

  const sampleMax = 40000;
  const step = Math.max(1, Math.floor(count / sampleMax));
  const n = Math.floor((count - 1) / step) + 1;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < count; i += step) {
    xs[k] = pts[i * 2];
    ys[k] = pts[i * 2 + 1];
    k++;
  }
  const sx = xs.subarray(0, k).slice().sort();
  const sy = ys.subarray(0, k).slice().sort();

  const q = 0.006;
  const lo = Math.floor(k * q);
  const hi = Math.min(k - 1, Math.ceil(k * (1 - q)));
  const r: Bounds = { minX: sx[lo], maxX: sx[hi], minY: sy[lo], maxY: sy[hi] };

  const w = r.maxX - r.minX;
  const h = r.maxY - r.minY;
  if (!(w > 1e-6) || !(h > 1e-6)) return fallback;

  // 切り落とした端がぎりぎりに来ないよう少しだけ広げる
  const pad = Math.max(w, h) * 0.02;
  return {
    minX: Math.max(fallback.minX, r.minX - pad),
    maxX: Math.min(fallback.maxX, r.maxX + pad),
    minY: Math.max(fallback.minY, r.minY - pad),
    maxY: Math.min(fallback.maxY, r.maxY + pad),
  };
}
