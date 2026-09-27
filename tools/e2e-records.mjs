// 計測の一時記録を確かめる。記録する（距離・面積）、「記録 N」の一覧、行を押して記録へ動く、図面の札を押す、
// 1 件消す、コピー、札を隠す、上限、別の図面を開く前の確認と、渡された図面で記録が消えたときの知らせ、横向きの一覧。
import { chromium, devices } from 'playwright';
import { startServer } from './serve.mjs';
import { defaultSample } from './samples.mjs';

const srv = await startServer({ port: 5323, host: false, quiet: true });
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

const tapAt = async (page, x, y) => {
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(220);
};

/** 点を順に置き、値の段が出てから少し待って（出た直後の押し間違いよけを越えて）「記録」を押す */
const measureAndRecord = async (page, pts) => {
  for (const [x, y] of pts) await tapAt(page, x, y);
  await page.waitForTimeout(500);
  await page.click('#btn-record');
  await frame(page);
};

const state = (page) => page.evaluate(() => {
  const a = window.__jww;
  const chip = document.getElementById('btn-records');
  return {
    n: a.records.length,
    nos: a.records.map((r) => r.no),
    modes: a.records.map((r) => r.mode),
    points: a.points.length,
    focus: a.focusNo,
    badges: a.recordBadges().map((b) => ({ no: b.no, x: Math.round(b.x), y: Math.round(b.y), focused: b.focused })),
    chipShown: !chip.classList.contains('hidden') && chip.getBoundingClientRect().width > 0,
    chipText: chip.textContent,
    hint: document.getElementById('hint').textContent,
    sheet: !document.getElementById('records-panel').classList.contains('hidden'),
    zoom: a.view.zoom,
  };
});

/** 記録の点の範囲（CSS ピクセル）と、バー・パネル・開いているシート・ツールバーに隠れない範囲 */
const fitInfo = (page, no) => page.evaluate((no) => {
  const a = window.__jww;
  const r = a.records.find((x) => x.no === no);
  const xs = [];
  const ys = [];
  for (const p of r.points) {
    const [x, y] = a.toCss(p.x, p.y);
    xs.push(x);
    ys.push(y);
  }
  const ins = a.measureInsets(true);
  const area = { left: ins.left, right: a.cssW - ins.right, top: ins.top, bottom: a.cssH - ins.bottom };
  const box = { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  return {
    box, area,
    inside: box.left >= area.left - 1 && box.right <= area.right + 1 && box.top >= area.top - 1 && box.bottom <= area.bottom + 1,
    // 記録の幅か高さが、見えている範囲のそれなりの割合を占める（小さすぎず、はみ出さない）
    share: Math.max((box.right - box.left) / (area.right - area.left), (box.bottom - box.top) / (area.bottom - area.top)),
  };
}, no);

/** 札のまわりに記録の色（青緑）の画素があるか */
const badgeInk = (page, b) => page.evaluate(({ x, y }) => {
  const c = document.getElementById('overlay');
  const k = c.width / c.clientWidth;
  const s = Math.round(28 * k);
  const d = c.getContext('2d').getImageData(Math.round(x * k - s / 2), Math.round(y * k - s / 2), s, s).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 150 && d[i + 1] > 190 && d[i + 2] > 170 && d[i + 3] > 200) n++;
  return { n, visible: getComputedStyle(c).visibility !== 'hidden' };
}, b);

