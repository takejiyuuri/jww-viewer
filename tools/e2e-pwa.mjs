// PWA としての要件を本番ビルドで検証する。
// Service Worker の登録、オフライン起動、直近図面の復元、manifest の妥当性。
import { chromium, devices } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import { startServer, projectRoot as root } from './serve.mjs';

// 第 1 引数が URL なら、そこを検査対象にする（公開済みのサイトを確かめるとき）
const remote = process.argv[2]?.startsWith('http') ? process.argv[2] : null;
const rest = remote ? process.argv.slice(3) : process.argv.slice(2);
const sample = rest[0] ?? path.join(root, 'samples', 'A棟 11階躯体図2026.5.12提出スリーブ.jww');
const outDir = rest[1] ?? '.';

// 本番ビルドを HTTPS で配信する。Service Worker は安全なコンテキストでしか動かない
const srv = remote ? null : await startServer({ port: 5443, https: true, preview: true, host: false, quiet: true });
const url = remote ?? srv.url;

const browser = await chromium.launch({
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    // 自己署名でも Secure Context として扱わせ、Service Worker を登録できるようにする
    '--ignore-certificate-errors',
    `--unsafely-treat-insecure-origin-as-secure=${new URL(url).origin}`,
  ],
});
const context = await browser.newContext({
  ...devices['iPhone 14 Pro'],
  hasTouch: true,
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const results = [];
const check = (name, ok, info) => results.push({ name, ok, ...(info ?? {}) });

// ---------- 0. Service Worker の決まり（ビルドした sw.js を、偽の caches と fetch の上で動かす） ----------
if (!remote) {
  const base = 'https://example.test/jww-viewer/';
  const src = fs.readFileSync(path.join(root, 'dist', 'sw.js'), 'utf8');
  const current = `jww-viewer-${src.match(/const VERSION = '([^']+)'/)[1]}`;
  const abs = (r) => new URL(typeof r === 'string' ? r : r.url, base).href;
  /** 名前 → (URL → 中身) */
  const store = new Map();
  const deleted = [];
  let addAllFails = false;
  const cacheOf = (m) => ({
    match: async (r) => m.get(abs(r)),
    put: async (r, res) => { m.set(abs(r), res); },
    addAll: async (reqs) => {
      if (addAllFails) throw new Error('取り込みの失敗');
      for (const r of reqs) m.set(abs(r), `pre:${abs(r)}`);
    },
  });
  const caches = {
    keys: async () => [...store.keys()],
    open: async (n) => { if (!store.has(n)) store.set(n, new Map()); return cacheOf(store.get(n)); },
    delete: async (n) => { deleted.push(n); return store.delete(n); },
    match: async (r) => { for (const m of store.values()) if (m.has(abs(r))) return m.get(abs(r)); return undefined; },
  };
  let fetchImpl = () => new Promise(() => {});
  const listeners = {};
  const self = {
    location: new URL('sw.js', base),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  class Req { constructor(u) { this.url = abs(u); } }
  vm.runInNewContext(src, { self, caches, fetch: (r) => fetchImpl(r), Request: Req, URL, setTimeout, clearTimeout, Promise, console });
  const dispatch = async (type, extra = {}) => {
    const waits = [];
    let responded = null;
    listeners[type]({ ...extra, waitUntil: (p) => waits.push(p), respondWith: (p) => { responded = p; } });
    return { responded, waits };
  };

  // 新しい版になったら古い版を消すが、直前の版と、同じオリジンのほかのサイトのキャッシュは残す
  for (const n of ['jww-viewer-old1', 'other-site', 'jww-viewer-old2', current]) store.set(n, new Map());
  store.get('jww-viewer-old2').set(abs('./assets/worker-old.js'), 'old-worker');
  store.get('jww-viewer-old2').set(abs('./icon-192.png'), 'old-icon');
  store.get(current).set(abs('./icon-192.png'), 'new-icon');
  store.get(current).set(abs('./'), 'cached-page');
  const act = await dispatch('activate');
  await Promise.all(act.waits);
  check('新しい版が有効になると古い版のキャッシュを消すが、直前の版とほかのサイトのキャッシュは残す',
    deleted.join() === 'jww-viewer-old1' && store.has('jww-viewer-old2') && store.has('other-site'), { deleted, left: [...store.keys()] });

  const get = async (u) => (await dispatch('fetch', { request: { method: 'GET', url: abs(u), mode: 'no-cors' } })).responded;
  fetchImpl = () => Promise.reject(new TypeError('オフライン'));
  const icon = await get('./icon-192.png');
  const oldWorker = await get('./assets/worker-old.js');
  check('同じ URL は今の版のキャッシュから返し、前の版のページが読み込むワーカーは残した直前の版から返す',
    icon === 'new-icon' && oldWorker === 'old-worker', { icon, oldWorker });

  // ページ遷移：返事が来ないまま待たされても、NAVIGATE_TIMEOUT を過ぎたらキャッシュで起動する
  const nav = () => dispatch('fetch', { request: { method: 'GET', url: base, mode: 'navigate' } });
  fetchImpl = () => new Promise(() => {});
  let t0 = Date.now();
  // キャッシュに切り替わらないときに検査ごと止まらないよう、待つのは 8 秒まで
  const hung = await Promise.race([(await nav()).responded, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
  const hungMs = Date.now() - t0;
  check('ページ遷移で返事が来ないまま待たされても、数秒でキャッシュから起動する', hung === 'cached-page' && hungMs >= 2500 && hungMs < 6000, { hung, hungMs });
  fetchImpl = () => Promise.reject(new TypeError('オフライン'));
  t0 = Date.now();
  const offline = await (await nav()).responded;
  check('オフラインならすぐキャッシュから起動する', offline === 'cached-page' && Date.now() - t0 < 1000, { offline });
  const fresh = { ok: true, clone: () => 'fresh-copy' };
  fetchImpl = () => Promise.resolve(fresh);
  const online = await nav();
  const onlineRes = await online.responded;
  await Promise.all(online.waits);
  check('つながれば新しい内容を返し、次に備えてキャッシュも入れ替える',
    onlineRes === fresh && store.get(current).get(abs('./')) === 'fresh-copy', { cached: store.get(current).get(abs('./')) });

  // 取り込みに失敗した版のキャッシュは残さない（次の版が「直前の版」と取り違えないように）
  addAllFails = true;
  store.delete(current);
  deleted.length = 0;
  const inst = await dispatch('install');
  const installed = await Promise.all(inst.waits).then(() => true, () => false);
  check('取り込みに失敗したら、その版の半端なキャッシュを消す', !installed && !store.has(current) && deleted.includes(current), { installed, deleted });
}

// ---------- 1. 初回訪問と Service Worker ----------
await page.goto(url, { waitUntil: 'networkidle' });

const swState = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return { supported: false };
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((r) => setTimeout(() => r(null), 10000)),
    ]);
    return {
      supported: true,
      registered: !!reg,
      scope: reg?.scope ?? null,
      active: !!reg?.active,
    };
  } catch (e) {
    return { supported: true, registered: false, error: String(e) };
  }
});
check('Service Worker が登録される', swState.registered === true && swState.active === true, swState);

