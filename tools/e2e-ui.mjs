// レイヤ一覧と属性のパネルを見出しのつまみで縮める／戻す、ボタンやパネルを隠して図面を画面いっぱいに見る、を確かめる。
// あわせて、図面に触れたときの扱い（置いた点の近くのタップ、取りこぼした指）、押せる大きさ、読み上げの名前、
// 図面情報のリンク、幅の狭い横画面・低い横画面でのシートとパネルの並びも確かめる。
import { chromium, devices } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { startServer, projectRoot as root } from './serve.mjs';
import { defaultSample } from './samples.mjs';

const srv = await startServer({ port: 5322, host: false, quiet: true });
const sample = process.argv[2] || defaultSample();

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

/**
 * 見出しを指（マウス）で dy だけ上下（dx だけ左右）にずらす。ふだんはつまみのすぐ下、ボタンのない所をつかむ。
 * from を渡せば、その要素の真ん中（つまみなど）をつかむ
 */
const dragHead = async (page, headSel, dy, { dx = 0, from = null } = {}) => {
  const at = await page.evaluate(([sel, from]) => {
    if (from) {
      const g = document.querySelector(from).getBoundingClientRect();
      return { x: g.left + g.width / 2, y: g.top + g.height / 2 };
    }
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.left + 40, y: r.top + r.height / 2 };
  }, [headSel, from]);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(at.x + (dx * i) / 6, at.y + (dy * i) / 6);
  await page.mouse.up();
  // 指を離したあと、パネルが元の位置へ戻る動き（0.18 秒）が終わるのを待つ（重いときは遅れるので、動きが止まるまで）
  await page.waitForTimeout(300);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 3000 }).catch(() => {});
  await frame(page);
};

/** 横向きで開いたシートの左に、計測のパネルがはみ出して見える（押せる）か */
const behindSheet = (page) => page.evaluate(() => {
  const ro = document.getElementById('readout').getBoundingClientRect();
  const sheet = document.getElementById('layer-panel').getBoundingClientRect();
  const hit = document.elementFromPoint(Math.min(ro.left + 6, sheet.left - 1), ro.bottom - 20);
  return {
    roLeft: ro.left, sheetLeft: sheet.left,
    onPanel: !!hit?.closest('#readout, #inspect-panel'),
    vis: getComputedStyle(document.getElementById('readout')).visibility,
  };
});

