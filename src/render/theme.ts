/**
 * 図面の色を、いまの表示設定（背景の明暗・単色）に合わせて画面に出す色へ変換する。
 *
 * Jw_cad の画面色は黒背景を前提にしているので、白い線や黄色・水色の線は
 * 白背景だとほとんど見えない。白背景では明るすぎる色だけを暗くし、
 * もともと濃い色（SXF の黒など）はそのまま使う。
 */

export type Background = 'dark' | 'light';

export interface DisplaySettings {
  background: Background;
  /** 線や文字をすべて一色で描く */
  mono: boolean;
}

export const DEFAULT_DISPLAY: DisplaySettings = { background: 'dark', mono: false };

/** 画面の背景色 */
export const BACKGROUND_RGB: Record<Background, [number, number, number]> = {
  dark: [11, 12, 16],
  light: [255, 255, 255],
};

/** 単色表示のときの線の色 */
const MONO_RGB: Record<Background, [number, number, number]> = {
  dark: [232, 232, 232],
  light: [24, 24, 24],
};

/**
 * 白背景で線として読み取れる明るさの上限（相対輝度）。
 * 白とのコントラスト比がおよそ 3.9:1 になる値。
 */
const LIGHT_MAX_Y = 0.22;

/** 黒背景でこれより暗い色は背景に溶けるので持ち上げる */
const DARK_MIN_SUM = 24;

function linear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** 相対輝度（0 が黒、1 が白） */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function displayColor(
  r: number, g: number, b: number, s: DisplaySettings,
): [number, number, number] {
  if (s.mono) return MONO_RGB[s.background];

  if (s.background === 'dark') {
    if (r + g + b < DARK_MIN_SUM) return [190, 190, 190];
    return [r, g, b];
  }

  // 白背景。もともと十分濃い色はそのまま使う
  if (luminance(r, g, b) <= LIGHT_MAX_Y) return [r, g, b];

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 40) {
    // 明るい無彩色は明暗を入れ替える。黒背景での白い線は、白背景では黒い線になる
    const v = 255 - Math.round((r + g + b) / 3);
    return [v, v, v];
  }

  // 色のある線は色合いを保ったまま、読める濃さまで一律に暗くする
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const k = (lo + hi) / 2;
    if (luminance(r * k, g * k, b * k) > LIGHT_MAX_Y) hi = k;
    else lo = k;
  }
  return [Math.round(r * lo), Math.round(g * lo), Math.round(b * lo)];
}

/**
 * 描画に使うパレット（1 色 4 byte の RGBA）を作る。
 * A は表示する色なら 255、隠す色なら 0。
 */
export function buildPalette(
  colors: Uint8Array,
  colorGroup: Uint16Array,
  hidden: ReadonlySet<number>,
  s: DisplaySettings,
): Uint8Array {
  const n = colorGroup.length;
  const out = new Uint8Array(Math.max(1, n) * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = displayColor(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2], s);
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = hidden.has(colorGroup[i]) ? 0 : 255;
  }
  return out;
}
