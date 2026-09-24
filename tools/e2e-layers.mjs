// レイヤの表示・非表示、属性の取得、新しいパネルの動きを画面で確かめる。
import { chromium, devices } from 'playwright';
import path from 'node:path';
import { startServer, projectRoot as root } from './serve.mjs';

const srv = await startServer({ port: 5309, host: false, quiet: true });
const sample = process.argv[2] || path.join(root, 'samples', 'A棟 11階躯体図2026.5.12提出スリーブ.jww');
const outDir = process.argv[3] || '.';

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

const openDrawing = async () => {
  await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
  await page.waitForTimeout(600);
};

await page.goto(srv.url, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.setInputFiles('#file', sample);
await openDrawing();

const isHidden = (id) => page.evaluate((i) => document.getElementById(i).classList.contains('hidden'), id);

/** GL 画面で背景以外の色になっているピクセルの数 */
const inkPixels = () => page.evaluate(() => {
  const a = window.__jww;
  a.renderer.draw(a.view, a.dpr);
  const c = document.getElementById('gl');
  const g = c.getContext('webgl2');
  const px = new Uint8Array(c.width * c.height * 4);
  g.readPixels(0, 0, c.width, c.height, g.RGBA, g.UNSIGNED_BYTE, px);
  const counts = new Map();
  for (let i = 0; i < px.length; i += 4) {
    const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const bg = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][1];
  return px.length / 4 - bg;
});

/** オーバーレイで何か描かれているピクセルの数 */
const overlayPixels = () => page.evaluate(() => {
  const a = window.__jww;
  a.draw();
  const c = document.getElementById('overlay');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
  return n;
});

const layerState = () => page.evaluate(() => window.__jww.layers.hidden());

/** 読み込み直後（Jw_cad で保存したときの状態）に隠れていたもの。1 で独立に確かめる */
let initialHidden = '';

// ---------- 1. 読み込み直後は Jw_cad で保存したときの表示 ----------
{
  const s = await page.evaluate(() => {
    const a = window.__jww;
    const info = a.info;
    const counts = a.scene.layerCounts;
    let expect = 0;
    for (let g = 0; g < 16; g++) {
      for (let l = 0; l < 16; l++) {
        const k = (g << 4) | l;
        if (!counts[k]) continue;
        const gi = info.groups[g];
        const isWrite = g === info.writeGroup && l === gi.writeLayer;
        const vis = isWrite || ((gi.state !== 0 || g === info.writeGroup) && gi.layers[l].state !== 0);
        if (!vis) expect++;
      }
    }
    return {
      expect,
      actual: a.layers.hiddenCount(counts),
      hint: document.getElementById('hint').textContent,
    };
  });
  check('Jw_cad で非表示のレイヤは最初から隠れる', s.expect > 0 && s.expect === s.actual, s);
  initialHidden = JSON.stringify(await page.evaluate(() => window.__jww.layers.hidden()));
  check('読み込み時に隠れているレイヤ数を知らせる', s.hint.includes(`${s.actual} 個のレイヤが非表示`), { hint: s.hint });
}

// ---------- 2. 計測パネルは点がなくても出ていて、戻す・消去は押せない ----------
{
  const s = await page.evaluate(() => ({
    readout: !document.getElementById('readout').classList.contains('hidden'),
    inspect: !document.getElementById('inspect-panel').classList.contains('hidden'),
    undo: document.getElementById('btn-undo').disabled,
    clear: document.getElementById('btn-clear').disabled,
    detail: document.getElementById('readout-detail').textContent,
  }));
  check('計測パネルが最初から出ている', s.readout && !s.inspect, s);
  check('点がないときは戻す・消去が押せない', s.undo && s.clear, s);
  const idle = await page.evaluate(() => {
    const box = document.getElementById('readout');
    const shown = (id) => document.getElementById(id).getClientRects().length > 0;
    return {
      idle: box.classList.contains('idle'),
      height: box.getBoundingClientRect().height,
      value: shown('readout-value'), undo: shown('btn-undo'), clear: shown('btn-clear'),
    };
  });
  check('点がないときの計測パネルは操作の 1 段で、長さ・戻す・消去を出さない', idle.idle && idle.height < 70 && !idle.value && !idle.undo && !idle.clear, idle);
}

// 線が詰まっている場所まで寄せておく
await page.evaluate(() => {
  const a = window.__jww;
  a.view.zoom *= 4;
  a.requestDraw(true);
});
await page.waitForTimeout(400);

// ---------- 3. 隠れているレイヤには吸着しない ----------
{
  const s = await page.evaluate(() => {
    const a = window.__jww;
    const sc = a.scene;
    const r = 22 * a.dpr / a.view.zoom;
    let hiddenLines = 0;
    let wrong = 0;
    for (let i = 0; i < sc.lineLayer.length && hiddenLines < 300; i++) {
      if (a.layerMask[sc.lineLayer[i]]) continue;
      hiddenLines++;
      const x = (sc.linePos[i * 4] + sc.linePos[i * 4 + 2]) / 2;
      const y = (sc.linePos[i * 4 + 1] + sc.linePos[i * 4 + 3]) / 2;
      const near = a.snapIndex.nearestLine(x, y, r);
      if (near.index >= 0 && !a.layerMask[sc.lineLayer[near.index]]) wrong++;
      const pick = a.pickAt(...(() => {
        const k = a.dpr;
        return [((x - a.view.cx) * a.view.zoom) / k + a.cssW / 2, a.cssH / 2 - ((y - a.view.cy) * a.view.zoom) / k];
      })());
      if (pick >= 0 && !a.layerMask[sc.entities.layer[pick]]) wrong++;
    }
    return { hiddenLines, wrong };
  });
  check('隠れたレイヤの線には吸着せず、属性でも拾わない', s.hiddenLines > 0 && s.wrong === 0, s);
}

// ---------- 4. 属性ツールに切り替える ----------
await page.click('#btn-tool-inspect');
await page.waitForTimeout(250);
{
  const s = await page.evaluate(() => ({
    tool: window.__jww.tool,
    readout: document.getElementById('readout').classList.contains('hidden'),
    inspect: document.getElementById('inspect-panel').classList.contains('hidden'),
    pressed: document.getElementById('btn-tool-inspect').getAttribute('aria-pressed'),
    body: document.getElementById('inspect-body').textContent,
  }));
  check('属性に切り替えるとパネルが入れ替わる', s.tool === 'inspect' && s.readout && !s.inspect && s.pressed === 'true', s);
  check('何も選んでいないときは使い方を出す', s.body.includes('図形をタップすると'), { body: s.body });
  const btns = await page.evaluate(() => {
    const b = (id) => document.getElementById(id);
    return {
      shown: ['btn-layer-only', 'btn-layer-hide', 'btn-layer-invert'].map((id) => !b(id).classList.contains('hidden')),
      enabled: ['btn-layer-only', 'btn-layer-hide', 'btn-layer-invert'].map((id) => !b(id).disabled),
      back: !b('btn-layer-back').classList.contains('hidden'),
    };
  });
  check('何も選んでいなくても操作ボタンは同じ 3 つが並び、「表示を反転」だけが押せる',
    JSON.stringify(btns.shown) === '[true,true,true]' && JSON.stringify(btns.enabled) === '[false,false,true]' && !btns.back, btns);
}

/** 画面の見えている範囲（上のバーと下のパネルの間） */
const safeArea = `(() => {
  const tops = ['toolbar', 'readout', 'inspect-panel']
    .map((id) => document.getElementById(id))
    .filter((n) => !n.classList.contains('hidden'))
    .map((n) => n.getBoundingClientRect().top);
  return { top: 110, bottom: Math.min(...tops) - 20 };
})()`;

const findLine = () => page.evaluate((areaSrc) => {
  const area = eval(areaSrc);
  const a = window.__jww;
  const sc = a.scene;
  const k = a.dpr;
  const scr = (x, y) => [((x - a.view.cx) * a.view.zoom) / k + a.cssW / 2, a.cssH / 2 - ((y - a.view.cy) * a.view.zoom) / k];
  for (let i = 0; i < sc.lineLayer.length; i += 3) {
    if (!a.snapIndex.lineVisible(i)) continue;
    const e = sc.lineEntity[i];
    if (sc.entities.kind[e] !== 0) continue;
    const [x1, y1] = scr(sc.linePos[i * 4], sc.linePos[i * 4 + 1]);
    const [x2, y2] = scr(sc.linePos[i * 4 + 2], sc.linePos[i * 4 + 3]);
    if (Math.hypot(x2 - x1, y2 - y1) < 40) continue;
    const x = Math.round((x1 + x2) / 2), y = Math.round((y1 + y2) / 2);
    if (x < 30 || x > a.cssW - 30 || y < area.top || y > area.bottom) continue;
    // 交点などで別の線と取り合いになる所は避ける（周り ±2px のどこを押しても同じ線が拾われる所だけ）
    let stable = true;
    for (let dx = -2; dx <= 2 && stable; dx++) for (let dy = -2; dy <= 2 && stable; dy++) if (a.pickAt(x + dx, y + dy) !== e) stable = false;
    if (!stable) continue;
    return {
      x, y, entity: e, layer: sc.entities.layer[e],
      wx: (sc.linePos[i * 4] + sc.linePos[i * 4 + 2]) / 2,
      wy: (sc.linePos[i * 4 + 1] + sc.linePos[i * 4 + 3]) / 2,
    };
  }
  return null;
}, safeArea);

/** 文字を一つ選んで、読める大きさまで寄せる。その文字の中心の画面座標を返す */
const findText = () => page.evaluate((areaSrc) => {
  const area = eval(areaSrc);
  const a = window.__jww;
  const sc = a.scene;
  const k = a.dpr;
  const saved = { ...a.view };
  for (const t of sc.texts) {
    if (!a.colorVisible[t.color] || !a.layerMask[t.layer]) continue;
    if (!t.text.trim() || t.height <= 0) continue;
    const ang = (t.angle * Math.PI) / 180;
    const u = t.width / 2, v = t.height / 2;
    const wx = t.x + u * Math.cos(ang) - v * Math.sin(ang);
    const wy = t.y + u * Math.sin(ang) + v * Math.cos(ang);
    // 文字の高さが画面で 18px ほどになるように寄せ、見えている範囲の真ん中に置く
    const zoom = (18 * k) / t.height;
    const midY = (area.top + area.bottom) / 2;
    a.view.zoom = zoom;
    a.view.cx = wx;
    a.view.cy = wy + ((midY - a.cssH / 2) * k) / zoom;
    const x = a.cssW / 2;
    const y = midY;
    if (a.pickAt(x, y) !== t.entity) continue;
    a.requestDraw(true);
    return { x, y, entity: t.entity, text: t.text };
  }
  Object.assign(a.view, saved);
  return null;
}, safeArea);

/** 図面座標の点が、いまの表示で画面のどこにあるか（選んだ図形が隠れると図面がずれるので毎回取り直す） */
const screenOf = (wx, wy) => page.evaluate(([x, y]) => {
  const a = window.__jww;
  return {
    x: ((x - a.view.cx) * a.view.zoom) / a.dpr + a.cssW / 2,
    y: a.cssH / 2 - ((y - a.view.cy) * a.view.zoom) / a.dpr,
  };
}, [wx, wy]);

const panel = () => page.evaluate(() => ({
  selected: window.__jww.selected,
  kind: document.getElementById('inspect-kind').textContent,
  tag: document.getElementById('inspect-tag').textContent,
  body: document.getElementById('inspect-body').innerText,
  only: !document.getElementById('btn-layer-only').disabled,
  back: !document.getElementById('btn-layer-back').classList.contains('hidden'),
}));

// ---------- 5. 線をタップすると属性が出て、図形が目立つ ----------
const line = await findLine();
check('属性を見る線が画面内にある', line !== null, { line });
let lineLayer = -1;
if (line) {
  lineLayer = line.layer;
  const before = await overlayPixels();
  await page.touchscreen.tap(line.x, line.y);
  await page.waitForTimeout(300);
  const p = await panel();
  const after = await overlayPixels();
  const expectTag = `${(line.layer >> 4).toString(16).toUpperCase()}-${(line.layer & 15).toString(16).toUpperCase()}`;
  check('線をタップすると、その線の属性が出る', p.selected === line.entity && p.kind === '線' && p.tag === expectTag, { p, expectTag });
  check('属性にレイヤ・線色・長さが並ぶ', /レイヤ/.test(p.body) && /線色/.test(p.body) && /長さ/.test(p.body) && /mm|m/.test(p.body), { body: p.body });
  check('選んだ図形がハイライトされる', after > before + 20, { before, after });
  const seen = await screenOf(line.wx, line.wy);
  const panelTop = await page.evaluate(() => document.getElementById('inspect-panel').getBoundingClientRect().top);
  check('選んだ図形が伸びたパネルに隠れない', seen.y < panelTop, { y: seen.y, panelTop });
  await page.screenshot({ path: path.join(outDir, 'e2e-layers-1-inspect.png') });
}

// ---------- 6. 文字をタップすると文字の中身が出る ----------
const viewBeforeText = await page.evaluate(() => ({ ...window.__jww.view }));
const text = await findText();
check('属性を見る文字が画面内にある', text !== null, { text });
if (text) {
  await page.touchscreen.tap(text.x, text.y);
  await page.waitForTimeout(300);
  const p = await panel();
  check('文字をタップすると、文字の中身が出る', p.selected === text.entity && p.body.includes(text.text.trim().slice(0, 8)), { p, text: text.text });
}

await page.evaluate((v) => { Object.assign(window.__jww.view, v); window.__jww.requestDraw(true); }, viewBeforeText);
await page.waitForTimeout(250);

// ---------- 7. 何もない所をタップすると選択が外れる ----------
{
  const empty = await page.evaluate((areaSrc) => {
    const area = eval(areaSrc);
    const a = window.__jww;
    for (let y = area.top; y < area.bottom; y += 13) {
      for (let x = 30; x < a.cssW - 30; x += 13) if (a.pickAt(x, y) < 0) return { x, y };
    }
    return null;
  }, safeArea);
  if (empty) {
    await page.touchscreen.tap(empty.x, empty.y);
    await page.waitForTimeout(250);
    const p = await panel();
    check('何もない所をタップすると選択が外れる', p.selected === -1 && p.kind === '属性' && !p.only, p);
  } else {
    check('何もない所をタップすると選択が外れる', false, { reason: '空いた場所が見つからない' });
  }
}

// ---------- 8. このレイヤだけ表示 → 元に戻す ----------
if (line) {
  const at = await screenOf(line.wx, line.wy);
  await page.touchscreen.tap(at.x, at.y);
  await page.waitForTimeout(250);
  const state0 = await layerState();
  const ink0 = await inkPixels();
  const rectsOf = () => page.evaluate(() => ['btn-layer-only', 'btn-layer-hide', 'btn-layer-invert'].map((id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width)];
  }));
  const before = await rectsOf();
  await page.click('#btn-layer-only');
  await page.waitForTimeout(300);
  const after = await rectsOf();
  check('「レイヤだけ表示」を押しても操作ボタンは動かない', JSON.stringify(before) === JSON.stringify(after), { before, after });
  const backAt = await page.evaluate(() => {
    const b = document.getElementById('btn-layer-back').getBoundingClientRect();
    const top = document.querySelector('#inspect-panel .panel-top').getBoundingClientRect();
    return { inHeader: b.top >= top.top - 1 && b.bottom <= top.bottom + 1, shown: b.width > 0 };
  });
  check('「元に戻す」は見出しの行に出る', backAt.inHeader && backAt.shown, backAt);
  // 「全体」はそのレイヤの図形に合う（隠した図形に引きずられて豆粒にならない）
  const fitOnly = await page.evaluate((k) => {
    const a = window.__jww;
    const saved = { ...a.view };
    a.fit();
    const sc = a.scene;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < sc.lineLayer.length; i++) {
      if (sc.lineLayer[i] !== k) continue;
      for (const j of [0, 2]) {
        x0 = Math.min(x0, sc.linePos[i * 4 + j]); x1 = Math.max(x1, sc.linePos[i * 4 + j]);
        y0 = Math.min(y0, sc.linePos[i * 4 + j + 1]); y1 = Math.max(y1, sc.linePos[i * 4 + j + 1]);
      }
    }
    const w = ((x1 - x0) * a.view.zoom) / a.dpr;
    const h = ((y1 - y0) * a.view.zoom) / a.dpr;
    Object.assign(a.view, saved);
    a.requestDraw(true);
    return { w: Math.round(w), h: Math.round(h), cssW: a.cssW };
  }, lineLayer);
  check('「レイヤだけ表示」のあとの「全体」は、そのレイヤの図形が画面の 3 割以上に映る', fitOnly.w >= fitOnly.cssW * 0.3 || fitOnly.h >= fitOnly.cssW * 0.3, fitOnly);
  const only = await page.evaluate((k) => {
    const a = window.__jww;
    let wrong = 0;
    for (let i = 0; i < 256; i++) if (a.layers.visible(i) !== (i === k)) wrong++;
    return { wrong, selected: a.selected };
  }, lineLayer);
  const ink1 = await inkPixels();
  const p = await panel();
  check('「レイヤだけ表示」でそのレイヤだけが見える', only.wrong === 0 && ink1 < ink0 && ink1 > 0, { ...only, ink0, ink1 });
  check('選んだ図形は選んだまま、元に戻すが出る', only.selected === line.entity && p.back, p);
  await page.screenshot({ path: path.join(outDir, 'e2e-layers-2-only.png') });
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('jww-viewer:hidden') ?? 'null'));
  check('一時的な「レイヤだけ表示」は保存しない', !stored || stored.layers === null || JSON.stringify({ groups: stored.groups, layers: stored.layers }) === JSON.stringify(state0), { stored, state0 });

  await page.click('#btn-layer-back');
  await page.waitForTimeout(300);
  const state1 = await layerState();
  const ink2 = await inkPixels();
  const p2 = await panel();
  check('元に戻すで前の表示に戻る', JSON.stringify(state0) === JSON.stringify(state1) && ink2 === ink0 && !p2.back, { ink0, ink2, back: p2.back });

  // ---------- 9. このレイヤを隠す → 元に戻す ----------
  await page.click('#btn-layer-hide');
  await page.waitForTimeout(300);
  const hid = await page.evaluate((k) => ({ visible: window.__jww.layers.visible(k), selected: window.__jww.selected }), lineLayer);
  const p3 = await panel();
  check('「レイヤを隠す」で隠れて、選択が外れる', !hid.visible && hid.selected === -1 && p3.back && !p3.only, { hid, p3 });
  await page.click('#btn-layer-back');
  await page.waitForTimeout(250);
  const state2 = await layerState();
  check('隠したあとも元に戻せる', JSON.stringify(state0) === JSON.stringify(state2), { state0, state2 });
}

