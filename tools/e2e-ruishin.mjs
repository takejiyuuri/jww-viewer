// 累進寸法を画面で確かめる：見本の図面を開くと列が累進に直って元の寸法値が隠れる、列をタップして選べる、
// 起点の丸をドラッグして通り芯の交点に吸着させると値が変わる、「寸法線上のみ」で寸法線の上だけを動く、
// 「同じ向きを連動」は無い（起点はその列だけ動く）、「累進表示」を切ると元に戻る。
// ミテハカールに統合した版：最初は「計測」、図面を開いた直後は元の寸法。「累進」の「累進表示」を入れたときだけ累進に直し、
// 切るか別のツールにすると元に戻る。起点は戻る・進むができ、寸法線の外へ動かすと寸法線が起点まで伸びて見える。
// 最初の画面：「図面を開く」「見本の図面を開く」がすぐ押せ、操作の説明は「使い方を見る」で開閉する（図面情報からも見られる）。
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
const OFF_NOTE = '元の寸法で表示しています。「累進表示」をオンにすると累進寸法になります。';
const HOWTO_KEYS = ['2 本指で拡大', '「計測」', '「累進」', '起点の移動', '「寸法線上のみ」', '戻る・進む', '「属性」', '「レイヤ」'];
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
    opened.expanded && opened.tipsShown && opened.summaryText === '使い方を閉じる' && opened.tips.length === 8
    && HOWTO_KEYS.every((k) => opened.tips.some((t) => t.includes(k))), opened);
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

// ---------- 1. 開いた直後は「計測」で元の寸法。「累進」を押しただけでは元の寸法のまま、「累進表示」で累進に直る ----------
const layerState = () => page.evaluate(() => {
  const a = window.__jww;
  return { tool: a.tool, on: a.ruishinOn, hidden: a.textLayer.hidden?.size ?? 0, layer: a.ordinateLayer() !== null,
    panel: !document.getElementById('ruishin-panel').classList.contains('hidden'),
    pressed: document.getElementById('btn-ruishin-on').getAttribute('aria-pressed') };
});
{
  const order = await page.evaluate(() => [...document.querySelectorAll('#toolbar button')].map((b) => b.textContent.trim()));
  check('下のツールバーは 計測・累進・属性・レイヤ・表示・全体 の順', order.join() === '計測,累進,属性,レイヤ,表示,全体', { order });
  const s0 = await layerState();
  check('図面を開いた直後は「計測」で、元の寸法のまま（累進の丸・矢印を描かない）',
    s0.tool === 'measure' && !s0.on && s0.hidden === 0 && !s0.layer && !s0.panel, s0);
  await page.screenshot({ path: path.join(outDir, 'ruishin-0-measure.png') });
  await page.click('#btn-tool-ruishin');
  await page.waitForTimeout(300);
  const s1 = await layerState();
  const t1 = await panelText();
  check('「累進」を押すとパネルが出るが、元の寸法のまま（「累進表示」は切）',
    s1.tool === 'ruishin' && s1.panel && !s1.on && s1.hidden === 0 && !s1.layer && s1.pressed === 'false' && t1.note === OFF_NOTE, { s1, t1 });
  await page.screenshot({ path: path.join(outDir, 'ruishin-0b-ruishin-off.png') });
  await page.click('#btn-ruishin-on');
  await page.waitForTimeout(300);
  const s2 = await layerState();
  check('「累進表示」を入れると累進寸法に直る', s2.on && s2.layer && s2.pressed === 'true', s2);
}
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
// あとの検査で同じ見え方に戻すための表示範囲
const goodView = await page.evaluate(() => ({ ...window.__jww.view }));
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
  check('切ったときの案内は「元の寸法で表示しています。「累進表示」をオンにすると累進寸法になります。」', t.note === OFF_NOTE, t);
  const offLayer = await layerState();
  check('切っているあいだは起点の丸・矢印・寸法線の延長を描かない', !offLayer.layer && offLayer.hidden === 0, offLayer);
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
    tool: window.__jww.tool, on: window.__jww.ruishinOn,
    welcome: !document.getElementById('welcome').classList.contains('hidden') }));
  check('「見本の図面を開く」で見本の図面が開き、寸法 3 列を拾う（表示は元の寸法）', r.chains === 3 && !r.welcome && r.tool === 'measure' && !r.on, r);
  await ctx2.close();
}

