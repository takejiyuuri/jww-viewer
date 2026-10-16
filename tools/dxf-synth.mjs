// 検証用の DXF を合成する（答えの分かっている図形だけを並べたもの）。
//   node tools/dxf-synth.mjs 出力フォルダ … basic.dxf・utf8.dxf・unitless.dxf を書き出す
// verify-dxf.ts と e2e-dxf.mjs は、ここの関数で作った中身をそのまま使う
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shift_JIS のバイト列（使う文字だけの表） */
const SJIS = { 日: [0x93, 0xfa], 本: [0x96, 0x7b], 語: [0x8c, 0xea], 壁: [0x95, 0xc7] };

/** 文字列を Shift_JIS に（表にない文字は ASCII として 1 バイト） */
function sjis(s) {
  const out = [];
  for (const ch of s) {
    if (SJIS[ch]) out.push(...SJIS[ch]);
    else out.push(ch.charCodeAt(0) & 0x7f);
  }
  return out;
}

/** コード・値の組を DXF の行に */
class Dxf {
  constructor() { this.lines = []; }
  pair(code, value) { this.lines.push(String(code).padStart(3), String(value)); return this; }
  pairs(...list) { for (let i = 0; i < list.length; i += 2) this.pair(list[i], list[i + 1]); return this; }
  text() { return this.lines.join('\r\n') + '\r\n'; }
}

function header(d, ver, codepage, insunits) {
  d.pairs(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, ver);
  if (codepage) d.pairs(9, '$DWGCODEPAGE', 3, codepage);
  if (insunits !== undefined) d.pairs(9, '$INSUNITS', 70, insunits);
  d.pairs(0, 'ENDSEC');
}

function tables(d, layers, ltypes = []) {
  d.pairs(0, 'SECTION', 2, 'TABLES');
  d.pairs(0, 'TABLE', 2, 'LTYPE', 70, ltypes.length + 1);
  d.pairs(0, 'LTYPE', 2, 'CONTINUOUS', 70, 0, 3, 'Solid line', 72, 65, 73, 0, 40, 0);
  for (const t of ltypes) {
    d.pairs(0, 'LTYPE', 2, t.name, 70, 0, 3, t.desc ?? '', 72, 65, 73, t.pattern.length, 40, t.pattern.reduce((s, v) => s + Math.abs(v), 0));
    for (const v of t.pattern) d.pairs(49, v, 74, 0);
  }
  d.pairs(0, 'ENDTAB');
  d.pairs(0, 'TABLE', 2, 'LAYER', 70, layers.length);
  for (const l of layers) {
    d.pairs(0, 'LAYER', 2, l.name, 70, l.flags ?? 0, 62, l.color ?? 7, 6, l.ltype ?? 'CONTINUOUS');
    if (l.trueColor !== undefined) d.pair(420, l.trueColor);
  }
  d.pairs(0, 'ENDTAB', 0, 'ENDSEC');
}

const line = (d, layer, x1, y1, x2, y2, extra = []) => d.pairs(0, 'LINE', 8, layer, ...extra, 10, x1, 20, y1, 30, 0, 11, x2, 21, y2, 31, 0);