// ---------- 9b. 表示を反転 ----------
{
  /** 図形のあるレイヤごとの見え方 */
  const seen = () => page.evaluate(() => {
    const a = window.__jww;
    const out = [];
    for (let k = 0; k < 256; k++) if (a.scene.layerCounts[k] > 0) out.push(a.layers.visible(k) ? 1 : 0);
    return out.join('');
  });
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('jww-viewer:hidden') ?? 'null'));
  const v0 = await seen();
  const ink0 = await inkPixels();
  await page.click('#btn-layer-invert');
  await page.waitForTimeout(250);
  const v1 = await seen();
  const ink1 = await inkPixels();
  const flipped = [...v0].every((c, i) => c !== v1[i]);
  const p1 = await panel();
  check('「表示を反転」で見えていたレイヤと隠れていたレイヤが入れ替わる', flipped && ink1 !== ink0 && p1.back, { v0, v1, ink0, ink1, back: p1.back });
  const st1 = await stored();
  check('反転は一時的なので保存しない（反転前の状態のまま）', !st1 || (st1.layers === null && st1.groups === null), { st1 });
  await page.click('#btn-layer-invert');
  await page.waitForTimeout(250);
  const v2 = await seen();
  const p2 = await panel();
  check('もう一度反転すると元の見え方に戻り、「元に戻す」は消える', v2 === v0 && !p2.back, { v0, v2, back: p2.back });

  if (line) {
    // このレイヤだけ → 反転で「このレイヤ以外」→ 元に戻す
    const at = await screenOf(line.wx, line.wy);
    await page.touchscreen.tap(at.x, at.y);
    await page.waitForTimeout(250);
    await page.click('#btn-layer-only');
    await page.waitForTimeout(200);
    await page.click('#btn-layer-invert');
    await page.waitForTimeout(250);
    const other = await page.evaluate((k) => {
      const a = window.__jww;
      let wrong = 0;
      for (let i = 0; i < 256; i++) if (a.layers.visible(i) !== (i !== k)) wrong++;
      return { wrong };
    }, lineLayer);
    check('「レイヤだけ表示」のあと反転すると、そのレイヤ以外が見える', other.wrong === 0, other);
    await page.click('#btn-layer-back');
    await page.waitForTimeout(250);
    const v3 = await seen();
    check('元に戻すで、反転する前の最初の見え方に戻る', v3 === v0, { v0, v3 });
  }
}

