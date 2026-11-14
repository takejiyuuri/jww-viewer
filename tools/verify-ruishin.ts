// 累進寸法の計算を、答えの分かっている合成の図面で確かめる。
// 寸法図形の列・寸法図形でない寸法（線と数字）の列・起点の移動・m 単位・寸法値を書き換えた寸法・斜めの列を見る。
// 引数に図面を渡すと、その図面から拾った列の数と、寸法値と合わない寸法の数も出す。
import { readFileSync } from 'node:fs';
import { parseJww } from '../src/jww/parser.ts';
import { buildScene } from '../src/render/geometry.ts';
import { extractChains } from '../src/ruishin/extract.ts';
import {
  buildChains, defaultOrigin, formatValue, ordinates, parseDimValue, realAt, type Chain, type DimInput,
} from '../src/ruishin/ordinate.ts';
import {
  emptyEntities, type JwwCommon, type JwwDim, type JwwDocument, type JwwEntities, type JwwLine, type JwwText,
} from '../src/jww/types.ts';

let failures = 0;
const fail = (name: string, info?: unknown): void => {
  failures++;
  console.log(`NG: ${name}`, info ?? '');
};
const ok = (cond: boolean, name: string, info?: unknown): void => {
  if (!cond) fail(name, info);
};
const near = (a: number, b: number, tol = 1e-6): boolean => Math.abs(a - b) <= tol;

const common = (glayer = 0): JwwCommon => ({ group: 0, penStyle: 1, penColor: 1, penWidth: 1, layer: 0, glayer, flag: 0 });
const line = (x1: number, y1: number, x2: number, y2: number): JwwLine => ({ ...common(), x1, y1, x2, y2 });
const text = (s: string, x: number, y: number, angle = 0, h = 2.5): JwwText => {
  const w = s.length * h * 0.8;
  const a = (angle * Math.PI) / 180;
  return {
    ...common(), x1: x, y1: y, x2: x + Math.cos(a) * w, y2: y + Math.sin(a) * w,
    fontType: 0, sizeX: h * 0.8, sizeY: h, spacing: 0, angle, fontName: 'MS ゴシック', text: s,
  };
};
/** 寸法図形。(x1,y1)-(x2,y2) が寸法線、値は寸法線の上に書く */
const dim = (x1: number, y1: number, x2: number, y2: number, value: string): JwwDim => {
  const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  const a = (ang * Math.PI) / 180;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  return {
    ...common(), line: line(x1, y1, x2, y2),
    text: text(value, mx - Math.sin(a) * 0.5, my + Math.cos(a) * 0.5, ang), sxfMode: 0,
  };
};

function makeDoc(parts: Partial<JwwEntities>, scale = 100): JwwDocument {
  const layers = Array.from({ length: 16 }, () => ({ state: 2, protect: 0, name: '' }));
  return {
    header: {
      version: 600, memo: '', paperSize: 3, writeGroup: 0,
      groups: Array.from({ length: 16 }, () => ({ state: 2, writeLayer: 0, scale, protect: 0, name: '', layers })),
      penColors: Array.from({ length: 10 }, () => ({ rgb: 0xffffff, width: 1 })),
      sxfColors: [], sxfColorNames: [], sxfLineTypeNames: [], lineTypes: [], pointRadius: [], drawPointRadius: false,
      zoom: 1, originX: 0, originY: 0,
    },
    entities: { ...emptyEntities(), ...parts },
    blockDefs: new Map(),
    warnings: [],
  };
}

const values = (c: Chain, ox: number, oy: number): number[] => ordinates(c, { x: ox, y: oy }).map((s) => Math.round(s.value * 1000) / 1000);

// ---- 1. 数字の読み取り ----
{
  ok(parseDimValue('1820')?.value === 1820, '1820 を読む');
  ok(parseDimValue('１，８２０')?.value === 1820 && parseDimValue('１，８２０')?.comma === true, '全角とカンマ');
  ok(parseDimValue('1.82')?.decimals === 2, '小数の桁');
  ok(parseDimValue('R300') === null && parseDimValue('φ50') === null && parseDimValue('45°') === null, '長さ以外は読まない');
  ok(formatValue(1820, { unit: 'mm', decimals: 0, comma: false }) === '1820', '1820 と書く');
  ok(formatValue(12345, { unit: 'mm', decimals: 0, comma: true }) === '12,345', 'カンマを付ける');
  ok(formatValue(1820, { unit: 'm', decimals: 2, comma: false }) === '1.82', 'm で書く');
  ok(formatValue(-910, { unit: 'mm', decimals: 0, comma: false }) === '910', '負は符号を付けない');
  ok(formatValue(-910, { unit: 'mm', decimals: 0, comma: false }, true) === '-910', '符号付き');
}

