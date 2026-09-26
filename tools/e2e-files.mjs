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
  rows: [...document.querySelectorAll('#recent-list .recent-row:not(.recent-undo)')].map((r) => ({
    name: r.querySelector('.recent-name')?.textContent,
    current: r.classList.contains('current'),
    meta: r.querySelector('.recent-meta')?.textContent,
  })),
  /** 外した直後の「元に戻す」の行（外した図面の名前と、並びの位置） */
  undo: (() => {
    const rows = [...document.querySelectorAll('#recent-list .recent-row')];
    const i = rows.findIndex((r) => r.classList.contains('recent-undo'));
    return i < 0 ? null : { name: rows[i].querySelector('.recent-name')?.textContent, index: i };
  })(),
  expanded: document.getElementById('btn-open').getAttribute('aria-expanded'),
}));
/** 一覧の行のボタン（開く・外す）。行は名前と中身から作った鍵で指す */
const rowButton = async (name, what, nth = 0) => {
  const key = await page.evaluate(([n, i]) => window.__jww.recent.filter((r) => r.name === n)[i]?.key, [name, nth]);
  if (!key) throw new Error(`一覧に無い図面: ${what}`);
  return `#recent-list [data-${what}="${key.replace(/["\\]/g, '\\$&')}"]`;
};
/** 保存した直近の図面と表示の状態（IndexedDB と localStorage） */
const stored = () => page.evaluate(async () => {
  const st = await import('/src/storage.ts');
  return { last: (await st.loadLast())?.name ?? null, view: localStorage.getItem('jww-viewer:hidden') };
});

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
await page.click(await rowButton(nameA, 'open'));
await opened(nameA);
await page.waitForFunction((n) => window.__jww.recent[0]?.name === n, nameA, { timeout: 10000 });
{
  await page.click('#btn-open');
  const s = await sheet();
  check('一覧から開き直すと、その図面が表示され、一覧の先頭に来る', s.rows[0].name === nameA && s.rows[0].current && s.rows.length === 2, s);
}

// ---------- 4. × で一覧から外せる。外した直後は「元に戻す」で戻せる ----------
await page.click(await rowButton(nameB, 'remove'));
await recentHas(1);
{
  const s = await sheet();
  check('× で一覧から外せる（表示中の図面はそのまま）', s.open && s.rows.length === 1 && s.rows[0].name === nameA, s);
  const data = await page.evaluate(async () => {
    const st = await import('/src/storage.ts');
    return (await st.listRecent()).length;
  });
  check('× で外すと、外した行の場所に「元に戻す」が出て、端末に取っておいた中身も消える',
    s.undo?.name === nameB && s.undo.index === 1 && data === 1, { undo: s.undo, data });
  await page.click('#recent-list [data-undo]');
  await recentHas(2);
  const back = await sheet();
  check('「元に戻す」で、外した図面が元の並びのまま一覧に戻る',
    back.rows.length === 2 && back.rows[0].name === nameA && back.rows[1].name === nameB && !back.undo, back);
  await page.click(await rowButton(nameB, 'remove'));
  await recentHas(1);
  // 閉じて開き直すと、「元に戻す」はもう出ない
  await page.click('#btn-files-close');
  await page.click('#btn-open');
  const again = await sheet();
  check('一覧を閉じたら「元に戻す」は出ない', again.open && again.rows.length === 1 && !again.undo, again);
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
    for (const r of await st.listRecent()) keep.push([r.name, await st.loadRecent(r.key)]);
    const bytes = (i) => new Uint8Array([i, 1, 2, 3]).buffer;
    for (let i = 0; i < 12; i++) {
      await st.saveRecent(`t${i}.jww`, bytes(i));
      await new Promise((res) => setTimeout(res, 3));
    }
    const list = await st.listRecent();
    const oldest = await st.loadRecent(st.recentKey('t0.jww', bytes(0)));
    const newest = await st.loadRecent(st.recentKey('t11.jww', bytes(11)));
    for (const x of list) if (x.name.startsWith('t')) await st.removeRecent(x.key);
    for (const [name, buf] of keep.reverse()) {
      if (buf) await st.saveRecent(name, buf);
      await new Promise((res) => setTimeout(res, 3));
    }
    await window.__jww.refreshRecent();
    return { n: list.length, max: st.RECENT_MAX, first: list[0]?.name, oldest, newest: newest ? [...new Uint8Array(newest)] : null };
  });
  check('最近の図面は 10 件まで取っておき、古いものから消える', r.n === r.max && r.max === 10 && r.first === 't11.jww' && r.oldest === null && r.newest?.[0] === 11, r);
}

