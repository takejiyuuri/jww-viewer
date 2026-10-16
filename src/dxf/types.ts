/** DXF の文書モデル。描画に使う項目だけを読む（座標は図面の単位のまま） */

export interface DxfCommon {
  layer: string;
  /** 線種名（BYLAYER・BYBLOCK もそのまま） */
  ltype: string;
  /** 色番号（ACI）。0 は BYBLOCK、256 は BYLAYER */
  color: number;
  /** 真の色（0xRRGGBB）。なければ -1 */
  trueColor: number;
  /** 押し出しの向きの z が負（OCS が裏返し）。2 次元の図形は x を反転して読む */
  flip: boolean;
}

export interface DxfLine extends DxfCommon { type: 'LINE'; x1: number; y1: number; x2: number; y2: number }
export interface DxfPoint extends DxfCommon { type: 'POINT'; x: number; y: number }
export interface DxfCircle extends DxfCommon { type: 'CIRCLE'; x: number; y: number; r: number }
/** 角度は度 */
export interface DxfArc extends DxfCommon { type: 'ARC'; x: number; y: number; r: number; start: number; end: number }
export interface DxfEllipse extends DxfCommon {
  type: 'ELLIPSE';
  x: number; y: number;
  /** 長軸の端（中心からの向き） */
  mx: number; my: number;
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
export interface DxfText extends DxfCommon {
  type: 'TEXT';
  x: number; y: number;
  height: number;
  /** 度 */
  rotation: number;
  /** 幅係数 */
  widthFactor: number;
  text: string;
}
export interface DxfSolid extends DxfCommon {
  type: 'SOLID';
  /** 頂点を外周の順（1, 2, 4, 3）に並べ替えたもの [x, y, ...] */
  pts: number[];
}
export interface DxfInsert extends DxfCommon {
  type: 'INSERT';
  block: string;
  x: number; y: number;
  sx: number; sy: number;
  /** 度 */
  rotation: number;
}

export type DxfEntity = DxfLine | DxfPoint | DxfCircle | DxfArc | DxfEllipse | DxfPolyline | DxfText | DxfSolid | DxfInsert;

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
