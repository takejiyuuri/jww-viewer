/**
 * ZIP から .jww を取り出す。LINE などは .jww をそのまま送れず、ZIP にして届けるため。
 * 展開はブラウザの DecompressionStream（deflate-raw、iOS 16.4 以降）に任せる。ZIP64・パスワード付きには対応しない
 */

export interface ZipEntry {
  /** フォルダを除いたファイル名 */
  name: string;
  buffer: ArrayBuffer;
}

/** 先頭が ZIP の印（PK\x03\x04）か */
export function isZipHead(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/**
 * ZIP の中の .jww をすべて取り出す（名前は ZIP の並び順）。.jww がなければ空の配列。
 * 展開後の合計が maxBytes を超えるもの（ZIP 爆弾など）は、展開しきる前に止める
 */
export async function jwwInZip(buffer: ArrayBuffer, maxBytes: number): Promise<ZipEntry[]> {
  const bytes = new Uint8Array(buffer);
  const v = new DataView(buffer);
  // 終わりの記録（EOCD）を後ろから探す。後ろにコメント（最大 65535 バイト）が付くことがある
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP の形式が読めません');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new Error('この ZIP の形式（ZIP64）には対応していません');

  const out: ZipEntry[] = [];
  let total = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP の形式が読めません');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const path = decodeName(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    const name = path.split(/[/\\]/).pop() ?? '';
    // Mac で作った ZIP の付け足し（__MACOSX/ や ._ で始まるもの）は図面ではない
    if (!/\.jww$/i.test(name) || name.startsWith('._') || /(^|[/\\])__MACOSX[/\\]/.test(path)) continue;
    if (flags & 1) throw new Error('パスワード付きの ZIP には対応していません');
    if (method !== 0 && method !== 8) throw new Error('この ZIP の圧縮方式には対応していません');
    total += usize;
    if (usize > maxBytes || total > maxBytes) throw new Error('ZIP の中の図面が大きすぎます');

    if (local + 30 > bytes.length || v.getUint32(local, true) !== 0x04034b50) throw new Error('ZIP の形式が読めません');
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + csize);
    if (data.length !== csize) throw new Error('ZIP が途中で切れています');
    out.push({ name, buffer: method === 0 ? data.slice().buffer : await inflate(data, usize) });
  }
  return out;
}

/** deflate を展開する。記録された大きさを超えたらそこで止める */
async function inflate(data: Uint8Array, size: number): Promise<ArrayBuffer> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('この端末では ZIP を展開できません（iOS 16.4 以降が必要です）');
  }
  const reader = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const out = new Uint8Array(size);
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > size) {
      await reader.cancel();
      throw new Error('ZIP を展開できませんでした');
    }
    out.set(value, n);
    n += value.length;
  }
  if (n !== size) throw new Error('ZIP を展開できませんでした');
  return out.buffer;
}

/**
 * ファイル名を読む。UTF-8 として読めなければ Shift_JIS とみなす
 * （Windows で作った ZIP は日本語の名前を Shift_JIS で入れることが多く、UTF-8 の印も付けない）
 */
function decodeName(b: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('shift_jis').decode(b);
  }
}
