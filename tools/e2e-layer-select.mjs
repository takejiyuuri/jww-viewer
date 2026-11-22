// レイヤ選択モード 段階 1・段階 2 と、レイヤ・表示のパネルの大きさ（仕様書 9 章、9-12〜9-14）を画面で確かめる。
// ・下の「レイヤ」で一覧を開いているあいだがモード。一覧をいちばん小さくしても続く（帯にレイヤ名）。閉じると直前の操作に戻る
// ・図面の線をタップすると、その線と一覧の行を黄色で示し、グループを開いて、行が見えなければ見える所まで送る。上に帯を出す
// ・別の線で切り替わり、何もない所で消える。選んだだけでは表示・非表示も、表示の戻る・進むの履歴も変わらない
// ・モードのあいだは、計測の点・累進の列や起点・属性の選択・記録の札を変えない。図面を動かす・拡大縮小はできる
// ・選んだレイヤ（グループ・色）を隠すと線の黄色が消え、行の黄色は残る。表示に戻すと線の黄色も戻る（j・m）
// ・隠したレイヤ・色の線は選べない。文字・寸法（線と数字は別のレイヤ）・点・塗り・部品を選べる。DXF の 1 段の一覧でも動く
// ・累進表示中は、累進で隠している元の寸法の数字を拾わない
// ・黒背景・白背景のどちらでも、黄色の強調が背景とはっきり違う色で描かれる（画面の書き出しで確かめる、o）
// ・iPhone SE・横向き・iPad で、帯と行が崩れない。ツールバーの道具を押すと一覧を閉じてその道具になる
// ・（段階 2）重なった線は、同じ所をもう一度タップするか帯の「重なり ▸」で次のレイヤの線へ（同じレイヤは 1 つ、順番はいつも同じ）。
//   別の所のタップ・図面を動かす・表示を変えると決め直す。長押しで拡大鏡を出し、指の下の線を黄色で示して、離した所の線を選ぶ
// ・レイヤ・表示のパネルは、つまみと見出し（横の iPhone は左の縁）をずらして大きさを自由に変え、離した所で止まる。
//   いちばん小さい・大きい大きさがあり、一覧を送っても・線を選んでも大きさは変わらない。大きさはパネルごとに覚え、回しても画面に収まる
// 引数：出力先のフォルダ（スクリーンショット）。図面はこの中で組み立てる（実務の図面は使わない）。累進は public/ruishin-sample.jww
import { chromium } from 'playwright';
import path from 'node:path';
import { startServer, projectRoot as root } from './serve.mjs';
import { makeJww } from './jww-synth.mjs';

const srv = await startServer({ port: 5332, host: false, quiet: true });
const outDir = process.argv[2] ?? '.';
const ruishinSample = path.join(root, 'public', 'ruishin-sample.jww');

