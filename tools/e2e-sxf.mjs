// SXF をアプリで開く：合成の SFC（sxf-synth.mjs）を開き、1/100 の部分図の線と用紙の線を測る（縮尺は自動）・
// 情報パネルの縮尺の枠（用紙・部分図）・レイヤの名前だけの一覧（元の図面で非表示の印）を確かめる。
// 同じ図面を P21（AP202）に書き直したものも開いて測る
import { chromium, devices } from 'playwright';
import { startServer } from './serve.mjs';
import { basicSfc } from './sxf-synth.mjs';
import { writeP21 } from './sxf-p21.ts';
import { parseSfc } from '../src/sxf/sfc.ts';

const srv = await startServer({ port: 5325, host: false, quiet: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ ...devices['iPhone 14 Pro'], hasTouch: true });
const page = await context.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const results = [];
const check = (name, ok, info) => results.push({ name, ok, ...(info ?? {}) });

const opened = (name) => page.waitForFunction((n) => document.getElementById('title')?.textContent === n && !!window.__jww.scene, name, { timeout: 60000 });
const pick = (name, data) => page.setInputFiles('#file', { name, mimeType: 'application/octet-stream', buffer: Buffer.from(data) });
const toScreen = (wx, wy) => page.evaluate(([x, y]) => {
  const a = window.__jww;
  return { x: ((x - a.view.cx) * a.view.zoom) / a.dpr + a.cssW / 2, y: a.cssH / 2 - ((y - a.view.cy) * a.view.zoom) / a.dpr };
}, [wx, wy]);
const readout = () => page.evaluate(() => document.getElementById('readout-value').textContent);

/** 用紙の (x1,y)-(x2,y) の線を画面の 7 割ほどに寄せ、端の少し外側（線の延長上）を触って測る */
const measure = async (x1, x2, y) => {
  await page.evaluate(([cx, cy, w]) => {
    const a = window.__jww;
    a.view = { cx, cy, zoom: (a.cssW * 0.7 * a.dpr) / w };
    a.requestDraw(true);
    a.points = [];
    a.updateReadout();
  }, [(x1 + x2) / 2, y, x2 - x1]);
  await page.waitForTimeout(300);
  for (const [x, dx] of [[x1, -4], [x2, 4]]) {
    const p = await toScreen(x, y);
    await page.touchscreen.tap(p.x + dx, p.y);
    await page.waitForTimeout(250);
  }
  return {
    value: await readout(),
    points: await page.evaluate(() => window.__jww.points.map((p) => ({ x: +p.x.toFixed(3), y: +p.y.toFixed(3), kind: p.kind, scale: p.scale }))),
  };
};

await page.goto(srv.url, { waitUntil: 'networkidle' });
await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('jww-viewer'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });

// ---------- 1. 開く ----------
await pick('basic.sfc', basicSfc());
await opened('basic.sfc');
await page.waitForTimeout(500);
{
  const info = await page.evaluate(() => ({
    format: window.__jww.info.format, mode: window.__jww.info.layerMode, scales: [...window.__jww.scene.scales.slice(0, 2)],
    paper: window.__jww.scene.paper,
  }));
  check('SFC を開ける（形式 sfc、レイヤは名前だけ、用紙 A3 横、枠 1 は 1/100）', info.format === 'sfc' && info.mode === 'flat'
    && info.scales[0] === 1 && info.scales[1] === 100 && info.paper?.maxX === 420, info);
}

// ---------- 2. 1/100 の部分図の線（用紙の 10 mm）は実寸 1 m、用紙の線（100 mm）は 0.1 m ----------
{
  const m = await measure(100, 110, 100);
  check('部分図の線の端から端までを測ると 1.000 m（縮尺は自動で 1/100）', m.value === '1.000 m' && m.points.length === 2
    && m.points.every((p) => p.kind === 'endpoint' && p.scale === 100), m);
}
{
  const m = await measure(0, 100, 0);
  check('用紙の線は 1/1 で 100.0 mm', m.value === '100.0 mm' && m.points.every((p) => p.scale === 1), m);
}

// ---------- 3. 情報パネルの縮尺の枠 ----------
await page.click('#btn-info');
await page.waitForSelector('#info-body .group-row.pick');
{
  const s = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('#info-body .group-row.pick')].map((r) => r.textContent),
    text: document.getElementById('info-body').textContent,
  }));
  check('情報パネルに用紙・部分図の縮尺と用紙の大きさが出る', s.rows.some((r) => r.includes('平面図') && r.includes('1/100'))
    && s.rows.some((r) => r.includes('用紙') && r.includes('1/1')) && s.text.includes('A3 横') && s.text.includes('SFC'), s);
  // 枠「平面図」を選ぶと、用紙の線も 1/100 で測る
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#info-body .group-row.pick')].find((r) => r.textContent.includes('平面図'));
    row.click();
  });
}
await page.click('#btn-info-close');
{
  const m = await measure(0, 100, 0);
  check('枠を選ぶとその縮尺で測る（用紙の 100 mm → 10 m）', m.value === '10.000 m', m);
}

// ---------- 4. レイヤの一覧 ----------
await page.click('#btn-layers');
await page.waitForSelector('#layer-list .l-row');
{
  const l = await page.evaluate(() => ({
    groups: document.querySelectorAll('#layer-list .lg').length,
    rows: [...document.querySelectorAll('#layer-list .l-row')].map((r) => ({
      name: r.querySelector('.lname').textContent, off: r.classList.contains('off'), flag: r.querySelector('.lflag')?.textContent ?? '',
    })),
  }));
  const names = l.rows.map((r) => r.name);
  const hidden = l.rows.find((r) => r.name === 'HIDDEN');
  check('レイヤは SXF のレイヤ名だけを並べる', l.groups === 0 && names.includes('壁') && names.includes('寸法'), l);
  check('lflag 0 のレイヤは隠し、印を付ける', !!hidden && hidden.off && hidden.flag === '元の図面で非表示', { row: hidden });
}
await page.click('#btn-layer-close');

// ---------- 5. P21 ----------
{
  const sfc = basicSfc();
  const doc = parseSfc(sfc.slice().buffer);
  await pick('basic.p21', writeP21(doc));
  await opened('basic.p21');
  await page.waitForTimeout(500);
  const info = await page.evaluate(() => ({ format: window.__jww.info.format, scales: [...window.__jww.scene.scales.slice(0, 2)] }));
  check('P21 を開ける（形式 p21、枠 1 は 1/100）', info.format === 'p21' && info.scales[1] === 100, info);
  const m = await measure(100, 110, 100);
  check('P21 でも部分図の線は 1.000 m', m.value === '1.000 m' && m.points.every((p) => p.scale === 100), m);
}

check('コンソールにエラーがない', errors.length === 0, { errors: errors.slice(0, 5) });

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length ? 1 : 0);
