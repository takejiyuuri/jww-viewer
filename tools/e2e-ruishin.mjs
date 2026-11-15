// 累進寸法を画面で確かめる：見本の図面を開くと列が累進に直って元の寸法値が隠れる、列をタップして選べる、
// 起点の丸をドラッグして通り芯の交点に吸着させると値が変わる、「寸法線上のみ」で寸法線の上だけを動く、
// 「同じ向きを連動」は無い（起点はその列だけ動く）、「累進表示」を切ると元に戻る。
// 最初の画面：「図面を開く」「見本の図面を開く」がすぐ押せ、操作の説明は「使い方を見る」で開閉する。
// 案内：列を選べない倍率では「拡大すると、寸法列を選べます」、戻すボタンの名前は「この列を戻す」「全列を戻す」。
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

const ZOOM_HINT = '拡大すると、寸法列を選べます';
const PICK_HINT = '列をタップして選び、起点の丸をドラッグして動かします';
/** 累進のパネルの案内文と、戻すボタンの名前 */
const panelText = () => page.evaluate(() => ({
  note: document.querySelector('#ruishin-body .note')?.textContent ?? '',
  reset: document.getElementById('btn-ruishin-reset').textContent,
  resetDisabled: document.getElementById('btn-ruishin-reset').disabled,
  active: window.__jww.activeChain,
}));

const results = [];
const check = (name, ok, info) => results.push({ name, ok, ...(info ?? {}) });

await page.goto(srv.url, { waitUntil: 'networkidle' });

// ---------- 0. 最初の画面：ファイルをすぐ開け、説明は「使い方を見る」で開閉する ----------
{
  await page.waitForFunction(() => !document.getElementById('welcome').classList.contains('hidden'), null, { timeout: 10000 });
  const state = () => page.evaluate(() => {
    const vis = (q) => { const e = document.querySelector(q); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) } : null; };
    const d = document.getElementById('welcome-howto');
    return {
      open: vis('#btn-open-2'), sample: vis('#btn-sample'), summary: vis('#welcome-howto summary'),
      summaryText: [...d.querySelectorAll('summary span')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.textContent).join(),
      expanded: d.open, tipsShown: d.querySelector('.tips li').checkVisibility(),
      tips: [...d.querySelectorAll('.tips li')].map((e) => e.textContent),
      viewH: innerHeight,
    };
  });
  const closed = await state();
  check('最初の画面：「図面を開く」のすぐ下に「見本の図面を開く」、説明は閉じていて「使い方を見る」が出る',
    closed.open && closed.sample && closed.sample.top >= closed.open.bottom && closed.sample.top - closed.open.bottom < 20
    && !closed.expanded && !closed.tipsShown && closed.summaryText === '使い方を見る' && closed.summary.h >= 44
    && closed.sample.bottom <= closed.viewH, closed);
  await page.screenshot({ path: path.join(outDir, 'ruishin-w1-welcome.png') });
  await page.click('#welcome-howto summary');
  await page.waitForTimeout(200);
  const opened = await state();
  check('「使い方を見る」で説明が開き（前の説明はすべて残る）、「使い方を閉じる」になる',
    opened.expanded && opened.tipsShown && opened.summaryText === '使い方を閉じる' && opened.tips.length === 6
    && ['1 本指でスクロール', '「累進」では', '「計測」では', '「属性」では', '「レイヤ」で', '起点は動かせます'].every((k) => opened.tips.some((t) => t.includes(k))), opened);
  await page.screenshot({ path: path.join(outDir, 'ruishin-w2-howto.png') });
  await page.click('#welcome-howto summary');
  await page.waitForTimeout(200);
  const again = await state();
  check('もう一度押すと説明が閉じる', !again.expanded && !again.tipsShown && again.summaryText === '使い方を見る', again);
}

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
  const t = await panelText();
  check('開いた直後（列を選べない倍率）は「拡大すると、寸法列を選べます」と案内し、ボタンは「全列を戻す」',
    t.note === ZOOM_HINT && t.reset === '全列を戻す', t);
}