// ---------- 10. 別のツールにすると元の寸法に戻り、もう一度「累進」を選んでも「累進表示」は切から ----------
const useView = async (v = goodView) => {
  await page.evaluate((v) => { const a = window.__jww; Object.assign(a.view, v); a.requestDraw(true); }, v);
  await page.waitForTimeout(300);
};
const ensureRuishinOn = async () => {
  if ((await page.evaluate(() => window.__jww.tool)) !== 'ruishin') await page.click('#btn-tool-ruishin');
  if (!(await page.evaluate(() => window.__jww.ruishinOn))) await page.click('#btn-ruishin-on');
  await page.waitForTimeout(250);
};
{
  await ensureRuishinOn();
  const on = await layerState();
  await page.click('#btn-tool-measure');
  await page.waitForTimeout(250);
  const measure = await layerState();
  await page.click('#btn-tool-inspect');
  await page.click('#btn-tool-ruishin');
  await page.waitForTimeout(250);
  const again = await layerState();
  check('別のツール（計測）にすると元の寸法に戻る', on.on && on.hidden === 14 && !measure.on && measure.hidden === 0 && !measure.layer, { on, measure });
  check('もう一度「累進」を選ぶと「累進表示」は切から始まる', again.tool === 'ruishin' && !again.on && again.hidden === 0 && again.pressed === 'false', again);
}

const setOriginT = (id, t) => page.evaluate(async ([id, t]) => {
  const a = window.__jww;
  const m = await import('/src/ruishin/ordinate.ts');
  const c = a.chains.find((o) => o.id === id);
  const [x, y] = m.onChain(c, t);
  a.setOrigin(id, { x, y });
  a.requestDraw(true);
}, [id, t]);
// ---------- 11. 戻る・進む：A → B → C、戻る 2 回で A、進む 2 回で C。戻した後に動かすと進むは消える ----------
const originOf = (id) => page.evaluate((id) => ({ ...window.__jww.origins.get(id) }), id);
const allOrigins = () => page.evaluate(() => Object.fromEntries([...window.__jww.origins].map(([k, v]) => [k, `${v.x.toFixed(3)},${v.y.toFixed(3)}`])));
const btns = () => page.evaluate(() => ({ undo: !document.getElementById('btn-ruishin-undo').disabled, redo: !document.getElementById('btn-ruishin-redo').disabled }));
const near = (o, x) => Math.abs(o.x - x) < 1e-3;
{
  await useView();
  await ensureRuishinOn();
  const s0 = await toScreen(30, bottom.offset);
  await tap(s0.x, s0.y - 4);
  await page.click('#btn-ruishin-reset'); // A：最初の端（x = 0）
  const others0 = (await allOrigins());
  delete others0[bottom.id];
  const moveTo = async (x) => {
    const o = await originOf(bottom.id);
    await drag(await toScreen(o.x, bottom.offset), await toScreen(x, bottom.offset));
  };
  await moveTo(18.2); // B
  await moveTo(45.5); // C
  const C = await originOf(bottom.id);
  const b0 = await btns();
  await page.click('#btn-ruishin-undo');
  const u1 = await originOf(bottom.id);
  await page.click('#btn-ruishin-undo');
  const u2 = await originOf(bottom.id);
  const b1 = await btns();
  await page.click('#btn-ruishin-redo');
  const r1 = await originOf(bottom.id);
  await page.click('#btn-ruishin-redo');
  const r2 = await originOf(bottom.id);
  const b2 = await btns();
  check('戻る 1 回で B、2 回で A、進む 1 回で B、2 回で C',
    near(C, 45.5) && near(u1, 18.2) && near(u2, 0) && near(r1, 18.2) && near(r2, 45.5), { C, u1, u2, r1, r2 });
  check('戻した履歴がないときは「進む」を押せない（戻すと押せる）', !b0.redo && b1.redo && !b2.redo && b0.undo, { b0, b1, b2 });
  await page.click('#btn-ruishin-undo'); // B
  await moveTo(63.7); // 新しく動かす → 進むは消える
  const b3 = await btns();
  const D = await originOf(bottom.id);
  check('戻した後で新しく起点を動かすと、進む履歴は消える', near(D, 63.7) && !b3.redo, { D, b3 });
  // 「この列を戻す」「全列を戻す」も戻る・進むの対象
  await page.click('#btn-ruishin-reset');
  const reset = await originOf(bottom.id);
  await page.click('#btn-ruishin-undo');
  const undoReset = await originOf(bottom.id);
  await page.click('#btn-ruishin-redo');
  const redoReset = await originOf(bottom.id);
  check('「この列を戻す」も戻る・進むでやり直せる', near(reset, 0) && near(undoReset, 63.7) && near(redoReset, 0), { reset, undoReset, redoReset });
  const others = await allOrigins();
  delete others[bottom.id];
  check('戻る・進むでほかの列の起点は変わらない', JSON.stringify(others) === JSON.stringify(others0), { others, others0 });
  // 全列を戻す（選択を外して）→ 戻る・進む
  await setOriginT(bottom.id, 36.4);
  await page.evaluate(() => { const a = window.__jww; a.activeChain = -1; a.updateRuishinPanel(); });
  const label = (await panelText()).reset;
  const before = await allOrigins();
  await page.click('#btn-ruishin-reset');
  const afterAll = await allOrigins();
  await page.click('#btn-ruishin-undo');
  const undoAll = await allOrigins();
  await page.click('#btn-ruishin-redo');
  const redoAll = await allOrigins();
  check('「全列を戻す」も戻る・進むでやり直せる', label === '全列を戻す' && JSON.stringify(undoAll) === JSON.stringify(before)
    && JSON.stringify(redoAll) === JSON.stringify(afterAll) && JSON.stringify(before) !== JSON.stringify(afterAll), { label, before, afterAll, undoAll, redoAll });
  const size = await page.evaluate(() => ['btn-ruishin-undo', 'btn-ruishin-redo'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; }));
  check('「戻る」「進む」は見出しの右に並び、押しやすい大きさ（44×38 以上）', size.every((b) => b.w >= 44 && b.h >= 38 && b.right <= 393) && size[0].right < size[1].right, { size });
  await page.screenshot({ path: path.join(outDir, 'ruishin-11-undo-redo.png') });
}

