// 撮影の自動手順を、ブラウザ（Chromium）で iPad / iPhone の大きさにして通しで試す（シミュレータを使う前の下見）。
// ここで撮った画像はブラウザの画面なので、App Store には使わない。
// 使い方：NODE_ENV=development npx vite build --outDir <dir> && node tools/appstore-shots/inject.mjs <dir>
//         node tools/appstore-shots/local-test.mjs <dir> <出力先> [幅] [高さ] [倍率]
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const [dir, out, w = '1032', h = '1376', dpr = '2'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jww': 'application/octet-stream', '.webmanifest': 'application/json' };
const server = createServer((req, res) => {
  let p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  res.end(readFileSync(p));
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch({
  ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, deviceScaleFactor: +dpr, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.text().startsWith('[shot]')) console.log(m.text()); });
page.on('pageerror', (e) => console.log('pageerror', e.message));
let finished = null;
const done = new Promise((r) => { finished = r; });
await page.exposeFunction('__shotHost', async (name) => {
  if (name === 'FINISHED' || name === 'ERROR') { finished(name); return; }
  await page.screenshot({ path: path.join(out, `${name}.png`) });
});
await page.goto(`http://localhost:${port}/`);
const result = await Promise.race([done, new Promise((r) => setTimeout(() => r('TIMEOUT'), 240000))]);
console.log('result', result);
await browser.close();
server.close();
process.exit(result === 'FINISHED' ? 0 : 1);
