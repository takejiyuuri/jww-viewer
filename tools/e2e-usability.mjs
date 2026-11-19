// 1.3 の使いやすさの改善を確かめる。
// ① 確かめる窓（iOS の英語の確認の代わり）：日本語、危険なボタンは赤、やめる・窓の外・Esc でやめる、出た直後の押し間違い、
//    ファイルの選択は窓のボタンを押したその場で出る、別の図面が届いたら窓を閉じる。
// ② 押せる所の大きさ：iPhone SE 相当（320×568・375×667）・通常（390×844）・横向き（667×375・568×320・852×393）・iPad で、
//    ボタンの押せる所が 44×44 以上か、見えているボタンの上に隣の押せる所が重なっていないか、押せる所が図面の側へはみ出していないか。
// ③ 「すべて消去」のあとの「元に戻す」：戻せる・二度は戻らない・続けて押した 2 回目で戻らない・次の点を置いたら戻せない・
//    種類を変えたら戻せない・別の図面には戻さない。
// ④ 入・切のスイッチと実行のボタンの見分け、危険な操作の赤と離し方。
// ⑤ 戻る・進むのアイコンがそろっていて、計測・累進・レイヤの履歴が混ざらない。
// 図面は公開してよい見本（public/ruishin-sample.jww）を使う（samples/ がなくても動く）。
import { chromium } from 'playwright';
import path from 'node:path';
import { startServer, projectRoot as root } from './serve.mjs';

const srv = await startServer({ port: 5326, host: false, quiet: true });
const sample = process.argv[2] || path.join(root, 'public', 'ruishin-sample.jww');
const sample2 = process.argv[3] || sample;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const results = [];
const check = (name, ok, info) => results.push({ name, ok, ...(info ?? {}) });
/** iOS の確認（window.confirm など）が出たら数える。1.3 では 1 度も出ないこと */
let nativeDialogs = 0;

const phone = (w, h, dpr = 2) => ({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true });

const open = async (opts) => {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => { nativeDialogs++; void d.dismiss(); });
  await page.goto(srv.url, { waitUntil: 'networkidle' });
  await page.setInputFiles('#file', sample);
  await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
  await page.waitForTimeout(600);
  return { ctx, page };
};

const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const wait = (page, ms) => page.waitForTimeout(ms);

const tapAt = async (page, x, y) => {
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(220);
};

/** 図面の見えている所に、横に並んだ点を n 個置く（パネルに重ならない画面の上のほう） */
const placePoints = async (page, n) => {
  const vp = page.viewportSize();
  const top = await page.evaluate(() => document.getElementById('topbar').getBoundingClientRect().bottom);
  const y = Math.max(top + 60, vp.height * 0.3);
  for (let i = 0; i < n; i++) await tapAt(page, vp.width * 0.25 + i * 40, y + (i % 2) * 30);
  await wait(page, 500);
};

