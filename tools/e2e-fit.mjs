// 「全体」と「前の範囲」の切り替えを画面で確かめる。
import { chromium, devices } from 'playwright';
import path from 'node:path';
import { startServer, projectRoot as root } from './serve.mjs';

const srv = await startServer({ port: 5313, host: false, quiet: true });
const sample = process.argv[2] || path.join(root, 'samples', 'A棟 11階躯体図2026.5.12提出スリーブ.jww');

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

const { ctx, page } = await open({ ...devices['iPhone 14 Pro'], hasTouch: true });

/** 描き終わるのを待ってから、ボタンの表示と表示範囲を読む */
const state = () => page.evaluate(async () => {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const a = window.__jww;
  const b = document.getElementById('btn-fit');
  return {
    label: b.querySelector('span').textContent,
    icon: b.querySelector('use').getAttribute('href'),
    aria: b.getAttribute('aria-label'),
    view: { ...a.view },
    n: a.points.length,
  };
});

const same = (a, b) => Math.abs(a.cx - b.cx) < 1e-9 && Math.abs(a.cy - b.cy) < 1e-9 && Math.abs(a.zoom / b.zoom - 1) < 1e-12;

/** 図面を指でなぞる（1 本指のパン） */
const drag = (dx, dy) => page.evaluate(async ([dx, dy]) => {
  const stage = document.getElementById('stage');
  const base = { pointerId: 31, pointerType: 'touch', isPrimary: true, bubbles: true };
  const x = 200, y = 300;
  stage.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x, clientY: y }));
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    stage.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x + (dx * i) / steps, clientY: y + (dy * i) / steps }));
  }
  stage.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: x + dx, clientY: y + dy }));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}, [dx, dy]);

// ---------- 1. 読み込み直後は全体表示なので、押しても戻る先はない ----------
{
  const s0 = await state();
  await page.click('#btn-fit');
  const s1 = await state();
  check('読み込み直後は「全体」。全体を見ているときに押しても「前の範囲」にはならない',
    s0.label === '全体' && s0.icon === '#i-fit' && s1.label === '全体', { s0: s0.label, s1: s1.label });
}

// ---------- 2. 寄せてから「全体」→「前の範囲」で戻る ----------
let detail;
{
  detail = await page.evaluate(async () => {
    const a = window.__jww;
    a.view.zoom *= 6;
    a.view.cx += (80 * a.dpr) / a.view.zoom;
    a.view.cy -= (60 * a.dpr) / a.view.zoom;
    a.requestDraw(true);
    return { ...a.view };
  });
  await page.click('#btn-fit');
  const s = await state();
  check('寄せた所で「全体」を押すと全体を表示し、ボタンが「前の範囲」になる',
    s.label === '前の範囲' && s.icon === '#i-back' && s.aria.includes('戻す') && s.view.zoom < detail.zoom / 3, { label: s.label, icon: s.icon, aria: s.aria });
  await page.click('#btn-fit');
  const back = await state();
  check('「前の範囲」を押すと、押す前とまったく同じ範囲に戻り、ボタンは「全体」に戻る',
    same(back.view, detail) && back.label === '全体' && back.icon === '#i-fit', { back: back.view, detail });
  // 何度でも行き来できる
  await page.click('#btn-fit');
  await page.click('#btn-fit');
  const again = await state();
  check('「全体」と「前の範囲」は何度でも行き来できる', same(again.view, detail) && again.label === '全体', { again: again.view });
}

// ---------- 3. 全体を見ながら少し動いただけなら戻れる。大きく動かしたら「全体」に戻る ----------
{
  await page.click('#btn-fit');
  await drag(10, 6);
  const small = await state();
  check('全体を表示したまま指が少し動いた程度なら「前の範囲」のまま', small.label === '前の範囲', { label: small.label });
  await page.click('#btn-fit');
  const back = await state();
  check('少し動いたあとでも「前の範囲」で元の範囲に戻る', same(back.view, detail), { view: back.view, detail });

  await page.click('#btn-fit');
  await drag(140, 90);
  const moved = await state();
  check('全体表示から大きく動かしたらボタンは「全体」に戻る', moved.label === '全体', { label: moved.label });
  // そこで「全体」を押すと、動かした所を覚えて全体にし、「前の範囲」でそこへ戻る
  await page.click('#btn-fit');
  const refit = await state();
  await page.click('#btn-fit');
  const toMoved = await state();
  check('大きく動かした所で「全体」を押すと、「前の範囲」でその動かした所へ戻る',
    refit.label === '前の範囲' && same(toMoved.view, moved.view) && toMoved.label === '全体', { refit: refit.label, toMoved: toMoved.view, moved: moved.view });
}

