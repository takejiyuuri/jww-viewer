// 壊れた .jww を渡してもハングや暴走をしないことを確かめる。
// 現場では転送途中のファイルや別形式のファイルを開いてしまうことがある。
// アプリと同じく、解析・描画データ・図面の情報（ワーカの中）から吸着の索引（画面の側）まで通す。
// 1 件ずつ別スレッドで動かし、止まらないものは打ち切って報告する。
import { readFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { parseJww } from '../src/jww/parser.ts';
import { Reader } from '../src/jww/reader.ts';
import { parseHeader } from '../src/jww/header.ts';
import { buildInfo } from '../src/jww/info.ts';
import { buildScene } from '../src/render/geometry.ts';
import { SnapIndex } from '../src/measure/snap.ts';
import { sampleFiles } from './samples.mjs';

interface Case {
  name: string;
  bytes: Uint8Array;
}

interface Result {
  ms: number;
  /** 例外で止まったときの内容 */
  error?: string;
  /** Error 以外の例外（TypeError・RangeError など）。壊れたファイルを弾いたのではなく、実装の不具合 */
  bug?: boolean;
}

/** 別スレッドの側：受け取ったバイト列をアプリと同じ順に通す */
function check(bytes: Uint8Array): Result {
  const t0 = performance.now();
  try {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const doc = parseJww(ab);
    const scene = buildScene(doc);
    buildInfo(doc, scene, 'fuzz.jww', 0);
    new SnapIndex(scene);
    return { ms: performance.now() - t0 };
  } catch (e) {
    // 壊れたファイルは Error で弾かれるのが正しい
    return { ms: performance.now() - t0, error: String(e), bug: !(e instanceof Error) || e.constructor !== Error };
  }
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

/** 図形リストの件数が書かれている位置（ヘッダのすぐ後） */
function countAt(base: Uint8Array): number {
  const r = new Reader(base.slice().buffer as ArrayBuffer);
  parseHeader(r);
  return r.pos;
}

/** 件数を count に書き換える。0xFFFF 未満は WORD、それ以上は 0xFFFF の後に DWORD（CArchive の決まり） */
function withCount(base: Uint8Array, at: number, count: number): Uint8Array {
  const wide = new DataView(base.buffer, base.byteOffset).getUint16(at, true) === 0xffff;
  const tail = base.subarray(at + (wide ? 6 : 2));
  const size = count < 0xffff ? 2 : 6;
  const out = new Uint8Array(at + size + tail.length);
  out.set(base.subarray(0, at));
  const dv = new DataView(out.buffer);
  if (count < 0xffff) {
    dv.setUint16(at, count, true);
  } else {
    dv.setUint16(at, 0xffff, true);
    dv.setUint32(at + 2, count, true);
  }
  out.set(tail, at + size);
  return out;
}

if (!isMainThread) {
  parentPort!.on('message', (bytes: Uint8Array) => parentPort!.postMessage(check(bytes)));
} else {
  await main();
}

async function main(): Promise<void> {
  const files = sampleFiles();

  let total = 0;
  let threw = 0;
  let ok = 0;
  let slowest = { name: '', ms: 0 };
  const problems: string[] = [];

  const LIMIT_MS = 4000;
  // これを過ぎても返ってこなければ、止まらないとみなして打ち切る
  const HANG_MS = LIMIT_MS * 5;

  let worker: Worker | null = null;

  /** 1 件を別スレッドで動かす。打ち切ったときと、スレッドごと落ちたときはその理由を返す */
  function inWorker(bytes: Uint8Array): Promise<Result | string> {
    const w = (worker ??= new Worker(new URL(import.meta.url)));
    return new Promise((resolve) => {
      const done = (r: Result | string): void => {
        clearTimeout(timer);
        w.off('message', onMessage);
        w.off('error', onError);
        if (typeof r === 'string') {
          // 次の件は新しいスレッドで動かす
          worker = null;
          void w.terminate();
        }
        resolve(r);
      };
      const onMessage = (r: Result): void => done(r);
      const onError = (e: Error): void => done(`スレッドが落ちた（${e.message}）`);
      const timer = setTimeout(() => done(`${HANG_MS}ms たっても終わらないので打ち切った`), HANG_MS);
      w.on('message', onMessage);
      w.on('error', onError);
      // どのケースも専用のバイト列なので、写さずに渡す
      w.postMessage(bytes, [bytes.buffer as ArrayBuffer]);
    });
  }

  async function run(c: Case): Promise<void> {
    total++;
    const r = await inWorker(c.bytes);
    if (typeof r === 'string') {
      problems.push(`${c.name}: ${r}`);
      return;
    }
    if (r.error === undefined) ok++;
    else threw++;
    if (r.bug) problems.push(`${c.name}: 実装の不具合らしい例外 ${r.error}`);
    if (r.ms > slowest.ms) slowest = { name: c.name, ms: r.ms };
    if (r.ms > LIMIT_MS) problems.push(`${c.name}: ${r.ms.toFixed(0)}ms かかった`);
  }

  for (const file of files) {
    const raw = readFileSync(file);
    const base = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const label = file.split(/[\\/]/).pop();

    // 途中で切れたファイル
    for (const ratio of [0.001, 0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99, 0.999]) {
      await run({ name: `${label} 先頭 ${(ratio * 100).toFixed(1)}% のみ`, bytes: base.slice(0, Math.floor(base.length * ratio)) });
    }

    // ヘッダだけ壊す
    {
      const b = base.slice();
      b[0] = 0x00;
      await run({ name: `${label} マジック破壊`, bytes: b });
    }
    {
      const b = base.slice();
      // バージョン番号を極端な値に
      new DataView(b.buffer, b.byteOffset).setUint32(8, 0xffffffff, true);
      await run({ name: `${label} バージョン異常`, bytes: b });
    }
    {
      // 図形リストの件数を巨大にする。ここで暴走しないことが重要
      const at = countAt(base);
      await run({ name: `${label} 件数改竄（0xFFFE 件）`, bytes: withCount(base, at, 0xfffe) });
      await run({ name: `${label} 件数改竄（0xFFFFFFFF 件）`, bytes: withCount(base, at, 0xffffffff) });
    }

    // ランダムなビット破壊
    for (let seed = 1; seed <= 60; seed++) {
      await run({ name: `${label} 乱数破壊 #${seed}`, bytes: mutate(base, seed) });
    }
  }

  // 極端に短い入力
  await run({ name: '空ファイル', bytes: new Uint8Array(0) });
  await run({ name: '1 バイト', bytes: new Uint8Array([0x4a]) });
  await run({ name: 'JwwData. のみ', bytes: new TextEncoder().encode('JwwData.') });
  {
    const b = new Uint8Array(64);
    b.set(new TextEncoder().encode('JwwData.'));
    new DataView(b.buffer).setUint32(8, 700, true);
    await run({ name: 'ヘッダ途中で終わる', bytes: b });
  }
  {
    // 件数だけ極端に大きく、中身は 4 KB で終わるファイル
    const raw = readFileSync(files[0]);
    const base = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const at = countAt(base);
    await run({ name: '巨大件数を名乗る短いファイル', bytes: withCount(base, at, 0xffffffff).slice(0, at + 6 + 4096) });
  }

  await worker?.terminate();

  console.log(`検査 ${total} 件 / 正常終了 ${ok} / 例外で停止 ${threw}`);
  console.log(`最長 ${slowest.ms.toFixed(0)}ms (${slowest.name})`);
  if (problems.length) {
    console.log('問題のあったケース:');
    for (const p of problems) console.log(`  ${p}`);
    process.exit(1);
  }
  console.log(`すべて ${LIMIT_MS}ms 以内に収束し、どれも Error で弾くか最後まで通りました`);
}