// ---------- 12. 起点を寸法線の外へ動かすと、寸法線が起点まで伸びて見える（左右・上下・ドラッグ中・縮小・レイヤ） ----------
/** 起点まで伸ばした寸法線の中ほど（画面の座標）と、そこに線が描かれているか（計測の層の色） */
const extensionAt = (id) => page.evaluate(async (id) => {
  const a = window.__jww;
  const m = await import('/src/ruishin/ordinate.ts');
  const c = a.chains.find((o) => o.id === id);
  const o = a.origins.get(id);
  const ext = m.chainExtension(c, o);
  const cv = document.getElementById('overlay');
  const g = cv.getContext('2d');
  const probe = (t) => {
    const [wx, wy] = m.onChain(c, t);
    const x = Math.round(((wx - a.view.cx) * a.view.zoom) + cv.width / 2);
    const y = Math.round(cv.height / 2 - ((wy - a.view.cy) * a.view.zoom));
    if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return { x, y, alpha: -1 };
    let best = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) best = Math.max(best, g.getImageData(x + dx, y + dy, 1, 1).data[3]);
    return { x, y, alpha: best };
  };
  return { ext, mid: ext ? probe((ext.from + ext.to) / 2) : null, inner: probe(c.stops[0] - 6), innerR: probe(c.stops[c.stops.length - 1] + 6) };
}, id);
{
  await useView();
  await ensureRuishinOn();
  // ドラッグ中：横の列の起点を、左の通り芯の端（x = -26）に吸着させる途中で、伸ばした線が出ている
  await page.evaluate(() => { const a = window.__jww; a.view.zoom *= 0.6; a.view.cx = 30; a.requestDraw(true); });
  await page.waitForTimeout(300);
  const s0 = await toScreen(30, bottom.offset);
  await tap(s0.x, s0.y - 4);
  const o0 = await originOf(bottom.id);
  const from = await toScreen(o0.x, bottom.offset);
  const to = await toScreen(-26, 0);
  const mid = await page.evaluate(async ([fx, fy, tx, ty]) => {
    const st = document.getElementById('stage');
    const b = { pointerId: 11, pointerType: 'touch', isPrimary: true, bubbles: true };
    st.dispatchEvent(new PointerEvent('pointerdown', { ...b, clientX: fx, clientY: fy }));
    await new Promise((r) => setTimeout(r, 60));
    for (let i = 1; i <= 8; i++) {
      st.dispatchEvent(new PointerEvent('pointermove', { ...b, clientX: fx + ((tx - fx) * i) / 8, clientY: fy + ((ty - fy) * i) / 8 }));
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 120));
    const a = window.__jww;
    return { preview: a.preview ? { x: a.preview.x, y: a.preview.y } : null, layer: a.ordinateLayer() !== null };
  }, [from.x, from.y, to.x, to.y]);
  // ドラッグ中の線：プレビューの起点で伸びた線を探す
  const during = await page.evaluate(async ([id, px, py]) => {
    const a = window.__jww;
    const m = await import('/src/ruishin/ordinate.ts');
    const c = a.chains.find((o) => o.id === id);
    const ext = m.chainExtension(c, { x: px, y: py });
    if (!ext) return { ext: null };
    const cv = document.getElementById('overlay');
    const g = cv.getContext('2d');
    // 拡大鏡に隠れない、起点に近い所を見る
    const [wx, wy] = m.onChain(c, ext.to + (ext.from - ext.to) * 0.15);
    const x = Math.round(((wx - a.view.cx) * a.view.zoom) + cv.width / 2);
    const y = Math.round(cv.height / 2 - ((wy - a.view.cy) * a.view.zoom));
    let best = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) best = Math.max(best, g.getImageData(x + dx, y + dy, 1, 1).data[3]);
    return { ext, alpha: best };
  }, [bottom.id, mid.preview?.x ?? 0, mid.preview?.y ?? 0]);
  await page.screenshot({ path: path.join(outDir, 'ruishin-12-dragging.png') });
  await page.evaluate(([tx, ty]) => document.getElementById('stage').dispatchEvent(new PointerEvent('pointerup',
    { pointerId: 11, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: tx, clientY: ty })), [to.x, to.y]);
  await page.waitForTimeout(300);
  check('起点をドラッグしている間も、寸法線が起点まで伸びて見える', !!mid.preview && during.ext && during.alpha > 100, { mid, during });
  const left = await extensionAt(bottom.id);
  check('横の列：起点を左の外へ動かすと、左の端から起点まで伸びる', left.ext && Math.abs(left.ext.from - 0) < 1e-4 && Math.abs(left.ext.to + 26) < 1e-3 && left.mid.alpha > 100, left);
  await page.screenshot({ path: path.join(outDir, 'ruishin-12-left.png') });
  // 右の外
  await setOriginT(bottom.id, 81.9 + 15);
  await page.waitForTimeout(250);
  const right = await extensionAt(bottom.id);
  check('横の列：起点を右の外へ動かすと、右の端から起点まで伸びる', right.ext && Math.abs(right.ext.from - 81.9) < 1e-4 && right.mid.alpha > 100 && right.inner.alpha === 0, right);
  // 拡大・移動に付いてくる
  const keep = await page.evaluate(() => ({ ...window.__jww.view }));
  await page.evaluate(() => { const a = window.__jww; a.view.cx = 81.9 + 7.5; a.view.zoom *= 1.25; a.requestDraw(true); });
  await page.waitForTimeout(300);
  const zoomed = await extensionAt(bottom.id);
  check('拡大・移動しても、伸ばした線は寸法線に付いてくる', zoomed.mid.alpha > 100 && (zoomed.mid.x !== right.mid.x || zoomed.mid.y !== right.mid.y), { zoomed, right });
  await useView(keep);
  await page.waitForTimeout(300);
  // レイヤ：寸法のレイヤを隠すと列ごと消え、表示に戻すと起点と伸ばした線が戻る
  const lay = await page.evaluate(() => {
    const a = window.__jww;
    const c0 = a.chains.filter((c) => c.uy === 0).sort((p, q) => p.offset - q.offset)[0];
    const layer = a.scene.entities.layer[c0.spans[0].entity];
    a.layers.layer[layer] = false;
    a.applyDisplay();
    return { layer, n: a.chains.length };
  });
  await page.waitForTimeout(300);
  const hiddenExt = await page.evaluate(() => window.__jww.chains.filter((c) => c.uy === 0).length);
  await page.evaluate((layer) => { const a = window.__jww; a.layers.layer[layer] = true; a.applyDisplay(); }, lay.layer);
  await page.waitForTimeout(300);
  const bottomId = await page.evaluate(() => window.__jww.chains.filter((c) => c.uy === 0).sort((p, q) => p.offset - q.offset)[0].id);
  const shownAgain = await extensionAt(bottomId);
  check('レイヤを隠すと列ごと消え、表示に戻すと伸ばした線も戻る', hiddenExt < 2 && shownAgain.ext && shownAgain.mid.alpha > 100, { lay, hiddenExt, shownAgain });
  // 範囲の中に戻すと消える
  await setOriginT(bottomId, 36.4);
  await page.waitForTimeout(250);
  const inside = await extensionAt(bottomId);
  check('起点を寸法線の範囲に戻すと、伸ばした線は消える', inside.ext === null && inside.innerR.alpha === 0, inside);
  // 累進表示を切ると消える
  await setOriginT(bottomId, -20);
  await page.waitForTimeout(250);
  const before = await extensionAt(bottomId);
  await page.click('#btn-ruishin-on');
  await page.waitForTimeout(300);
  const off = await extensionAt(bottomId);
  check('「累進表示」を切ると、伸ばした線は消える', before.mid.alpha > 100 && off.mid.alpha === 0, { before, off });
  await page.click('#btn-ruishin-on');
  await page.waitForTimeout(250);
  // 縦の列：上・下の外
  const vid = await page.evaluate(() => window.__jww.chains.find((c) => c.ux === 0).id);
  const vchain = await page.evaluate((id) => { const c = window.__jww.chains.find((o) => o.id === id); return { lo: c.stops[0], hi: c.stops[c.stops.length - 1], offset: c.offset }; }, vid);
  await page.evaluate(([cy]) => { const a = window.__jww; a.view.cx = -13; a.view.cy = cy; a.view.zoom *= 0.7; a.requestDraw(true); }, [(vchain.lo + vchain.hi) / 2]);
  await page.waitForTimeout(300);
  await setOriginT(vid, vchain.lo - 12);
  await page.waitForTimeout(250);
  const down = await extensionAt(vid);
  await setOriginT(vid, vchain.hi + 12);
  await page.waitForTimeout(250);
  const up = await extensionAt(vid);
  check('縦の列：起点を下・上の外へ動かすと、近いほうの端から起点まで伸びる',
    down.ext && Math.abs(down.ext.from - vchain.lo) < 1e-4 && down.mid.alpha > 100
    && up.ext && Math.abs(up.ext.from - vchain.hi) < 1e-4 && up.mid.alpha > 100, { vchain, down, up });
  await page.screenshot({ path: path.join(outDir, 'ruishin-12-vertical.png') });
  await setOriginT(vid, vchain.lo);
  await useView();
}

