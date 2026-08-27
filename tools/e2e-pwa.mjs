// PWA としての要件を本番ビルドで検証する。
// Service Worker の登録、オフライン起動、直近図面の復元、manifest の妥当性。
import { chromium, devices } from 'playwright';
import path from 'node:path';
import { startServer, projectRoot as root } from './serve.mjs';

const sample = process.argv[2] ?? path.join(root, 'samples', 'A棟 11階躯体図2026.5.12提出スリーブ.jww');
const outDir = process.argv[3] ?? '.';

// 本番ビルドを HTTPS で配信する。Service Worker は安全なコンテキストでしか動かない
const srv = await startServer({ port: 5443, https: true, preview: true, host: false, quiet: true });
const url = srv.url;

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
    const r = indexedDB.open('jww-viewer', 1);
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
          const r = indexedDB.open('jww-viewer', 1);
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
await srv.close();
process.exit(failed.length ? 1 : 0);
