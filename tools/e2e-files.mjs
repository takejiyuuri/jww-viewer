// 図面を開く：最近開いた図面の一覧（Web 版と iOS アプリで共通）と、
// iOS アプリで「ファイル」アプリや共有メニューから渡された図面を受け取る口の決まりを確かめる。
import { chromium, devices } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { startServer, projectRoot as root } from './serve.mjs';

const srv = await startServer({ port: 5321, host: false, quiet: true });
const samples = fs.readdirSync(path.join(root, 'samples')).filter((f) => f.endsWith('.jww')).sort();
if (samples.length < 2) throw new Error('samples/ に .jww が 2 つ以上必要です');
const [fileA, fileB] = samples.slice(0, 2).map((f) => path.join(root, 'samples', f));
const nameA = path.basename(fileA);
const nameB = path.basename(fileB);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ ...devices['iPhone 14 Pro'], hasTouch: true });
const page = await context.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const results = [];
const check = (name, ok, info) => results.push({ name, ok, ...(info ?? {}) });

const opened = (name) => page.waitForFunction((n) => document.getElementById('title')?.textContent === n, name, { timeout: 60000 });
/** 最近の図面の保存（非同期）が一覧に反映されるまで待つ */
const recentHas = (n) => page.waitForFunction((k) => window.__jww.recent.length === k, n, { timeout: 10000 });
const sheet = () => page.evaluate(() => ({
  open: !document.getElementById('files-panel').classList.contains('hidden'),
  rows: [...document.querySelectorAll('#recent-list .recent-row')].map((r) => ({
    name: r.querySelector('.recent-name')?.textContent,
    current: r.classList.contains('current'),
    meta: r.querySelector('.recent-meta')?.textContent,
  })),
  expanded: document.getElementById('btn-open').getAttribute('aria-expanded'),
}));