/**
 * R2000（AC1015）・ANSI_932（Shift_JIS）・単位 mm の図面。
 * 答え（verify-dxf.ts で確かめる）:
 *   LINE (0,0)-(1000,0) レイヤ「壁」、色 1
 *   LWPOLYLINE (0,300)-(200,300) ふくらみ 1 → 半円、半径 100、長さ 100π
 *   POLYLINE（VERTEX）(0,600)-(100,600)-(100,700)、最初の辺のふくらみ -1 → 長さ 50π + 100
 *   ELLIPSE 中心 (500,500) 長軸 (200,0) 比 0.5 の 1/4（0〜π/2）
 *   CIRCLE (700,0) r=50、ARC (900,0) r=100 0〜90°
 *   TEXT 「日本語」の後ろに %%c50（Ø50）
 *   部品 B1（基点 (10,10)、中身はレイヤ 0・色 BYBLOCK の線 (10,10)-(20,10)）
 *     INSERT B1 (1000,1000) 倍率 2・90° レイヤ「壁」色 3 → (1000,1000)-(1000,1020)、レイヤ「壁」、色 3
 *     INSERT B1 (2000,0) 倍率 x -1（反転） → (2000,0)-(1990,0)
 *     INSERT B2 (3000,0)。B2 の中に INSERT B1 (100,0) 90° → (3100,0)-(3100,10)
 *     INSERT B3（自分を配置する部品）→ 止まること
 *   真の色 0x123456 の線 (0,-100)-(100,-100)
 *   レイヤ HIDDEN（色 -3）と FROZEN（70=1）の線、レイヤ DASHLAYER は線種 DASHED
 *   ペーパー空間の線 1 本と MTEXT 1 個は読み飛ばす
 */
export function basicDxf() {
  const d = new Dxf();
  d.pairs(999, 'synthetic');
  header(d, 'AC1015', 'ANSI_932', 4);
  tables(d, [
    { name: '0' },
    { name: '壁', color: 1 },
    { name: 'HIDDEN', color: -3 },
    { name: 'FROZEN', color: 2, flags: 1 },
    { name: 'DASHLAYER', color: 4, ltype: 'DASHED' },
  ], [{ name: 'DASHED', desc: '__ __', pattern: [12.7, -6.35] }]);

  d.pairs(0, 'SECTION', 2, 'BLOCKS');
  d.pairs(0, 'BLOCK', 8, '0', 2, 'B1', 70, 0, 10, 10, 20, 10, 30, 0, 3, 'B1');
  line(d, '0', 10, 10, 20, 10, [62, 0]);
  d.pairs(0, 'ENDBLK', 8, '0');
  d.pairs(0, 'BLOCK', 8, '0', 2, 'B2', 70, 0, 10, 0, 20, 0, 30, 0, 3, 'B2');
  d.pairs(0, 'INSERT', 8, '0', 2, 'B1', 10, 100, 20, 0, 30, 0, 50, 90);
  d.pairs(0, 'ENDBLK', 8, '0');
  d.pairs(0, 'BLOCK', 8, '0', 2, 'B3', 70, 0, 10, 0, 20, 0, 30, 0, 3, 'B3');
  line(d, '0', 0, 0, 1, 1);
  d.pairs(0, 'INSERT', 8, '0', 2, 'B3', 10, 5, 20, 5, 30, 0);
  d.pairs(0, 'ENDBLK', 8, '0');
  d.pairs(0, 'ENDSEC');

  d.pairs(0, 'SECTION', 2, 'ENTITIES');
  line(d, '壁', 0, 0, 1000, 0);
  d.pairs(0, 'LWPOLYLINE', 8, '0', 90, 2, 70, 0, 10, 0, 20, 300, 42, 1, 10, 200, 20, 300);
  d.pairs(0, 'POLYLINE', 8, '0', 66, 1, 10, 0, 20, 0, 30, 0, 70, 0);
  d.pairs(0, 'VERTEX', 8, '0', 10, 0, 20, 600, 30, 0, 42, -1);
  d.pairs(0, 'VERTEX', 8, '0', 10, 100, 20, 600, 30, 0);
  d.pairs(0, 'VERTEX', 8, '0', 10, 100, 20, 700, 30, 0);
  d.pairs(0, 'SEQEND', 8, '0');
  d.pairs(0, 'ELLIPSE', 8, '0', 10, 500, 20, 500, 30, 0, 11, 200, 21, 0, 31, 0, 40, 0.5, 41, 0, 42, Math.PI / 2);
  d.pairs(0, 'CIRCLE', 8, '0', 10, 700, 20, 0, 30, 0, 40, 50);
  d.pairs(0, 'ARC', 8, '0', 10, 900, 20, 0, 30, 0, 40, 100, 50, 0, 51, 90);
  d.pairs(0, 'TEXT', 8, '0', 10, 0, 20, -300, 30, 0, 40, 25, 1, '@@TEXT@@%%c50');
  d.pairs(0, 'SOLID', 8, '0', 10, 0, 20, -500, 30, 0, 11, 100, 21, -500, 31, 0, 12, 0, 22, -400, 32, 0, 13, 100, 23, -400, 33, 0);
  d.pairs(0, 'POINT', 8, '0', 10, 50, 20, 50, 30, 0);
  d.pairs(0, 'INSERT', 8, '壁', 62, 3, 2, 'B1', 10, 1000, 20, 1000, 30, 0, 41, 2, 42, 2, 43, 1, 50, 90);
  d.pairs(0, 'INSERT', 8, '0', 2, 'B1', 10, 2000, 20, 0, 30, 0, 41, -1, 42, 1, 43, 1);
  d.pairs(0, 'INSERT', 8, '0', 2, 'B2', 10, 3000, 20, 0, 30, 0);
  d.pairs(0, 'INSERT', 8, '0', 2, 'B3', 10, 4000, 20, 0, 30, 0);
  line(d, '0', 0, -100, 100, -100, [420, 0x123456]);
  line(d, 'HIDDEN', 0, -200, 100, -200);
  line(d, 'FROZEN', 0, -250, 100, -250);
  line(d, 'DASHLAYER', 0, -150, 300, -150);
  line(d, '0', 0, 0, 5, 5, [67, 1]);
  d.pairs(0, 'MTEXT', 8, '0', 10, 0, 20, 0, 30, 0, 40, 10, 1, 'skip');
  d.pairs(0, 'ENDSEC', 0, 'EOF');

  // 日本語の部分を Shift_JIS で埋め込む
  const parts = d.text().split(/(壁|@@TEXT@@)/);
  const bytes = [];
  for (const p of parts) {
    if (p === '壁') bytes.push(...SJIS['壁']);
    else if (p === '@@TEXT@@') bytes.push(...sjis('日本語'));
    else bytes.push(...Buffer.from(p, 'latin1'));
  }
  return new Uint8Array(bytes);
}