// ---------- 4. 拡大・縮小したら「全体」に戻る ----------
{
  await page.evaluate(() => { const a = window.__jww; Object.assign(a.view, { zoom: a.view.zoom * 5 }); a.requestDraw(true); });
  await page.click('#btn-fit');
  const s0 = await state();
  // ホイール（ピンチと同じく倍率を変える）
  await page.mouse.move(200, 300);
  await page.mouse.wheel(0, -120);
  const s1 = await state();
  check('全体を表示してから拡大・縮小すると、ボタンは「全体」に戻る', s0.label === '前の範囲' && s1.label === '全体' && s1.view.zoom > s0.view.zoom * 1.05, { s0: s0.label, s1: s1.label });
}

/** 同じ図面を開き直し、読み込み終わる（図形の入れ物が新しくなる）まで待つ */
const reload = async () => {
  await page.evaluate(() => { window.__oldScene = window.__jww.scene; });
  await page.setInputFiles('#file', sample);
  await page.waitForFunction(() => window.__jww.scene && window.__jww.scene !== window.__oldScene, null, { timeout: 60000 });
  await page.waitForTimeout(300);
};

/** 寄せた範囲を作ってから「全体」を押す。寄せた範囲を返す */
const zoomInThenFit = async () => {
  const d = await page.evaluate(() => {
    const a = window.__jww;
    a.fit();
    a.view.zoom *= 6;
    a.view.cx += (50 * a.dpr) / a.view.zoom;
    a.requestDraw(true);
    return { ...a.view };
  });
  await page.click('#btn-fit');
  return d;
};

// ---------- 4b. 戻った直後に文字が一瞬ずれて見えない（その場で描き直す） ----------
{
  await zoomInThenFit();
  await page.click('#btn-fit');
  const t = await page.evaluate(() => {
    const a = window.__jww;
    const at = a.textLayer.drawnAt;
    return { drawn: !!at && at.zoom === a.view.zoom && at.cx === a.view.cx && at.cy === a.view.cy, transform: a.textLayer.canvas.style.transform };
  });
  check('「前の範囲」で戻った直後に文字をその場で描き直す（全体表示の小さな文字が一瞬残らない）', t.drawn && t.transform === '', t);
}

// ---------- 4c. 1 点目をパネルの上へ出すための自動の移動では、戻る先を失わない ----------
{
  const d = await zoomInThenFit();
  await page.evaluate(() => { const a = window.__jww; a.points = []; a.updateReadout(); });
  await page.waitForTimeout(100);
  const moved = await page.evaluate(() => {
    const a = window.__jww;
    const before = { ...a.view };
    const top = document.getElementById('readout').getBoundingClientRect().top;
    const w = a.toWorld(a.cssW / 2, top - 4);
    a.addPoint({ x: w.x, y: w.y, kind: 'free', glayer: 0, ambiguousGroup: false });
    const shift = (Math.hypot(a.view.cx - before.cx, a.view.cy - before.cy) * a.view.zoom) / a.dpr;
    return { shift };
  });
  const s = await state();
  await page.click('#btn-fit');
  const back = await state();
  check('全体表示で 1 点目を置いて図面が自動でずれても、「前の範囲」で元の範囲に戻れる',
    moved.shift > 32 && s.label === '前の範囲' && same(back.view, d), { moved, label: s.label, back: back.view, d });
  await page.evaluate(() => { const a = window.__jww; a.points = []; a.updateReadout(); a.requestDraw(true); });
}

// ---------- 4d. 全体から大きく動かしたら、戻る先は忘れる（全体の近くへ戻ってきても古い範囲へ飛ばない） ----------
{
  await zoomInThenFit();
  const fitted = await page.evaluate(() => ({ ...window.__jww.view }));
  await page.mouse.move(200, 300);
  await page.mouse.wheel(0, -300);
  await state();
  await page.evaluate((v) => { const a = window.__jww; Object.assign(a.view, v); a.requestDraw(true); }, fitted);
  const s = await state();
  check('全体から大きく動かしてから全体の近くへ戻ってきても、古い範囲への「前の範囲」は出ない', s.label === '全体', { label: s.label });
}

