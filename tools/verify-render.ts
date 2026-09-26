// 描き方の検査（ブラウザ不要）。答えを決め打ちした合成データで、次を確かめる。
//   線種の模様の表、円弧を折った線分でも破線が続くこと、補助線種の色グループ、実点の丸、
//   円ソリッドの種類ごとの塗り（扇形・弓形・外側円弧・円周・円環）、特殊文字の区切り、単色での塗りの色
import { AUX_STYLE_PEN, DASH_STYLES, KIND, buildScene } from '../src/render/geometry.ts';
import { buildPalette, luminance } from '../src/render/theme.ts';
import { plainText, specialRuns } from '../src/render/textlayer.ts';
import { emptyEntities } from '../src/jww/types.ts';
import type { JwwCommon, JwwDocument, JwwEntities, JwwHeader, JwwLineType, JwwSolid } from '../src/jww/types.ts';

let failures = 0;
const fail = (msg: string, info?: unknown): void => {
  failures++;
  console.log(`NG: ${msg}${info === undefined ? '' : ` ${JSON.stringify(info)}`}`);
};
const check = (msg: string, ok: boolean, info?: unknown): void => {
  if (!ok) fail(msg, info);
};

/** Jw_cad の既定の線種（基本設定の「線種」の初期値） */
const JW_LINE_TYPES: [number, number, number, number, number][] = [
  [2, 0x99999999, 4, 1, 3], [3, 0xc3c3c3c3, 8, 1, 4], [4, 0xe7e7e7e7, 8, 1, 5],
  [5, 0xf99ff99f, 16, 1, 5], [6, 0xfff99fff, 32, 1, 8], [7, 0xf24ff24f, 16, 1, 5], [8, 0xfff24fff, 32, 1, 8],
  [9, 0x22222222, 4, 1, 10], [11, 0xccb2b32a, 1, 3, 5], [16, 0xfff99fff, 32, 2, 20],
  [30, 0, 0, 0, 0], [31, 0xffffffff, 32, 1, 10], [32, 0xfe3ffe3f, 16, 1, 15], [50, 0, 32, 1, 10],
];

function header(drawPointRadius = false): JwwHeader {
  const lineTypes: (JwwLineType | undefined)[] = [];
  for (const [s, pattern, unit, pitch, printPitch] of JW_LINE_TYPES) lineTypes[s] = { pattern, unit, pitch, printPitch };
  return {
    version: 700, memo: '', paperSize: 3, writeGroup: 0,
    groups: Array.from({ length: 16 }, () => ({
      state: 2, writeLayer: 0, scale: 1, protect: 0, name: '',
      layers: Array.from({ length: 16 }, () => ({ state: 2, protect: 0, name: '' })),
    })),
    // 線色 9（補助線色）だけ色を変えておく
    penColors: Array.from({ length: 10 }, (_, i) => ({ rgb: i === 9 ? 0xff80ff : 0xffffff, width: 1 })),
    sxfColors: [], sxfColorNames: [], sxfLineTypeNames: [],
    lineTypes,
    pointRadius: [1, 0.2, 0.3, 0.4, 0.5, 0.5, 0.5, 0.5, 0.5, 1],
    drawPointRadius,
    zoom: 1, originX: 0, originY: 0,
  };
}

const common = (penColor: number, penStyle: number): JwwCommon => ({
  group: 0, penStyle, penColor, penWidth: 1, layer: 0, glayer: 0, flag: 0,
});

function doc(fill: (e: JwwEntities) => void, drawPointRadius = false): JwwDocument {
  const entities = emptyEntities();
  fill(entities);
  return { header: header(drawPointRadius), entities, blockDefs: new Map(), warnings: [] };
}

// ---------- 1. 線種の模様の表 ----------
{
  const scene = buildScene(doc(() => {}));
  const d = scene.dashes;
  check('模様の表の大きさ', d.length === DASH_STYLES * 2, d.length);
  check('点線1 は 0x99999999・4 ビット周期・1 ドット', d[2 * 2] === 0x99999999 && d[2 * 2 + 1] === (4 | (1 << 8)), [d[4], d[5]]);
  check('補助線は 0x22222222', d[9 * 2] === 0x22222222, d[18]);
  check('倍長線種は 1 ビット 2 ドット', d[16 * 2 + 1] === (32 | (2 << 8)), d[33]);
  check('実線（1）は模様なし', d[1 * 2 + 1] === 0);
  check('ランダム線は実線で描く', d[11 * 2 + 1] === 0);
  check('すべて 1 の模様（SXF の実線）は実線', d[31 * 2 + 1] === 0);
  check('空の模様・周期 0 は、線が消えないよう実線', d[30 * 2 + 1] === 0 && d[50 * 2 + 1] === 0);
  check('SXF の破線は模様あり', d[32 * 2 + 1] === (16 | (1 << 8)));
}