// ---------- 2. manifest ----------
const manifest = await page.evaluate(async () => {
  const link = document.querySelector('link[rel=manifest]');
  if (!link) return null;
  const res = await fetch(link.href);
  const m = await res.json();
  const icons = await Promise.all(
    m.icons.map(async (i) => {
      const r = await fetch(new URL(i.src, link.href).href);
      return { src: i.src, status: r.status, type: r.headers.get('content-type') };
    })
  );
  return { m, icons };
});
check('manifest が読める', !!manifest, { name: manifest?.m?.name });
check('アイコンがすべて取得できる', manifest?.icons.every((i) => i.status === 200), {
  結果: manifest?.icons.map((i) => `${i.src}:${i.status}`).join(' '),
});
check('display が standalone', manifest?.m?.display === 'standalone');
check('start_url と scope が相対', manifest?.m?.start_url === './' && manifest?.m?.scope === './');

// ---------- 3. 図面を読み込んで IndexedDB に保存されるか ----------
await page.setInputFiles('#file', sample);
await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
await page.waitForTimeout(1500);

const stored = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('jww-viewer');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const rec = await new Promise((res, rej) => {
    const tx = db.transaction('last', 'readonly');
    const q = tx.objectStore('last').get('file');
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  db.close();
  return rec ? { name: rec.name, bytes: rec.buffer?.byteLength ?? 0 } : null;
});
check('直近の図面が保存される', !!stored && stored.bytes > 1000, stored ?? {});