const st = (page) => page.evaluate(() => {
  const a = window.__jww;
  const ro = document.getElementById('readout');
  const shown = (id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  return {
    points: a.points.map((p) => [p.x, p.y]),
    cleared: a.cleared ? a.cleared.points.length : null,
    undoing: ro.classList.contains('undoing'),
    undoShown: shown('readout-undo'),
    undoMain: document.getElementById('undo-main').textContent,
    topShown: shown('readout-value'),
    records: a.records.length,
    confirm: !document.getElementById('confirm-dialog').classList.contains('hidden'),
    hint: document.getElementById('hint').textContent,
    mode: a.measurePrefs.mode,
  };
});

/** 確かめる窓の中身 */
const confirmState = (page) => page.evaluate(() => {
  const ok = document.getElementById('btn-confirm-ok');
  const cancel = document.getElementById('btn-confirm-cancel');
  const bg = getComputedStyle(ok).backgroundColor.match(/\d+/g).map(Number);
  const o = ok.getBoundingClientRect();
  const c = cancel.getBoundingClientRect();
  return {
    shown: !document.getElementById('confirm-dialog').classList.contains('hidden'),
    title: document.getElementById('confirm-title').textContent,
    text: document.getElementById('confirm-text').textContent,
    ok: ok.textContent,
    cancel: cancel.textContent,
    okRed: bg[0] > 180 && bg[1] < 90 && bg[2] < 90,
    // やめるは左、危険なボタンは右に離して置く
    apart: o.left - c.right,
    cancelLeft: c.left < o.left,
    focused: document.activeElement?.id ?? null,
  };
});

// ================= ① 確かめる窓 =================
{
  const { ctx, page } = await open(phone(390, 844, 3));
  let choosers = 0;
  page.on('filechooser', () => { choosers++; });

  // 記録を 1 つ作る
  await placePoints(page, 2);
  await page.click('#btn-record');
  await frame(page);
  check('準備：記録が 1 件ある', (await st(page)).records === 1);

  // 記録の「すべて消す」→ 窓。やめる・窓の外・Esc ではどれも消えない
  await page.click('#btn-records');
  await page.click('#btn-records-clear');
  await frame(page);
  const c1 = await confirmState(page);
  check('記録の「すべて消す」は、アプリの中の日本語の窓で確かめる（危険なボタンは赤い「消す」、やめるは左、最初は「やめる」を選んでいる）',
    c1.shown && c1.title === '計測の記録（1 件）をすべて消しますか？' && c1.ok === '消す' && c1.cancel === 'やめる' && c1.okRed
      && c1.cancelLeft && c1.apart >= 10 && c1.focused === 'btn-confirm-cancel', c1);
  await page.click('#btn-confirm-cancel');
  check('「やめる」では記録は消えない', (await st(page)).records === 1 && !(await st(page)).confirm);

  await page.click('#btn-records-clear');
  await wait(page, 400);
  // 窓の外（暗くした所）の、窓から離れた下のほう
  const vp = page.viewportSize();
  await page.mouse.click(vp.width / 2, vp.height - 20);
  await frame(page);
  check('窓の外を押すとやめる（記録は消えない）', (await st(page)).records === 1 && !(await st(page)).confirm);

  await page.click('#btn-records-clear');
  await page.keyboard.press('Escape');
  await frame(page);
  check('Esc でやめる（記録は消えない）', (await st(page)).records === 1 && !(await st(page)).confirm);

  // 窓が出た直後（続けて押したタップ）は「消す」を押しても消さない。少し待てば消せる
  await page.click('#btn-records-clear');
  await page.evaluate(() => document.getElementById('btn-confirm-ok').click());
  const quick = await st(page);
  check('窓が出た直後に続けて押したタップでは「消す」が働かない', quick.records === 1 && quick.confirm, quick);
  await wait(page, 400);
  await page.click('#btn-confirm-ok');
  await frame(page);
  const cleared = await st(page);
  check('少し待って「消す」を押すと、記録をすべて消して窓を閉じる', cleared.records === 0 && !cleared.confirm, cleared);
  await page.click('#btn-records-close');

  // 別の図面を開く前の確認：記録があるときは窓、「消して開く」を押したその場でファイルの選択が出る
  await placePoints(page, 2);
  await page.click('#btn-record');
  await frame(page);
  await page.click('#btn-open');
  await frame(page);
  await page.click('#btn-pick-file');
  await wait(page, 300);
  const c2 = await confirmState(page);
  check('記録があるとき「ファイルから選ぶ」は先に窓で確かめ、まだファイルの選択は出さない（危険なボタンは赤い「消して開く」）',
    c2.shown && c2.title === '計測の記録（1 件）が消えます' && c2.ok === '消して開く' && c2.okRed && choosers === 0, { ...c2, choosers });
  await page.click('#btn-confirm-cancel');
  await wait(page, 300);
  check('「やめる」ではファイルの選択を出さず、記録も残る', choosers === 0 && (await st(page)).records === 1, { choosers });

  await page.click('#btn-open');
  await frame(page);
  await page.click('#btn-pick-file');
  await wait(page, 400);
  const chooserP = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
  await page.click('#btn-confirm-ok');
  const chooser = await chooserP;
  check('「消して開く」を押したその場でファイルの選択が出る（iOS の「押した直後でないと出せない」を守る）', !!chooser && !(await st(page)).confirm,
    { chooser: !!chooser });
  if (chooser) {
    await chooser.setFiles(sample2);
    await page.waitForFunction(() => window.__jww.records.length === 0, null, { timeout: 30000 }).catch(() => {});
    await wait(page, 600);
  }
  check('選んだ図面が開き、前の図面の記録は消える', (await st(page)).records === 0);

  // 最近の一覧がないとき（「ファイル」で直接選ぶ）も、窓の「消して開く」から選択が出る
  await placePoints(page, 2);
  await page.click('#btn-record');
  await frame(page);
  await page.evaluate(() => { window.__jww.recent = []; });
  await page.click('#btn-open');
  await wait(page, 400);
  const before = choosers;
  const c3 = await confirmState(page);
  const chooser3P = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
  await page.click('#btn-confirm-ok');
  const chooser3 = await chooser3P;
  check('最近の一覧がないときの「ファイル」も、窓で確かめてから押したその場で選択を出す', c3.shown && before === choosers - 1 && !!chooser3,
    { shown: c3.shown, chooser: !!chooser3 });
  // 選ばずにやめたときは、記録はそのまま
  await wait(page, 300);
  check('ファイルを選ばずにやめたときは、記録はそのまま', (await st(page)).records === 1);

  // 見本の図面・最近の図面も、記録があれば窓で確かめる
  await page.evaluate(() => window.__jww.openSample());
  await frame(page);
  const c4 = await confirmState(page);
  await page.click('#btn-confirm-cancel');
  await wait(page, 300);
  check('見本の図面を開くときも窓で確かめ、やめれば開かない', c4.shown && c4.ok === '消して開く' && (await st(page)).records === 1, c4);

  // 窓を出しているあいだに別の図面が届いたら（共有など）、窓は閉じ、窓の答えは新しい図面に当てない
  let ran = false;
  await page.exposeFunction('__ran', () => { ran = true; });
  await page.evaluate(() => window.__jww.askConfirm({ title: 't', text: 't', ok: '消す' }, () => window.__ran()));
  await page.setInputFiles('#file', sample);
  await page.waitForFunction(() => window.__jww.records.length === 0, null, { timeout: 30000 }).catch(() => {});
  await wait(page, 500);
  const c5 = await confirmState(page);
  check('窓を出しているあいだに別の図面が開いたら、窓を閉じ、窓のことはしない', !c5.shown && !ran, { shown: c5.shown, ran });

  check('iOS の確認（英語の Cancel / OK）は 1 度も出ない', nativeDialogs === 0, { nativeDialogs });
  await ctx.close();
}

// ================= ③ 「すべて消去」のあとの「元に戻す」 =================
{
  const { ctx, page } = await open(phone(390, 844, 3));
  await placePoints(page, 3);
  const p0 = (await st(page)).points;
  const undoBtn = await page.evaluate(() => {
    const r = document.getElementById('btn-clear').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.click('#btn-clear');
  await frame(page);
  const s1 = await st(page);
  check('「すべて消去」で点が消え、値の段の代わりに「3 点を消しました」と「元に戻す」が出る（次の点を置くまで戻せると書く）',
    s1.points.length === 0 && s1.undoing && s1.undoShown && !s1.topShown && s1.undoMain === '3 点を消しました' && s1.cleared === 3, s1);
  const sub = await page.evaluate(() => document.querySelector('.undo-sub').textContent);
  check('戻せる条件を段の中に書く', sub === '次の点を置くまで戻せます', { sub });

  // 消去を続けて 2 回押した 2 回目（同じ所）では戻さない
  await page.touchscreen.tap(undoBtn.x, undoBtn.y);
  await frame(page);
  check('消去を続けて押した 2 回目は「元に戻す」にならない（すぐには戻さない）', (await st(page)).points.length === 0 && (await st(page)).undoing);
  await wait(page, 500);
  await page.click('#btn-restore');
  await frame(page);
  const s2 = await st(page);
  check('「元に戻す」で消す前の点が同じ位置に戻り、元に戻すの段は消える', JSON.stringify(s2.points) === JSON.stringify(p0) && !s2.undoing && s2.topShown
    && s2.cleared === null && s2.hint.includes('3 点を元に戻しました'), s2);
  // 戻した直後に同じ所を続けて押しても（そこには消去が戻ってくる）、消去は働かない
  await page.touchscreen.tap(undoBtn.x, undoBtn.y);
  await frame(page);
  check('戻した直後に続けて押したタップで、戻ってきた消去は働かない', (await st(page)).points.length === 3);
  // 二重に戻らない
  await page.evaluate(() => window.__jww.restoreCleared());
  check('戻したあとにもう一度戻しても、点は増えない（二重に戻さない）', (await st(page)).points.length === 3);

  // 次の点を置いたら戻せない
  await wait(page, 500);
  await page.click('#btn-clear');
  await wait(page, 300);
  await placePoints(page, 1);
  const s3 = await st(page);
  check('消去のあとで次の点を置くと、消した点は戻せなくなる（元に戻すの段が消える）', s3.points.length === 1 && s3.cleared === null && !s3.undoing, s3);
  await page.evaluate(() => window.__jww.restoreCleared());
  check('そのあと戻そうとしても、いまの点は変わらない', (await st(page)).points.length === 1);

  // 計測の種類を変えたら戻せない
  await placePoints(page, 2);
  await wait(page, 300);
  await page.click('#btn-clear');
  await wait(page, 300);
  await page.click('#seg-mode [data-mode="area"]');
  await frame(page);
  const s4 = await st(page);
  check('消去のあとで計測の種類を変えると、消した点は戻せなくなる', s4.cleared === null && !s4.undoing && s4.mode === 'area', s4);
  await page.click('#seg-mode [data-mode="length"]');
  await frame(page);

  // 別の図面には戻さない
  await placePoints(page, 3);
  await page.click('#btn-clear');
  await wait(page, 300);
  check('準備：消した点を覚えている', (await st(page)).cleared === 3);
  await page.setInputFiles('#file', sample2);
  await page.waitForFunction(() => window.__jww.cleared === null, null, { timeout: 30000 }).catch(() => {});
  await wait(page, 800);
  await page.evaluate(() => window.__jww.restoreCleared());
  const s5 = await st(page);
  check('別の図面（同じ図面を開き直したときも）を開くと、前の図面の消した点は戻さない', s5.points.length === 0 && s5.cleared === null && !s5.undoing, s5);

  // 1 点戻す（↶）では元に戻すの段は出ない（これまでどおり）
  await placePoints(page, 1);
  await wait(page, 300);
  await page.click('#btn-undo');
  await wait(page, 1300);
  const s6 = await st(page);
  check('「1 点戻す」で点がなくなったときは、これまでどおり値の段をしまう（元に戻すの段は出さない）', s6.points.length === 0 && !s6.undoing && !s6.topShown, s6);

  // 画面を回しても元に戻すの段は残り、押せる
  await placePoints(page, 2);
  await page.click('#btn-clear');
  await page.setViewportSize({ width: 844, height: 390 });
  await wait(page, 700);
  const land = await page.evaluate(() => {
    const u = document.getElementById('readout-undo').getBoundingClientRect();
    const b = document.getElementById('btn-restore').getBoundingClientRect();
    const main = document.getElementById('undo-main');
    return { shown: u.height > 0, inside: b.right <= innerWidth && b.bottom <= innerHeight, fits: main.scrollWidth <= main.clientWidth };
  });
  await page.click('#btn-restore');
  check('横向きに回しても元に戻すの段が見えていて、押すと戻る', land.shown && land.inside && land.fits && (await st(page)).points.length === 2, land);
  await ctx.close();
}

// ================= ④ 入・切のスイッチと実行のボタン、危険な操作 =================
{
  const { ctx, page } = await open(phone(390, 844, 3));
  await page.click('#btn-tool-ruishin');
  await frame(page);
  const tg = await page.evaluate(() => {
    const info = (id) => {
      const b = document.getElementById(id);
      const t = b.querySelector('.tgl');
      return {
        tgl: !!t && t.getBoundingClientRect().width > 0,
        pressed: b.getAttribute('aria-pressed'),
        track: t ? getComputedStyle(t).backgroundColor : null,
        knob: t ? getComputedStyle(t, '::after').left : null,
      };
    };
    return {
      on: info('btn-ruishin-on'), along: info('btn-ruishin-along'),
      resetTgl: !!document.getElementById('btn-ruishin-reset').querySelector('.tgl'),
      resetPressed: document.getElementById('btn-ruishin-reset').hasAttribute('aria-pressed'),
    };
  });
  await page.click('#btn-ruishin-on');
  await frame(page);
  const tg2 = await page.evaluate(() => {
    const t = document.querySelector('#btn-ruishin-on .tgl');
    return { pressed: document.getElementById('btn-ruishin-on').getAttribute('aria-pressed'), track: getComputedStyle(t).backgroundColor, knob: getComputedStyle(t, '::after').left };
  });
  check('累進表示・寸法線上のみはスイッチの絵つき、全列を戻すはスイッチなしの実行のボタン', tg.on.tgl && tg.along.tgl && !tg.resetTgl && !tg.resetPressed, tg);
  check('累進表示を入れると、スイッチが緑になりつまみが右へ動く（切ると灰色で左）',
    tg.on.pressed === 'false' && tg2.pressed === 'true' && tg.on.track !== tg2.track && parseFloat(tg2.knob) > parseFloat(tg.on.knob), { off: tg.on, on: tg2 });

  await page.click('#btn-tool-measure');
  await frame(page);
  const ortho = await page.evaluate(() => {
    const b = document.getElementById('btn-ortho');
    const t = b.querySelector('.tgl');
    return { pressed: b.getAttribute('aria-pressed'), tgl: t.getBoundingClientRect().width > 0, label: b.querySelector('.label').getBoundingClientRect().width > 0 };
  });
  check('直交はスイッチの絵と「直交」の文字（通常の幅）', ortho.pressed === 'true' && ortho.tgl && ortho.label, ortho);

  // 危険な操作（点の消去）は赤く、戻すから離す
  await placePoints(page, 2);
  const danger = await page.evaluate(() => {
    const rgb = (el) => getComputedStyle(el).color.match(/\d+/g).map(Number);
    const c = document.getElementById('btn-clear');
    const u = document.getElementById('btn-undo');
    const red = (v) => v[0] > 200 && v[1] < 140 && v[2] < 140;
    return {
      clearRed: red(rgb(c)), undoRed: red(rgb(u)),
      gap: c.getBoundingClientRect().left - u.getBoundingClientRect().right,
    };
  });
  check('点の「すべて消去」は赤、戻すは赤くない。消去は戻すから 12px 以上離す', danger.clearRed && !danger.undoRed && danger.gap >= 12, danger);
  await page.click('#btn-record');
  await frame(page);
  await page.click('#btn-records');
  await frame(page);
  const rec = await page.evaluate(() => {
    const rgb = (el) => getComputedStyle(el).color.match(/\d+/g).map(Number);
    const red = (v) => v[0] > 200 && v[1] < 140 && v[2] < 140;
    const b = document.getElementById('btn-records-badges');
    const c = document.getElementById('btn-records-clear');
    return {
      badgesTgl: !!b.querySelector('.tgl'), pressed: b.getAttribute('aria-pressed'),
      clearRed: red(rgb(c)), copyRed: red(rgb(document.getElementById('btn-records-copy'))),
      gap: c.getBoundingClientRect().left - b.getBoundingClientRect().right,
      sameRow: Math.abs(c.getBoundingClientRect().top - b.getBoundingClientRect().top) < 2,
    };
  });
  await page.click('#btn-records-badges');
  await frame(page);
  const pressed2 = await page.getAttribute('#btn-records-badges', 'aria-pressed');
  check('記録の「札を表示」はスイッチ（押すと切になる）、「すべて消す」は赤く、ほかのボタンから離す',
    rec.badgesTgl && rec.pressed === 'true' && pressed2 === 'false' && rec.clearRed && !rec.copyRed && (!rec.sameRow || rec.gap >= 14), { ...rec, pressed2 });
  await ctx.close();
}

// ================= ⑤ 戻る・進むのアイコンと、履歴が混ざらないこと =================
{
  const { ctx, page } = await open(phone(390, 844, 3));
  const icons = await page.evaluate(() => {
    const href = (id) => document.querySelector(`#${id} use`)?.getAttribute('href');
    return {
      undo: ['btn-undo', 'btn-ruishin-undo', 'btn-layer-undo', 'btn-layer-list-undo'].map(href),
      redo: ['btn-ruishin-redo', 'btn-layer-redo', 'btn-layer-list-redo'].map(href),
      flipped: document.querySelectorAll('.flip-x').length,
      fit: href('btn-fit'),
    };
  });
  check('戻るは計測・累進・レイヤとも同じ ↶、進むは累進・レイヤとも同じ ↷（左右に返した絵は使わない）',
    icons.undo.every((h) => h === '#i-undo') && icons.redo.every((h) => h === '#i-redo') && icons.flipped === 0, icons);

  // 計測の点を 2 つ
  await placePoints(page, 2);
  // 累進：起点を 1 回動かす
  await page.click('#btn-tool-ruishin');
  await page.click('#btn-ruishin-on');
  await page.evaluate(() => {
    const a = window.__jww;
    const c = a.chains[0];
    const o = a.origins.get(c.id);
    a.setOrigin(c.id, { x: o.x + c.ux * 100, y: o.y + c.uy * 100 });
    a.updateRuishinPanel();
  });
  // レイヤ：反転を 2 回（見え方は元どおり、履歴は 2 段）
  await page.click('#btn-layers');
  await page.click('#btn-layer-invert-all');
  await page.click('#btn-layer-invert-all');
  await frame(page);
  const h = () => page.evaluate(() => {
    const a = window.__jww;
    return { points: a.points.length, origin: [a.originPast.length, a.originFuture.length], layer: [a.layerPast.length, a.layerFuture.length] };
  });
  const h0 = await h();
  await page.click('#btn-layer-list-undo');
  const h1 = await h();
  check('レイヤの ↶ はレイヤの表示だけを戻す（計測の点・累進の起点の履歴は変わらない）',
    h0.layer[0] === 2 && h1.layer[0] === 1 && h1.layer[1] === 1 && h1.points === 2 && h1.origin[0] === 1, { h0, h1 });
  await page.click('#btn-layer-list-redo');
  await page.click('#btn-layer-close');
  await page.click('#btn-ruishin-undo');
  const h2 = await h();
  await page.click('#btn-ruishin-redo');
  const h3 = await h();
  check('累進の ↶ ↷ は起点だけを戻す・進める（レイヤの履歴と計測の点は変わらない）',
    h2.origin[0] === 0 && h2.origin[1] === 1 && h3.origin[0] === 1 && h2.layer[0] === 2 && h2.points === 2, { h2, h3 });
  await page.click('#btn-tool-measure');
  await wait(page, 500);
  await page.click('#btn-undo');
  const h4 = await h();
  check('計測の ↶ は点を 1 つ戻すだけ（レイヤ・累進の履歴は変わらない）', h4.points === 1 && h4.origin[0] === 1 && h4.layer[0] === 2, h4);
  const fit = await page.evaluate(() => document.querySelector('#btn-fit use').getAttribute('href'));
  check('「全体」「前の範囲」のアイコンは操作の戻る（↶）とは別のまま', fit === '#i-fit', { fit });
  await ctx.close();
}

// ================= ② 押せる所の大きさ（縦・横、小さい画面・通常・iPad） =================

/**
 * ボタンごとに、押せる所（elementFromPoint でそのボタンに当たる所）の外接の大きさを 1px おきに測る。
 * あわせて、見えている所（内側 2px）がほかのボタンの押せる所に覆われていないか、
 * 押せる所が入れ物（バー・パネル・シート・窓）の外（図面の側）へはみ出していないかも見る
 */
const measureHits = (page, sel) => page.evaluate((sel) => {
  const holders = '#topbar, #toolbar, .panel, .sheet, .dialog, #color-pop';
  const out = [];
  for (const b of document.querySelectorAll(sel)) {
    const r = b.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (getComputedStyle(b).visibility === 'hidden') continue;
    const mine = (x, y) => {
      const e = document.elementFromPoint(x, y);
      return !!e && (e === b || b.contains(e));
    };
    // 送れる一覧の端で一部が隠れているものは、見えている所だけでは測れないので数えない
    let clipped = false;
    for (let p = b.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p);
      if (o.overflowY === 'visible' && o.overflowX === 'visible') continue;
      const c = p.getBoundingClientRect();
      if (r.top < c.top || r.bottom > c.bottom || r.left < c.left || r.right > c.right) clipped = true;
    }
    // 真ん中が見えていない（ほかのものの下）ボタンも数えない
    if (clipped || !mine(r.left + r.width / 2, r.top + r.height / 2)) {
      out.push({ id: b.id || b.textContent.trim().slice(0, 10), covered: true });
      continue;
    }
    // 1px おきに当たる所を探し、端は真ん中の行・列で 1/64px まで詰める（整数の画素で数えると 1px 小さく出るため）
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let y = Math.floor(r.top) - 14; y <= Math.ceil(r.bottom) + 14; y++) {
      for (let x = Math.floor(r.left) - 14; x <= Math.ceil(r.right) + 14; x++) {
        if (!mine(x + 0.5, y + 0.5)) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    /** in（当たる）と out（当たらない）のあいだの境目 */
    const edge = (inV, outV, at) => {
      let a = inV, o = outV;
      for (let k = 0; k < 8; k++) {
        const m = (a + o) / 2;
        if (at(m)) a = m; else o = m;
      }
      return (a + o) / 2;
    };
    const left = edge(minX + 0.5, minX - 1, (x) => mine(x, cy));
    const right = edge(maxX + 0.5, maxX + 2, (x) => mine(x, cy));
    const top = edge(minY + 0.5, minY - 1, (y) => mine(cx, y));
    const bottom = edge(maxY + 0.5, maxY + 2, (y) => mine(cx, y));
    // 見えている所（角の丸みの外を除いた内側）は、どこを押してもこのボタン
    const cs = getComputedStyle(b);
    const rad = cs.borderTopLeftRadius.endsWith('%')
      ? (Math.min(r.width, r.height) * parseFloat(cs.borderTopLeftRadius)) / 100
      : parseFloat(cs.borderTopLeftRadius) || 0;
    const ins = 2 + Math.min(rad, Math.min(r.width, r.height) / 2) * 0.3;
    let stolen = 0;
    for (let y = r.top + ins; y <= r.bottom - ins; y += 3) {
      for (let x = r.left + ins; x <= r.right - ins; x += 3) if (!mine(x, y)) stolen++;
    }
    const holder = b.closest(holders);
    const h = holder?.getBoundingClientRect();
    const inside = !h || (left >= h.left - 0.5 && right <= h.right + 0.5 && top >= h.top - 0.5 && bottom <= h.bottom + 0.5);
    out.push({
      id: b.id || b.dataset.mode || b.dataset.color || b.textContent.trim().slice(0, 10),
      w: +(right - left).toFixed(2), h: +(bottom - top).toFixed(2), stolen, inside,
      holder: holder ? (holder.id || holder.className) : null,
    });
  }
  return out;
}, sel);

const SIZES = [
  ['iPhone SE（初代）縦 320×568', phone(320, 568)],
  ['iPhone SE（第2・3世代）縦 375×667', phone(375, 667)],
  ['通常の iPhone 縦 390×844', phone(390, 844, 3)],
  ['iPhone SE 横 667×375', phone(667, 375)],
  ['iPhone SE（初代）横 568×320', phone(568, 320)],
  ['通常の iPhone 横 852×393', phone(852, 393, 3)],
  ['iPad 縦 820×1180', { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
];

/** 幅が 44 に届かなくても、原則の例外として数えるもの（距離・面積・体積・角度の 4 つは、狭い画面では 1 行に入りきらない） */
const WIDTH_EXCEPTIONS = new Set(['length', 'area', 'volume', 'angle']);
const segWidths = [];

for (const [name, opts] of SIZES) {
  const { ctx, page } = await open(opts);
  const bad = [];
  const covered = [];
  const audit = async (label, sel) => {
    for (const r of await measureHits(page, sel)) {
      if (r.covered) {
        covered.push(`${label}:${r.id}`);
        continue;
      }
      const narrowOk = WIDTH_EXCEPTIONS.has(r.id);
      if (narrowOk) segWidths.push({ size: name, id: r.id, w: r.w, h: r.h });
      if ((r.w < 43.9 && !narrowOk) || r.h < 43.9 || r.stolen > 0 || !r.inside) bad.push({ state: label, ...r });
    }
  };
  // 計測：点を置いて値の段が出ているとき
  await placePoints(page, 3);
  await audit('上のバー', '#topbar button');
  await audit('計測', '#readout button');
  await audit('ツールバー', '#toolbar button');
  // 図面の側へはみ出していない：パネルの上端のすぐ上と、上のバーのすぐ下は図面に当たる
  const edge = await page.evaluate(() => {
    const ro = document.getElementById('readout').getBoundingClientRect();
    const tb = document.getElementById('topbar').getBoundingClientRect();
    const onStage = (x, y) => !!document.elementFromPoint(x, y)?.closest('#stage');
    const xs = [0.2, 0.5, 0.8].map((f) => ro.left + ro.width * f);
    // 上のバーのボタンそれぞれの真下
    const chips = [...document.querySelectorAll('#topbar button')].map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0);
    return {
      aboveReadout: xs.every((x) => onStage(x, ro.top - 2)),
      belowTopbar: chips.every((r) => onStage(r.left + r.width / 2, tb.bottom + 2)),
    };
  });
  check(`${name}：計測パネルのすぐ上と上のバーのすぐ下は図面のまま（押せる所が図面へはみ出さない）`, edge.aboveReadout && edge.belowTopbar, edge);
  // 「すべて消去」のあと（元に戻すの段）
  await page.click('#btn-clear');
  await wait(page, 500);
  await audit('元に戻す', '#readout button');
  const fits = await page.evaluate(() => {
    const m = document.getElementById('undo-main');
    const s = document.querySelector('.undo-sub');
    const u = document.getElementById('readout-undo').getBoundingClientRect();
    const ro = document.getElementById('readout').getBoundingClientRect();
    return { main: m.scrollWidth <= m.clientWidth, sub: s.scrollWidth <= s.clientWidth, inside: u.right <= ro.right && u.left >= ro.left };
  });
  check(`${name}：元に戻すの段の文字が切れずに収まる`, fits.main && fits.sub && fits.inside, fits);
  await page.click('#btn-restore');
  await wait(page, 500);
  // 色の一覧
  await page.click('#btn-color');
  await frame(page);
  await audit('色の一覧', '#color-pop button');
  await page.click('#btn-color');
  // 記録の一覧
  await page.click('#btn-record');
  await frame(page);
  await page.click('#btn-records');
  await frame(page);
  await audit('記録の一覧', '#records-panel button');
  // 確かめる窓
  await page.click('#btn-records-clear');
  await wait(page, 400);
  await audit('確かめる窓', '#confirm-dialog button');
  await page.click('#btn-confirm-cancel');
  await page.click('#btn-records-close');
  // 体積の高さの窓
  await page.click('#seg-mode [data-mode="volume"]');
  await frame(page);
  await audit('高さの窓', '#height-dialog button');
  await page.click('#btn-height-cancel');
  // 図面を開くシート
  await page.click('#btn-open');
  await frame(page);
  await audit('図面を開く', '#files-panel button');
  await page.click('#btn-files-close');
  // 図面情報
  await page.click('#btn-info');
  await frame(page);
  await audit('図面情報', '#info-panel button, #info-panel summary, #info-panel a, #info-panel .group-row.pick');
  await page.click('#btn-info-close');
  // 累進
  await page.click('#btn-tool-ruishin');
  await page.click('#btn-ruishin-on');
  await frame(page);
  await audit('累進', '#ruishin-panel button');
  const ruishinFit = await page.evaluate(() => [...document.querySelectorAll('#ruishin-actions .pill')].every((b) => b.scrollWidth <= b.clientWidth + 1));
  check(`${name}：累進のボタンの文字とスイッチがボタンに収まる`, ruishinFit);
  // 属性とレイヤ一覧
  await page.click('#btn-tool-inspect');
  await frame(page);
  await audit('属性', '#inspect-panel button');
  await page.click('#btn-layers');
  await frame(page);
  await audit('レイヤ一覧', '#layer-panel .sheet-head button, #layer-panel .section-actions button, #layer-list .sw, #layer-list .lg-head');
  await page.click('#btn-layer-close');
  // 表示
  await page.click('#btn-display');
  await frame(page);
  await audit('表示', '#display-panel .sheet-head button, #display-panel .section-actions button');
  await page.click('#btn-display-close');

  check(`${name}：ボタンの押せる所は 44×44 以上で、見えているボタンに隣の押せる所が重ならず、入れ物の外（図面の側）へはみ出さない`,
    bad.length === 0, { bad: bad.slice(0, 12), covered });
  await ctx.close();
}

// 距離・面積・体積・角度の幅（原則の例外）を、画面ごとにいちばん狭いもので知らせる
const segMin = {};
for (const s of segWidths) segMin[s.size] = Math.min(segMin[s.size] ?? Infinity, s.w);
check('（例外・記録のみ）距離・面積・体積・角度の押せる幅（高さは 44 以上）。狭い画面では 4 つを 1 行に並べるため 44 に届かない', true, { segMin });

check('コンソールにエラーがない', errors.length === 0, { errors: errors.slice(0, 5) });

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length ? 1 : 0);