// ---------- 2. 破線が円弧の継ぎ目で始まり直さない ----------
{
  const scene = buildScene(doc((e) => {
    e.arcs.push({
      ...common(2, 5), cx: 0, cy: 0, radius: 10, startAngle: 0, arcAngle: Math.PI, tilt: 0, flatness: 1, isCircle: false,
    });
    e.lines.push({ ...common(2, 2), x1: 0, y1: 0, x2: 30, y2: 0 });
  }));
  const ent = scene.entities;
  // 図形は線、円弧の順に出る
  const arc = 1;
  const ls = ent.lineStart[arc], lc = ent.lineCount[arc];
  let sum = 0;
  let worst = 0;
  for (let i = ls; i < ls + lc; i++) {
    worst = Math.max(worst, Math.abs(scene.lineDist[i] - sum));
    sum += Math.hypot(scene.linePos[i * 4 + 2] - scene.linePos[i * 4], scene.linePos[i * 4 + 3] - scene.linePos[i * 4 + 1]);
  }
  check('円弧の線分は始まりからの長さを続けて持つ', lc > 4 && worst < 1e-4, { 分割: lc, ずれ: worst });
  check('円弧の線分はすべて円弧の線種', Array.from(scene.lineStyle.subarray(ls, ls + lc)).every((s) => s === 5));
  const line = ent.lineStart[0];
  check('次の図形は長さ 0 から数え直す', scene.lineDist[line] === 0 && scene.lineStyle[line] === 2, {
    dist: scene.lineDist[line], style: scene.lineStyle[line],
  });
}

// ---------- 3. 補助線種は補助線色で描き、別の色グループにまとめる。吸着はする ----------
{
  const scene = buildScene(doc((e) => {
    e.lines.push({ ...common(2, 9), x1: 0, y1: 0, x2: 10, y2: 0 });
    e.lines.push({ ...common(2, 1), x1: 0, y1: 5, x2: 10, y2: 5 });
    e.arcs.push({
      ...common(5, 9), cx: 0, cy: 0, radius: 3, startAngle: 0, arcAngle: 0, tilt: 0, flatness: 1, isCircle: true,
    });
  }));
  const ent = scene.entities;
  const g0 = scene.groups[scene.colorGroup[ent.color[0]]];
  const g1 = scene.groups[scene.colorGroup[ent.color[1]]];
  const g2 = scene.groups[scene.colorGroup[ent.color[2]]];
  check('補助線種の線は「補助線種」のグループ', g0.penColor === AUX_STYLE_PEN && g0.label === '補助線種', g0);
  check('線色の違う補助線種の円も同じグループ', g2 === g0 && g0.count === 2, { g2, g0 });
  check('補助線種の見本は補助線色', g0.rgb.join() === '255,128,255', g0.rgb);
  const c = ent.color[0];
  check('補助線種は補助線色で描く', [scene.colors[c * 3], scene.colors[c * 3 + 1], scene.colors[c * 3 + 2]].join() === '255,128,255');
  check('実線の線は線色のグループのまま', g1.penColor === 2 && g1.count === 1, g1);
  check('補助線種の線にも吸着する', scene.lineSnap[ent.lineStart[0]] === 1);
  check('属性の線色は元の線色のまま', ent.pen[0] === 2 && ent.style[0] === 9);
}

// ---------- 4. 実点の丸 ----------
{
  const pts = (e: JwwEntities): void => {
    e.points.push({ ...common(3, 1), x: 1, y: 2, temporary: false });
    e.points.push({ ...common(3, 1), x: 5, y: 5, temporary: true });
  };
  const a = buildScene(doc(pts));
  check('実点は丸として描く（仮点は描かない）', a.dotPos.length === 3 && a.dotPos[0] === 1 && a.dotPos[1] === 2 && a.dotPos[2] === 0,
    Array.from(a.dotPos));
  check('実点の丸は線と同じ色番号', a.dotColor[0] === a.entities.color[0]);
  check('実点も色の図形の数に入る', a.groups[a.colorGroup[a.entities.color[0]]].count === 1);
  const b = buildScene(doc(pts, true));
  check('画面を指定半径で描く図面では、線色ごとの実点半径', Math.abs(b.dotPos[2] - 0.4) < 1e-6, b.dotPos[2]);
}

