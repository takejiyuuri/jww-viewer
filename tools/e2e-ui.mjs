// レイヤ一覧と属性のパネルを見出しのつまみで縮める／戻す、ボタンやパネルを隠して図面を画面いっぱいに見る、を確かめる。
import { chromium, devices } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { startServer, projectRoot as root } from './serve.mjs';

const srv = await startServer({ port: 5322, host: false, quiet: true });
const sample = process.argv[2] || path.join(root, 'samples', fs.readdirSync(path.join(root, 'samples')).find((f) => f.endsWith('.jww')));

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
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

const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** パネルの大きさと、中身が見えているか */
const panel = (page, id, bodySel) => page.evaluate(([id, bodySel]) => {
  const p = document.getElementById(id);
  const r = p.getBoundingClientRect();
  const body = p.querySelector(bodySel);
  return {
    shown: !p.classList.contains('hidden') && r.height > 0,
    collapsed: p.classList.contains('collapsed'),
    top: r.top, bottom: r.bottom, h: r.height,
    bodyShown: !!body && body.getBoundingClientRect().height > 0,
    vh: innerHeight,
  };
}, [id, bodySel]);

/** 見出しを指（マウス）で dy だけ上下にずらす。つまみのすぐ下、ボタンのない所をつかむ */
const dragHead = async (page, headSel, dy) => {
  const at = await page.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.left + 40, y: r.top + r.height / 2 };
  }, headSel);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(at.x, at.y + (dy * i) / 6);
  await page.mouse.up();
  // 指を離したあと、パネルが元の位置へ戻る動き（0.18 秒）が終わるのを待つ
  await page.waitForTimeout(300);
  await frame(page);
};

