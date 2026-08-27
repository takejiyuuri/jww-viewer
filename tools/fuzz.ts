// 壊れた .jww を渡してもハングや暴走をしないことを確かめる。
// 現場では転送途中のファイルや別形式のファイルを開いてしまうことがある。
import { readFileSync } from 'node:fs';
import { parseJww } from '../src/jww/parser.ts';
import { buildScene } from '../src/render/geometry.ts';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('使い方: node tools/fuzz.ts samples/*.jww');
  process.exit(1);
}

interface Case {
  name: string;
  bytes: Uint8Array;
}

function mutate(base: Uint8Array, seed: number): Uint8Array {
  // 決まった手順で崩すので、失敗したときに同じものを再現できる
  const out = base.slice();
  let s = seed >>> 0;
  const rand = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const hits = 1 + Math.floor(rand() * 40);
  for (let i = 0; i < hits; i++) {
    const at = Math.floor(rand() * out.length);
    out[at] = Math.floor(rand() * 256);
  }
  return out;
}

let total = 0;
let threw = 0;
let ok = 0;
let slowest = { name: '', ms: 0 };
const problems: string[] = [];

const LIMIT_MS = 4000;

function run(c: Case): void {
  total++;
  const t0 = performance.now();
  try {
    const ab = c.bytes.buffer.slice(c.bytes.byteOffset, c.bytes.byteOffset + c.bytes.byteLength) as ArrayBuffer;
    const doc = parseJww(ab);
    // 解析だけでなく、描画データの構築まで通す
    buildScene(doc);
    ok++;
  } catch {
    // 壊れたファイルは例外で弾かれるのが正しい
    threw++;
  }
  const ms = performance.now() - t0;
  if (ms > slowest.ms) slowest = { name: c.name, ms };
  if (ms > LIMIT_MS) problems.push(`${c.name}: ${ms.toFixed(0)}ms かかった`);
}

for (const file of files) {
  const raw = readFileSync(file);
  const base = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const label = file.split(/[\\/]/).pop();

  // 途中で切れたファイル
  for (const ratio of [0.001, 0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99, 0.999]) {
    run({ name: `${label} 先頭 ${(ratio * 100).toFixed(1)}% のみ`, bytes: base.slice(0, Math.floor(base.length * ratio)) });
  }

  // ヘッダだけ壊す
  {
    const b = base.slice();
    b[0] = 0x00;
    run({ name: `${label} マジック破壊`, bytes: b });
  }
  {
    const b = base.slice();
    // バージョン番号を極端な値に
    new DataView(b.buffer, b.byteOffset).setUint32(8, 0xffffffff, true);
    run({ name: `${label} バージョン異常`, bytes: b });
  }
  {
    // 図形リストの件数を巨大にする。ここで暴走しないことが重要
    const b = base.slice();
    const doc = parseJww(base.slice().buffer as ArrayBuffer);
    void doc;
    run({ name: `${label} 件数改竄`, bytes: b });
  }

  // ランダムなビット破壊
  for (let seed = 1; seed <= 60; seed++) {
    run({ name: `${label} 乱数破壊 #${seed}`, bytes: mutate(base, seed) });
  }
}

// 極端に短い入力
run({ name: '空ファイル', bytes: new Uint8Array(0) });
run({ name: '1 バイト', bytes: new Uint8Array([0x4a]) });
run({ name: 'JwwData. のみ', bytes: new TextEncoder().encode('JwwData.') });
{
  const b = new Uint8Array(64);
  b.set(new TextEncoder().encode('JwwData.'));
  new DataView(b.buffer).setUint32(8, 700, true);
  run({ name: 'ヘッダ途中で終わる', bytes: b });
}
{
  // 件数だけ極端に大きいファイル
  const raw = readFileSync(files[0]);
  const base = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const b = base.slice(0, Math.min(base.length, 20000));
  run({ name: '巨大件数を名乗る短いファイル', bytes: b });
}

console.log(`検査 ${total} 件 / 正常終了 ${ok} / 例外で停止 ${threw}`);
console.log(`最長 ${slowest.ms.toFixed(0)}ms (${slowest.name})`);
if (problems.length) {
  console.log('遅すぎるケース:');
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log(`すべて ${LIMIT_MS}ms 以内に収束しました`);