// ---- 2. 寸法図形の水平の列（縮尺 1/100、図面の 18.2mm = 実寸 1820mm） ----
{
  const doc = makeDoc({
    dims: [
      dim(0, 0, 18.2, 0, '1820'),
      dim(18.2, 0, 27.3, 0, '910'),
      dim(27.3, 0, 45.5, 0, '1820'),
      // 別の高さの全体寸法（単独なので列にしない）
      dim(0, 10, 45.5, 10, '4550'),
      // 縦の列
      dim(-10, 0, -10, 9.1, '910'),
      dim(-10, 9.1, -10, 27.3, '1820'),
    ],
  });
  const chains = extractChains(buildScene(doc));
  ok(chains.length === 2, '列は横 1・縦 1', chains.map((c) => c.spans.length));
  const h = chains.find((c) => c.uy === 0)!;
  const v = chains.find((c) => c.ux === 0)!;
  ok(!!h && h.stops.length === 4, '横の列の端は 4 つ', h?.stops);
  ok(!!h && values(h, ...xy(defaultOrigin(h))).join() === '0,1820,2730,4550', '左端からの累進', h && values(h, 0, 0));
  ok(!!v && values(v, ...xy(defaultOrigin(v))).join() === '0,910,2730', '縦の列の累進', v && values(v, -10, 0));
  // 起点を真ん中の端（27.3）へ。図面のどこの点でも、列の向きに投影して使う（上のほうの交点など）
  ok(!!h && values(h, 27.3, 55).join() === '-2730,-910,0,1820', '起点を動かすと更新される', h && values(h, 27.3, 55));
  // 端に乗らない起点（10 → 実寸 1000）は、その位置にも 0 を足す
  const o = h ? ordinates(h, { x: 10, y: 3 }) : [];
  ok(o.length === 5 && o.filter((s) => s.isOrigin).length === 1 && near(o[1].value, 0) && near(o[1].x, 10) && near(o[1].y, 0),
    '端でない起点に 0 の印', o);
  ok(near(o[2].value, 820, 1e-3) && near(o[0].value, -1000, 1e-3), '端でない起点からの値', o.map((s) => s.value));
  // 列の外の起点は縮尺で伸ばす
  ok(!!h && near(realAt(h, -5), -500), '列の外は縮尺で伸ばす');
}

// ---- 3. 寸法図形にしていない寸法（線と、線の上の数字）。縦の列は数字を 90° 回して書く ----
{
  const doc = makeDoc({
    lines: [
      line(0, 0, 18.2, 0), line(18.2, 0, 36.4, 0),
      // 寸法線と関係のない線（数字の近くにあるが長さが合わない）
      line(0, 1, 50, 1),
      line(60, 0, 60, 9.1), line(60, 9.1, 60, 18.2),
    ],
    texts: [
      text('1820', 6, 0.6), text('1,820', 24, 0.6),
      text('910', 59.4, 2, 90), text('910', 59.4, 11, 90),
      // 長さと合わない数字は寸法にしない
      text('123', 40, 1.6),
    ],
  });
  const chains = extractChains(buildScene(doc));
  ok(chains.length === 2, '線と数字の寸法から列を作る', chains.map((c) => [c.ux, c.uy, c.spans.length]));
  const h = chains.find((c) => c.uy === 0);
  ok(!!h && values(h, 0, 0).join() === '0,1820,3640' && h.format.comma, '線と数字の累進とカンマ', h && values(h, 0, 0));
  const v = chains.find((c) => c.ux === 0);
  ok(!!v && values(v, 60, 0).join() === '0,910,1820', '縦の線と数字', v && values(v, 60, 0));
}

