// 形式によらない Scene の組み立て（線分・三角形・文字・図形ごとの属性の配列を積み、最後に Scene にまとめる）
import { fitScene } from './fit.ts';

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
  /** すべての図形を見せたときの「全体」の範囲（表示しているレイヤ・色だけで求め直すには fitScene を使う） */
  fitBounds: Bounds;
  /** 用紙の枠（用紙の大きさが分からなければ null） */
  paper: Bounds | null;
  /** 線分 [x1,y1,x2,y2, ...] */
  linePos: Float32Array;
  /** 線分ごとの色番号（colors の添字） */
  lineColor: Uint16Array;
  /** 線分ごとのレイヤ（0〜255）。縮尺の判定には上位 4 ビットのレイヤグループを使う */
  lineLayer: Uint8Array;
  /** 線分ごとのスナップの扱い（SNAP_FLAG のビット。0 なら寸法の補助線などの対象外） */
  lineSnap: Uint8Array;
  /** 線分ごとの、元になった図形の番号（entities の添字） */
  lineEntity: Uint32Array;
  /** 線分ごとの線種番号（破線の描き分けに使う。0〜DASH_STYLES-1。模様のない番号とソリッドの線は実線） */
  lineStyle: Uint8Array;
  /**
   * 線分ごとの、図形の始まりからその線分の始点までの長さ（図面座標）。
   * 円弧を折った線分でも、破線の模様が継ぎ目ごとに始まり直さず続くようにするため
   */
  lineDist: Float32Array;
  /**
   * 線種番号（0〜DASH_STYLES-1）ごとの画面表示の模様。
   * [ビット列, 1 周期のビット数 | 1 ビットのドット数 << 8] の並びで、1 周期のビット数が 0 なら実線
   */
  dashes: Uint32Array;
  /** 実点 [x, y, 半径（用紙上の mm。指定がなければ 0）, ...]。画面では小さな丸で描く */
  dotPos: Float32Array;
  /** 実点ごとの色番号 */
  dotColor: Uint16Array;
  /** 実点ごとのレイヤ */
  dotLayer: Uint8Array;
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
  /**
   * 円・円弧・楕円（弧）の元の式。CURVE_STRIDE 個ずつ [図形の番号, cx, cy, ux, uy, vx, vy, 開始角, 円弧角] と並ぶ。
   * 曲線上の点は (cx, cy) + (ux, uy)·cosθ + (vx, vy)·sinθ（θ は開始角から円弧角ぶん）。
   * 吸着で折れ線ではなく曲線そのものの上の点（線上・交点・円弧の中点）を求めるのに使う
   */
  curves: Float64Array;
  /**
   * curves の 1 件ごとの、その式で描いた線分の範囲 [最初の線分, 本数, ...]。
   * 1 つの図形が複数の式を持つ（折れ線の中のふくらみの弧など）ので、吸着では「線分 → 式」で引く。
   * 無ければ図形の線分すべてがその式のもの（古い形）
   */
  curveLines?: Uint32Array;
  /**
   * 書き出す前に座標から引いた量（図面の元の座標 = 座標 + origin）。大きな座標の図面を
   * Float32 で持つと桁が落ちるので、図面の中ほどを原点に寄せる。ずらしていなければ無い
   */
  origin?: [number, number];
}

/** curves の 1 件あたりの数 */
export const CURVE_STRIDE = 9;

/**
 * lineSnap のビット。
 * 円・円弧を折った線分の継ぎ目や真ん中は図面上の点ではないので、端点・中点にはしない
 */
export const SNAP_FLAG = {
  /** 吸着先にする（線上・交点） */
  on: 1,
  /** 始点が図形の本当の端 */
  start: 2,
  /** 終点が図形の本当の端 */
  end: 4,
  /** 線分の真ん中が図形の中点 */
  mid: 8,
} as const;

/** 直線（寸法線を含む）の線分。両端と真ん中に吸着する */
const SNAP_LINE = SNAP_FLAG.on | SNAP_FLAG.start | SNAP_FLAG.end | SNAP_FLAG.mid;

