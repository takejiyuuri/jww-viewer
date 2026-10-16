/** SXF（SFC・P21）を読んで Scene と画面に出す情報にする（worker から別のチャンクとして読み込む） */
import { parseSfc } from './sfc.ts';
import { parseP21 } from './p21.ts';
import { ap202ToSxf } from './ap202.ts';
import { buildSxfScene, type SxfSceneResult } from './scene.ts';
import type { SxfDocument } from './types.ts';
import type { Scene } from '../render/builder.ts';
import type { LoadedInfo } from '../formats/info.ts';

/** 文書モデルまで読む（tools から確かめるのにも使う） */
export function parseSxf(buffer: ArrayBuffer, format: 'sfc' | 'p21'): SxfDocument {
  return format === 'sfc' ? parseSfc(buffer) : ap202ToSxf(parseP21(buffer));
}

export function loadSxf(
  buffer: ArrayBuffer, name: string, format: 'sfc' | 'p21',
): { scene: Scene; info: LoadedInfo; result: SxfSceneResult } {
  const t0 = performance.now();
  const doc = parseSxf(buffer, format);
  const r = buildSxfScene(doc);
  const parseMs = performance.now() - t0;
  const c = r.counts;
  const n = (...keys: string[]): number => keys.reduce((s, k) => s + (c[k] ?? 0), 0);
  // レイヤは 16 個ずつ仮のグループに入れる（グループは見せない）
  const groups = Array.from({ length: 16 }, (_, g) => {
    let used = false;
    for (let l = 0; l < 16; l++) if (r.scene.layerCounts[(g << 4) | l] > 0) used = true;
    return {
      no: g, scale: 1, name: '', used, state: 2, writeLayer: -1,
      layers: Array.from({ length: 16 }, (_, l) => {
        const layer = r.layers[(g << 4) | l];
        return { no: l, name: layer?.name ?? '', state: layer?.state ?? 2 };
      }),
    };
  });
  const info: LoadedInfo = {
    name,
    format,
    formatLabel: format === 'sfc' ? 'SXF（SFC）' : 'SXF（P21）',
    layerMode: 'flat',
    scaleSlots: r.slots,
    paperLabel: r.paperLabel,
    lineTypeNames: r.lineTypeNames,
    extraCounts: c,
    version: 0,
    paperSize: -1,
    memo: doc.sheetName,
    counts: {
      lines: n('line', 'polyline', 'spline', 'clothoid', 'label', 'balloon'),
      arcs: n('arc', 'circle', 'ellipse', 'ellipseArc'),
      points: n('point', 'symbol'),
      texts: n('text'),
      solids: n('hatch:fill', 'hatch:pattern', 'hatch:external', 'hatch:tiles'),
      dims: n('dim'),
      blocks: n('locate'),
    },
    groups,
    writeGroup: -1,
    sxfLineTypeNames: [],
    parseMs,
    warnings: r.warnings,
  };
  return { scene: r.scene, info, result: r };
}
