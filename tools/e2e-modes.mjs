// 計測の色と、距離・面積・体積の切り替えを画面で確かめる。
import { chromium, devices } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { startServer, projectRoot as root } from './serve.mjs';

const srv = await startServer({ port: 5312, host: false, quiet: true });
const sample = process.argv[2] || path.join(root, 'samples', fs.readdirSync(path.join(root, 'samples')).find((f) => f.endsWith('.jww')));
const outDir = process.argv[3] || '.';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const errors = [];
const results = [];
const check = (name, ok, info) => results.push({ name, ok, ...(info ?? {}) });

const open = async (opts) => {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(srv.url, { waitUntil: 'networkidle' });
  await page.setInputFiles('#file', sample);
  await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
  await page.waitForTimeout(600);
  return { ctx, page };
};

// ---------- 1. 狭い画面から横向きまで、操作の段が 1 行に収まる ----------
for (const [name, opts] of [
  ['縦 393', { ...devices['iPhone 14 Pro'], hasTouch: true }],
  ['縦 375', { viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ['縦 320', { viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ['横 667', { viewport: { width: 667, height: 375 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ['横 568', { viewport: { width: 568, height: 320 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
]) {
  const { ctx, page } = await open(opts);
  const bar = await page.evaluate(() => {
    const panel = document.getElementById('readout').getBoundingClientRect();
    const ids = ['btn-scale', 'btn-ortho', 'btn-color', 'seg-mode'];
    const rects = ids.map((id) => document.getElementById(id).getBoundingClientRect());
    const mids = rects.map((r) => r.top + r.height / 2);
    const segs = [...document.querySelectorAll('#seg-mode button')];
    return {
      oneRow: Math.max(...mids) - Math.min(...mids) < 2,
      inside: rects.every((r) => r.left >= panel.left - 0.5 && r.right <= panel.right + 0.5),
      ordered: rects.every((r, i) => i === 0 || r.left >= rects[i - 1].right - 0.5),
      overflow: segs.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent),
      // 文字が 2 行に折り返すと背が伸びる
      tall: segs.filter((b) => b.getBoundingClientRect().height > 36).map((b) => b.textContent),
      panelH: Math.round(panel.height),
      segWidth: Math.round(rects[3].width),
    };
  });
  check(`${name}：縮尺・直交・色・距離／面積／体積が 1 行に並び、折り返さず、パネルからはみ出さない`,
    bar.oneRow && bar.inside && bar.ordered && bar.overflow.length === 0 && bar.tall.length === 0 && bar.panelH < 70 && bar.segWidth >= 96, bar);
  // 大きな体積（1/100 の図で 514 m² × 3 m）でも、値と内訳（底面と高さ）が切れない
  const fits = await page.evaluate(() => {
    const a = window.__jww;
    a.setMeasurePrefs({ ...a.measurePrefs, mode: 'volume', height: 3000 });
    const c = a.toWorld(a.cssW / 2, a.cssH * 0.4);
    a.points = [[0, 0], [227, 0], [227, 226.6], [0, 226.6]].map(([x, y]) => ({ x: c.x + x, y: c.y + y, glayer: 0, kind: 'endpoint', scale: 100 }));
    a.manualScale = false;
    a.updateReadout();
    const v = document.getElementById('readout-value');
    const d = document.getElementById('readout-detail');
    const out = {
      value: v.textContent, detail: d.innerText,
      valueCut: v.scrollWidth > v.clientWidth + 1,
      detailCut: d.scrollHeight > d.clientHeight + 1,
    };
    a.points = [];
    a.setMeasurePrefs({ ...a.measurePrefs, mode: 'length', height: 1000 });
    localStorage.removeItem('jww-viewer:measure');
    return out;
  });
  check(`${name}：大きな体積でも値と内訳（底面と高さ）が切れない`, fits.value === '1543.146 m³' && !fits.valueCut && !fits.detailCut, fits);
  // 色の一覧も画面の中に収まる
  await page.click('#btn-color');
  const pop = await page.evaluate(() => {
    const r = document.getElementById('color-pop').getBoundingClientRect();
    const btns = [...document.querySelectorAll('#color-pop button')].map((b) => b.getBoundingClientRect());
    return {
      shown: r.height > 0, top: r.top, left: r.left, right: r.right, vw: innerWidth,
      small: btns.filter((b) => b.width < 24).length, count: btns.length,
    };
  });
  check(`${name}：色の一覧が画面の中に出て、8 色とも押せる大きさ`,
    pop.shown && pop.top >= 0 && pop.left >= 0 && pop.right <= pop.vw && pop.count === 8 && pop.small === 0, pop);
  if (name === '横 667') await page.screenshot({ path: path.join(outDir, 'e2e-modes-land.png') });
  if (name.startsWith('横')) {
    await page.click('#btn-color');
    await page.click('#seg-mode button[data-mode="volume"]');
    const dlg = await page.evaluate(() => {
      const box = document.querySelector('#height-dialog .dialog').getBoundingClientRect();
      const ok = document.getElementById('btn-height-ok').getBoundingClientRect();
      return {
        ok: ok.bottom, input: document.getElementById('height-input').getBoundingClientRect().bottom, h: innerHeight,
        inside: ok.right <= box.right + 0.5 && ok.left >= box.left - 0.5,
      };
    });
    // 横向きのキーボード（と入力の補助の段）は画面の下半分ほどを覆う
    check(`${name}：高さを聞く窓の入力と「決定」が画面の上半分に収まり（キーボードに隠れない）、窓からはみ出さない`,
      dlg.ok <= dlg.h * 0.5 && dlg.input <= dlg.h * 0.5 && dlg.inside, dlg);
    if (name === '横 667') await page.screenshot({ path: path.join(outDir, 'e2e-modes-land-dialog.png') });
    await page.click('#btn-height-cancel');
  }
  await ctx.close();
}

const { ctx, page } = await open({ ...devices['iPhone 14 Pro'], hasTouch: true });

const state = () => page.evaluate(() => ({
  value: document.getElementById('readout-value').textContent,
  detail: document.getElementById('readout-detail').textContent,
  chip: document.getElementById('btn-scale').textContent,
  mode: [...document.querySelectorAll('#seg-mode button.on')].map((b) => b.dataset.mode).join(),
  prefs: JSON.parse(localStorage.getItem('jww-viewer:measure') ?? 'null'),
  dialog: !document.getElementById('height-dialog').classList.contains('hidden'),
  n: window.__jww.points.length,
}));

/** 画面の真ん中に、図面上 w×h（縮尺 scale の図に乗った点）の四角を置く */
const placeRect = (w, h, scale, scales) => page.evaluate(([w, h, scale, scales]) => {
  const a = window.__jww;
  const c = a.toWorld(a.cssW / 2, a.cssH * 0.4);
  // 画面で見える大きさにするため、図面座標の四角が 200px 前後になるよう表示を合わせる
  a.view.zoom = (200 * a.dpr) / Math.max(w, h);
  a.view.cx = c.x;
  a.view.cy = c.y;
  const s = (i) => (scales ? scales[i] : scale);
  a.points = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y], i) => ({ x: c.x + x - w / 2, y: c.y + y - h / 2, glayer: 0, kind: 'endpoint', scale: s(i) }));
  a.manualScale = false;
  a.updateReadout();
  a.draw();
  return a.points.map((p) => [((p.x - a.view.cx) * a.view.zoom) / a.dpr + a.cssW / 2, a.cssH / 2 - ((p.y - a.view.cy) * a.view.zoom) / a.dpr]);
}, [w, h, scale, scales ?? null]);

/** オーバーレイで、指定した色に近いピクセルの数 */
const colorPixels = (rgb, tol = 40) => page.evaluate(([rgb, tol]) => {
  const a = window.__jww;
  a.draw();
  const c = document.getElementById('overlay');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    if (Math.abs(d[i] - rgb[0]) < tol && Math.abs(d[i + 1] - rgb[1]) < tol && Math.abs(d[i + 2] - rgb[2]) < tol) n++;
  }
  return n;
}, [rgb, tol]);

/** オーバーレイの 1 ピクセル（CSS ピクセルの位置） */
const overlayAt = (x, y) => page.evaluate(([x, y]) => {
  const a = window.__jww;
  a.draw();
  const d = document.getElementById('overlay').getContext('2d').getImageData(Math.round(x * a.dpr), Math.round(y * a.dpr), 1, 1).data;
  return [...d];
}, [x, y]);

// ---------- 2. 最初は距離・緑 ----------
{
  const s = await state();
  const measure = await page.evaluate(() => document.getElementById('readout').style.getPropertyValue('--measure'));
  check('最初は「距離」で、色は緑', s.mode === 'length' && measure === '#35d07f' && s.prefs === null, { ...s, measure });
}

// ---------- 3. 色を変えると、線・印・数字がその色になり、次回も使う ----------
{
  await placeRect(100, 60, 50);
  await page.evaluate(() => { const a = window.__jww; a.points = a.points.slice(0, 2); a.updateReadout(); });
  const green0 = await colorPixels([0x35, 0xd0, 0x7f]);
  await page.click('#btn-color');
  const opened = await page.evaluate(() => ({
    shown: !document.getElementById('color-pop').classList.contains('hidden'),
    expanded: document.getElementById('btn-color').getAttribute('aria-expanded'),
    on: document.querySelector('#color-pop button.on')?.dataset.color,
  }));
  check('色のボタンで色の一覧が開き、いまの色に印が付いている', opened.shown && opened.expanded === 'true' && opened.on === 'green', opened);
  await page.click('#color-pop button[data-color="orange"]');
  const orange = await colorPixels([0xff, 0x95, 0x00]);
  const green1 = await colorPixels([0x35, 0xd0, 0x7f]);
  const s = await state();
  const ui = await page.evaluate(() => ({
    shown: !document.getElementById('color-pop').classList.contains('hidden'),
    value: getComputedStyle(document.getElementById('readout-value')).color,
  }));
  check('色を選ぶと一覧が閉じ、測線・印・数字がその色で描かれる', !ui.shown && green0 > 100 && orange > 100 && green1 < green0 * 0.05, { green0, orange, green1 });
  check('パネルの値の数字も選んだ色になり、選んだ色を覚える', ui.value === 'rgb(255, 149, 0)' && s.prefs?.color === 'orange', { ui, prefs: s.prefs });

  // 一覧を開いたまま図面を押すと、一覧が閉じるだけで点は置かない
  await page.click('#btn-color');
  const before = (await state()).n;
  await page.touchscreen.tap(200, 300);
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => ({
    n: window.__jww.points.length,
    shown: !document.getElementById('color-pop').classList.contains('hidden'),
  }));
  check('色の一覧を開いたまま図面を押すと、一覧が閉じるだけで点は置かない', !after.shown && after.n === before, { before, after });

  // 置いた点のすぐそばを押しても、点はつままれず動かない
  const pts0 = await page.evaluate(() => JSON.stringify(window.__jww.points.map((p) => [p.x, p.y])));
  const near0 = await page.evaluate(() => {
    const a = window.__jww;
    const p = a.points[0];
    return { x: ((p.x - a.view.cx) * a.view.zoom) / a.dpr + a.cssW / 2 + 12, y: a.cssH / 2 - ((p.y - a.view.cy) * a.view.zoom) / a.dpr + 9 };
  });
  await page.click('#btn-color');
  await page.touchscreen.tap(near0.x, near0.y);
  await page.waitForTimeout(250);
  const pts1 = await page.evaluate(() => JSON.stringify(window.__jww.points.map((p) => [p.x, p.y])));
  check('色の一覧を閉じるために置いた点のそばを押しても、その点は動かない', pts0 === pts1, { pts0, pts1 });

  // 長押しでも点を置かない
  await page.click('#btn-color');
  const held = await page.evaluate(async () => {
    const a = window.__jww;
    const n0 = a.points.length;
    const stage = document.getElementById('stage');
    const base = { pointerId: 21, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: 150, clientY: 250 };
    stage.dispatchEvent(new PointerEvent('pointerdown', base));
    await new Promise((r) => setTimeout(r, 330));
    const holding = a.holding;
    stage.dispatchEvent(new PointerEvent('pointerup', base));
    await new Promise((r) => setTimeout(r, 50));
    return { n0, n1: a.points.length, holding, shown: !document.getElementById('color-pop').classList.contains('hidden') };
  });
  check('色の一覧を閉じるための長押しでも、拡大鏡を出さず点も置かない', held.n1 === held.n0 && !held.holding && !held.shown, held);

  // 消去の直後（値の段をしまう待ち時間）に一覧を開いても、一覧はあとからずれない
  await page.waitForTimeout(500);
  await page.click('#btn-clear');
  await page.click('#btn-color');
  const top0 = await page.evaluate(() => document.getElementById('color-pop').getBoundingClientRect().top);
  await page.waitForTimeout(1200);
  const top1 = await page.evaluate(() => document.getElementById('color-pop').getBoundingClientRect().top);
  check('値の段をしまう待ち時間に色の一覧を開いても、一覧はあとからずれない', Math.abs(top1 - top0) < 0.5, { top0, top1 });
  await page.click('#btn-color');
}

// ---------- 4. 面積 ----------
{
  await page.click('#seg-mode button[data-mode="area"]');
  await page.waitForTimeout(150);
  const hint = await page.textContent('#hint');
  const corners = await placeRect(100, 60, 50);
  const s = await state();
  check('「面積」で、囲んだ範囲の面積（1/50 の 100×60 → 15 m²）と外周を出す',
    s.mode === 'area' && s.value === '15.000 m²' && s.detail === '外周 16.000 m ／ 4 点' && s.chip === '1/50' && s.prefs?.mode === 'area', { s, hint });
  // 囲んだ中を薄く塗り、真ん中に面積を出す
  const [x0, y0] = corners[0];
  const [x2, y2] = corners[2];
  const inside = await overlayAt(x0 + (x2 - x0) * 0.2, y0 + (y2 - y0) * 0.3);
  const label = await overlayAt((x0 + x2) / 2, (y0 + y2) / 2);
  check('囲んだ中を薄く塗り、真ん中に値のラベルを出す', inside[3] > 10 && inside[3] < 120 && label[3] > 200, { inside, label });
  await page.screenshot({ path: path.join(outDir, 'e2e-modes-area.png') });

  // 最初の点に戻ってきた点は足さない（最後の点から最初の点へは自動でつなぐ）
  const closing = await page.evaluate(() => {
    const a = window.__jww;
    const p = a.points[0];
    a.addPoint({ x: p.x, y: p.y, kind: 'endpoint', glayer: 0, ambiguousGroup: false });
    return { n: a.points.length, hint: document.getElementById('hint').textContent };
  });
  check('面積で最初の点に戻ってきた点は足さず、囲んだと知らせる', closing.n === 4 && closing.hint.includes('最初の点に戻った'), closing);

  // 2 点のときは、あと 1 点と知らせる
  await page.evaluate(() => { const a = window.__jww; a.points = a.points.slice(0, 2); a.updateReadout(); });
  const two = await state();
  check('2 点のときは値を出さず、あと 1 点と知らせる', two.value === '—' && two.detail.includes('あと 1 点で面積'), two);

  // 戻すで 1 点ずつ減る（三角形の面積になる）
  await placeRect(100, 60, 50);
  await page.waitForTimeout(500);
  await page.click('#btn-undo');
  const tri = await state();
  check('戻すで角が 1 つ減り、残りで囲んだ面積になる', tri.n === 3 && tri.value === '7.500 m²', tri);

  // 縮尺の違う図の点が混じると注意する
  await placeRect(100, 60, 50, [50, 50, 100, 100]);
  const mixed = await state();
  check('縮尺の違う図の点が混じると注意を出す', mixed.detail.startsWith('※縮尺の違う図をまたいでいます'), mixed);

  // 辺が交差すると注意する
  await page.evaluate(() => {
    const a = window.__jww;
    const p = a.points;
    a.points = [p[0], p[2], p[1], p[3]].map((q) => ({ ...q, scale: 50 }));
    a.updateReadout();
  });
  const bow = await state();
  check('辺が交差する囲み方をすると注意を出す', bow.detail.startsWith('※辺が交差しています'), bow);
}

// ---------- 5. 体積：高さを聞いて、面積に掛ける ----------
{
  await placeRect(100, 60, 50);
  await page.click('#seg-mode button[data-mode="volume"]');
  await page.waitForTimeout(150);
  const d = await page.evaluate(() => ({
    shown: !document.getElementById('height-dialog').classList.contains('hidden'),
    value: document.getElementById('height-input').value,
    focused: document.activeElement?.id,
    top: document.querySelector('#height-dialog .dialog').getBoundingClientRect().bottom,
    h: innerHeight,
  }));
  check('「体積」を選ぶと高さを聞く窓が画面の上半分に出て、入力できる', d.shown && d.value === '1000' && d.focused === 'height-input' && d.top < d.h * 0.5, d);
  await page.fill('#height-input', '2,400');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  const s = await state();
  check('高さを入れると、面積 × 高さの体積を出す（15 m² × 2.4 m = 36 m³）',
    !s.dialog && s.value === '36.000 m³' && s.detail === '底面 15.000 m²\n× 高さ 2.400 m' && s.prefs?.height === 2400 && s.prefs?.mode === 'volume', s);
  await page.screenshot({ path: path.join(outDir, 'e2e-modes-volume.png') });

  // 選んである「体積」をもう一度押すと高さを変えられる。読めない値は受け付けない
  await page.click('#seg-mode button[data-mode="volume"]');
  await page.waitForTimeout(100);
  const again = await page.inputValue('#height-input');
  await page.fill('#height-input', 'abc');
  await page.click('#btn-height-ok');
  const bad = await page.evaluate(() => ({
    shown: !document.getElementById('height-dialog').classList.contains('hidden'),
    error: document.getElementById('height-error').textContent,
  }));
  check('「体積」をもう一度押すと今の高さで窓が開き、読めない値では閉じない', again === '2400' && bad.shown && bad.error.length > 0, { again, bad });
  await page.click('#btn-height-cancel');
  const cancelled = await state();
  check('「やめる」で閉じ、高さは変わらない', !cancelled.dialog && cancelled.prefs?.height === 2400 && cancelled.value === '36.000 m³', cancelled);
  // 窓の外を押しても閉じる（全角の数字も読める）
  await page.click('#seg-mode button[data-mode="volume"]');
  await page.fill('#height-input', '１５０');
  await page.click('#btn-height-ok');
  const zen = await state();
  check('全角の数字でも読める（150 mm）', zen.prefs?.height === 150 && zen.detail.endsWith('× 高さ 150.0 mm'), zen);
  await page.click('#seg-mode button[data-mode="volume"]');
  await page.mouse.click(20, 450);
  const outside = await state();
  check('窓の外を押すと閉じる', !outside.dialog && outside.prefs?.height === 150, outside);
}

// ---------- 6. 開き直しても、色・種類・高さを覚えている。距離に戻すと点はそのまま ----------
{
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
  await page.waitForTimeout(500);
  const s = await state();
  const measure = await page.evaluate(() => document.getElementById('readout').style.getPropertyValue('--measure'));
  check('開き直しても、体積・橙・高さを覚えている（窓は勝手に開かない）', s.mode === 'volume' && measure === '#ff9500' && !s.dialog && s.prefs?.height === 150, { s, measure });
  await placeRect(100, 60, 50);
  await page.click('#seg-mode button[data-mode="length"]');
  const len = await state();
  check('距離に戻すと、同じ点を結んだ長さ（最後の区間 5 m、合計 13 m）を出す',
    len.mode === 'length' && len.n === 4 && len.value === '5.000 m' && len.detail.startsWith('合計 13.000 m'), len);
}

// ---------- 7. 白黒：白い背景では黒で描く ----------
{
  await page.evaluate(() => {
    const a = window.__jww;
    a.setDisplay({ ...a.display, background: 'light' });
  });
  await page.click('#btn-color');
  await page.click('#color-pop button[data-color="mono"]');
  await placeRect(100, 60, 50);
  const dark = await colorPixels([0x11, 0x13, 0x18], 30);
  const dot = await page.evaluate(() => document.querySelector('#btn-color .color-dot').classList.contains('mono'));
  check('白黒を選ぶと、白い背景では測線を黒で描く', dark > 100 && dot, { dark, dot });
  await page.evaluate(() => {
    const a = window.__jww;
    a.setDisplay({ ...a.display, background: 'dark' });
  });
  const white = await colorPixels([0xff, 0xff, 0xff], 30);
  check('黒い背景では白で描く', white > 100, { white });
}

check('コンソールにエラーがない', errors.length === 0, { errors: errors.slice(0, 5) });
await ctx.close();

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length ? 1 : 0);
