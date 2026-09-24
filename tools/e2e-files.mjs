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
    for (let i = 0; i < 12; i++) {
      await st.saveRecent(`t${i}.jww`, new Uint8Array([i, 1, 2, 3]).buffer);
      await new Promise((res) => setTimeout(res, 3));
    }
    const list = await st.listRecent();
    const oldest = await st.loadRecent('t0.jww');
    const newest = await st.loadRecent('t11.jww');
    for (const x of list) if (x.name.startsWith('t')) await st.removeRecent(x.name);
    return { n: list.length, max: st.RECENT_MAX, first: list[0]?.name, oldest, newest: newest ? [...new Uint8Array(newest)] : null };
  });
  check('最近の図面は 10 件まで取っておき、古いものから消える', r.n === r.max && r.max === 10 && r.first === 't11.jww' && r.oldest === null && r.newest?.[0] === 11, r);
}

// ---------- 7. iOS アプリで渡された図面を受け取る口（Web でも同じ決まりを確かめる） ----------
{
  const r = await page.evaluate(async () => {
    const nat = await import('/src/native.ts');
    const log = { opened: [], failed: [], removed: [] };
    const reader = {
      read: async (url) => {
        if (url.includes('broken')) throw new Error('x');
        return new Uint8Array([1, 2, 3]).buffer;
      },
      remove: async (url) => { log.removed.push(url); },
    };
    const handle = nat.incomingHandler(reader, {
      open: (buf, name) => log.opened.push({ name, bytes: buf.byteLength }),
      fail: (m) => log.failed.push(m),
    });
    const inbox = 'file:///private/var/mobile/Containers/Data/Application/X/Documents/Inbox/%E5%B9%B3%E9%9D%A2%E5%9B%B3%201.jww';
    const a = await handle(inbox);
    // 起動時の URL と、動いている間の URL で同じものが二度来ても一度だけ開く
    const b = await handle(inbox);
    const c = await handle('https://example.com/x.jww');
    const d = await handle(undefined);
    const e = await handle('file:///tmp/broken.jww');
    await new Promise((res) => setTimeout(res, 10));
    return {
      a, b, c, d, e, log,
      isNative: nat.isNative,
      names: [nat.fileNameOf('file:///a/b/%E5%9B%B3%E9%9D%A2.JWW'), nat.fileNameOf('file:///a/b/%E0%A4%A.jww'), nat.fileNameOf('file:///')],
    };
  });
  check('渡された図面は、ファイルの名前（日本語も）で開き、Inbox の写しは読み終えたら消す',
    r.a && r.log.opened.length === 1 && r.log.opened[0].name === '平面図 1.jww' && r.log.opened[0].bytes === 3
      && r.log.removed.length === 1, r);
  check('同じ図面が二度渡されても一度だけ開き、ファイル以外の URL は無視する', !r.b && !r.c && !r.d, r);
  check('読めないファイルは「読み取れませんでした」と知らせる', !r.e && r.log.failed.length === 1 && /読み取れません/.test(r.log.failed[0]), r);
  check('名前が崩れていても落ちない（崩れたままの名前か「図面.jww」）',
    r.names[0] === '図面.JWW' && r.names[1] === '%E0%A4%A.jww' && r.names[2] === '図面.jww', { names: r.names });
  check('Web 版では iOS アプリとして扱わない', r.isNative === false, { isNative: r.isNative });
}

// ---------- 8. 横向きでは、図面を開くシートも右側に縦長に出る ----------
{
  await page.setViewportSize({ width: 852, height: 393 });
  await page.waitForTimeout(500);
  await page.click('#btn-open');
  const r = await page.evaluate(() => {
    const b = document.getElementById('files-panel').getBoundingClientRect();
    return { left: b.left, top: b.top, bottom: b.bottom, w: innerWidth, h: innerHeight };
  });
  check('横向きでは、図面を開くシートが右側に縦長に出る', r.left >= r.w / 2 - 90 && r.bottom - r.top > r.h * 0.6, r);
  await page.click('#btn-files-close');
}

check('コンソールにエラーがない', errors.length === 0, { errors: errors.slice(0, 5) });

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length ? 1 : 0);