// ---------- 1. レイヤ一覧：見出しを押すと縮み、もう一度押すと戻る ----------
{
  const { ctx, page } = await open({ ...devices['iPhone 14 Pro'], hasTouch: true });
  await page.click('#btn-layers');
  await frame(page);
  const open0 = await panel(page, 'layer-panel', '.sheet-body');
  // 見出しの「レイヤ」の文字を押す
  await page.click('#layer-panel .sheet-head strong');
  await frame(page);
  const tapped = await panel(page, 'layer-panel', '.sheet-body');
  check('レイヤ一覧の見出しを押すと、見出しだけに縮む（下に寄せたまま）',
    open0.shown && open0.bodyShown && tapped.collapsed && !tapped.bodyShown && tapped.h < 90 && Math.abs(tapped.bottom - open0.bottom) < 2,
    { open0, tapped });
  await page.click('#layer-panel .sheet-head strong');
  await frame(page);
  const back = await panel(page, 'layer-panel', '.sheet-body');
  check('縮めたレイヤ一覧の見出しを押すと元に戻る', !back.collapsed && back.bodyShown && Math.abs(back.h - open0.h) < 2, back);

  // ---------- 2. 見出しを下へずらすと縮み、上へずらすと戻る ----------
  await dragHead(page, '#layer-panel .sheet-head', 140);
  const down = await panel(page, 'layer-panel', '.sheet-body');
  check('レイヤ一覧の見出しを下へずらすと縮む', down.collapsed && !down.bodyShown, down);
  await dragHead(page, '#layer-panel .sheet-head', -80);
  const up = await panel(page, 'layer-panel', '.sheet-body');
  check('縮めたレイヤ一覧の見出しを上へずらすと戻る', !up.collapsed && up.bodyShown, up);
  // 少しずらしただけなら縮めない（元の位置へ戻る）
  await dragHead(page, '#layer-panel .sheet-head', 20);
  const small = await page.evaluate(() => ({
    collapsed: document.getElementById('layer-panel').classList.contains('collapsed'),
    transform: document.getElementById('layer-panel').style.transform,
  }));
  check('見出しを少しずらしただけなら縮めず、元の位置へ戻る', !small.collapsed && small.transform === '', small);

  // ---------- 3. 縮めても見出しのボタンは押せる。開き直すと元の大きさ ----------
  await page.click('#layer-panel .sheet-head strong');
  await frame(page);
  await page.click('#btn-layer-close');
  const closed = await panel(page, 'layer-panel', '.sheet-body');
  await page.click('#btn-layers');
  await frame(page);
  const reopened = await panel(page, 'layer-panel', '.sheet-body');
  check('縮めたままでも「閉じる」は押せ、開き直すと元の大きさで出る', !closed.shown && reopened.shown && !reopened.collapsed && reopened.bodyShown, { closed, reopened });
  await page.click('#btn-layer-close');

  // ---------- 4. 属性のパネル：見出しを下へずらすと縮み、見出し（種類）は見えたまま ----------
  await page.click('#btn-tool-inspect');
  await page.evaluate(() => {
    const a = window.__jww;
    for (let i = 0; i < a.scene.entities.count; i++) {
      if (a.entityVisible(i)) { a.select(i); break; }
    }
  });
  await frame(page);
  const ins0 = await panel(page, 'inspect-panel', '#inspect-body');
  await dragHead(page, '#inspect-panel .panel-top', 120);
  const ins1 = await panel(page, 'inspect-panel', '#inspect-body');
  const kind = await page.evaluate(() => {
    const k = document.getElementById('inspect-kind');
    return { text: k.textContent, h: k.getBoundingClientRect().height };
  });
  check('属性のパネルの見出しを下へずらすと、見出し（種類とレイヤ）だけに縮む',
    ins0.bodyShown && ins1.collapsed && !ins1.bodyShown && ins1.h < ins0.h - 40 && kind.h > 0 && kind.text.length > 0,
    { ins0, ins1, kind });
  // 縮めたあいだも、見えている範囲（拡大鏡・全体表示）は縮めたパネルに合わせる
  const insets = await page.evaluate(() => {
    const a = window.__jww;
    const r = document.getElementById('inspect-panel').getBoundingClientRect();
    return { bottom: a.measureInsets().bottom, panelTop: r.top, cssH: a.cssH };
  });
  check('縮めた属性のパネルの分だけ、見えている範囲が広がる', Math.abs(insets.cssH - insets.bottom - (insets.panelTop - 8)) < 2, insets);
  await page.click('#inspect-panel .panel-top #inspect-kind');
  await frame(page);
  const ins2 = await panel(page, 'inspect-panel', '#inspect-body');
  check('縮めた属性のパネルの見出しを押すと元に戻る', !ins2.collapsed && ins2.bodyShown, ins2);
  await page.click('#btn-tool-measure');

  // ---------- 5. ボタンを隠す：全体を見ていたなら、広くなった画面に合わせて図面を大きくする ----------
  // 属性で図形を選んだときに図面が少し動いたので、全体の表示に戻してから始める
  await page.evaluate(() => { window.__jww.fit(); });
  await frame(page);
  const before = await page.evaluate(() => ({ ...window.__jww.view }));
  await page.click('#btn-ui-hide');
  await frame(page);
  const hidden = await page.evaluate(() => {
    const shown = (id) => {
      const n = document.getElementById(id);
      return !!n && n.getBoundingClientRect().height > 0 && getComputedStyle(n).display !== 'none';
    };
    const a = window.__jww;
    const fitNow = a.fitView();
    return {
      topbar: shown('topbar'), toolbar: shown('toolbar'), readout: shown('readout'), show: shown('btn-ui-show'),
      zoom: a.view.zoom, area: a.visibleArea(), cssW: a.cssW, cssH: a.cssH,
      refit: Math.abs(a.view.zoom / fitNow.zoom - 1) < 1e-9 && Math.abs(a.view.cx - fitNow.cx) < 1e-6 && Math.abs(a.view.cy - fitNow.cy) < 1e-6,
    };
  });
  check('ボタンを隠すと、上のバー・ツールバー・計測のパネルが消え、戻すボタンだけ出る',
    !hidden.topbar && !hidden.toolbar && !hidden.readout && hidden.show, hidden);
  // 縦向きの横長の図面は幅で大きさが決まるので、大きさは同じまま、広くなった画面の真ん中に合わせ直す
  check('全体を見ていたときにボタンを隠すと、広くなった画面に合わせて全体を表示し直す（縦向き）',
    hidden.refit && hidden.zoom >= before.zoom * 0.999, { before: before.zoom, after: hidden.zoom, refit: hidden.refit });
  check('ボタンを隠しているあいだは、見えている範囲が画面のほぼ全体になる',
    hidden.area.bottom > hidden.cssH - 12 && hidden.area.right >= hidden.cssW - 1 && hidden.area.top < 80, hidden.area);
  await page.click('#btn-ui-show');
  await frame(page);
  const restored = await page.evaluate(() => ({
    topbar: document.getElementById('topbar').getBoundingClientRect().height > 0,
    toolbar: document.getElementById('toolbar').getBoundingClientRect().height > 0,
    show: getComputedStyle(document.getElementById('btn-ui-show')).display !== 'none',
    zoom: window.__jww.view.zoom,
  }));
  check('戻すボタンで元の表示に戻り、図面も元の全体の大きさに戻る',
    restored.topbar && restored.toolbar && !restored.show && Math.abs(restored.zoom / before.zoom - 1) < 0.01, { restored, before: before.zoom });

  // 寄せて見ているときにボタンを隠しても、見ている所は変えない
  await page.evaluate(() => { const a = window.__jww; a.view = { ...a.view, zoom: a.view.zoom * 5 }; a.requestDraw(true); });
  await frame(page);
  const detail = await page.evaluate(() => ({ ...window.__jww.view }));
  await page.click('#btn-ui-hide');
  await frame(page);
  const detail2 = await page.evaluate(() => ({ ...window.__jww.view }));
  check('寄せて見ているときにボタンを隠しても、見ている所と大きさは変えない',
    detail2.zoom === detail.zoom && detail2.cx === detail.cx && detail2.cy === detail.cy, { detail, detail2 });
  await page.click('#btn-ui-show');
  await ctx.close();
}