// ---------- 13. 図面情報（i）の「使い方を見る」。閉じても図面の表示や操作はそのまま ----------
{
  await useView();
  const before = await page.evaluate(() => { const a = window.__jww; return JSON.stringify({ v: a.view, tool: a.tool, on: a.ruishinOn, active: a.activeChain, o: [...a.origins] }); });
  await page.click('#btn-info');
  await page.waitForTimeout(300);
  const shown = await page.evaluate(() => {
    const d = document.getElementById('info-howto');
    return { panel: !document.getElementById('info-panel').classList.contains('hidden'), has: !!d, open: d?.open,
      file: document.getElementById('info-body').textContent.includes('ruishin-sample.jww') };
  });
  await page.click('#info-howto summary');
  await page.waitForTimeout(200);
  const opened = await page.evaluate(() => {
    const d = document.getElementById('info-howto');
    return { open: d.open, tips: [...d.querySelectorAll('li')].filter((e) => e.checkVisibility()).map((e) => e.textContent),
      label: [...d.querySelectorAll('summary span')].filter((e) => e.checkVisibility()).map((e) => e.textContent).join() };
  });
  await page.screenshot({ path: path.join(outDir, 'ruishin-13-info-howto.png') });
  await page.click('#info-howto summary');
  await page.waitForTimeout(200);
  const closedAgain = await page.evaluate(() => !document.getElementById('info-howto').open);
  await page.click('#btn-info-close');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => { const a = window.__jww; return JSON.stringify({ v: a.view, tool: a.tool, on: a.ruishinOn, active: a.activeChain, o: [...a.origins] }); });
  check('図面を開いた後も、図面情報（i）の「使い方を見る」で使い方が見られる（図面情報もそのまま）',
    shown.panel && shown.has && !shown.open && shown.file && opened.open && opened.label === '使い方を閉じる'
    && HOWTO_KEYS.every((k) => opened.tips.some((t) => t.includes(k))), { shown, opened });
  check('使い方を閉じても、図面の表示位置や操作の状態は変わらない', closedAgain && after === before, { closedAgain, same: after === before });
}

