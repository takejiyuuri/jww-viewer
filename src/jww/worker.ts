import type { Scene } from '../render/geometry.ts';
import type { LoadedInfo } from '../formats/info.ts';
import { loadDrawing } from '../formats/load.ts';
import type { DetectedFormat } from '../formats/detect.ts';

export type { LayerState, LayerInfo, LayerGroupInfo, LoadedInfo } from '../formats/info.ts';

export interface LoadRequest {
  buffer: ArrayBuffer;
  name: string;
  /** 見分けた形式（なければ worker で見分ける） */
  format?: DetectedFormat | null;
}

export type LoadResponse =
  | { ok: true; scene: Scene; info: LoadedInfo }
  | { ok: false; error: string };

self.onmessage = async (ev: MessageEvent<LoadRequest>) => {
  const { buffer, name, format } = ev.data;
  try {
    const { scene, info } = await loadDrawing(buffer, name, format ?? undefined);

    // 型付き配列は複製せずに受け渡す（数十万要素あるので複製すると重い）
    const transfer: Transferable[] = [
      scene.linePos, scene.lineColor, scene.lineLayer, scene.lineSnap, scene.lineEntity,
      scene.lineStyle, scene.lineDist, scene.dashes, scene.dotPos, scene.dotColor, scene.dotLayer,
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
