// 累進寸法を画面で確かめる：見本の図面を開くと列が累進に直って元の寸法値が隠れる、列をタップして選べる、
// 起点の丸をドラッグして通り芯の交点に吸着させると値が変わる、「寸法線に沿う」で寸法線の上だけを動く、
// 「同じ向きを連動」で平行な列の起点もそろう、「累進で表示」を切ると元に戻る。
// 引数：出力先のフォルダ（スクリーンショット）。図面は public/ruishin-sample.jww（tools/ruishin-sample.mjs で作る）
import { chromium, devices } from 'playwright';
import path from 'node:path';
import { startServer, projectRoot as root } from './serve.mjs';

const srv = await startServer({ port: 5311, host: false, quiet: true });
const outDir = process.argv[2] ?? '.';
const sample = path.join(root, 'public', 'ruishin-sample.jww');

const browser = await chromium.launch({
  // 決まった場所の Chromium を使うとき（CI など）は PW_CHROMIUM に実行ファイルを渡す
  ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ ...devices['iPhone 14 Pro'], hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const results = [];
const check = (name, ok, info) => results.push({ name, ok, ...(info ?? {}) });

await page.goto(srv.url, { waitUntil: 'networkidle' });
await page.setInputFiles('#file', sample);
await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
await page.waitForTimeout(800);

const toScreen = (wx, wy) => page.evaluate(([x, y]) => {
  const a = window.__jww;
  return {
    x: ((x - a.view.cx) * a.view.zoom) / a.dpr + a.cssW / 2,
    y: a.cssH / 2 - ((y - a.view.cy) * a.view.zoom) / a.dpr,
  };
}, [wx, wy]);

/** 押して（holdMs 待って）動かして離す */
const drag = async (from, to, holdMs = 60) => {
  await page.evaluate(async ([fx, fy, tx, ty, ms]) => {
    const stage = document.getElementById('stage');
    const base = { pointerId: 9, pointerType: 'touch', isPrimary: true, bubbles: true };
    stage.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: fx, clientY: fy }));
    await new Promise((r) => setTimeout(r, ms));
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      stage.dispatchEvent(new PointerEvent('pointermove', {
        ...base, clientX: fx + ((tx - fx) * i) / steps, clientY: fy + ((ty - fy) * i) / steps,
      }));
      await new Promise((r) => setTimeout(r, 25));
    }
    stage.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: tx, clientY: ty }));
  }, [from.x, from.y, to.x, to.y, holdMs]);
  await page.waitForTimeout(250);
};
const tap = async (x, y) => {
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(250);
};

/** 列ごとの累進の値（起点からの実寸を丸めたもの） */
const values = () => page.evaluate(async () => {
  const a = window.__jww;
  const m = await import('/src/ruishin/ordinate.ts');
  return a.chains.map((c) => ({
    id: c.id, dir: c.uy === 0 ? 'h' : c.ux === 0 ? 'v' : 's', offset: c.offset,
    values: m.ordinates(c, a.origins.get(c.id)).map((s) => Math.round(s.value)),
  }));
});

// ---------- 1. 開いたら累進に直っている ----------
{
  const v = await values();
  const h = v.filter((c) => c.dir === 'h');
  const vert = v.filter((c) => c.dir === 'v');
  check('横 2 列・縦 1 列を拾う', h.length === 2 && vert.length === 1, { v });
  check('下の列は左端から 0,1820,3640,4550,6370,8190',
    h.some((c) => c.values.join() === '0,1820,3640,4550,6370,8190'), { h });
  check('縦の列は 0,1820,2730,4550,6370', vert[0]?.values.join() === '0,1820,2730,4550,6370', { vert });
  const panel = await page.evaluate(() => ({
    shown: !document.getElementById('ruishin-panel').classList.contains('hidden'),
    title: document.getElementById('ruishin-title').textContent,
    tool: window.__jww.tool,
  }));
  check('累進のパネルが出ている', panel.shown && panel.tool === 'ruishin' && panel.title.includes('3 列'), panel);
  const hiddenCount = await page.evaluate(() => window.__jww.textLayer.hidden?.size ?? 0);
  check('元の寸法値（14 個）を隠す', hiddenCount === 14, { hiddenCount });
  await page.screenshot({ path: path.join(outDir, 'ruishin-1-open.png') });
}