const browser = await chromium.launch({
  ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const phone = (w, h, dpr = 3) => ({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true });
const errors = [];

const results = [];
const check = (name, ok, info) => results.push({ name, ok, ...(info ?? {}) });
const report = () => {
  let failed = 0;
  for (const r of results) {
    const { name, ok, ...info } = r;
    if (ok) console.log(`OK: ${name}`);
    else {
      failed++;
      console.log(`NG: ${name}`);
      console.log(`    ${JSON.stringify(info)}`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} 合格`);
  return failed;
};
// 途中で止まっても、そこまでの結果は出す
process.on('uncaughtException', (err) => {
  report();
  console.log(`NG: 途中で止まった ${err?.message?.split('\n')[0]}`);
  process.exit(1);
});

// ---------- 確かめるための図面（縮尺 1、図面の mm） ----------
// グループ・レイヤの番号は 16 進の 2 桁（上がグループ、下がレイヤ）
const K = {
  wall: 0x00, grid: 0x01, text: 0x12, point: 0x14, solid: 0x15, tesuri: 0x23, buhin: 0x30, dimLine: 0x57, dimText: 0x58, far: 0xfe,
  ovA: 0x40, ovB: 0x41, ovC: 0x42, tierLine: 0x44, tierPoint: 0x45, tierSolid: 0x46,
};
const at = (k) => [k >> 4, k & 15];
const entities = [
  { line: [0, 0, 30, 0], layer: at(K.tesuri), color: 2 },    // 手すり（横線、線色 2）
  { line: [50, -15, 50, 15], layer: at(K.wall) },             // 壁（縦線）
  { line: [70, -15, 70, 15], layer: at(K.grid), color: 5 },   // 通り芯（線色 5。色を隠す確かめに使う）
  { text: 'LABEL', at: [90, -2.5], angle: 0, size: 5, layer: at(K.text) }, // 文字（90〜110 × -2.5〜2.5）
  { point: [130, 0], layer: at(K.point) },
  { solid: [150, -10, 170, -10, 170, 10, 150, 10], layer: at(K.solid) },
  { ref: 1, at: [190, 0], layer: at(K.buhin) },               // 部品「MADO」（中身の線は 190〜210）
  { dim: [230, 0, 260, 0], value: '3000', size: 3, layer: at(K.dimLine), textLayer: at(K.dimText) },
  { line: [280, -15, 280, 15], layer: at(K.far) },            // いちばん下のグループの行
  // （段階 2）ぴったり重なった線。描く順は C・A・B・B（同じレイヤ B は 2 本）。候補はレイヤの番号の順に A・B・C の 3 つ
  { line: [320, 0, 350, 0], layer: at(K.ovC) },
  { line: [320, 0, 350, 0], layer: at(K.ovA) },
  { line: [320, 0, 350, 0], layer: at(K.ovB) },
  { line: [325, 0, 345, 0], layer: at(K.ovB) },
  // （段階 2）段の順：線（指のすぐ近く）→ 点 → 塗り。塗りの上に、線と、線のすぐ近くの点を置く
  { solid: [360, -6, 380, -6, 380, 6, 360, 6], layer: at(K.tierSolid) },
  { line: [360, 0, 380, 0], layer: at(K.tierLine) },
  { point: [370, 0.4], layer: at(K.tierPoint) },
];
// 一覧を長くする（グループ 0 の残りのレイヤと、グループ 6〜E）。図面の遠い所に短い線を置く
for (let l = 2; l < 16; l++) entities.push({ line: [400 + l * 3, 80, 400 + l * 3, 85], layer: [0, l] });
for (let g = 6; g < 15; g++) entities.push({ line: [500 + g * 3, 80, 500 + g * 3, 85], layer: [g, 0] });
const groupNames = [];
groupNames[0] = 'KIHON';
groupNames[1] = 'MOJI';
groupNames[2] = 'GAIKO-EXTERIOR-WORKS-AND-FENCES';
groupNames[3] = 'BUHIN';
groupNames[4] = 'KASANARI';
groupNames[5] = 'SUNPOU';
groupNames[15] = 'LAST';
const layerNames = {
  [K.wall]: 'WALL', [K.grid]: 'GRID', [K.text]: 'TEXT', [K.point]: 'POINT', [K.solid]: 'SOLID',
  [K.tesuri]: 'TESURI-HANDRAIL', [K.buhin]: 'BUHIN-PLACE', [K.dimLine]: 'DIM-LINE', [K.dimText]: 'DIM-TEXT', [K.far]: 'FAR-ROW',
  [K.ovA]: 'OV-A', [K.ovB]: 'OV-B', [K.ovC]: 'OV-C', [K.tierLine]: 'T-LINE', [K.tierPoint]: 'T-POINT', [K.tierSolid]: 'T-SOLID',
};
const jwwBytes = Buffer.from(makeJww({
  entities,
  defs: [{ no: 1, name: 'MADO', entities: [{ line: [0, 0, 20, 0], layer: [4, 9] }] }],
  layerNames, groupNames,
}));

// DXF（レイヤ名だけの 1 段の一覧）。35 レイヤで、名前の絞り込みの欄が出る
const dxfText = (() => {
  const L = Array.from({ length: 35 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`);
  const out = [];
  const p = (...kv) => { for (let i = 0; i < kv.length; i += 2) out.push(String(kv[i]).padStart(3), String(kv[i + 1])); };
  p(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1015', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC');
  p(0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, L.length);
  for (const n of L) p(0, 'LAYER', 2, n, 70, 0, 62, 7, 6, 'CONTINUOUS');
  p(0, 'ENDTAB', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES');
  L.forEach((n, i) => p(0, 'LINE', 8, n, 10, i * 10, 20, 0, 30, 0, 11, i * 10, 21, 20, 31, 0));
  p(0, 'ENDSEC', 0, 'EOF');
  return out.join('\r\n') + '\r\n';
})();

// ---------- 画面の操作 ----------
const newPage = async (options) => {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(srv.url, { waitUntil: 'networkidle' });
  return page;
};
const openFile = async (page, name, buffer) => {
  await page.setInputFiles('#file', { name, mimeType: 'application/octet-stream', buffer });
  await page.waitForFunction((n) => document.getElementById('title')?.textContent?.endsWith(n.slice(-4)), name, { timeout: 60000 });
  await page.waitForTimeout(800);
};
const openPath = async (page, file) => {
  await page.setInputFiles('#file', file);
  await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
  await page.waitForTimeout(800);
};

/**
 * 図面の点 (wx, wy) が、バー・パネル・開いている一覧に隠れずに見えている所の真ん中に来るように、1 mm = ppm px で表示する。
 * その点の画面の位置（CSS ピクセル）を返す
 */
const showAt = (page, wx, wy, ppm = 6) => page.evaluate(([wx, wy, ppm]) => {
  const a = window.__jww;
  const v = { ...a.visibleArea() };
  const panel = document.getElementById('layer-panel');
  if (!panel.classList.contains('hidden')) {
    const r = panel.getBoundingClientRect();
    if (r.top > a.cssH * 0.3) v.bottom = Math.min(v.bottom, r.top);
    else v.right = Math.min(v.right, r.left);
  }
  a.view.zoom = ppm * a.dpr;
  const mx = (v.left + v.right) / 2;
  const my = (v.top + v.bottom) / 2;
  a.view.cx = wx - ((mx - a.cssW / 2) * a.dpr) / a.view.zoom;
  a.view.cy = wy + ((my - a.cssH / 2) * a.dpr) / a.view.zoom;
  a.textLayer.render(a.view);
  a.requestDraw(true);
  return { x: mx, y: my };
}, [wx, wy, ppm]);
const tapAt = async (page, wx, wy, ppm) => {
  const s = await showAt(page, wx, wy, ppm);
  await page.waitForTimeout(120);
  await page.touchscreen.tap(s.x, s.y);
  await page.waitForTimeout(250);
  return s;
};

/** モードと、選んだ線・一覧の行・帯、ほかの操作の状態をまとめて取る */
const st = (page) => page.evaluate(() => {
  const a = window.__jww;
  const rows = document.querySelectorAll('#layer-list .l-row.mark');
  const row = rows[0];
  const body = document.querySelector('#layer-panel .sheet-body');
  const panel = document.getElementById('layer-panel');
  let rowVisible = false;
  if (row && row.offsetParent && !row.hidden) {
    const r = row.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    rowVisible = r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5;
  }
  const bar = document.getElementById('layer-pick');
  const e = a.scene.entities;
  const pr = panel.getBoundingClientRect();
  return {
    open: !panel.classList.contains('hidden'), panelH: Math.round(pr.height), panelW: Math.round(pr.width),
    overlap: a.overlap ? `${a.overlap.at + 1}/${a.overlap.list.length}` : null,
    mode: a.layerMode(), pick: a.layerPick, pickLayer: a.layerPick >= 0 ? e.layer[a.layerPick] : -1,
    pickKind: a.layerPick >= 0 ? e.kind[a.layerPick] : -1,
    marks: rows.length, mark: row ? Number(row.dataset.k) : null, rowVisible,
    groupOpen: row ? !(row.closest('.lg-layers')?.hidden ?? false) : null,
    scrollTop: Math.round(body.scrollTop),
    bar: bar.hidden || getComputedStyle(bar).display === 'none' ? null : bar.textContent,
    yellow: !!a.layerPickHighlight(), green: !!a.currentHighlight(),
    tool: a.tool, selected: a.selected,
    points: JSON.stringify(a.points.map((p) => [+p.x.toFixed(6), +p.y.toFixed(6)])),
    records: a.records.length, focus: a.focusNo,
    origins: JSON.stringify([...a.origins.entries()]), active: a.activeChain,
    past: a.layerPast.length, future: a.layerFuture.length, layers: JSON.stringify(a.layers.snapshot()),
    zoom: a.view.zoom, cx: a.view.cx, cy: a.view.cy,
    holding: a.holding, magnifier: !!a.magnifier,
    inspect: document.getElementById('inspect-body')?.innerHTML ?? '',
  };
});
const entityOn = (page, k, kind) => page.evaluate(([k, kind]) => {
  const e = window.__jww.scene.entities;
  for (let i = 0; i < e.count; i++) if (e.layer[i] === k && (kind === undefined || e.kind[i] === kind)) return i;
  return -1;
}, [k, kind]);

/** 指で押さえて動かす（pointer イベントを直に送る） */
const drag = (page, from, to, holdMs = 40) => page.evaluate(async ([fx, fy, tx, ty, ms]) => {
  const stage = document.getElementById('stage');
  const base = { pointerId: 9, pointerType: 'touch', isPrimary: true, bubbles: true };
  stage.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: fx, clientY: fy }));
  await new Promise((r) => setTimeout(r, ms));
  for (let i = 1; i <= 8; i++) {
    stage.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: fx + ((tx - fx) * i) / 8, clientY: fy + ((ty - fy) * i) / 8 }));
    await new Promise((r) => setTimeout(r, 25));
  }
  stage.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: tx, clientY: ty }));
  await new Promise((r) => setTimeout(r, 200));
}, [from.x, from.y, to.x, to.y, holdMs]);
/** 2 本指で広げる */
const pinch = (page, c) => page.evaluate(async ([cx, cy]) => {
  const stage = document.getElementById('stage');
  const ev = (type, id, x, primary) => stage.dispatchEvent(new PointerEvent(type, {
    pointerId: id, pointerType: 'touch', isPrimary: primary, bubbles: true, clientX: x, clientY: cy,
  }));
  ev('pointerdown', 21, cx - 20, true);
  ev('pointerdown', 22, cx + 20, false);
  for (let i = 1; i <= 8; i++) {
    ev('pointermove', 21, cx - 20 - i * 6, true);
    ev('pointermove', 22, cx + 20 + i * 6, false);
    await new Promise((r) => setTimeout(r, 20));
  }
  ev('pointerup', 21, cx - 68, true);
  ev('pointerup', 22, cx + 68, false);
  await new Promise((r) => setTimeout(r, 200));
}, [c.x, c.y]);
/** 押したまま待って離す（動かさない）。押しているあいだの様子も返す */
const holdStill = (page, c, ms = 650) => page.evaluate(async ([x, y, ms]) => {
  const a = window.__jww;
  const stage = document.getElementById('stage');
  const base = { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: x, clientY: y };
  stage.dispatchEvent(new PointerEvent('pointerdown', base));
  await new Promise((r) => setTimeout(r, ms));
  const mid = { holding: a.holding, magnifier: !!a.magnifier };
  stage.dispatchEvent(new PointerEvent('pointerup', base));
  await new Promise((r) => setTimeout(r, 200));
  return mid;
}, [c.x, c.y, ms]);
/** 線を選ぶ前の帯の文字 */
const EMPTY_BAR = '線をタップすると、レイヤを示します長押しで拡大鏡を出して選べます';

/**
 * パネル（id）のつまみをずらす。縦の画面では見出し（の「レイヤ」などの文字の所）を上下に、横の iPhone では左の縁のつまみを左右に。
 * delta は大きくする向きを正にした量（縦は上へ、横は左へ）。grip に 'head' を渡すと横の iPhone でも見出しをつかむ。
 * ずらしたあとの大きさ（縦は高さ、横は幅）を返す
 */
const resizePanel = (page, id, delta, grip = 'auto') => page.evaluate(async ([id, delta, grip]) => {
  const p = document.getElementById(id);
  const side = window.__jww.sideSheets();
  const g = side && grip !== 'head' ? p.querySelector('.resize-edge') : p.querySelector('.sheet-head');
  const t = side && grip !== 'head' ? g : g.querySelector('strong');
  const b = t.getBoundingClientRect();
  const x = b.left + b.width / 2;
  const y = b.top + b.height / 2;
  const base = { pointerId: 31, pointerType: 'touch', isPrimary: true, bubbles: true };
  t.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x, clientY: y }));
  for (let i = 1; i <= 10; i++) {
    const d = (delta * i) / 10;
    t.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: side ? x - d : x, clientY: side ? y : y - d }));
    await new Promise((r) => setTimeout(r, 16));
  }
  t.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: side ? x - delta : x, clientY: side ? y : y - delta }));
  await new Promise((r) => setTimeout(r, 200));
  const r = p.getBoundingClientRect();
  return Math.round(side ? r.width : r.height);
}, [id, delta, grip]);
/** パネル（id）の大きさ（縦は高さ、横の iPhone は幅）と、画面の中に収まっているか */
const panelBox = (page, id) => page.evaluate((id) => {
  const a = window.__jww;
  const p = document.getElementById(id).getBoundingClientRect();
  const tb = document.getElementById('toolbar').getBoundingClientRect();
  const top = document.getElementById('topbar').getBoundingClientRect();
  const side = a.sideSheets();
  return {
    side, size: Math.round(side ? p.width : p.height), left: p.left, right: p.right, top: p.top, bottom: p.bottom,
    inScreen: p.left >= -0.5 && p.right <= innerWidth + 0.5 && p.top >= top.bottom - 0.5 && p.bottom <= innerHeight + 0.5,
    // 縦の画面ではツールバーにかからない（ツールバーのすぐ上）。横の iPhone ではツールバーの列にかからない
    clearOfToolbar: side ? (p.right <= tb.left + 0.5 || p.left >= tb.right - 0.5) : p.bottom <= tb.top + 0.5,
    toolbarShown: tb.width > 0 && tb.height > 0,
    stored: JSON.parse(localStorage.getItem('jww-viewer:panel-size') ?? 'null'),
  };
}, id);

