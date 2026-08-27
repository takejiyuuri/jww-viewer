import type { SnapKind } from './snap.ts';

export interface MeasurePoint {
  /** 図面座標 */
  x: number;
  y: number;
  glayer: number;
  kind: SnapKind;
  /**
   * この点が乗っている図形のレイヤグループの縮尺分母。
   * 何もない場所や、縮尺の違う 2 本の交点のように決め手がない場合は null。
   */
  scale: number | null;
}

export const SNAP_LABEL: Record<SnapKind, string> = {
  endpoint: '端点',
  center: '中心・点',
  intersection: '交点',
  midpoint: '中点',
  online: '線上',
  free: '任意点',
};

/**
 * 図面座標の距離を実寸(mm)に直す。
 * JWW の座標は用紙上の mm なので、レイヤグループの縮尺分母を掛けると実寸になる。
 */
export function toReal(drawingDist: number, scale: number): number {
  return drawingDist * scale;
}

/** 実寸 mm を読みやすい文字列にする */
export function formatLength(mm: number): string {
  const abs = Math.abs(mm);
  if (abs >= 1000) {
    return `${(mm / 1000).toFixed(3)} m`;
  }
  return `${mm.toFixed(1)} mm`;
}

export interface Measured {
  /** 区間ごとの実寸(mm) */
  segments: number[];
  /** 区間ごとに使った縮尺の分母 */
  scales: number[];
  total: number;
  /** 縮尺の異なるレイヤグループをまたいでいる */
  mixed: boolean;
}

/**
 * 区間ごとに、その両端が乗っているレイヤグループの縮尺で実寸に直す。
 * 図面には縮尺の違う図が同居しているので、全区間を一つの縮尺で通すと桁が狂う。
 */
export function measureLengths(points: MeasurePoint[], fallback: number): Measured {
  const segments: number[] = [];
  const scales: number[] = [];
  let mixed = false;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const raw = Math.hypot(b.x - a.x, b.y - a.y);
    let scale: number;
    if (a.scale != null && b.scale != null) {
      if (a.scale === b.scale) {
        scale = a.scale;
      } else {
        scale = fallback;
        mixed = true;
      }
    } else {
      scale = a.scale ?? b.scale ?? fallback;
    }
    segments.push(raw * scale);
    scales.push(scale);
  }
  return { segments, scales, total: segments.reduce((x, y) => x + y, 0), mixed };
}
