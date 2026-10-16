// 検証用の DXF を合成する（答えの分かっている図形だけを並べたもの）。
//   node tools/dxf-synth.mjs 出力フォルダ … basic.dxf・utf8.dxf・unitless.dxf・stage-b.dxf を書き出す
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
 *   ペーパー空間の線 1 本と IMAGE 1 個は読み飛ばす
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
  d.pairs(0, 'IMAGE', 8, '0', 10, 0, 20, 0, 30, 0);
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

/**
 * 段階 B の図形（R2000・mm）。答え（verify-dxf.ts で確かめる）:
 *   MTEXT (100,1000) 高さ 10、基点 5（中央）、「{\fArial|b0;AB}\PC\H2x;D\S1/2;%%d\U+00B1\M+193FA」
 *     → 行「AB」（高さ 10）と「CD1/2°±日」（高さ 20）。「AB」の左下は (95, 1000 + 21.667 − 10)
 *   TEXT「ABCD」高さ 10、中央・中（72=1, 73=2）、11/21 = (500,1000) → 左下 (490, 995)、長さ 20
 *   TEXT「AB」両端揃え（72=3）(0,1100)〜(100,1100) → 長さ 100、高さ 100
 *   DIMENSION *D1：寸法線 (0,1300)-(1000,1300)、補助線 2 本、矢印、寸法値 MTEXT「1000」、実測値 42 = 1000
 *   INSERT BA (2000,1000) に ATTRIB「A-12」、見えない ATTRIB「HIDE」。BA の中に定数の ATTDEF「CONST」と定数でない ATTDEF「DEF」
 *   MINSERT BM (3000,1000) 3 列 × 4 行、間隔 10・20 → 線 12 本（(3020,1060)-(3021,1060) を含む）
 *   MINSERT BM2 200 × 200 → 1 万個で打ち切り
 *   HATCH 塗り：外周 (0,2000)〜(100,2100) の正方形、穴は中心 (50,2050) 半径 20 の円 → 面積 10000 − 400π
 *   HATCH 模様：(200,2000)〜(300,2100) に 45° の線、間隔 5 → 線の長さの合計 2000
 *   SPLINE 3 次・制御点 (0,3000) (100,3100) (200,2900) (300,3000)・両端固定 → (150,3000) を通る
 *   CIRCLE 押し出し (0,0,-1)、中心 (100,4000) r=10 → WCS の中心 (-100,4000)
 *   ARC 押し出し (0,0,-1)、中心 (200,4000) r=10 0〜90° → 端 (-210,4000)・(-200,4010)
 *   CIRCLE 押し出し (0.6,0,0.8) r=10 → 楕円（長い半径 10、短い半径 8）
 *   LEADER (0,5000)-(100,5100)-(200,5100) 矢印あり
 *   XLINE (0,6000) 向き (1,0) → 図面の範囲で切った線
 */
