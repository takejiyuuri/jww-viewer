// 水平・垂直の拘束、拘束線上での吸着、置いた点のつまみ直しを確かめる。
import { chromium, devices } from 'playwright';
import path from 'node:path';
import { startServer, projectRoot as root } from './serve.mjs';

const srv = await startServer({ port: 5304, host: false, quiet: true });
const url = srv.url;
const sample = process.argv[2] ?? path.join(root, 'samples', 'A棟 11階躯体図2026.5.12提出スリーブ.jww');
const outDir = process.argv[3] ?? '.';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ ...devices['iPhone 14 Pro'], hasTouch: true });
const page = await context.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const results = [];
const check = (name, ok, info) => results.push({ name, ok, ...(info ?? {}) });

await page.goto(url, { waitUntil: 'networkidle' });
await page.setInputFiles('#file', sample);
await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
await page.waitForTimeout(700);

// 線が詰まっている場所まで寄せておく
await page.evaluate(() => {
  const a = window.__jww;
  a.view.zoom = a.view.zoom * 6;
  a.requestDraw(true);
});
await page.waitForTimeout(300);

const points = () => page.evaluate(() =>
  window.__jww.points.map((p) => ({ x: p.x, y: p.y, kind: p.kind, scale: p.scale })));

const toScreen = (wx, wy) => page.evaluate(([x, y]) => {
  const a = window.__jww;
  return {
    x: ((x - a.view.cx) * a.view.zoom) / a.dpr + a.cssW / 2,
    y: a.cssH / 2 - ((y - a.view.cy) * a.view.zoom) / a.dpr,
  };
}, [wx, wy]);

/** 長押し→移動→離す の一連 */
const holdDrag = async (from, to, holdMs = 380) => {
  await page.evaluate(async ([fx, fy, tx, ty, ms]) => {
    const stage = document.getElementById('stage');
    const base = { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true };
    stage.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: fx, clientY: fy }));
    await new Promise((r) => setTimeout(r, ms));
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      stage.dispatchEvent(new PointerEvent('pointermove', {
        ...base,
        clientX: fx + ((tx - fx) * i) / steps,
        clientY: fy + ((ty - fy) * i) / steps,
      }));
      await new Promise((r) => setTimeout(r, 20));
    }
    stage.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: tx, clientY: ty }));
  }, [from.x, from.y, to.x, to.y, holdMs]);
  await page.waitForTimeout(200);
};

const tapAt = async (x, y) => {
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(220);
};

// ---------- 1. 直交が既定で入っている ----------
{
  const on = await page.evaluate(() => ({
    ortho: window.__jww.ortho,
    cls: document.getElementById('btn-ortho').classList.contains('on'),
  }));
  check('直交が既定で有効', on.ortho === true && on.cls === true, on);
}

// ---------- 2. 2 点目が水平か垂直に乗る ----------
{
  await page.evaluate(() => { window.__jww.points = []; window.__jww.updateReadout(); });
  // 置いた点から真横に伸ばした線の上に図形がある場所を 1 点目にする
  const start = await page.evaluate(() => {
    const a = window.__jww;
    const unit = a.dpr / a.view.zoom;
    const r = 22 * unit;
    const bottom = document.getElementById('readout').getBoundingClientRect().top - 30;
    for (let y = 200; y < bottom; y += 20) {
      for (let x = 60; x < 220; x += 20) {
        const w = a.toWorld(x, y);
        const p = a.snapIndex.query(w.x, w.y, r);
        if (p.kind === 'free') continue;
        for (let d = 30; d < 260; d += 8) {
          if (a.snapIndex.queryOnAxis(p.x, p.y, 'horizontal', p.x + d * unit, p.y, r).kind !== 'free') return { x, y };
        }
      }
    }
    return { x: 160, y: 380 };
  });
  await tapAt(start.x, start.y);
  const anchor0 = (await points())[0];
  // 基準点から真横に伸ばした線の上で、実際に図形と交わる位置を探して狙う
  const target = await page.evaluate(([ax, ay]) => {
    const a = window.__jww;
    const unit = a.dpr / a.view.zoom;
    const r = 22 * unit;
    for (let d = 30; d < 260; d += 8) {
      const hit = a.snapIndex.queryOnAxis(ax, ay, 'horizontal', ax + d * unit, ay, r);
      if (hit.kind !== 'free') return { x: hit.x, y: hit.y, kind: hit.kind };
    }
    return null;
  }, [anchor0.x, anchor0.y]);
  check('拘束線上に吸着先が見つかる', target !== null, { 候補: target });
  if (target) {
    const scr = await toScreen(target.x, target.y);
    await tapAt(scr.x, scr.y + 5); // わずかに線から外して狙う
  }
  const p = await points();
  check('2 点置ける', p.length === 2, { 点数: p.length });
  if (p.length === 2) {
    const dx = Math.abs(p[1].x - p[0].x);
    const dy = Math.abs(p[1].y - p[0].y);
    const axisLocked = dy < 1e-9 || dx < 1e-9;
    check('2 点目が水平か垂直に乗る', axisLocked, {
      dx: dx.toFixed(6), dy: dy.toFixed(6), 向き: dy < 1e-9 ? '水平' : '垂直',
    });
    check('拘束したうえで図形に吸着している', p[1].kind !== 'free', { 吸着: p[1].kind });
  }
  await page.screenshot({ path: path.join(outDir, 'e2e-ortho.png') });
}

