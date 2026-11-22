// 累進寸法を表示したまま計測する（仕様書 8 章）を画面で確かめる。
// ・「計測」と「累進」のあいだは累進表示・起点・「寸法線上のみ」・選んだ列を覚えたまま。「属性」のあいだだけ元の寸法で見せる
// ・距離・面積・体積・角度のどれでも、累進を表示したまま測れて、記録・番号札・拡大鏡・吸着は今どおり
// ・計測中に起点の丸を押しても起点は動かず、計測の点が置かれる
// ・計測の 1 点戻す・すべて消去・元に戻すと、起点の戻る・進むは、互いに混ざらない
// ・拡大鏡の中にも累進の数字を描く（計測で点を置くときも、累進で起点を動かすときも）
// ・「累進」ボタンの角の点は、累進を表示したまま計測しているときだけ。図面の見える所は狭くならない
// ・別の図面を開くと累進表示は切に戻る。累進の入・切や起点は端末に保存しない
// 引数：出力先のフォルダ（スクリーンショット）。図面は public/ruishin-sample.jww（tools/ruishin-sample.mjs で作る）
import { chromium, devices } from 'playwright';
import path from 'node:path';
import { startServer, projectRoot as root } from './serve.mjs';

const srv = await startServer({ port: 5330, host: false, quiet: true });
const outDir = process.argv[2] ?? '.';
const sample = path.join(root, 'public', 'ruishin-sample.jww');