// ---------- 10. 長押しで拡大鏡を出して選ぶ ----------
if (line) {
  const s = await page.evaluate(async ([x, y]) => {
    const a = window.__jww;
    const stage = document.getElementById('stage');
    const base = { pointerId: 9, pointerType: 'touch', isPrimary: true, bubbles: true };
    stage.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x, clientY: y }));
    await new Promise((r) => setTimeout(r, 420));
    stage.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x + 1, clientY: y }));
    await new Promise((r) => requestAnimationFrame(() => r()));
    const mid = {
      holding: a.holding,
      magnifier: a.magnifier ? { ...a.magnifier } : null,
      preview: a.previewEntity,
      panelTop: document.getElementById('inspect-panel').getBoundingClientRect().top,
    };
    stage.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: x + 1, clientY: y }));
    await new Promise((r) => setTimeout(r, 100));
    return { mid, selected: a.selected, magnifierAfter: !!a.magnifier };
  }, await (async () => { const at = await screenOf(line.wx, line.wy); return [at.x, at.y]; })());
  check('長押しで拡大鏡が出て、指の下の図形を示す', s.mid.holding && s.mid.magnifier && s.mid.preview === line.entity, s);
  check('拡大鏡が下のパネルに重ならない', s.mid.magnifier && s.mid.magnifier.y + s.mid.magnifier.size <= s.mid.panelTop, s.mid);
  check('指を離すとその図形が選ばれる', s.selected === line.entity && !s.magnifierAfter, s);
}