// ---------- 4. キャッシュに主要アセットが入っているか ----------
const cached = await page.evaluate(async () => {
  const names = await caches.keys();
  const out = [];
  for (const n of names) {
    const c = await caches.open(n);
    for (const req of await c.keys()) out.push(new URL(req.url).pathname);
  }
  return out;
});
const hasHtml = cached.some((p) => p.endsWith('/') || p.endsWith('index.html'));
const hasJs = cached.some((p) => /assets\/index-.*\.js$/.test(p));
const hasWorker = cached.some((p) => /assets\/worker-.*\.js$/.test(p));
const hasCss = cached.some((p) => /assets\/index-.*\.css$/.test(p));
check('HTML がキャッシュされる', hasHtml, { 件数: cached.length });
check('本体 JS がキャッシュされる', hasJs);
check('Worker がキャッシュされる', hasWorker);
check('CSS がキャッシュされる', hasCss);

// ---------- 4b. 電波が弱くて返事が来ないときも、数秒でキャッシュから起動するか ----------
{
  // Service Worker からのページの取得に返事をしない（Chromium では Service Worker の取得も route で止められる）
  const pending = [];
  const isPage = (u) => u.pathname.endsWith('/') || u.pathname.endsWith('/index.html');
  await context.route(isPage, (route) => { pending.push(route); });
  const slow = await context.newPage();
  const t0 = Date.now();
  let loaded = false;
  try {
    await slow.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    loaded = true;
  } catch {
    // 下で失敗として数える
  }
  const ms = Date.now() - t0;
  const stalled = pending.length;
  for (const r of pending) await r.abort().catch(() => {});
  await context.unroute(isPage);
  await slow.close();
  check('電波が弱くて返事が来ないときも、数秒でキャッシュから起動する', loaded && stalled > 0 && ms < 10000, { ms, stalled });
}

// ---------- 5. オフラインで起動できるか ----------
await context.setOffline(true);
const offlinePage = await context.newPage();
const offErrors = [];
const offLogs = [];
offlinePage.on('pageerror', (e) => offErrors.push(`pageerror: ${e.message}`));
offlinePage.on('console', (m) => offLogs.push(`${m.type()}: ${m.text()}`));
offlinePage.on('requestfailed', (r) => offErrors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
let offlineLoaded = false;
try {
  await offlinePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  offlineLoaded = true;
} catch (e) {
  offErrors.push(`goto: ${e.message}`);
}

let offlineState = {};
if (offlineLoaded) {
  // 直近の図面が復元されて描画まで進むか
  try {
    await offlinePage.waitForFunction(
      () => document.getElementById('title')?.textContent?.endsWith('.jww'),
      null, { timeout: 30000 },
    );
    offlineState.restored = true;
  } catch {
    offlineState.restored = false;
  }
  offlineState = {
    ...offlineState,
    ...await offlinePage.evaluate(async () => {
      let idb = null;
      try {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open('jww-viewer');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
          r.onblocked = () => rej(new Error('blocked'));
        });
        const rec = await new Promise((res, rej) => {
          const tx = db.transaction('last', 'readonly');
          const q = tx.objectStore('last').get('file');
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        db.close();
        idb = rec ? { name: rec.name, bytes: rec.buffer?.byteLength ?? 0 } : 'empty';
      } catch (e) {
        idb = `error: ${e && e.message}`;
      }
      return {
        title: document.getElementById('title')?.textContent,
        glReady: (() => {
          const c = document.getElementById('gl');
          return !!c && c.width > 0 && !!c.getContext('webgl2');
        })(),
        welcomeHidden: document.getElementById('welcome')?.classList.contains('hidden'),
        loadingHidden: document.getElementById('loading')?.classList.contains('hidden'),
        loadingText: document.getElementById('loading-text')?.textContent,
        idb,
      };
    }),
  };
  await offlinePage.screenshot({ path: path.join(outDir, 'e2e-offline.png') });
}

check('オフラインでページが開く', offlineLoaded, { エラー: offErrors.slice(0, 2).join(' / ') });
check('オフラインで直近図面が復元される', offlineState.restored === true, {
  タイトル: offlineState.title,
  IndexedDB: offlineState.idb,
  読込中: offlineState.loadingText,
  読込中非表示: offlineState.loadingHidden,
  ようこそ非表示: offlineState.welcomeHidden,
  ログ: offLogs.slice(0, 5),
  失敗: offErrors.slice(0, 5),
});
check('オフラインでも WebGL が動く', offlineState.glReady === true);

await context.setOffline(false);

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length, errors: errors.slice(0, 6) }, null, 2));
await browser.close();
if (srv) await srv.close();
process.exit(failed.length ? 1 : 0);