const browser = await chromium.launch({
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
const report = () => {
  let failed = 0;
  for (const r of results) {
    const { name, ok, ...info } = r;
    if (ok) console.log(`OK: ${name}`);
    else {
      failed++;
      console.log(`NG: ${name}`);
      console.log(`    ${JSON.stringify(info)}`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} 合格`);
  return failed;
};
// 途中で止まっても、そこまでの結果は出す
process.on('uncaughtException', (err) => {
  report();
  console.log(`NG: 途中で止まった ${err?.message?.split('\n')[0]}`);
  process.exit(1);
});
const wait = (ms) => page.waitForTimeout(ms);

const openSample = async () => {
  await page.setInputFiles('#file', sample);
  await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
  await wait(800);
};

await page.goto(srv.url, { waitUntil: 'networkidle' });
const storageAtStart = await page.evaluate(() => Object.keys(localStorage).sort());
await openSample();

const toScreen = (wx, wy) => page.evaluate(([x, y]) => {
  const a = window.__jww;
  return {
    x: ((x - a.view.cx) * a.view.zoom) / a.dpr + a.cssW / 2,
    y: a.cssH / 2 - ((y - a.view.cy) * a.view.zoom) / a.dpr,
  };
}, [wx, wy]);
const tapWorld = async (wx, wy) => {
  const s = await toScreen(wx, wy);
  await page.touchscreen.tap(s.x, s.y);
  await wait(300);
};
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
  await wait(300);
};

/** 図面の範囲 [x0,x1]×[y0,y1] が、パネルやバーに隠れない所にちょうど収まるように表示する */
const frameRegion = (x0, y0, x1, y1) => page.evaluate(([x0, y0, x1, y1]) => {
  const a = window.__jww;
  const v = a.visibleArea();
  const zoom = Math.min(((v.right - v.left) * a.dpr) / (x1 - x0), ((v.bottom - v.top) * a.dpr) / (y1 - y0));
  a.view.zoom = zoom;
  const mx = (v.left + v.right) / 2;
  const my = (v.top + v.bottom) / 2;
  a.view.cx = (x0 + x1) / 2 - ((mx - a.cssW / 2) * a.dpr) / zoom;
  a.view.cy = (y0 + y1) / 2 + ((my - a.cssH / 2) * a.dpr) / zoom;
  a.requestDraw(true);
}, [x0, y0, x1, y1]);

/** 累進と計測の状態をまとめて取る */
const st = () => page.evaluate(() => {
  const a = window.__jww;
  const layer = a.ordinateLayer();
  const b = document.getElementById('btn-tool-ruishin');
  const dot = b.querySelector('.live-dot');
  return {
    tool: a.tool, on: a.ruishinOn, hidden: a.textLayer.hidden?.size ?? 0,
    layer: layer !== null, layerActive: layer ? layer.active : null,
    active: a.activeChain, along: a.alongChain,
    alongPressed: document.getElementById('btn-ruishin-along').getAttribute('aria-pressed'),
    onPressed: document.getElementById('btn-ruishin-on').getAttribute('aria-pressed'),
    origins: JSON.stringify([...a.origins.entries()]),
    past: a.originPast.length, future: a.originFuture.length,
    points: a.points.map((p) => ({ x: +p.x.toFixed(6), y: +p.y.toFixed(6), kind: p.kind })),
    mode: a.measurePrefs.mode,
    records: a.records.length, badges: a.recordBadges().length,
    chip: document.getElementById('btn-records').textContent.trim(),
    dot: !!dot && getComputedStyle(dot).display !== 'none',
    label: b.getAttribute('aria-label'),
    readout: !document.getElementById('readout').classList.contains('hidden'),
    ruishinPanel: !document.getElementById('ruishin-panel').classList.contains('hidden'),
    value: document.getElementById('readout-value').textContent.trim(),
    hint: document.getElementById('hint').textContent,
  };
});
// 図面の座標は 32 ビットの小数で持つので、1/10000 mm まで合えば同じ点とみなす
const near = (p, x, y) => !!p && Math.abs(p.x - x) < 1e-4 && Math.abs(p.y - y) < 1e-4;

// 下の列（寸法線 y = -13）と、通り芯 X0〜X3・Y0〜Y1 が見える大きさで表示する
await frameRegion(-4, -17, 50, 22);
await wait(400);
const goodView = await page.evaluate(() => ({ ...window.__jww.view }));
const useView = async () => {
  await page.evaluate((v) => { const a = window.__jww; Object.assign(a.view, v); a.requestDraw(true); }, goodView);
  await wait(300);
};
const bottom = await page.evaluate(() => window.__jww.chains.filter((c) => c.uy === 0).sort((p, q) => p.offset - q.offset)[0]);

// ---------- 1. 累進で起点を動かし、「寸法線上のみ」を入れ、列を選んでおく ----------
await page.click('#btn-tool-ruishin');
await page.click('#btn-ruishin-on');
await wait(300);
{
  const s = await toScreen(9.1, bottom.offset);
  await page.touchscreen.tap(s.x, s.y - 4);
  await wait(300);
  const from = await toScreen(0, bottom.offset);
  const to = await toScreen(45.5 + 0.2, -0.15);
  await drag(from, to);
}
await page.click('#btn-ruishin-along');
await wait(250);
const inRuishin = await st();
const movedOrigin = await page.evaluate((id) => window.__jww.origins.get(id), bottom.id);
check('準備：累進で下の列を選び、起点を通り芯の交点（X3, Y0）へ動かし、「寸法線上のみ」を入れた',
  inRuishin.tool === 'ruishin' && inRuishin.on && inRuishin.active === bottom.id && inRuishin.layerActive === bottom.id
  && near(movedOrigin, 45.5, 0) && inRuishin.along && inRuishin.alongPressed === 'true' && inRuishin.past === 1 && inRuishin.hidden === 14,
  { inRuishin, movedOrigin });
await page.screenshot({ path: path.join(outDir, 'rm-1-ruishin.png') });

// 見える所の広さ（累進を切って計測しているとき）と比べるため、先に「累進表示」を切った状態の計測の画面を測る
const areaOf = () => page.evaluate(() => {
  const a = window.__jww;
  const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map((n) => Math.round(n * 10) / 10).join(); };
  return { area: JSON.stringify(a.visibleArea()), toolbar: r('toolbar'), btn: r('btn-tool-ruishin'), readout: r('readout') };
});

// ---------- 2. 「計測」に替える：累進は表示したまま、起点・設定・選んだ列は覚えたまま ----------
await page.click('#btn-tool-measure');
await wait(300);
const inMeasure = await st();
check('「計測」に替えても累進寸法を表示したまま（元の寸法値 14 個は隠したまま、計測のパネルが出る）',
  inMeasure.tool === 'measure' && inMeasure.on && inMeasure.hidden === 14 && inMeasure.layer && inMeasure.readout && !inMeasure.ruishinPanel, inMeasure);
check('計測のあいだも起点・「寸法線上のみ」・選んだ列・起点の履歴は覚えたまま',
  inMeasure.origins === inRuishin.origins && inMeasure.along && inMeasure.alongPressed === 'true' && inMeasure.active === bottom.id
  && inMeasure.past === inRuishin.past && inMeasure.future === inRuishin.future, inMeasure);
check('計測のあいだは選んだ列のオレンジの強調は出さない（8-4）', inMeasure.layerActive === -1, inMeasure);
check('「累進」ボタンの角に点が出て、読み上げは「累進（累進寸法を表示中）」', inMeasure.dot && inMeasure.label === '累進（累進寸法を表示中）', inMeasure);
check('計測に替えたときの短い案内は、累進寸法を表示したままと伝える', inMeasure.hint === 'タップで計測点を置きます（累進寸法は表示したまま）', { hint: inMeasure.hint });
const liveArea = await areaOf();
await page.screenshot({ path: path.join(outDir, 'rm-2-measure-live.png') });

// ---------- 3. 距離・面積・体積・角度：累進を表示したまま測れて、吸着・記録・番号札は今どおり ----------
const clearPoints = async () => {
  if ((await st()).points.length === 0) return;
  await page.click('#btn-clear');
  await wait(600);
};
const setMode = async (mode) => {
  await page.click(`#seg-mode button[data-mode="${mode}"]`);
  if (mode === 'volume') {
    await page.waitForSelector('#height-input', { state: 'visible' });
    await page.fill('#height-input', '2400');
    await page.click('#btn-height-ok');
  }
  await wait(300);
};
const cases = [
  { mode: 'length', name: '距離', pts: [[18.2, 0], [36.4, 0]] },
  { mode: 'area', name: '面積', pts: [[0, 0], [18.2, 0], [18.2, 18.2], [0, 18.2]] },
  { mode: 'volume', name: '体積', pts: [[18.2, 0], [36.4, 0], [36.4, 18.2], [18.2, 18.2]] },
  { mode: 'angle', name: '角度', pts: [[45.5, 0], [0, 0], [18.2, 18.2]] },
];
const measured = {};
let recordsSoFar = (await st()).records;
for (const c of cases) {
  await clearPoints();
  await setMode(c.mode);
  for (const [x, y] of c.pts) await tapWorld(x, y);
  const s = await st();
  measured[c.mode] = s.value;
  const snapped = c.pts.every(([x, y], i) => near(s.points[i], x, y) && s.points[i].kind !== 'free');
  check(`${c.name}：累進を表示したまま、通り芯の交点に吸着して測れる（値が出る、累進は表示したまま）`,
    s.mode === c.mode && s.points.length === c.pts.length && snapped && s.value !== '' && !s.value.startsWith('—')
    && s.on && s.hidden === 14 && s.layer && s.origins === inRuishin.origins && s.past === inRuishin.past,
    { mode: s.mode, value: s.value, points: s.points });
  await page.click('#btn-record');
  await wait(400);
  const r = await st();
  recordsSoFar += 1;
  check(`${c.name}：記録すると記録の数と番号札が 1 つ増え、累進の起点は変わらない`,
    r.records === recordsSoFar && r.badges === recordsSoFar && r.chip === `記録 ${recordsSoFar}` && r.origins === inRuishin.origins && r.on && r.hidden === 14,
    { records: r.records, badges: r.badges, chip: r.chip });
  await page.screenshot({ path: path.join(outDir, `rm-3-${c.mode}.png`) });
}
check('距離・面積・体積・角度の値（累進を表示したまま）', measured.length && measured.area && measured.volume && measured.angle, { measured });

// 同じ点を累進を切って測った値と同じ（計測の計算は累進の表示に左右されない、8 章 g）
{
  await page.click('#btn-tool-ruishin');
  await page.click('#btn-ruishin-on');
  await page.click('#btn-tool-measure');
  await wait(300);
  const offArea = await areaOf();
  const off = await st();
  check('累進を切って計測しているときは「累進」ボタンに点は出ない', !off.on && !off.dot && off.label === '累進' && off.hidden === 0 && !off.layer, off);
  check('点を出しても図面の見える所・下のツールバー・「累進」ボタンの大きさは変わらない（案内の文をずっと出したりしない）',
    offArea.area === liveArea.area && offArea.toolbar === liveArea.toolbar && offArea.btn === liveArea.btn && offArea.readout === liveArea.readout,
    { liveArea, offArea });
  // 前に記録した札（角度の札は頂点 (0, 0) にある）を押すと記録を見せるので、比べるあいだは札を隠しておく
  const toggleBadges = async () => {
    await page.click('#btn-records');
    await page.click('#btn-records-badges');
    await page.click('#btn-records-close');
    await wait(300);
  };
  await toggleBadges();
  const offValues = {};
  const offPoints = {};
  for (const c of cases) {
    await clearPoints();
    await setMode(c.mode);
    for (const [x, y] of c.pts) await tapWorld(x, y);
    const s = await st();
    offValues[c.mode] = s.value;
    offPoints[c.mode] = s.points;
  }
  check('累進を切って同じ点を測っても、距離・面積・体積・角度の値は同じ（計算は今のまま）',
    cases.every((c) => offValues[c.mode] === measured[c.mode]), { measured, offValues, offPoints });
  await clearPoints();
  await toggleBadges();
  await page.click('#btn-tool-ruishin');
  await page.click('#btn-ruishin-on');
  await page.click('#btn-tool-measure');
  await wait(300);
  const back = await st();
  check('「累進表示」を入れ直すと、起点は動かした所のまま', back.on && back.origins === inRuishin.origins && back.hidden === 14 && back.dot, back);
}
await setMode('length');

// ---------- 4. 番号札：累進を表示したまま、札を隠す・出すも今どおり ----------
{
  const before = await st();
  await page.click('#btn-records');
  await page.click('#btn-records-badges');
  await page.click('#btn-records-close');
  await wait(300);
  const hidden = await st();
  const icon = await page.evaluate(() => !!document.querySelector('#btn-records .badges-off'));
  await page.click('#btn-records');
  await page.click('#btn-records-badges');
  await page.click('#btn-records-close');
  await wait(300);
  const shown = await st();
  check('累進を表示したまま「札を表示」を切ると札が消えて目に斜線の印、入れると戻る（累進はそのまま）',
    before.badges === recordsSoFar && hidden.badges === 0 && icon && shown.badges === recordsSoFar
    && hidden.on && hidden.hidden === 14 && shown.hidden === 14 && shown.origins === inRuishin.origins, { before: before.badges, hidden: hidden.badges, icon, shown: shown.badges });
}

// ---------- 5. 描く順：累進の数字より上に計測の線・点・札を描く（8-4） ----------
{
  await useView();
  await tapWorld(18.2, 0);
  await tapWorld(36.4, 0);
  const order = await page.evaluate(async () => {
    const a = window.__jww;
    const m = await import('/src/ruishin/ordinate.ts');
    const labels = new Set();
    for (const c of a.chains) for (const s of m.ordinates(c, a.origins.get(c.id))) labels.add(m.formatValue(s.value, c.format));
    const ctx = a.overlay.ctx;
    const log = [];
    const orig = ctx.fillText;
    ctx.fillText = function (t, ...rest) { log.push(String(t)); return orig.call(this, t, ...rest); };
    try { a.draw(); } finally { ctx.fillText = orig; }
    const ord = log.map((t, i) => (labels.has(t) ? i : -1)).filter((i) => i >= 0);
    const other = log.map((t, i) => (!labels.has(t) ? i : -1)).filter((i) => i >= 0);
    return { ordCount: ord.length, otherCount: other.length, lastOrd: Math.max(...ord), firstOther: Math.min(...other), sample: log.slice(0, 6) };
  });
  check('計測の値・記録の札は、累進の数字を描いたあとに描く（累進の数字に隠れない）',
    order.ordCount > 0 && order.otherCount > 0 && order.lastOrd < order.firstOther, order);
  await clearPoints();
}

// ---------- 6. 拡大鏡の中にも累進の数字を描く（計測で点を置くとき） ----------
/** 拡大鏡の中の計測の層の、描いてある画素の数。without なら累進を描かずに数える */
const magnifierInk = () => page.evaluate(() => {
  const a = window.__jww;
  const m = a.magnifier;
  if (!m) return null;
  const count = () => {
    a.draw();
    const k = a.dpr;
    const img = a.overlay.ctx.getImageData(Math.round(m.x * k) + 4, Math.round(m.y * k) + 4, Math.round(m.size * k) - 8, Math.round(m.size * k) - 8);
    let n = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 40) n++;
    return n;
  };
  const withOrd = count();
  const orig = a.ordinateLayer;
  a.ordinateLayer = () => null;
  let withoutOrd;
  try { withoutOrd = count(); } finally { a.ordinateLayer = orig; }
  a.draw();
  return { withOrd, withoutOrd, box: { x: m.x, y: m.y, size: m.size } };
});
const holdAt = async (wx, wy, id = 7) => {
  const s = await toScreen(wx, wy);
  await page.evaluate(async ([x, y, id]) => {
    const stage = document.getElementById('stage');
    const o = { pointerId: id, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true };
    stage.dispatchEvent(new PointerEvent('pointerdown', o));
    await new Promise((r) => setTimeout(r, 450));
    stage.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: x + 2, clientY: y + 1 }));
    await new Promise((r) => setTimeout(r, 200));
  }, [s.x, s.y, id]);
  return s;
};
const release = async (s, type, id = 7) => {
  await page.evaluate(([x, y, type, id]) => {
    document.getElementById('stage').dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'touch', isPrimary: true, clientX: x + 2, clientY: y + 1, bubbles: true,
    }));
  }, [s.x, s.y, type, id]);
  await wait(300);
};
{
  await useView();
  const before = await st();
  const s = await holdAt(18.2, bottom.offset + 2);
  const ink = await magnifierInk();
  await page.screenshot({ path: path.join(outDir, 'rm-4-magnifier-measure.png') });
  check('計測で長押ししたときの拡大鏡の中に、累進の数字・矢印を描く', !!ink && ink.withOrd > ink.withoutOrd + 150, ink ?? {});
  await release(s, 'pointercancel');
  const after = await st();
  check('長押しをやめても、計測の点・累進の起点は変わらない', after.points.length === before.points.length && after.origins === before.origins, { before: before.points.length, after: after.points.length });
}

