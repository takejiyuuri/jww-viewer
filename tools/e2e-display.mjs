// 背景の白黒・単色表示・色ごとの表示非表示を、画面のピクセルで確かめる。
import { chromium, devices } from 'playwright';
import path from 'node:path';
import { startServer, projectRoot as root } from './serve.mjs';

const srv = await startServer({ port: 5307, host: false, quiet: true });
const sample = process.argv[2] ?? path.join(root, 'samples', 'A棟 11階躯体図2026.5.12提出スリーブ.jww');
const outDir = process.argv[3] ?? '.';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ ...devices['iPhone 14 Pro'], hasTouch: true });
const page = await context.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const results = [];
const check = (name, ok, info) => results.push({ name, ok, ...(info ?? {}) });

const openDrawing = async () => {
  await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
  await page.waitForTimeout(500);
};

await page.goto(srv.url, { waitUntil: 'networkidle' });
await page.setInputFiles('#file', sample);
await openDrawing();

/** 描き直した直後の GL 画面から、色ごとのピクセル数を数える */
const glPixels = () => page.evaluate(() => {
  const a = window.__jww;
  a.renderer.draw(a.view, a.dpr);
  const c = document.getElementById('gl');
  const g = c.getContext('webgl2');
  const px = new Uint8Array(c.width * c.height * 4);
  g.readPixels(0, 0, c.width, c.height, g.RGBA, g.UNSIGNED_BYTE, px);
  const counts = new Map();
  for (let i = 0; i < px.length; i += 4) {
    const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  // 多い順に上位だけ返す
  const top = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12)
    .map(([k, n]) => ({ rgb: [(k >> 16) & 255, (k >> 8) & 255, k & 255], n }));
  return { total: px.length / 4, distinct: counts.size, top, counts: Object.fromEntries(counts) };
});

const countOf = (px, rgb) => px.counts[(rgb[0] << 16) | (rgb[1] << 8) | rgb[2]] ?? 0;

/** 文字レイヤで、指定の色に近いピクセルの数 */
const textPixels = (rgb) => page.evaluate((c0) => {
  const c = document.getElementById('text');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  let any = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    any++;
    if (Math.abs(d[i] - c0[0]) + Math.abs(d[i + 1] - c0[1]) + Math.abs(d[i + 2] - c0[2]) < 30) n++;
  }
  return { n, any };
}, rgb);

// ---------- 1. 表示シート ----------
await page.click('#btn-display');
await page.waitForTimeout(200);
const sheet = await page.evaluate(() => ({
  open: !document.getElementById('display-panel').classList.contains('hidden'),
  rows: document.querySelectorAll('#color-list .color-row').length,
  groups: window.__jww.scene.groups.length,
  labels: [...document.querySelectorAll('#color-list .color-name')].map((n) => n.textContent),
}));
check('表示シートが開く', sheet.open);
check('図面で使われている色が並ぶ', sheet.rows === sheet.groups && sheet.rows > 0, {
  行: sheet.rows, 色: sheet.groups, 例: sheet.labels.slice(0, 6).join('・'),
});
await page.screenshot({ path: path.join(outDir, 'e2e-display-sheet.png') });

// ---------- 2. 黒背景 → 白背景 ----------
const darkPx = await glPixels();
await page.click('#seg-bg button[data-value="light"]');
await page.waitForTimeout(200);
const lightPx = await glPixels();
const state2 = await page.evaluate(() => ({
  bg: document.body.dataset.bg,
  on: document.querySelector('#seg-bg button.on')?.dataset.value,
}));
check('白背景にすると画面の地が白になる', lightPx.top[0].rgb.join() === '255,255,255', {
  前の地: darkPx.top[0].rgb.join(), 後の地: lightPx.top[0].rgb.join(),
});
check('白背景の状態が画面に反映される', state2.bg === 'light' && state2.on === 'light', state2);
// 黒背景での白い線（線色2）は、白背景では黒くなるはず
check('白い線は白背景で黒く描かれる', countOf(lightPx, [0, 0, 0]) > 1000, {
  黒の画素: countOf(lightPx, [0, 0, 0]),
});
// 白背景に白い線が残っていないか（背景以外の純白がない）
check('白背景に白の線が残らない', darkPx.distinct > 50 && lightPx.distinct > 50, {
  色数_黒背景: darkPx.distinct, 色数_白背景: lightPx.distinct,
});

