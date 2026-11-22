// 計測の記録の番号札（①②…）の回帰テスト。
// ① 31 通りの操作（記録・種類の切り替え・点の追加・すべて消去と元に戻す・1 点ずつ戻す・体積の高さをやめる・拡大・縮小・全体・前の範囲・
//    札を押す・図面を押す・一覧の開閉・札の表示の切り替え・ツールの切り替え・ボタンを隠す・横向き・裏へ回して戻る）のあとも、
//    札の数が記録の数と合い、図面の上に札の色で描かれていること（「札を表示」を切っているときは描かないこと）。
// ② 「札を表示」を切っているあいだは、上のバーの「記録 N」の横に「札なし」と出すこと。自動では入れ直さないこと
//    （新しく記録しても・ツールを替えても・向きを変えても・裏へ回しても・別の図面を開いても切ったまま）。
//    iPhone SE（320 幅）でも「記録 N 札なし」が切れずに収まり、隣のボタンと重ならないこと。
// 図面は公開してよい見本（public/ruishin-sample.jww）を使う（samples/ がなくても動く）。
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, projectRoot as root } from './serve.mjs';
import { makeJww } from './jww-synth.mjs';

const srv = await startServer({ port: 5328, host: false, quiet: true });
const sample = process.argv[2] || path.join(root, 'public', 'ruishin-sample.jww');

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const results = [];
const check = (name, ok, info) => results.push({ name, ok, ...(info ?? {}) });

const open = async (opts) => {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => { errors.push(`dialog: ${d.message()}`); void d.dismiss(); });
  await page.goto(srv.url, { waitUntil: 'networkidle' });
  await page.setInputFiles('#file', sample);
  await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
  await page.waitForTimeout(800);
  return { ctx, page };
};

const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const tap = async (page, x, y) => {
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(260);
};
/** 点を置いて記録する */
const record = async (page, pts) => {
  for (const [x, y] of pts) await tap(page, x, y);
  await page.waitForTimeout(500);
  await page.click('#btn-record');
  await frame(page);
};

/** 札と「記録 N」の様子。札の位置の周りで、札の色（青緑）の点がいくつ描かれているかも数える */
const badgeState = (page) => page.evaluate(() => {
  const a = window.__jww;
  const c = document.getElementById('overlay');
  const k = c.width / c.clientWidth;
  const g = c.getContext('2d');
  const badges = a.recordBadges();
  const ink = (x, y) => {
    const s = Math.round(28 * k);
    const d = g.getImageData(Math.round(x * k - s / 2), Math.round(y * k - s / 2), s, s).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 150 && d[i + 1] > 190 && d[i + 2] > 170 && d[i + 3] > 200) n++;
    return n;
  };
  const onScreen = (x, y) => x > 0 && x < a.cssW && y > 0 && y < a.cssH;
  const chip = document.getElementById('btn-records');
  return {
    recs: a.records.length,
    show: a.showBadges,
    focus: a.focusNo,
    badges: badges.length,
    vis: getComputedStyle(c).visibility,
    // 画面の中にある札ごとの、札の色の点の数
    ink: badges.filter((b) => onScreen(b.x, b.y)).map((b) => ({ no: b.no, n: ink(b.x, b.y) })),
    // 札を描いていない記録の位置（札を切っているとき）に、札の色が残っていないか
    hiddenInk: a.records.filter((r) => !badges.some((b) => b.no === r.no)).map((r) => {
      const p = a.recordAnchor(r);
      const [x, y] = a.toCss(p.x, p.y);
      return onScreen(x, y) ? ink(x, y) : 0;
    }),
    chipShown: !chip.classList.contains('hidden'),
    chipText: chip.textContent,
    offMark: chip.querySelector('.badges-off')?.textContent ?? null,
    aria: chip.getAttribute('aria-label'),
    listPressed: document.getElementById('btn-records-badges').getAttribute('aria-pressed'),
    tool: a.tool,
  };
});

/** 札が正しく出ているか（見せている記録＝一覧で押した記録は、札を切っていても出す） */
const badgesOk = (s) => {
  if (s.recs === 0) return s.badges === 0 && !s.chipShown;
  const want = s.show ? s.recs : (s.focus != null && s.focus >= 0 ? 1 : 0);
  if (s.badges !== want) return false;
  if (s.badges > 0 && s.vis === 'hidden') return false;
  if (s.ink.some((i) => i.n < 20)) return false;
  const chip = s.show ? `記録 ${s.recs}` : `記録 ${s.recs}札なし`;
  return s.chipShown && s.chipText === chip && (s.show ? s.offMark === null : s.offMark === '札なし');
};