export function stageBDxf() {
  const d = new Dxf();
  header(d, 'AC1015', 'ANSI_1252', 4);
  tables(d, [{ name: '0' }, { name: 'DIM' }]);

  d.pairs(0, 'SECTION', 2, 'BLOCKS');
  d.pairs(0, 'BLOCK', 8, '0', 2, '*D1', 70, 1, 10, 0, 20, 0, 30, 0, 3, '*D1');
  line(d, '0', 0, 1300, 1000, 1300);
  line(d, '0', 0, 1205, 0, 1310);
  line(d, '0', 1000, 1205, 1000, 1310);
  d.pairs(0, 'SOLID', 8, '0', 10, 0, 20, 1300, 30, 0, 11, 25, 21, 1304, 31, 0, 12, 25, 22, 1296, 32, 0, 13, 25, 23, 1296, 33, 0);
  d.pairs(0, 'MTEXT', 8, '0', 10, 500, 20, 1310, 30, 0, 40, 25, 71, 8, 1, '\\A1;1000');
  d.pairs(0, 'POINT', 8, 'DEFPOINTS', 10, 0, 20, 1200, 30, 0);
  d.pairs(0, 'ENDBLK', 8, '0');
  d.pairs(0, 'BLOCK', 8, '0', 2, 'BA', 70, 2, 10, 0, 20, 0, 30, 0, 3, 'BA');
  line(d, '0', 0, 0, 50, 0);
  d.pairs(0, 'ATTDEF', 8, '0', 10, 0, 20, 10, 30, 0, 40, 5, 1, 'CONST', 3, 'prompt', 2, 'C', 70, 2);
  d.pairs(0, 'ATTDEF', 8, '0', 10, 0, 20, 20, 30, 0, 40, 5, 1, 'DEF', 3, 'prompt', 2, 'NO', 70, 0);
  d.pairs(0, 'ENDBLK', 8, '0');
  d.pairs(0, 'BLOCK', 8, '0', 2, 'BM', 70, 0, 10, 0, 20, 0, 30, 0, 3, 'BM');
  line(d, '0', 0, 0, 1, 0);
  d.pairs(0, 'ENDBLK', 8, '0');
  d.pairs(0, 'BLOCK', 8, '0', 2, 'BM2', 70, 0, 10, 0, 20, 0, 30, 0, 3, 'BM2');
  d.pairs(0, 'POINT', 8, '0', 10, 0, 20, 0, 30, 0);
  d.pairs(0, 'ENDBLK', 8, '0');
  d.pairs(0, 'ENDSEC');

  d.pairs(0, 'SECTION', 2, 'ENTITIES');
  d.pairs(0, 'MTEXT', 8, '0', 10, 100, 20, 1000, 30, 0, 40, 10, 71, 5, 3, '{\\fArial|b0;AB}\\PC\\H2x;D', 1, '\\S1/2;%%d\\U+00B1\\M+193FA');
  d.pairs(0, 'TEXT', 8, '0', 10, 0, 20, 0, 30, 0, 40, 10, 1, 'ABCD', 72, 1, 11, 500, 21, 1000, 31, 0, 73, 2);
  d.pairs(0, 'TEXT', 8, '0', 10, 0, 20, 1100, 30, 0, 40, 10, 1, 'AB', 72, 3, 11, 100, 21, 1100, 31, 0);
  d.pairs(0, 'DIMENSION', 8, 'DIM', 2, '*D1', 10, 1000, 20, 1300, 30, 0, 11, 500, 21, 1310, 31, 0, 70, 32, 1, '',
    13, 0, 23, 1200, 33, 0, 14, 1000, 24, 1200, 34, 0, 42, 1000);
  d.pairs(0, 'INSERT', 8, '0', 66, 1, 2, 'BA', 10, 2000, 20, 1000, 30, 0);
  d.pairs(0, 'ATTRIB', 8, '0', 10, 2000, 20, 990, 30, 0, 40, 5, 1, 'A-12', 2, 'NO', 70, 0);
  d.pairs(0, 'ATTRIB', 8, '0', 10, 2000, 20, 980, 30, 0, 40, 5, 1, 'HIDE', 2, 'H', 70, 1);
  d.pairs(0, 'SEQEND', 8, '0');
  d.pairs(0, 'INSERT', 8, '0', 2, 'BM', 10, 3000, 20, 1000, 30, 0, 70, 3, 71, 4, 44, 10, 45, 20);
  d.pairs(0, 'INSERT', 8, '0', 2, 'BM2', 10, 3500, 20, 1000, 30, 0, 70, 200, 71, 200, 44, 1, 45, 1);
  // 塗りの HATCH：折れ線の外周と、円弧の辺の穴
  d.pairs(0, 'HATCH', 8, '0', 10, 0, 20, 0, 30, 0, 210, 0, 220, 0, 230, 1, 2, 'SOLID', 70, 1, 71, 0, 91, 2);
  d.pairs(92, 3, 72, 0, 73, 1, 93, 4, 10, 0, 20, 2000, 10, 100, 20, 2000, 10, 100, 20, 2100, 10, 0, 20, 2100, 97, 0);
  d.pairs(92, 16, 93, 1, 72, 2, 10, 50, 20, 2050, 40, 20, 50, 0, 51, 360, 73, 1, 97, 0);
  d.pairs(75, 0, 76, 1, 98, 1, 10, 50, 20, 2010);
  // 模様の HATCH：45° の線、間隔 5
  const s5 = 5 / Math.SQRT2;
  d.pairs(0, 'HATCH', 8, '0', 10, 0, 20, 0, 30, 0, 210, 0, 220, 0, 230, 1, 2, 'ANSI31', 70, 0, 71, 0, 91, 1);
  d.pairs(92, 1, 93, 4,
    72, 1, 10, 200, 20, 2000, 11, 300, 21, 2000,
    72, 1, 10, 300, 20, 2000, 11, 300, 21, 2100,
    72, 1, 10, 300, 20, 2100, 11, 200, 21, 2100,
    72, 1, 10, 200, 20, 2100, 11, 200, 21, 2000, 97, 0);
  d.pairs(75, 1, 76, 1, 52, 0, 41, 1, 77, 0, 78, 1, 53, 45, 43, 0, 44, 0, 45, -s5, 46, s5, 79, 0, 98, 0);
  d.pairs(0, 'SPLINE', 8, '0', 210, 0, 220, 0, 230, 1, 70, 8, 71, 3, 72, 8, 73, 4, 74, 0,
    40, 0, 40, 0, 40, 0, 40, 0, 40, 1, 40, 1, 40, 1, 40, 1,
    10, 0, 20, 3000, 30, 0, 10, 100, 20, 3100, 30, 0, 10, 200, 20, 2900, 30, 0, 10, 300, 20, 3000, 30, 0);
  d.pairs(0, 'CIRCLE', 8, '0', 10, 100, 20, 4000, 30, 0, 40, 10, 210, 0, 220, 0, 230, -1);
  d.pairs(0, 'ARC', 8, '0', 10, 200, 20, 4000, 30, 0, 40, 10, 210, 0, 220, 0, 230, -1, 50, 0, 51, 90);
  d.pairs(0, 'CIRCLE', 8, '0', 10, 0, 20, 0, 30, 0, 40, 10, 210, 0.6, 220, 0, 230, 0.8);
  d.pairs(0, 'LEADER', 8, '0', 3, 'Standard', 71, 1, 72, 0, 76, 3, 10, 0, 20, 5000, 30, 0, 10, 100, 20, 5100, 30, 0, 10, 200, 20, 5100, 30, 0);
  d.pairs(0, 'XLINE', 8, '0', 10, 0, 20, 6000, 30, 0, 11, 1, 21, 0, 31, 0);
  d.pairs(0, 'ENDSEC', 0, 'EOF');
  return new TextEncoder().encode(d.text());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? '.';
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'basic.dxf'), basicDxf());
  fs.writeFileSync(path.join(out, 'utf8.dxf'), utf8Dxf());
  fs.writeFileSync(path.join(out, 'unitless.dxf'), unitlessDxf());
  fs.writeFileSync(path.join(out, 'stage-b.dxf'), stageBDxf());
  console.log(`書き出しました: ${out}`);
}
