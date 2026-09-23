import { parseJww } from './parser.ts';
import { buildScene } from '../render/geometry.ts';
import type { Scene } from '../render/geometry.ts';
import { buildInfo, type LoadedInfo } from './info.ts';

export type { LayerState, LayerInfo, LayerGroupInfo, LoadedInfo } from './info.ts';

export interface LoadRequest {
  buffer: ArrayBuffer;
  name: string;
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

    const info = buildInfo(doc, scene, name, parseMs);

    // 型付き配列は複製せずに受け渡す（数十万要素あるので複製すると重い）
    const transfer: Transferable[] = [
      scene.linePos, scene.lineColor, scene.lineLayer, scene.lineSnap, scene.lineEntity,
      scene.triPos, scene.triColor, scene.triLayer, scene.triEntity,
      scene.snapPoint, scene.snapPointLayer, scene.snapPointColor, scene.snapPointEntity,
      scene.scales, scene.colors, scene.colorGroup, scene.layerCounts,
      ...Object.values(scene.entities).filter(ArrayBuffer.isView),
    ].map((a) => (a as ArrayBufferView).buffer as ArrayBuffer);
    const res: LoadResponse = { ok: true, scene, info };
    (self as unknown as Worker).postMessage(res, transfer);
  } catch (err) {
    const res: LoadResponse = { ok: false, error: (err as Error).message };
    (self as unknown as Worker).postMessage(res);
  }
};
