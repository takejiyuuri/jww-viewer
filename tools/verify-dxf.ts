// DXF の読み取りの検査（ブラウザ不要）。答えの分かっている合成の DXF（dxf-synth.mjs）を loadDrawing で読み、
// ふくらみの半円・楕円の 1/4・入れ子・回転・反転した部品の位置・文字コード・真の色・レイヤの状態・単位を確かめる
import { loadDrawing } from '../src/formats/load.ts';
import { detectFormat, unsupportedReason } from '../src/formats/detect.ts';
import { KIND, type Scene } from '../src/render/builder.ts';
import { TRUE_COLOR_PEN } from '../src/dxf/aci.ts';
import type { LoadedInfo } from '../src/formats/info.ts';
import { arcMidpoint, curveIndex, onlinePoint } from '../src/measure/snap.ts';
import { basicDxf, unitlessDxf, utf8Dxf } from './dxf-synth.mjs';

let failures = 0;
const check = (msg: string, ok: boolean, info?: unknown): void => {
  if (ok) return;
  failures++;
  console.log(`NG: ${msg}${info === undefined ? '' : ` ${JSON.stringify(info)}`}`);
};
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

const buf = (u: Uint8Array): ArrayBuffer => u.slice().buffer;

/** レイヤ名から番号 */
function layerNo(info: LoadedInfo, name: string): number {
  for (let k = 0; k < 256; k++) if (info.groups[k >> 4].layers[k & 15].name === name) return k;
  return -1;
}

/** 種類が kind の図形の番号 */
function ofKind(scene: Scene, kind: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < scene.entities.count; i++) if (scene.entities.kind[i] === kind) out.push(i);
  return out;
}

/** 端点が (x1,y1)-(x2,y2) の線分を持つ図形 */
function segmentAt(scene: Scene, x1: number, y1: number, x2: number, y2: number): number[] {
  const p = scene.linePos;
  const out: number[] = [];
  for (let i = 0; i < p.length / 4; i++) {
    const a = near(p[i * 4], x1, 1e-3) && near(p[i * 4 + 1], y1, 1e-3) && near(p[i * 4 + 2], x2, 1e-3) && near(p[i * 4 + 3], y2, 1e-3);
    const b = near(p[i * 4], x2, 1e-3) && near(p[i * 4 + 1], y2, 1e-3) && near(p[i * 4 + 2], x1, 1e-3) && near(p[i * 4 + 3], y1, 1e-3);
    if (a || b) out.push(scene.lineEntity[i]);
  }
  return out;
}

/** 楕円弧の長さを細かく分けて求める */
function ellipseLength(a: number, b: number, t0: number, t1: number): number {
  const n = 200000;
  let len = 0;
  let px = a * Math.cos(t0), py = b * Math.sin(t0);
  for (let i = 1; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    const x = a * Math.cos(t), y = b * Math.sin(t);
    len += Math.hypot(x - px, y - py);
    px = x; py = y;
  }
  return len;
}

// ---------- 見分け ----------
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
check('DXF を見分ける', detectFormat(enc('  0\r\nSECTION\r\n  2\r\nHEADER\r\n')) === 'dxf');
check('注釈付きの DXF を見分ける', detectFormat(enc('999\nmade by\n0\nSECTION\n')) === 'dxf');
check('DWG を見分ける', detectFormat(enc('AC1027\0\0\0')) === 'dwg');
check('DWG の理由', (unsupportedReason('dwg') ?? '').includes('DXF'));
check('バイナリ DXF を見分ける', detectFormat(enc('AutoCAD Binary DXF\r\n\x1a\0')) === 'dxfb');
check('JWW を見分ける', detectFormat(enc('JwwData.\0\0\0\0')) === 'jww');
check('ZIP を見分ける', detectFormat(new Uint8Array([0x50, 0x4b, 3, 4, 0])) === 'zip');
check('ほかの形式は null', detectFormat(enc('hello world'), 'a.txt') === null);