// ---------- 7. 計測中に起点の丸を押すと、起点は動かず計測の点が置かれる（8 章 c・8-4） ----------
{
  await useView();
  const before = await st();
  // 下の列の起点の丸は、寸法線の上の (45.5, -13)
  await tapWorld(45.5, bottom.offset);
  const t1 = await st();
  check('計測中に起点の丸をタップすると計測の点が置かれ、起点・選んだ列・起点の履歴は変わらない',
    t1.tool === 'measure' && t1.points.length === before.points.length + 1 && near(t1.points.at(-1), 45.5, bottom.offset)
    && t1.origins === before.origins && t1.active === before.active && t1.past === before.past && t1.future === before.future,
    { before: before.points, after: t1.points, past: t1.past });
  // いま置いた点を消してから、起点の丸を長押しして、ずらして離す（起点のドラッグにはならず、計測の点を置く）
  await page.click('#btn-undo');
  await wait(400);
  const from = await toScreen(45.5, bottom.offset);
  const to = await toScreen(36.4, bottom.offset);
  await drag(from, to, 450);
  const t2 = await st();
  check('計測中に起点の丸を長押ししてずらしても、起点は動かず、離した所に計測の点が置かれる',
    t2.points.length === before.points.length + 1 && near(t2.points.at(-1), 36.4, bottom.offset)
    && t2.origins === before.origins && t2.past === before.past, { points: t2.points, past: t2.past });
  await page.screenshot({ path: path.join(outDir, 'rm-5-origin-tap.png') });
}