// ================= ① 31 通りの操作のあとも札が消えない =================
{
  const { ctx, page } = await open({ ...devices['iPhone 14 Pro'], hasTouch: true });
  const step = async (label) => {
    await frame(page);
    await page.waitForTimeout(120);
    const s = await badgeState(page);
    check(`札：${label}`, badgesOk(s), s);
    return s;
  };
  await record(page, [[110, 260], [280, 260]]);
  await step('01 距離を記録する');
  await page.click('#seg-mode [data-mode="area"]');
  await page.waitForTimeout(1200);
  await record(page, [[100, 300], [290, 300], [290, 400], [100, 400]]);
  await step('02 面積を記録する');
  await page.click('#seg-mode [data-mode="length"]');
  await page.waitForTimeout(600);
  await step('03 距離に戻す');
  await tap(page, 150, 200);
  await tap(page, 250, 220);
  await page.waitForTimeout(500);
  await step('04 点を 2 つ置く');
  await page.click('#btn-clear');
  await page.waitForTimeout(600);
  await step('05 すべて消去');
  await page.click('#btn-restore');
  await page.waitForTimeout(600);
  await step('06 元に戻す');
  await page.click('#btn-undo');
  await page.waitForTimeout(600);
  await page.click('#btn-undo');
  await page.waitForTimeout(1600);
  await step('07 1 点ずつ戻して 0 点');
  for (const [i, m] of [['08', 'angle'], ['09', 'area'], ['10', 'length']]) {
    await page.click(`#seg-mode [data-mode="${m}"]`);
    await page.waitForTimeout(500);
    await step(`${i} 種類を ${m === 'angle' ? '角度' : m === 'area' ? '面積' : '距離'} にする`);
  }
  await page.click('#seg-mode [data-mode="volume"]');
  await page.waitForTimeout(500);
  if (await page.isVisible('#btn-height-cancel')) await page.click('#btn-height-cancel');
  await page.waitForTimeout(400);
  await step('11 体積 → 高さをやめる');
  await page.click('#seg-mode [data-mode="length"]');
  await page.waitForTimeout(500);
  await page.evaluate(() => { const a = window.__jww; a.view.zoom *= 3; a.requestDraw(true); });
  await step('12 拡大');
  await page.evaluate(() => { const a = window.__jww; a.view.zoom /= 9; a.requestDraw(true); });
  await step('13 縮小');
  await page.click('#btn-fit');
  await page.waitForTimeout(600);
  await step('14 全体');
  await page.click('#btn-fit');
  await page.waitForTimeout(600);
  await step('15 前の範囲');
  await page.click('#btn-fit');
  await page.waitForTimeout(600);
  const b1 = await page.evaluate(() => window.__jww.recordBadges()[0]);
  await tap(page, b1.x, b1.y);
  await page.waitForTimeout(800);
  const s16 = await step('16 札を押す');
  check('札を押すと、その記録を見せる', s16.focus === b1.no, { focus: s16.focus, no: b1.no });
  await tap(page, 200, 150);
  await page.waitForTimeout(500);
  await step('17 図面の札のない所を押す');
  await page.click('#btn-records');
  await page.waitForTimeout(400);
  await step('18 記録の一覧を開く');
  await page.click('#btn-records-badges');
  await page.waitForTimeout(300);
  const s19 = await step('19 「札を表示」を切る');
  check('「札を表示」を切ると図面の札は描かず、「記録 N」の横に「札なし」', !s19.show && s19.badges === 0 && s19.offMark === '札なし'
    && s19.listPressed === 'false' && s19.hiddenInk.every((n) => n < 20), s19);
  await page.click('#btn-records-badges');
  await page.waitForTimeout(300);
  const s20 = await step('20 「札を表示」を入れる');
  check('「札を表示」を入れ直すと札が戻り、「札なし」は消える', s20.show && s20.badges === s20.recs && s20.offMark === null && s20.listPressed === 'true', s20);
  await page.click('#btn-records-close');
  await page.waitForTimeout(400);
  await step('21 一覧を閉じる');
  const tools = [['22', 'btn-tool-ruishin', '累進'], ['23', 'btn-tool-inspect', '属性'], ['24', 'btn-layers', 'レイヤ'], ['25', 'btn-display', '表示'], ['26', 'btn-tool-measure', '計測']];
  for (const [i, t, name] of tools) {
    await page.click(`#${t}`);
    await page.waitForTimeout(500);
    await step(`${i} 「${name}」に切り替える`);
    if (t === 'btn-layers') { await page.click('#btn-layer-close'); await page.waitForTimeout(300); }
    if (t === 'btn-display') { await page.click('#btn-display-close'); await page.waitForTimeout(300); }
  }
  await page.click('#btn-ui-hide');
  await page.waitForTimeout(400);
  await step('27 ボタンを隠す');
  await page.click('#btn-ui-show');
  await page.waitForTimeout(400);
  await step('28 ボタンを出す');
  await page.setViewportSize({ width: 852, height: 393 });
  await page.waitForTimeout(800);
  await step('29 横向きにする');
  await page.setViewportSize({ width: 393, height: 659 });
  await page.waitForTimeout(800);
  await step('30 縦に戻す');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pageshow'));
  });
  await page.waitForTimeout(800);
  await step('31 アプリを裏へ回して戻る');
  const total = results.filter((r) => r.name.startsWith('札：')).length;
  check('札の操作は 31 通り試した', total === 31, { total });
  await ctx.close();
}

