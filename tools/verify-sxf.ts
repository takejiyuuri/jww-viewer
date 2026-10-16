// SXF の読み取りの検査（ブラウザ不要）。答えの分かっている合成の SFC（sxf-synth.mjs）を読み、
// 部分図の縮尺と実寸・色と線種・円弧・文字の寄せと縦書き・複合図形の入れ子・寸法値・穴のある塗りの面積・
// 循環する複合図形で止まらないこと・壊れたファイルで落ちないことを確かめる。
// P21 は、同じ図面を AP202 に書き直したもの（sxf-p21.ts）が SFC と同じ Scene になるか、\X2\ の文字列、
// B スプライン、循環する参照で止まること、壊れた P21 で落ちないことを確かめる
import { loadDrawing } from '../src/formats/load.ts';
import { detectFormat, unsupportedReason } from '../src/formats/detect.ts';
import { KIND, type Scene } from '../src/render/builder.ts';
import type { LoadedInfo } from '../src/formats/info.ts';
import { loadSxf } from '../src/sxf/load.ts';
import { parseSfc } from '../src/sxf/sfc.ts';
import { buildSxfScene } from '../src/sxf/scene.ts';
import { decodeStepString, parseP21 } from '../src/sxf/p21.ts';
import { alignment, ap202ToSxf } from '../src/sxf/ap202.ts';
import type { SxfDocument, SxfFeature } from '../src/sxf/types.ts';
import { basicSfc, sjis } from './sxf-synth.mjs';
import { writeP21 } from './sxf-p21.ts';

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

/** 端点が (x1,y1)-(x2,y2) の線分を持つ図形 */
function segmentAt(scene: Scene, x1: number, y1: number, x2: number, y2: number, tol = 1e-3): number[] {
  const p = scene.linePos;
  const out: number[] = [];
  for (let i = 0; i < p.length / 4; i++) {
    const a = near(p[i * 4], x1, tol) && near(p[i * 4 + 1], y1, tol) && near(p[i * 4 + 2], x2, tol) && near(p[i * 4 + 3], y2, tol);
    const b = near(p[i * 4], x2, tol) && near(p[i * 4 + 1], y2, tol) && near(p[i * 4 + 2], x1, tol) && near(p[i * 4 + 3], y1, tol);
    if (a || b) out.push(scene.lineEntity[i]);
  }
  return out;
}

function ofKind(scene: Scene, kind: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < scene.entities.count; i++) if (scene.entities.kind[i] === kind) out.push(i);
  return out;
}

// ---------- 見分け ----------
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
check('SFC を見分ける', detectFormat(enc("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('SCADEC level2 feature_mode'),'2;1');\nDATA;\n/*SXF\n")) === 'sfc');
check('注釈が後ろでも FILE_DESCRIPTION で SFC と見分ける', detectFormat(enc("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('SCADEC level2 feature_mode'),'2;1');\n")) === 'sfc');
check('P21 を見分ける', detectFormat(enc("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('SCADEC level2 AP202 mode'),'2;1');\nDATA;\n#1=CARTESIAN_POINT('',(0.,0.));\n")) === 'p21');
check('SFC は開ける形式', unsupportedReason('sfc') === null);