/** 要素の真ん中を押したときに、その要素（の中）に当たらないもの（ほかのものに覆われているもの）の id */
const covered = (page, ids) => page.evaluate((ids) => ids.filter((id) => {
  const n = document.getElementById(id);
  const r = n.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !hit || !n.contains(hit);
}), ids);

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
  // 縮めた見出しは、計測のパネルとツールバーの上に浮かび、どちらのボタンも押せる
  const roTop = await page.evaluate(() => document.getElementById('readout').getBoundingClientRect().top);
  const under = await covered(page, ['btn-tool-measure', 'btn-tool-inspect', 'btn-layers', 'btn-display', 'btn-fit', 'btn-scale', 'btn-ortho', 'btn-color', 'seg-mode']);
  check('縦向きでレイヤ一覧の見出しを押すと、見出しだけに縮み、計測のパネルとツールバーの上に浮かぶ（どのボタンも押せる）',
    open0.shown && open0.bodyShown && tapped.collapsed && !tapped.bodyShown && tapped.h < 90
      && tapped.bottom <= roTop + 1 && roTop - tapped.bottom < 16 && under.length === 0,
    { open0, tapped, roTop, under });
  // 縮めたまま色の一覧を開いても、色の丸は縮めた見出しに隠れず押せる
  await page.click('#btn-color');
  await frame(page);
  const dots = await page.evaluate(() => [...document.querySelectorAll('#color-pop button')].filter((b) => {
    const r = b.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) !== b;
  }).length);
  await page.click('#btn-color');
  check('縦向きで縮めたレイヤ一覧があっても、色の一覧の 8 色とも押せる', dots === 0, { hidden: dots });
  // 縮めた見出しのすぐ上に 1 点目を置いても、伸びた計測のパネルと一緒に上がる見出しに隠れない
  await page.waitForTimeout(500);
  const headTop = await page.evaluate(() => document.getElementById('layer-panel').getBoundingClientRect().top);
  await page.touchscreen.tap(200, headTop - 10);
  await page.waitForTimeout(400);
  const placed = await page.evaluate(() => {
    const a = window.__jww;
    const p = a.points[0];
    const out = {
      n: a.points.length,
      sy: p ? a.cssH / 2 - ((p.y - a.view.cy) * a.view.zoom) / a.dpr : null,
      top: document.getElementById('layer-panel').getBoundingClientRect().top,
    };
    a.points = [];
    a.updateReadout();
    return out;
  });
  check('縮めたレイヤ一覧のすぐ上に 1 点目を置いても、パネルと一緒に上がる見出しに点が隠れない',
    placed.n === 1 && placed.sy !== null && placed.sy < placed.top, placed);
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
  // 横になでただけでは、押したことにしない（縮めない）
  await dragHead(page, '#layer-panel .sheet-head', 0, { dx: 160 });
  const side = await panel(page, 'layer-panel', '.sheet-body');
  check('見出しを横になでただけでは、縮めも戻しもしない', !side.collapsed && side.bodyShown, side);

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
  // 見た目の手がかりのつまみを触ったときも、見出しをつかめる
  const grab = await page.evaluate(() => {
    const r = document.querySelector('#inspect-panel .grab').getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { onHead: !!hit?.closest('#inspect-panel .panel-top'), hit: hit?.id || hit?.className || null };
  });
  check('属性のパネルのつまみの所は、見出し（ずらすと縮む所）に当たる', grab.onHead, grab);
  await dragHead(page, '#inspect-panel .panel-top', 120, { from: '#inspect-panel .grab' });
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
  // 縮めたまま計測に切り替えて戻ると、属性のパネルは縮めずに出す（長さや線色の行が隠れたままにならない）
  await dragHead(page, '#inspect-panel .panel-top', 120);
  const ins3 = await panel(page, 'inspect-panel', '#inspect-body');
  await page.click('#btn-tool-measure');
  await page.click('#btn-tool-inspect');
  await frame(page);
  const ins4 = await panel(page, 'inspect-panel', '#inspect-body');
  check('属性のパネルを縮めたまま計測に切り替えて戻ると、縮めずに出す', ins3.collapsed && !ins4.collapsed && ins4.bodyShown, { ins3, ins4 });
  // 縮めたレイヤ一覧を載せたまま図形を選んでも、選んだ図形は、伸びた属性のパネルと一緒に上がる見出しの下に隠れない
  await page.click('#btn-layers');
  await frame(page);
  await page.click('#layer-panel .sheet-head strong');
  await frame(page);
  const underHead = await page.evaluate(async () => {
    const a = window.__jww;
    const two = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const s = a.scene;
    let j = 0;
    while (j < s.lineEntity.length && !(s.entities.kind[s.lineEntity[j]] === 0 && a.entityVisible(s.lineEntity[j]))) j++;
    if (j >= s.lineEntity.length) return null;
    const i = s.lineEntity[j];
    const [x1, y1, x2, y2] = s.linePos.slice(j * 4, j * 4 + 4);
    // 選んだときの並び（属性のパネルが伸び、縮めた見出しがその上に載る）を測ってから、選ぶのをやめる
    a.select(i);
    await two();
    const head = document.getElementById('layer-panel').getBoundingClientRect();
    a.select(-1);
    await two();
    // 線を画面で 30px ほどの長さにして、選んだときに見出しが来る所に置いてから選ぶ
    const zoom = (30 * a.dpr) / Math.max(Math.hypot(x2 - x1, y2 - y1), 1e-9);
    const sy = head.top + head.height / 2;
    a.view = { zoom, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 - (a.cssH / 2 - sy) * (a.dpr / zoom) };
    a.requestDraw(true);
    await two();
    a.select(i);
    await two();
    const toY = (y) => a.cssH / 2 - ((y - a.view.cy) * a.view.zoom) / a.dpr;
    return { placed: sy, bottom: Math.max(toY(y1), toY(y2)), headTop: document.getElementById('layer-panel').getBoundingClientRect().top };
  });
  check('縮めたレイヤ一覧を載せたまま図形を選んでも、選んだ図形はその見出しの下に隠れない（縦向き）',
    !!underHead && underHead.bottom < underHead.headTop, underHead);
  await page.click('#btn-layer-close');
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
  // 隠しているあいだは見るだけ：図面を押しても点を置かず（値が見えないので）、戻し方を知らせる
  const n0 = await page.evaluate(() => window.__jww.points.length);
  await page.touchscreen.tap(200, 330);
  await page.waitForTimeout(250);
  const tapHidden = await page.evaluate(() => ({
    n: window.__jww.points.length,
    hint: document.getElementById('hint').textContent,
    shown: !document.getElementById('hint').classList.contains('hidden'),
  }));
  check('ボタンを隠しているあいだに図面を押しても点を置かず、戻し方を知らせる',
    tapHidden.n === n0 && tapHidden.shown && tapHidden.hint.includes('見るだけ'), { n0, ...tapHidden });
  // 長押ししても拡大鏡を出さず、指を離しても点を置かない（指す必要がないので）
  const held = await page.evaluate(async () => {
    const a = window.__jww;
    const stage = document.getElementById('stage');
    const base = { pointerId: 51, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: 200, clientY: 330 };
    const n = a.points.length;
    stage.dispatchEvent(new PointerEvent('pointerdown', base));
    await new Promise((r) => setTimeout(r, 450));
    const during = { holding: a.holding, magnifier: a.magnifier };
    stage.dispatchEvent(new PointerEvent('pointerup', base));
    return { ...during, added: a.points.length - n };
  });
  check('ボタンを隠しているあいだは、長押ししても拡大鏡を出さず、点も置かない', !held.holding && !held.magnifier && held.added === 0, held);
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

  // 寄せた所から「全体」→ ボタンを隠す → 横向きに回す → 戻す：「前の範囲」の囲いは、押して戻ったときに映る所と同じ
  await page.click('#btn-fit');
  await frame(page);
  await page.click('#btn-ui-hide');
  await frame(page);
  await page.setViewportSize({ width: 852, height: 393 });
  await page.waitForTimeout(500);
  await frame(page);
  await page.click('#btn-ui-show');
  await frame(page);
  const outline = await page.evaluate(() => {
    const a = window.__jww;
    return { rect: a.backRect && { ...a.backRect }, label: document.querySelector('#btn-fit span').textContent };
  });
  await page.click('#btn-fit');
  await frame(page);
  const seen = await page.evaluate(() => { const a = window.__jww; return a.visibleRect(a.view); });
  const ratio = (b) => b && (b.maxX - b.minX) / (b.maxY - b.minY);
  const sameRect = !!outline.rect && ['minX', 'maxX', 'minY', 'maxY'].every((k) => Math.abs(outline.rect[k] - seen[k]) <= 1e-6 * Math.max(1, Math.abs(seen[k])));
  check('ボタンを隠したまま画面を回して戻しても、「前の範囲」の囲いは、押して戻ったときに映る所と同じになる',
    outline.label === '前の範囲' && sameRect, { label: outline.label, rect: ratio(outline.rect), seen: ratio(seen) });
  await ctx.close();
}