// ================= ② 「札を表示」を切っているあいだの「札なし」 =================
{
  const { ctx, page } = await open({ ...devices['iPhone 14 Pro'], hasTouch: true });
  await record(page, [[110, 260], [280, 260]]);
  const on = await badgeState(page);
  check('「札を表示」が入っているときは「記録 1」だけ（「札なし」は出さない）', on.show && on.chipText === '記録 1' && on.offMark === null
    && on.aria === '計測の記録（1 件）', on);

  await page.click('#btn-records');
  await page.click('#btn-records-badges');
  await page.click('#btn-records-close');
  await page.waitForTimeout(300);
  const off = await badgeState(page);
  const geo = await page.evaluate(() => {
    const chip = document.getElementById('btn-records').getBoundingClientRect();
    const mark = document.querySelector('#btn-records .badges-off').getBoundingClientRect();
    const cs = getComputedStyle(document.querySelector('#btn-records .badges-off'));
    return { chip: { l: chip.left, r: chip.right, t: chip.top, b: chip.bottom, h: chip.height }, mark: { l: mark.left, r: mark.right, t: mark.top, b: mark.bottom }, color: cs.color };
  });
  check('「札を表示」を切ると、「記録 1」の横（右）に「札なし」を出す', off.chipText === '記録 1札なし' && off.offMark === '札なし'
    && geo.mark.l > geo.chip.l + 20 && geo.mark.r <= geo.chip.r && geo.mark.t >= geo.chip.t && geo.mark.b <= geo.chip.b, { off, geo });
  check('読み上げでも、札を表示していないことが分かる', off.aria === '計測の記録（1 件・図面の札は表示していません）', off);

  // 新しく記録しても、自動では入れ直さない
  await page.click('#seg-mode [data-mode="length"]');
  await record(page, [[120, 330], [270, 360]]);
  const s2 = await badgeState(page);
  check('切ったまま新しく記録しても、自動では入れ直さない（「記録 2 札なし」、札は描かない）', !s2.show && s2.recs === 2 && s2.chipText === '記録 2札なし'
    && s2.badges === 0 && s2.hiddenInk.every((n) => n < 20), s2);

  // ツール・向き・ボタンを隠す・裏へ回すでも切ったまま
  for (const t of ['btn-tool-ruishin', 'btn-tool-inspect', 'btn-tool-measure']) {
    await page.click(`#${t}`);
    await page.waitForTimeout(300);
  }
  await page.setViewportSize({ width: 852, height: 393 });
  await page.waitForTimeout(600);
  const land = await badgeState(page);
  await page.setViewportSize({ width: 393, height: 659 });
  await page.waitForTimeout(600);
  await page.click('#btn-ui-hide');
  await page.waitForTimeout(300);
  await page.click('#btn-ui-show');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pageshow'));
  });
  await page.waitForTimeout(500);
  const after = await badgeState(page);
  check('ツールの切り替え・横向き・ボタンを隠す・裏へ回すのあとも切ったまま（「札なし」のまま）',
    !land.show && land.offMark === '札なし' && !after.show && after.offMark === '札なし' && after.badges === 0, { land, after });

  // 一覧で記録を押したときは、その札だけ出す（「札なし」はそのまま）
  await page.click('#btn-records');
  await page.waitForTimeout(300);
  await page.click('#records-list .record-row >> nth=0');
  await page.waitForTimeout(500);
  const focused = await badgeState(page);
  check('切っていても、一覧で押した記録の札だけは出す（「札なし」はそのまま）', !focused.show && focused.badges === 1 && focused.offMark === '札なし'
    && focused.ink.every((i) => i.n >= 20), focused);
  // 記録を押すと一覧は閉じて図面を見せる（開いたままなら閉じる）
  if (await page.isVisible('#btn-records-close')) await page.click('#btn-records-close');
  await page.waitForTimeout(300);

  // 別の図面を開いても切ったまま（記録は消えるので「記録 N」は隠れ、次に記録すると「札なし」付きで出る）
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'badges-')), 'badges-other.jww');
  fs.writeFileSync(file, makeJww({ entities: [{ line: [0, 0, 100, 0], color: 2, style: 1 }, { line: [0, 0, 0, 60], color: 2, style: 1 }], scale: 100 }));
  await page.setInputFiles('#file', file);
  await page.waitForFunction(() => document.getElementById('title')?.textContent === 'badges-other.jww', null, { timeout: 60000 });
  await page.waitForTimeout(600);
  const other = await badgeState(page);
  await record(page, [[110, 260], [280, 260]]);
  const other1 = await badgeState(page);
  check('別の図面を開いても自動では入れ直さない（記録すると「記録 1 札なし」）', other.recs === 0 && !other.chipShown && !other.show
    && other1.recs === 1 && other1.chipText === '記録 1札なし' && other1.badges === 0, { other, other1 });

  // 入れ直すと「札なし」は消え、札が戻る
  await page.click('#btn-records');
  await page.click('#btn-records-badges');
  await page.click('#btn-records-close');
  await page.waitForTimeout(300);
  const back = await badgeState(page);
  check('自分で「札を表示」を入れ直すと「札なし」は消え、札が戻る', back.show && back.chipText === '記録 1' && back.offMark === null
    && back.badges === 1 && back.ink.every((i) => i.n >= 20), back);
  await page.screenshot({ path: path.join(process.argv[3] ?? os.tmpdir(), 'badges-on.png') }).catch(() => {});
  await ctx.close();
}