// ---------- 合成の SFC ----------
{
  const bytes = basicSfc();
  const { scene, info } = await loadDrawing(buf(bytes), 'basic.sfc');
  const e = scene.entities;
  check('形式', info.format === 'sfc' && info.layerMode === 'flat' && info.formatLabel.includes('SFC'), [info.format, info.layerMode]);
  check('警告がない', info.warnings.length === 0, info.warnings);
  check('用紙は A3 横（420 × 297）', info.paperLabel === 'A3 横' && scene.paper?.maxX === 420 && scene.paper?.maxY === 297, [info.paperLabel, scene.paper]);
  check('図面名', info.memo === '合成図面', info.memo);

  // レイヤ（用紙の後ろに書いた layer_feature も、出てきた順にコード 1, 2, 3）
  const wall = layerNo(info, '壁');
  const dimL = layerNo(info, '寸法');
  const hidden = layerNo(info, 'HIDDEN');
  check('レイヤの名前（コード順）', wall === 0 && dimL === 1 && hidden === 2, [wall, dimL, hidden]);
  check('lflag 0 のレイヤは元の図面で非表示', info.groups[0].layers[2].state === 0 && info.groups[0].layers[0].state === 2);

  // 縮尺の枠：0 は用紙 1/1、1 は部分図「平面図」1/100
  check('縮尺の枠', info.scaleSlots.length === 2 && info.scaleSlots[0].scale === 1 && info.scaleSlots[1].label === '平面図'
    && near(info.scaleSlots[1].scale, 100, 1e-9) && scene.scales[1] === 100, info.scaleSlots);

  // 用紙の線 (0,0)-(100,0)：枠 0、実寸 100 mm
  const sheetLine = segmentAt(scene, 0, 0, 100, 0);
  check('用紙の線は枠 0 で 100 mm', sheetLine.length === 1 && e.group[sheetLine[0]] === 0
    && near(e.size[sheetLine[0]] * scene.scales[e.group[sheetLine[0]]], 100, 1e-4), sheetLine);
  // 部分図の線 (0,0)-(1000,0) は用紙の (100,100)-(110,100)、実寸 1000 mm
  const partLine = segmentAt(scene, 100, 100, 110, 100);
  check('1/100 の部分図の線は実寸 1000 mm', partLine.length === 1 && e.group[partLine[0]] === 1
    && near(e.size[partLine[0]] * scene.scales[1], 1000, 1e-2) && e.kind[partLine[0]] === KIND.line,
  partLine.map((i) => [e.group[i], e.size[i]]));
  check('部分図の中の図形は部品の外（block -1）', partLine.length === 1 && e.block[partLine[0]] === -1);

  // 色：赤（既定義 2）と利用者定義 17（10,20,30）
  const red = scene.groups.find((g) => g.penColor === 2);
  const user = scene.groups.find((g) => g.penColor === 17);
  check('既定義色の赤', red?.label === '赤' && red.rgb.join() === '255,0,0', red);
  check('利用者定義色 17', !!user && user.rgb.join() === '10,20,30' && user.label.includes('10, 20, 30'), user);

  // 線種：破線（既定義 2）と利用者定義 16（myline）
  const dashed = segmentAt(scene, 100, 101, 110, 101);
  const mine = segmentAt(scene, 100, 102, 110, 102);
  const dashedStyle = dashed.length ? e.style[dashed[0]] : -1;
  const mineStyle = mine.length ? e.style[mine[0]] : -1;
  check('既定義線種の破線', dashedStyle > 0 && info.lineTypeNames?.[dashedStyle] === '破線'
    && scene.dashes[dashedStyle * 2 + 1] > 0, [dashedStyle, info.lineTypeNames]);
  check('利用者定義線種', mineStyle > 0 && mineStyle !== dashedStyle && info.lineTypeNames?.[mineStyle] === 'myline'
    && e.pen[mine[0]] === 17, [mineStyle, info.lineTypeNames]);

  // 入れ子：平面図 ⊃ 作図グループ G1 ⊃ 作図部品「部品A」（(5,5) に 90°・2 倍）。線 (0,0)-(10,0) は (5,5)-(5,25)
  const nested = segmentAt(scene, 100.05, 100.05, 100.05, 100.25, 1e-4);
  check('入れ子の部品の線（回転・倍率・部分図の縮尺）', nested.length === 1 && e.group[nested[0]] === 1
    && near(e.size[nested[0]] * scene.scales[1], 20, 1e-3), nested.map((i) => [e.group[i], e.size[i]]));
  check('部品の中の図形は自分のレイヤ（受け継がない）と部品名', nested.length === 1 && e.layer[nested[0]] === dimL
    && scene.blockNames[e.block[nested[0]]] === '部品A', nested.map((i) => [e.layer[i], e.block[i]]));

  // 円弧：部分図の中の半径 100 の 1/4（実寸の半径 100、弧の長さ 50π）
  const arcs = ofKind(scene, KIND.arc).filter((i) => e.group[i] === 1);
  check('部分図の円弧の実寸', arcs.length === 1 && near(e.size[arcs[0]] * 100, 100, 1e-3)
    && near(e.length[arcs[0]] * 100, 50 * Math.PI, 1e-2), arcs.map((i) => [e.size[i], e.length[i]]));

  // 文字の寄せ：基点 5（中中）で (50, 50)、幅 10・高さ 5 → 左下 (45, 47.5)
  const center = scene.texts.find((t) => t.text === '中央');
  check('文字の基点 5（中中）', !!center && near(center.x, 45, 1e-6) && near(center.y, 47.5, 1e-6)
    && near(center.width, 10, 1e-6) && near(center.height, 5, 1e-6), center);
  // 縦書き：基点 7（左上）で (80, 80)、高さ 4、長さ 8 → 1 字ずつ上から
  const v1 = scene.texts.find((t) => t.text === '縦');
  const v2 = scene.texts.find((t) => t.text === '書');
  check('縦書きは 1 字ずつ上から下へ', !!v1 && !!v2 && near(v1.x, 80, 1e-6) && near(v1.y, 76, 1e-6) && near(v2.y, 72, 1e-6)
    && v1.entity === v2.entity, [v1, v2]);
  const hiddenText = scene.texts.find((t) => t.text === '隠し');
  check('非表示レイヤの文字も読む', !!hiddenText && hiddenText.layer === hidden);

  // 寸法：寸法線は KIND.dim（枠 1）、補助線は dimAux（吸着しない）、寸法値 1000 をつなぐ
  const dims = ofKind(scene, KIND.dim);
  const aux = ofKind(scene, KIND.dimAux);
  const dimText = ofKind(scene, KIND.dimText);
  check('寸法線・補助線 2 本・寸法値', dims.length === 1 && aux.length === 2 && dimText.length === 1, [dims.length, aux.length, dimText.length]);
  if (dims.length === 1) {
    const t = scene.texts[e.text[dims[0]]];
    check('寸法線に寸法値 1000 がつながる', t?.text === '1000' && aux.every((i) => e.text[i] === e.text[dims[0]]), t);
    check('寸法線の実寸は 1000 mm、寸法は枠 1', near(e.size[dims[0]] * scene.scales[e.group[dims[0]]], 1000, 1e-2)
      && e.group[dims[0]] === 1, [e.size[dims[0]], e.group[dims[0]]]);
    let auxSnap = 0;
    for (let i = 0; i < scene.lineEntity.length; i++) if (aux.includes(scene.lineEntity[i]) && scene.lineSnap[i]) auxSnap++;
    check('補助線は吸着しない', auxSnap === 0, auxSnap);
  }

  // 塗り：外周 40 × 40 − 穴 10 × 10 = 1500。外周の境界（flag 1）は線で描き、穴（flag 0）は描かない
  const hatches = ofKind(scene, KIND.hatch);
  const fill = hatches.find((i) => e.triCount[i] > 0);
  check('穴のある塗りの面積 1500', fill !== undefined && near(e.size[fill], 1500, 1e-6) && e.pen[fill] === 17,
    hatches.map((i) => [e.size[i], e.triCount[i]]));
  check('見える境界だけ線で描く', segmentAt(scene, 0, 150, 40, 150).length === 1 && segmentAt(scene, 10, 160, 20, 160).length === 0);
  // 模様：半円（面積 50π）の中に 45° の線。吸着しない
  const pattern = hatches.find((i) => e.lineCount[i] > 0);
  let patternSnap = 0;
  if (pattern !== undefined) {
    for (let k = e.lineStart[pattern]; k < e.lineStart[pattern] + e.lineCount[pattern]; k++) {
      if (scene.lineSnap[k]) patternSnap++;
      const dx = scene.linePos[k * 4 + 2] - scene.linePos[k * 4], dy = scene.linePos[k * 4 + 3] - scene.linePos[k * 4 + 1];
      if (!near(Math.abs(dx), Math.abs(dy), 1e-3)) patternSnap += 1000;
    }
  }
  check('模様のハッチング（45° の線、吸着しない、半円の面積）', pattern !== undefined && e.lineCount[pattern] >= 5
    && patternSnap === 0 && near(e.size[pattern], 50 * Math.PI, 0.6), pattern !== undefined ? [e.lineCount[pattern], patternSnap, e.size[pattern]] : null);

  // スプライン・クロソイド・楕円弧・点・引出し線
  const splines = ofKind(scene, KIND.spline);
  check('スプラインとクロソイド', splines.length === 2, splines.length);
  const clothoid = splines.find((i) => near(scene.linePos[e.lineStart[i] * 4], 200, 1e-6));
  check('クロソイドの長さ 50', clothoid !== undefined && near(e.size[clothoid], 50, 0.05), clothoid !== undefined ? e.size[clothoid] : null);
  check('楕円弧', ofKind(scene, KIND.arc).some((i) => near(e.size[i], 20, 1e-6) && near(e.size2[i], 10, 1e-6)));
  check('点', ofKind(scene, KIND.point).length === 1 && scene.dotPos.length === 3);
  const lead = scene.texts.find((t) => t.text === '引出');
  check('引出し線の文字', !!lead);

  // 循環する複合図形 LOOP は 1 回だけ展開し、中の線 (0,0)-(1,1) は 1 本
  check('循環する複合図形で止まる', segmentAt(scene, 0, 0, 1, 1).length === 1, segmentAt(scene, 0, 0, 1, 1).length);

  // loadSxf の寸法の記録
  const r = loadSxf(buf(bytes), 'basic.sfc', 'sfc').result;
  check('寸法の記録（寸法値・図形の座標の長さ・枠）', r.dimensions.length === 1 && r.dimensions[0].text === '1000'
    && near(r.dimensions[0].length, 1000, 1e-9) && r.dimensions[0].slot === 1, r.dimensions);
}