/** WCAG の相対輝度とコントラスト比 */
const lum = ([r, g, b]) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (p, q) => { const a = lum(p), b = lum(q); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
/**
 * 画面の書き出しで、縦線（画面の x の所）を横に横切る色を取る。
 * 線の真ん中・縁取りの所（3 px 外）・背景（14 px 外）の色
 */
const crossColors = async (page, x, y) => {
  const png = (await page.screenshot()).toString('base64');
  return page.evaluate(async ([b64, x, y]) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const k = img.width / innerWidth;
    const at = (dx) => [...g.getImageData(Math.round((x + dx) * k), Math.round(y * k), 1, 1).data.slice(0, 3)];
    return { center: at(0), edgeUp: at(-3), edgeDown: at(3), bgUp: at(-14), bgDown: at(14) };
  }, [png, x, y]);
};
const isYellow = ([r, g, b]) => r > 200 && g > 160 && b < 110;

// =====================================================================
// 1. iPhone（縦）：計測の途中で一覧を開いて線を選ぶ
// =====================================================================
const page = await newPage(phone(393, 852));
await openFile(page, 'layer-select.jww', jwwBytes);

const ids = {
  tesuri: await entityOn(page, K.tesuri), wall: await entityOn(page, K.wall), grid: await entityOn(page, K.grid),
  text: await entityOn(page, K.text), point: await entityOn(page, K.point), solid: await entityOn(page, K.solid),
  buhin: await entityOn(page, K.buhin), far: await entityOn(page, K.far),
};
check('準備：確かめる図面のレイヤに図形が入っている', Object.values(ids).every((i) => i >= 0), ids);

// 計測の点を 2 つ置いて記録し、また 2 つ置く。属性で壁を選んでから、計測に戻る
await tapAt(page, 0, 0);
await tapAt(page, 30, 0);
await page.click('#btn-record');
await page.waitForTimeout(300);
await tapAt(page, 0, 0);
await tapAt(page, 50, 0);
await page.click('#btn-tool-inspect');
await tapAt(page, 50, 0);
await page.click('#btn-tool-measure');
await page.waitForTimeout(300);
const before = await st(page);
check('準備：計測の点 2 つ・記録 1 つ・属性で壁を選んだまま計測にいる',
  before.tool === 'measure' && JSON.parse(before.points).length === 2 && before.records === 1 && before.selected === ids.wall && !before.open,
  { tool: before.tool, points: before.points, records: before.records, selected: before.selected });

// ---- 開く：モードに入り、属性で選んでいた線を最初から黄色で示す ----
await page.click('#btn-layers');
await page.waitForTimeout(400);
{
  const s = await st(page);
  check('一覧を開くとレイヤ選択モードになる', s.open && s.mode, s);
  check('開いたとき、属性で選んでいた線（壁）を最初から黄色で示し、行にも印（属性の選択は変えない）',
    s.pick === ids.wall && s.yellow && s.marks === 1 && s.mark === K.wall && s.rowVisible && s.selected === ids.wall, s);
  check('帯に「選んだ線：WALL（KIHON）」', s.bar === '選んだ線：WALL（KIHON）', { bar: s.bar });
  const rowStyle = await page.evaluate(() => {
    const r = document.querySelector('#layer-list .l-row.mark');
    const cs = getComputedStyle(r);
    return { bg: cs.backgroundColor, shadow: cs.boxShadow };
  });
  check('行の印は黄色（薄い緑ではない）', /250, 204, 21/.test(rowStyle.bg) && /250, 204, 21/.test(rowStyle.shadow), rowStyle);
  await page.screenshot({ path: path.join(outDir, 'ls-1-open.png') });
}

// ---- 線をタップ：計測の点は置かず、その線とレイヤを黄色で示す（9-2 i ①） ----
{
  const c = await showAt(page, 15, 0);
  await page.waitForTimeout(120);
  const base = await st(page);
  await page.touchscreen.tap(c.x, c.y);
  await page.waitForTimeout(250);
  const s = await st(page);
  check('計測中でも、モードのあいだのタップは計測の点を置かずに線を選ぶ', s.points === before.points && s.pick === ids.tesuri, { points: s.points, pick: s.pick });
  check('選んだ線の行が黄色になり、行のグループが開いて見える所にある',
    s.marks === 1 && s.mark === K.tesuri && s.groupOpen && s.rowVisible && s.yellow, s);
  check('帯に「選んだ線：TESURI-HANDRAIL（GAIKO-…）」', s.bar === '選んだ線：TESURI-HANDRAIL（GAIKO-EXTERIOR-WORKS-AND-FENCES）', { bar: s.bar });
  check('線を選んだだけでは、表示・非表示も、表示の戻る・進むの履歴も変わらない',
    s.layers === base.layers && s.past === base.past && s.future === base.future, { past: s.past, future: s.future });
  check('属性の選択・記録・累進の起点は変わらない（9-3 n）',
    s.selected === before.selected && s.records === before.records && s.origins === before.origins && s.focus === null, s);
  check('線を選んでも図面は動かない', s.zoom === base.zoom && s.cx === base.cx && s.cy === base.cy, { base: [base.zoom, base.cx, base.cy], s: [s.zoom, s.cx, s.cy] });
  await page.screenshot({ path: path.join(outDir, 'ls-2-pick-tesuri.png') });

  // 図面は 1 本指で動かせる（選んだ線はそのまま）
  const v0 = await st(page);
  await drag(page, c, { x: c.x + 60, y: c.y + 30 });
  const v1 = await st(page);
  check('モードのあいだも 1 本指で図面を動かせる（選んだ線・計測の点は変わらない）',
    (v1.cx !== v0.cx || v1.cy !== v0.cy) && v1.pick === ids.tesuri && v1.points === before.points, { v0: [v0.cx, v0.cy], v1: [v1.cx, v1.cy] });
  // 2 本指で拡大できる
  await pinch(page, c);
  const v2 = await st(page);
  check('モードのあいだも 2 本指で拡大できる（選んだ線・計測の点は変わらない）',
    v2.zoom > v1.zoom && v2.pick === ids.tesuri && v2.points === before.points, { z1: v1.zoom, z2: v2.zoom });
  // （段階 2）長押しで拡大鏡を出し、指の下の線を黄色で示して、離した所の線を選ぶ。点は置かない
  await tapAt(page, 100, 40); // 選択を消しておく
  const c2 = await showAt(page, 15, 0);
  const mid = await page.evaluate(async ([x, y]) => {
    const a = window.__jww;
    const stage = document.getElementById('stage');
    const base = { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: x, clientY: y };
    stage.dispatchEvent(new PointerEvent('pointerdown', base));
    await new Promise((r) => setTimeout(r, 650));
    const m = a.magnifier;
    const panel = document.getElementById('layer-panel').getBoundingClientRect();
    const res = {
      holding: a.holding, magnifier: !!m, preview: a.previewEntity, yellow: !!a.layerPickHighlight(), pick: a.layerPick,
      bar: document.getElementById('layer-pick').textContent,
      clearOfPanel: !!m && (m.y + m.size <= panel.top + 0.5 || m.x + m.size <= panel.left + 0.5 || m.y >= panel.bottom - 0.5),
    };
    stage.dispatchEvent(new PointerEvent('pointerup', base));
    await new Promise((r) => setTimeout(r, 250));
    return res;
  }, [c2.x, c2.y]);
  const v3 = await st(page);
  check('（段階 2）長押しで拡大鏡を出し、指の下の線を黄色で示す（帯もその線のレイヤ。離すまでは選ばない）',
    mid.holding && mid.magnifier && mid.preview === ids.tesuri && mid.yellow && mid.pick === -1
      && mid.bar === '選んだ線：TESURI-HANDRAIL（GAIKO-EXTERIOR-WORKS-AND-FENCES）', mid);
  check('（段階 2）拡大鏡は一覧のパネルにかからない', mid.clearOfPanel, mid);
  check('（段階 2）指を離すとその線を選ぶ。計測の点は置かない',
    !v3.holding && !v3.magnifier && v3.pick === ids.tesuri && v3.mark === K.tesuri && v3.points === before.points, { pick: v3.pick, points: v3.points });
  await page.screenshot({ path: path.join(outDir, 'ls-2b-hold.png') });
  // 何もない所から長押しして、線の上まで指を動かして離すと、その線を選ぶ（図面は動かない）
  await tapAt(page, 100, 40);
  const from = await showAt(page, 50, 8);
  const v4 = await st(page);
  const moved = await page.evaluate(async ([x, y]) => {
    const a = window.__jww;
    const stage = document.getElementById('stage');
    const base = { pointerId: 8, pointerType: 'touch', isPrimary: true, bubbles: true };
    stage.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x - 60, clientY: y }));
    await new Promise((r) => setTimeout(r, 450));
    const empty = { preview: a.previewEntity, yellow: !!a.layerPickHighlight() };
    for (let i = 1; i <= 10; i++) {
      stage.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x - 60 + i * 6, clientY: y }));
      await new Promise((r) => setTimeout(r, 30));
    }
    const over = { preview: a.previewEntity, yellow: !!a.layerPickHighlight() };
    stage.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: x, clientY: y }));
    await new Promise((r) => setTimeout(r, 250));
    return { empty, over };
  }, [from.x, from.y]);
  const v5 = await st(page);
  check('（段階 2）何もない所で長押しして線の上まで動かすと、その線を黄色で示し、離すと選ぶ（図面は動かない）',
    moved.empty.preview === -1 && !moved.empty.yellow && moved.over.preview === ids.wall && moved.over.yellow
      && v5.pick === ids.wall && v5.cx === v4.cx && v5.cy === v4.cy && v5.points === before.points, { moved, pick: v5.pick });
  await tapAt(page, 15, 0);
}

