/**
 * SXF の文書モデル。SFC（sfc.ts）と P21（ap202.ts）のどちらもこの形にして、同じ buildSxfScene で描く。
 * 座標・長さは図形が置かれた座標系のまま（用紙の上なら用紙の mm、部分図の中なら部分図の座標）。
 * 色・線種・線幅・レイヤ・文字フォントは SFC と同じ「コード」で持つ（P21 は ap202.ts で表を作ってコードにする）
 */

/** 線の属性（コード）。layer はレイヤコード（1〜256、0 は指定なし） */
export interface SxfStyle {
  layer: number;
  color: number;
  ltype: number;
  width: number;
}

/** 文字の配置。b_pnt は基点（1〜9：左下・中下・右下・左中・中中・右中・左上・中上・右上） */
export interface SxfText {
  font: number;
  text: string;
  x: number; y: number;
  /** 文字の高さと、文字列全体の幅（用紙または部分図の座標） */
  height: number; width: number;
  spacing: number;
  /** 度 */
  angle: number;
  slant: number;
  bpnt: number;
  /** 1 は横書き、2 は縦書き */
  direction: number;
}

/** 矢印。(ux, uy) は矢の先が向く向き（単位ベクトル）。code 0 は描かない */
export interface SxfArrow {
  code: number;
  x: number; y: number;
  ux: number; uy: number;
  scale: number;
}

/** ハッチングの模様の線の族（fill_area_style_hatching のひとつ） */
export interface SxfHatchLine {
  color: number; ltype: number; width: number;
  x: number; y: number;
  spacing: number;
  /** 度 */
  angle: number;
}

/** 複合曲線（ハッチングの境界）。部材は円弧・楕円弧・折れ線・スプライン */
export interface SxfCompositeCurve {
  color: number; ltype: number; width: number;
  /** 境界の線を描くか（composite_curve_org_feature の flag が 1） */
  visible: boolean;
  members: SxfFeature[];
}

export type SxfFeature =
  | { t: 'line'; s: SxfStyle; x1: number; y1: number; x2: number; y2: number }
  | { t: 'polyline'; s: SxfStyle; xy: number[] }
  | { t: 'circle'; s: SxfStyle; x: number; y: number; r: number }
  /** 円弧。dir 0 は左回り、1 は右回り。角度は度 */
  | { t: 'arc'; s: SxfStyle; x: number; y: number; r: number; dir: number; start: number; end: number }
  | { t: 'ellipse'; s: SxfStyle; x: number; y: number; rx: number; ry: number; rot: number }
  | {
    t: 'ellipseArc'; s: SxfStyle; x: number; y: number; rx: number; ry: number; dir: number; rot: number;
    start: number; end: number;
  }
  | { t: 'spline'; s: SxfStyle; closed: boolean; xy: number[] }
  /** クロソイド。(x, y) は原点（曲率 0 の点）、a はパラメータ、angle は原点での接線の向き（度）、l0〜l1 の区間を描く */
  | {
    t: 'clothoid'; s: SxfStyle; x: number; y: number; a: number; dir: number; angle: number;
    l0: number; l1: number;
  }
  | { t: 'point'; s: SxfStyle; x: number; y: number; marker: number; angle: number; scale: number }
  | { t: 'text'; s: SxfStyle; text: SxfText }
  /** 複合図形の配置。name は sfig の名前 */
  | { t: 'locate'; layer: number; name: string; x: number; y: number; angle: number; rx: number; ry: number }
  /** 外部定義シンボル（形は分からないので点で描く） */
  | { t: 'symbol'; s: SxfStyle; name: string; x: number; y: number; angle: number; scale: number }
  /**
   * 寸法・引出し線・バルーン。line は寸法線（折れ線）か寸法線の円弧（arc。中心・半径・開始角・終了角、左回り）。
   * aux は補助線 [x1, y1, x2, y2] の並び
   */
  | {
    t: 'dim'; kind: SxfDimKind; s: SxfStyle;
    line: number[] | null;
    arc: { x: number; y: number; r: number; start: number; end: number } | null;
    aux: number[][];
    arrows: SxfArrow[];
    text: SxfText | null;
    /** バルーンの丸 */
    circle: { x: number; y: number; r: number } | null;
  }
  /**
   * ハッチング。kind は external（外部定義。模様は描かない）・fill（塗り）・pattern（模様の線）・tiles（タイル。描かない）
   */
  | {
    t: 'hatch'; kind: 'external' | 'fill' | 'pattern' | 'tiles'; s: SxfStyle; name: string;
    outer: SxfCompositeCurve; holes: SxfCompositeCurve[]; lines: SxfHatchLine[];
  };

export type SxfDimKind = 'linear' | 'curve' | 'angular' | 'radius' | 'diameter' | 'label' | 'balloon';

/** 複合図形の定義。kind は 1 部分図（数学座標系）・2 部分図（測地座標系）・3 作図グループ・4 作図部品 */
export interface SxfFigure {
  name: string;
  kind: number;
  features: SxfFeature[];
}

export interface SxfDocument {
  /** 'sfc' か 'p21' */
  format: 'sfc' | 'p21';
  /** 図面の名前（drawing_sheet_feature の name） */
  sheetName: string;
  /** 用紙。type は 0〜4 が A0〜A4、9 は自由（x, y が用紙の長さ mm）。orientation は 0 縦、1 横 */
  sheet: { type: number; orientation: number; x: number; y: number } | null;
  /** レイヤ（コード 1 から順）。visible は lflag */
  layers: { name: string; visible: boolean }[];
  /** 利用者定義の色（コード 17 から順）の RGB */
  userColors: [number, number, number][];
  /** 利用者定義の線種（コード 16 から順）の名前とピッチ（正は線、負は空き） */
  userLineTypes: { name: string; pitch: number[] }[];
  /** 線幅コードごとの mm（既定義 1〜9 と利用者定義） */
  widths: Map<number, number>;
  /** 文字フォント（コード 1 から順）の名前 */
  fonts: string[];
  /** 用紙に直に置いた図形 */
  sheetFeatures: SxfFeature[];
  /** 複合図形の定義（名前で引く） */
  figures: Map<string, SxfFigure>;
  /** 種類ごとの数（情報パネルに出す） */
  counts: Record<string, number>;
  /** 読み飛ばした種類と数 */
  skipped: Map<string, number>;
  /** P21 のときの図面の呼び名（FILE_DESCRIPTION など） */
  version: string;
  warnings: string[];
}

export function emptySxfDocument(format: 'sfc' | 'p21'): SxfDocument {
  return {
    format, sheetName: '', sheet: null, layers: [], userColors: [], userLineTypes: [], widths: new Map(),
    fonts: [], sheetFeatures: [], figures: new Map(), counts: {}, skipped: new Map(), version: '', warnings: [],
  };
}
