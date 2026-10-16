/**
 * SXF の既定義の色・線種・線幅。
 * 色の推奨 RGB と線種のピッチは『SXF Ver.3.1 仕様書・同解説 共通既定義要素編』の値
 * （本文は手に入らなかったので、MIT ライセンスの ezsxf（monozukuri-ai/ezsxf 0.1.2）の表と、
 * OCF『SXF 実装規約 OCF 版（幾何検定編）2016/04』の「既定義色は推奨 RGB 値で表示」から取った）
 */

/** 既定義色（色コード 1〜16）の英名と推奨 RGB、日本語の呼び名 */
export const SXF_COLORS: { name: string; ja: string; rgb: [number, number, number] }[] = [
  { name: 'black', ja: '黒', rgb: [0, 0, 0] },
  { name: 'red', ja: '赤', rgb: [255, 0, 0] },
  { name: 'green', ja: '緑', rgb: [0, 255, 0] },
  { name: 'blue', ja: '青', rgb: [0, 0, 255] },
  { name: 'yellow', ja: '黄', rgb: [255, 255, 0] },
  { name: 'magenta', ja: 'マゼンタ', rgb: [255, 0, 255] },
  { name: 'cyan', ja: 'シアン', rgb: [0, 255, 255] },
  { name: 'white', ja: '白', rgb: [255, 255, 255] },
  { name: 'deeppink', ja: '濃いピンク', rgb: [192, 0, 128] },
  { name: 'brown', ja: '茶', rgb: [192, 128, 64] },
  { name: 'orange', ja: 'オレンジ', rgb: [255, 128, 0] },
  { name: 'lightgreen', ja: '薄い緑', rgb: [128, 192, 128] },
  { name: 'lightblue', ja: '薄い青', rgb: [0, 128, 255] },
  { name: 'lavender', ja: 'ラベンダー', rgb: [128, 64, 255] },
  { name: 'lightgray', ja: '明るい灰', rgb: [192, 192, 192] },
  { name: 'darkgray', ja: '暗い灰', rgb: [128, 128, 128] },
];

/**
 * 既定義線種（線種コード 1〜15）の英名・呼び名・ピッチ（用紙上の mm。正は線、負は空き）。
 * 呼び名は src/jww/names.ts の SXF 線種と同じ
 */
export const SXF_LINE_TYPES: { name: string; ja: string; pitch: number[] }[] = [
  { name: 'continuous', ja: '実線', pitch: [] },
  { name: 'dashed', ja: '破線', pitch: [6, -1.5] },
  { name: 'dashed spaced', ja: '跳び破線', pitch: [6, -6] },
  { name: 'long dashed dotted', ja: '一点長鎖線', pitch: [12, -1.5, 0.25, -1.5] },
  { name: 'long dashed double-dotted', ja: '二点長鎖線', pitch: [12, -1.5, 0.25, -1.5, 0.25, -1.5] },
  { name: 'long dashed triplicate-dotted', ja: '三点長鎖線', pitch: [12, -1.5, 0.25, -1.5, 0.25, -1.5, 0.25, -1.5] },
  { name: 'dotted', ja: '点線', pitch: [0.25, -1.5] },
  { name: 'chain', ja: '一点鎖線', pitch: [12, -1.5, 3.5, -1.5] },
  { name: 'chain double dash', ja: '二点鎖線', pitch: [12, -1.5, 3.5, -1.5, 3.5, -1.5] },
  { name: 'dashed dotted', ja: '一点短鎖線', pitch: [6, -1.5, 0.25, -1.5] },
  { name: 'double-dashed dotted', ja: '一点二短鎖線', pitch: [6, -1.5, 6, -1.5, 0.25, -1.5] },
  { name: 'dashed double-dotted', ja: '二点短鎖線', pitch: [6, -1.5, 0.25, -1.5, 0.25, -1.5] },
  { name: 'double-dashed double-dotted', ja: '二点二短鎖線', pitch: [6, -1.5, 6, -1.5, 0.25, -1.5, 0.25, -1.5] },
  { name: 'dashed triplicate-dotted', ja: '三点短鎖線', pitch: [6, -1.5, 0.25, -1.5, 0.25, -1.5, 0.25, -1.5] },
  {
    name: 'double-dashed triplicate-dotted', ja: '三点二短鎖線',
    pitch: [6, -1.5, 6, -1.5, 0.25, -1.5, 0.25, -1.5, 0.25, -1.5],
  },
];

/** 既定義線幅（線幅コード 1〜9）の mm */
export const SXF_WIDTHS = [0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1.0, 1.4, 2.0];

/**
 * 利用者定義の線種コードの始まり。
 * OCF の実装規約は「線種の数 31（ユーザー定義の数 16）」なので 16 から（ezsxf は 17 から数える。
 * 仕様書の本文で確かめられなかったので、16 から数えて、合わなければ 17 からとみなす。sfc.ts の lineTypeAt）
 */
export const USER_LINE_TYPE_BASE = 16;
/** 利用者定義の色コードの始まり（既定義 16 色の次。OCF の実装規約「色の数 256（ユーザー定義の数 240）」） */
export const USER_COLOR_BASE = 17;

/** 名前（大文字小文字・空白の数は問わない）から既定義色のコード（1〜16）。なければ 0 */
export function predefinedColorCode(name: string): number {
  const key = normalize(name);
  return SXF_COLORS.findIndex((c) => c.name === key) + 1;
}

/** 名前から既定義線種のコード（1〜15）。なければ 0 */
export function predefinedLineTypeCode(name: string): number {
  const key = normalize(name);
  return SXF_LINE_TYPES.findIndex((t) => t.name === key) + 1;
}

function normalize(name: string): string {
  return name.trim().split(/\s+/).join(' ').toLowerCase();
}