await page.goto(srv.url, { waitUntil: 'networkidle' });
// 前の検証の残りを消してから始める
await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('jww-viewer'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
await page.reload({ waitUntil: 'networkidle' });

// ---------- 0. 前回の図面がなければ、最初の画面（図面を開く案内）を出す ----------
{
  await page.waitForFunction(() => !document.getElementById('welcome').classList.contains('hidden'), null, { timeout: 10000 })
    .catch(() => {});
  const s = await page.evaluate(() => ({
    welcome: !document.getElementById('welcome').classList.contains('hidden'),
    loading: !document.getElementById('loading').classList.contains('hidden'),
  }));
  check('前回の図面がなければ、起動すると最初の画面を出す', s.welcome && !s.loading, s);
}

// ---------- 1. 何も開いていなければ、「ファイル」はそのままファイルを選ぶ ----------
{
  const chooser = page.waitForEvent('filechooser', { timeout: 3000 }).then(() => true).catch(() => false);
  await page.click('#btn-open');
  const s = await sheet();
  check('最近開いた図面がなければ、「ファイル」でそのままファイルの選択が出る', (await chooser) && !s.open, s);
}

// ---------- 2. 開いた図面は最近の一覧に新しい順で並ぶ ----------
await page.setInputFiles('#file', fileA);
await opened(nameA);
await recentHas(1);
await page.setInputFiles('#file', fileB);
await opened(nameB);
await recentHas(2);
await page.click('#btn-open');
{
  const s = await sheet();
  check('「ファイル」で最近開いた図面の一覧が出て、新しい順に並び、表示中のものに印が付く',
    s.open && s.expanded === 'true' && s.rows.length === 2 && s.rows[0].name === nameB && s.rows[0].current
      && s.rows[1].name === nameA && !s.rows[1].current && /表示中/.test(s.rows[0].meta ?? '') && /(KB|MB)/.test(s.rows[1].meta ?? ''),
    s);
}

// ---------- 3. 一覧から開き直すと、その図面が出て先頭に来る ----------
await page.click(`#recent-list .recent-open[data-open="${nameA}"]`);
await opened(nameA);
await page.waitForFunction((n) => window.__jww.recent[0]?.name === n, nameA, { timeout: 10000 });
{
  await page.click('#btn-open');
  const s = await sheet();
  check('一覧から開き直すと、その図面が表示され、一覧の先頭に来る', s.rows[0].name === nameA && s.rows[0].current && s.rows.length === 2, s);
}

// ---------- 4. × で一覧から外せる ----------
await page.click(`#recent-list .recent-remove[data-remove="${nameB}"]`);
await recentHas(1);
{
  const s = await sheet();
  check('× で一覧から外せる（表示中の図面はそのまま）', s.open && s.rows.length === 1 && s.rows[0].name === nameA, s);
}

// ---------- 5. 「ファイルから選ぶ」でファイルの選択が出て、一覧は閉じる ----------
{
  const chooser = page.waitForEvent('filechooser', { timeout: 3000 }).then(() => true).catch(() => false);
  await page.click('#btn-pick-file');
  const s = await sheet();
  check('「ファイルから選ぶ」でファイルの選択が出て、一覧は閉じる', (await chooser) && !s.open, s);
}

// ---------- 6. 取っておくのは 10 件まで（古いものから消える） ----------
{
  const r = await page.evaluate(async () => {
    const st = await import('/src/storage.ts');
    // 今の一覧（本物の図面）を控えておき、検査のあとに戻す（12 件入れると上限で押し出されるため）
    const keep = [];
    for (const r of await st.listRecent()) keep.push([r.name, await st.loadRecent(r.name)]);
    for (let i = 0; i < 12; i++) {
      await st.saveRecent(`t${i}.jww`, new Uint8Array([i, 1, 2, 3]).buffer);
      await new Promise((res) => setTimeout(res, 3));
    }
    const list = await st.listRecent();
    const oldest = await st.loadRecent('t0.jww');
    const newest = await st.loadRecent('t11.jww');
    for (const x of list) if (x.name.startsWith('t')) await st.removeRecent(x.name);
    for (const [name, buf] of keep.reverse()) {
      if (buf) await st.saveRecent(name, buf);
      await new Promise((res) => setTimeout(res, 3));
    }
    await window.__jww.refreshRecent();
    return { n: list.length, max: st.RECENT_MAX, first: list[0]?.name, oldest, newest: newest ? [...new Uint8Array(newest)] : null };
  });
  check('最近の図面は 10 件まで取っておき、古いものから消える', r.n === r.max && r.max === 10 && r.first === 't11.jww' && r.oldest === null && r.newest?.[0] === 11, r);
}

// ---------- 7. iOS アプリで渡された図面を受け取る口（Web でも同じ決まりを確かめる） ----------
{
  const r = await page.evaluate(async () => {
    const nat = await import('/src/native.ts');
    const log = { opened: [], failed: [], removed: [], receiving: [], order: [] };
    const reader = {
      read: async (url) => {
        if (url.includes('broken')) throw new Error('x');
        return new Uint8Array([1, 2, 3]).buffer;
      },
      remove: async (url) => { log.removed.push(url); },
    };
    let clock = 1000;
    const handle = nat.incomingHandler(reader, {
      receiving: (name) => { log.receiving.push(name); log.order.push('receiving'); },
      open: (buf, name) => { log.opened.push({ name, bytes: buf.byteLength }); log.order.push('open'); },
      fail: (m) => { log.failed.push(m); log.order.push('fail'); },
    }, () => clock);
    const inbox = 'file:///private/var/mobile/Containers/Data/Application/X/Documents/Inbox/%E5%B9%B3%E9%9D%A2%E5%9B%B3%201.jww';
    // 起動したとき：起動時の URL と、動いている間の URL で同じものがほぼ同時に届く。一度だけ開き、どちらも「開いた」を返す
    const [a, b] = await Promise.all([handle(inbox), (clock += 30, handle(inbox))]);
    const openedAtLaunch = log.opened.length;
    // 少し経ってから同じ名前の図面をまた渡された（iOS は同じ場所に写す）：改めて開く
    clock += 60000;
    const again = await handle(inbox);
    const c = await handle('https://example.com/x.jww');
    const d = await handle(undefined);
    const e = await handle('file:///tmp/broken.jww');
    await new Promise((res) => setTimeout(res, 10));
    return {
      a, b, again, openedAtLaunch, c, d, e, log,
      isNative: nat.isNative,
      names: [nat.fileNameOf('file:///a/b/%E5%9B%B3%E9%9D%A2.JWW'), nat.fileNameOf('file:///a/b/%E0%A4%A.jww'), nat.fileNameOf('file:///')],
    };
  });
  check('渡された図面は、ファイルの名前（日本語も）で開き、Inbox の写しは読み終えたら消す',
    r.a && r.log.opened[0]?.name === '平面図 1.jww' && r.log.opened[0]?.bytes === 3 && r.log.removed.length >= 1, r);
  check('起動時に同じ図面が二か所から届いても一度だけ開き、どちらにも「開いた」を返す（前回の図面を出し直さない）',
    r.a && r.b && r.openedAtLaunch === 1, r);
  check('少し経ってから同じ名前の図面をまた渡されたら、改めて開く', r.again && r.log.opened.length === 2, r);
  check('ファイル以外の URL は無視する', !r.c && !r.d, r);
  check('受け取ったら、読む前に「読み込み中」を出すよう知らせる（名前付き）',
    r.log.receiving[0] === '平面図 1.jww' && r.log.order[0] === 'receiving' && r.log.order[1] === 'open', { receiving: r.log.receiving, order: r.log.order });
  check('読めないファイルは「読み取れませんでした」と知らせる', !r.e && r.log.failed.length === 1 && /読み取れません/.test(r.log.failed[0]), r);
  check('名前が崩れていても落ちない（崩れたままの名前か「図面.jww」）',
    r.names[0] === '図面.JWW' && r.names[1] === '%E0%A4%A.jww' && r.names[2] === '図面.jww', { names: r.names });
  check('Web 版では iOS アプリとして扱わない', r.isNative === false, { isNative: r.isNative });
}

// ---------- 7b. 読めないファイルは最近の一覧に入れず、図面を開いていれば最初の画面で覆わない ----------
{
  const bad = path.join(root, 'package.json');
  const before = await page.evaluate(() => window.__jww.recent.length);
  await page.setInputFiles('#file', bad);
  await page.waitForFunction(() => /読み込めませんでした/.test(document.getElementById('hint').textContent), null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const after = await page.evaluate(async () => {
    const st = await import('/src/storage.ts');
    return {
      recent: window.__jww.recent.length, names: (await st.listRecent()).map((r) => r.name), last: (await st.loadLast())?.name,
      welcomeHidden: document.getElementById('welcome').classList.contains('hidden'), title: document.getElementById('title').textContent,
    };
  });
  check('読めなかったファイルは、最近の一覧にも「前回の図面」にも入れない',
    after.recent === before && !after.names.includes('package.json') && after.last !== 'package.json', { before, ...after });
  check('図面を開いたまま読めなかったときは、最初の画面で覆わずに知らせ、表示中の図面はそのまま',
    after.welcomeHidden && after.title === nameA, after);
  await page.click('#btn-open');
  const shown = await page.evaluate(() => {
    const panel = document.getElementById('files-panel').getBoundingClientRect();
    const top = document.elementFromPoint(panel.left + panel.width / 2, panel.top + 20);
    return {
      open: !document.getElementById('files-panel').classList.contains('hidden'),
      welcomeHidden: document.getElementById('welcome').classList.contains('hidden'),
      onTop: !!top?.closest('#files-panel'),
    };
  });
  check('読み込めなかったあとに「ファイル」を押すと、一覧が隠れずに出る', shown.open && shown.welcomeHidden && shown.onTop, shown);
  // 一覧から開き直せば、また図面が出る
  await page.click(`#recent-list .recent-open[data-open="${nameA}"]`);
  // 見出しは読み込めなかったあとも前の図面の名前のままなので、読み込み中の画面が消えるのを待つ
  await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden')
    && document.getElementById('welcome').classList.contains('hidden'), null, { timeout: 60000 });
  await page.waitForFunction((n) => window.__jww.recent[0]?.name === n, nameA, { timeout: 10000 });
  const re = await page.evaluate(() => ({
    title: document.getElementById('title').textContent, scene: !!window.__jww.scene,
    recent: window.__jww.recent.map((r) => r.name), hint: document.getElementById('hint').textContent,
  }));
  check('そのまま一覧から図面を開き直せる', re.title === nameA && re.scene && re.recent.includes(nameA) && !/見つからなかった/.test(re.hint), re);
}

// ---------- 8. 横向きでは、図面を開くシートも右側に縦長に出る ----------
{
  await page.setViewportSize({ width: 852, height: 393 });
  await page.waitForTimeout(500);
  await page.click('#btn-open');
  const r = await page.evaluate(() => {
    const b = document.getElementById('files-panel').getBoundingClientRect();
    return {
      open: !document.getElementById('files-panel').classList.contains('hidden'), recent: window.__jww.recent.length,
      left: b.left, top: b.top, bottom: b.bottom, w: innerWidth, h: innerHeight,
    };
  });
  check('横向きでは、図面を開くシートが右側に縦長に出る', r.open && r.left >= r.w / 2 - 90 && r.bottom - r.top > r.h * 0.6, r);
  if (r.open) await page.click('#btn-files-close');
}

check('コンソールにエラーがない', errors.length === 0, { errors: errors.slice(0, 5) });

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length ? 1 : 0);
