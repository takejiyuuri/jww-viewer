// DXF の読み取りの検査（ブラウザ不要）。答えの分かっている合成の DXF（dxf-synth.mjs）を loadDrawing で読み、
// ふくらみの半円・楕円の 1/4・入れ子・回転・反転した部品の位置・文字コード・真の色・レイヤの状態・単位を確かめる
import { loadDrawing } from '../src/formats/load.ts';
import { detectFormat, unsupportedReason } from '../src/formats/detect.ts';
import { KIND, type Scene } from '../src/render/builder.ts';
import { TRUE_COLOR_PEN } from '../src/dxf/aci.ts';
import type { LoadedInfo } from '../src/formats/info.ts';
import { arcMidpoint, curveIndex, onlinePoint } from '../src/measure/snap.ts';
import { basicDxf, stageBDxf, unitlessDxf, utf8Dxf } from './dxf-synth.mjs';
import { parseDxf } from '../src/dxf/parse.ts';
import { buildDxfScene } from '../src/dxf/scene.ts';
import { parseMtext } from '../src/dxf/mtext.ts';

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
  check('読み飛ばしの警告', info.warnings.some((w) => w.includes('IMAGE')), info.warnings);
}

// ---------- 段階 B：MTEXT・寄せ・寸法・属性・MINSERT・HATCH・SPLINE・OCS・LEADER・XLINE ----------
{
  // 書式記号
  const lines = parseMtext('{\\fArial|b0;AB}\\PC\\H2x;D\\S1/2;%%d\\U+00B1\\M+193FA', 10);
  check('MTEXT の行', lines.length === 2 && lines[0].text === 'AB' && lines[1].text === 'CD1/2°±日', lines);
  check('MTEXT の高さ（\\H2x）', lines[0].height === 10 && lines[1].height === 20, lines);
  const odd = parseMtext('a\\Lb\\l\\Oc\\o{\\C1;d}\\Q15;e\\~f\\\\g\\{h\\}\\Zi^Jj', 1);
  check('MTEXT の知らない記号を外す', odd.map((l) => l.text).join('|') === 'abcde f\\g{h}i|j', odd);

  const bytes = stageBDxf();
  const doc = parseDxf(buf(bytes));
  const r = buildDxfScene(doc);
  const scene = r.scene;
  const e = scene.entities;
  const textAt = (s: string) => scene.texts.find((t) => t.text === s);

  check('MTEXT の 2 行目', !!textAt('CD1/2°±日'), scene.texts.map((t) => t.text));
  {
    const m = scene.texts.find((t) => t.text === 'AB' && near(t.x, 95, 1e-6));
    check('MTEXT の基点 5（中央）の位置', !!m && near(m.y, 1000 + 21.6667 - 10, 1e-3) && near(m.width, 10, 1e-9), m);
  }
  const abcd = textAt('ABCD');
  check('TEXT の中央・中の寄せ', !!abcd && near(abcd.x, 490, 1e-9) && near(abcd.y, 995, 1e-9) && near(abcd.width, 20, 1e-9), abcd);
  const fit = scene.texts.find((t) => t.text === 'AB' && near(t.y, 1100, 1e-9));
  check('TEXT の両端揃え', !!fit && near(fit.x, 0, 1e-9) && near(fit.width, 100, 1e-9) && near(fit.height, 100, 1e-9), fit);

  // 寸法
  check('寸法が 1 つ', r.dimensions.length === 1 && r.counts.DIMENSION === 1, r.dimensions);
  const dm = r.dimensions[0];
  if (dm) {
    check('寸法の実測値（42）と寸法値・寸法線の長さが合う',
      dm.measurement === 1000 && Number.parseFloat(dm.text) === dm.measurement && near(dm.length, dm.measurement, 1e-9), dm);
  }
  const dims = ofKind(scene, KIND.dim), aux = ofKind(scene, KIND.dimAux), dimTexts = ofKind(scene, KIND.dimText);
  const dimLine = dims.find((i) => near(e.size[i], 1000, 1e-6));
  check('寸法線（長さ 1000）', dimLine !== undefined, dims.map((i) => e.size[i]));
  check('寸法の補助線 2 本（吸着しない）', aux.length === 2 && aux.every((i) => scene.lineSnap[e.lineStart[i]] === 0), aux.length);
  check('寸法値の文字', dimTexts.length === 1 && scene.texts[e.text[dimTexts[0]]]?.text === '1000');
  if (dimLine !== undefined) check('寸法線から寸法値をたどれる', scene.texts[e.text[dimLine]]?.text === '1000');
  check('寸法の中身は線の数に入れない（部品の線 13 本だけ）', r.counts.LINE === 13, r.counts);

  // 属性
  check('ATTRIB を描く', !!textAt('A-12'));
  check('見えない ATTRIB は描かない', !textAt('HIDE'));
  check('定数の ATTDEF を描く', !!textAt('CONST'));
  check('定数でない ATTDEF は描かない', !textAt('DEF'));

  // MINSERT
  const bm = scene.blockNames.indexOf('BM');
  const bmLines = ofKind(scene, KIND.line).filter((i) => e.block[i] === bm);
  check('MINSERT の 3 × 4', bmLines.length === 12, bmLines.length);
  check('MINSERT の位置', segmentAt(scene, 3020, 1060, 3021, 1060).length === 1);
  const bm2 = scene.blockNames.indexOf('BM2');
  const bm2n = ofKind(scene, KIND.point).filter((i) => e.block[i] === bm2).length;
  check('MINSERT の上限 1 万', bm2n === 10000, bm2n);
  check('MINSERT の上限の警告', r.warnings.some((w) => w.includes('MINSERT')), r.warnings);

  // HATCH
  const hatches = ofKind(scene, KIND.hatch);
  const filled = hatches.filter((i) => e.triCount[i] > 0);
  const want = 10000 - 400 * Math.PI;
  check('塗りの HATCH の面積（穴あり）', filled.length === 1 && near(e.size[filled[0]], want, want * 1e-3), filled.map((i) => e.size[i]));
  if (filled[0] !== undefined) {
    // 三角形の面積の合計も同じで、穴の中心を含む三角形はない
    const tp = scene.triPos;
    let sum = 0, center = false;
    for (let k = e.triStart[filled[0]]; k < e.triStart[filled[0]] + e.triCount[filled[0]]; k++) {
      const [x1, y1, x2, y2, x3, y3] = tp.subarray(k * 6, k * 6 + 6);
      sum += Math.abs((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1)) / 2;
      const d1 = (x2 - x1) * (2050 - y1) - (y2 - y1) * (50 - x1);
      const d2 = (x3 - x2) * (2050 - y2) - (y3 - y2) * (50 - x2);
      const d3 = (x1 - x3) * (2050 - y3) - (y1 - y3) * (50 - x3);
      if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) center = true;
    }
    check('塗りの三角形の面積', near(sum, want, want * 1e-3), sum);
    check('穴の中は塗らない', !center);
  }
  const patterned = hatches.filter((i) => e.lineCount[i] > 0);
  if (patterned[0] !== undefined) {
    const i = patterned[0];
    const p = scene.linePos;
    let len = 0, snap = 0;
    for (let k = e.lineStart[i]; k < e.lineStart[i] + e.lineCount[i]; k++) {
      len += Math.hypot(p[k * 4 + 2] - p[k * 4], p[k * 4 + 3] - p[k * 4 + 1]);
      snap |= scene.lineSnap[k];
    }
    check('模様の線の長さの合計 = 面積 / 間隔', near(len, 2000, 2000 * 0.01), len);
    check('模様の線は吸着しない', snap === 0);
  } else {
    check('模様の HATCH', false);
  }

  // SPLINE
  const splines = ofKind(scene, KIND.spline);
  check('SPLINE が 1 つ', splines.length === 1, splines.length);
  if (splines[0] !== undefined) {
    const i = splines[0];
    const p = scene.linePos;
    const s = e.lineStart[i], n = e.lineCount[i];
    let inHull = true, best = Infinity;
    for (let k = s; k < s + n; k++) {
      for (const [x, y] of [[p[k * 4], p[k * 4 + 1]], [p[k * 4 + 2], p[k * 4 + 3]]]) {
        if (x < -1e-6 || x > 300 + 1e-6 || y < 2900 - 1e-6 || y > 3100 + 1e-6) inHull = false;
        best = Math.min(best, Math.hypot(x - 150, y - 3000));
      }
    }
    check('SPLINE の両端は制御点の両端', near(p[s * 4], 0, 1e-6) && near(p[s * 4 + 1], 3000, 1e-6)
      && near(p[(s + n - 1) * 4 + 2], 300, 1e-3) && near(p[(s + n - 1) * 4 + 3], 3000, 1e-3));
    check('SPLINE は制御点の囲みの中', inHull);
    check('SPLINE は (150,3000) を通る', best < 0.5, best);
    check('SPLINE の両端は端点', (scene.lineSnap[s] & 2) !== 0 && (scene.lineSnap[s + n - 1] & 4) !== 0);
  }

  // OCS
  const sp = scene.snapPoint;
  const hasPoint = (x: number, y: number): boolean => {
    for (let k = 0; k < sp.length / 2; k++) if (near(sp[k * 2], x, 1e-6) && near(sp[k * 2 + 1], y, 1e-6)) return true;
    return false;
  };
  check('押し出し -Z の円の中心', hasPoint(-100, 4000));
  {
    const arcs = ofKind(scene, KIND.arc).filter((i) => near(e.size[i], 10, 1e-9));
    const p = scene.linePos;
    const ends = arcs.map((i) => {
      const s = e.lineStart[i], n = e.lineCount[i];
      return [p[s * 4], p[s * 4 + 1], p[(s + n - 1) * 4 + 2], p[(s + n - 1) * 4 + 3]].map((v) => Math.round(v * 1000) / 1000);
    });
    check('押し出し -Z の円弧の端', ends.some((v) => v[0] === -210 && v[1] === 4000 && v[2] === -200 && v[3] === 4010), ends);
  }
  {
    const circles = ofKind(scene, KIND.circle);
    const tilted = circles.filter((i) => near(e.size[i], 10, 1e-6) && near(e.size2[i], 8, 1e-6));
    check('傾いた押し出しの円は楕円に写る', tilted.length === 1, circles.map((i) => [e.size[i], e.size2[i]]));
  }

  // LEADER・XLINE
  const leaders = ofKind(scene, KIND.polyline).filter((i) => near(e.size[i], Math.SQRT2 * 100 + 100, 1e-3));
  check('LEADER と矢印', leaders.length === 1 && e.triCount[leaders[0]] === 1, leaders.map((i) => e.triCount[i]));
  {
    const xl = ofKind(scene, KIND.line).filter((i) => {
      const k = e.lineStart[i];
      return near(scene.linePos[k * 4 + 1], 6000, 1e-6) && near(scene.linePos[k * 4 + 3], 6000, 1e-6);
    });
    const k = xl[0] !== undefined ? e.lineStart[xl[0]] : -1;
    const x1 = k >= 0 ? Math.min(scene.linePos[k * 4], scene.linePos[k * 4 + 2]) : NaN;
    const x2 = k >= 0 ? Math.max(scene.linePos[k * 4], scene.linePos[k * 4 + 2]) : NaN;
    check('XLINE は図面の範囲で切る', xl.length === 1 && x1 <= -210 && x2 >= 3500 && x2 < 1e6, [x1, x2]);
    check('XLINE の切った端は端点にしない', k >= 0 && (scene.lineSnap[k] & 6) === 0);
  }
  check('段階 B の図面に読み飛ばしの警告はない', !r.warnings.some((w) => w.includes('読み飛ばし')), r.warnings);

  // loadDrawing の数
  const { info } = await loadDrawing(buf(bytes), 'stage-b.dxf');
  check('情報の寸法の数', info.counts.dims === 1, info.counts);
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