// ---------- UTF-8 の SFC・壊れた SFC ----------
{
  const text = new TextDecoder('shift_jis').decode(basicSfc());
  const { scene, info } = await loadDrawing(buf(new TextEncoder().encode(text)), 'utf8.sfc');
  check('UTF-8 の SFC も読める', info.format === 'sfc' && scene.texts.some((t) => t.text === '中央') && layerNo(info, '壁') === 0);
}
{
  const head = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('SCADEC level2 feature_mode'),'2;1');\nENDSEC;\nDATA;\n";
  const broken = [
    "/*SXF\n#10 = line_feature('1','1','1','1','0','0','10'\nSXF*/",
    "/*SXF\n#20 = line_feature('1','1','1','1','x','0','10','0')\nSXF*/",
    "/*SXF\n#30 = polyline_feature('1','1','1','1','3','(0,1)','(0)')\nSXF*/",
    "/*SXF\n#40 = sfig_locate_feature('0',\\'NONE\\','0','0','0','1','1')\nSXF*/",
    "/*SXF\n#50 = fill_area_style_colour_feature('1','1','99','0','()')\nSXF*/",
    "/*SXF\n#60 = text_string_feature('1','1','1',\\'閉じない",
    "/*SXF\n#70 = arc_feature('1','1','1','1','0','0','1e400','0','0','90')\nSXF*/",
  ].join('\n');
  let ok = true;
  try {
    const doc = parseSfc(buf(sjis(head + broken)));
    const r = buildSxfScene(doc);
    ok = r.scene.linePos.every(Number.isFinite);
  } catch (err) {
    ok = false;
    console.log(err);
  }
  check('壊れた SFC でも落ちない', ok);
  // 自分を置く部品を何重にも置いても止まる
  const bomb: string[] = [];
  for (let k = 0; k < 12; k++) {
    const prev = k === 0 ? "#1 = line_feature('1','1','1','1','0','0','1','0')" : '';
    if (prev) bomb.push(`/*SXF\n${prev}\nSXF*/`);
    if (k > 0) for (let j = 0; j < 8; j++) bomb.push(`/*SXF\n#${k * 100 + j} = sfig_locate_feature('0',\\'P${k - 1}\\','${j}','0','0','1','1')\nSXF*/`);
    bomb.push(`/*SXF\n#${k * 100 + 99} = sfig_org_feature(\\'P${k}\\','4')\nSXF*/`);
  }
  bomb.push("/*SXF\n#9999 = sfig_locate_feature('0',\\'P11\\','0','0','0','1','1')\nSXF*/");
  const t0 = performance.now();
  const r = buildSxfScene(parseSfc(buf(sjis(head + bomb.join('\n')))));
  check('入れ子で増える部品は上限で打ち切る', r.warnings.some((w) => w.includes('打ち切り')) && performance.now() - t0 < 20000, r.warnings);
}