// ---- 4. 寸法値を書き換えた寸法（図形の長さと合わない）は、書いてある数字で累計する ----
{
  const dims: DimInput[] = [
    { x1: 0, y1: 0, x2: 10, y2: 0, text: '1000', textHeight: 2.5, scale: 100, group: 0, entity: 0, textIndex: 0 },
    { x1: 10, y1: 0, x2: 20, y2: 0, text: '1500', textHeight: 2.5, scale: 100, group: 0, entity: 1, textIndex: 1 },
    { x1: 20, y1: 0, x2: 30, y2: 0, text: '', textHeight: 2.5, scale: 100, group: 0, entity: 2, textIndex: -1 },
  ];
  const [c] = buildChains(dims);
  ok(!!c && c.mismatch && c.spans[1].mismatch && !c.spans[0].mismatch, '合わない寸法を見つける', c?.spans);
  ok(!!c && values(c, 0, 0).join() === '0,1000,2500,3500', '書いてある数字で累計する（読めない区間は図形の長さ）', c && values(c, 0, 0));
  // 書き換えた区間の中の起点は、その区間の数字で比例配分する（15 は 1000 + 750）
  ok(!!c && near(realAt(c, 15), 1750), '区間の中は比例で割り振る');
}

// ---- 5. m で書いた寸法値 ----
{
  const dims: DimInput[] = [
    { x1: 0, y1: 0, x2: 18.2, y2: 0, text: '1.82', textHeight: 2.5, scale: 100, group: 0, entity: 0, textIndex: 0 },
    { x1: 18.2, y1: 0, x2: 27.3, y2: 0, text: '0.91', textHeight: 2.5, scale: 100, group: 0, entity: 1, textIndex: 1 },
  ];
  const [c] = buildChains(dims);
  ok(!!c && c.format.unit === 'm' && !c.mismatch, 'm の寸法値と分かる', c?.format);
  const o = c ? ordinates(c, { x: 0, y: 0 }).map((s) => formatValue(s.value, c.format)) : [];
  ok(o.join() === '0,1.82,2.73', 'm で累進を書く', o);
}

// ---- 6. 列の切り分け：同じ高さでも離れた寸法は別の列、縮尺の違うグループは別の列、斜めの列 ----
{
  const mk = (x1: number, y1: number, x2: number, y2: number, group = 0, scale = 100): DimInput =>
    ({ x1, y1, x2, y2, text: '', textHeight: 2.5, scale, group, entity: 0, textIndex: -1 });
  const chains = buildChains([
    mk(0, 0, 10, 0), mk(10, 0, 20, 0),
    mk(40, 0, 50, 0), mk(50, 0, 60, 0),
    mk(0, 0, 10, 0, 1, 50), mk(10, 0, 20, 0, 1, 50),
    // 30° の列（逆向きに描いた寸法も混ぜる）
    mk(0, 0, Math.cos(Math.PI / 6) * 10, Math.sin(Math.PI / 6) * 10),
    mk(Math.cos(Math.PI / 6) * 20, Math.sin(Math.PI / 6) * 20, Math.cos(Math.PI / 6) * 10, Math.sin(Math.PI / 6) * 10),
  ]);
  ok(chains.length === 4, '離れた列・縮尺違い・斜めの列を分ける', chains.map((c) => [c.ux.toFixed(3), c.group, c.stops]));
  const slant = chains.find((c) => c.ux !== 0 && c.uy !== 0);
  ok(!!slant && values(slant, 0, 0).join() === '0,1000,2000', '斜めの列の累進', slant && values(slant, 0, 0));
  const g1 = chains.find((c) => c.group === 1);
  ok(!!g1 && values(g1, 0, 0).join() === '0,500,1000', 'グループの縮尺で実寸にする', g1 && values(g1, 0, 0));
}

function xy(p: { x: number; y: number }): [number, number] {
  return [p.x, p.y];
}

// ---- 実際の図面 ----
for (const file of process.argv.slice(2)) {
  const buf = readFileSync(file);
  const doc = parseJww(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const scene = buildScene(doc);
  const t0 = performance.now();
  const chains = extractChains(scene);
  const ms = performance.now() - t0;
  const spans = chains.reduce((s, c) => s + c.spans.length, 0);
  const bad = chains.reduce((s, c) => s + c.spans.filter((p) => p.mismatch).length, 0);
  console.log(`${file}: 寸法図形 ${doc.entities.dims.length} / 列 ${chains.length}（寸法 ${spans}、合わない ${bad}）${ms.toFixed(1)}ms`);
}

if (failures) {
  console.log(`${failures} 件 NG`);
  process.exit(1);
}
console.log('累進寸法の検査はすべて OK');
