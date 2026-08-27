// 2 本指のうち 1 本を離したときに、どの Pointer イベントが届くのかを観測する
import { chromium, devices } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const url = process.argv[2] ?? 'http://localhost:5199/';
const sample = path.join(root, 'samples', 'A棟 11階躯体図2026.5.12提出スリーブ.jww');

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ ...devices['iPhone 14 Pro'], hasTouch: true });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

await page.goto(url, { waitUntil: 'networkidle' });
await page.setInputFiles('#file', sample);
await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
await page.waitForTimeout(600);

await page.evaluate(() => {
  window.__log = [];
  const stage = document.getElementById('stage');
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerout', 'pointerleave', 'lostpointercapture']) {
    stage.addEventListener(t, (e) => {
      window.__log.push({
        t, id: e.pointerId, x: Math.round(e.clientX), y: Math.round(e.clientY),
        n: window.__jww.pointers.size, zoom: +window.__jww.view.zoom.toFixed(4),
      });
    }, true);
  }
});

const touch = (type, points) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i, radiusX: 12, radiusY: 12, force: 1 })),
  });

await touch('touchStart', [{ x: 120, y: 420, id: 1 }, { x: 280, y: 420, id: 2 }]);
await page.waitForTimeout(40);
await touch('touchEnd', [{ x: 120, y: 420, id: 1 }]);
await page.waitForTimeout(40);
for (let i = 1; i <= 3; i++) {
  await touch('touchMove', [{ x: 120 + i * 10, y: 420 + i * 8, id: 1 }]);
  await page.waitForTimeout(20);
}
await touch('touchEnd', []);
await page.waitForTimeout(80);

const log = await page.evaluate(() => window.__log);
console.log(JSON.stringify(log, null, 1));
await browser.close();