// ---------- 8. 履歴は別々：計測の操作で起点は変わらず、起点の戻る・進むで計測の点は変わらない ----------
{
  await tapWorld(18.2, 0);
  await tapWorld(18.2, 18.2);
  const s0 = await st();
  await page.click('#btn-undo');
  await wait(400);
  const s1 = await st();
  check('計測の「1 点戻す」は計測の点だけを戻す（起点・起点の履歴は変わらない）',
    s1.points.length === s0.points.length - 1 && s1.origins === s0.origins && s1.past === s0.past && s1.future === s0.future, { s0: s0.points.length, s1: s1.points.length });
  await page.click('#btn-clear');
  await wait(600);
  const s2 = await st();
  await page.click('#btn-restore');
  await wait(400);
  const s3 = await st();
  check('計測の「すべて消去」「元に戻す」は計測の点だけ（起点・起点の履歴は変わらない）',
    s2.points.length === 0 && JSON.stringify(s3.points) === JSON.stringify(s1.points)
    && s2.origins === s0.origins && s3.origins === s0.origins && s3.past === s0.past && s3.future === s0.future,
    { s2: s2.points.length, s3: s3.points.length });
  // 累進に戻って起点を戻す・進める
  await page.click('#btn-tool-ruishin');
  await wait(300);
  const r0 = await st();
  await page.click('#btn-ruishin-undo');
  await wait(300);
  const r1 = await st();
  await page.click('#btn-ruishin-redo');
  await wait(300);
  const r2 = await st();
  check('起点の「戻る」「進む」は起点だけ（計測の点は数も位置も変わらない）',
    r1.origins !== r0.origins && r2.origins === r0.origins && r1.past === r0.past - 1 && r2.past === r0.past
    && JSON.stringify(r1.points) === JSON.stringify(s3.points) && JSON.stringify(r2.points) === JSON.stringify(s3.points),
    { r0: r0.past, r1: r1.past, r2: r2.past, points: r2.points.length });
}