// ---------- P21 ----------
/** Scene の指紋（型付き配列と文字・色グループ・部品名・用紙） */
function digest(scene: Scene): string {
  let h = 0x811c9dc5;
  const bytes = (b: Uint8Array): void => { for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); } };
  const view = (v: ArrayBufferView): void => bytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  const str = (x: string): void => bytes(new TextEncoder().encode(`${x}\0`));
  const e = scene.entities;
  for (const v of [
    scene.linePos, scene.lineColor, scene.lineLayer, scene.lineSnap, scene.lineEntity, scene.lineStyle, scene.lineDist,
    scene.dashes, scene.dotPos, scene.triPos, scene.triColor, scene.triLayer, scene.triEntity, scene.snapPoint,
    scene.scales, scene.colors, scene.colorGroup, scene.layerCounts, scene.curves,
    e.kind, e.layer, e.pen, e.style, e.color, e.block, e.lineStart, e.lineCount, e.triStart, e.triCount, e.group, e.text,
    e.size, e.size2, e.length,
  ]) view(v);
  for (const t of scene.texts) str(JSON.stringify(t));
  for (const g of scene.groups) str(JSON.stringify(g));
  for (const n of scene.blockNames) str(n);
  str(JSON.stringify(scene.paper));
  return (h >>> 0).toString(16);
}
/** P21 に写せない（AP202 に当たる実体のない）スプラインとクロソイドを外す */
function withoutCurves(doc: SxfDocument): SxfDocument {
  const keep = (list: SxfFeature[]): SxfFeature[] => list.filter((f) => f.t !== 'spline' && f.t !== 'clothoid');
  doc.sheetFeatures = keep(doc.sheetFeatures);
  for (const fig of doc.figures.values()) fig.features = keep(fig.features);
  return doc;
}
check('\\X2\\ などの文字列', decodeStepString('\\X2\\58C1\\X0\\') === '壁' && decodeStepString('\\X\\E9') === 'é'
  && decodeStepString('\\X4\\0001F600\\X0\\') === '😀' && decodeStepString('a\\\\b') === 'a\\b');
