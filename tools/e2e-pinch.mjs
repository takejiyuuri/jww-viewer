// 2 本指ピンチ・マルチタッチの挙動を CDP の生タッチイベントで検証する。
// Playwright の touchscreen は 1 点しか送れないため、Input.dispatchTouchEvent を直接使う。
import { chromium, devices } from 'playwright';
import path from 'node:path';
import { startServer, projectRoot as root } from './serve.mjs';

const srv = await startServer({ port: 5302, host: false, quiet: true });
const url = srv.url;
const sample = process.argv[2] ?? path.join(root, 'samples', 'A棟 11階躯体図2026.5.12提出スリーブ.jww');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ ...devices['iPhone 14 Pro'], hasTouch: true });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(url, { waitUntil: 'networkidle' });
await page.setInputFiles('#file', sample);
await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
await page.waitForTimeout(800);

const touch = (type, points) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i, radiusX: 12, radiusY: 12, force: 1 })),
  });

const view = () => page.evaluate(() => {
  const a = window.__jww;
  return { cx: a.view.cx, cy: a.view.cy, zoom: a.view.zoom, dpr: a.dpr, pointers: a.pointers.size };
});

/** CSS 座標が指している図面座標 */
const worldAt = (x, y) => page.evaluate(([px, py]) => {
  const a = window.__jww;
  return a.toWorld(px, py);
}, [x, y]);

const results = [];
const check = (name, ok, info) => {
  results.push({ name, ok, ...info });
};

const W = 393, H = 852;