// ---------- 11. レイヤ一覧 ----------
await page.click('#btn-layers');
await page.waitForTimeout(300);
{
  const s = await page.evaluate((k) => ({
    open: !document.getElementById('layer-panel').classList.contains('hidden'),
    mark: document.querySelector('#layer-list .l-row.mark')?.dataset.k,
    groups: document.querySelectorAll('#layer-list .lg').length,
    rows: document.querySelectorAll('#layer-list .l-row').length,
    flags: document.querySelectorAll('#layer-list .lflag').length,
    summary: document.getElementById('layer-summary').textContent,
    expected: k,
  }), lineLayer);
  check('レイヤ一覧が開き、選んでいる図形のレイヤに印が付く', s.open && Number(s.mark) === lineLayer, s);
  check('Jw_cad で非表示のレイヤに印が付く', s.flags > 0, s);
  await page.screenshot({ path: path.join(outDir, 'e2e-layers-3-sheet.png') });
}

if (lineLayer >= 0) {
  // 対象のグループが閉じていたら開いておく
  const opened = await page.evaluate((k) => !!document.querySelector(`#layer-list .l-row[data-k="${k}"]`)?.offsetParent, lineLayer);
  if (!opened) await page.click(`#layer-list .lg-head[data-toggle="${lineLayer >> 4}"]`);
  const ink0 = await inkPixels();
  // レイヤのスイッチ
  await page.click(`#layer-list .sw[data-layer="${lineLayer}"]`);
  await page.waitForTimeout(250);
  const a1 = await page.evaluate((k) => ({
    visible: window.__jww.layers.visible(k),
    pressed: document.querySelector(`#layer-list .sw[data-layer="${k}"]`).getAttribute('aria-pressed'),
    summary: document.getElementById('layer-summary').textContent,
  }), lineLayer);
  const ink1 = await inkPixels();
  check('レイヤのスイッチで隠れる', !a1.visible && a1.pressed === 'false' && ink1 < ink0, { ...a1, ink0, ink1 });
  // 行を押しても切り替わる
  await page.click(`#layer-list .l-row[data-k="${lineLayer}"] .lname`);
  await page.waitForTimeout(250);
  const ink2 = await inkPixels();
  const a2 = await page.evaluate((k) => window.__jww.layers.visible(k), lineLayer);
  check('行を押しても表示が戻る', a2 && ink2 === ink0, { ink0, ink2 });

  // グループのスイッチ
  const g = lineLayer >> 4;
  await page.click(`#layer-list .sw[data-group="${g}"]`);
  await page.waitForTimeout(250);
  const ink3 = await inkPixels();
  const g1 = await page.evaluate((gg) => {
    const a = window.__jww;
    let anyVisible = false;
    for (let l = 0; l < 16; l++) if (a.layers.visible((gg << 4) | l)) anyVisible = true;
    return { group: a.layers.group[gg], anyVisible };
  }, g);
  check('グループのスイッチで中のレイヤがすべて隠れる', !g1.group && !g1.anyVisible && ink3 < ink0, { ...g1, ink0, ink3 });

  // 隠れたグループの中のレイヤを表示にすると、グループが戻ってそのレイヤだけが見える
  await page.click(`#layer-list .sw[data-layer="${lineLayer}"]`);
  await page.waitForTimeout(250);
  const g2 = await page.evaluate((k) => {
    const a = window.__jww;
    const gg = k >> 4;
    const shown = [];
    for (let l = 0; l < 16; l++) if (a.layers.visible((gg << 4) | l)) shown.push((gg << 4) | l);
    return { group: a.layers.group[gg], shown };
  }, lineLayer);
  check('隠れたグループのレイヤを表示にすると、そのレイヤだけが見える', g2.group && g2.shown.length === 1 && g2.shown[0] === lineLayer, g2);

  // Jw_cad の状態に戻す
  await page.click('#btn-layer-jw');
  await page.waitForTimeout(250);
  const jwNow = JSON.stringify(await layerState());
  check('「Jw_cad の状態」で読み込み直後の表示に戻る', jwNow === initialHidden, { jwNow, initialHidden });
  const storedJw = await page.evaluate(() => JSON.parse(localStorage.getItem('jww-viewer:hidden') ?? 'null'));
  check('Jw_cad の状態のままなら、レイヤの記録は残さない', storedJw && storedJw.layers === null && storedJw.groups === null, { storedJw });

  // 一覧の「反転」は保存される。もう一度反転すれば Jw_cad の状態に戻って記録も消える
  const before = await page.evaluate(() => {
    const a = window.__jww;
    return [...a.layers.mask()].join('');
  });
  await page.click('#btn-layer-invert-all');
  await page.waitForTimeout(250);
  const inv = await page.evaluate(() => ({
    mask: [...window.__jww.layers.mask()].join(''),
    stored: JSON.parse(localStorage.getItem('jww-viewer:hidden') ?? 'null'),
  }));
  const allFlipped = [...before].every((c, i) => c !== inv.mask[i]);
  check('一覧の「反転」で全レイヤの見え方が入れ替わり、保存される', allFlipped && inv.stored && Array.isArray(inv.stored.layers), { stored: inv.stored && inv.stored.layers && inv.stored.layers.length });
  await page.click('#btn-layer-invert-all');
  await page.waitForTimeout(250);
  const back2 = await page.evaluate(() => ({
    mask: [...window.__jww.layers.mask()].join(''),
    stored: JSON.parse(localStorage.getItem('jww-viewer:hidden') ?? 'null'),
  }));
  check('一覧でもう一度反転すると元に戻り、Jw_cad の状態なら記録を残さない', back2.mask === before && back2.stored && back2.stored.layers === null, { stored: back2.stored });

  // すべて表示
  await page.click('#btn-layer-all');
  await page.waitForTimeout(250);
  const all = await page.evaluate(() => window.__jww.layers.hiddenCount(window.__jww.scene.layerCounts));
  const inkAll = await inkPixels();
  check('「すべて表示」で隠れたレイヤがなくなり、線が増える', all === 0 && inkAll > ink0, { all, ink0, inkAll });
  await page.click('#btn-layer-jw');
  await page.waitForTimeout(200);
}

