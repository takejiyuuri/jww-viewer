// 公開中の版から新しい版へ更新したとき、端末に残っているものがそのまま使えるかを確かめる。
// 前の版の本番ビルドと今の本番ビルドを同じ場所（同じオリジン）から順に配り、
// 前の版で図面を開いて設定を変えたあと、今の版に差し替えて開き直す。
//
// 使い方: node tools/e2e-upgrade.mjs <前の版の dist> [図面] [出力先]
//   前の版の dist は、たとえば `git worktree add ../base main && (cd ../base && npm ci && npm run build)` で作る
import { chromium, devices } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot as root } from './serve.mjs';
import { defaultSample } from './samples.mjs';

const oldDist = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!oldDist || !fs.existsSync(path.join(oldDist, 'index.html'))) {
  console.error('前の版の dist を引数で渡してください（例: node tools/e2e-upgrade.mjs ../base/dist）');
  process.exit(1);
}
const newDist = path.join(root, 'dist');
if (!fs.existsSync(path.join(newDist, 'index.html'))) {
  console.error('dist がありません。先に npm run build を実行してください');
  process.exit(1);
}
const sample = process.argv[3] ?? defaultSample();
const outDir = process.argv[4] ?? '.';
// 2 つ目の図面（最近の一覧が 2 件以上でも引き継がれるかを見る）。前の版の見本の図面を使う
const second = ['sample.jww', 'ruishin-sample.jww'].map((f) => path.join(oldDist, f)).find((f) => fs.existsSync(f));

// ---------- 配る中身を差し替えられる、ごく小さな配信 ----------
let current = oldDist;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm',
};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let f = path.join(current, decodeURIComponent(u.pathname));
  if (!f.startsWith(current)) { res.statusCode = 403; res.end(); return; }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', types[path.extname(f)] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(5610, '127.0.0.1', r));
