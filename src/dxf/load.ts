/** DXF を読んで Scene と画面に出す情報にする（worker から別のチャンクとして読み込む） */
import { parseDxf } from './parse.ts';
import { buildDxfScene } from './scene.ts';
import type { Scene } from '../render/builder.ts';
import type { LoadedInfo } from '../formats/info.ts';

export function loadDxf(buffer: ArrayBuffer, name: string): { scene: Scene; info: LoadedInfo } {
  const t0 = performance.now();
  const doc = parseDxf(buffer);
  const r = buildDxfScene(doc);
  const parseMs = performance.now() - t0;
  const c = r.counts;
  const n = (...keys: string[]): number => keys.reduce((s, k) => s + (c[k] ?? 0), 0);
  // レイヤは 16 個ずつ仮のグループに入れる（グループは見せない）
  const groups = Array.from({ length: 16 }, (_, g) => {
    let used = false;
    for (let l = 0; l < 16; l++) if (r.scene.layerCounts[(g << 4) | l] > 0) used = true;
    return {
      no: g, scale: r.scene.scales[0], name: '', used, state: 2, writeLayer: -1,
      layers: Array.from({ length: 16 }, (_, l) => {
        const layer = r.layers[(g << 4) | l];
        return { no: l, name: layer?.name ?? '', state: layer?.state ?? 2 };
      }),
    };
  });
  const info: LoadedInfo = {
    name,
    format: 'dxf',
    formatLabel: `DXF${doc.version ? `（${doc.version}）` : ''}`,
    layerMode: 'flat',
    scaleSlots: [{ no: 0, label: 'モデル空間', scale: r.scene.scales[0], used: true }],
    units: r.units,
    lineTypeNames: r.lineTypeNames,
    extraCounts: c,
    version: 0,
    paperSize: -1,
    memo: '',
    counts: {
      lines: n('LINE', 'POLYLINE'),
      arcs: n('ARC', 'CIRCLE', 'ELLIPSE'),
      points: n('POINT'),
      texts: n('TEXT'),
      solids: n('SOLID'),
      dims: 0,
      blocks: n('INSERT'),
    },
    groups,
    writeGroup: -1,
    sxfLineTypeNames: [],
    parseMs,
    warnings: r.warnings,
  };
  return { scene: r.scene, info };
}