// ---------- 11b. シートを開いたまま長押ししても、拡大鏡はシートに重ならない ----------
{
  const s = await page.evaluate(async () => {
    const a = window.__jww;
    const sheet = document.getElementById('layer-panel').getBoundingClientRect();
    const x = a.cssW * 0.3;
    const y = Math.max(80, sheet.top - 30);
    const stage = document.getElementById('stage');
    const base = { pointerId: 11, pointerType: 'touch', isPrimary: true, bubbles: true };
    stage.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x, clientY: y }));
    await new Promise((r) => setTimeout(r, 420));
    stage.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x + 1, clientY: y }));
    const m = a.magnifier ? { ...a.magnifier } : null;
    stage.dispatchEvent(new PointerEvent('pointercancel', { ...base, clientX: x + 1, clientY: y }));
    return { m, sheetTop: sheet.top, open: sheet.height > 0 };
  });
  check('シートを開いたままでも拡大鏡がシートに重ならない', s.open && s.m && s.m.y + s.m.size <= s.sheetTop + 0.5, s);
}

// ---------- 12. シートは同時に一つだけ ----------
await page.click('#btn-layer-close');
await page.click('#btn-display');
await page.waitForTimeout(200);
check('表示シートを開くとレイヤ一覧は閉じている',
  !(await isHidden('display-panel')) && (await isHidden('layer-panel')) && (await isHidden('info-panel')));
