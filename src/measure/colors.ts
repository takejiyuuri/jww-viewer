import type { Background } from '../render/theme.ts';

/** 計測の印・線・数字の色。hex が null のものは背景に合わせて白か黒にする */
export interface MeasureColor {
  id: string;
  name: string;
  hex: string | null;
}

export const MEASURE_COLORS: MeasureColor[] = [
  { id: 'green', name: '緑', hex: '#35d07f' },
  { id: 'blue', name: '青', hex: '#3fa9ff' },
  { id: 'red', name: '赤', hex: '#ff4d4d' },
  { id: 'orange', name: '橙', hex: '#ff9500' },
  { id: 'yellow', name: '黄', hex: '#ffd60a' },
  { id: 'purple', name: '紫', hex: '#bf5af2' },
  { id: 'pink', name: '桃', hex: '#ff5fa2' },
  { id: 'mono', name: '白黒', hex: null },
];

export const DEFAULT_MEASURE_COLOR = 'green';

/** 計測を描くときの色一式 */
export interface MeasureInk {
  /** 印の縁・線 */
  stroke: string;
  /** 測線（少し透かす） */
  line: string;
  /** 直交の基準線 */
  guide: string;
  /** 面積の塗り */
  fill: string;
  /** 長さのラベルの文字と地 */
  text: string;
  label: string;
  /** 印の中の塗り */
  dot: string;
}

function rgba(hex: string, a: number): string {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
}

export function measureColor(id: string): MeasureColor {
  return MEASURE_COLORS.find((c) => c.id === id) ?? MEASURE_COLORS[0];
}

export function measureInk(id: string, background: Background): MeasureInk {
  const hex = measureColor(id).hex;
  if (hex) {
    return {
      stroke: hex,
      line: rgba(hex, 0.85),
      guide: rgba(hex, 0.38),
      fill: rgba(hex, 0.16),
      text: hex,
      label: 'rgba(11,12,16,0.88)',
      dot: 'rgba(11,12,16,0.65)',
    };
  }
  // 白黒：黒い背景には白、白い背景には黒。ラベルの地は文字と反対の色にする
  return background === 'light'
    ? {
      stroke: '#111318',
      line: 'rgba(17,19,24,0.85)',
      guide: 'rgba(17,19,24,0.38)',
      fill: 'rgba(17,19,24,0.12)',
      text: '#111318',
      label: 'rgba(255,255,255,0.9)',
      dot: 'rgba(255,255,255,0.7)',
    }
    : {
      stroke: '#ffffff',
      line: 'rgba(255,255,255,0.85)',
      guide: 'rgba(255,255,255,0.38)',
      fill: 'rgba(255,255,255,0.14)',
      text: '#ffffff',
      label: 'rgba(11,12,16,0.88)',
      dot: 'rgba(11,12,16,0.65)',
    };
}