// 下の列の値が見える大きさに寄せ、下の列を画面の上から 4 割ほどの所（パネルに隠れない所）に置く
await page.evaluate(() => {
  const a = window.__jww;
  a.view.zoom *= 1.9;
  a.view.cx = 40;
  a.view.cy = -13 - (a.cssH * 0.1 * a.dpr) / a.view.zoom;
  a.requestDraw(true);
});
await page.waitForTimeout(400);

const bottom = (await page.evaluate(() => {
  const a = window.__jww;
  return a.chains.filter((c) => c.uy === 0).sort((p, q) => p.offset - q.offset)[0];
}));

// ---------- 2. 列をタップして選ぶ ----------
{
  const s = await toScreen(30, bottom.offset);
  await tap(s.x, s.y - 4);
  const active = await page.evaluate(() => window.__jww.activeChain);
  const title = await page.evaluate(() => document.getElementById('ruishin-title').textContent);
  check('寸法線の近くをタップすると列を選ぶ', active === bottom.id && title === '横の列', { active, title });
}

// ---------- 3. 起点をドラッグして通り芯の交点（X3 = 4550, Y0）に吸着 ----------
{
  const from = await toScreen(0, bottom.offset);
  const to = await toScreen(45.5 + 0.2, -0.15); // 交点の少し横を離す
  await drag(from, to);
  const o = await page.evaluate((id) => window.__jww.origins.get(id), bottom.id);
  check('起点が交点に吸着する', Math.abs(o.x - 45.5) < 1e-3 && Math.abs(o.y) < 1e-3, { o });
  const v = (await values()).find((c) => c.id === bottom.id);
  check('起点を動かすと値が更新される', v.values.join() === '-4550,-2730,-910,0,1820,3640', { v });
  await page.screenshot({ path: path.join(outDir, 'ruishin-2-moved.png') });
}

// ---------- 4. 寸法線に沿う：寸法線の上だけを動き、通り芯との交点に吸着 ----------
{
  await page.click('#btn-ruishin-along');
  const o0 = await page.evaluate((id) => window.__jww.origins.get(id), bottom.id);
  const from = await toScreen(o0.x, bottom.offset);
  const to = await toScreen(63.7 + 0.5, bottom.offset + 3);
  await drag(from, to);
  const o = await page.evaluate((id) => window.__jww.origins.get(id), bottom.id);
  check('寸法線に沿って X4 の通り芯に吸着', Math.abs(o.x - 63.7) < 1e-3 && Math.abs(o.y - bottom.offset) < 1e-3, { o });
  await page.click('#btn-ruishin-along');
}

// ---------- 5. 同じ向きを連動：上の列（線と数字の寸法）も同じ起点になる ----------
{
  await page.click('#btn-ruishin-link');
  const o0 = await page.evaluate((id) => window.__jww.origins.get(id), bottom.id);
  const from = await toScreen(o0.x, bottom.offset);
  const to = await toScreen(18.2 + 0.3, 18.2 - 0.3);
  await drag(from, to);
  const v = await values();
  const hs = v.filter((c) => c.dir === 'h');
  check('平行な列の起点もそろう', hs.every((c) => c.values.join() === '-1820,0,1820,2730,4550,6370'), { hs });
  await page.click('#btn-ruishin-link');
  await page.screenshot({ path: path.join(outDir, 'ruishin-3-linked.png') });
}

// ---------- 6. 起点を戻す・累進で表示を切る ----------
{
  await page.click('#btn-ruishin-reset');
  const v = (await values()).find((c) => c.id === bottom.id);
  check('この列の起点を戻す', v.values[0] === 0, { v });
  await page.click('#btn-ruishin-on');
  const off = await page.evaluate(() => ({ on: window.__jww.ruishinOn, hidden: window.__jww.textLayer.hidden }));
  check('切ると元の寸法値に戻る', off.on === false && off.hidden === null, off);
  await page.screenshot({ path: path.join(outDir, 'ruishin-4-off.png') });
  await page.click('#btn-ruishin-on');
}

check('コンソールにエラーがない', errors.length === 0, { errors });

await browser.close();
await srv.close();
let ng = 0;
for (const r of results) {
  if (!r.ok) ng++;
  const { name, ok, ...info } = r;
  console.log(`${ok ? 'OK' : 'NG'}: ${name}${ok ? '' : ` ${JSON.stringify(info)}`}`);
}
process.exit(ng ? 1 : 0);
