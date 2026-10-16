import type { JwwDocument } from './types.ts';
import type { Scene } from '../render/geometry.ts';
import { JW_SCALE_SLOTS, type LoadedInfo } from '../formats/info.ts';

export type { LayerState, LayerInfo, LayerGroupInfo, LoadedInfo } from '../formats/info.ts';

/** 画面に出す図面の情報（ヘッダとレイヤの状態）をまとめる */
export function buildInfo(doc: JwwDocument, scene: Scene, name: string, parseMs: number): LoadedInfo {
  // 図形のあるレイヤグループ（部品の中身は配置した側に数えられている）
  const used = new Set<number>();
  for (let k = 0; k < 256; k++) if (scene.layerCounts[k] > 0) used.add(k >> 4);

  return {
    name,
    format: 'jww',
    formatLabel: `Jw_cad ${(doc.header.version / 100).toFixed(2)}`,
    layerMode: 'jw',
    scaleSlots: JW_SCALE_SLOTS,
    version: doc.header.version,
    paperSize: doc.header.paperSize,
    memo: doc.header.memo,
    counts: {
      lines: doc.entities.lines.length,
      arcs: doc.entities.arcs.length,
      points: doc.entities.points.length,
      texts: doc.entities.texts.length,
      solids: doc.entities.solids.length,
      dims: doc.entities.dims.length,
      blocks: doc.entities.blocks.length,
    },
    groups: doc.header.groups.map((g, i) => ({
      no: i,
      scale: g.scale,
      name: g.name,
      used: used.has(i),
      state: g.state,
      writeLayer: g.writeLayer,
      layers: g.layers.map((l, j) => ({ no: j, name: l.name, state: l.state })),
    })),
    writeGroup: doc.header.writeGroup,
    sxfLineTypeNames: doc.header.sxfLineTypeNames,
    parseMs,
    warnings: doc.warnings,
  };
}