// ---- 記録の札を押しても、記録へ動かない（9-2 e） ----
{
  await showAt(page, 15, 0);
  const badge = await page.evaluate(() => {
    const b = window.__jww.recordBadges()[0];
    const top = document.getElementById('layer-panel').getBoundingClientRect().top;
    return b ? { x: b.x, y: b.y, top } : null;
  });
  const v0 = await st(page);
  if (badge && badge.y < badge.top - 10) {
    await page.touchscreen.tap(badge.x, badge.y);
    await page.waitForTimeout(300);
  }
  const s = await st(page);
  check('モードのあいだは、記録の札を押しても記録を見せない（図面も動かない）',
    !!badge && badge.y < badge.top - 10 && s.focus === null && s.zoom === v0.zoom && s.cx === v0.cx && s.cy === v0.cy, { badge, focus: s.focus });
}

// ---- 別の線で切り替わり、何もない所で消える ----
{
  await tapAt(page, 50, 0);
  const s1 = await st(page);
  check('別の線をタップすると強調が切り替わる', s1.pick === ids.wall && s1.mark === K.wall && s1.marks === 1 && s1.yellow, s1);
  await tapAt(page, 100, 40);
  const s2 = await st(page);
  check('何もない所をタップすると強調を消す（行の印は消え、帯は選ぶ前の案内に戻る）', s2.pick === -1 && s2.marks === 0 && s2.bar === EMPTY_BAR && !s2.yellow, s2);
}

// ---- （段階 2）重なった線の選び分け：同じ所をもう一度タップ・「重なり ▸」で次のレイヤへ（9-2 h、9-3 k・l） ----
{
  const c = await tapAt(page, 335, 0);
  const s1 = await st(page);
  check('（段階 2）ぴったり重なった線では、レイヤの番号の小さい線（OV-A）を選び、帯に「重なり 1/3 ▸」と案内を出す（同じレイヤ B の 2 本は 1 つ）',
    s1.pickLayer === K.ovA && s1.overlap === '1/3' && s1.bar === '選んだ線：OV-A（KASANARI）もう一度タップで次の線重なり 1/3 ▸', { bar: s1.bar, overlap: s1.overlap });
  await page.screenshot({ path: path.join(outDir, 'ls-14-overlap.png') });
  const order = [s1.pickLayer];
  for (let i = 0; i < 3; i++) {
    await page.touchscreen.tap(c.x + (i === 1 ? 5 : 0), c.y + (i === 2 ? -4 : 0));
    await page.waitForTimeout(250);
    order.push((await st(page)).pickLayer);
  }
  check('（段階 2）同じ所（少しずれても）をもう一度タップすると A → B → C → A と回る', JSON.stringify(order) === JSON.stringify([K.ovA, K.ovB, K.ovC, K.ovA]), { order });
  const s2 = await st(page);
  check('（段階 2）回しても、表示・非表示も表示の履歴も変わらず、行は選んだレイヤ', s2.mark === K.ovA && s2.past === s1.past && s2.layers === s1.layers, s2);
  await page.click('#layer-pick .lp-next');
  await page.waitForTimeout(250);
  const s3 = await st(page);
  check('（段階 2）帯の「重なり ▸」を押しても次へ（2/3）', s3.pickLayer === K.ovB && s3.overlap === '2/3' && s3.bar.endsWith('重なり 2/3 ▸'), { bar: s3.bar });
  // 別の所をタップしてから戻ると、最初から
  await page.touchscreen.tap(c.x, c.y - 60);
  await page.waitForTimeout(250);
  await page.touchscreen.tap(c.x, c.y);
  await page.waitForTimeout(250);
  const s4 = await st(page);
  check('（段階 2）別の所をタップしてから戻ると、決め直して 1 番目から', s4.pickLayer === K.ovA && s4.overlap === '1/3', { pick: s4.pickLayer, overlap: s4.overlap });
  // 図面を動かしたら決め直す
  await page.touchscreen.tap(c.x, c.y);
  await page.waitForTimeout(250);
  await page.evaluate(() => { const a = window.__jww; a.view.cx += 0.01; a.requestDraw(true); });
  await page.waitForTimeout(150);
  await page.touchscreen.tap(c.x, c.y);
  await page.waitForTimeout(250);
  const s5 = await st(page);
  check('（段階 2）図面を動かしたら、同じ所でも決め直して 1 番目から', s5.pickLayer === K.ovA && s5.overlap === '1/3', { pick: s5.pickLayer, overlap: s5.overlap });
  // 同じ順番がいつも同じ（何度やっても A・B・C）
  const again = [];
  for (let n = 0; n < 2; n++) {
    await page.touchscreen.tap(c.x, c.y - 60);
    await page.waitForTimeout(200);
    const seq = [];
    for (let i = 0; i < 3; i++) {
      await page.touchscreen.tap(c.x, c.y);
      await page.waitForTimeout(220);
      seq.push((await st(page)).pickLayer);
    }
    again.push(seq.join(','));
  }
  check('（段階 2）同じ所を同じようにタップすれば、毎回同じ順番で回る', again[0] === again[1] && again[0] === [K.ovA, K.ovB, K.ovC].join(','), { again });
  // レイヤを隠すと、そのレイヤは候補から外れる（表示を変えたら決め直す）
  await page.click(`#layer-list .sw[data-layer="${K.ovB}"]`);
  await page.waitForTimeout(300);
  await page.touchscreen.tap(c.x, c.y);
  await page.waitForTimeout(250);
  const h1 = await st(page);
  await page.touchscreen.tap(c.x, c.y);
  await page.waitForTimeout(250);
  const h2 = await st(page);
  check('（段階 2）隠したレイヤ（OV-B）は重なりの候補に入らない（A → C）', h1.pickLayer === K.ovA && h1.overlap === '1/2' && h2.pickLayer === K.ovC, { h1: [h1.pickLayer, h1.overlap], h2: h2.pickLayer });
  await page.click(`#layer-list .sw[data-layer="${K.ovB}"]`);
  await page.waitForTimeout(300);
  // 段の順：線 → 点 → 塗り
  const t = await tapAt(page, 370, 0);
  const tier = [(await st(page)).pickLayer];
  for (let i = 0; i < 2; i++) {
    await page.touchscreen.tap(t.x, t.y);
    await page.waitForTimeout(250);
    tier.push((await st(page)).pickLayer);
  }
  check('（段階 2）候補の順は、指のすぐ近くの線 → 点 → 塗り', JSON.stringify(tier) === JSON.stringify([K.tierLine, K.tierPoint, K.tierSolid]), { tier });
  // 重なりのない線では「重なり」は出さない
  await tapAt(page, 15, 0);
  const s6 = await st(page);
  check('（段階 2）重なりのない線では「重なり」のボタンも案内も出さない', s6.pickLayer === K.tesuri && s6.overlap === '1/1' && !/重なり|もう一度/.test(s6.bar), { bar: s6.bar });
  // 長押しで選んだあと、同じ所のタップで次の重なりへ
  const hc = await showAt(page, 335, 0);
  await holdStill(page, hc);
  const g1 = await st(page);
  await page.touchscreen.tap(hc.x, hc.y);
  await page.waitForTimeout(250);
  const g2 = await st(page);
  check('（段階 2）長押しで選んだ線（A）のあと、同じ所をタップすると次の重なり（B）へ', g1.pickLayer === K.ovA && g2.pickLayer === K.ovB, { g1: g1.pickLayer, g2: g2.pickLayer });
}