/** AC1021（UTF-8）・単位 m。線 (0,0)-(1.5,0) は 1500 mm、文字は「日本語UTF8」 */
export function utf8Dxf() {
  const d = new Dxf();
  header(d, 'AC1021', 'ANSI_1252', 6);
  tables(d, [{ name: '0' }, { name: '壁 UTF8', color: 5 }]);
  d.pairs(0, 'SECTION', 2, 'ENTITIES');
  line(d, '壁 UTF8', 0, 0, 1.5, 0);
  d.pairs(0, 'TEXT', 8, '0', 10, 0, 20, 1, 30, 0, 40, 0.2, 1, '日本語UTF8');
  d.pairs(0, 'ENDSEC', 0, 'EOF');
  return new TextEncoder().encode(d.text());
}

/** 単位の指定がない図面（mm とみなす）。名前の自然順を確かめるレイヤ L2・L10・L1 */
export function unitlessDxf() {
  const d = new Dxf();
  header(d, 'AC1015', 'ANSI_1252');
  tables(d, [{ name: '0' }, { name: 'L2' }, { name: 'L10' }, { name: 'L1' }]);
  d.pairs(0, 'SECTION', 2, 'ENTITIES');
  line(d, 'L2', 0, 0, 2000, 0);
  line(d, 'L10', 0, 100, 2000, 100);
  line(d, 'L1', 0, 200, 2000, 1700);
  d.pairs(0, 'ENDSEC', 0, 'EOF');
  return new TextEncoder().encode(d.text());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? '.';
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'basic.dxf'), basicDxf());
  fs.writeFileSync(path.join(out, 'utf8.dxf'), utf8Dxf());
  fs.writeFileSync(path.join(out, 'unitless.dxf'), unitlessDxf());
  console.log(`書き出しました: ${out}`);
}