// ---------- 1. ピンチアウト（拡大）----------
{
  const before = await view();
  const midX = W / 2, midY = H / 2;
  const worldBefore = await worldAt(midX, midY);

  const d0 = 60, d1 = 150;
  await touch('touchStart', [
    { x: midX - d0, y: midY, id: 1 },
    { x: midX + d0, y: midY, id: 2 },
  ]);
  // 数ステップに分けて広げる
  for (let i = 1; i <= 6; i++) {
    const d = d0 + ((d1 - d0) * i) / 6;
    await touch('touchMove', [
      { x: midX - d, y: midY, id: 1 },
      { x: midX + d, y: midY, id: 2 },
    ]);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(120);

  const after = await view();
  const worldAfter = await worldAt(midX, midY);
  const expected = (d1 * 2) / (d0 * 2);
  const actual = after.zoom / before.zoom;
  const zoomErr = Math.abs(actual - expected) / expected;
  // 中点が掴んでいた図面上の点がずれていないか（画面ピクセル換算）
  const driftPx = Math.hypot(worldAfter.x - worldBefore.x, worldAfter.y - worldBefore.y) * after.zoom / after.dpr;

  check('ピンチアウトの倍率', zoomErr < 0.02, { expected: expected.toFixed(3), actual: actual.toFixed(3), 誤差: `${(zoomErr * 100).toFixed(2)}%` });
  check('ピンチアウトの中心固定', driftPx < 2, { ずれ: `${driftPx.toFixed(2)} px` });
  check('ポインタ残留なし(ピンチ後)', after.pointers === 0, { 残り: after.pointers });
}

// ---------- 2. ピンチイン（縮小）+ 同時パン ----------
{
  const before = await view();
  const startMid = { x: W / 2, y: H / 2 };
  const endMid = { x: W / 2 - 50, y: H / 2 + 40 };
  const worldBefore = await worldAt(startMid.x, startMid.y);

  const d0 = 140, d1 = 70;
  await touch('touchStart', [
    { x: startMid.x - d0, y: startMid.y, id: 1 },
    { x: startMid.x + d0, y: startMid.y, id: 2 },
  ]);
  for (let i = 1; i <= 6; i++) {
    const t = i / 6;
    const d = d0 + (d1 - d0) * t;
    const mx = startMid.x + (endMid.x - startMid.x) * t;
    const my = startMid.y + (endMid.y - startMid.y) * t;
    await touch('touchMove', [
      { x: mx - d, y: my, id: 1 },
      { x: mx + d, y: my, id: 2 },
    ]);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(120);

  const after = await view();
  const worldAfter = await worldAt(endMid.x, endMid.y);
  const expected = d1 / d0;
  const actual = after.zoom / before.zoom;
  const zoomErr = Math.abs(actual - expected) / expected;
  const driftPx = Math.hypot(worldAfter.x - worldBefore.x, worldAfter.y - worldBefore.y) * after.zoom / after.dpr;

  check('ピンチインの倍率', zoomErr < 0.02, { expected: expected.toFixed(3), actual: actual.toFixed(3), 誤差: `${(zoomErr * 100).toFixed(2)}%` });
  check('ピンチ+パンの追従', driftPx < 3, { ずれ: `${driftPx.toFixed(2)} px` });
}

// ---------- 3. 2 本 → 1 本に減らす（片方だけ離す）----------
// CDP の touchEnd は「離す点」を渡す仕様なので、残す方ではなく離す方を指定する
{
  const midX = W / 2, midY = H / 2;
  await touch('touchStart', [
    { x: midX - 80, y: midY, id: 1 },
    { x: midX + 80, y: midY, id: 2 },
  ]);
  await page.waitForTimeout(30);
  await touch('touchEnd', [{ x: midX + 80, y: midY, id: 2 }]);
  await page.waitForTimeout(30);
  const before = await view();
  const midState = await page.evaluate(() => ({ n: window.__jww.pointers.size, pinch: !!window.__jww.pinch }));
  for (let i = 1; i <= 5; i++) {
    await touch('touchMove', [{ x: midX - 80 + i * 8, y: midY + i * 6, id: 1 }]);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd', [{ x: midX - 40, y: midY + 30, id: 1 }]);
  await page.waitForTimeout(120);
  const after = await view();
  const zoomChanged = Math.abs(after.zoom / before.zoom - 1);
  const panned = Math.hypot(after.cx - before.cx, after.cy - before.cy) * after.zoom / after.dpr;

  check('片方を離すとピンチ状態が解ける', midState.n === 1 && midState.pinch === false, midState);
  check('1本残しでズームが飛ばない', zoomChanged < 0.001, { 倍率変化: zoomChanged.toExponential(2) });
  check('1本残しでパンできる', panned > 20 && panned < 120, { 移動量: `${panned.toFixed(1)} px` });
  check('ポインタ残留なし(片手離し後)', after.pointers === 0, { 残り: after.pointers });
}

// ---------- 3b. 3 本 → 2 本（基準の 2 点が入れ替わる）----------
{
  await touch('touchStart', [
    { x: 100, y: 400, id: 1 },
    { x: 200, y: 400, id: 2 },
    { x: 300, y: 400, id: 3 },
  ]);
  await page.waitForTimeout(30);
  // 基準になっていた 1 本目を離す
  await touch('touchEnd', [{ x: 100, y: 400, id: 1 }]);
  await page.waitForTimeout(30);
  const before = await view();
  // 残り 2 本を少しだけ動かす。倍率が跳ねたら pinch の張り直しができていない
  await touch('touchMove', [{ x: 202, y: 400, id: 2 }, { x: 302, y: 400, id: 3 }]);
  await page.waitForTimeout(30);
  const after = await view();
  const jump = Math.abs(after.zoom / before.zoom - 1);
  await touch('touchEnd', []);
  await page.waitForTimeout(80);
  check('3本→2本で倍率が跳ねない', jump < 0.05, { 倍率変化: `${(jump * 100).toFixed(2)}%` });
}

// ---------- 3c. 2 本指タップで計測点が増えない ----------
{
  const before = await page.evaluate(() => window.__jww.points.length);
  await touch('touchStart', [{ x: 160, y: 430, id: 1 }, { x: 240, y: 430, id: 2 }]);
  await page.waitForTimeout(60);
  await touch('touchEnd', []);
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => window.__jww.points.length);
  check('2本指タップで点が増えない', after === before, { 前: before, 後: after });
}

// ---------- 4. 3 本指 ----------
{
  const before = await view();
  await touch('touchStart', [
    { x: 120, y: 400, id: 1 },
    { x: 200, y: 400, id: 2 },
    { x: 280, y: 400, id: 3 },
  ]);
  for (let i = 1; i <= 4; i++) {
    await touch('touchMove', [
      { x: 120 - i * 5, y: 400, id: 1 },
      { x: 200, y: 400 + i * 4, id: 2 },
      { x: 280 + i * 5, y: 400, id: 3 },
    ]);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(120);
  const after = await view();
  const finite = Number.isFinite(after.zoom) && Number.isFinite(after.cx) && Number.isFinite(after.cy);
  check('3本指でも数値が壊れない', finite && after.zoom > 0, { zoom: after.zoom, cx: after.cx.toFixed(1) });
  check('ポインタ残留なし(3本指後)', after.pointers === 0, { 残り: after.pointers });
}

// ---------- 5. touchCancel（通知などで中断）----------
{
  const before = await page.evaluate(() => window.__jww.points.length);
  await touch('touchStart', [{ x: 200, y: 400, id: 1 }]);
  await page.waitForTimeout(30);
  await touch('touchMove', [{ x: 203, y: 402, id: 1 }]);
  await page.waitForTimeout(30);
  await touch('touchCancel', []);
  await page.waitForTimeout(150);
  const after = await view();
  const points = await page.evaluate(() => window.__jww.points.length);
  check('touchCancel でポインタが残らない', after.pointers === 0, { 残り: after.pointers });
  check('touchCancel で点が増えない', points === before, { 前: before, 後: points });
}

// ---------- 6. 長押し中に 2 本目が触れる ----------
{
  await touch('touchStart', [{ x: 200, y: 420, id: 1 }]);
  await page.waitForTimeout(400); // 長押し成立
  const holding = await page.evaluate(() => window.__jww.holding);
  await touch('touchStart', [{ x: 200, y: 420, id: 1 }, { x: 280, y: 420, id: 2 }]);
  await page.waitForTimeout(60);
  const afterSecond = await page.evaluate(() => ({
    holding: window.__jww.holding,
    magnifier: !!window.__jww.magnifier,
    pointers: window.__jww.pointers.size,
  }));
  await touch('touchEnd', []);
  await page.waitForTimeout(150);
  const end = await page.evaluate(() => ({
    holding: window.__jww.holding,
    magnifier: !!window.__jww.magnifier,
    pointers: window.__jww.pointers.size,
    points: window.__jww.points.length,
  }));

  check('長押しが成立する', holding === true, { holding });
  check('2本目で長押しが解除される', afterSecond.holding === false, afterSecond);
  check('解除後に拡大鏡が残らない', end.magnifier === false, end);
  check('ポインタ残留なし(長押し中断後)', end.pointers === 0, { 残り: end.pointers });
}

// ---------- 7. ズーム限界 ----------
{
  const huge = await page.evaluate(() => {
    const a = window.__jww;
    a.setZoom(1e12);
    const hi = a.view.zoom;
    a.setZoom(1e-12);
    const lo = a.view.zoom;
    return { hi, lo, finite: Number.isFinite(hi) && Number.isFinite(lo) && hi > lo };
  });
  check('ズーム上下限が効く', huge.finite && huge.hi < 1e9 && huge.lo > 1e-9, huge);
  await page.evaluate(() => window.__jww.fit());
  await page.waitForTimeout(100);
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length, errors }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length > 0 || errors.length > 0 ? 1 : 0);