// ---------- 9. 「累進」に戻ったとき：入ったまま、起点・「寸法線上のみ」・選んだ列もそのまま ----------
{
  const s = await st();
  check('「累進」に戻ると累進表示は入ったまま（オフからにしない）、選んだ列・「寸法線上のみ」・起点もそのまま',
    s.tool === 'ruishin' && s.on && s.onPressed === 'true' && s.hidden === 14 && s.active === bottom.id && s.layerActive === bottom.id
    && s.along && s.alongPressed === 'true' && s.origins === inRuishin.origins && s.ruishinPanel && !s.readout, s);
  check('「累進」を選んでいるあいだは、ボタンの角の点は出さない（ボタン自体が選んだ色になる）', !s.dot && s.label === '累進', s);
}

// ---------- 10. 拡大鏡の中にも累進の数字を描く（累進で起点を動かすとき） ----------
{
  await useView();
  const before = await st();
  // 選んだ列の起点の丸をつまむと、その場で拡大鏡が出る
  const s = await holdAt(45.5, bottom.offset, 8);
  const held = await page.evaluate(() => ({ drag: window.__jww.originDrag, mag: !!window.__jww.magnifier }));
  const ink = await magnifierInk();
  await page.screenshot({ path: path.join(outDir, 'rm-6-magnifier-ruishin.png') });
  check('累進で起点の丸をつまんでいるときの拡大鏡の中にも、累進の数字・矢印を描く',
    held.drag === bottom.id && held.mag && !!ink && ink.withOrd > ink.withoutOrd + 150, { held, ink });
  await release(s, 'pointercancel', 8);
  const after = await st();
  check('つまむのをやめると起点は元のまま', after.origins === before.origins && after.past === before.past, {});
}

