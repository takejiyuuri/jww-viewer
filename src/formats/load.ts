/** 形式ごとに図面を読んで Scene と情報にする。worker と tools から共通に使う */
import { parseJww } from '../jww/parser.ts';
import { buildScene, type Scene } from '../render/geometry.ts';
import { buildInfo } from '../jww/info.ts';
import type { LoadedInfo } from './info.ts';
import { detectFormat, unsupportedReason } from './detect.ts';

export async function loadDrawing(
  buffer: ArrayBuffer, name: string, format = detectFormat(new Uint8Array(buffer, 0, Math.min(4096, buffer.byteLength)), name),
): Promise<{ scene: Scene; info: LoadedInfo }> {
  if (format === 'jww') {
    const t0 = performance.now();
    const doc = parseJww(buffer);
    const scene = buildScene(doc);
    return { scene, info: buildInfo(doc, scene, name, performance.now() - t0) };
  }
  if (format === 'dxf') {
    // DXF の読み取りは別のチャンクにする（JWW を開く速さを保つため）
    const { loadDxf } = await import('../dxf/load.ts');
    return loadDxf(buffer, name);
  }
  if (format === 'sfc' || format === 'p21') {
    // SXF の読み取りも別のチャンクにする
    const { loadSxf } = await import('../sxf/load.ts');
    const { scene, info } = loadSxf(buffer, name, format);
    return { scene, info };
  }
  throw new Error(unsupportedReason(format) ?? '対応していない形式です');
}
