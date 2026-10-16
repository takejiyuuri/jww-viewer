// DXF をアプリで開く：合成の DXF（dxf-synth.mjs）を開き、長さを測る・単位と縮尺を選ぶ（図面ごとに覚える）・
// レイヤの名前だけの一覧・段階 B の図形（寸法・MTEXT・HATCH・SPLINE など）・DWG を断る、を確かめる
import { chromium, devices } from 'playwright';
import { startServer } from './serve.mjs';
import { basicDxf, stageBDxf, unitlessDxf } from './dxf-synth.mjs';

const srv = await startServer({ port: 5324, host: false, quiet: true });
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

await page.goto(srv.url, { waitUntil: 'networkidle' });
await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('jww-viewer'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });

// ---------- 1. 開いて、長さ 1000 mm の線を測る ----------
await pick('basic.dxf', basicDxf());
await opened('basic.dxf');
await page.waitForTimeout(500);
{
  const info = await page.evaluate(() => ({ format: window.__jww.info.format, mode: window.__jww.info.layerMode, scale: window.__jww.scene.scales[0] }));
  check('DXF を開ける（形式 dxf、レイヤは名前だけ）', info.format === 'dxf' && info.mode === 'flat' && info.scale === 1, info);
}
// 線 (0,0)-(1000,0) が画面の 7 割ほどになるように寄せる
await page.evaluate(() => {
  const a = window.__jww;
  a.view = { cx: 500, cy: 0, zoom: (a.cssW * 0.7 * a.dpr) / 1000 };
  a.requestDraw(true);
});
await page.waitForTimeout(300);
const measure = async () => {
  await page.evaluate(() => { window.__jww.points = []; window.__jww.updateReadout(); });
  // 線の上ちょうどを触ると「線上」が勝つので、端の少し外側（線の延長上）を触る
  for (const [x, y, dx] of [[0, 0, -4], [1000, 0, 4]]) {
    const p = await toScreen(x, y);
    await page.touchscreen.tap(p.x + dx, p.y);
    await page.waitForTimeout(250);
  }
  return {
    value: await readout(),
    points: await page.evaluate(() => window.__jww.points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), kind: p.kind }))),
  };
};
{
  const m = await measure();
  check('線の端から端までを測ると 1.000 m', m.value === '1.000 m' && m.points.length === 2 && m.points.every((p) => p.kind === 'endpoint'), m);
}

// ---------- 2. 単位と縮尺を選ぶ ----------
await page.click('#btn-info');
await page.waitForSelector('#dxf-unit');
{
  const shown = await page.evaluate(() => ({
    unit: document.getElementById('dxf-unit').value, scale: document.getElementById('dxf-scale').value,
    text: document.getElementById('info-body').textContent,
  }));
  check('情報パネルに単位（図面の指定 mm）と縮尺 1/1 が出る', shown.unit === '4' && shown.scale === '1' && shown.text.includes('DXF'), shown);
}
await page.selectOption('#dxf-unit', '6');
await page.waitForTimeout(200);
check('単位を m にすると、置いた点のまま 1000 m', (await readout()) === '1000.000 m', { value: await readout() });
await page.selectOption('#dxf-unit', '4');
await page.selectOption('#dxf-scale', '100');
await page.waitForTimeout(200);
check('縮尺 1/100 にすると 100 m', (await readout()) === '100.000 m', { value: await readout() });
await page.click('#btn-info-close');
{
  const m = await measure();
  check('縮尺 1/100 のまま測り直しても 100 m', m.value === '100.000 m', m);
}

// 同じ図面を開き直すと、選んだ単位と縮尺を覚えている
await page.waitForFunction(() => window.__jww.recent.some((r) => r.name === 'basic.dxf'), null, { timeout: 10000 });
await page.reload({ waitUntil: 'networkidle' });
await opened('basic.dxf');
{
  const s = await page.evaluate(() => ({ scale: window.__jww.scene.scales[0], dxfScale: window.__jww.dxfScale }));
  check('開き直すと、図面ごとに選んだ縮尺（1/100）を覚えている', s.scale === 100 && s.dxfScale === 100, s);
}