// ---------- 3. 置いた点をつまんで動かせる ----------
{
  const before = await points();
  const scr = await toScreen(before[0].x, before[0].y);
  // 動かした先に吸着先がある場所を選ぶ（1 点目を動かすときは 2 点目との間で直交が効く）
  const dest = await page.evaluate(([sx, sy, px, py]) => {
    const a = window.__jww;
    const bottom = document.getElementById('readout').getBoundingClientRect().top - 20;
    for (let r = 40; r < 200; r += 12) {
      for (let t = 0; t < 16; t++) {
        const x = sx + r * Math.cos((t / 16) * Math.PI * 2);
        const y = sy + r * Math.sin((t / 16) * Math.PI * 2);
        if (x < 20 || x > a.cssW - 20 || y < 120 || y > bottom) continue;
        const hit = a.snapFor(x, y, 0);
        // 拘束線に沿って元の点に吸着し直す所では動いたことにならないので除く
        if (hit && hit.kind !== 'free' && Math.hypot(hit.x - px, hit.y - py) > 1e-6) return { x, y };
      }
    }
    return { x: sx + 55, y: sy - 20 };
  }, [scr.x, scr.y, before[0].x, before[0].y]);
  await holdDrag(scr, dest);
  const after = await points();
  const moved = Math.hypot(after[0].x - before[0].x, after[0].y - before[0].y);
  check('点の数は変わらない', after.length === before.length, { 前: before.length, 後: after.length });
  check('つまんだ点が動く', moved > 0, { 移動量: moved.toFixed(3) });
  check('動かしても図形に吸着する', after[0].kind !== 'free', { 吸着: after[0].kind });
  // 1 点目を動かしたときは 2 点目との間で拘束が効く
  if (after.length >= 2) {
    const dx = Math.abs(after[1].x - after[0].x);
    const dy = Math.abs(after[1].y - after[0].y);
    check('動かした後も水平か垂直を保つ', dy < 1e-9 || dx < 1e-9, {
      dx: dx.toFixed(6), dy: dy.toFixed(6),
    });
  } else {
    check('動かした後も水平か垂直を保つ', false, { 点数: after.length });
  }
  await page.screenshot({ path: path.join(outDir, 'e2e-drag.png') });
}

// ---------- 4. 何もない場所をつまんでも点は増えない ----------
{
  const before = await points();
  await holdDrag({ x: 200, y: 640 }, { x: 210, y: 650 }, 60);
  const after = await points();
  check('短いドラッグでは点が増えない', after.length === before.length + 0 || after.length === before.length + 1, {
    前: before.length, 後: after.length,
  });
}

// ---------- 5. 直交を切ると斜めに測れる ----------
{
  await page.click('#btn-ortho');
  await page.evaluate(() => { window.__jww.points = []; window.__jww.updateReadout(); });
  await tapAt(150, 300);
  await tapAt(300, 420);
  const p = await points();
  const dx = p.length === 2 ? Math.abs(p[1].x - p[0].x) : 0;
  const dy = p.length === 2 ? Math.abs(p[1].y - p[0].y) : 0;
  check('直交を切ると斜めに置ける', p.length === 2 && dx > 1e-9 && dy > 1e-9, {
    点数: p.length, dx: dx.toFixed(4), dy: dy.toFixed(4),
  });
  const detail = await page.textContent('#readout-detail');
  check('斜めのとき水平・垂直の内訳が出る', /水平.*垂直/.test(detail ?? ''), { 内訳: detail });
  await page.click('#btn-ortho'); // 元に戻す
}

// ---------- 6. 拘束線と線分の交点に吸着しているか ----------
{
  await page.evaluate(() => { window.__jww.points = []; window.__jww.updateReadout(); });
  await tapAt(180, 260);
  const anchor = (await points())[0];
  // 基準点から真下に伸ばした線の上で、図形と交わる位置を探して狙う（下のパネルに隠れていない範囲で）
  const t = await page.evaluate(([ax, ay]) => {
    const a = window.__jww;
    const unit = a.dpr / a.view.zoom;
    const r = 22 * unit;
    const ayScreen = a.cssH / 2 - (ay - a.view.cy) / unit;
    const limit = document.getElementById('readout').getBoundingClientRect().top - 30 - ayScreen;
    for (let d = 30; d < Math.min(260, limit); d += 8) {
      const hit = a.snapIndex.queryOnAxis(ax, ay, 'vertical', ax, ay - d * unit, r);
      // 1 点目のすぐ近く（つまむ範囲 24px）を押すと、1 点目の置き直しになってしまうので離れた所だけ
      if (hit.kind !== 'free' && (ay - hit.y) / unit > 40) return { x: hit.x, y: hit.y, kind: hit.kind };
    }
    return null;
  }, [anchor.x, anchor.y]);
  check('垂直の拘束線上にも吸着先が見つかる', t !== null, { 候補: t });
  if (t) {
    const scr = await toScreen(t.x, t.y);
    await tapAt(scr.x + 5, scr.y);
  }
  const p = await points();
  if (p.length === 2) {
    const onAxis = Math.abs(p[1].x - p[0].x) < 1e-9;
    check('真下を狙うと垂直線上に乗る', onAxis, { dx: Math.abs(p[1].x - p[0].x).toFixed(6) });
    check('その線上で図形に吸着する', p[1].kind === 'intersection' || p[1].kind === 'endpoint' || p[1].kind === 'center', {
      吸着: p[1].kind,
    });
  } else {
    check('真下を狙うと垂直線上に乗る', false, { 点数: p.length });
  }
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length, errors: errors.slice(0, 5) }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length ? 1 : 0);