// ---------- 14. 斜めの列：起点を外へ動かすと、斜めの寸法線が伸びる ----------
{
  const { makeJww } = await import('./jww-synth.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const ents = [];
  // 45° の向きに 3 つつながった寸法（1 つ 1000 mm、縮尺 1/100）
  const d = 10 / Math.SQRT2;
  for (let i = 0; i < 3; i++) ents.push({ dim: [d * i, d * i, d * (i + 1), d * (i + 1)], value: '1000' });
  ents.push({ line: [-20, 10, 60, 10], color: 2, style: 1 });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ruishin-')), 'oblique.jww');
  fs.writeFileSync(file, makeJww({ entities: ents, scale: 100 }));
  await page.setInputFiles('#file', file);
  await page.waitForFunction(() => document.getElementById('title')?.textContent === 'oblique.jww', null, { timeout: 60000 });
  await page.waitForTimeout(600);
  await ensureRuishinOn();
  const info = await page.evaluate(() => window.__jww.chains.map((c) => ({ id: c.id, ux: c.ux, uy: c.uy, lo: c.stops[0], hi: c.stops[c.stops.length - 1] })));
  const sc = info.find((c) => c.ux !== 0 && c.uy !== 0);
  await page.evaluate(() => { const a = window.__jww; a.view.zoom *= 0.6; a.requestDraw(true); });
  await page.waitForTimeout(300);
  let ok = false, lo = null, hi = null;
  if (sc) {
    await setOriginT(sc.id, sc.lo - 8);
    await page.waitForTimeout(250);
    lo = await extensionAt(sc.id);
    await setOriginT(sc.id, sc.hi + 8);
    await page.waitForTimeout(250);
    hi = await extensionAt(sc.id);
    ok = lo.ext && hi.ext && lo.mid.alpha > 100 && hi.mid.alpha > 100;
  }
  check('斜めの列：起点を両側の外へ動かすと、斜めの寸法線が起点まで伸びる', !!sc && ok, { info, lo, hi });
  await page.screenshot({ path: path.join(outDir, 'ruishin-14-oblique.png') });
  const hist = await page.evaluate(() => window.__jww.originPast.length + window.__jww.originFuture.length);
  check('別の図面を開くと、起点の戻る・進むの履歴は前の図面のものを持ち越さない', hist === 2, { hist });
}

// ---------- 15. 横向きの iPhone でも、ツールバー・パネル・戻る／進むが使える ----------
{
  await page.setViewportSize({ width: 852, height: 393 });
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); const q = e.getBoundingClientRect(); return e.checkVisibility() && q.right <= innerWidth + 0.5 && q.bottom <= innerHeight + 0.5 && q.width > 0; };
    const panel = document.getElementById('ruishin-panel').getBoundingClientRect();
    const pills = [...document.querySelectorAll('#ruishin-actions .pill')].map((b) => b.scrollWidth <= b.clientWidth && b.getBoundingClientRect().right <= panel.right + 0.5);
    return { tools: ['btn-tool-measure', 'btn-tool-ruishin', 'btn-tool-inspect', 'btn-layers', 'btn-display', 'btn-fit'].every(vis),
      undo: vis('btn-ruishin-undo'), redo: vis('btn-ruishin-redo'), pills };
  });
  check('横向き：ツールバー 6 つ・戻る／進む・3 つのボタンが画面に収まる', r.tools && r.undo && r.redo && r.pills.every(Boolean), r);
  await page.screenshot({ path: path.join(outDir, 'ruishin-15-landscape.png') });
  await page.setViewportSize({ width: 393, height: 659 });
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