// ---------- 4e. 全体を表示したあとで見えるレイヤが変わったら、押すと見えるものに合わせ直し、戻る先はそのまま ----------
{
  const d = await zoomInThenFit();
  const s0 = await state();
  // 図形の多いレイヤを 1 つだけ残す
  await page.evaluate(() => {
    const a = window.__jww;
    const counts = a.scene.layerCounts;
    let best = 0;
    for (let k = 0; k < 256; k++) if (counts[k] > counts[best] && a.layers.visible(k)) best = k;
    a.layers.only(best);
    a.afterLayerChange(true);
  });
  // 全体の範囲が変わったかは、描き直しのあと少し待ってから確かめる
  await page.waitForTimeout(300);
  const s1 = await state();
  await page.click('#btn-fit');
  const s2 = await state();
  const refit = await page.evaluate(() => { const a = window.__jww; const v = { ...a.view }; a.fit(); const f = { ...a.view }; Object.assign(a.view, v); a.requestDraw(true); return { v, f }; });
  await page.click('#btn-fit');
  const s3 = await state();
  check('全体表示のあとで見えるレイヤが変わるとボタンは「全体」に戻り、押すと見えるものに合わせ直す',
    s0.label === '前の範囲' && s1.label === '全体' && s2.label === '前の範囲' && same(refit.v, refit.f), { s0: s0.label, s1: s1.label, s2: s2.label });
  check('合わせ直したあとの「前の範囲」は、最初に寄せていた範囲に戻る', same(s3.view, d) && s3.label === '全体', { s3: s3.view, d });
  await page.click('#btn-layers');
  await page.click('#btn-layer-jw');
  await page.click('#btn-layer-close');
  await page.waitForTimeout(200);
}

// ---------- 4f. 全体を表示したあとで画面を回したら、押すと新しい向きで合わせ直し、戻る先はそのまま ----------
{
  const d = await zoomInThenFit();
  await page.setViewportSize({ width: 852, height: 393 });
  await page.waitForTimeout(600);
  const s1 = await state();
  await page.click('#btn-fit');
  const s2 = await state();
  const fitted = await page.evaluate(() => { const a = window.__jww; const v = { ...a.view }; a.fit(); const f = { ...a.view }; Object.assign(a.view, v); a.requestDraw(true); return same(v, f); function same(x, y) { return Math.abs(x.cx - y.cx) < 1e-9 && Math.abs(x.cy - y.cy) < 1e-9 && Math.abs(x.zoom / y.zoom - 1) < 1e-12; } });
  await page.click('#btn-fit');
  const s3 = await state();
  check('全体表示のあとで画面を回すとボタンは「全体」に戻り、押すと新しい向きで全体に合わせる', s1.label === '全体' && s2.label === '前の範囲' && fitted, { s1: s1.label, s2: s2.label, fitted });
  check('回したあとの「前の範囲」も、最初に寄せていた範囲に戻る', same(s3.view, d), { s3: s3.view, d });
  await page.setViewportSize({ width: 393, height: 660 });
  await page.waitForTimeout(600);
}

// ---------- 4g. 全体の範囲が変わらないレイヤを隠しただけなら「前の範囲」のまま ----------
{
  const d = await zoomInThenFit();
  // 隠しても全体の範囲が変わらないレイヤを探す（図形の少ないものから）
  const k = await page.evaluate(() => {
    const a = window.__jww;
    const counts = a.scene.layerCounts;
    const used = [];
    for (let i = 0; i < 256; i++) if (counts[i] > 0 && a.layers.visible(i)) used.push(i);
    used.sort((x, y) => counts[x] - counts[y]);
    for (const i of used.slice(0, 40)) {
      a.layers.layer[i] = false;
      a.applyDisplay();
      a.checkFitStale();
      const stale = a.fitStale;
      a.layers.layer[i] = true;
      a.applyDisplay();
      a.checkFitStale();
      if (!stale) return i;
    }
    return -1;
  });
  await page.evaluate((i) => { const a = window.__jww; a.layers.forget(i >> 4); a.layers.layer[i] = false; a.afterLayerChange(true); }, k);
  await page.waitForTimeout(300);
  const s = await state();
  await page.click('#btn-fit');
  const back = await state();
  check('全体の範囲が変わらないレイヤを隠しただけなら「前の範囲」のままで、押すと元の範囲に戻る',
    k >= 0 && s.label === '前の範囲' && same(back.view, d), { k, label: s.label });
  await page.click('#btn-layers');
  await page.click('#btn-layer-jw');
  await page.click('#btn-layer-close');
  await page.waitForTimeout(200);
}

