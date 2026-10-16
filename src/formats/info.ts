/** 形式によらない、画面に出す図面の情報 */

/** Jw_cad でのレイヤの状態。0 は非表示、1 は表示のみ、2 は編集可、3 は書込 */
export type LayerState = 0 | 1 | 2 | 3;

export interface LayerInfo {
  no: number;
  name: string;
  state: number;
}

export interface LayerGroupInfo {
  no: number;
  scale: number;
  name: string;
  /** 図形が 1 つでもあるか */
  used: boolean;
  state: number;
  /** 書込レイヤ（Jw_cad で保存したときに書込にしていたレイヤ） */
  writeLayer: number;
  layers: LayerInfo[];
}

/** 図面の形式 */
export type DrawingFormat = 'jww' | 'dxf' | 'sfc' | 'p21';

/** 縮尺の枠（JWW はレイヤグループ 16 個。DXF は 1 個） */
export interface ScaleSlot {
  no: number;
  label: string;
  scale: number;
  used: boolean;
}

/** JWW の縮尺の枠は Scene.scales とレイヤグループで分かるので、ここには持たない */
export const JW_SCALE_SLOTS: ScaleSlot[] = [];

export interface LoadedInfo {
  name: string;
  format: DrawingFormat;
  /** 情報パネルに出す形式の呼び名（Jw_cad 7.11、DXF（AC1015）など） */
  formatLabel: string;
  /**
   * レイヤの見せ方。'jw' はグループ 16 × レイヤ 16 で、'flat' はレイヤの名前だけを 1 列に並べる。
   * flat でも groups には 16 個の仮のグループを入れ、レイヤ k の名前と状態は groups[k >> 4].layers[k & 15] に置く
   */
  layerMode: 'jw' | 'flat';
  /** 縮尺の枠（平らな形式で使う） */
  scaleSlots: ScaleSlot[];
  /** 図面の単位（DXF）。guessed は図面に指定がなく mm とみなしたもの。code は $INSUNITS */
  units?: { name: string; toMm: number; guessed: boolean; code: number };
  /** 線種番号ごとの名前（DXF） */
  lineTypeNames?: string[];
  /** 形式ごとの図形の数（情報パネルに出す） */
  extraCounts?: Record<string, number>;
  version: number;
  paperSize: number;
  memo: string;
  counts: {
    lines: number; arcs: number; points: number; texts: number;
    solids: number; dims: number; blocks: number;
  };
  /** レイヤグループ番号ごとの縮尺分母と、実際に図形があるか */
  groups: LayerGroupInfo[];
  writeGroup: number;
  /** SXF 線種の名前（線種番号 30 から順）。属性の表示に使う */
  sxfLineTypeNames: string[];
  parseMs: number;
  warnings: string[];
}