// ---------- R2000・Shift_JIS・mm ----------
{
  const { scene, info } = await loadDrawing(buf(basicDxf()), 'basic.dxf');
  const e = scene.entities;
  check('形式', info.format === 'dxf' && info.layerMode === 'flat', [info.format, info.layerMode]);
  check('単位 mm（図面の指定）', info.units?.name === 'mm' && info.units.guessed === false && scene.scales[0] === 1, info.units);
  const wall = layerNo(info, '壁');
  check('Shift_JIS のレイヤ名', wall > 0, wall);

  // 線
  const lines = ofKind(scene, KIND.line).filter((i) => near(e.size[i], 1000, 1e-6));
  check('線の長さ 1000', lines.length === 1);
  if (lines[0] !== undefined) {
    check('線のレイヤと色', e.layer[lines[0]] === wall && e.pen[lines[0]] === 1, [e.layer[lines[0]], e.pen[lines[0]]]);
  }

  // ふくらみ
  const polys = ofKind(scene, KIND.polyline).map((i) => e.length[i]).sort((a, b) => a - b);
  check('LWPOLYLINE のふくらみの半円 = 100π', polys.some((v) => near(v, 100 * Math.PI, 1e-3)), polys);
  check('POLYLINE（VERTEX）= 50π + 100', polys.some((v) => near(v, 50 * Math.PI + 100, 1e-3)), polys);
  {
    // 半円の頂点 (100, 300 − 100)：ふくらみ 1 は左回りなので、(0,300)→(200,300) は下へふくらむ
    const p = scene.linePos;
    let low = Infinity;
    for (let i = 0; i < p.length / 4; i++) {
      if (e.kind[scene.lineEntity[i]] !== KIND.polyline) continue;
      if (p[i * 4] >= 0 && p[i * 4] <= 200 && p[i * 4 + 1] > 150 && p[i * 4 + 1] <= 300) low = Math.min(low, p[i * 4 + 1]);
    }
    check('半円は下へふくらむ', near(low, 200, 0.05), low);
    // 吸着は弦ではなく弧の上（中心 (100,300)、半径 100）。中点は (100,200)
    const curveOf = curveIndex(scene);
    let worst = 0, arcLines = 0, mid: [number, number] | null = null;
    for (let i = 0; i < p.length / 4; i++) {
      if (e.kind[scene.lineEntity[i]] !== KIND.polyline || curveOf[i] < 0) continue;
      if (!(p[i * 4] >= 0 && p[i * 4] <= 200 && p[i * 4 + 1] <= 300 && p[i * 4 + 1] > 150)) continue;
      arcLines++;
      const q = onlinePoint(scene, curveOf, i, (p[i * 4] + p[i * 4 + 2]) / 2, (p[i * 4 + 1] + p[i * 4 + 3]) / 2);
      if (q) worst = Math.max(worst, Math.abs(Math.hypot(q[0] - 100, q[1] - 300) - 100));
      mid ??= arcMidpoint(scene, curveOf, i);
    }
    check('ふくらみの弧の線上は弧の上', arcLines > 4 && worst < 1e-6, [arcLines, worst]);
    check('ふくらみの弧の中点', mid !== null && near(mid[0], 100, 1e-6) && near(mid[1], 200, 1e-6), mid);
    // POLYLINE の直線の辺は式を持たない
    let straight = 0;
    for (let i = 0; i < p.length / 4; i++) {
      if (e.kind[scene.lineEntity[i]] === KIND.polyline && near(p[i * 4], 100, 1e-6) && near(p[i * 4 + 2], 100, 1e-6) && curveOf[i] < 0) straight++;
    }
    check('折れ線の直線の辺は直線のまま', straight === 1, straight);
  }

  // 楕円の 1/4
  const ell = ofKind(scene, KIND.arc).filter((i) => near(e.size[i], 200, 1e-3));
  check('楕円弧が 1 つ', ell.length === 1, ell.length);
  if (ell[0] !== undefined) {
    const i = ell[0];
    check('楕円の半径', near(e.size2[i], 100, 1e-3), [e.size[i], e.size2[i]]);
    const want = ellipseLength(200, 100, 0, Math.PI / 2);
    check('楕円の 1/4 の長さ', near(e.length[i], want, want * 1e-5), [e.length[i], want]);
    const s = e.lineStart[i], n = e.lineCount[i];
    const p = scene.linePos;
    check('楕円弧の始点 (700,500)', near(p[s * 4], 700, 1e-3) && near(p[s * 4 + 1], 500, 1e-3));
    check('楕円弧の終点 (500,600)', near(p[(s + n - 1) * 4 + 2], 500, 1e-3) && near(p[(s + n - 1) * 4 + 3], 600, 1e-3));
  }
  // 円と円弧
  const circles = ofKind(scene, KIND.circle);
  check('円 r=50', circles.length === 1 && near(e.size[circles[0]], 50, 1e-6) && near(e.length[circles[0]], 100 * Math.PI, 1e-4));
  const arcs = ofKind(scene, KIND.arc).filter((i) => near(e.size[i], 100, 1e-6));
  check('円弧 90°', arcs.length === 1 && near(e.length[arcs[0]], 50 * Math.PI, 1e-4));

  // 文字
  check('Shift_JIS の文字と %%c', scene.texts.some((t) => t.text === '日本語Ø50'), scene.texts.map((t) => t.text));

  // 部品
  const r1 = segmentAt(scene, 1000, 1000, 1000, 1020);
  check('回転・倍率の部品の位置', r1.length === 1, r1);
  if (r1[0] !== undefined) {
    check('レイヤ 0 は配置側のレイヤ、BYBLOCK は配置側の色', e.layer[r1[0]] === wall && e.pen[r1[0]] === 3, [e.layer[r1[0]], e.pen[r1[0]]]);
    check('部品の名前', scene.blockNames[e.block[r1[0]]] === 'B1', scene.blockNames);
  }
  check('反転した部品の位置', segmentAt(scene, 2000, 0, 1990, 0).length === 1);
  check('入れ子の部品の位置', segmentAt(scene, 3100, 0, 3100, 10).length === 1);
  check('自分を配置する部品は 1 回だけ', segmentAt(scene, 4000, 0, 4001, 1).length === 1);

  // 真の色
  const tc = [];
  for (let i = 0; i < e.count; i++) if (e.pen[i] === TRUE_COLOR_PEN) tc.push(i);
  check('真の色の図形', tc.length === 1, tc.length);
  if (tc[0] !== undefined) {
    const i = tc[0];
    check('真の色の COLORREF', e.rgb[i] === 0x563412, e.rgb[i].toString(16));
    const c = e.color[i];
    check('真の色の画面色', scene.colors[c * 3] === 0x12 && scene.colors[c * 3 + 1] === 0x34 && scene.colors[c * 3 + 2] === 0x56);
    check('真の色のグループ', scene.groups[scene.colorGroup[c]].label === '真の色');
  }

  // レイヤの状態
  const st = (name: string): number => {
    const k = layerNo(info, name);
    return k < 0 ? -1 : info.groups[k >> 4].layers[k & 15].state;
  };
  check('表示オフのレイヤ', st('HIDDEN') === 0, st('HIDDEN'));
  check('凍結のレイヤ', st('FROZEN') === 0, st('FROZEN'));
  check('ふつうのレイヤ', st('壁') === 2);

  // 線種
  const dash = ofKind(scene, KIND.line).find((i) => e.layer[i] === layerNo(info, 'DASHLAYER'));
  check('線種のある線', dash !== undefined && e.style[dash] > 0);
  if (dash !== undefined) {
    const s = e.style[dash];
    check('線種の模様', scene.dashes[s * 2] !== 0 && (scene.dashes[s * 2 + 1] & 255) > 0);
    check('線種の名前', info.lineTypeNames?.[s] === 'DASHED', info.lineTypeNames);
  }

  // 塗り・点
  const solids = ofKind(scene, KIND.solid);
  check('ソリッドは三角形 2 枚', solids.length === 1 && e.triCount[solids[0]] === 2);
  const sp = scene.snapPoint;
  let point = false;
  for (let i = 0; i < sp.length / 2; i++) if (near(sp[i * 2], 50, 1e-6) && near(sp[i * 2 + 1], 50, 1e-6)) point = true;
  check('点', point);

  check('ペーパー空間の警告', info.warnings.some((w) => w.includes('ペーパー空間')), info.warnings);
  check('読み飛ばしの警告', info.warnings.some((w) => w.includes('MTEXT')), info.warnings);
}