check('寄せの名前', alignment('baseline left') === 1 && alignment('centre centre') === 5 && alignment('top right') === 9 && alignment('right') === 3);
{
  const sfcDoc = withoutCurves(parseSfc(buf(basicSfc())));
  const fromSfc = buildSxfScene(sfcDoc);
  const p21 = writeP21(sfcDoc);
  check('P21 を見分ける（書き直したもの）', detectFormat(p21.subarray(0, 4096), 'synth.p21') === 'p21');
  check("P21 の '' の文字列", parseP21(buf(new TextEncoder().encode(
    "ISO-10303-21;\nDATA;\n#1=X('it''s');\nENDSEC;\n"))).entities.get(1)?.records.get('X')?.[0] === "it's");
  const { scene, info } = await loadDrawing(buf(p21), 'synth.p21');
  check('P21 の形式', info.format === 'p21' && info.formatLabel.includes('P21') && info.warnings.length === 0, [info.format, info.warnings]);
  check('P21 のレイヤ名（\\X2\\）と非表示', layerNo(info, '壁') === 0 && layerNo(info, '寸法') === 1 && info.groups[0].layers[2].state === 0);
  check('P21 の用紙と縮尺の枠', info.paperLabel === 'A3 横' && info.scaleSlots.length === 2 && info.scaleSlots[1].scale === 100,
    [info.paperLabel, info.scaleSlots]);
  const a = digest(fromSfc.scene), b = digest(scene);
  check('同じ図面の SFC と P21 で Scene の指紋が同じ', a === b, [a, b, fromSfc.scene.linePos.length, scene.linePos.length,
    fromSfc.scene.entities.count, scene.entities.count, fromSfc.scene.texts.length, scene.texts.length]);
  if (a !== b) {
    // 違うところを探す手がかり
    const e1 = fromSfc.scene.entities, e2 = scene.entities;
    for (let i = 0; i < Math.min(e1.count, e2.count); i++) {
      if (e1.kind[i] !== e2.kind[i] || e1.lineCount[i] !== e2.lineCount[i] || e1.color[i] !== e2.color[i] || e1.layer[i] !== e2.layer[i]
        || e1.size[i] !== e2.size[i] || e1.style[i] !== e2.style[i] || e1.group[i] !== e2.group[i] || e1.block[i] !== e2.block[i]) {
        console.log('  最初に違う図形', i, [e1.kind[i], e2.kind[i]], [e1.lineCount[i], e2.lineCount[i]], [e1.size[i], e2.size[i]],
          [e1.color[i], e2.color[i]], [e1.layer[i], e2.layer[i]], [e1.style[i], e2.style[i]], [e1.group[i], e2.group[i]]);
        break;
      }
    }
  }
}
{
  // B スプライン（単純なインスタンスと、有理の複合インスタンス）。次数 1 の 2 点は長さ 10 の直線
  const head = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('SCADEC level2 AP202 mode'),'2;1');\nENDSEC;\nDATA;\n";
  const body = [
    "#1=CARTESIAN_POINT('',(0.,0.));", "#2=CARTESIAN_POINT('',(10.,0.));", "#3=CARTESIAN_POINT('',(0.,5.));",
    "#4=CARTESIAN_POINT('',(5.,10.));", "#5=CARTESIAN_POINT('',(10.,5.));",
    "#10=B_SPLINE_CURVE_WITH_KNOTS('',1,(#1,#2),.UNSPECIFIED.,.F.,.F.,(2,2),(0.,1.),.UNSPECIFIED.);",
    '#11=(BOUNDED_CURVE()B_SPLINE_CURVE(2,(#3,#4,#5),.UNSPECIFIED.,.F.,.F.)B_SPLINE_CURVE_WITH_KNOTS((3,3),(0.,1.),.UNSPECIFIED.)'
      + "CURVE()GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_CURVE((1.,1.,1.))REPRESENTATION_ITEM(''));",
    "#20=DRAUGHTING_PRE_DEFINED_COLOUR('red');", "#21=DRAUGHTING_PRE_DEFINED_CURVE_FONT('continuous');",
    "#22=CURVE_STYLE('',#21,POSITIVE_LENGTH_MEASURE(0.25),#20);", '#23=PRESENTATION_STYLE_ASSIGNMENT((#22));',
    "#30=ANNOTATION_CURVE_OCCURRENCE('',(#23),#10);", "#31=ANNOTATION_CURVE_OCCURRENCE('',(#23),#11);",
    // 循環：自分を部材にする合成曲線、自分を置く表現
    "#40=COMPOSITE_CURVE('',(#41),.F.);", '#41=COMPOSITE_CURVE_SEGMENT(.CONTINUOUS.,.T.,#40);',
    "#42=ANNOTATION_CURVE_OCCURRENCE('',(#23),#40);",
    "#50=AXIS2_PLACEMENT_2D('',#1,$);", "#51=DRAUGHTING_SUBFIGURE_REPRESENTATION('R',(#30,#53),$);",
    '#52=SYMBOL_REPRESENTATION_MAP(#50,#51);', "#53=MAPPED_ITEM('',#52,#54);", "#54=SYMBOL_TARGET('',#50,1.,1.);",
    "#90=DRAWING_SHEET_REVISION('S',(#30,#31,#42,#53),$,'1');",
  ].join('\n');
  const t0 = performance.now();
  const { scene, info } = await loadDrawing(buf(new TextEncoder().encode(`${head}${body}\nENDSEC;\nEND-ISO-10303-21;\n`)), 'b.p21');
  const e = scene.entities;
  const sp = ofKind(scene, KIND.spline);
  check('P21 の B スプライン（直線は長さ 10、有理の 2 次は (0,5) から）', sp.length >= 2 && near(e.size[sp[0]], 10, 1e-6)
    && near(scene.linePos[e.lineStart[sp[1]] * 4], 0, 1e-6) && near(scene.linePos[e.lineStart[sp[1]] * 4 + 1], 5, 1e-6),
  sp.map((i) => e.size[i]));
  check('循環する参照で止まる', performance.now() - t0 < 5000 && info.format === 'p21');
}
{
  // 壊れた P21：途中で切れる・閉じない文字列・読めない値・深すぎる入れ子・自分を参照する配置
  const head = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('x'),'2;1');\nENDSEC;\nDATA;\n";
  const cases = [
    "#1=CARTESIAN_POINT('',(0.,0.));\n#2=POLYLINE('',(#1,#3));\n#3=CART",
    "#1=TEXT_LITERAL('abc,(#2));\n",
    "#1=FOO(@@@);\n#2=DRAWING_SHEET_REVISION('S',(#1),$,'1');\n",
    `#1=FOO(${'('.repeat(100)}${')'.repeat(100)});\n#2=DRAWING_SHEET_REVISION('S',(#1),$,'1');\n`,
    "#2=DRAWING_SHEET_REVISION('S',(#2,#3),$,'1');\n#3=MAPPED_ITEM('',#3,#3);\n",
    'no data section',
  ];
  let ok = true;
  for (const c of cases) {
    try {
      const r = buildSxfScene(ap202ToSxf(parseP21(buf(new TextEncoder().encode(head + c)))));
      if (!r.scene.linePos.every(Number.isFinite)) ok = false;
    } catch (err) {
      // DATA 節のないものは理由を出して断る
      if (!(c === 'no data section' && /DATA/.test((err as Error).message))) { ok = false; console.log(err); }
    }
  }
  check('壊れた P21 でも落ちない', ok);
}