// ---- 選んだレイヤを隠すと線の黄色が消え、行の黄色は残る（j）。戻る・進むで選んだ線は変わらない（m） ----
await tapAt(page, 15, 0);
{
  const s0 = await st(page);
  await page.click(`#layer-list .sw[data-layer="${K.tesuri}"]`);
  await page.waitForTimeout(300);
  const s1 = await st(page);
  check('選んだレイヤを隠すと、線の黄色は消え、行の黄色と帯は残る',
    !s1.yellow && s1.pick === ids.tesuri && s1.mark === K.tesuri && s1.bar !== null && s1.past === s0.past + 1, s1);
  await page.screenshot({ path: path.join(outDir, 'ls-3-hidden-layer.png') });
  await page.click(`#layer-list .sw[data-layer="${K.tesuri}"]`);
  await page.waitForTimeout(300);
  const s2 = await st(page);
  check('そのレイヤを表示に戻すと、線の黄色も戻る', s2.yellow && s2.pick === ids.tesuri && s2.mark === K.tesuri, s2);
  await page.click('#btn-layer-list-undo');
  await page.waitForTimeout(300);
  const s3 = await st(page);
  check('表示の戻るをしても、選んだ線と行は変わらない（隠れた分だけ線の黄色は消える）',
    s3.pick === ids.tesuri && s3.mark === K.tesuri && !s3.yellow, s3);
  await page.click('#btn-layer-list-redo');
  await page.waitForTimeout(300);
  const s4 = await st(page);
  check('表示の進むをしても、選んだ線と行は変わらない（見えれば線の黄色も戻る）', s4.pick === ids.tesuri && s4.mark === K.tesuri && s4.yellow, s4);
  // グループごと隠したときも同じ
  await page.click(`#layer-list .sw[data-group="${K.tesuri >> 4}"]`);
  await page.waitForTimeout(300);
  const s5 = await st(page);
  await page.click(`#layer-list .sw[data-group="${K.tesuri >> 4}"]`);
  await page.waitForTimeout(300);
  const s6 = await st(page);
  check('グループごと隠すと線の黄色が消え（行は残る）、戻すと線の黄色も戻る',
    !s5.yellow && s5.mark === K.tesuri && s6.yellow && s6.mark === K.tesuri, { s5: s5.yellow, s6: s6.yellow });
  // 色を隠したときも同じ（「表示」の色の一覧と同じ処理を直に呼ぶ。「表示」を開くと一覧が閉じるため）
  const hideColor = (on) => page.evaluate(([i, on]) => {
    const a = window.__jww;
    const g = a.scene.colorGroup[a.scene.entities.color[i]];
    if (on) a.hiddenGroups.add(g); else a.hiddenGroups.delete(g);
    a.afterVisibilityChange();
  }, [ids.tesuri, on]);
  await hideColor(true);
  await page.waitForTimeout(250);
  const s7 = await st(page);
  await hideColor(false);
  await page.waitForTimeout(250);
  const s8 = await st(page);
  check('線の色を隠すと線の黄色が消え（行は残る）、戻すと線の黄色も戻る',
    !s7.yellow && s7.mark === K.tesuri && s8.yellow && s8.mark === K.tesuri, { s7: s7.yellow, s8: s8.yellow });
}

// ---- 文字・点・塗り・部品・寸法（線と数字は別のレイヤ）を選べる ----
{
  await tapAt(page, 100, 0);
  const t = await st(page);
  check('文字を選べる（文字のレイヤ）', t.pickLayer === K.text && t.pick === ids.text && t.yellow && t.bar === '選んだ線：TEXT（MOJI）', t);
  await page.screenshot({ path: path.join(outDir, 'ls-4-text.png') });
  await tapAt(page, 130, 0);
  const p = await st(page);
  check('点を選べる', p.pickLayer === K.point && p.pick === ids.point && p.yellow, p);
  await tapAt(page, 160, 0);
  const so = await st(page);
  check('塗りの中をタップして塗りを選べる', so.pickLayer === K.solid && so.pick === ids.solid && so.yellow, so);
  await page.screenshot({ path: path.join(outDir, 'ls-5-solid.png') });
  await tapAt(page, 200, 0);
  const b = await st(page);
  check('部品の中の線をタップすると、部品を置いたレイヤを示し、帯に「部品『MADO』の一部」',
    b.pickLayer === K.buhin && b.mark === K.buhin && b.yellow && b.bar === '選んだ線：BUHIN-PLACE（BUHIN）部品『MADO』の一部', b);
  await page.screenshot({ path: path.join(outDir, 'ls-6-buhin.png') });
  await tapAt(page, 234, 0, 8);
  const dl = await st(page);
  await tapAt(page, 245, 2.1, 8);
  const dt = await st(page);
  check('寸法線をタップすると寸法線のレイヤ、寸法の数字をタップすると数字のレイヤを示す',
    dl.pickLayer === K.dimLine && dl.mark === K.dimLine && dt.pickLayer === K.dimText && dt.mark === K.dimText && dl.yellow && dt.yellow,
    { line: [dl.pickLayer, dl.bar], text: [dt.pickLayer, dt.bar] });
  await page.screenshot({ path: path.join(outDir, 'ls-7-dimtext.png') });
}

// ---- 隠したレイヤ・色の線は選べない ----
{
  // 文字のレイヤを隠す（壁のレイヤは隠さない。属性で選んでいる図形を隠すと、今までどおり属性の選択が外れるため）
  await tapAt(page, 100, 40); // 選択を消しておく
  await page.click(`#layer-list .sw[data-layer="${K.text}"]`);
  await page.waitForTimeout(300);
  await tapAt(page, 100, 0);
  const s1 = await st(page);
  await page.click(`#layer-list .sw[data-layer="${K.text}"]`);
  await page.waitForTimeout(300);
  await page.evaluate((i) => {
    const a = window.__jww;
    a.hiddenGroups.add(a.scene.colorGroup[a.scene.entities.color[i]]);
    a.afterVisibilityChange();
  }, ids.grid);
  await tapAt(page, 70, 0);
  const s2 = await st(page);
  await page.evaluate(() => { const a = window.__jww; a.hiddenGroups.clear(); a.afterVisibilityChange(); });
  await page.waitForTimeout(250);
  await tapAt(page, 70, 0);
  const s3 = await st(page);
  check('隠したレイヤの線は選べない', s1.pick === -1, { pick: s1.pick });
  check('隠した色の線は選べない（色を戻せば選べる）', s2.pick === -1 && s3.pick === ids.grid && s3.mark === K.grid, { s2: s2.pick, s3: s3.pick });
}

// ---- 行が一覧の見える所になければ、見える所まで送る。見えていれば送らない ----
{
  await tapAt(page, 280, 0);
  const s1 = await st(page);
  check('いちばん下のグループの線を選ぶと、そのグループが開き、行が見える所まで送られる',
    s1.mark === K.far && s1.groupOpen && s1.rowVisible && s1.scrollTop > 0, { mark: s1.mark, rowVisible: s1.rowVisible, scrollTop: s1.scrollTop });
  await page.screenshot({ path: path.join(outDir, 'ls-8-scrolled.png') });
  await tapAt(page, 15, 0);
  const s2 = await st(page);
  check('上の方のグループの線を選ぶと、上へ送り戻される', s2.mark === K.tesuri && s2.rowVisible && s2.scrollTop < s1.scrollTop, { scrollTop: s2.scrollTop });
  await tapAt(page, 15, 0);
  const s3 = await st(page);
  check('選んだ行がもう見えていれば、一覧は動かさない', s3.mark === K.tesuri && s3.scrollTop === s2.scrollTop, { s2: s2.scrollTop, s3: s3.scrollTop });
}

