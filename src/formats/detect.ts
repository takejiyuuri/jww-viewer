/** ファイルの先頭から形式を見分ける。拡張子は中身で決まらないときだけ使う */
import { isJwwHead } from '../jww/header.ts';

export type DetectedFormat = 'jww' | 'zip' | 'dxf' | 'dxfb' | 'sfc' | 'p21' | 'dwg';

/** 見分けに使う先頭のバイト数 */
export const DETECT_BYTES = 4096;

export function detectFormat(head: Uint8Array, name = ''): DetectedFormat | null {
  if (isJwwHead(head)) return 'jww';
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'zip';
  const text = new TextDecoder('latin1').decode(head.subarray(0, DETECT_BYTES));
  if (text.startsWith('AutoCAD Binary DXF')) return 'dxfb';
  // DWG は "AC10" と版の数字で始まる
  if (/^AC10\d\d/.test(text)) return 'dwg';
  if (/^﻿?\s*ISO-10303-21;/.test(text) || text.startsWith('ï»¿ISO-10303-21;')) {
    // SFC は DATA 節の図形を /*SXF … SXF*/ の注釈に書く（FILE_DESCRIPTION は 'SCADEC level2 feature_mode'）
    return /\/\*SXF/.test(text) || /feature_mode/i.test(text) ? 'sfc' : 'p21';
  }
  if (/^\s*\/\*SXF/.test(text)) return 'sfc';
  if (isDxfText(text)) return 'dxf';
  // 中身で決まらないときは拡張子で（先頭の注釈が長い DXF など）
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext === 'dxf' && /^\s*\d+\s*\r?\n/.test(text.replace(/^ï»¿/, ''))) return 'dxf';
  return null;
}

/** 先頭が「0 / SECTION」（前に 999 の注釈があってもよい）か */
function isDxfText(text: string): boolean {
  const lines = text.replace(/^ï»¿/, '').split('\n').map((l) => l.trim());
  let i = 0;
  while (i + 1 < lines.length && lines[i] === '999') i += 2;
  return lines[i] === '0' && lines[i + 1] === 'SECTION';
}

/** 図面の形式（ZIP は入れ物なので含めない）。拡張子と同じ綴り */
export type DrawingFormat = 'jww' | 'dxf' | 'sfc' | 'p21';

/** Web 版で開く形式 */
export const WEB_FORMATS: readonly DrawingFormat[] = ['jww', 'dxf', 'sfc', 'p21'];

/**
 * iOS アプリで開く形式。アプリの 1.1 は Jw_cad の図面（.jww）だけにし、DXF・SXF は Web 版だけで試す。
 * アプリでも開けるようにする版（1.2 の予定）では、この 1 行に 'dxf', 'sfc', 'p21' を足すだけでよい
 * （ファイルの選択・ZIP の中の一覧・開く前の確かめは、どれもこの並びに従う）
 */
export const NATIVE_FORMATS: readonly DrawingFormat[] = ['jww'];

/** この版では開かない形式を選んだときの知らせ */
export const NOT_IN_THIS_VERSION = 'このアプリの版で開けるのは Jw_cad の図面（.jww）だけです。DXF・SXF は今後の版で対応します';

/** 開けない形式なら、その理由（開ける形式なら null）。allowed はこの版で開く図面の形式 */
export function unsupportedReason(format: DetectedFormat | null, allowed: readonly DrawingFormat[] = WEB_FORMATS): string | null {
  const drawing = format as DrawingFormat;
  if (WEB_FORMATS.includes(drawing) && !allowed.includes(drawing)) return NOT_IN_THIS_VERSION;
  switch (format) {
    case 'jww': case 'dxf': case 'sfc': case 'p21': case 'zip': return null;
    case 'dwg': return 'DWG ファイルは開けません。CAD で DXF 形式に保存し直してから開いてください';
    case 'dxfb': return 'バイナリ形式の DXF には対応していません。ASCII（テキスト）形式の DXF で保存し直してください';
    default: return 'JWW・DXF・SXF ファイルではありません';
  }
}
