// 画面向きを変えたときの拡大鏡の置き場所と、描画コンテキストが失われたあとの復帰を確かめる。
import { chromium } from 'playwright';
import path from 'node:path';
import { startServer, projectRoot as root } from './serve.mjs';

const sample = process.argv[2] ?? path.join(root, 'samples', 'A棟 11階躯体図2026.5.12提出スリーブ.jww');
const outDir = process.argv[3] ?? '.';

const srv = await startServer({ port: 5303, host: false, quiet: true });
const url = srv.url;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const results = [];
const check = (name, ok, info) => results.push({ name, ok, ...(info ?? {}) });
const errors = [];

// ---------- 拡大鏡の置き場所 ----------
const SCREENS = [
  { name: 'iPhone 縦 (393x852)', w: 393, h: 852 },
  { name: 'iPhone 横 (852x393)', w: 852, h: 393 },
  { name: '小さい端末 縦 (375x667)', w: 375, h: 667 },
  { name: '小さい端末 横 (667x375)', w: 667, h: 375 },
  { name: '極端に低い (740x320)', w: 740, h: 320 },
];

for (const s of SCREENS) {
  const ctx = await browser.newContext({
    viewport: { width: s.w, height: s.h },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${s.name}: ${e.message}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.setInputFiles('#file', sample);
  await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
  await page.waitForTimeout(400);

  const report = await page.evaluate(([w, h]) => {
    const app = window.__jww;
    const bad = [];
    let count = 0;
    for (let x = 20; x < w; x += 37) {
      for (let y = 60; y < h - 60; y += 31) {
        const m = app.placeMagnifier(x, y);
        count++;
        const overlaps = x >= m.x && x <= m.x + m.size && y >= m.y && y <= m.y + m.size;
        const outside = m.x < 0 || m.y < 0 || m.x + m.size > w || m.y + m.size > h;
        if (overlaps || outside) {
          bad.push({ x, y, m, overlaps, outside });
        }
      }
    }
    return { count, bad: bad.slice(0, 4), badCount: bad.length };
  }, [s.w, s.h]);

  check(`${s.name} で拡大鏡が指と重ならない`, report.badCount === 0, {
    試行: report.count,
    重なり: report.badCount,
    例: report.bad,
  });

  if (s.name.startsWith('iPhone 横')) {
    // 実際に長押しして絵を残す
    await page.evaluate(() => {
      const stage = document.getElementById('stage');
      const o = { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 400, clientY: 200, bubbles: true };
      stage.dispatchEvent(new PointerEvent('pointerdown', o));
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, 'e2e-magnifier-landscape.png') });
    await page.evaluate(() => {
      const stage = document.getElementById('stage');
      stage.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 400, clientY: 200, bubbles: true,
      }));
    });
  }

  await ctx.close();
}

// ---------- コンテキスト消失からの復帰 ----------
{
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`lost: ${e.message}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.setInputFiles('#file', sample);
  await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
  await page.waitForTimeout(600);

  const colorsOf = () => page.evaluate(() => {
    const c = document.getElementById('gl');
    const g = c.getContext('webgl2', { preserveDrawingBuffer: true });
    if (!g || g.isContextLost()) return -1;
    const px = new Uint8Array(4 * 96 * 96);
    g.readPixels(Math.floor(c.width / 2) - 48, Math.floor(c.height / 2) - 48, 96, 96, g.RGBA, g.UNSIGNED_BYTE, px);
    const set = new Set();
    for (let i = 0; i < px.length; i += 4) set.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
    return set.size;
  });

  const before = await colorsOf();

  const lostState = await page.evaluate(async () => {
    const c = document.getElementById('gl');
    const g = c.getContext('webgl2');
    const ext = g.getExtension('WEBGL_lose_context');
    if (!ext) return { supported: false };
    ext.loseContext();
    await new Promise((r) => setTimeout(r, 300));
    const lost = g.isContextLost();
    ext.restoreContext();
    await new Promise((r) => setTimeout(r, 800));
    return { supported: true, lost, restored: !g.isContextLost() };
  });

  await page.waitForTimeout(600);
  const after = await colorsOf();

  check('コンテキスト消失を扱える', lostState.supported !== true || lostState.lost === true, lostState);
  check('復帰後に描画が戻る', !lostState.supported || after >= Math.max(2, before - 4), {
    前: before, 後: after,
  });
  await page.screenshot({ path: path.join(outDir, 'e2e-restored.png') });
  await ctx.close();
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length, errors: errors.slice(0, 5) }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length ? 1 : 0);