// ---------- 11. 「属性」のあいだは隠し、「計測」「累進」に戻ると出す ----------
{
  await page.click('#btn-tool-inspect');
  await wait(300);
  const i = await st();
  check('「属性」のあいだは累進を隠して元の寸法（入・切・起点・選んだ列は覚えておく、点も出さない）',
    i.tool === 'inspect' && i.on && i.hidden === 0 && !i.layer && !i.dot && i.label === '累進'
    && i.origins === inRuishin.origins && i.active === bottom.id, i);
  check('「属性」に替えたときの案内は、属性のあいだは元の寸法で表示すると伝える',
    i.hint === '図形をタップすると属性を表示します（属性のあいだは元の寸法で表示）', { hint: i.hint });
  // 属性で寸法の数字の所をタップすると、元の寸法の図形を見られる
  await useView();
  await tapWorld(9.1, bottom.offset);
  const picked = await page.evaluate(() => window.__jww.selected);
  check('「属性」のあいだは図形をタップして属性を見られる', picked >= 0, { picked });
  await page.click('#btn-tool-measure');
  await wait(300);
  const m = await st();
  check('「属性」から「計測」に戻ると、また累進で表示する（点も出る）',
    m.tool === 'measure' && m.on && m.hidden === 14 && m.layer && m.dot && m.origins === inRuishin.origins, m);
  await page.click('#btn-tool-inspect');
  await page.click('#btn-tool-ruishin');
  await wait(300);
  const r = await st();
  check('「属性」から「累進」に戻ると、累進で表示し、選んだ列もそのまま',
    r.tool === 'ruishin' && r.on && r.hidden === 14 && r.active === bottom.id && r.layerActive === bottom.id, r);
  await page.click('#btn-tool-measure');
  await wait(300);
}