await page.click('#btn-display-close');
await page.click('#btn-info');
await page.waitForTimeout(150);
check('図面情報を開くとほかのシートは閉じている', !(await isHidden('info-panel')) && (await isHidden('display-panel')));
await page.click('#btn-info-close');

// ---------- 13. 図面を開き直すと、隠したレイヤがそのまま ----------
if (lineLayer >= 0) {
  await page.click('#btn-layers');
  await page.click(`#layer-list .sw[data-layer="${lineLayer}"]`);
  await page.waitForTimeout(200);
  await page.click('#btn-layer-close');
  const saved = await layerState();
  await page.reload({ waitUntil: 'networkidle' });
  await openDrawing();
  const restored = await layerState();
  check('開き直すと隠したレイヤがそのまま', JSON.stringify(saved) === JSON.stringify(restored) && restored.layers.includes(lineLayer), { saved, restored });
  // 「レイヤだけ表示」したまま開き直すと、絞り込む前の表示で開く
  await page.click('#btn-tool-inspect');
  const at2 = await page.evaluate((k) => {
    const a = window.__jww;
    const sc = a.scene;
    for (let i = 0; i < sc.entities.count; i++) {
      if (sc.entities.layer[i] !== k && a.layerMask[sc.entities.layer[i]] && sc.entities.lineCount[i] > 0) return i;
    }
    return -1;
  }, lineLayer);
  if (at2 >= 0) {
    await page.evaluate((i) => window.__jww.select(i), at2);
    const beforeOnly = await layerState();
    await page.click('#btn-layer-only');
    await page.waitForTimeout(200);
    await page.reload({ waitUntil: 'networkidle' });
    await openDrawing();
    const afterReload = await layerState();
    check('「レイヤだけ表示」したまま開き直すと、その前の表示で開く', JSON.stringify(beforeOnly) === JSON.stringify(afterReload), { beforeOnly, afterReload });
  }
  await page.click('#btn-tool-measure');

  // 後片付け：Jw_cad の状態に戻しておく
  await page.click('#btn-layers');
  await page.click('#btn-layer-jw');
  await page.click('#btn-layer-close');
}

// ---------- 14. 計測に戻す ----------
await page.click('#btn-tool-measure');
await page.waitForTimeout(200);
{
  const target = await page.evaluate((areaSrc) => {
    const area = eval(areaSrc);
    return { x: window.__jww.cssW / 2, y: (area.top + area.bottom) / 2 };
  }, safeArea);
  await page.touchscreen.tap(target.x, target.y);
  await page.waitForTimeout(250);
  const s = await page.evaluate(() => ({
    points: window.__jww.points.length,
    undo: document.getElementById('btn-undo').disabled,
    highlight: window.__jww.currentHighlight(),
    detail: document.getElementById('readout-detail').textContent,
  }));
  check('計測に戻すとタップで点が置け、戻すが押せる', s.points === 1 && !s.undo, s);
  const gap = await page.evaluate(() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    const a = r('btn-scale');
    const b = r('btn-clear');
    // 2 つの矩形のあいだの距離（重なっていれば 0）
    const dx = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right));
    const dy = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom));
    return { dist: Math.hypot(dx, dy), dx, dy, idle: document.getElementById('readout').classList.contains('idle') };
  });
  check('点を置くと 2 段になり、縮尺ボタンは消去ボタンから離れている', !gap.idle && gap.dx > 60, gap);
  check('計測中は属性のハイライトを描かない', s.highlight === null, s);
  // 縮尺を選ぶと全区間をその縮尺で測り、「自動」で戻る
  await page.click('#btn-scale');
  await page.waitForTimeout(150);
  const rows = await page.evaluate(() => [...document.querySelectorAll('#info-body .group-row.pick')].map((r) => ({
    auto: !!r.dataset.auto, scale: r.dataset.scale, active: r.classList.contains('active'),
  })));
  check('縮尺の一覧は最初「自動」が選ばれている', rows.length >= 2 && rows[0].auto && rows[0].active, { rows });
  const pickRow = rows.findIndex((r) => !r.auto);
  await page.click(`#info-body .group-row.pick >> nth=${pickRow}`);
  await page.waitForTimeout(150);
  const fixed = await page.evaluate(() => ({
    manual: window.__jww.manualScale, chip: document.getElementById('btn-scale').textContent,
  }));
  check('縮尺を選ぶとその縮尺に固定される', fixed.manual && fixed.chip === `1/${rows[pickRow].scale}`, { fixed, want: rows[pickRow].scale });
  await page.click('#info-body .group-row.pick >> nth=0');
  await page.waitForTimeout(150);
  check('「自動」を選ぶと固定が外れる', !(await page.evaluate(() => window.__jww.manualScale)));
  await page.click('#btn-info-close');

  await page.click('#btn-clear');
  await page.waitForTimeout(100);
  const c = await page.evaluate(() => ({ points: window.__jww.points.length, clear: document.getElementById('btn-clear').disabled }));
  check('消去で点がなくなり、消去が押せなくなる', c.points === 0 && c.clear, c);
}