export interface ColorGroup {
  /** Jw_cad の線色番号。任意色は 10、SXF 拡張色は 100 以上、補助線種は AUX_STYLE_PEN */
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
  /** 折れ線（DXF の LWPOLYLINE・POLYLINE） */
  polyline: 9,
  /** スプライン（DXF の SPLINE） */
  spline: 10,
  /** ハッチング（DXF の HATCH。模様の線は吸着しない） */
  hatch: 11,
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
export interface Xform {
  a: number; b: number; c: number; d: number; e: number; f: number;
}

export const IDENTITY: Xform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function apply(t: Xform, x: number, y: number): [number, number] {
  return [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
}

/** p を適用した後に q を適用する合成変換 */
export function compose(p: Xform, q: Xform): Xform {
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
export const MAX_LINE_FLOATS = 3_000_000 * 4;
export const MAX_TRI_FLOATS = 1_000_000 * 6;
/**
 * 図形 100 万個 / 文字 30 万個 / 部品の展開 20 万回を超えたら打ち切る（実データは図形が数万、展開は数百）。
 * 同じ部品を何度も配置する入れ子は、数 KB のファイルでも展開すると指数的に増え、
 * 線の上限だけでは図形ごとの属性や文字が際限なく積まれて、時間とメモリを使い果たすため
 */
export const MAX_ENTITIES = 1_000_000;
export const MAX_TEXTS = 300_000;
export const MAX_EXPANSIONS = 200_000;

/** 打ち切ったときの警告（読み込んだときの知らせにも使う） */
export const TRUNCATED_WARNING = '図形が多すぎたため、描画データを途中で打ち切りました';

/**
 * 座標や大きさとして受け付ける値の上限（図面上の mm）。これを超える値は壊れたファイルのものとして捨てる。
 * 1e9 mm は 1000 km で、縮尺 1/1 で描いた測量座標でも収まる。
 * 途方もない値が範囲に入ると、「全体」や吸着の索引の格子が壊れる
 */
export const MAX_COORD = 1e9;

/**
 * 円弧を折れ線にするときの許容誤差の既定（JWW の図面上の mm）。
 * 弦と弧の最大の隔たりがこれ以内になるように分割数を決める。
 * 吸着は元の式（Scene.curves）で曲線そのものの上に求めるので、この誤差はほぼ描画にだけ出る。
 */
export const ARC_TOLERANCE = 0.02;

/** 許容誤差 tol を満たす分割数。小さな円は粗く、大きな円は細かくなる */
export function arcSegments(radius: number, sweep: number, tol = ARC_TOLERANCE): number {
  const r = Math.abs(radius);
  const abs = Math.abs(sweep);
  if (!(abs > 0)) return 1;
  if (!(r > tol)) return Math.max(3, Math.min(8, Math.ceil(abs / (Math.PI / 2))));
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / r)));
  if (!(step > 1e-6)) return 720;
  return Math.max(4, Math.min(720, Math.ceil(abs / step)));
}

/** 座標として使える値か（NaN・Infinity と、MAX_COORD を超える途方もない値は使えない） */
function inRange(v: number): boolean {
  return v >= -MAX_COORD && v <= MAX_COORD;
}

/** 4 つとも座標として使える値か。有限なだけでなく、MAX_COORD の内側にあること */
export function finite4(a: number, b: number, c: number, d: number): boolean {
  return inRange(a) && inRange(b) && inRange(c) && inRange(d);
}

/** COLORREF (0x00BBGGRR) を RGB に分解 */
export function colorref(v: number): [number, number, number] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
}

/** 色番号は Uint16 で持つので、これを超える種類の色は最後の番号にまとめる */
const MAX_COLORS = 65535;

/** 補助線種の線種番号。Jw_cad では印刷されない作図用の線で、画面では補助線色の疎な点線で描く */
export const AUX_LINE_STYLE = 9;
/**
 * 補助線種の線をまとめた色グループの番号（ColorGroup.penColor）。線色によらずここに入れ、
 * 補助線色で描いて、表示・非表示も線色とは別に切り替えられるようにする。線色の並びでは最後に来る
 */
export const AUX_STYLE_PEN = 1000 + AUX_LINE_STYLE;

/** 模様を持てる線種番号の数（0〜63。SXF 線種の 30〜62 まで入る）。これより大きい番号は実線で描く */
export const DASH_STYLES = 64;

/** 形式ごとの線色の決まり。線色番号（形式ごとの番号）から元の色と呼び名を返す */
export interface ColorSource {
  /** 図面に保存されている、その線色の画面色 */
  base(pen: number): [number, number, number];
  /** 色の一覧に出す呼び名 */
  label(pen: number): string;
}

/**
 * 線色番号（と任意色の RGB）ごとに色番号を払い出す。
 * 色番号は描画色の単位、グループは表示・非表示の単位。
 * 任意色（JWW のソリッドの任意色、DXF の真の色）は RGB ごとに別の色番号を持つが、グループは線色番号ひとつにまとめる。
 */
export class Palette {
  private source: ColorSource;
  private byKey = new Map<string, number>();
  private groupByPen = new Map<number, number>();
  readonly rgb: number[] = [];
  readonly entryGroup: number[] = [];
  readonly groups: ColorGroup[] = [];

  constructor(source: ColorSource) {
    this.source = source;
  }

  private groupOf(penColor: number, rgb: [number, number, number]): number {
    const hit = this.groupByPen.get(penColor);
    if (hit !== undefined) return hit;
    const g = this.groups.length;
    this.groups.push({ penColor, label: this.source.label(penColor), rgb, count: 0 });
    this.groupByPen.set(penColor, g);
    return g;
  }