// ---------- 5. 円ソリッドの種類ごとの塗り ----------
{
  const R = 10;
  /** 円系ソリッド。p1=中心, p4=(半径, 扁平率), p2=(傾き角, 開始角), p3=(円弧角, 種別) */
  const circleSolid = (penStyle: number, sweep: number, kind: number, flat = 1): JwwSolid => ({
    ...common(2, penStyle), x1: 0, y1: 0, x4: R, y4: flat, x2: 0, y2: 0, x3: sweep, y3: kind,
  });
  const area = (solid: JwwSolid): { area: number; tris: number; lines: number; maxR: number } => {
    const scene = buildScene(doc((e) => e.solids.push(solid)));
    const t = scene.triPos;
    let s = 0;
    for (let i = 0; i < t.length; i += 6) {
      s += Math.abs((t[i + 2] - t[i]) * (t[i + 5] - t[i + 1]) - (t[i + 4] - t[i]) * (t[i + 3] - t[i + 1])) / 2;
    }
    let maxR = 0;
    for (let i = 0; i < scene.linePos.length; i += 2) maxR = Math.max(maxR, Math.hypot(scene.linePos[i], scene.linePos[i + 1]));
    check('円ソリッドは 1 つの図形', scene.entities.count === 1 && scene.entities.kind[0] === KIND.solid);
    return { area: s, tris: t.length / 6, lines: scene.linePos.length / 4, maxR };
  };
  // 折れ線で塗るので、弧と弦のあいだのぶん（弦と弧の隔たり 0.02mm ほど）だけ小さくなる
  const near = (v: number, want: number): boolean => Math.abs(v - want) <= Math.max(want * 0.01, 0.2);
  const th = Math.PI / 3;
  const sector = area(circleSolid(101, th, 0));
  check('扇形は中心から', near(sector.area, (R * R * th) / 2), sector.area);
  const segment = area(circleSolid(101, th, 5));
  check('弓形は弦と弧のあいだだけ', near(segment.area, (R * R * (th - Math.sin(th))) / 2), segment.area);
  const q = Math.PI / 2;
  const outer = area(circleSolid(101, q, -1));
  check('外側円弧は弧と両端の接線のあいだ', near(outer.area, R * R * (Math.tan(q / 2) - q / 2)), outer.area);
  const full = area(circleSolid(101, 0, 100));
  check('全円は円板', near(full.area, Math.PI * R * R), full.area);
  const rim = area(circleSolid(111, th, 0));
  check('円周ソリッドは塗らずに円周を線で描く', rim.tris === 0 && rim.lines > 2 && Math.abs(rim.maxR - R) < 1e-3, rim);
  const rimFull = area(circleSolid(111, 0, 100));
  check('円周ソリッドの全円も線だけ', rimFull.tris === 0 && rimFull.lines > 8, rimFull);
  const inner = 6;
  const ring = area(circleSolid(105, 2 * Math.PI, inner, 0.5));
  check('円環ソリッド（105）の楕円は内側も同じ扁平率', near(ring.area, Math.PI * (R * R - inner * inner) * 0.5), ring.area);
  const ring2 = area(circleSolid(106, 2 * Math.PI, inner, 0.5));
  const gap = R - inner;
  check('円環ソリッド「2」（106）の楕円は内外の差が一定', near(ring2.area, Math.PI * (R * R * 0.5 - (R - gap) * (R * 0.5 - gap))), ring2.area);
}

// ---------- 6. 特殊文字 ----------
{
  const runs = specialRuns('3.5^u2-3C');
  check('上付きを区切る', JSON.stringify(runs) === JSON.stringify([
    { text: '3.5', kind: 'normal' }, { text: '2', kind: 'sup' }, { text: '-3C', kind: 'normal' },
  ]), runs);
  check('重ね文字は 2 文字', JSON.stringify(specialRuns('^w12')) === JSON.stringify([{ text: '12', kind: 'overlay' }]));
  check('記号を取り除いた文字列', plainText('m^u2・^d3^o4^c5') === 'm2・345', plainText('m^u2・^d3^o4^c5'));
  check('後ろに文字のない「^」と知らない記号はそのまま', plainText('a^') === 'a^' && plainText('^x1') === '^x1' && plainText('^u') === '^u');
  check('特殊文字のない文字列はそのまま', plainText('寸法 1,200') === '寸法 1,200');
}

// ---------- 7. 単色での塗りの色 ----------
{
  const colors = Uint8Array.from([255, 255, 0, 40, 40, 200]);
  const groups = Uint16Array.from([0, 1]);
  const contrast = (a: number[], b: number[]): number => {
    const la = luminance(a[0], a[1], a[2]) + 0.05, lb = luminance(b[0], b[1], b[2]) + 0.05;
    return Math.max(la, lb) / Math.min(la, lb);
  };
  for (const background of ['dark', 'light'] as const) {
    const p = buildPalette(colors, groups, new Set([1]), { background, mono: true });
    check('パレットは線の色と塗りの色を並べる', p.length === 2 * 2 * 4);
    for (let i = 0; i < 2; i++) {
      const line = [p[i * 4], p[i * 4 + 1], p[i * 4 + 2]];
      const fill = [p[(2 + i) * 4], p[(2 + i) * 4 + 1], p[(2 + i) * 4 + 2]];
      check(`単色（${background}）の塗りの上でも線と文字が読める`, contrast(line, fill) >= 4.5, { line, fill, 比: contrast(line, fill).toFixed(2) });
      check('塗りも隠した色では隠れる', p[(2 + i) * 4 + 3] === p[i * 4 + 3]);
    }
  }
  const color = buildPalette(colors, groups, new Set(), { background: 'dark', mono: false });
  check('色分けのときの塗りは線と同じ色', color.subarray(0, 8).join() === color.subarray(8, 16).join());
}

console.log(failures ? `\n${failures} 件の不合格` : '\nすべて合格');
process.exit(failures ? 1 : 0);
