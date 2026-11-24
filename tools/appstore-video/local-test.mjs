// 動画の自動手順をブラウザで試す（シミュレータを使わずに流れと時刻を確かめる）。
// 使い方：NODE_ENV=development npx vite build && node tools/appstore-video/inject.mjs && node tools/appstore-video/local-test.mjs [出力先] [幅] [高さ]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { startServer } from '../serve.mjs';

const out = process.argv[2] ?? 'video-test';
const w = Number(process.argv[3] ?? 430);
const h = Number(process.argv[4] ?? 932);
mkdirSync(out, { recursive: true });
const srv = await startServer({ port: 5393, preview: true, host: false, quiet: true });
const browser = await chromium.launch({
  ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, locale: 'ja-JP', recordVideo: { dir: out, size: { width: w, height: h } } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.text().startsWith('[video]')) console.log(m.text()); });
let done;
const finished = new Promise((r) => { done = r; });
await page.exposeFunction('__shotHost', async (name) => { if (name === 'FINISHED' || name === 'ERROR') done(name); });
await page.goto(srv.url, { waitUntil: 'networkidle' });
const result = await Promise.race([finished, new Promise((r) => setTimeout(() => r('TIMEOUT'), 120000))]);
await page.screenshot({ path: `${out}/last.png` });
await context.close();
await browser.close();
await srv.close?.();
console.log('結果', result, errors.length ? errors : '');
process.exit(result === 'FINISHED' && !errors.length ? 0 : 1);