  /**
   * 色番号を返す。custom は任意色（COLORREF）。
   * 呼ぶたびにその色のグループの図形数を 1 増やすかどうかを tally で選ぶ。
   * aux は補助線種の線。線色によらず補助線色（線色 9）で描き、「補助線種」のグループに入れる
   */
  entry(penColor: number, custom?: number, tally = true, aux = false): number {
    const rgb = aux ? this.source.base(9) : custom !== undefined ? colorref(custom) : this.source.base(penColor);
    const key = aux ? 'aux' : custom !== undefined ? `${penColor}:${custom}` : String(penColor);
    let e = this.byKey.get(key);
    if (e === undefined) {
      if (this.entryGroup.length >= MAX_COLORS) {
        e = MAX_COLORS - 1;
      } else {
        e = this.entryGroup.length;
        this.rgb.push(rgb[0], rgb[1], rgb[2]);
        this.entryGroup.push(this.groupOf(aux ? AUX_STYLE_PEN : penColor, rgb));
      }
      this.byKey.set(key, e);
    }
    if (tally) this.groups[this.entryGroup[e]].count++;
    return e;
  }
}

type Typed = Float32Array | Uint8Array | Uint16Array | Uint32Array | Int32Array;

/** 伸びる型付き配列 */
export class Buf<T extends Typed> {
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

/** Builder の形式ごとの設定 */
export interface BuilderOptions {
  /** 円弧を折れ線にするときの許容誤差（図面座標） */
  arcTolerance: number;
  /** 線色ごとの実点の半径（用紙上の mm。0 なら画面で決めた大きさ） */
  pointRadius(pen: number): number;
}

export class Builder {
  linePos = new Buf(f32);
  lineColor = new Buf(u16);
  lineLayer = new Buf(u8);
  lineSnap = new Buf(u8);
  lineEntity = new Buf(u32);
  lineStyle = new Buf(u8);
  lineDist = new Buf(f32);
  dotPos = new Buf(f32);
  dotColor = new Buf(u16);
  dotLayer = new Buf(u8);
  triPos = new Buf(f32);
  triColor = new Buf(u16);
  triLayer = new Buf(u8);
  triEntity = new Buf(u32);
  texts: SceneText[] = [];
  snapPoint = new Buf(f32);
  snapPointLayer = new Buf(u8);
  snapPointColor = new Buf(u16);
  snapPointEntity = new Buf(u32);
  /** 円・円弧・楕円の元の式（Scene.curves と同じ並び） */
  curves: number[] = [];
  /** curves の 1 件ごとの線分の範囲 [最初の線分, 本数, ...] */
  curveLines: number[] = [];
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
  private blockIndex = new Map<number | string, number>();
  /** いま書き出している図形の番号 */
  private cur = 0;
  /** いま書き出している図形の線種と、その図形の始まりから数えた線分の長さの合計（破線の模様をつなげるため） */
  private curStyle = 0;
  private curDist = 0;

  minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
  /** 壊れたファイルで際限なく膨らむのを防ぐための打ち切り */
  truncated = false;
  /** 図形の一覧を展開した回数（いちばん外側と、部品を配置するたびのその中身） */
  expanded = 0;

  readonly palette: Palette;
  private readonly options: BuilderOptions;

  constructor(palette: Palette, options: BuilderOptions) {
    this.palette = palette;
    this.options = options;
  }

  /** 実点を描く半径（用紙上の mm）。0 なら画面で決めた大きさ */
  pointRadius(penColor: number): number {
    return this.options.pointRadius(penColor);
  }

  /** 円弧を折れ線にするときの分割数（形式ごとの許容誤差で） */
  arcSegments(radius: number, sweep: number): number {
    return arcSegments(radius, sweep, this.options.arcTolerance);
  }

