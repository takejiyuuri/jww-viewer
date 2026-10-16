/** DXF の文書モデル。描画に使う項目だけを読む（座標は図面の単位のまま） */

export interface DxfCommon {
  layer: string;
  /** 線種名（BYLAYER・BYBLOCK もそのまま） */
  ltype: string;
  /** 色番号（ACI）。0 は BYBLOCK、256 は BYLAYER */
  color: number;
  /** 真の色（0xRRGGBB）。なければ -1 */
  trueColor: number;
  /** 押し出しの向き（210/220/230。既定は (0, 0, 1)） */
  normal: [number, number, number];
  /** 高さ（OCS の z。30 または LWPOLYLINE の 38）。OCS を平面図に写すときに使う */
  elevation: number;
}

export interface DxfLine extends DxfCommon { type: 'LINE'; x1: number; y1: number; x2: number; y2: number }
export interface DxfPoint extends DxfCommon { type: 'POINT'; x: number; y: number }
export interface DxfCircle extends DxfCommon { type: 'CIRCLE'; x: number; y: number; r: number }
/** 角度は度 */
export interface DxfArc extends DxfCommon { type: 'ARC'; x: number; y: number; r: number; start: number; end: number }
export interface DxfEllipse extends DxfCommon {
  type: 'ELLIPSE';
  x: number; y: number;
  /** 長軸の端（中心からの向き。WCS の 3 次元） */
  mx: number; my: number; mz: number;
  /** 短軸 / 長軸 */
  ratio: number;
  /** 媒介変数（ラジアン） */
  start: number; end: number;
}
/** LWPOLYLINE と 2 次元の POLYLINE */
export interface DxfPolyline extends DxfCommon {
  type: 'POLYLINE';
  xy: number[];
  /** 頂点ごとのふくらみ（次の頂点への辺） */
  bulge: number[];
  closed: boolean;
}
/** TEXT・ATTRIB・ATTDEF（定数のもの） */
export interface DxfText extends DxfCommon {
  type: 'TEXT';
  x: number; y: number;
  height: number;
  /** 度 */
  rotation: number;
  /** 幅係数 */
  widthFactor: number;
  text: string;
  /** 横の寄せ（72。0 左、1 中央、2 右、3 両端揃え、4 中央（縦も）、5 フィット） */
  halign: number;
  /** 縦の寄せ（TEXT は 73、ATTRIB・ATTDEF は 74。0 基線、1 下、2 中、3 上） */
  valign: number;
  /** 2 つ目の位置合わせ点（11/21。なければ NaN） */
  x2: number; y2: number;
}
/** MTEXT（書式記号は読んだときに外して行に分けてある） */
export interface DxfMText extends DxfCommon {
  type: 'MTEXT';
  x: number; y: number;
  /** 既定の文字の高さ */
  height: number;
  /** 折り返しの幅（41。0 なら折り返さない） */
  width: number;
  /** 基点の位置（71。1〜9 = 左上・中上・右上・左中・中央・右中・左下・中下・右下） */
  attach: number;
  /** 度（11/21 の向きがあればそちらから） */
  rotation: number;
  /** 行間の係数（44） */
  spacing: number;
  /** 段落（\P）ごとの行。height は行の中でいちばん高い字 */
  lines: { text: string; height: number }[];
}
export interface DxfSolid extends DxfCommon {
  type: 'SOLID';
  /** 頂点を外周の順（1, 2, 4, 3）に並べ替えたもの [x, y, ...] */
  pts: number[];
}
/** 3DFACE（輪郭だけ。WCS） */
export interface DxfFace extends DxfCommon {
  type: '3DFACE';
  pts: number[];
  /** 見えない辺のビット（70） */
  hidden: number;
}
export interface DxfInsert extends DxfCommon {
  type: 'INSERT';
  block: string;
  x: number; y: number;
  sx: number; sy: number;
  /** 度 */
  rotation: number;
  /** MINSERT の列・行の数と間隔 */
  cols: number; rows: number;
  colSpacing: number; rowSpacing: number;
  /** 続く ATTRIB（見えないものは除いてある） */
  attribs: DxfText[];
}
/** DIMENSION。描く中身は匿名部品（*D…）にある */
export interface DxfDimension extends DxfCommon {
  type: 'DIMENSION';
  block: string;
  /** 寸法線の位置の点（10/20） */
  x: number; y: number;
  /** 補助線の起点（13/23・14/24。なければ NaN） */
  x3: number; y3: number; x4: number; y4: number;
  /** 実測値（42。なければ NaN） */
  measurement: number;
  /** 寸法の種類（70 の下位 3 ビット。0 長さ、1 平行、2 角度、3 直径、4 半径、5 3 点角度、6 座標） */
  dimType: number;
  /** 寸法値の書き換え（1。空なら実測値） */
  text: string;
}
/** SPLINE（WCS） */
export interface DxfSpline extends DxfCommon {
  type: 'SPLINE';
  degree: number;
  closed: boolean;
  knots: number[];
  weights: number[];
  /** 制御点 [x, y, ...] */
  ctrl: number[];
  /** 通過点 [x, y, ...]（制御点がないときに使う） */
  fit: number[];
}
/** HATCH の境界の辺 */
export type HatchEdge =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  /** 円弧。角度は度、ccw が false なら時計回り */
  | { kind: 'arc'; cx: number; cy: number; r: number; start: number; end: number; ccw: boolean }
  /** 楕円弧。長軸の端 (mx, my)、比 ratio、角度は度 */
  | { kind: 'ellipse'; cx: number; cy: number; mx: number; my: number; ratio: number; start: number; end: number; ccw: boolean }
  | { kind: 'spline'; degree: number; knots: number[]; weights: number[]; ctrl: number[]; fit: number[] };
