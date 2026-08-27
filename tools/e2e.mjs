// iPhone を模したブラウザで実際に読み込み・描画・計測まで通す検証
import { chromium, devices } from 'playwright';
import path from 'node:path';
import { startServer, projectRoot as root } from './serve.mjs';

const srv = await startServer({ port: 5301, host: false, quiet: true });
const url = srv.url;
const sample = process.argv[2] ?? path.join(root, 'samples', 'A棟 11階躯体図2026.5.12提出スリーブ.jww');
const outDir = process.argv[3] ?? '.';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ ...devices['iPhone 14 Pro'], hasTouch: true });
const page = await context.newPage();

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(url, { waitUntil: 'networkidle' });
await page.screenshot({ path: path.join(outDir, 'e2e-1-welcome.png') });

// ファイルを読み込ませる
await page.setInputFiles('#file', sample);
await page.waitForFunction(
  () => document.getElementById('title')?.textContent?.endsWith('.jww'),
  null, { timeout: 60000 },
);
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(outDir, 'e2e-2-drawing.png') });

const title = await page.textContent('#title');
const gl = await page.evaluate(() => {
  const c = document.getElementById('gl');
  return { w: c.width, h: c.height, ctx: !!c.getContext('webgl2') };
});

// 描画されたピクセルが背景一色でないことを確認する
const painted = await page.evaluate(() => {
  const c = document.getElementById('gl');
  const g = c.getContext('webgl2', { preserveDrawingBuffer: true });
  const px = new Uint8Array(4 * 64 * 64);
  g.readPixels(Math.floor(c.width / 2) - 32, Math.floor(c.height / 2) - 32, 64, 64, g.RGBA, g.UNSIGNED_BYTE, px);
  let distinct = new Set();
  for (let i = 0; i < px.length; i += 4) distinct.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
  return distinct.size;
});

// 拡大してから 2 点をタップし、計測結果が出るかを見る
const box = await page.locator('#stage').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

await page.evaluate(() => {
  // 図面中央あたりを実寸で確認できる倍率まで寄せる
  window.dispatchEvent(new Event('resize'));
});

await page.touchscreen.tap(cx - 60, cy - 40);
await page.waitForTimeout(250);
await page.touchscreen.tap(cx + 60, cy + 40);
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(outDir, 'e2e-3-measure.png') });

const readout = await page.textContent('#readout-value');
const detail = await page.textContent('#readout-detail');

// 長押し（拡大鏡）
await page.touchscreen.tap(cx, cy - 120);
await page.waitForTimeout(100);
const held = await page.evaluate(async ([x, y]) => {
  const stage = document.getElementById('stage');
  const opts = { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true };
  stage.dispatchEvent(new PointerEvent('pointerdown', opts));
  await new Promise((r) => setTimeout(r, 450));
  stage.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x + 2, clientY: y + 2 }));
  await new Promise((r) => setTimeout(r, 250));
  return true;
}, [cx - box.x, cy - box.y]);
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(outDir, 'e2e-4-magnifier.png') });
await page.evaluate(([x, y]) => {
  const stage = document.getElementById('stage');
  stage.dispatchEvent(new PointerEvent('pointerup', {
    pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x + 2, clientY: y + 2, bubbles: true,
  }));
}, [cx - box.x, cy - box.y]);
await page.waitForTimeout(300);

// 3 点目を足して連続計測にする
await page.touchscreen.tap(cx, cy + 90);
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(outDir, 'e2e-5-multi.png') });
const multiDetail = await page.textContent('#readout-detail');

// 描画性能
const fps = await page.evaluate(async () => {
  const t0 = performance.now();
  let frames = 0;
  await new Promise((resolve) => {
    const step = () => {
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: frames % 2 ? 12 : -12 }));
      frames++;
      if (performance.now() - t0 > 1000) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  return frames;
});

console.log(JSON.stringify({
  title, gl, distinctColorsInCenter: painted, held,
  距離: readout, 内訳: detail, 連続計測: multiDetail,
  秒間フレーム: fps,
  errors,
}, null, 2));

await browser.close();
await srv.close();
