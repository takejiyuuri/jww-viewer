/**
 * DXF（ASCII）の文字コードを決めて、2 行ずつの「グループコード・値」の組に分ける。
 * AC1021（AutoCAD 2007）以降は UTF-8。それより前は $DWGCODEPAGE の符号（日本語は ANSI_932 = Shift_JIS）で書かれる
 */

/** コード・値の組の上限（壊れたファイルや途方もない図面で、メモリを使い果たさないように） */
export const MAX_PAIRS = 30_000_000;

export interface DxfPairs {
  codes: Int32Array;
  values: string[];
  count: number;
}

/** 文字コードを決めて文字列にする */
export function decodeDxf(buffer: ArrayBuffer): { text: string; encoding: string } {
  const bytes = new Uint8Array(buffer);
  // ヘッダは先頭にあるので、先頭 64KB だけを 1 バイト 1 文字で見る
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 65536));
  const ver = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d{4})/.exec(head)?.[1] ?? '';
  const page = (/\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*([^\r\n]*)/.exec(head)?.[1] ?? '').trim().toUpperCase();
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  const body = bytes.subarray(start);
  if (ver >= 'AC1021') return { text: new TextDecoder('utf-8').decode(body), encoding: 'utf-8' };
  if (page === 'ANSI_932' || page === 'DOS932') return { text: new TextDecoder('shift_jis').decode(body), encoding: 'shift_jis' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('shift_jis').decode(body), encoding: 'shift_jis' };
  }
}

/** 行に分けて、コード・値の組にする。コードが数でない行に当たったら、そこで読むのをやめる（壊れた末尾など） */
export function tokenize(text: string): DxfPairs {
  const lines = text.split('\n');
  const n = Math.floor(lines.length / 2);
  if (n > MAX_PAIRS) throw new Error('DXF が大きすぎます');
  const codes = new Int32Array(n);
  const values = new Array<string>(n);
  let count = 0;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i], 10);
    if (!Number.isFinite(code)) break;
    let v = lines[i + 1];
    if (v.endsWith('\r')) v = v.slice(0, -1);
    codes[count] = code;
    values[count] = v;
    count++;
  }
  return { codes, values, count };
}