/** HATCH の境界の 1 周 */
export interface HatchLoop {
  /** 折れ線の境界 */
  poly?: { xy: number[]; bulge: number[] };
  edges?: HatchEdge[];
}
/** HATCH の模様の線の族（角度・基点・ずれ・破線は図形の縮尺と角度を掛けたもの） */
export interface HatchPatternLine {
  /** 度 */
  angle: number;
  x: number; y: number;
  dx: number; dy: number;
  dashes: number[];
}
export interface DxfHatch extends DxfCommon {
  type: 'HATCH';
  solid: boolean;
  loops: HatchLoop[];
  pattern: HatchPatternLine[];
}
/** LEADER（WCS） */
export interface DxfLeader extends DxfCommon {
  type: 'LEADER';
  xy: number[];
  arrow: boolean;
  /** 72 = 1 ならスプラインの経路 */
  spline: boolean;
}
/** XLINE・RAY（図面の範囲で切って描く。WCS） */
export interface DxfXline extends DxfCommon {
  type: 'XLINE' | 'RAY';
  x: number; y: number;
  dx: number; dy: number;
}

export type DxfEntity =
  | DxfLine | DxfPoint | DxfCircle | DxfArc | DxfEllipse | DxfPolyline | DxfText | DxfMText | DxfSolid | DxfFace
  | DxfInsert | DxfDimension | DxfSpline | DxfHatch | DxfLeader | DxfXline;

export interface DxfLayer {
  name: string;
  /** 色番号（負なら表示オフ） */
  color: number;
  trueColor: number;
  ltype: string;
  frozen: boolean;
}

export interface DxfLineType {
  name: string;
  description: string;
  /** 要素の長さ（正は線、負は空き、0 は点） */
  pattern: number[];
}

export interface DxfBlock {
  name: string;
  /** 基点 */
  x: number; y: number;
  entities: DxfEntity[];
}

export interface DxfDocument {
  /** $ACADVER（AC1015 など） */
  version: string;
  /** 文字列を読んだ文字コード */
  encoding: string;
  /** $INSUNITS（0 は指定なし） */
  insunits: number;
  /** $MEASUREMENT（0 はインチ系、1 はメートル系、-1 は指定なし） */
  measurement: number;
  /** $EXTMIN・$EXTMAX（なければ null） */
  extents: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** $DIMASZ × $DIMSCALE（引出線の矢印の大きさ。なければ NaN） */
  arrowSize: number;
  layers: DxfLayer[];
  /** 線種（名前は大文字にそろえて引く） */
  ltypes: Map<string, DxfLineType>;
  /** 部品（名前は大文字にそろえて引く） */
  blocks: Map<string, DxfBlock>;
  /** モデル空間の図形 */
  entities: DxfEntity[];
  /** 読み飛ばした図形の種類ごとの数 */
  skipped: Map<string, number>;
  /** ペーパー空間にあって描かない図形の数 */
  paperSpace: number;
  warnings: string[];
}