// ---------- AC1021・UTF-8・m ----------
{
  const { scene, info } = await loadDrawing(buf(utf8Dxf()), 'utf8.dxf');
  check('単位 m', info.units?.name === 'm' && scene.scales[0] === 1000, info.units);
  const lines = ofKind(scene, KIND.line);
  check('1.5 m の線は 1500 mm', lines.length === 1 && near(scene.entities.size[lines[0]] * scene.scales[0], 1500, 1e-3));
  check('UTF-8 の文字', scene.texts.some((t) => t.text === '日本語UTF8'), scene.texts.map((t) => t.text));
  check('UTF-8 のレイヤ名', layerNo(info, '壁 UTF8') >= 0);
}

// ---------- 単位なし ----------
{
  const { scene, info } = await loadDrawing(buf(unitlessDxf()), 'unitless.dxf');
  check('単位の指定なしは mm とみなす', info.units?.name === 'mm' && info.units.guessed && scene.scales[0] === 1, info.units);
}

// ---------- 壊れた DXF で止まらないこと ----------
{
  const full = basicDxf();
  let thrown = 0;
  for (let n = 0; n < full.length; n += Math.max(1, Math.floor(full.length / 97))) {
    try {
      await loadDrawing(buf(full.subarray(0, n)), 'cut.dxf', 'dxf');
    } catch (err) {
      if (!(err instanceof Error)) check('途中で切れた DXF は Error で知らせる', false);
      thrown++;
    }
  }
  check('途中で切れた DXF を読めた（または知らせた）', true, thrown);
}

console.log(failures ? `${failures} 件の不合格` : 'すべて合格');
if (failures) process.exit(1);
