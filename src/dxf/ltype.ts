/**
 * DXF の線種（LTYPE の要素の長さ）を、画面表示の模様（32 ビット、Scene.dashes の形）に近づける。
 * 模様の大きさは Jw_cad と同じく画面のドット単位にする（$LTSCALE などの長さそのものは使わない）
 */
import type { DxfLineType } from './types.ts';

/** 線種に割り当てる番号。補助線種（9）とランダム線（11〜15）は使わない */
export const DXF_STYLE_SLOTS: number[] = [2, 3, 4, 5, 6, 7, 8, 10, ...Array.from({ length: 48 }, (_, i) => 16 + i)];

/** 1 周期のおよそのビット数 */
const TARGET_BITS = 24;

/** 模様 [ビット列, 1 周期のビット数 | 1 ビットのドット数 << 8]。実線（空きのない線種）なら null */
export function dashPattern(t: DxfLineType): [number, number] | null {
  const els = t.pattern.filter(Number.isFinite);
  const total = els.reduce((s, v) => s + Math.abs(v), 0);
  if (!(total > 0) || !els.some((v) => v < 0)) return null;
  let bits = els.map((v) => Math.max(1, Math.round((Math.abs(v) / total) * TARGET_BITS)));
  let sum = bits.reduce((s, v) => s + v, 0);
  if (sum > 32) {
    // 要素が多すぎるときは縮める（それでも収まらなければ実線）
    bits = els.map((v) => Math.max(1, Math.floor((Math.abs(v) / total) * 32)));
    sum = bits.reduce((s, v) => s + v, 0);
    if (sum > 32) return null;
  }
  let pattern = 0;
  let pos = 0;
  els.forEach((v, i) => {
    for (let k = 0; k < bits[i]; k++, pos++) if (v >= 0) pattern |= 1 << (31 - pos);
  });
  return [pattern >>> 0, sum | (1 << 8)];
}
