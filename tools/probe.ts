// 実ファイルで CArchive のクラスタグ採番方式を確認する調査用スクリプト
import { readFileSync } from 'node:fs';
import { Reader } from '../src/jww/reader.ts';
import { parseHeader } from '../src/jww/header.ts';

const file = process.argv[2];
const buf = readFileSync(file);
const r = new Reader(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const h = parseHeader(r);
console.log(`version=${h.version} memo=${JSON.stringify(h.memo)} paper=${h.paperSize}`);
console.log(`図形データ開始位置 = 0x${r.pos.toString(16)} (${r.pos}) / ファイル長 ${r.length}`);
console.log(`グループ0の縮尺=1/${h.groups[0].scale}, 書込グループ=${h.writeGroup}`);

const total = r.count();
console.log(`トップレベル要素数 = ${total}`);

// 先頭 40 タグをそのまま表示
console.log('\n--- 生タグの並び (先頭は新クラス宣言のはず) ---');
for (let n = 0; n < 40 && !r.eof; n++) {
  const at = r.pos;
  const wTag = r.u16();
  if (wTag === 0xffff) {
    const schema = r.u16();
    const len = r.u16();
    const name = r.ascii(len);
    console.log(`[${n}] @0x${at.toString(16)} NEWCLASS schema=${schema} name=${name}`);
    // クラス本体のバイトを少し見せて、次のタグ位置の手がかりにする
    console.log(`      次の 32 バイト: ${Buffer.from(r.bytes.subarray(r.pos, r.pos + 32)).toString('hex')}`);
    break;
  } else {
    console.log(`[${n}] @0x${at.toString(16)} tag=0x${wTag.toString(16)}`);
  }
}