// ---------- 4i. 全体のあとで属性に切り替え（パネルの高さが変わる）、背景や色を変えても「前の範囲」のまま ----------
{
  const d = await zoomInThenFit();
  await page.click('#btn-tool-inspect');
  await page.waitForTimeout(200);
  await page.evaluate(() => { const a = window.__jww; a.setDisplay({ ...a.display, background: 'light' }); });
  await page.waitForTimeout(300);
  const s1 = await state();
  // 見える色を 1 つ隠して戻す（範囲の内側なら全体の範囲は変わらないことが多いが、変わるなら「全体」になるのが正しい）
  const colorCase = await page.evaluate(async () => {
    const a = window.__jww;
    a.hiddenGroups.add(0);
    a.afterVisibilityChange();
    a.checkFitStale();
    const changed = !a.nearView(a.fitView(a.fitBasis.bounds), a.fitView());
    const stale = a.fitStale;
    a.hiddenGroups.delete(0);
    a.afterVisibilityChange();
    a.checkFitStale();
    return { changed, stale, after: a.fitStale };
  });
  const s2 = await state();
  await page.click('#btn-fit');
  const back = await state();
  check('全体のあとで属性に切り替えて背景を変えても「前の範囲」のまま', s1.label === '前の範囲', { label: s1.label });
  check('色を隠したときは、全体の範囲が変わったときだけ「全体」に戻り、元に戻すと「前の範囲」に戻る',
    colorCase.stale === colorCase.changed && colorCase.after === false && s2.label === '前の範囲' && same(back.view, d), { colorCase, label: s2.label });
  await page.evaluate(() => { const a = window.__jww; a.setDisplay({ ...a.display, background: 'dark' }); });
  await page.click('#btn-tool-measure');
  await page.waitForTimeout(200);
}

// ---------- 4h. 読み込んだときの全体表示のまま画面を回したり、レイヤを絞ったりして「全体」を押しても、戻る先は作らない ----------
{
  await reload();
  await page.setViewportSize({ width: 852, height: 393 });
  await page.waitForTimeout(600);
  await page.click('#btn-fit');
  const rot = await state();
  await page.setViewportSize({ width: 393, height: 660 });
  await page.waitForTimeout(600);
  await page.click('#btn-fit');
  const rot2 = await state();
  check('読み込んだときの全体表示のまま画面を回して「全体」を押しても、「前の範囲」は出ない', rot.label === '全体' && rot2.label === '全体', { rot: rot.label, rot2: rot2.label });
  await page.evaluate(() => {
    const a = window.__jww;
    const counts = a.scene.layerCounts;
    let best = 0;
    for (let k = 0; k < 256; k++) if (counts[k] > counts[best] && a.layers.visible(k)) best = k;
    a.layers.only(best);
    a.afterLayerChange(true);
  });
  await page.click('#btn-fit');
  const only = await state();
  check('全体表示のままレイヤを絞って「全体」を押しても、「前の範囲」は出ない', only.label === '全体', { label: only.label });
  await page.click('#btn-layers');
  await page.click('#btn-layer-jw');
  await page.click('#btn-layer-close');
  await page.waitForTimeout(200);
}

// ---------- 5. ボタンを押しても計測の点は増えない。図面を開き直すと戻る先は消える ----------
{
  const n0 = (await state()).n;
  await page.evaluate(() => { const a = window.__jww; a.view.zoom *= 4; a.requestDraw(true); });
  await page.click('#btn-fit');
  await page.click('#btn-fit');
  const n1 = (await state()).n;
  check('「全体」「前の範囲」を押しても計測の点は増えない', n0 === n1, { n0, n1 });
  await page.evaluate(() => { const a = window.__jww; a.view.zoom *= 4; a.requestDraw(true); });
  await page.click('#btn-fit');
  const before = (await state()).label;
  await reload();
  const s = await state();
  const kept = await page.evaluate(() => window.__jww.viewBeforeFit);
  check('図面を開き直すと、戻る先は消えてボタンは「全体」', before === '前の範囲' && s.label === '全体' && kept === null, { before, label: s.label, kept });
}
await ctx.close();

// ---------- 6. 幅の狭い画面・横向きでも「前の範囲」の文字がボタンに収まる ----------
for (const [name, opts] of [
  ['縦 320', { viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ['横 667', { viewport: { width: 667, height: 375 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
]) {
  const o = await open(opts);
  await o.page.evaluate(() => { const a = window.__jww; a.view.zoom *= 6; a.requestDraw(true); });
  await o.page.click('#btn-fit');
  const fit = await o.page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const b = document.getElementById('btn-fit');
    const span = b.querySelector('span');
    return { label: span.textContent, cut: span.scrollWidth > b.clientWidth, w: b.clientWidth, text: span.scrollWidth };
  });
  check(`${name}：「前の範囲」の文字がボタンからはみ出さない`, fit.label === '前の範囲' && !fit.cut, fit);
  await o.ctx.close();
}

check('コンソールにエラーがない', errors.length === 0, { errors: errors.slice(0, 5) });

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length ? 1 : 0);