// ---------- 12. 道具の切り替えでない操作（レイヤ・表示・全体・ボタンを隠す）では累進はそのまま ----------
{
  const s0 = await st();
  await page.click('#btn-layers');
  await wait(300);
  await page.click('#btn-layer-close');
  await wait(200);
  const afterLayers = await st();
  await page.click('#btn-display');
  await wait(300);
  await page.click('#btn-display-close');
  await wait(200);
  const afterDisplay = await st();
  await page.click('#btn-fit');
  await wait(400);
  const afterFit = await st();
  await page.click('#btn-ui-hide');
  await wait(300);
  const hiddenUi = await st();
  await page.click('#btn-ui-show');
  await wait(300);
  const afterUi = await st();
  const same = (s) => s.tool === 'measure' && s.on && s.hidden === 14 && s.layer && s.origins === s0.origins && s.points.length === s0.points.length;
  check('「レイヤ」「表示」「全体」「ボタンを隠す」では、累進を表示したまま（点も覚えたまま）',
    [afterLayers, afterDisplay, afterFit, hiddenUi, afterUi].every(same) && afterUi.dot,
    { afterLayers: same(afterLayers), afterDisplay: same(afterDisplay), afterFit: same(afterFit), hiddenUi: same(hiddenUi), afterUi: same(afterUi) });
  await useView();
}

// ---------- 13. 累進の入・切や起点は端末に保存しない。別の図面を開くと切に戻る ----------
{
  const storage = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
  const keys = Object.keys(storage);
  const leaked = keys.filter((k) => /ruishin|origin|ordinate/i.test(k) || /ruishin|ordinate|"origins?"/i.test(storage[k] ?? ''));
  check('累進の入・切・起点・「寸法線上のみ」は端末に保存しない（保存の中身に累進の値が無い）', leaked.length === 0, { keys, leaked, storageAtStart });
  await openSample();
  const s = await st();
  const defaults = await page.evaluate(async () => {
    const a = window.__jww;
    const m = await import('/src/ruishin/ordinate.ts');
    return a.chains.every((c) => { const o = a.origins.get(c.id); const d = m.defaultOrigin(c); return o && o.x === d.x && o.y === d.y; });
  });
  check('別の図面を開くと「計測」で累進表示は切（点も出ない）、起点は最初の端に戻る',
    s.tool === 'measure' && !s.on && s.onPressed === 'false' && s.hidden === 0 && !s.layer && !s.dot && s.label === '累進'
    && s.active === -1 && s.past === 0 && s.future === 0 && defaults, { s, defaults });
  await page.screenshot({ path: path.join(outDir, 'rm-7-reopened.png') });
}

check('コンソールにエラーがない', errors.length === 0, { errors: errors.slice(0, 5) });

await browser.close();
await srv.close();

process.exit(report() ? 1 : 0);