// ---------- 6. 横向き：縮めたレイヤ一覧は、見出しだけを右下に残す ----------
{
  const { ctx, page } = await open({ viewport: { width: 852, height: 393 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.click('#btn-layers');
  await frame(page);
  const o = await panel(page, 'layer-panel', '.sheet-body');
  const sliver = await behindSheet(page);
  check('横向き 852 でシートを開いているあいだは、シートの左にはみ出す計測のパネルを見せず、押せない', sliver.vis === 'hidden' && !sliver.onPanel, sliver);
  await dragHead(page, '#layer-panel .sheet-head', 120);
  const c = await panel(page, 'layer-panel', '.sheet-body');
  const ro = await page.evaluate(() => {
    const r = document.getElementById('readout').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vis: getComputedStyle(document.getElementById('readout')).visibility };
  });
  const cw = await page.evaluate(() => {
    const r = document.getElementById('layer-panel').getBoundingClientRect();
    return { left: r.left, right: r.right };
  });
  check('横向きでも、レイヤ一覧の見出しを下へずらすと見出しだけになり、右下の計測のパネルの上に載る（重ならない・幅がそろう）',
    o.bodyShown && c.collapsed && !c.bodyShown && c.top > c.vh * 0.4 && c.bottom <= ro.top + 1 && ro.top - c.bottom < 16
      && ro.vis === 'visible' && Math.abs(cw.left - ro.left) < 1 && Math.abs(cw.right - ro.right) < 1, { o, c, ro, cw });
  // 縮めた一覧は色の一覧と同じ所に来るが、色の一覧を開いているあいだは色の丸が前に出て、8 色とも押せる
  await page.click('#btn-color');
  await frame(page);
  const dots = await page.evaluate(() => [...document.querySelectorAll('#color-pop button')].filter((b) => {
    const r = b.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) !== b;
  }).length);
  await page.click('#color-pop button[data-color="orange"]');
  await frame(page);
  const picked = await page.evaluate(() => ({
    color: window.__jww.measurePrefs.color,
    collapsed: document.getElementById('layer-panel').classList.contains('collapsed'),
    open: !document.getElementById('layer-panel').classList.contains('hidden'),
  }));
  check('横向きで縮めたレイヤ一覧があっても、色の一覧の 8 色とも押せ、選べる（レイヤ一覧は縮めたまま）',
    dots === 0 && picked.color === 'orange' && picked.collapsed && picked.open, { hidden: dots, picked });
  // ダイナミックアイランドの側（ツールバーの列の反対側）の端で長押ししても、拡大鏡は安全領域に入れない
  const island = await page.evaluate(async () => {
    const a = window.__jww;
    const root = document.documentElement.style;
    root.setProperty('--safe-left', '59px');
    root.setProperty('--safe-right', '59px');
    a.cssW = 0;
    a.resize();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const rail = document.documentElement.dataset.rail;
    a.insets = a.measureInsets(true);
    const box = rail === 'left' ? a.placeMagnifier(a.cssW - 70, 300) : a.placeMagnifier(70, 300);
    root.removeProperty('--safe-left');
    root.removeProperty('--safe-right');
    a.cssW = 0;
    a.resize();
    return { rail, box, cssW: a.cssW };
  });
  const islandClear = island.rail === 'left' ? island.box.x + island.box.size <= island.cssW - 59 : island.box.x >= 59;
  check('横向きで、ダイナミックアイランドの側の端で長押ししても、拡大鏡を安全領域に入れない', islandClear, island);
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

// ---------- 7. 図面に触れたときの扱い（置いた点の近くのタップ、取りこぼした指）・押せる大きさ・読み上げの名前 ----------
{
  const { ctx, page } = await open({ ...devices['iPhone 14 Pro'], hasTouch: true });
  // 図面を小さくして、吸着先のない所（押した所にそのまま点が乗る所）を探す
  const spot = await page.evaluate(() => {
    const a = window.__jww;
    a.view = { ...a.view, zoom: a.view.zoom / 4 };
    a.requestDraw(true);
    const area = a.visibleArea();
    for (let y = area.top + 80; y < (area.top + area.bottom) / 2; y += 11) {
      for (let x = 40; x < a.cssW - 120; x += 13) {
        const free = [[0, 0], [15, 0], [60, 0], [0, -60], [15, -60], [60, 30]].every(([dx, dy]) => a.snapFor(x + dx, y + dy, null)?.kind === 'free');
        if (free) return { x, y };
      }
    }
    return null;
  });
  check('吸着先のない所が見つかる（以下の確かめの前提）', spot !== null, { spot });
  if (spot) {
    const pts = () => page.evaluate(() => window.__jww.points.map((p) => [p.x, p.y]));
    await page.touchscreen.tap(spot.x, spot.y);
    await page.waitForTimeout(250);
    const a0 = await pts();
    // 置いた点から 15px の所（つまむ範囲 24px の中）を軽く押す
    await page.touchscreen.tap(spot.x + 15, spot.y);
    await page.waitForTimeout(250);
    const a1 = await pts();
    check('置いた点のすぐ近くを軽く押すと、その点は動かさず、押した所に新しい点を足す',
      a0.length === 1 && a1.length === 2 && a1[0][0] === a0[0][0] && a1[0][1] === a0[0][1], { a0, a1 });
    // つまんでずらせば、その点を置き直す
    await page.evaluate(async ([x, y]) => {
      const stage = document.getElementById('stage');
      const base = { pointerId: 41, pointerType: 'touch', isPrimary: true, bubbles: true };
      stage.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x, clientY: y }));
      for (let i = 1; i <= 6; i++) {
        stage.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x, clientY: y - 10 * i }));
        await new Promise((r) => setTimeout(r, 16));
      }
      stage.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: x, clientY: y - 60 }));
    }, [spot.x, spot.y]);
    await page.waitForTimeout(150);
    const a2 = await pts();
    check('置いた点をつまんでずらすと、その点を置き直す（点は増えない）',
      a2.length === 2 && (a2[0][0] !== a1[0][0] || a2[0][1] !== a1[0][1]) && a2[1][0] === a1[1][0] && a2[1][1] === a1[1][1], { a1, a2 });

    // 指の終わり（pointerup）を取りこぼしても、次のタップで点を置ける（古い指の記録でピンチ扱いにならない）
    const stale = await page.evaluate(async ([x, y]) => {
      const a = window.__jww;
      const stage = document.getElementById('stage');
      stage.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 77, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: x, clientY: y }));
      // 長押しの拡大鏡が出るまで待つ（そのまま指の終わりが届かなかったことにする）
      await new Promise((r) => setTimeout(r, 350));
      return { pointers: a.pointers.size, holding: a.holding, n: a.points.length };
    }, [spot.x + 60, spot.y + 30]);
    await page.touchscreen.tap(spot.x + 60, spot.y + 30);
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => ({ pointers: window.__jww.pointers.size, holding: window.__jww.holding, n: window.__jww.points.length }));
    check('指の終わりを取りこぼしても、次のタップで点を置け、拡大鏡も残らない',
      stale.pointers === 1 && stale.holding && after.n === stale.n + 1 && after.pointers === 0 && !after.holding, { stale, after });
    // アプリを離れたときも、途中の指の記録を捨てる
    const left = await page.evaluate(() => {
      const a = window.__jww;
      document.getElementById('stage').dispatchEvent(new PointerEvent('pointerdown', { pointerId: 78, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: 120, clientY: 200 }));
      const during = a.pointers.size;
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      const out = a.pointers.size;
      delete document.visibilityState;
      return { during, out, holding: a.holding };
    });
    check('アプリを離れると、途中の指の記録と長押しを捨てる', left.during === 1 && left.out === 0 && !left.holding, left);
  }

  // 押せる所は見た目より少し広い（上のバーの ⤢・i と、距離・面積・体積・角度）
  const reach = await page.evaluate(() => {
    const btns = [document.getElementById('btn-ui-hide'), document.getElementById('btn-info'), ...document.querySelectorAll('#seg-mode button')];
    return btns.filter((b) => {
      const r = b.getBoundingClientRect();
      const x = r.left + r.width / 2;
      return ![r.top - 4, r.bottom + 4].every((y) => document.elementFromPoint(x, y)?.closest('button') === b);
    }).map((b) => b.id || b.textContent);
  });
  check('上のバーの ⤢・i と、距離・面積・体積・角度は、見た目の少し外（4px）を押しても押せる', reach.length === 0, { reach });
  // 消去（点をすべて消す）は押し間違えないよう、戻すとの間と、下の段の方へは広げない
  const clearZone = await page.evaluate(() => {
    const u = document.getElementById('btn-undo').getBoundingClientRect();
    const c = document.getElementById('btn-clear').getBoundingClientRect();
    const at = (x, y) => document.elementFromPoint(x, y)?.closest('button')?.id ?? null;
    return { shown: c.height > 0, gap: at((u.right + c.left) / 2, c.top + c.height / 2), below: at(c.left + c.width / 2, c.bottom + 3) };
  });
  check('戻すと消去の間と、消去のすぐ下を押しても、消去は押されない',
    clearZone.shown && clearZone.gap !== 'btn-clear' && clearZone.gap !== 'btn-undo' && clearZone.below !== 'btn-clear', clearZone);

  // 読み上げの名前：縮尺のボタンはいまの縮尺まで読み、直交は見えている文字で始まる。知らせと値は読み上げる
  const names = {
    scale: await page.getByRole('button', { name: /^計測に使う縮尺 1\/\d/ }).count(),
    ortho: await page.getByRole('button', { name: /^直交/ }).count(),
    hint: await page.getAttribute('#hint', 'role'),
    value: await page.getAttribute('#readout-value', 'aria-live'),
  };
  check('縮尺のボタンは「計測に使う縮尺」といまの縮尺を読み、直交は「直交」で始まる名前。知らせと値は読み上げる',
    names.scale === 1 && names.ortho === 1 && names.hint === 'status' && names.value === 'polite', names);

  // 図面情報：プライバシーポリシーとサポートへの案内がある
  await page.click('#btn-info');
  await frame(page);
  const info = await page.evaluate(() => ({
    links: [...document.querySelectorAll('#info-body .about-links a')].map((a) => ({ href: a.href, target: a.target, rel: a.rel })),
  }));
  check('図面情報に、プライバシーポリシーとサポートへの案内があり、新しいタブ（iOS アプリでは Safari）で開く',
    info.links.length === 2 && info.links.some((l) => l.href === 'https://takejiyuuri.github.io/jww-viewer/privacy.html')
      && info.links.some((l) => l.href === 'https://takejiyuuri.github.io/jww-viewer/support.html')
      && info.links.every((l) => l.target === '_blank' && l.rel.includes('noopener')), info.links);
  await page.click('#btn-info-close');

  // ホーム画面から開いた Web 版で白背景のときだけ、ステータスバーの所に暗い帯を敷く
  const band = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const bg = body.dataset.bg;
    const before = () => {
      const s = getComputedStyle(body, '::before');
      return { content: s.content, h: s.height, color: s.backgroundColor };
    };
    root.classList.add('standalone');
    root.style.setProperty('--safe-top', '47px');
    body.dataset.bg = 'light';
    const web = before();
    body.dataset.bg = 'dark';
    const dark = before().content;
    body.dataset.bg = 'light';
    root.classList.add('native');
    const native = before().content;
    root.classList.remove('standalone', 'native');
    const safari = before().content;
    root.style.removeProperty('--safe-top');
    body.dataset.bg = bg;
    return { web, dark, native, safari };
  });
  check('ホーム画面の Web 版で白背景のときだけ、ステータスバーの所に暗い帯を敷く（iOS アプリ・Safari・黒背景では敷かない）',
    band.web.content !== 'none' && band.web.h === '47px' && band.web.color === 'rgb(11, 12, 16)'
      && band.dark === 'none' && band.native === 'none' && band.safari === 'none', band);
  await ctx.close();
}