// ---------- 15. 1 点目で計測パネルが伸びても、点は隠れず、ボタンも押されない ----------
{
  // 直前に押した「消去」の直後のタップとみなされないよう、少し間を置く
  await page.waitForTimeout(600);
  const p0 = await page.evaluate(() => {
    const a = window.__jww;
    a.points = [];
    a.updateReadout();
    const r = document.getElementById('readout').getBoundingClientRect();
    return { top: r.top, x: a.cssW - 40 };
  });
  // 1 段のパネルのすぐ上、2 段になると消去ボタンが来る所を押す
  await page.touchscreen.tap(p0.x, p0.top - 10);
  await page.waitForTimeout(300);
  const s = await page.evaluate(() => {
    const a = window.__jww;
    const p = a.points[0];
    const top = document.getElementById('readout').getBoundingClientRect().top;
    const sy = p ? a.cssH / 2 - ((p.y - a.view.cy) * a.view.zoom) / a.dpr : null;
    return { n: a.points.length, ortho: a.ortho, sy, top };
  });
  check('1 点目をパネルのすぐ上に置いても、点が伸びたパネルに隠れない', s.n === 1 && s.sy !== null && s.sy < s.top, s);
  check('そのときパネルのボタンが押されない（直交のまま・点も消えない）', s.n === 1 && s.ortho === true, s);

  // 「戻す」を続けて押す：点がなくなってパネルが縮んでも、2 回目のタップは図面に点を置かない
  const undo = await page.evaluate(() => {
    const r = document.getElementById('btn-undo').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.touchscreen.tap(undo.x, undo.y);
  await page.waitForTimeout(80);
  await page.touchscreen.tap(undo.x, undo.y);
  await page.waitForTimeout(300);
  const n2 = await page.evaluate(([x, y]) => ({
    n: window.__jww.points.length,
    onPanel: !!document.elementFromPoint(x, y)?.closest('#readout'),
  }), [undo.x, undo.y]);
  check('「戻す」を続けて押しても、図面に点を置かない（戻すの場所はパネルのまま）', n2.n === 0 && n2.onPanel, n2);

  // 点を置いても消しても、操作の段（縮尺・直交）は同じ位置のまま
  const barAt = () => page.evaluate(() => {
    const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top)]; };
    return { ortho: r('btn-ortho'), scale: r('btn-scale') };
  });
  const idleBar = await barAt();
  // 点がないとき、これから「戻す」「消去」が出る場所を押しても、図面に点は置かれない（使い方の文字がある）
  const future = await page.evaluate(() => {
    const r = document.getElementById('readout').getBoundingClientRect();
    return { x: r.right - 40, y: r.bottom - 22 };
  });
  await page.touchscreen.tap(future.x, future.y);
  await page.waitForTimeout(200);
  const f = await page.evaluate(([x, y]) => ({
    n: window.__jww.points.length,
    hint: document.elementFromPoint(x, y)?.id,
  }), [future.x, future.y]);
  check('点がないとき、戻す・消去が出る場所は使い方の文字で、押しても点は置かれない', f.n === 0 && f.hint === 'readout-hint', f);

  const mid = await page.evaluate(() => ({ x: window.__jww.cssW / 2, y: 300 }));
  await page.touchscreen.tap(mid.x, mid.y);
  await page.waitForTimeout(250);
  const grownBar = await barAt();
  check('点を置いても操作の段（縮尺・直交）は動かない', JSON.stringify(idleBar) === JSON.stringify(grownBar), { idleBar, grownBar });
  // 縮尺の桁が変わっても（1/50 → 1/1000）直交は動かない
  const wideBar = await page.evaluate(() => {
    const a = window.__jww;
    a.measureScale = 1000;
    a.manualScale = true;
    a.updateReadout();
    const b = document.getElementById('btn-ortho').getBoundingClientRect();
    return { ortho: [Math.round(b.left), Math.round(b.top)], chip: document.getElementById('btn-scale').textContent };
  });
  check('縮尺の桁が変わっても直交は動かない', JSON.stringify(wideBar.ortho) === JSON.stringify(grownBar.ortho), { wideBar, grownBar });
  // 点を足して内訳が 2 行になっても、計測パネルの高さは変わらない
  const h1 = await page.evaluate(() => document.getElementById('readout').getBoundingClientRect().height);
  await page.evaluate(() => {
    const a = window.__jww;
    const p = a.points[0];
    for (let i = 1; i <= 4; i++) a.points.push({ ...p, x: p.x + i * 5000 / a.measureScale, y: p.y + (i % 2) * 3000 / a.measureScale });
    a.updateReadout();
  });
  const h4 = await page.evaluate(() => ({
    h: document.getElementById('readout').getBoundingClientRect().height,
    lines: Math.round(document.getElementById('readout-detail').getBoundingClientRect().height / 16.8),
  }));
  check('点を足して内訳が長くなっても計測パネルの高さは変わらない', Math.abs(h4.h - h1) < 0.5, { h1, h4 });
  await page.evaluate(() => { const a = window.__jww; a.manualScale = false; a.points = []; a.updateReadout(); a.requestDraw(true); });
  await page.waitForTimeout(150);
}