const url = 'http://127.0.0.1:5610/';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
// Service Worker が前の版を出し続けると差し替えを確かめられないので止める（SW の更新は e2e-pwa で見る）
const context = await browser.newContext({ ...devices['iPhone 14 Pro'], hasTouch: true, serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const results = [];
const check = (name, ok, info) => results.push({ name, ok, ...(info ?? {}) });

const titleIs = (name) => page.waitForFunction((n) => document.getElementById('title')?.textContent === n, name, { timeout: 60000 });
const openFile = async (f) => {
  await page.setInputFiles('#file', f);
  await titleIs(path.basename(f));
  await page.waitForTimeout(700);
};

/** 端末に残っているもの: localStorage すべてと、IndexedDB の直近の図面・最近の一覧 */
const snapshot = () => page.evaluate(async () => {
  const ls = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    ls[k] = localStorage.getItem(k);
  }
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('jww-viewer');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const all = (store) => new Promise((resolve) => {
    if (!db.objectStoreNames.contains(store)) { resolve(null); return; }
    const tx = db.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    const keys = os.getAllKeys();
    const vals = os.getAll();
    tx.oncomplete = () => resolve(keys.result.map((k, i) => ({ k, v: vals.result[i] })));
  });
  const last = await all('last');
  const meta = await all('recent-meta');
  const data = await all('recent-data');
  const out = {
    version: db.version,
    stores: [...db.objectStoreNames].sort(),
    ls,
    last: last?.map(({ k, v }) => ({ k, name: v.name, size: v.buffer?.byteLength, key: v.key ?? null })),
    meta: meta?.map(({ k, v }) => ({ k, ...v })),
    data: data?.map(({ k, v }) => ({ k, size: (v.buffer ?? v)?.byteLength ?? null })),
  };
  db.close();
  return out;
});

/** 画面に出ている設定（本番ビルドには調べ口がないので、画面の表示から読む） */
const readout = () => page.evaluate(() => ({
  title: document.getElementById('title')?.textContent,
  welcome: !document.getElementById('welcome')?.classList.contains('hidden'),
  mode: document.querySelector('#seg-mode button[aria-pressed="true"], #seg-mode button.on')?.dataset.mode ?? null,
  bg: getComputedStyle(document.body).backgroundColor,
}));

// ---------- 1. 前の版で使う ----------
await page.goto(url, { waitUntil: 'networkidle' });
const oldTitle = await page.title();
if (second) await openFile(second);
await openFile(sample);

// 背景を明るくする
await page.click('#btn-display');
await page.waitForTimeout(250);
await page.click('#seg-bg button[data-value="light"]');
await page.waitForTimeout(250);
await page.click('#btn-display-close');
await page.waitForTimeout(250);
// 計測の種類を「面積」にする
await page.click('#seg-mode button[data-mode="area"]');
await page.waitForTimeout(250);
// レイヤを 1 つ隠す
await page.click('#btn-layers');
await page.waitForTimeout(300);
const hiddenLayer = await page.evaluate(() => {
  const head = document.querySelector('#layer-list .lg-head[data-toggle]');
  head?.click();
  const sw = [...document.querySelectorAll('#layer-list .sw[data-layer][aria-pressed="true"]')].find((e) => e.offsetParent);
  if (!sw) return null;
  sw.click();
  return sw.dataset.layer;
});
await page.waitForTimeout(300);
await page.click('#btn-layer-close');
await page.waitForTimeout(300);
const oldSeen = await readout();
const before = await snapshot();
await page.screenshot({ path: path.join(outDir, 'e2e-upgrade-1-old.png') });

// ---------- 2. 今の版に差し替えて開き直す（アプリの更新にあたる） ----------
current = newDist;
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction((n) => document.getElementById('title')?.textContent === n, path.basename(sample), { timeout: 60000 })
  .catch(() => {});
await page.waitForTimeout(1200);
const newTitle = await page.title();
const newSeen = await readout();
const after = await snapshot();
await page.screenshot({ path: path.join(outDir, 'e2e-upgrade-2-new.png') });

check('前の版と今の版が本当に別のもの（差し替わっている）', oldTitle !== '' && newTitle !== '' &&
  fs.readFileSync(path.join(oldDist, 'index.html'), 'utf8') !== fs.readFileSync(path.join(newDist, 'index.html'), 'utf8'),
{ oldTitle, newTitle });
check('前の版で設定を残せている（確かめる中身がある）',
  !!before.ls['jww-viewer:display'] && !!before.ls['jww-viewer:measure'] && (before.meta?.length ?? 0) >= (second ? 2 : 1),
{ keys: Object.keys(before.ls), recent: before.meta?.length, hiddenLayer });
check('端末の保存先（データベースの版と置き場）が変わらない',
  after.version === before.version && JSON.stringify(after.stores) === JSON.stringify(before.stores),
{ before: [before.version, before.stores], after: [after.version, after.stores] });
{
  const changed = Object.keys({ ...before.ls, ...after.ls }).filter((k) => before.ls[k] !== after.ls[k]);
  check('端末に残した設定（表示・計測・レイヤ）が 1 つも変わらない', changed.length === 0, { changed, before: before.ls, after: after.ls });
}
check('直近に開いた図面がそのまま残る', JSON.stringify(after.last) === JSON.stringify(before.last), { before: before.last, after: after.last });
check('最近開いた図面の一覧がそのまま残る（名前・大きさ・日時・中身）',
  JSON.stringify(after.meta) === JSON.stringify(before.meta) && JSON.stringify(after.data) === JSON.stringify(before.data),
{ before: before.meta, after: after.meta });
check('更新後に開くと、前に開いていた図面がそのまま出る', newSeen.title === path.basename(sample) && !newSeen.welcome, newSeen);
check('背景の明るさが引き継がれる', newSeen.bg === oldSeen.bg, { old: oldSeen.bg, now: newSeen.bg });
check('計測の種類（面積）が引き継がれる', oldSeen.mode === 'area' && newSeen.mode === 'area', { old: oldSeen.mode, now: newSeen.mode });
{
  const tool = await page.evaluate(() => document.querySelector('#toolbar .tool.on')?.id ?? null);
  check('更新後も最初の道具は「計測」', tool === 'btn-tool-measure', { tool });
}
if (hiddenLayer !== null) {
  await page.click('#btn-layers');
  await page.waitForTimeout(300);
  const st = await page.evaluate((k) => {
    const head = document.querySelector(`#layer-list .lg-head[data-toggle="${Number(k) >> 4}"]`);
    if (head && !document.querySelector(`#layer-list .sw[data-layer="${k}"]`)?.offsetParent) head.click();
    return document.querySelector(`#layer-list .sw[data-layer="${k}"]`)?.getAttribute('aria-pressed');
  }, hiddenLayer);
  check('隠したレイヤが隠れたまま', st === 'false', { layer: hiddenLayer, pressed: st });
  await page.click('#btn-layer-close');
  await page.waitForTimeout(250);
}
// 最近の一覧から前の図面を開き直せる
if (second) {
  await page.click('#btn-open');
  await page.waitForTimeout(400);
  const names = await page.evaluate(() => [...document.querySelectorAll('#recent-list [data-open]')]
    .map((e) => e.textContent.trim()).filter(Boolean));
  const hit = await page.evaluate((n) => {
    const b = [...document.querySelectorAll('#recent-list [data-open]')].find((e) => e.textContent.includes(n));
    b?.click();
    return !!b;
  }, path.basename(second));
  if (hit) await titleIs(path.basename(second)).catch(() => {});
  const t = await page.evaluate(() => document.getElementById('title')?.textContent);
  check('最近開いた図面の一覧から、前の版で開いた図面を開き直せる', hit && t === path.basename(second), { names, title: t });
}
check('エラーが出ない', errors.length === 0, { errors });

await browser.close();
server.close();

let failed = 0;
for (const r of results) {
  const { name, ok, ...info } = r;
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'NG  '} ${name}${ok ? '' : `  ${JSON.stringify(info).slice(0, 600)}`}`);
}
console.log(`\n${results.length - failed}/${results.length} 合格`);
process.exit(failed ? 1 : 0);