// ---------- 8. 幅の狭い横画面（568）：レイヤ一覧が収まり、開いたシートの左に計測のパネルがはみ出さない ----------
{
  const { ctx, page } = await open({ viewport: { width: 568, height: 320 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.click('#btn-layers');
  // すべてのグループを開いて、すべてのレイヤの行を並べる
  await page.evaluate(() => {
    const a = window.__jww;
    for (let g = 0; g < 16; g++) a.expandedGroups.add(g);
    a.buildLayerPanel();
  });
  await page.waitForTimeout(200);
  const rows = await page.evaluate(() => {
    const sheet = document.getElementById('layer-panel').getBoundingClientRect();
    const body = document.querySelector('#layer-panel .sheet-body');
    const names = [...document.querySelectorAll('#layer-list .lname')].filter((n) => !n.closest('[hidden]')).map((n) => n.getBoundingClientRect().width);
    const out = (sel) => [...document.querySelectorAll(sel)].filter((n) => n.getBoundingClientRect().right > sheet.right - 1).length;
    return {
      width: sheet.width, n: names.length, minName: Math.min(...names),
      scroll: body.scrollWidth - body.clientWidth, swOut: out('#layer-list .sw'), chipOut: out('#layer-panel .section-actions .chip'),
    };
  });
  check('幅の狭い横画面（568）でも、レイヤ一覧は横にはみ出さず、レイヤ名が残り、スイッチとボタンが枠の中に収まる',
    rows.n > 0 && rows.scroll <= 1 && rows.minName >= 20 && rows.swOut === 0 && rows.chipOut === 0, rows);
  const sliver = await behindSheet(page);
  check('横向き 568 でシートを開いているあいだは、シートの左にはみ出す計測のパネルを見せず、押せない', sliver.vis === 'hidden' && !sliver.onPanel, sliver);
  await ctx.close();
}

// ---------- 9. 低い横画面で属性のパネルが高くても、縮めたレイヤ一覧は上のバーにかからない ----------
{
  const { ctx, page } = await open({ viewport: { width: 852, height: 320 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.click('#btn-tool-inspect');
  await page.evaluate(() => {
    const a = window.__jww;
    for (let i = 0; i < a.scene.entities.count; i++) {
      if (a.entityVisible(i)) { a.select(i); break; }
    }
    // 行の多い図形（長い文字など）の代わりに、行を足して属性のパネルをいちばん高くする
    document.getElementById('inspect-body').insertAdjacentHTML('beforeend', '<span class="k">行</span><span class="v">あ</span>'.repeat(30));
  });
  await page.click('#btn-layers');
  await frame(page);
  await dragHead(page, '#layer-panel .sheet-head', 120);
  await page.waitForTimeout(200);
  await frame(page);
  const r = await page.evaluate(() => {
    const l = document.getElementById('layer-panel').getBoundingClientRect();
    const p = document.getElementById('inspect-panel').getBoundingClientRect();
    const bar = document.getElementById('btn-info').getBoundingClientRect();
    return {
      collapsed: document.getElementById('layer-panel').classList.contains('collapsed'),
      layerTop: l.top, layerBottom: l.bottom, panelTop: p.top, barBottom: bar.bottom,
    };
  });
  const under = await covered(page, ['btn-info', 'btn-ui-hide', 'btn-open', 'btn-layer-undo', 'btn-layer-redo']);
  check('低い横画面で属性のパネルが高くても、縮めたレイヤ一覧は上のバーにかからず（⤢・i が押せる）、属性のパネルの上に載る',
    r.collapsed && r.layerTop >= r.barBottom && r.layerBottom <= r.panelTop + 1 && under.length === 0, { ...r, under });
  await ctx.close();
}

check('コンソールにエラーがない', errors.length === 0, { errors: errors.slice(0, 5) });

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length ? 1 : 0);