{
  // 壊したファイル（切り詰め・バイトの書き換え）を SFC と P21 で 300 通りずつ。落ちず、座標は有限で、早く終わること
  let seed = 12345;
  const rand = (n: number): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  const sfc = basicSfc();
  const p21 = writeP21(withoutCurves(parseSfc(buf(sfc))));
  let bad = 0;
  let slowest = 0;
  for (const [format, src] of [['sfc', sfc], ['p21', p21]] as const) {
    for (let k = 0; k < 300; k++) {
      let b = src.slice();
      if (k % 3 === 0) b = b.subarray(0, rand(b.length));
      else for (let j = 0; j < 1 + rand(20); j++) b[rand(b.length)] = [0x28, 0x29, 0x27, 0x23, 0x2c, 0x3b, 0x2d, 0x39, rand(256)][rand(9)];
      const t0 = performance.now();
      try {
        const r = loadSxf(buf(b), 'x', format).scene;
        if (!r.linePos.every(Number.isFinite) || !r.triPos.every(Number.isFinite)) bad++;
      } catch (err) {
        if (!/DATA/.test((err as Error).message)) { bad++; if (bad < 3) console.log(format, k, err); }
      }
      slowest = Math.max(slowest, performance.now() - t0);
    }
  }
  check('壊した SXF 600 通りで落ちない', bad === 0 && slowest < 5000, { bad, slowest: Math.round(slowest) });
}

if (failures) {
  console.log(`\n${failures} 件の NG`);
  process.exit(1);
}
console.log('SXF の検査はすべて OK');
