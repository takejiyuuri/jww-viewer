/**
 * OCS（図形の座標系）を平面図（WCS の XY）に写す変換。押し出しの向き N から任意軸アルゴリズムで
 * OCS の x 軸・y 軸を決め、OCS の点 (x, y, 高さ) を WCS に直して XY だけを取る
 */
import type { Xform } from '../render/builder.ts';

type Vec = [number, number, number];

function cross(a: Vec, b: Vec): Vec {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(v: Vec): Vec | null {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 && Number.isFinite(l) ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

/** 押し出しの向きを単位ベクトルに（使えなければ (0, 0, 1)） */
export function unitNormal(n: Vec): Vec {
  return unit(n) ?? [0, 0, 1];
}

/** OCS の変換。押し出しの向きが (0, 0, 1) なら null（そのまま） */
export function ocsXform(normal: Vec, elevation: number): Xform | null {
  const n = unitNormal(normal);
  if (Math.abs(n[0]) < 1e-12 && Math.abs(n[1]) < 1e-12 && n[2] > 0) return null;
  // 任意軸アルゴリズム：N が Z 軸に近ければ Wy × N、そうでなければ Wz × N を x 軸にする
  const ax = unit(Math.abs(n[0]) < 1 / 64 && Math.abs(n[1]) < 1 / 64 ? cross([0, 1, 0], n) : cross([0, 0, 1], n));
  if (!ax) return null;
  const ay = unit(cross(n, ax)) ?? [0, 1, 0];
  const z = Number.isFinite(elevation) ? elevation : 0;
  return { a: ax[0], b: ax[1], c: ay[0], d: ay[1], e: z * n[0], f: z * n[1] };
}

/** WCS の楕円の短軸の向き（N × 長軸）の XY */
export function minorAxis(normal: Vec, mx: number, my: number, mz: number): [number, number] {
  const n = unitNormal(normal);
  const v = cross(n, [mx, my, Number.isFinite(mz) ? mz : 0]);
  return [v[0], v[1]];
}