// ---------- 16. 横向きの狭い画面でも、属性の操作ボタンの文字がはみ出さない ----------
{
  const ctx2 = await browser.newContext({ viewport: { width: 667, height: 375 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push(`pageerror(横): ${e.message}`));
  await p2.goto(srv.url, { waitUntil: 'networkidle' });
  await p2.setInputFiles('#file', sample);
  await p2.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
  await p2.waitForTimeout(500);
  await p2.click('#btn-tool-inspect');
  const s = await p2.evaluate(() => {
    const a = window.__jww;
    for (let i = 0; i < a.scene.entities.count; i++) {
      if (a.layerMask[a.scene.entities.layer[i]] && a.colorVisible[a.scene.entities.color[i]]) { a.select(i); break; }
    }
    a.layerSnapshot = a.layers.snapshot();
    a.updateInspect();
    const pills = [...document.querySelectorAll('#inspect-actions .pill')].filter((b) => !b.classList.contains('hidden'));
    const panel = document.getElementById('inspect-panel').getBoundingClientRect();
    return {
      count: pills.length,
      overflow: pills.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent),
      inside: pills.every((b) => { const r = b.getBoundingClientRect(); return r.left >= panel.left - 0.5 && r.right <= panel.right + 0.5; }),
    };
  });
  check('横向きの狭い画面でも属性の操作ボタンの文字がはみ出さない', s.count === 3 && s.overflow.length === 0 && s.inside, s);

  // 横向きで、右に寄せたパネルのすぐ上に 1 点目を置いても、伸びたパネルに隠れない
  await p2.click('#btn-tool-measure');
  await p2.waitForTimeout(1000);
  const r0 = await p2.evaluate(() => {
    const a = window.__jww;
    a.points = [];
    a.updateReadout();
    const r = document.getElementById('readout').getBoundingClientRect();
    return { x: r.left + 60, y: r.top - 8 };
  });
  await p2.touchscreen.tap(r0.x, r0.y);
  await p2.waitForTimeout(300);
  const land = await p2.evaluate(() => {
    const a = window.__jww;
    const p = a.points[0];
    if (!p) return { n: 0 };
    const sx = ((p.x - a.view.cx) * a.view.zoom) / a.dpr + a.cssW / 2;
    const sy = a.cssH / 2 - ((p.y - a.view.cy) * a.view.zoom) / a.dpr;
    const r = document.getElementById('readout').getBoundingClientRect();
    return { n: a.points.length, covered: sx >= r.left && sx <= r.right && sy >= r.top && sy <= r.bottom, sx, sy };
  });
  check('横向きでも 1 点目が伸びたパネルに隠れない', land.n === 1 && !land.covered, land);
  await ctx2.close();

  // 高さ 320px の横画面で、属性の行が多い図形（文字）を選んでも、操作ボタンは全部見えている
  const ctx3 = await browser.newContext({ viewport: { width: 568, height: 320 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p3 = await ctx3.newPage();
  await p3.goto(srv.url, { waitUntil: 'networkidle' });
  await p3.setInputFiles('#file', sample);
  await p3.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
  await p3.waitForTimeout(500);
  await p3.click('#btn-tool-inspect');
  const low = await p3.evaluate(() => {
    const a = window.__jww;
    const t = a.scene.texts.find((x) => a.layerMask[x.layer] && a.colorVisible[x.color]);
    if (t) a.select(t.entity);
    a.layerSnapshot = a.layers.snapshot();
    a.updateInspect();
    const panel = document.getElementById('inspect-panel').getBoundingClientRect();
    const pills = [...document.querySelectorAll('#inspect-actions .pill')].filter((b) => !b.classList.contains('hidden'));
    return {
      count: pills.length,
      hidden: pills.filter((b) => { const r = b.getBoundingClientRect(); return r.top < panel.top - 0.5 || r.bottom > panel.bottom + 0.5; }).map((b) => b.textContent),
    };
  });
  check('高さの低い横画面でも、属性の操作ボタンがパネルの下に隠れない', low.count === 3 && low.hidden.length === 0, low);
  await ctx3.close();
}

// ---------- 17. 画面の高さ：図面・枠・ツールバーの下端と描画の大きさがそろい、画面を回すと測り直す ----------
{
  const openAs = async (standalone) => {
    const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errors.push(`pageerror(高さ): ${e.message}`));
    await pg.addInitScript((sa) => { Object.defineProperty(navigator, 'standalone', { get: () => sa }); }, standalone);
    await pg.goto(srv.url, { waitUntil: 'networkidle' });
    await pg.setInputFiles('#file', sample);
    await pg.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
    await pg.waitForTimeout(500);
    const measure = () => pg.evaluate(() => {
      const a = window.__jww;
      const rect = (id) => document.getElementById(id).getBoundingClientRect();
      window.scrollTo(0, 200);
      return {
        standalone: document.documentElement.classList.contains('standalone'),
        cssW: a.cssW, cssH: a.cssH, innerH: innerHeight,
        stage: [Math.round(rect('stage').width), Math.round(rect('stage').height)],
        shellBottom: Math.round(rect('shell').bottom),
        toolbarBottom: Math.round(rect('toolbar').bottom),
        canvas: [document.getElementById('gl').width, document.getElementById('gl').height],
        scrollY: window.scrollY,
      };
    });
    const portrait = await measure();
    await pg.setViewportSize({ width: 852, height: 393 });
    await pg.waitForTimeout(600);
    const landscape = await measure();
    await ctx.close();
    return { portrait, landscape };
  };
  const good = (m) => m.cssW === m.stage[0] && m.cssH === m.stage[1] && m.stage[1] === m.shellBottom
    && m.toolbarBottom === m.shellBottom && m.canvas[0] === m.cssW * 3 && m.canvas[1] === m.cssH * 3 && m.scrollY === 0;
  const home = await openAs(true);
  check('ホーム画面から開いたとき、図面・枠・ツールバーの下端と描画の大きさがそろう（縦・横）',
    home.portrait.standalone && good(home.portrait) && good(home.landscape) && home.landscape.cssW === 852, home);
  const safari = await openAs(false);
  check('Safari で開いたときも、図面・枠・ツールバーの下端と描画の大きさがそろう（縦・横）',
    !safari.portrait.standalone && good(safari.portrait) && good(safari.landscape), safari);
}

check('コンソールにエラーがない', errors.length === 0, { errors: errors.slice(0, 5) });

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length ? 1 : 0);
