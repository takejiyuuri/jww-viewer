import type { JwwDocument } from './types.ts';
import type { Scene } from '../render/geometry.ts';

/** Jw_cad でのレイヤの状態。0 は非表示、1 は表示のみ、2 は編集可、3 は書込 */
export type LayerState = 0 | 1 | 2 | 3;

export interface LayerInfo {
  no: number;
  name: string;
  state: number;
}

export interface LayerGroupInfo {
  no: number;
  scale: number;
  name: string;
  /** 図形が 1 つでもあるか */
  used: boolean;
  state: number;
  /** 書込レイヤ（Jw_cad で保存したときに書込にしていたレイヤ） */
  writeLayer: number;
  layers: LayerInfo[];
}

export interface LoadedInfo {
  name: string;
  version: number;
  paperSize: number;
  memo: string;
  counts: {
    lines: number; arcs: number; points: number; texts: number;
    solids: number; dims: number; blocks: number;
  };
  /** レイヤグループ番号ごとの縮尺分母と、実際に図形があるか */
  groups: LayerGroupInfo[];
  writeGroup: number;
  /** SXF 線種の名前（線種番号 30 から順）。属性の表示に使う */
  sxfLineTypeNames: string[];
  parseMs: number;
  warnings: string[];
}

/** 画面に出す図面の情報（ヘッダとレイヤの状態）をまとめる */
export function buildInfo(doc: JwwDocument, scene: Scene, name: string, parseMs: number): LoadedInfo {
  // 図形のあるレイヤグループ（部品の中身は配置した側に数えられている）
  const used = new Set<number>();
  for (let k = 0; k < 256; k++) if (scene.layerCounts[k] > 0) used.add(k >> 4);

  return {
    name,
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