// ================= ③ 狭い iPhone でも「記録 N 札なし」が上のバーに収まる =================
for (const [w, h] of [[320, 568], [375, 667], [390, 844], [568, 320], [852, 393]]) {
  const { ctx, page } = await open({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  // 記録を 12 件にして、2 けたの「記録 12 札なし」で確かめる
  const vp = page.viewportSize();
  const y = Math.max(110, vp.height * 0.3);
  for (let i = 0; i < 12; i++) {
    await tap(page, vp.width * 0.3, y);
    await tap(page, vp.width * 0.6, y + 20);
    await page.waitForTimeout(300);
    await page.click('#btn-record');
    await frame(page);
  }
  await page.click('#btn-records');
  await page.click('#btn-records-badges');
  await page.click('#btn-records-close');
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => {
    const ids = ['btn-open', 'title', 'btn-records', 'btn-ui-hide', 'btn-info'];
    const boxes = ids.map((id) => {
      const e = document.getElementById(id);
      const q = e.getBoundingClientRect();
      // 中の文字が枠の内側（余白の内側）からはみ出していないか
      const range = document.createRange();
      range.selectNodeContents(e);
      const c = range.getBoundingClientRect();
      const cs = getComputedStyle(e);
      const innerL = q.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
      const innerR = q.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
      const cut = id !== 'title' && (c.left < innerL - 0.5 || c.right > innerR + 0.5);
      return { id, l: q.left, r: q.right, t: q.top, b: q.bottom, w: q.width, h: q.height, cut };
    });
    return { boxes, text: document.getElementById('btn-records').textContent, vw: innerWidth };
  });
  const [open1, title, chip, hide, info] = r.boxes;
  const inside = r.boxes.every((b) => b.l >= -0.5 && b.r <= r.vw + 0.5);
  const order = open1.r <= title.l + 0.5 && title.r <= chip.l + 0.5 && chip.r <= hide.l + 0.5 && hide.r <= info.l + 0.5;
  check(`${w}×${h}：「記録 12 札なし」が切れずに 1 行で上のバーに収まり、ほかのボタンと重ならない`,
    r.text === '記録 12札なし' && r.boxes.every((b) => !b.cut && b.h <= 40) && inside && order && hide.w >= 36 && info.w >= 36 && open1.w >= 40, r);
  await ctx.close();
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
console.log(`${results.length - ng}/${results.length} OK`);
process.exit(ng ? 1 : 0);