// ---------- 6. 横向き：縮めたレイヤ一覧は、見出しだけを右下に残す ----------
{
  const { ctx, page } = await open({ viewport: { width: 852, height: 393 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.click('#btn-layers');
  await frame(page);
  const o = await panel(page, 'layer-panel', '.sheet-body');
  await dragHead(page, '#layer-panel .sheet-head', 120);
  const c = await panel(page, 'layer-panel', '.sheet-body');
  const ro = await page.evaluate(() => {
    const r = document.getElementById('readout').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  check('横向きでも、レイヤ一覧の見出しを下へずらすと見出しだけになり、右下の計測のパネルの上に載る（重ならない）',
    o.bodyShown && c.collapsed && !c.bodyShown && c.top > c.vh * 0.4 && c.bottom <= ro.top + 1 && ro.top - c.bottom < 16, { o, c, ro });
  // 横向きでボタンを隠すと、ツールバーの列も消え、高さで大きさの決まる図面は大きくなる
  await page.click('#btn-layer-close');
  await page.evaluate(() => { window.__jww.fit(); });
  await frame(page);
  const z0 = await page.evaluate(() => window.__jww.view.zoom);
  await page.click('#btn-ui-hide');
  await frame(page);
  const land = await page.evaluate(() => ({
    rail: getComputedStyle(document.getElementById('toolbar')).display,
    zoom: window.__jww.view.zoom,
  }));
  check('横向きでボタンを隠すと、縦に並べたツールバーも消え、全体を見ていた図面は画面に合わせて大きくなる',
    land.rail === 'none' && land.zoom > z0 * 1.03, { ...land, z0 });
  await ctx.close();
}

check('コンソールにエラーがない', errors.length === 0, { errors: errors.slice(0, 5) });

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length ? 1 : 0);
