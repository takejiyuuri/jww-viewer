/** AutoCAD の色番号（ACI 1〜255）の色と呼び名 */

/** 真の色（420）の図形をまとめる線色番号。ACI と重ならない番号にする */
export const TRUE_COLOR_PEN = 1100;

const NAMES: Record<number, string> = {
  1: '赤', 2: '黄', 3: '緑', 4: 'シアン', 5: '青', 6: 'マゼンタ', 7: '白・黒', 8: '灰', 9: '薄い灰',
};

/** 250〜255 の灰色 */
const GRAYS = [51, 80, 105, 130, 190, 255];

/** 色番号の RGB。10〜249 は 15° ずつの色相 × 明るさ 5 段 × 濃淡 2 種 */
export function aciRgb(n: number): [number, number, number] {
  switch (n) {
    case 1: return [255, 0, 0];
    case 2: return [255, 255, 0];
    case 3: return [0, 255, 0];
    case 4: return [0, 255, 255];
    case 5: return [0, 0, 255];
    case 6: return [255, 0, 255];
    case 8: return [128, 128, 128];
    case 9: return [192, 192, 192];
  }
  if (n >= 250 && n <= 255) {
    const g = GRAYS[n - 250];
    return [g, g, g];
  }
  if (n < 10 || n > 249) return [255, 255, 255];
  const hue = Math.floor((n - 10) / 10) * 15;
  const sub = (n - 10) % 10;
  const value = [255, 165, 127, 76, 38][sub >> 1];
  // 奇数は淡い色（彩度が半分）
  const sat = sub & 1 ? 0.5 : 1;
  const c = value * sat;
  const h = hue / 60;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = value - c;
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return [Math.round(r + m), Math.round(g + m), Math.round(b + m)];
}

/** 色の一覧に出す呼び名 */
export function aciLabel(n: number): string {
  if (n === TRUE_COLOR_PEN) return '真の色';
  const name = NAMES[n];
  return name ? `色 ${n}（${name}）` : `色 ${n}`;
}