// ---------- 縦向き（iPhone 14 Pro） ----------
{
  const { ctx, page } = await open({ ...devices['iPhone 14 Pro'], hasTouch: true });

  // 1. 距離を記録する
  const before = await page.evaluate(() => document.getElementById('btn-record').disabled);
  await tapAt(page, 110, 300);
  const one = await page.evaluate(() => document.getElementById('btn-record').disabled);
  await measureAndRecord(page, [[280, 300]]);
  const s1 = await state(page);
  const ink1 = s1.badges[0] ? await badgeInk(page, s1.badges[0]) : null;
  check('距離を記録すると 1 件になり、点は消え、「記録 1」と図面の札 ① が出る（点がないときや 1 点では押せない）',
    before && one && s1.n === 1 && s1.modes[0] === 'length' && s1.points === 0 && s1.chipShown && s1.chipText === '記録 1'
      && s1.badges.length === 1 && s1.hint.includes('① を記録しました') && ink1?.n > 20 && ink1.visible,
    { before, one, s1, ink1 });

  // 2. 面積を記録する
  await page.click('#seg-mode [data-mode="area"]');
  await page.waitForTimeout(1200);
  await measureAndRecord(page, [[100, 345], [290, 345], [290, 450], [100, 450]]);
  const s2 = await state(page);
  check('面積を記録すると 2 件になり、札が 2 つ出る', s2.n === 2 && s2.modes[1] === 'area' && s2.points === 0 && s2.badges.length === 2
    && s2.chipText === '記録 2' && s2.hint.includes('② を記録しました'), s2);
  await page.click('#seg-mode [data-mode="length"]');
  await page.waitForTimeout(1200);

  // 3. 一覧の行と文
  await page.click('#btn-records');
  await frame(page);
  const list = await page.evaluate(() => {
    const a = window.__jww;
    const rows = [...document.querySelectorAll('#records-list .record-row')].map((r) => r.textContent);
    return {
      rows,
      values: a.records.map((r) => r.value),
      summary: document.getElementById('records-summary').textContent,
      expanded: document.getElementById('btn-records').getAttribute('aria-expanded'),
      pressed: document.getElementById('btn-records-badges').getAttribute('aria-pressed'),
    };
  });
  check('「記録 2」で一覧が開き、行に番号・種類・値が並ぶ',
    list.rows.length === 2 && list.rows[0].includes('①') && list.rows[0].includes('距離') && list.rows[0].includes(list.values[0])
      && list.rows[1].includes('②') && list.rows[1].includes('面積') && list.rows[1].includes(list.values[1])
      && list.summary.startsWith('2 件') && list.expanded === 'true' && list.pressed === 'true',
    { rows: list.rows, summary: list.summary });

  // 4. 行を押すと、その記録へ動いて見せる（縦向きでは一覧を閉じる）
  const z0 = (await state(page)).zoom;
  await page.click('#records-list [data-focus="1"]');
  await frame(page);
  const s4 = await state(page);
  const f4 = await fitInfo(page, 1);
  check('行を押すと、その記録へ図面が動き（倍率も変わる）、記録が見える所に収まる。縦向きでは一覧を閉じる',
    s4.focus === 1 && !s4.sheet && Math.abs(Math.log(s4.zoom / z0)) > 0.01 && f4.inside && f4.share > 0.3 && f4.share < 0.95
      && s4.badges.find((b) => b.no === 1)?.focused === true,
    { focus: s4.focus, sheet: s4.sheet, z0, zoom: s4.zoom, ...f4 });
  const fitBtn = await page.evaluate(() => document.querySelector('#btn-fit span').textContent);
  check('記録へ動いたあとの右下のボタンは「全体」', fitBtn === '全体', { fitBtn });

  // 5. 図面の札を押すと、その記録を見せる（点は置かない）
  await page.click('#btn-fit');
  await page.waitForTimeout(300);
  const s5a = await state(page);
  const b2 = s5a.badges.find((b) => b.no === 2);
  const z5 = s5a.zoom;
  await tapAt(page, b2.x + 6, b2.y + 4);
  const s5 = await state(page);
  const f5 = await fitInfo(page, 2);
  check('計測のときに札 ② を押すと、点を置かずに ② へ動いて見せる', s5.focus === 2 && s5.points === 0
    && Math.abs(Math.log(s5.zoom / z5)) > 0.01 && f5.inside, { b2, focus: s5.focus, points: s5.points, ...f5 });

  // 属性のときも札を押せる（図形は選ばない）
  await page.click('#btn-tool-inspect');
  await page.click('#btn-fit');
  await page.waitForTimeout(300);
  const b1 = (await state(page)).badges.find((b) => b.no === 1);
  await tapAt(page, b1.x, b1.y);
  const s5b = await page.evaluate(() => ({ focus: window.__jww.focusNo, selected: window.__jww.selected }));
  check('属性のときに札 ① を押すと、図形を選ばずに ① を見せる', s5b.focus === 1 && s5b.selected === -1, s5b);
  await page.click('#btn-tool-measure');

  // 6. 札のない所を押すと、見せていた記録はしまい、点を置く
  await page.click('#btn-fit');
  await page.waitForTimeout(300);
  await tapAt(page, 196, 200);
  const s6 = await state(page);
  check('札のない所を押すと見せていた記録をしまい、ふつうに点を置く', s6.focus === null && s6.points === 1, { focus: s6.focus, points: s6.points });
  await page.waitForTimeout(500);
  await page.click('#btn-clear');
  await page.waitForTimeout(1200);

  // 7. コピー（クリップボードを差し替えて、写した文を確かめる）
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t) => { window.__copied = t; } },
    });
  });
  await page.click('#btn-records');
  await frame(page);
  await page.click('#btn-records-copy');
  await page.waitForTimeout(200);
  const copied = await page.evaluate(() => {
    const lines = (window.__copied ?? '').split('\n');
    const a = window.__jww;
    return {
      n: lines.length,
      first: lines[1] ?? '',
      second: lines[2] ?? '',
      v1: a.records[0].value,
      s1: a.records[0].scaleText,
      hint: document.getElementById('hint').textContent,
    };
  });
  check('コピーで、図面の名前の行のあとに ① 距離 … 1/○○ の形で 1 件 1 行ずつ写す',
    copied.n === 3 && copied.first.startsWith(`① 距離 ${copied.v1}`) && copied.first.endsWith(copied.s1)
      && copied.second.startsWith('② 面積 ') && copied.hint.includes('2 件の記録をコピーしました'),
    { n: copied.n, first: copied.first, second: copied.second, hint: copied.hint });
  // クリップボードが使えない環境でも止まらない
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  await page.click('#btn-records-copy');
  await page.waitForTimeout(200);
  const noClip = await page.evaluate(() => document.getElementById('hint').textContent);
  check('クリップボードが使えなくても、写せたか写せなかったかを知らせる', /コピーしました|コピーできませんでした/.test(noClip), { noClip });

  // 8. 1 件消す
  await page.click('#records-list [data-delete="1"]');
  await frame(page);
  const s8 = await state(page);
  const rows8 = await page.evaluate(() => document.querySelectorAll('#records-list .record-row').length);
  check('行の × でその記録だけを消す（ほかの番号はそのまま）', s8.n === 1 && s8.nos[0] === 2 && rows8 === 1 && s8.chipText === '記録 1'
    && s8.badges.length === 1, { n: s8.n, nos: s8.nos, rows8 });

  // 9. 札を隠すと、札の所を押してもふつうに点を置く
  const b9 = s8.badges[0];
  await page.click('#btn-records-badges');
  await frame(page);
  const pressed = await page.evaluate(() => document.getElementById('btn-records-badges').getAttribute('aria-pressed'));
  const hidden9 = await state(page);
  await page.click('#btn-records-close');
  await frame(page);
  await tapAt(page, b9.x, b9.y);
  const s9 = await state(page);
  check('「札を表示」を切ると札が消え、札のあった所を押すと点を置く', pressed === 'false' && hidden9.badges.length === 0
    && s9.points === 1 && s9.focus === null, { pressed, badges: hidden9.badges.length, points: s9.points, focus: s9.focus });
  await page.waitForTimeout(500);
  await page.click('#btn-clear');
  await page.waitForTimeout(1200);
  await page.click('#btn-records');
  await page.click('#btn-records-badges');
  await page.click('#btn-records-close');

  // 10. 上限
  await page.evaluate(() => {
    const a = window.__jww;
    const r = a.records[0];
    for (let i = a.records.length; i < 50; i++) a.records.push({ ...r, no: a.nextRecordNo++ });
    a.updateRecordsUi();
  });
  await measureAndRecord(page, [[110, 250], [280, 250]]);
  const s10 = await state(page);
  check('記録は 50 件まで（それ以上は知らせて、点は残す）', s10.n === 50 && s10.points === 2 && s10.hint.includes('50 件まで'),
    { n: s10.n, points: s10.points, hint: s10.hint });
  await page.evaluate(() => {
    const a = window.__jww;
    a.records.splice(1);
    a.updateRecordsUi();
  });
  await page.click('#btn-clear');
  await page.waitForTimeout(1200);

  // 11. 別の図面を開く前に確かめる。やめれば記録はそのまま
  await page.click('#btn-open');
  await page.waitForSelector('#recent-list [data-open]', { timeout: 5000 });
  let dialog = '';
  page.once('dialog', (d) => { dialog = d.message(); void d.dismiss(); });
  let chooser = false;
  const onChooser = () => { chooser = true; };
  page.on('filechooser', onChooser);
  await page.click('#btn-pick-file');
  await page.waitForTimeout(300);
  page.off('filechooser', onChooser);
  const s11 = await state(page);
  const filesOpen = await page.evaluate(() => !document.getElementById('files-panel').classList.contains('hidden'));
  check('記録があるときに「ファイルから選ぶ」を押すと確かめ、やめればファイルの選択を出さず記録も残す',
    dialog === '計測の記録（1 件）は消えます。別の図面を開きますか？' && !chooser && s11.n === 1 && filesOpen,
    { dialog, chooser, n: s11.n, filesOpen });
  // 開くと答えれば、開き直した図面で記録は消える
  let dialog2 = '';
  page.once('dialog', (d) => { dialog2 = d.message(); void d.accept(); });
  await page.click('#recent-list [data-open]');
  await page.waitForFunction(() => window.__jww.records.length === 0, null, { timeout: 60000 });
  await page.waitForTimeout(600);
  const s11b = await state(page);
  check('最近の図面から開くと答えると、読み込んだあと記録は消え、「記録 N」も札も消える',
    dialog2.includes('1 件') && s11b.n === 0 && !s11b.chipShown && s11b.badges.length === 0 && s11b.focus === null,
    { dialog2, n: s11b.n, chip: s11b.chipShown });

  // 12. 渡された図面（共有・ドラッグと同じく、確かめずに開く）では、開いたあと記録が消えたことを知らせる
  await measureAndRecord(page, [[110, 300], [280, 300]]);
  let asked = false;
  page.once('dialog', (d) => { asked = true; void d.accept(); });
  await page.setInputFiles('#file', sample);
  await page.waitForFunction(() => window.__jww.records.length === 0, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const s12 = await state(page);
  check('渡された図面を開くと確かめずに開き、前の記録が消えたことを知らせる', !asked && s12.n === 0
    && s12.hint.includes('計測の記録（1 件）は消えました'), { asked, hint: s12.hint });
  await ctx.close();
}

// ---------- 横向き：一覧は右に出したまま、左の図面に記録を収める ----------
{
  const { ctx, page } = await open({ viewport: { width: 852, height: 393 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await measureAndRecord(page, [[250, 200], [420, 200]]);
  await page.click('#btn-records');
  await frame(page);
  const sheet = await page.evaluate(() => {
    const r = document.getElementById('records-panel').getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, w: r.width, vw: innerWidth };
  });
  const z0 = (await state(page)).zoom;
  await page.click('#records-list [data-focus="1"]');
  await frame(page);
  const s = await state(page);
  const f = await fitInfo(page, 1);
  check('横向きでは一覧を右に縦長に出し、行を押しても開いたまま、記録は一覧の左の見える所に収まる',
    sheet.w < sheet.vw * 0.6 && sheet.left > sheet.vw / 2 - 40 && s.sheet && s.focus === 1 && f.inside && f.box.right <= sheet.left
      && Math.abs(Math.log(s.zoom / z0)) > 0.01,
    { sheet, focus: s.focus, ...f });
  await ctx.close();
}

check('コンソールにエラーがない', errors.length === 0, { errors: errors.slice(0, 5) });

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length ? 1 : 0);