// ---------- 1b. 縮めて見ているときは、列を選んだり起点を動かしたりしない ----------
{
  const before = await page.evaluate(() => ({ zoom: window.__jww.view.zoom, cx: window.__jww.view.cx, cy: window.__jww.view.cy }));
  await page.evaluate(() => { const a = window.__jww; a.view.zoom *= 0.3; a.view.cx = 40; a.view.cy = 30; a.requestDraw(true); });
  await page.waitForTimeout(300);
  const b0 = await page.evaluate(() => window.__jww.chains.filter((c) => c.uy === 0).sort((p, q) => p.offset - q.offset)[0]);
  const o0 = await page.evaluate((id) => window.__jww.origins.get(id), b0.id);
  const s = await toScreen(30, b0.offset);
  await tap(s.x, s.y);
  const from = await toScreen(o0.x, b0.offset);
  const to = await toScreen(45.5, 0);
  await drag(from, to);
  const after = await page.evaluate((id) => ({ active: window.__jww.activeChain, o: window.__jww.origins.get(id) }), b0.id);
  check('縮めて見ているときは列を選ばず、起点も動かない',
    after.active === -1 && after.o.x === o0.x && after.o.y === o0.y, { after, o0 });
  await page.screenshot({ path: path.join(outDir, 'ruishin-0-small.png') });
  await page.evaluate((v) => { const a = window.__jww; Object.assign(a.view, v); a.requestDraw(true); }, before);
  await page.waitForTimeout(300);
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
{
  const t = await panelText();
  check('拡大すると、列の選択と起点のドラッグを案内する', t.note === PICK_HINT && t.reset === '全列を戻す', t);
  await page.screenshot({ path: path.join(outDir, 'ruishin-1b-zoomed.png') });
}

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
  const t = await panelText();
  check('列を選んでいるときのボタンは「この列を戻す」', t.reset === 'この列を戻す', t);
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

// ---------- 4. 寸法線上のみ：寸法線の上だけを動き、通り芯との交点に吸着 ----------
{
  const btn = await page.evaluate(() => { const b = document.getElementById('btn-ruishin-along'); return { text: b.textContent, label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed') }; });
  check('ボタンの名前は「寸法線上のみ」（読み上げの説明も同じ名前）', btn.text === '寸法線上のみ' && btn.label.startsWith('寸法線上のみ') && btn.pressed === 'false', btn);
  await page.click('#btn-ruishin-along');
  const on = await page.evaluate(() => document.getElementById('btn-ruishin-along').getAttribute('aria-pressed'));
  check('「寸法線上のみ」を押すと入になる', on === 'true', { on });
  const o0 = await page.evaluate((id) => window.__jww.origins.get(id), bottom.id);
  const from = await toScreen(o0.x, bottom.offset);
  const to = await toScreen(63.7 + 0.5, bottom.offset + 3);
  await drag(from, to);
  const o = await page.evaluate((id) => window.__jww.origins.get(id), bottom.id);
  check('寸法線上のみで X4 の通り芯に吸着', Math.abs(o.x - 63.7) < 1e-3 && Math.abs(o.y - bottom.offset) < 1e-3, { o });
  await page.click('#btn-ruishin-along');
}

// ---------- 5. 起点はその列だけ動く（平行な上の列は動かない） ----------
{
  const before = (await values()).filter((c) => c.dir === 'h' && c.id !== bottom.id);
  const o0 = await page.evaluate((id) => window.__jww.origins.get(id), bottom.id);
  const from = await toScreen(o0.x, bottom.offset);
  const to = await toScreen(18.2 + 0.3, 18.2 - 0.3);
  await drag(from, to);
  const v = await values();
  const mine = v.find((c) => c.id === bottom.id);
  const others = v.filter((c) => c.dir === 'h' && c.id !== bottom.id);
  check('起点はその列だけ動く', mine.values.join() === '-1820,0,1820,2730,4550,6370'
    && JSON.stringify(others) === JSON.stringify(before), { mine, others, before });
  await page.screenshot({ path: path.join(outDir, 'ruishin-3-moved2.png') });
  // 戻すボタンで、動かす前の起点に戻る
  await page.click('#btn-ruishin-undo');
  const back = await page.evaluate((id) => window.__jww.origins.get(id), bottom.id);
  check('戻すボタンで 1 つ前の起点に戻る', back.x === o0.x && back.y === o0.y, { back, o0 });
}

// ---------- 6. この列を戻す（戻すボタンで取り消せる）・累進表示を切る ----------
{
  await page.click('#btn-ruishin-reset');
  const v = (await values()).find((c) => c.id === bottom.id);
  check('この列の起点を戻す', v.values[0] === 0, { v });
  await page.click('#btn-ruishin-undo');
  const undone = (await values()).find((c) => c.id === bottom.id);
  check('「この列を戻す」も戻すボタンで取り消せる', undone.values[0] !== 0, { undone });
  await page.click('#btn-ruishin-reset');
  await page.click('#btn-ruishin-on');
  const off = await page.evaluate(() => ({ on: window.__jww.ruishinOn, hidden: window.__jww.textLayer.hidden }));
  check('切ると元の寸法値に戻る', off.on === false && off.hidden === null, off);
  const t = await panelText();
  check('切ったときの案内は「「累進表示」をオンにすると戻せます」',
    t.note === '元の寸法で表示しています。「累進表示」をオンにすると戻せます。', t);
  await page.screenshot({ path: path.join(outDir, 'ruishin-4-off.png') });
  await page.click('#btn-ruishin-on');
  const t2 = await panelText();
  check('オンに戻すと列の選択が外れ、ボタンは「全列を戻す」', t2.active === -1 && t2.reset === '全列を戻す' && !t2.resetDisabled, t2);
  await page.screenshot({ path: path.join(outDir, 'ruishin-5-on-again.png') });
}

// ---------- 6b. 横の列：起点を 3640 の位置へ → 右端 4550、この列を戻す → 8190 ----------
{
  const s = await toScreen(30, bottom.offset);
  await tap(s.x, s.y - 4);
  const o0 = await page.evaluate((id) => window.__jww.origins.get(id), bottom.id);
  const from = await toScreen(o0.x, bottom.offset);
  const to = await toScreen(36.4, bottom.offset);
  await drag(from, to);
  const moved = (await values()).find((c) => c.id === bottom.id);
  check('起点を 3640 の位置に移すと右端が 4550', moved.values.at(-1) === 4550 && moved.values.join() === '-3640,-1820,0,910,2730,4550', { moved });
  await page.screenshot({ path: path.join(outDir, 'ruishin-6-at3640.png') });
  const others = (await values()).filter((c) => c.id !== bottom.id);
  const t = await panelText();
  await page.click('#btn-ruishin-reset');
  const back = (await values()).find((c) => c.id === bottom.id);
  const othersAfter = (await values()).filter((c) => c.id !== bottom.id);
  check('「この列を戻す」で右端が 8190 に戻る（ほかの列は変わらない）',
    t.reset === 'この列を戻す' && back.values.at(-1) === 8190 && JSON.stringify(others) === JSON.stringify(othersAfter),
    { reset: t.reset, back });
  await page.screenshot({ path: path.join(outDir, 'ruishin-7-reset.png') });
}

// ---------- 7. 隠したレイヤの寸法は累進にしない ----------
{
  const r = await page.evaluate(() => {
    const a = window.__jww;
    const e = a.scene.entities;
    const c0 = a.chains.filter((c) => c.uy === 0).sort((p, q) => p.offset - q.offset)[0];
    const layer = e.layer[c0.spans[0].entity];
    const before = a.chains.length;
    a.layers.layer[layer] = false;
    a.applyDisplay();
    const hidden = { n: a.chains.length, leak: a.chains.some((c) => c.spans.some((s) => e.layer[s.entity] === layer)) };
    a.layers.layer[layer] = true;
    a.applyDisplay();
    return { layer, before, hidden, back: a.chains.length };
  });
  check('隠したレイヤの寸法は累進にしない（表示に戻すと戻る）',
    r.hidden.n < r.before && !r.hidden.leak && r.back === r.before, r);
}

// ---------- 8. 3 つのボタンが iPhone の横幅に収まる（文字を小さくしすぎず、押しやすい高さ） ----------
for (const [name, w, h] of [['iPhone 14 Pro', 393, 659], ['iPhone SE', 375, 553]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(300);
  for (const sel of [false, true]) {
    if (sel) {
      // 列を選んで、いちばん長い「この列を戻す」の状態でも確かめる
      await page.evaluate((id) => { const a = window.__jww; a.activeChain = id; a.updateRuishinPanel(); }, bottom.id);
    } else {
      await page.evaluate(() => { const a = window.__jww; a.activeChain = -1; a.updateRuishinPanel(); });
    }
    const r = await page.evaluate(() => {
      const panel = document.getElementById('ruishin-panel').getBoundingClientRect();
      return [...document.querySelectorAll('#ruishin-actions .pill')].map((b) => {
        const q = b.getBoundingClientRect();
        return { text: b.textContent, fits: b.scrollWidth <= b.clientWidth, inside: q.left >= panel.left - 0.5 && q.right <= panel.right + 0.5,
          h: Math.round(q.height), w: Math.round(q.width), font: parseFloat(getComputedStyle(b).fontSize) };
      });
    });
    check(`${name}：3 つのボタン（${r.map((b) => b.text).join('・')}）が横幅に収まり、文字 12px 以上・高さ 40px 以上`,
      r.length === 3 && r.every((b) => b.fits && b.inside && b.font >= 12 && b.h >= 40)
      && r.map((b) => b.text).join() === `累進表示,寸法線上のみ,${sel ? 'この列を戻す' : '全列を戻す'}`, { r });
  }
  await page.screenshot({ path: path.join(outDir, `ruishin-8-buttons-${w}.png`) });
}

// ---------- 9. 回帰：パネルの開閉・計測・属性・レイヤ・表示・見本の図面 ----------
await page.setViewportSize({ width: 393, height: 659 });
await page.waitForTimeout(300);
{
  // 累進のパネルを見出しで縮めて戻す
  const tapHead = () => page.evaluate(() => {
    const h = document.querySelector('#ruishin-panel .panel-top');
    const r = h.getBoundingClientRect();
    const b = { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: r.left + 30, clientY: r.top + r.height / 2 };
    h.dispatchEvent(new PointerEvent('pointerdown', b));
    h.dispatchEvent(new PointerEvent('pointerup', b));
  });
  const st = () => page.evaluate(() => ({ collapsed: document.getElementById('ruishin-panel').classList.contains('collapsed'),
    actions: document.getElementById('btn-ruishin-on').checkVisibility() }));
  await tapHead(); await page.waitForTimeout(400);
  const c1 = await st();
  await tapHead(); await page.waitForTimeout(400);
  const c2 = await st();
  check('累進のパネルを見出しで縮めて、戻せる', c1.collapsed && !c1.actions && !c2.collapsed && c2.actions, { c1, c2 });
}
{
  // 計測：2 点を置くと長さが出る
  await page.click('#btn-tool-measure');
  await page.waitForTimeout(300);
  const p1 = await toScreen(18.2, bottom.offset + 5);
  const p2 = await toScreen(36.4, bottom.offset + 5);
  await tap(p1.x, p1.y);
  await tap(p2.x, p2.y);
  const m = await page.evaluate(() => ({ n: window.__jww.points.length, value: document.getElementById('readout-value').textContent,
    shown: !document.getElementById('readout').classList.contains('hidden') }));
  check('計測：2 点を置くと距離が出る', m.shown && m.n === 2 && m.value !== '—' && /\d/.test(m.value), m);
  await page.screenshot({ path: path.join(outDir, 'ruishin-9-measure.png') });
}
{
  // 属性：線をタップすると属性が出る
  await page.click('#btn-tool-inspect');
  await page.waitForTimeout(300);
  const p = await toScreen(18.2, bottom.offset + 5);
  await tap(p.x, p.y);
  const r = await page.evaluate(() => ({ selected: window.__jww.selected, shown: !document.getElementById('inspect-panel').classList.contains('hidden') }));
  check('属性：線をタップすると属性のパネルが出る', r.shown && r.selected >= 0, r);
}
{
  // レイヤ：一覧を開いて閉じる。表示：背景を白にして黒に戻す
  await page.click('#btn-layers');
  await page.waitForTimeout(300);
  const open = await page.evaluate(() => !document.getElementById('layer-panel').classList.contains('hidden'));
  await page.click('#btn-layer-close');
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => document.getElementById('layer-panel').classList.contains('hidden'));
  check('レイヤ：一覧を開いて閉じられる', open && closed, { open, closed });
  await page.click('#btn-display');
  await page.waitForTimeout(300);
  await page.click('#seg-bg button[data-value="light"]');
  const light = await page.evaluate(() => window.__jww.display.background);
  await page.click('#seg-bg button[data-value="dark"]');
  const dark = await page.evaluate(() => window.__jww.display.background);
  await page.click('#btn-display-close');
  check('表示：背景を白・黒に切り替えられる', light === 'light' && dark === 'dark', { light, dark });
  await page.click('#btn-tool-ruishin');
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => ({ tool: window.__jww.tool, shown: !document.getElementById('ruishin-panel').classList.contains('hidden') }));
  check('累進に戻すと累進のパネルが出る', back.tool === 'ruishin' && back.shown, back);
}
{
  // 最初の画面の「見本の図面を開く」で見本の図面が開く（前の図面を覚えていない、新しい環境で）
  const ctx2 = await browser.newContext({ ...devices['iPhone 14 Pro'], hasTouch: true });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push(`pageerror(2): ${e.message}`));
  await p2.goto(srv.url, { waitUntil: 'networkidle' });
  await p2.waitForFunction(() => !document.getElementById('welcome').classList.contains('hidden'), null, { timeout: 10000 }).catch(() => {});
  await p2.click('#btn-sample');
  await p2.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
  await p2.waitForTimeout(500);
  const r = await p2.evaluate(() => ({ title: document.getElementById('title').textContent, chains: window.__jww.chains.length,
    welcome: !document.getElementById('welcome').classList.contains('hidden') }));
  check('「見本の図面を開く」で見本の図面が開き、3 列を累進にする', r.chains === 3 && !r.welcome, r);
  await ctx2.close();
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