  /** 部品名の番号。key は形式ごとの部品の見分け（JWW は定義番号、DXF は名前）。name は初めてのときだけ呼ぶ */
  blockOf(key: number | string, name: () => string): number {
    const hit = this.blockIndex.get(key);
    if (hit !== undefined) return hit;
    const i = this.blockNames.length;
    this.blockNames.push(name());
    this.blockIndex.set(key, i);
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
    // 上限に達したら打ち切りの印だけ立てる（書き始めた図形は閉じられるよう、ここでは積む。以後の部品は展開しない）
    if (this.entKind.len >= MAX_ENTITIES || this.texts.length >= MAX_TEXTS) this.truncated = true;
    this.cur = this.entKind.len;
    // ソリッドの線種番号は円ソリッドの種類なので、線（円周ソリッド）は実線で描く。
    // 模様の表にない番号（壊れたファイルの大きな値など）も実線にする（下位の桁だけで別の線種や実点の印に化けないように）
    this.curStyle = kind !== KIND.solid && style > 0 && style < DASH_STYLES ? style : 0;
    this.curDist = 0;
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

  track(x: number, y: number): void {
    // 捨てた座標（NaN・Infinity・途方もない値）は範囲にも入れない（点は捨てたあとも呼ばれる）
    if (!finite4(x, y, 0, 0)) return;
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  }

  /** snap は true なら直線（両端と真ん中に吸着）、false なら吸着しない、数なら SNAP_FLAG のビット */
  addSegment(
    x1: number, y1: number, x2: number, y2: number,
    color: number, layer: number, snap: boolean | number,
  ): void {
    // 壊れたファイルでは座標が NaN や Infinity になりうる。
    // そのまま入れると範囲計算も索引も総崩れになるので、ここで落とす。
    if (!finite4(x1, y1, x2, y2)) return;
    if (this.linePos.len >= MAX_LINE_FLOATS) { this.truncated = true; return; }
    this.linePos.push(x1, y1, x2, y2);
    this.lineColor.push(color);
    this.lineLayer.push(layer);
    this.lineSnap.push(snap === true ? SNAP_LINE : snap === false ? 0 : snap);
    this.lineEntity.push(this.cur);
    // 線種は begin で受け取った図形のもの。長さは同じ図形の中で続けて数える
    this.lineStyle.push(this.curStyle);
    this.lineDist.push(this.curDist);
    this.curDist += Math.hypot(x2 - x1, y2 - y1);
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

  /** いま積んである線分の数（曲線の式に線分の範囲を持たせるときの始まり） */
  get lineCount(): number {
    return this.lineLayer.len;
  }

  /**
   * いま書き出している図形（円・円弧）の元の式を残す。式が壊れていれば残さない（吸着は折れ線のまま）。
   * from はこの式で描いた最初の線分（省けば図形の最初の線分）。from から今までの線分がこの式のもの
   */
  addCurve(
    cx: number, cy: number, ux: number, uy: number, vx: number, vy: number, start: number, sweep: number,
    from = this.entLineStart.data[this.cur],
  ): void {
    const v = [cx, cy, ux, uy, vx, vy, start, sweep];
    if (!v.every(Number.isFinite)) return;
    if (!(Math.abs(ux * vy - uy * vx) > 1e-9 * (ux * ux + uy * uy + vx * vx + vy * vy))) return;
    this.curves.push(this.cur, ...v);
    this.curveLines.push(from, this.lineLayer.len - from);
  }

  /** 実点を描くための丸。radius は用紙上の mm（0 なら画面で決めた大きさ） */
  addDot(x: number, y: number, radius: number, color: number, layer: number): void {
    if (!finite4(x, y, radius, 0)) return;
    this.dotPos.push(x, y, radius);
    this.dotColor.push(color);
    this.dotLayer.push(layer);
  }
}
/** finishScene に渡す、形式ごとの残りの項目 */
export interface SceneExtras {
  paper: Bounds | null;
  dashes: Uint32Array;
  /** 縮尺の枠ごとの縮尺 */
  scales: Float64Array;
  /** 座標をずらした量（大きな座標を原点の近くへ寄せたとき） */
  origin?: [number, number];
}

/** 積んだものを Scene にまとめる */
export function finishScene(b: Builder, x: SceneExtras): Scene {
  const empty = !Number.isFinite(b.minX);
  const bounds: Bounds = empty
    ? { minX: 0, minY: 0, maxX: 100, maxY: 100 }
    : { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };

  const scene: Scene = {
    bounds,
    fitBounds: { ...bounds },
    paper: x.paper,
    linePos: b.linePos.trim(),
    lineColor: b.lineColor.trim(),
    lineLayer: b.lineLayer.trim(),
    lineSnap: b.lineSnap.trim(),
    lineEntity: b.lineEntity.trim(),
    lineStyle: b.lineStyle.trim(),
    lineDist: b.lineDist.trim(),
    dashes: x.dashes,
    dotPos: b.dotPos.trim(),
    dotColor: b.dotColor.trim(),
    dotLayer: b.dotLayer.trim(),
    triPos: b.triPos.trim(),
    triColor: b.triColor.trim(),
    triLayer: b.triLayer.trim(),
    triEntity: b.triEntity.trim(),
    texts: b.texts,
    snapPoint: b.snapPoint.trim(),
    snapPointLayer: b.snapPointLayer.trim(),
    snapPointColor: b.snapPointColor.trim(),
    snapPointEntity: b.snapPointEntity.trim(),
    scales: x.scales,
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
    curves: Float64Array.from(b.curves),
    curveLines: Uint32Array.from(b.curveLines),
  };
  if (x.origin) scene.origin = x.origin;
  scene.fitBounds = fitScene(scene, () => true);
  return scene;
}