// ---- 一覧をいちばん小さくしてもモードは続く（9-12 v）。選んでも大きさは変わらず、広げると行を見せる（u・w） ----
{
  const h0 = (await st(page)).panelH;
  const hMin = await resizePanel(page, 'layer-panel', -2000);
  const s1 = await st(page);
  const geo = await page.evaluate(() => {
    const p = document.getElementById('layer-panel').getBoundingClientRect();
    const bar = document.getElementById('layer-pick').getBoundingClientRect();
    const head = document.querySelector('#layer-panel .sheet-head').getBoundingClientRect();
    return { barInside: bar.top >= p.top && bar.bottom <= p.bottom + 0.5, headInside: head.top >= p.top - 0.5 };
  });
  check('一覧をいちばん小さくすると、見出しと帯だけになる（いちばん小さい大きさで止まる）',
    hMin < h0 && hMin >= 100 && hMin <= 150 && geo.barInside && geo.headInside, { h0, hMin, geo });
  check('いちばん小さくしてもモードは続き、選んでいた線は黄色のまま（帯にレイヤ名）',
    s1.open && s1.mode && s1.yellow && s1.pick === ids.tesuri && s1.bar === '選んだ線：TESURI-HANDRAIL（GAIKO-EXTERIOR-WORKS-AND-FENCES）', s1);
  await page.screenshot({ path: path.join(outDir, 'ls-15-min.png') });
  // 小さくしたまま線をタップして選べる。計測の点は置かない。パネルの大きさは変わらない（一覧を勝手に広げない）
  await tapAt(page, 280, 0);
  const s2 = await st(page);
  check('小さくしたまま図面の線を選べて、帯にレイヤ名が出る（計測の点は置かない）',
    s2.mode && s2.pick === ids.far && s2.bar === '選んだ線：FAR-ROW（LAST）' && s2.points === before.points, { bar: s2.bar, points: s2.points });
  check('線を選んでも、一覧の自動の送りでも、パネルの大きさは変わらない', s2.panelH === hMin, { hMin, after: s2.panelH });
  // 一覧の中を指でずらしても大きさは変わらない（送るのは一覧だけ）
  await resizePanel(page, 'layer-panel', 260);
  const sizeBefore = (await st(page)).panelH;
  await page.evaluate(async () => {
    const body = document.querySelector('#layer-panel .sheet-body');
    const r = body.getBoundingClientRect();
    const base = { pointerId: 32, pointerType: 'touch', isPrimary: true, bubbles: true };
    const x = r.left + r.width / 2;
    body.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x, clientY: r.bottom - 20 }));
    for (let i = 1; i <= 8; i++) {
      body.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x, clientY: r.bottom - 20 - i * 15 }));
      await new Promise((res) => setTimeout(res, 16));
    }
    body.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: x, clientY: r.bottom - 140 }));
    body.scrollTop = 0;
    body.scrollTop = 120;
    await new Promise((res) => setTimeout(res, 200));
  });
  const s3 = await st(page);
  check('一覧の中を指でずらしたり送ったりしても、パネルの大きさは変わらない', s3.panelH === sizeBefore, { sizeBefore, after: s3.panelH });
  // 小さくしてから選び直し、広げると、選んだ行を見える所へ送る
  await resizePanel(page, 'layer-panel', -2000);
  await tapAt(page, 15, 0);
  const s4 = await st(page);
  await resizePanel(page, 'layer-panel', 330);
  const s5 = await st(page);
  check('小さくしたまま選んだ線の行は、一覧を広げると黄色で見える所にある', s4.pick === ids.tesuri && s5.mark === K.tesuri && s5.rowVisible && s5.panelH > s4.panelH, { s4: s4.panelH, s5: s5.panelH, rowVisible: s5.rowVisible });
  await page.screenshot({ path: path.join(outDir, 'ls-16-reopen.png') });
  // 指を離した所で止まる（決まった位置に吸い付かない）。途中の大きさでも止まる
  const odd = await resizePanel(page, 'layer-panel', -37);
  check('指を離した所で止まる（決まった位置に吸い付けない）', odd === s5.panelH - 37, { before: s5.panelH, after: odd });
  // 見出しを押しただけでは大きさは変わらない（2 段の切り替えはしない）
  const headTap = await page.evaluate(() => {
    const b = document.querySelector('#layer-panel .sheet-head strong').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.touchscreen.tap(headTap.x, headTap.y);
  await page.waitForTimeout(300);
  const s6 = await st(page);
  check('見出しを押しただけでは、大きさは変わらない', s6.panelH === odd && s6.mode, { odd, after: s6.panelH });
}

// ---- 閉じると強調を消して直前の操作（計測）に戻る。点・記録・属性の選択は残る ----
{
  await page.click('#btn-layer-close');
  await page.waitForTimeout(300);
  const s = await st(page);
  check('「閉じる」で強調を消し、計測に戻る', !s.open && !s.mode && s.pick === -1 && !s.yellow && s.tool === 'measure', s);
  check('閉じたあとも、計測の点・記録・属性の選択・累進の起点は残る',
    s.points === before.points && s.records === before.records && s.selected === before.selected && s.origins === before.origins, s);
  await tapAt(page, 50, 10);
  const s2 = await st(page);
  check('閉じたあとのタップは、また計測の点を置く', JSON.parse(s2.points).length === JSON.parse(before.points).length + 1, { points: s2.points });
  await page.waitForTimeout(500);
  await page.click('#btn-undo');
  await page.waitForTimeout(300);
}

// ---- 属性の途中で一覧を開く：タップで属性の選択は変わらない（9-2 i ②）。緑の強調はモードのあいだ休む ----
{
  await page.click('#btn-tool-inspect');
  await page.waitForTimeout(300);
  const s0 = await st(page);
  await page.click('#btn-layers');
  await page.waitForTimeout(300);
  const s1 = await st(page);
  await tapAt(page, 15, 0);
  const s2 = await st(page);
  check('属性の途中で一覧を開くと、属性で選んでいた線を黄色で示す（緑の強調はモードのあいだ出さない）',
    s0.green && s1.mode && s1.pick === ids.wall && s1.yellow && !s1.green, { s0: s0.green, s1 });
  check('属性の途中でも、モードのあいだのタップは属性の選択を変えない（属性の表示もそのまま）',
    s2.pick === ids.tesuri && s2.selected === ids.wall && s2.inspect === s0.inspect, { pick: s2.pick, selected: s2.selected });
  await page.screenshot({ path: path.join(outDir, 'ls-9-inspect.png') });
  await page.click('#btn-layer-close');
  await page.waitForTimeout(300);
  const s3 = await st(page);
  check('閉じると属性に戻り、属性で選んでいた線（壁）の緑の強調も戻る', s3.tool === 'inspect' && s3.selected === ids.wall && s3.green && !s3.yellow, s3);
  await page.click('#btn-tool-measure');
  await page.waitForTimeout(300);
}

// ---- 黒背景・白背景のどちらでも、黄色の強調がはっきり見える（o） ----
for (const bg of ['dark', 'light']) {
  await page.click('#btn-display');
  await page.click(`#seg-bg button[data-value="${bg}"]`);
  await page.click('#btn-display-close');
  await page.click('#btn-layers');
  await page.waitForTimeout(300);
  // 通り芯（縦線）を選び、その途中を横切って色を見る（計測の線が重ならない所）
  const c = await tapAt(page, 70, 8, 6);
  const colors = await crossColors(page, c.x, c.y);
  const bgColor = colors.bgUp;
  const centerC = contrast(colors.center, bgColor);
  const edgeC = Math.max(contrast(colors.edgeUp, bgColor), contrast(colors.edgeDown, bgColor));
  const best = Math.max(centerC, edgeC);
  check(`${bg === 'dark' ? '黒' : '白'}背景：線の真ん中は黄色で、黄色か黒い縁取りが背景とはっきり違う（コントラスト比 4.5 以上）`,
    isYellow(colors.center) && best >= 4.5,
    { colors, centerContrast: +centerC.toFixed(2), edgeContrast: +edgeC.toFixed(2) });
  await page.screenshot({ path: path.join(outDir, `ls-10-${bg}.png`) });
  await page.click('#btn-layer-close');
  await page.waitForTimeout(200);
}
await page.click('#btn-display');
await page.click('#seg-bg button[data-value="dark"]');
await page.click('#btn-display-close');
await page.waitForTimeout(200);

// =====================================================================
// 2. 累進表示中：累進で隠している元の寸法の数字は拾わない。起点・選んだ列は変わらない
// =====================================================================
{
  const rp = await newPage(phone(393, 852));
  await openPath(rp, ruishinSample);
  await rp.click('#btn-tool-ruishin');
  await rp.click('#btn-ruishin-on');
  await rp.waitForTimeout(300);
  // 下の列（寸法線 y = -13）を選んでおく
  const bottom = await rp.evaluate(() => window.__jww.chains.filter((c) => c.uy === 0).sort((p, q) => p.offset - q.offset)[0]);
  const target = await rp.evaluate((id) => {
    const a = window.__jww;
    const c = a.chains.find((x) => x.id === id);
    const s = c.spans.find((x) => x.text >= 0);
    const t = a.scene.texts[s.text];
    return { ti: s.text, entity: t.entity, x: t.x + t.width / 2, y: t.y + t.height / 2 };
  }, bottom.id);
  {
    const c = await showAt(rp, target.x, bottom.offset, 7);
    await rp.touchscreen.tap(c.x, c.y - 4);
    await rp.waitForTimeout(300);
  }
  await rp.click('#btn-tool-measure');
  await rp.waitForTimeout(300);
  const r0 = await st(rp);
  check('準備：累進で列を選び、累進を表示したまま計測にいる（元の数字は隠れている）',
    r0.tool === 'measure' && r0.active === bottom.id && (await rp.evaluate((ti) => window.__jww.ruishinHiddenTexts.has(ti), target.ti)), { active: r0.active });
  await rp.click('#btn-layers');
  await rp.waitForTimeout(300);
  await tapAt(rp, target.x, target.y, 7);
  const r1 = await st(rp);
  check('累進表示中は、隠している元の寸法の数字を拾わず、下の寸法線を選ぶ',
    r1.pick >= 0 && r1.pick !== target.entity && r1.mode, { pick: r1.pick, kind: r1.pickKind, textEntity: target.entity });
  // 起点の丸をタップしても、起点も選んだ列も変わらない
  const origin = await rp.evaluate((id) => window.__jww.origins.get(id), bottom.id);
  await tapAt(rp, origin.x, origin.y, 7);
  const r2 = await st(rp);
  check('モードのあいだは、起点の丸をタップしても起点・選んだ列は変わらない', r2.origins === r0.origins && r2.active === r0.active && r2.points === r0.points, r2);
  await rp.screenshot({ path: path.join(outDir, 'ls-11-ruishin.png') });
  // 累進の道具でも同じ（列を選ばない）
  await rp.click('#btn-layer-close');
  await rp.click('#btn-tool-ruishin');
  await rp.waitForTimeout(300);
  await rp.click('#btn-layers');
  await rp.waitForTimeout(300);
  await tapAt(rp, 30, 30, 7);
  const r3 = await st(rp);
  check('累進の途中でも、モードのあいだのタップは列を選び直さない', r3.active === r0.active && r3.origins === r0.origins, { active: r3.active });
  await rp.click('#btn-layer-close');
  await rp.waitForTimeout(300);
  const r4 = await st(rp);
  check('閉じると累進に戻り、起点・選んだ列は残る', r4.tool === 'ruishin' && r4.active === r0.active && r4.origins === r0.origins && !r4.mode, r4);
  // 属性（元の寸法で見せる）のときは、同じ所で元の寸法の数字を選ぶ
  await rp.click('#btn-tool-inspect');
  await rp.waitForTimeout(300);
  await rp.click('#btn-layers');
  await rp.waitForTimeout(300);
  await tapAt(rp, target.x, target.y, 7);
  const r5 = await st(rp);
  check('属性のあいだ（元の寸法で見せる）は、同じ所で元の寸法の数字を選ぶ', r5.pick === target.entity, { pick: r5.pick, textEntity: target.entity });
  await rp.context().close();
}

// =====================================================================
// 3. DXF（レイヤ名だけの 1 段の一覧）と、名前の絞り込み
// =====================================================================
{
  const dp = await newPage(phone(393, 852));
  await openFile(dp, 'layers.dxf', Buffer.from(dxfText, 'latin1'));
  await dp.click('#btn-layers');
  await dp.waitForTimeout(300);
  await tapAt(dp, 60, 10);
  const d1 = await st(dp);
  const name1 = await dp.evaluate((k) => document.querySelector(`#layer-list .l-row[data-k="${k}"] .lname`)?.textContent, d1.pickLayer);
  check('DXF でも線を選ぶと行が黄色になり、帯にレイヤ名だけを出す',
    d1.pick >= 0 && d1.mark === d1.pickLayer && name1 === 'L07' && d1.bar === '選んだ線：L07' && d1.rowVisible && d1.yellow, { ...d1, name1 });
  await dp.fill('#layer-list .layer-filter', 'L2');
  await dp.waitForTimeout(250);
  const d2 = await st(dp);
  check('絞り込みで選んだ行が隠れると、帯に「絞り込みで隠れています」と出す（絞り込みは消さない）',
    d2.bar === '選んだ線：L07絞り込みで隠れています' && (await dp.inputValue('#layer-list .layer-filter')) === 'L2', { bar: d2.bar });
  await dp.screenshot({ path: path.join(outDir, 'ls-12-dxf-filter.png') });
  await tapAt(dp, 240, 10);
  const d3 = await st(dp);
  check('絞り込みに合う行の線を選ぶと、帯の添え書きは消える', d3.bar === '選んだ線：L25' && d3.rowVisible, { bar: d3.bar });
  await dp.fill('#layer-list .layer-filter', '');
  await dp.context().close();
}

// =====================================================================
// 4. 画面の形ごと：帯と行が崩れない。パネルの大きさを変えられ、いちばん小さく・大きくしても画面に収まる。
//    道具を押すと一覧を閉じてその道具になる（ツールバーはどの画面でも見えている）
// =====================================================================
const shapes = [
  ['iPhone SE（初代）縦 320×568', phone(320, 568, 2), 'se1'],
  ['iPhone SE（第2・3世代）縦 375×667', phone(375, 667, 2), 'se2'],
  ['大きい iPhone 縦 430×932', phone(430, 932), 'large'],
  ['iPhone 横 852×393', phone(852, 393), 'land'],
  ['大きい iPhone 横 932×430', phone(932, 430), 'large-land'],
  ['iPhone SE（初代）横 568×320', phone(568, 320, 2), 'se1-land'],
  ['iPad 縦 820×1180', phone(820, 1180, 2), 'ipad'],
  ['iPad 横 1180×820', phone(1180, 820, 2), 'ipad-land'],
];
for (const [label, opts, key] of shapes) {
  const p = await newPage(opts);
  await openFile(p, 'layer-select.jww', jwwBytes);
  await p.click('#btn-layers');
  await p.waitForTimeout(300);
  const c = await tapAt(p, 15, 0);
  const s = await st(p);
  const box = await p.evaluate(() => {
    const panel = document.getElementById('layer-panel').getBoundingClientRect();
    const bar = document.getElementById('layer-pick');
    const b = bar.getBoundingClientRect();
    const layer = bar.querySelector('.lp-layer');
    const group = bar.querySelector('.lp-group');
    const row = document.querySelector('#layer-list .l-row.mark');
    const r = row?.getBoundingClientRect();
    const lname = row?.querySelector('.lname');
    // 幅の制限なしで並べたときの幅（「…」で省いていなければ、見えている幅はこれと同じ）
    const natural = (e) => {
      const c = e.cloneNode(true);
      c.style.cssText = 'position:absolute;visibility:hidden;max-width:none;overflow:visible;white-space:nowrap';
      e.parentElement.appendChild(c);
      const w = c.getBoundingClientRect().width;
      c.remove();
      return w;
    };
    return {
      panel: [panel.left, panel.right], bar: [b.left, b.right, b.top, b.bottom], barFits: bar.scrollWidth <= bar.clientWidth + 1,
      layerWhole: layer.getBoundingClientRect().width >= natural(layer) - 0.5, groupCut: group.getBoundingClientRect().width < natural(group) - 0.5,
      groupShown: group.clientWidth > 0,
      row: r ? [r.left, r.right] : null, lnameWidth: lname?.clientWidth ?? 0,
    };
  });
  const inside = box.bar[0] >= box.panel[0] - 0.5 && box.bar[1] <= box.panel[1] + 0.5
    && box.row && box.row[0] >= box.panel[0] - 0.5 && box.row[1] <= box.panel[1] + 0.5;
  check(`${label}：線を選べて、帯と行が一覧の中に収まる（帯ははみ出さず、レイヤ名は省かない）`,
    c.x > 0 && s.pick === ids.tesuri && s.rowVisible && inside && box.barFits && box.layerWhole && box.lnameWidth > 20, { box, rowVisible: s.rowVisible });
  if (key === 'se1') check(`${label}：入りきらないグループ名は「…」で省く`, box.groupCut, box);
  await p.screenshot({ path: path.join(outDir, `ls-13-${key}.png`) });
  // パネルはツールバーにかからず（ツールバーは見えている）、画面に収まる
  const b0 = await panelBox(p, 'layer-panel');
  check(`${label}：一覧はツールバーにかからず画面に収まる（ツールバーは見えている）`, b0.inScreen && b0.clearOfToolbar && b0.toolbarShown, b0);
  // いちばん小さく：モードは続き、帯は収まる。いちばん大きく：図面が残り、画面に収まる
  await resizePanel(p, 'layer-panel', -3000);
  const bMin = await panelBox(p, 'layer-panel');
  const sMin = await st(p);
  const barIn = await p.evaluate(() => {
    const pr = document.getElementById('layer-panel').getBoundingClientRect();
    const br = document.getElementById('layer-pick').getBoundingClientRect();
    const head = document.querySelector('#layer-panel .sheet-head');
    return br.bottom <= pr.bottom + 0.5 && br.right <= pr.right + 0.5 && head.scrollWidth <= head.clientWidth + 1
      && head.getBoundingClientRect().height < 70;
  });
  check(`${label}：いちばん小さくしても、モードは続き、見出しと帯が崩れず収まる`,
    bMin.size < b0.size && bMin.inScreen && sMin.mode && sMin.pick === ids.tesuri && barIn, { b0: b0.size, bMin, barIn });
  await p.screenshot({ path: path.join(outDir, `ls-17-${key}-min.png`) });
  await resizePanel(p, 'layer-panel', 3000);
  const bMax = await panelBox(p, 'layer-panel');
  const room = await p.evaluate((side) => {
    const a = window.__jww;
    const pr = document.getElementById('layer-panel').getBoundingClientRect();
    const top = document.getElementById('topbar').getBoundingClientRect();
    return side ? pr.left - Math.max(a.measureInsets().left, a.safeLeft) : pr.top - top.bottom;
  }, bMax.side);
  check(`${label}：いちばん大きくしても画面に収まり、図面が残る（縦は 96px 以上、横は 150px 以上）`,
    bMax.size > b0.size - 1 && bMax.inScreen && bMax.clearOfToolbar && room >= (bMax.side ? 150 : 96), { bMax, room });
  await p.screenshot({ path: path.join(outDir, `ls-17-${key}-max.png`) });
  {
    // 「レイヤ」をもう一度押して閉じても、強調を消して計測に戻る。開き直すと、選び直すまで何も選んでいない
    let again = true;
    try {
      await p.click('#btn-layers', { timeout: 3000 });
    } catch {
      again = false;
    }
    await p.waitForTimeout(300);
    const r = await st(p);
    check(`${label}：「レイヤ」をもう一度押して閉じても、強調を消して計測に戻る`, again && !r.open && r.pick === -1 && r.tool === 'measure', { again, open: r.open, pick: r.pick });
    await p.click('#btn-layers');
    await p.waitForTimeout(300);
    await tapAt(p, 15, 0);
    // ツールバーが見えている画面では、一覧を開いたまま道具を押すと、一覧を閉じてその道具になる
    let clicked = true;
    try {
      await p.click('#btn-tool-inspect', { timeout: 3000 });
    } catch {
      clicked = false;
    }
    await p.waitForTimeout(300);
    const t = await st(p);
    check(`${label}：一覧を開いたまま「属性」を押すと、一覧を閉じて属性になる`, clicked && !t.open && !t.mode && t.pick === -1 && t.tool === 'inspect', { clicked, open: t.open, tool: t.tool });
  }
  await p.context().close();
}

// =====================================================================
// 5. パネルの大きさを覚える（レイヤと表示で別々、縦と横で別々）。回しても画面に収まる。表示のパネルも同じ操作（9-12 p・y・z）
// =====================================================================
{
  const p = await newPage(phone(393, 852));
  await openFile(p, 'layer-select.jww', jwwBytes);
  await p.click('#btn-layers');
  await p.waitForTimeout(300);
  const first = await panelBox(p, 'layer-panel');
  check('大きさを変える前は、覚えた大きさは無い（初めの大きさで出る）', first.stored === null, first);
  const hL = await resizePanel(p, 'layer-panel', -123);
  await p.click('#btn-layer-close');
  await p.waitForTimeout(200);
  // 表示のパネルも、見出しをずらして高さを変えられる（レイヤと同じ操作）
  await p.click('#btn-display');
  await p.waitForTimeout(300);
  const d0 = await panelBox(p, 'display-panel');
  const dMin = await resizePanel(p, 'display-panel', -3000);
  const dHead = await p.evaluate(() => {
    const pr = document.getElementById('display-panel').getBoundingClientRect();
    const h = document.querySelector('#display-panel .sheet-head').getBoundingClientRect();
    return { panel: pr.height, headBottom: h.bottom - pr.top };
  });
  check('表示のパネルも見出しを下へずらすと縮み、いちばん小さいと見出しだけになる', dMin < d0.size && Math.abs(dHead.panel - dHead.headBottom) <= 2, { d0: d0.size, dMin, dHead });
  await p.screenshot({ path: path.join(outDir, 'ls-18-display-min.png') });
  const hD = await resizePanel(p, 'display-panel', 180);
  check('表示のパネルを上へずらすと広がり、離した所で止まる', hD === dMin + 180, { dMin, hD });
  await p.click('#btn-display-close');
  await p.waitForTimeout(200);
  await p.click('#btn-layers');
  await p.waitForTimeout(300);
  const l2 = await panelBox(p, 'layer-panel');
  check('レイヤの一覧を開き直すと、前に変えた大きさで出る（表示の大きさとは別）', l2.size === hL && l2.stored?.layer?.h === hL && l2.stored?.display?.h === hD, l2);
  // 表示の「閉じる」以外：レイヤを開くと表示は閉じる（同時に 1 つ）
  // アプリを開き直しても同じ大きさ
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
  await p.waitForTimeout(800);
  await p.click('#btn-layers');
  await p.waitForTimeout(300);
  const l3 = await panelBox(p, 'layer-panel');
  await p.click('#btn-layer-close');
  await p.click('#btn-display');
  await p.waitForTimeout(300);
  const d3 = await panelBox(p, 'display-panel');
  check('アプリを開き直しても、レイヤ・表示それぞれ前に変えた大きさで出る', l3.size === hL && d3.size === hD, { l3: l3.size, d3: d3.size, hL, hD });
  await p.click('#btn-display-close');
  // 横にすると、横の幅（初めは今までの幅）で出し、幅を変えられる。縦に戻すと縦の大きさに戻る
  await p.click('#btn-layers');
  await p.waitForTimeout(300);
  await p.setViewportSize({ width: 852, height: 393 });
  await p.waitForTimeout(500);
  const w0 = await panelBox(p, 'layer-panel');
  check('横にすると、一覧は右に縦長で、今までの幅で出る（画面に収まる）', w0.side && w0.size === 340 && w0.inScreen && w0.clearOfToolbar, w0);
  const w1 = await resizePanel(p, 'layer-panel', 90);
  const w2 = await resizePanel(p, 'layer-panel', -40, 'head');
  check('横の iPhone では、左の縁のつまみ（と見出し）を左右にずらして幅を変える', w1 === 430 && w2 === 390, { w1, w2 });
  const sl = await st(p);
  check('横で幅を変えても、レイヤ選択モードは続く', sl.mode, sl);
  await p.setViewportSize({ width: 393, height: 852 });
  await p.waitForTimeout(500);
  const back = await panelBox(p, 'layer-panel');
  check('縦に戻すと、縦で変えた高さに戻る（横の幅は別に覚える）', !back.side && back.size === hL && back.stored?.layer?.w === 390 && back.inScreen, back);
  // 大きくしたあと、狭い画面（SE）に回しても画面に収まる。覚えた大きさは変えない
  const big = await resizePanel(p, 'layer-panel', 3000);
  await p.setViewportSize({ width: 320, height: 568 });
  await p.waitForTimeout(500);
  const se = await panelBox(p, 'layer-panel');
  const seRoom = await p.evaluate(() => document.getElementById('layer-panel').getBoundingClientRect().top - document.getElementById('topbar').getBoundingClientRect().bottom);
  check('大きくしたまま小さい画面にすると、画面に収まる大きさに縮めて出す（図面も残る）', se.size < big && se.inScreen && se.clearOfToolbar && seRoom >= 96, { big, se, seRoom });
  await p.setViewportSize({ width: 393, height: 852 });
  await p.waitForTimeout(500);
  const back2 = await panelBox(p, 'layer-panel');
  check('元の画面に戻すと、覚えた大きさで出る', back2.size === big, { big, back2: back2.size });
  // iPad：縦・横とも下の中央で、高さを変えられる
  await p.setViewportSize({ width: 820, height: 1180 });
  await p.waitForTimeout(500);
  const ip = await panelBox(p, 'layer-panel');
  const ip2 = await resizePanel(p, 'layer-panel', -100);
  await p.setViewportSize({ width: 1180, height: 820 });
  await p.waitForTimeout(500);
  const ipl = await panelBox(p, 'layer-panel');
  check('iPad では縦・横とも、下の中央でツールバーの上に出し、高さを変えられる（回しても収まる）',
    !ip.side && ip.inScreen && ip.clearOfToolbar && ip2 === ip.size - 100 && !ipl.side && ipl.inScreen && ipl.clearOfToolbar, { ip, ip2, ipl });
  // 覚えた大きさが読めない（壊れている）ときも、初めの大きさで出る
  await p.evaluate(() => localStorage.setItem('jww-viewer:panel-size', '{"layer":{"h":"abc"},"display":7}'));
  await p.setViewportSize({ width: 393, height: 852 });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
  await p.waitForTimeout(800);
  await p.click('#btn-layers');
  await p.waitForTimeout(300);
  const broken = await panelBox(p, 'layer-panel');
  check('覚えた大きさが壊れていても、初めの大きさで出る（画面は壊れない）', broken.inScreen && broken.size === first.size, { broken: broken.size, first: first.size });
  await p.context().close();
}

check('画面にエラーが出ていない', errors.length === 0, { errors: errors.slice(0, 5) });

await browser.close();
await srv.close();
const failed = report();
process.exit(failed ? 1 : 0);