// ---------- 3. 単色 ----------
await page.click('#seg-mono button[data-value="mono"]');
await page.waitForTimeout(200);
const monoPx = await glPixels();
// 単色なら、地と線色（と両者の中間のにじみ）だけになる。色相のある画素がほぼ消える
const chromatic = Object.entries(monoPx.counts).reduce((sum, [k, n]) => {
  const v = Number(k);
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  return Math.max(r, g, b) - Math.min(r, g, b) > 24 ? sum + n : sum;
}, 0);
check('単色にすると色のついた線がなくなる', chromatic < monoPx.total * 0.002, {
  色のある画素: chromatic, 全画素: monoPx.total,
});
await page.click('#seg-mono button[data-value="color"]');
await page.waitForTimeout(150);

// ---------- 4. 色ごとに隠す ----------
// 白背景で一番多く描かれている線色を選び、それを隠すとその色の画素が消えるかを見る
const target = await page.evaluate(() => {
  const a = window.__jww;
  const s = a.scene;
  // 線分の本数が一番多い色グループ
  const tally = new Map();
  for (let i = 0; i < s.lineColor.length; i++) {
    const g = s.colorGroup[s.lineColor[i]];
    tally.set(g, (tally.get(g) ?? 0) + 1);
  }
  const [group] = [...tally.entries()].sort((x, y) => y[1] - x[1])[0];
  // その色の、いまの表示色
  const entry = s.colorGroup.indexOf(group);
  const p = a.renderer.palette;
  return { group, label: s.groups[group].label, rgb: [p[entry * 4], p[entry * 4 + 1], p[entry * 4 + 2]] };
});
const before4 = await glPixels();
const textBefore = await textPixels(target.rgb);
await page.click(`#color-list .color-row[data-group="${target.group}"]`);
await page.waitForTimeout(250);
const after4 = await glPixels();
const textAfter = await textPixels(target.rgb);
const rowOff = await page.evaluate((g) => {
  const row = document.querySelector(`#color-list .color-row[data-group="${g}"]`);
  return { off: row.classList.contains('off'), pressed: row.getAttribute('aria-pressed') };
}, target.group);

check('隠した色の線が画面から消える', countOf(before4, target.rgb) > 200 && countOf(after4, target.rgb) < countOf(before4, target.rgb) * 0.02, {
  色: target.label, 表示色: target.rgb.join(), 前: countOf(before4, target.rgb), 後: countOf(after4, target.rgb),
});
check('隠した色の文字も消える', textBefore.n === 0 || textAfter.n < textBefore.n * 0.05, {
  前: textBefore.n, 後: textAfter.n,
});
check('隠した行はスイッチが切れて見える', rowOff.off && rowOff.pressed === 'false', rowOff);

// ---------- 5. すべて隠す → 何も吸着しない / すべて表示で戻る ----------
await page.click('#btn-color-none');
await page.waitForTimeout(250);
const nonePx = await glPixels();
const snapNone = await page.evaluate(() => {
  const a = window.__jww;
  let free = 0;
  let total = 0;
  for (let i = 0; i < 40; i++) {
    const k = Math.floor((i / 40) * (a.scene.linePos.length / 4)) * 4;
    const r = a.snapIndex.query(a.scene.linePos[k], a.scene.linePos[k + 1], 5);
    total++;
    if (r.kind === 'free') free++;
  }
  return { free, total };
});
check('すべて隠すと画面が地の色だけになる', nonePx.top[0].n > nonePx.total * 0.995, {
  地の割合: (nonePx.top[0].n / nonePx.total).toFixed(4),
});
check('隠した線には吸着しない', snapNone.free === snapNone.total, snapNone);

await page.click('#btn-color-all');
await page.waitForTimeout(250);
const allPx = await glPixels();
check('すべて表示で元に戻る', Math.abs(allPx.distinct - before4.distinct) < before4.distinct * 0.1, {
  前: before4.distinct, 後: allPx.distinct,
});

// ---------- 6. 設定が残るか ----------
// ひとつ隠した状態で再読み込みする。背景は端末の設定として、隠した色は同じ図面なら戻る
await page.click(`#color-list .color-row[data-group="${target.group}"]`);
await page.waitForTimeout(150);
await page.click('#btn-display-close');
await page.screenshot({ path: path.join(outDir, 'e2e-display-light.png') });

await page.reload({ waitUntil: 'networkidle' });
await openDrawing();
const restored = await page.evaluate((g) => ({
  bg: document.body.dataset.bg,
  hidden: [...window.__jww.hiddenGroups],
  label: window.__jww.scene.groups[g]?.label,
}), target.group);
check('再読み込み後も白背景のまま', restored.bg === 'light', { bg: restored.bg });
check('同じ図面なら隠した色が戻る', restored.hidden.length === 1, restored);

// 後片付け（次の検証に響かないよう既定に戻す）
await page.evaluate(() => localStorage.clear());

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length, errors: errors.slice(0, 5) }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length ? 1 : 0);
