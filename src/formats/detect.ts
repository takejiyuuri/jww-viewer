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
    return /\/\*SXF/.test(text) ? 'sfc' : 'p21';
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

/** 開けない形式なら、その理由（開ける形式なら null） */
export function unsupportedReason(format: DetectedFormat | null): string | null {
  switch (format) {
    case 'jww': case 'dxf': case 'zip': return null;
    case 'dwg': return 'DWG ファイルは開けません。CAD で DXF 形式に保存し直してから開いてください';
    case 'dxfb': return 'バイナリ形式の DXF には対応していません。ASCII（テキスト）形式の DXF で保存し直してください';
    case 'sfc': case 'p21': return 'SXF（.sfc・.p21）にはまだ対応していません';
    default: return 'JWW・DXF ファイルではありません';
  }
}