// ---------- 6b. 同じ名前でも中身が違えば別の図面として取っておく（名前だけを鍵にしていたころのものも扱える） ----------
{
  const r = await page.evaluate(async () => {
    const st = await import('/src/storage.ts');
    const buf = (...b) => new Uint8Array(b).buffer;
    const names = async () => (await st.listRecent()).filter((x) => x.name === 'same.jww');
    await st.saveRecent('same.jww', buf(1, 2, 3));
    await new Promise((res) => setTimeout(res, 3));
    await st.saveRecent('same.jww', buf(4, 5, 6));
    const two = (await names()).length;
    await new Promise((res) => setTimeout(res, 3));
    // 同じ中身を開き直したら、増えずに入れ替わって先頭へ
    await st.saveRecent('same.jww', buf(1, 2, 3));
    const after = await names();
    const first = [...new Uint8Array(await st.loadRecent(after[0].key))];
    for (const x of after) await st.removeRecent(x.key);
    // 名前だけを鍵にしていたころの記録（鍵を持たない）を直に書く
    const legacy = (bytes) => new Promise((res, rej) => {
      const q = indexedDB.open('jww-viewer');
      q.onsuccess = () => {
        const db = q.result;
        const tx = db.transaction(['recent-meta', 'recent-data'], 'readwrite');
        tx.objectStore('recent-meta').put({ name: 'old.jww', size: bytes.byteLength, openedAt: 1 }, 'old.jww');
        tx.objectStore('recent-data').put(bytes, 'old.jww');
        tx.oncomplete = () => { db.close(); res(); };
        tx.onerror = () => rej(tx.error);
      };
    });
    await legacy(buf(7, 8, 9));
    const legacyListed = (await st.listRecent()).find((x) => x.name === 'old.jww');
    const legacyData = legacyListed ? [...new Uint8Array(await st.loadRecent(legacyListed.key))] : null;
    await st.saveRecent('old.jww', buf(7, 8, 9));
    const replaced = (await st.listRecent()).filter((x) => x.name === 'old.jww');
    await st.saveRecent('old.jww', buf(7, 8, 0));
    const different = (await st.listRecent()).filter((x) => x.name === 'old.jww');
    for (const x of different) await st.removeRecent(x.key);
    await window.__jww.refreshRecent();
    return {
      two, after: after.length, first, legacyKey: legacyListed?.key, legacyData,
      replaced: replaced.map((x) => x.key === 'old.jww'), different: different.length,
    };
  });
  check('同じ名前で中身の違う図面は、一覧に別々に残る（同じ中身なら 1 件のまま先頭へ）',
    r.two === 2 && r.after === 2 && r.first.join() === '1,2,3', r);
  check('名前だけを鍵にしていたころの記録も一覧に出て開け、同じ中身を開き直すと入れ替わる（違う中身なら別に残る）',
    r.legacyKey === 'old.jww' && r.legacyData?.join() === '7,8,9' && r.replaced.length === 1 && r.replaced[0] === false && r.different === 2, r);
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

// ---------- 7a. 渡された写しは保存が済んでから消す。起動時の URL を読み直しのあとに処理し直さない ----------
{
  const r = await page.evaluate(async () => {
    const nat = await import('/src/native.ts');
    localStorage.removeItem('jww-viewer:received');
    const base = 'file:///private/var/mobile/Containers/Data/Application/X';
    const log = { opened: [], failed: [], removed: [], receiving: [] };
    const stamps = new Map();
    let release = () => {};
    let hold = false;
    const reader = {
      read: async () => new Uint8Array([1, 2, 3]).buffer,
      remove: async (url) => { log.removed.push(url.replace(base, '')); stamps.delete(url); },
      stamp: async (url) => stamps.get(url) ?? null,
    };
    let clock = 1000;
    const h = {
      receiving: (name) => log.receiving.push(name),
      // 解析と保存が済むまで決着しない open（hold のとき）
      open: (buf, name) => {
        log.opened.push(name);
        return hold ? new Promise((res) => { release = res; }) : undefined;
      },
      fail: (m) => log.failed.push(m),
    };
    const tick = () => new Promise((res) => setTimeout(res, 10));
    let handle = nat.incomingHandler(reader, h, () => clock);

    // 保存が済むまでは写しを消さない
    const inbox = `${base}/Documents/Inbox/a.jww`;
    stamps.set(inbox, 's1');
    hold = true;
    const opened = await handle(inbox);
    await tick();
    const beforeSave = log.removed.length;
    release();
    await tick();
    const afterSave = log.removed.slice();
    hold = false;

    // 「ファイル」アプリからの写し（tmp/<Bundle ID>-Inbox/）も消す。アプリの外の場所のファイルは消さない
    const tmp = `${base}/tmp/io.github.takejiyuuri.mitehakaru-Inbox/b.jww`;
    const other = `${base}/Documents/c.jww`;
    stamps.set(tmp, 's2');
    stamps.set(other, 's3');
    clock += 60000;
    await handle(tmp);
    await handle(other);
    await tick();
    const removedPaths = log.removed.slice();

    // WebView が読み直された：受け取る口は作り直され、起動時の URL として前の URL がまた届く
    const before = log.opened.length;
    clock += 60000;
    handle = nat.incomingHandler(reader, h, () => clock);
    const staleGone = await handle(inbox, true); // 写しはもう消してある
    const staleKept = await handle(other, true); // 写しは残っているが、片付けまで済んでいる
    const reopenedStale = log.opened.length - before;
    // 同じ場所に新しい写しが来た（同じ名前の図面をまた渡された）なら開く
    stamps.set(other, 's3-new');
    clock += 60000;
    const fresh = await handle(other, true);
    // 読み込みの途中で落ちて、片付けが済んでいない写しなら、読み直したあと開き直す
    const crashed = `${base}/Documents/Inbox/d.jww`;
    stamps.set(crashed, 's4');
    clock += 60000;
    const recovered = await handle(crashed, true);
    await tick();
    const marker = localStorage.getItem('jww-viewer:received');
    localStorage.removeItem('jww-viewer:received');
    return {
      opened, beforeSave, afterSave, removedPaths, staleGone, staleKept, reopenedStale, fresh, recovered,
      failed: log.failed, markerHasName: !!marker && /\.jww|Inbox/.test(marker),
    };
  });
  check('渡された写しは、読み込みと保存が済むまで消さない', r.opened && r.beforeSave === 0 && r.afterSave.length === 1, r);
  check('「ファイル」アプリからの写し（tmp/…-Inbox）も読み終えたら消し、Inbox でないファイルは消さない',
    r.removedPaths.includes('/tmp/io.github.takejiyuuri.mitehakaru-Inbox/b.jww') && !r.removedPaths.includes('/Documents/c.jww'), r);
  check('読み直したあと、起動時の URL として前に受け取った図面が届いても開き直さず、「読み取れません」とも出さない',
    r.staleGone === false && r.staleKept === false && r.reopenedStale === 0 && r.failed.length === 0, r);
  check('同じ場所に新しく写された図面や、片付けの前に落ちた図面は、起動時の URL から開く', r.fresh === true && r.recovered === true, r);
  check('受け取りの記録にファイルの名前を残さない', r.markerHasName === false, r);
}

// ---------- 7b. 読めないファイルは最近の一覧に入れず、一覧を出しても最初の画面の下に隠れない ----------
{
  const bad = path.join(root, 'package.json');
  const before = await page.evaluate(() => window.__jww.recent.length);
  await page.setInputFiles('#file', bad);
  await page.waitForFunction(() => !document.getElementById('welcome').classList.contains('hidden'), null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const after = await page.evaluate(async () => {
    const st = await import('/src/storage.ts');
    return { recent: window.__jww.recent.length, names: (await st.listRecent()).map((r) => r.name), last: (await st.loadLast())?.name };
  });
  check('読めなかったファイルは、最近の一覧にも「前回の図面」にも入れない',
    after.recent === before && !after.names.includes('package.json') && after.last !== 'package.json', { before, ...after });
  await page.click('#btn-open-2');
  const shown = await page.evaluate(() => {
    const panel = document.getElementById('files-panel').getBoundingClientRect();
    const top = document.elementFromPoint(panel.left + panel.width / 2, panel.top + 20);
    return {
      open: !document.getElementById('files-panel').classList.contains('hidden'),
      welcomeHidden: document.getElementById('welcome').classList.contains('hidden'),
      onTop: !!top?.closest('#files-panel'),
    };
  });
  check('読み込めなかったあとに「図面を開く」を押すと、一覧が最初の画面に隠れずに出る', shown.open && shown.welcomeHidden && shown.onTop, shown);
  // 一覧から開き直せば、また図面が出る
  await page.click(await rowButton(nameA, 'open'));
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

// ---------- 7c. 一覧から開くときの読み出しが一時的に失敗しても、一覧からは外さない ----------
{
  await page.click('#btn-open');
  const sel = await rowButton(nameA, 'open');
  await page.evaluate(() => {
    window.__idbOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function () { throw new DOMException('一時的な失敗', 'UnknownError'); };
  });
  await page.click(sel);
  await page.waitForFunction(() => /読み出せません/.test(document.getElementById('hint').textContent ?? ''), null, { timeout: 5000 })
    .catch(() => {});
  const r = await page.evaluate(async () => {
    IDBFactory.prototype.open = window.__idbOpen;
    const st = await import('/src/storage.ts');
    return {
      hint: document.getElementById('hint').textContent,
      listed: (await st.listRecent()).length,
      shown: document.querySelectorAll('#recent-list .recent-row:not(.recent-undo)').length,
    };
  });
  check('一覧から開くときの読み出しが一時的に失敗したら、そう知らせ、一覧からは外さない',
    /読み出せません/.test(r.hint ?? '') && !/見つからなかった/.test(r.hint ?? '') && r.listed === 1 && r.shown === 1, r);
  await page.click('#btn-files-close');
}

// ---------- 7d. 容量が足りずに保存できないときは、一覧の古いものから外して入れ直す ----------
{
  await page.evaluate(async () => {
    const st = await import('/src/storage.ts');
    await st.saveRecent('q0.jww', new Uint8Array([9, 9, 9]).buffer);
    await window.__jww.refreshRecent();
    // 次の図面の中身を書くとき、一度だけ容量不足にする
    const put = IDBObjectStore.prototype.put;
    let n = 0;
    IDBObjectStore.prototype.put = function (...a) {
      if (this.name === 'recent-data' && n++ === 0) throw new DOMException('容量不足', 'QuotaExceededError');
      return put.apply(this, a);
    };
    window.__restorePut = () => { IDBObjectStore.prototype.put = put; };
  });
  await page.setInputFiles('#file', fileB);
  await opened(nameB);
  await page.waitForFunction((n) => window.__jww.recent[0]?.name === n, nameB, { timeout: 10000 }).catch(() => {});
  const r = await page.evaluate(async (a) => {
    window.__restorePut();
    const st = await import('/src/storage.ts');
    const list = await st.listRecent();
    const out = {
      names: list.map((x) => (x.name === a ? 'A' : x.name === 'q0.jww' ? 'q0' : 'other')),
      last: !!(await st.loadLast()), hint: document.getElementById('hint').textContent,
    };
    for (const x of list) if (x.name === 'q0.jww') await st.removeRecent(x.key);
    await window.__jww.refreshRecent();
    return out;
  }, nameA);
  check('容量が足りないときは、いちばん古い図面を一覧から外して保存し直し、そう知らせる',
    r.names.join() === 'other,q0' && r.last && /古いもの/.test(r.hint ?? ''), r);
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

// ---------- 9. 同じ名前の別の図面を見分け、表示中の図面を外すと次に起動したとき出し直さない ----------
{
  const same = 'same-ui.jww';
  await page.setInputFiles('#file', { name: same, mimeType: 'application/octet-stream', buffer: fs.readFileSync(fileA) });
  await opened(same);
  await page.waitForFunction((n) => window.__jww.recent.filter((r) => r.name === n).length === 1, same, { timeout: 10000 });
  await page.setInputFiles('#file', { name: same, mimeType: 'application/octet-stream', buffer: fs.readFileSync(fileB) });
  await page.waitForFunction((n) => window.__jww.recent.filter((r) => r.name === n).length === 2, same, { timeout: 60000 });
  await page.click('#btn-open');
  const s = await sheet();
  const rows = s.rows.filter((x) => x.name === same);
  check('同じ名前で中身の違う図面は一覧に 2 行並び、表示中の印は表示している方だけに付く',
    rows.length === 2 && rows[0].current && !rows[1].current, { rows });

  // 表示の状態を記録してから、表示中の図面を外す
  await page.evaluate(() => window.__jww.saveViewState());
  const before = await stored();
  await page.click(await rowButton(same, 'remove', 0));
  await page.waitForFunction((n) => window.__jww.recent.filter((r) => r.name === n).length === 1, same, { timeout: 10000 });
  const removed = await stored();
  // 外したあとも表示し続けている図面の表示の状態は、記録しない
  await page.evaluate(() => window.__jww.saveViewState());
  const afterSave = await stored();
  check('表示中の図面を外すと、次に起動したとき出し直す図面と表示の状態の記録も消え、その後も記録しない',
    before.last === same && JSON.parse(before.view ?? 'null')?.name === same
      && removed.last === null && removed.view === null && afterSave.view === null,
    { before: { last: before.last === same, view: !!before.view }, removed, afterSave });
  await page.click('#recent-list [data-undo]');
  await page.waitForFunction((n) => window.__jww.recent.filter((r) => r.name === n).length === 2, same, { timeout: 10000 });
  const undone = await stored();
  check('「元に戻す」で、次に起動したとき出し直す図面と表示の状態も戻る',
    undone.last === same && undone.view === before.view, { last: undone.last === same, view: undone.view === before.view });

  // もう一度外し、同じ名前のもう一つも外してから、起動し直す
  await page.click(await rowButton(same, 'remove', 0));
  await page.waitForFunction((n) => window.__jww.recent.filter((r) => r.name === n).length === 1, same, { timeout: 10000 });
  await page.click(await rowButton(same, 'remove', 0));
  await page.waitForFunction((n) => window.__jww.recent.every((r) => r.name !== n), same, { timeout: 10000 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.getElementById('welcome').classList.contains('hidden'), null, { timeout: 10000 })
    .catch(() => {});
  await page.waitForTimeout(500);
  const re = await page.evaluate(() => ({
    welcome: !document.getElementById('welcome').classList.contains('hidden'),
    loading: !document.getElementById('loading').classList.contains('hidden'),
    scene: !!window.__jww.scene,
  }));
  check('表示中の図面を一覧から外して起動し直すと、その図面は出ず、最初の画面が出る', re.welcome && !re.loading && !re.scene, re);
}

// ---------- 10. 保存できなかったときは知らせる（閲覧はそのまま続けられる） ----------
{
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...a) {
      if (this.name === 'recent-data') throw new DOMException('容量不足', 'QuotaExceededError');
      return put.apply(this, a);
    };
    window.__restorePut = () => { IDBObjectStore.prototype.put = put; };
  });
  const listed = await page.evaluate(() => window.__jww.recent.length);
  await page.setInputFiles('#file', fileA);
  await opened(nameA);
  await page.waitForFunction(() => /保存できませんでした/.test(document.getElementById('hint').textContent ?? ''), null, { timeout: 10000 })
    .catch(() => {});
  const r = await page.evaluate(async () => {
    window.__restorePut();
    const st = await import('/src/storage.ts');
    return {
      hint: document.getElementById('hint').textContent, scene: !!window.__jww.scene,
      last: !!(await st.loadLast()), listed: (await st.listRecent()).length,
    };
  });
  check('端末に保存できなかったときは知らせ、図面はそのまま見られる', /保存できませんでした/.test(r.hint ?? '') && r.scene && !r.last, { ...r, before: listed });
}

check('コンソールにエラーがない', errors.length === 0, { errors: errors.slice(0, 5) });

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length ? 1 : 0);
