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
      count: segs.length,
    };
  });
  check(`${name}：縮尺・直交・色・距離／面積／体積／角度が 1 行に並び、折り返さず、パネルからはみ出さない`,
    bar.count === 4 && bar.oneRow && bar.inside && bar.ordered && bar.overflow.length === 0 && bar.tall.length === 0 && bar.panelH < 70 && bar.segWidth >= 96, bar);
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
    // 距離から「体積」を押して「やめる」を選んだら、距離のまま（体積には切り替えない）
    const kept = await page.evaluate(() => ({
      mode: [...document.querySelectorAll('#seg-mode button.on')].map((b) => b.dataset.mode).join(),
      prefs: JSON.parse(localStorage.getItem('jww-viewer:measure') ?? 'null'),
      dialog: !document.getElementById('height-dialog').classList.contains('hidden'),
    }));
    check(`${name}：「体積」を押して高さの窓で「やめる」を選ぶと、元の「距離」のまま`,
      kept.mode === 'length' && (kept.prefs?.mode ?? 'length') === 'length' && !kept.dialog, kept);
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

// ---------- 8. 角度：3 点で頂点の角を出し、水平・垂直の拘束は掛けない ----------
{
  const { ctx, page } = await open({ ...devices['iPhone 14 Pro'], hasTouch: true });
  await page.click('#seg-mode button[data-mode="angle"]');
  const s = await page.evaluate(async () => {
    const a = window.__jww;
    const c = a.toWorld(a.cssW / 2, a.cssH * 0.4);
    const at = (list, kind = 'intersection') => list.map(([x, y]) => ({ x: c.x + x, y: c.y + y, glayer: 0, kind, scale: 100 }));
    const read = () => ({ value: document.getElementById('readout-value').textContent, detail: document.getElementById('readout-detail').textContent });
    // 直交が入っていても、角度では拘束しない
    a.points = at([[0, 0]], 'endpoint');
    a.snapFor(a.cssW / 2 + 40, a.cssH * 0.4 - 30, null);
    const constraint = a.constraint;
    // 2 点では、あと 1 点で出すことと線の傾きを知らせる
    a.points = at([[20, 0], [0, 0]]);
    a.updateReadout();
    const two = read();
    // 3 点：頂点 (0,0) の角
    a.points = at([[20, 0], [0, 0], [20, 20]]);
    a.updateReadout();
    const three = read();
    // 図面の上に角度の札を描く
    const texts = [];
    const g = a.overlay.ctx;
    const fillText = g.fillText;
    g.fillText = function (t, ...rest) { texts.push(String(t)); return fillText.call(this, t, ...rest); };
    a.requestDraw(true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    g.fillText = fillText;
    // 4 点目：最後の頂点の角を大きく、前の頂点の角も添える
    a.points = at([[20, 0], [0, 0], [20, 20], [40, 0]]);
    a.updateReadout();
    const four = read();
    const out = {
      pressed: document.querySelector('#seg-mode button[data-mode="angle"]').getAttribute('aria-pressed'),
      orthoDisabled: document.getElementById('btn-ortho').disabled,
      orthoOn: a.ortho,
      constraint, two, three, four, texts: texts.filter((t) => t.includes('°')),
    };
    a.points = [];
    a.updateReadout();
    return out;
  });
  check('角度に切り替えると、直交は押せなくなり（入り切りは残る）、水平・垂直の拘束も掛からない',
    s.pressed === 'true' && s.orthoDisabled && s.orthoOn && s.constraint === null, s);
  check('2 点では、あと 1 点で角度を出すことと、線の傾きを知らせる', s.two.value === '—' && /あと 1 点/.test(s.two.detail) && /傾き 0°/.test(s.two.detail), s.two);
  check('3 点で頂点の角と外側の角を出す', s.three.value === '45°' && /外側 315°/.test(s.three.detail) && /頂点は交点/.test(s.three.detail), s.three);
  check('図面の上にも、頂点に角度の札を出す', s.texts.includes('45°'), { texts: s.texts });
  check('4 点目を置くと、最後の頂点の角を出し、前の頂点の角も添える', s.four.value === '90°' && /前の頂点 45°/.test(s.four.detail), s.four);
  await page.click('#seg-mode button[data-mode="length"]');
  const back = await page.evaluate(() => ({ disabled: document.getElementById('btn-ortho').disabled, ortho: window.__jww.ortho }));
  check('距離に戻すと、直交がまた押せて効く', !back.disabled && back.ortho, back);
  await page.evaluate(() => localStorage.removeItem('jww-viewer:measure'));
  await ctx.close();
}

// ---------- 横向きではツールバーを縦に並べ、縦向きで下だった側に置く ----------
{
  /** 端末の向き（window.orientation。左に回すと 90、右に回すと -90）を決めて開く */
  const openRotated = async (viewport, angle) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ctx.addInitScript((a) => {
      window.__angle = a;
      Object.defineProperty(window, 'orientation', { get: () => window.__angle, configurable: true });
    }, angle);
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.goto(srv.url, { waitUntil: 'networkidle' });
    await page.setInputFiles('#file', sample);
    await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
    await page.waitForTimeout(600);
    return { ctx, page };
  };
  /** ツールバーの並びと、ほかのものとの重なり */
  const layout = (page) => page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const a = window.__jww;
    const rect = (n) => { const r = n.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
    const bar = rect(document.getElementById('toolbar'));
    const tools = [...document.querySelectorAll('#toolbar .tool')].map(rect);
    const overlap = (p, q) => p.l < q.r && q.l < p.r && p.t < q.b && q.t < p.b;
    const hits = ['btn-open', 'btn-info', 'readout', 'inspect-panel', 'layer-panel', 'display-panel', 'info-panel']
      .map((id) => document.getElementById(id))
      .filter((n) => n && !n.classList.contains('hidden') && n.getBoundingClientRect().width > 0)
      .filter((n) => tools.some((t) => overlap(t, rect(n))))
      .map((n) => n.id);
    return {
      rail: document.documentElement.dataset.rail,
      cssW: a.cssW,
      cssH: a.cssH,
      vertical: bar.h > bar.w,
      side: bar.l + bar.w / 2 > a.cssW / 2 ? 'right' : 'left',
      stacked: tools.every((t, i) => i === 0 || (Math.abs(t.l - tools[0].l) < 1 && t.t >= tools[i - 1].b)),
      inside: tools.length === 5 && tools.every((t) => t.l >= 0 && t.r <= a.cssW && t.t >= 0 && t.b <= a.cssH),
      hits,
      area: a.visibleArea(),
      toolsL: Math.min(...tools.map((t) => t.l)),
      toolsR: Math.max(...tools.map((t) => t.r)),
      label: document.querySelector('#btn-fit span').textContent,
    };
  });

  for (const [name, viewport] of [['横 852', { width: 852, height: 393 }], ['横 568', { width: 568, height: 320 }]]) {
    for (const [angle, want] of [[90, 'right'], [-90, 'left']]) {
      const tag = `${name}・${want === 'right' ? '左に回した' : '右に回した'}`;
      const side = want === 'right' ? '右' : '左';
      const o = await openRotated(viewport, angle);
      const s = await layout(o.page);
      check(`${tag}：ツールバーは縦に並び、縦向きで下だった${side}の端に収まる`,
        s.rail === want && s.vertical && s.side === want && s.stacked && s.inside, s);
      const clear = want === 'right' ? s.area.right <= s.toolsL : s.area.left >= s.toolsR;
      check(`${tag}：見えている範囲（全体表示・前の範囲の囲い）はツールバーの列を避ける`, clear,
        { area: s.area, toolsL: s.toolsL, toolsR: s.toolsR });
      // 全体表示の図面は、ツールバーのボタンにも計測パネルにも重ならず、十分な大きさで見える
      const fitted = await o.page.evaluate(() => {
        const a = window.__jww;
        a.fit();
        const b = a.visibleFit();
        const k = a.dpr / a.view.zoom;
        const d = { l: (b.minX - a.view.cx) / k + a.cssW / 2, r: (b.maxX - a.view.cx) / k + a.cssW / 2, t: a.cssH / 2 - (b.maxY - a.view.cy) / k, b: a.cssH / 2 - (b.minY - a.view.cy) / k };
        const rect = (n) => { const r = n.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
        const overlap = (p, q) => p.l < q.r - 1 && q.l < p.r - 1 && p.t < q.b - 1 && q.t < p.b - 1;
        const blockers = [...document.querySelectorAll('#toolbar .tool'), document.getElementById('readout')].map(rect);
        return { drawing: d, hits: blockers.filter((q) => overlap(d, q)).length, share: Math.max((d.r - d.l) / a.cssW, (d.b - d.t) / a.cssH) };
      });
      check(`${tag}：全体表示の図面はツールバーにも計測パネルにも重ならず、大きく見える`, fitted.hits === 0 && fitted.share > 0.5, fitted);
      // 拡大鏡もツールバーの列に重ねない。列のすぐ内側の下の方（拡大鏡が指の上に出る所）で長押ししたとき。
      // 右の列では計測パネルの幅が列より広いので、パネルを除いて列だけで避けられるかを見る
      const mag = await o.page.evaluate(([right, l, r]) => {
        const a = window.__jww;
        const ins = a.measureInsets(true);
        a.insets = right ? { ...ins, right: ins.rail } : ins;
        const box = a.placeMagnifier(right ? l - 10 : r + 10, a.cssH - 40);
        return { box, above: box.y + box.size <= a.cssH - 40, clear: right ? box.x + box.size <= l : box.x >= r };
      }, [want === 'right', s.toolsL, s.toolsR]);
      check(`${tag}：拡大鏡をツールバーに重ねない`, mag.above && mag.clear, mag);
      // 属性のパネルとレイヤのシートを開いても、ツールバーのボタンと重ならない
      await o.page.click('#btn-tool-inspect');
      const s2 = await layout(o.page);
      await o.page.click('#btn-layers');
      const s3 = await layout(o.page);
      check(`${tag}：上のバー・計測と属性のパネル・シートがツールバーのボタンに重ならない`,
        s.hits.length === 0 && s2.hits.length === 0 && s3.hits.length === 0, { measure: s.hits, inspect: s2.hits, sheet: s3.hits });
      // レイヤのシートは右側に縦長に出て、左の図面を覆わない
      const sheet = await o.page.evaluate(() => {
        const r = document.getElementById('layer-panel').getBoundingClientRect();
        return { left: r.left, top: r.top, bottom: r.bottom, cssW: window.__jww.cssW, cssH: window.__jww.cssH };
      });
      check(`${tag}：レイヤのシートは右側に縦長に出て、画面の左半分を覆わない`,
        sheet.left >= sheet.cssW / 2 - 90 && sheet.bottom - sheet.top > sheet.cssH * 0.6, sheet);
      // 開いているシートのボタン（レイヤ）は緑、ほかのシートのボタン（表示）は緑にしない。閉じれば戻る
      const open1 = await o.page.evaluate(() => ({
        layers: document.getElementById('btn-layers').classList.contains('open'),
        display: document.getElementById('btn-display').classList.contains('open'),
        color: getComputedStyle(document.getElementById('btn-layers')).color,
      }));
      await o.page.click('#btn-layer-close');
      const open2 = await o.page.evaluate(() => document.getElementById('btn-layers').classList.contains('open'));
      check(`${tag}：レイヤを開いているあいだはレイヤのボタンが緑になり、閉じると戻る`,
        open1.layers && !open1.display && open1.color === 'rgb(53, 208, 127)' && !open2, { open1, open2 });
      // ツールバーの列と上のバーは、ぼかしの帯（モヤ）を出さない
      const haze = await o.page.evaluate(() => ({
        toolbar: getComputedStyle(document.getElementById('toolbar')).backgroundImage,
        topbar: getComputedStyle(document.getElementById('topbar')).backgroundImage,
      }));
      check(`${tag}：ツールバーの列と上のバーにぼかしの帯を出さない`, haze.toolbar === 'none' && haze.topbar === 'none', haze);
      await o.ctx.close();
    }
  }

  // iPhone 14 Pro などの横向き（左右の安全領域 59px）：ツールバーの列はアイランドのない側なので端に寄せ、
  // 反対側（アイランドの側）の上のバー・パネルは安全領域の内側に置く
  for (const [angle, want] of [[90, 'right'], [-90, 'left']]) {
    const o = await openRotated({ width: 852, height: 393 }, angle);
    const r = await o.page.evaluate(async () => {
      const root = document.documentElement.style;
      root.setProperty('--safe-left', '59px');
      root.setProperty('--safe-right', '59px');
      root.setProperty('--safe-bottom', '21px');
      window.__jww.cssW = 0;
      window.__jww.resize();
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const tools = [...document.querySelectorAll('#toolbar .tool')].map((t) => t.getBoundingClientRect());
      const open = document.getElementById('btn-open').getBoundingClientRect();
      const info = document.getElementById('btn-info').getBoundingClientRect();
      const ro = document.getElementById('readout').getBoundingClientRect();
      return {
        w: innerWidth,
        toolsL: Math.min(...tools.map((t) => t.left)),
        toolsR: Math.max(...tools.map((t) => t.right)),
        openL: open.left, infoR: info.right, roL: ro.left, roR: ro.right,
      };
    });
    const side = want === 'right' ? '右' : '左';
    const edge = want === 'right' ? r.w - r.toolsR : r.toolsL;
    // アイランドの側（ツールバーの反対側）
    const island = want === 'right' ? r.openL : r.w - r.infoR;
    const panelClear = want === 'right' ? r.roR <= r.toolsL - 4 : r.roL >= r.toolsR + 4;
    check(`横 852・安全領域 59px・ツールバーは${side}：列は端に寄せ（8px）、アイランドの側は安全領域の内側に置く`,
      edge <= 9 && island >= 59 && panelClear, { edge, island, ...r });
    await o.ctx.close();
  }

  // 縦向き：レイヤが多くても、レイヤのシートは画面の半分までにして中を送る
  {
    const o = await openRotated({ width: 393, height: 852 }, 0);
    await o.page.click('#btn-layers');
    // すべてのグループを開いて、いちばん長くする
    await o.page.evaluate(() => {
      for (const h of document.querySelectorAll('#layer-list .lg-head[aria-expanded="false"]')) h.click();
    });
    await o.page.waitForTimeout(200);
    const r = await o.page.evaluate(() => {
      const p = document.getElementById('layer-panel').getBoundingClientRect();
      const body = document.querySelector('#layer-panel .sheet-body');
      return { h: p.height, vh: innerHeight, scrolls: body.scrollHeight > body.clientHeight + 1 };
    });
    check('縦向きでレイヤを全部開いても、レイヤのシートは画面の半分までで、中を送れる', r.h <= r.vh * 0.5 + 1 && r.scrolls, r);
    await o.ctx.close();
  }

  // Safari のバーが出て高さの低い横画面でも、ボタンを低くして 5 つとも画面に収める
  {
    const o = await openRotated({ width: 568, height: 240 }, 90);
    const s = await layout(o.page);
    check('高さ 240 の低い横画面でも、縦に並べたボタンが 5 つとも画面に収まる', s.vertical && s.stacked && s.inside, s);
    await o.ctx.close();
  }

  // 横向きのまま逆さにする（左右が入れ替わる）と、大きさが同じでもツールバーは反対側へ移り、
  // 全体に合わせ直せるよう「全体」に戻る
  {
    const o = await openRotated({ width: 852, height: 393 }, 90);
    await o.page.evaluate(() => { const a = window.__jww; a.view.zoom *= 4; a.requestDraw(true); });
    await o.page.click('#btn-fit');
    const before = await layout(o.page);
    await o.page.evaluate(() => { window.__angle = -90; window.dispatchEvent(new Event('orientationchange')); });
    await o.page.waitForTimeout(600);
    const after = await layout(o.page);
    check('横向きのまま逆さにすると、ツールバーが反対側へ移り、ボタンが「全体」に戻る',
      before.side === 'right' && before.label === '前の範囲' && after.rail === 'left' && after.side === 'left' && after.label === '全体',
      { before: { side: before.side, label: before.label }, after: { rail: after.rail, side: after.side, label: after.label } });
    // 縦向きに戻すと、ツールバーはまた下に横に並ぶ
    await o.page.setViewportSize({ width: 393, height: 852 });
    await o.page.evaluate(() => { window.__angle = 0; window.dispatchEvent(new Event('orientationchange')); });
    await o.page.waitForTimeout(600);
    const portrait = await o.page.evaluate(() => {
      const r = document.getElementById('toolbar').getBoundingClientRect();
      return { w: r.width, h: r.height, bottom: r.bottom, cssH: window.__jww.cssH };
    });
    check('縦向きではツールバーは下に横に並ぶ', portrait.w > portrait.h && Math.abs(portrait.bottom - portrait.cssH) < 1, portrait);
    // 縦向きではステータスバーの文字が図面に埋もれないよう、上のバーのぼかしは残す
    const topbar = await o.page.evaluate(() => getComputedStyle(document.getElementById('topbar')).backgroundImage);
    check('縦向きでは上のバーのぼかしを残す（ステータスバーの文字を読みやすく）', topbar !== 'none', { topbar });
    await o.ctx.close();
  }
}

check('コンソールにエラーがない', errors.length === 0, { errors: errors.slice(0, 5) });
await ctx.close();

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length ? 1 : 0);
