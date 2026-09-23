/** JWW 図形データの型定義 */

/** 全図形が持つ共通属性（CData） */
export interface JwwCommon {
  /** 曲線属性番号（連続線のグループ） */
  group: number;
  /** 線種番号。点では 100 のとき点コード付き、ソリッドでは 101 以上で円系 */
  penStyle: number;
  /** 線色番号 1-9、10 は任意色、100+ は SXF 拡張色 */
  penColor: number;
  /** 線幅。文字では寸法値フラグを兼ねる */
  penWidth: number;
  layer: number;
  glayer: number;
  /** 属性フラグ */
  flag: number;
}

export interface JwwLine extends JwwCommon {
  x1: number; y1: number;
  x2: number; y2: number;
}

export interface JwwArc extends JwwCommon {
  cx: number; cy: number;
  /** 長軸半径 */
  radius: number;
  /** 開始角(rad) */
  startAngle: number;
  /** 円弧角(rad) */
  arcAngle: number;
  /** 傾き角(rad) */
  tilt: number;
  /** 扁平率（短軸/長軸）。1 で真円 */
  flatness: number;
  /** 全円フラグ */
  isCircle: boolean;
}

export interface JwwPoint extends JwwCommon {
  x: number; y: number;
  temporary: boolean;
  /** 点コード（矢印・ポイントマーカー）。penStyle===100 のときのみ */
  code?: number;
  angle?: number;
  scale?: number;
}

export interface JwwText extends JwwCommon {
  x1: number; y1: number;
  x2: number; y2: number;
  /** 文字種。斜体 +10000、ボールド +20000 */
  fontType: number;
  sizeX: number;
  sizeY: number;
  spacing: number;
  /** 角度(度) */
  angle: number;
  fontName: string;
  text: string;
}

export interface JwwSolid extends JwwCommon {
  /** 四角形の頂点は p1 → p2 → p3 → p4 の順に並べ替え済み */
  x1: number; y1: number;
  x2: number; y2: number;
  x3: number; y3: number;
  x4: number; y4: number;
  /** penColor===10 のときの RGB（0xBBGGRR） */
  rgb?: number;
}

export interface JwwDim extends JwwCommon {
  line: JwwLine;
  text: JwwText;
  sxfMode: number;
  /** 補助線・矢印・基準点（Ver.4.20 以降） */
  extras?: {
    aux1: JwwLine; aux2: JwwLine;
    arrow1: JwwPoint; arrow2: JwwPoint;
    base1: JwwPoint; base2: JwwPoint;
  };
}

export interface JwwBlockRef extends JwwCommon {
  x: number; y: number;
  scaleX: number; scaleY: number;
  /** 回転角(rad) */
  angle: number;
  /** 参照するブロック定義の通し番号 */
  defNo: number;
}

/** ブロック定義（CDataList） */
export interface JwwBlockDef {
  no: number;
  referred: boolean;
  time: number;
  name: string;
  entities: JwwEntities;
}

export interface JwwEntities {
  lines: JwwLine[];
  arcs: JwwArc[];
  points: JwwPoint[];
  texts: JwwText[];
  solids: JwwSolid[];
  dims: JwwDim[];
  blocks: JwwBlockRef[];
}

export function emptyEntities(): JwwEntities {
  return { lines: [], arcs: [], points: [], texts: [], solids: [], dims: [], blocks: [] };
}

/** レイヤグループ（0-15）。縮尺はグループ単位 */
export interface JwwLayerGroup {
  /** 0:非表示 1:表示のみ 2:編集可 3:書込 */
  state: number;
  writeLayer: number;
  /** 縮尺の分母。図面座標(mm) × scale = 実寸(mm) */
  scale: number;
  protect: number;
  name: string;
  layers: { state: number; protect: number; name: string }[];
}

export interface JwwHeader {
  version: number;
  memo: string;
  /** 0-4:A0-A4, 8:2A, 9:3A, 10:4A, 11:5A, 12:10m, 13:50m, 14:100m */
  paperSize: number;
  writeGroup: number;
  groups: JwwLayerGroup[];
  /** 線色 1-9 の画面表示色 (0xBBGGRR) と線幅 */
  penColors: { rgb: number; width: number }[];
  /** SXF 拡張色 (色番号 100-356) */
  sxfColors: { rgb: number; width: number }[];
  /** SXF 拡張色の名前（色番号 100 から順）。空文字のこともある */
  sxfColorNames: string[];
  /** 保存時の画面倍率・原点 */
  zoom: number;
  originX: number;
  originY: number;
}

export interface JwwDocument {
  header: JwwHeader;
  entities: JwwEntities;
  blockDefs: Map<number, JwwBlockDef>;
  /** パース時の警告 */
  warnings: string[];
}