// ---------- 3. レイヤの一覧 ----------
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
  check('レイヤはグループなしで名前だけを並べる', l.groups === 0 && names.includes('壁') && names.includes('DASHLAYER') && names.includes('0'), l);
  check('元の図面で表示オフのレイヤは隠し、印を付ける', !!hidden && hidden.off && hidden.flag === '元の図面で非表示', hidden);
  // 「壁」を隠す
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#layer-list .l-row')].find((r) => r.querySelector('.lname').textContent === '壁');
    row.querySelector('.sw').click();
  });
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => {
    const a = window.__jww;
    const info = a.info;
    let k = -1;
    for (let i = 0; i < 256; i++) if (info.groups[i >> 4].layers[i & 15].name === '壁') k = i;
    const row = [...document.querySelectorAll('#layer-list .l-row')].find((r) => r.querySelector('.lname').textContent === '壁');
    return { visible: a.layers.visible(k), off: row.classList.contains('off') };
  });
  check('レイヤの行で表示を切り替えられる', !after.visible && after.off, after);
}
await page.click('#btn-layer-close');

// ---------- 4. 単位の指定がない図面と、名前の自然順 ----------
await pick('unitless.dxf', unitlessDxf());
await opened('unitless.dxf');
await page.click('#btn-layers');
await page.waitForSelector('#layer-list .l-row');
{
  const names = await page.evaluate(() => [...document.querySelectorAll('#layer-list .l-row .lname')].map((n) => n.textContent));
  check('レイヤは名前の自然順（L1, L2, L10）', names.join() === 'L1,L2,L10', { names });
}
await page.click('#btn-layer-close');
await page.click('#btn-info');
await page.waitForSelector('#dxf-unit');
{
  const s = await page.evaluate(() => ({
    unit: document.getElementById('dxf-unit').value,
    label: document.getElementById('dxf-unit').selectedOptions[0].textContent,
    scale: window.__jww.scene.scales[0],
  }));
  check('単位の指定がない図面は mm とみなして、そう示す（前の図面の縮尺は持ち越さない）', s.unit === '4' && s.label.includes('指定なし') && s.scale === 1, s);
}
await page.click('#btn-info-close');

// ---------- 5. 段階 B の図形（寸法・MTEXT・HATCH・SPLINE など） ----------
await pick('stage-b.dxf', stageBDxf());
await opened('stage-b.dxf');
await page.waitForTimeout(500);
{
  const s = await page.evaluate(() => {
    const a = window.__jww;
    const e = a.scene.entities;
    const kinds = new Set();
    for (let i = 0; i < e.count; i++) kinds.add(e.kind[i]);
    return { texts: a.scene.texts.map((t) => t.text), kinds: [...kinds].sort((x, y) => x - y), tris: a.scene.triPos.length / 6, dims: a.info.counts.dims };
  });
  check('寸法・MTEXT・属性・HATCH・SPLINE を描く', s.texts.includes('CD1/2°±日') && s.texts.includes('1000') && s.texts.includes('A-12')
    && s.kinds.includes(6) && s.kinds.includes(10) && s.kinds.includes(11) && s.tris > 10 && s.dims === 1, { ...s, texts: s.texts.slice(0, 8) });
}
// 寸法線 (0,1300)-(1000,1300) の両端を測る
await page.evaluate(() => {
  const a = window.__jww;
  a.view = { cx: 500, cy: 1300, zoom: (a.cssW * 0.7 * a.dpr) / 1000 };
  a.requestDraw(true);
  a.points = [];
  a.updateReadout();
});
await page.waitForTimeout(300);
for (const [x, y, dx] of [[0, 1300, -4], [1000, 1300, 4]]) {
  const p = await toScreen(x, y);
  await page.touchscreen.tap(p.x + dx, p.y);
  await page.waitForTimeout(250);
}
{
  const v = await readout();
  const pts = await page.evaluate(() => window.__jww.points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), kind: p.kind })));
  check('寸法線の端から端までを測ると 1.000 m', v === '1.000 m' && pts.length === 2 && pts.every((p) => p.kind === 'endpoint'), { v, pts });
}

// ---------- 6. DWG は理由を出して断る ----------
await pick('plan.dwg', Buffer.concat([Buffer.from('AC1027'), Buffer.alloc(200)]));
await page.waitForFunction(() => /DXF/.test(document.getElementById('hint').textContent ?? ''), null, { timeout: 10000 }).catch(() => {});
{
  const s = await page.evaluate(() => ({ hint: document.getElementById('hint').textContent, title: document.getElementById('title').textContent }));
  check('DWG は「DXF で保存し直して」と断り、表示中の図面はそのまま', /DWG/.test(s.hint) && /DXF 形式に保存し直して/.test(s.hint) && s.title === 'stage-b.dxf', s);
}

check('コンソールにエラーがない', errors.length === 0, { errors: errors.slice(0, 5) });

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length ? 1 : 0);
