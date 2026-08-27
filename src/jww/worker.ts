import { parseJww } from './parser.ts';
import { buildScene } from '../render/geometry.ts';
import type { Scene } from '../render/geometry.ts';

export interface LoadRequest {
  buffer: ArrayBuffer;
  name: string;
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
  groups: { no: number; scale: number; name: string; used: boolean }[];
  writeGroup: number;
  parseMs: number;
  warnings: string[];
}

export type LoadResponse =
  | { ok: true; scene: Scene; info: LoadedInfo }
  | { ok: false; error: string };

self.onmessage = (ev: MessageEvent<LoadRequest>) => {
  const { buffer, name } = ev.data;
  try {
    const t0 = performance.now();
    const doc = parseJww(buffer);
    const scene = buildScene(doc);
    const parseMs = performance.now() - t0;

    const used = new Set<number>();
    for (let i = 0; i < scene.lineGroup.length; i++) used.add(scene.lineGroup[i]);

    const info: LoadedInfo = {
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
      })),
      writeGroup: doc.header.writeGroup,
      parseMs,
      warnings: doc.warnings,
    };

    const transfer: Transferable[] = [
      scene.linePos.buffer, scene.lineCol.buffer, scene.lineGroup.buffer,
      scene.lineSnap.buffer, scene.triPos.buffer, scene.triCol.buffer,
      scene.snapPoint.buffer, scene.snapPointGroup.buffer, scene.scales.buffer,
    ];
    const res: LoadResponse = { ok: true, scene, info };
    (self as unknown as Worker).postMessage(res, transfer);
  } catch (err) {
    const res: LoadResponse = { ok: false, error: (err as Error).message };
    (self as unknown as Worker).postMessage(res);
  }
};