// ---------- レイヤが 257 個以上 ----------
{
  const rows = ['0', 'SECTION', '2', 'ENTITIES'];
  for (let k = 1; k <= 300; k++) rows.push('0', 'LINE', '8', `L${k}`, '10', '0', '20', String(k), '11', '10', '21', String(k));
  rows.push('0', 'ENDSEC', '0', 'EOF');
  const { scene, info } = await loadDrawing(buf(enc(rows.join('\n'))), 'many.dxf');
  const last = info.groups[15].layers[15];
  check('256 個目からは「その他のレイヤ」', last.name.includes('その他のレイヤ（46 個）') && scene.layerCounts[255] === 46, [last.name, scene.layerCounts[255]]);
  check('レイヤが多い警告', info.warnings.some((w) => w.includes('301 個')), info.warnings);
}

// ---------- 段階 B の図面を切ったり、数を壊したりしても止まらないこと ----------
{
  const full = stageBDxf();
  const text = new TextDecoder().decode(full);
  const lines = text.split('\r\n');
  let seed = 12345;
  const rand = (): number => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
  const bad = ['1e308', '-1e308', 'nan', '-1', '0', '999999999', '1e-300', ''];
  let slowest = 0;
  for (let round = 0; round < 120; round++) {
    let data: Uint8Array;
    if (round < 40) {
      data = full.subarray(0, Math.floor((full.length * round) / 40));
    } else {
      // 値の行（奇数行）をいくつか壊れた数に置き換える
      const copy = [...lines];
      for (let k = 0; k < 8; k++) {
        const at = 1 + 2 * Math.floor(rand() * ((copy.length - 1) / 2));
        copy[at] = bad[Math.floor(rand() * bad.length)];
      }
      data = new TextEncoder().encode(copy.join('\r\n'));
    }
    const t0 = performance.now();
    try {
      await loadDrawing(buf(data), 'broken.dxf', 'dxf');
    } catch (err) {
      if (!(err instanceof Error)) check('壊れた DXF は Error で知らせる', false);
    }
    slowest = Math.max(slowest, performance.now() - t0);
  }
  check('壊れた段階 B の DXF も 4 秒以内', slowest < 4000, Math.round(slowest));
}

console.log(failures ? `${failures} 件の不合格` : 'すべて合格');
if (failures) process.exit(1);
