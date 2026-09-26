// 画面向きを変えたときの拡大鏡の置き場所と、描画コンテキストが失われたあとの復帰を確かめる。
// あわせて、読み込めないファイル・表示の準備で止まる図面・部品の爆弾・開いている途中で落ちたあとの起動を確かめる。
import { chromium } from 'playwright';
import path from 'node:path';
import { startServer, projectRoot as root } from './serve.mjs';
import { makeJww, nestedBomb } from './jww-synth.mjs';

const sample = process.argv[2] ?? path.join(root, 'samples', 'A棟 11階躯体図2026.5.12提出スリーブ.jww');
const outDir = process.argv[3] ?? '.';

const srv = await startServer({ port: 5303, host: false, quiet: true });
const url = srv.url;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const results = [];
const check = (name, ok, info) => results.push({ name, ok, ...(info ?? {}) });
const errors = [];

// ---------- 拡大鏡の置き場所 ----------
const SCREENS = [
  { name: 'iPhone 縦 (393x852)', w: 393, h: 852 },
  { name: 'iPhone 横 (852x393)', w: 852, h: 393 },
  { name: '小さい端末 縦 (375x667)', w: 375, h: 667 },
  { name: '小さい端末 横 (667x375)', w: 667, h: 375 },
  { name: '極端に低い (740x320)', w: 740, h: 320 },
];

for (const s of SCREENS) {
  const ctx = await browser.newContext({
    viewport: { width: s.w, height: s.h },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${s.name}: ${e.message}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.setInputFiles('#file', sample);
  await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
  await page.waitForTimeout(400);

  const report = await page.evaluate(([w, h]) => {
    const app = window.__jww;
    const bad = [];
    let count = 0;
    for (let x = 20; x < w; x += 37) {
      for (let y = 60; y < h - 60; y += 31) {
        const m = app.placeMagnifier(x, y);
        count++;
        const overlaps = x >= m.x && x <= m.x + m.size && y >= m.y && y <= m.y + m.size;
        const outside = m.x < 0 || m.y < 0 || m.x + m.size > w || m.y + m.size > h;
        if (overlaps || outside) {
          bad.push({ x, y, m, overlaps, outside });
        }
      }
    }
    return { count, bad: bad.slice(0, 4), badCount: bad.length };
  }, [s.w, s.h]);

  check(`${s.name} で拡大鏡が指と重ならない`, report.badCount === 0, {
    試行: report.count,
    重なり: report.badCount,
    例: report.bad,
  });

  if (s.name.startsWith('iPhone 横')) {
    // 実際に長押しして絵を残す
    await page.evaluate(() => {
      const stage = document.getElementById('stage');
      const o = { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 400, clientY: 200, bubbles: true };
      stage.dispatchEvent(new PointerEvent('pointerdown', o));
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, 'e2e-magnifier-landscape.png') });
    await page.evaluate(() => {
      const stage = document.getElementById('stage');
      stage.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 400, clientY: 200, bubbles: true,
      }));
    });
  }

  await ctx.close();
}

// ---------- コンテキスト消失からの復帰 ----------
{
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`lost: ${e.message}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.setInputFiles('#file', sample);
  await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
  await page.waitForTimeout(600);

  const colorsOf = () => page.evaluate(() => {
    const c = document.getElementById('gl');
    const g = c.getContext('webgl2', { preserveDrawingBuffer: true });
    if (!g || g.isContextLost()) return -1;
    const px = new Uint8Array(4 * 96 * 96);
    g.readPixels(Math.floor(c.width / 2) - 48, Math.floor(c.height / 2) - 48, 96, 96, g.RGBA, g.UNSIGNED_BYTE, px);
    const set = new Set();
    for (let i = 0; i < px.length; i += 4) set.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
    return set.size;
  });

  const before = await colorsOf();

  const lostState = await page.evaluate(async () => {
    const c = document.getElementById('gl');
    const g = c.getContext('webgl2');
    const ext = g.getExtension('WEBGL_lose_context');
    if (!ext) return { supported: false };
    ext.loseContext();
    await new Promise((r) => setTimeout(r, 300));
    const lost = g.isContextLost();
    ext.restoreContext();
    await new Promise((r) => setTimeout(r, 800));
    return { supported: true, lost, restored: !g.isContextLost() };
  });

  await page.waitForTimeout(600);
  const after = await colorsOf();

  check('コンテキスト消失を扱える', lostState.supported !== true || lostState.lost === true, lostState);
  check('復帰後に描画が戻る', !lostState.supported || after >= Math.max(2, before - 4), {
    前: before, 後: after,
  });
  await page.screenshot({ path: path.join(outDir, 'e2e-restored.png') });
  await ctx.close();
}

// ---------- 読み込めないとき・落ちたあとの起動 ----------
{
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`load: ${e.message}`));
  await page.goto(url, { waitUntil: 'networkidle' });

  const small = { name: 'small.jww', mimeType: 'application/octet-stream', buffer: Buffer.from(makeJww({ entities: [{ line: [0, 0, 200, 100] }, { line: [0, 100, 200, 0] }] })) };
  const notJww = { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('これは図面ではありません') };
  const brokenJww = { name: 'broken.jww', mimeType: 'application/octet-stream', buffer: Buffer.concat([Buffer.from('JwwData.'), Buffer.alloc(200, 0xff)]) };
  const state = () => page.evaluate(() => ({
    welcome: !document.getElementById('welcome').classList.contains('hidden'),
    welcomeText: document.querySelector('#welcome .welcome-body p')?.textContent ?? '',
    loading: !document.getElementById('loading').classList.contains('hidden'),
    uiHidden: document.body.classList.contains('ui-hidden'),
    title: document.getElementById('title').textContent,
    hint: document.getElementById('hint').classList.contains('hidden') ? '' : document.getElementById('hint').textContent,
    scene: !!window.__jww.scene,
    recent: window.__jww.recent.map((r) => r.name),
    opening: localStorage.getItem('jww-viewer:opening'),
  }));
  const hintHas = (text) => page.waitForFunction((t) => {
    const h = document.getElementById('hint');
    return !h.classList.contains('hidden') && h.textContent.includes(t);
  }, text, { timeout: 30000 });
  const titled = (name) => page.waitForFunction((n) => document.getElementById('title').textContent === n, name, { timeout: 60000 });
  const lastName = () => page.evaluate(async () => (await (await import('/src/storage.ts')).loadLast())?.name ?? null);

  // 図面がないまま、ボタンを隠して読めないファイルを選ぶ：最初の画面に理由が出て、ボタンも戻る
  await page.waitForFunction(() => !document.getElementById('welcome').classList.contains('hidden'), null, { timeout: 10000 });
  await page.evaluate(() => window.__jww.setUiHidden(true));
  await page.setInputFiles('#file', notJww);
  await page.waitForFunction(() => /JWW ファイルではありません/.test(document.querySelector('#welcome .welcome-body p')?.textContent ?? ''), null, { timeout: 10000 });
  {
    const s = await state();
    check('図面がないときに読めないファイルを選ぶと、最初の画面に理由を出し、隠したボタンも戻す',
      s.welcome && !s.loading && !s.uiHidden && !s.scene, s);
  }

  // 図面を開いたあとに読めないファイル・壊れた .jww を開いても、最初の画面で覆わず、前の図面をそのまま使える
  await page.setInputFiles('#file', small);
  await titled('small.jww');
  await page.waitForFunction(() => window.__jww.recent.some((r) => r.name === 'small.jww'), null, { timeout: 10000 });
  await page.waitForFunction(() => localStorage.getItem('jww-viewer:opening') === null, null, { timeout: 10000 });
  await page.evaluate(() => { window.__prevScene = window.__jww.scene; });
  for (const [label, file, why] of [['JWW でないファイル', notJww, 'JWW ファイルではありません'], ['壊れた .jww', brokenJww, '途中で終わっています']]) {
    await page.setInputFiles('#file', file);
    await hintHas(why);
    await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'), null, { timeout: 30000 });
    const s = await state();
    const same = await page.evaluate(() => window.__jww.scene === window.__prevScene);
    check(`図面を開いたまま${label}を開くと、知らせだけ出して前の図面を残す（最初の画面で覆わない）`,
      !s.welcome && !s.loading && s.title === 'small.jww' && same && /読み込めませんでした/.test(s.hint) && s.opening === null, { ...s, same });
  }

  // 表示の準備で止まった図面：前の図面を残して知らせ、最近の一覧にも前回の図面にも入れない
  {
    await page.evaluate(() => { window.__jww.onLoaded = () => { throw new Error('テスト用の失敗'); }; });
    const bad = { name: 'throws.jww', mimeType: 'application/octet-stream', buffer: Buffer.from(makeJww({ entities: [{ line: [0, 0, 1, 1] }] })) };
    await page.setInputFiles('#file', bad);
    await hintHas('表示できません');
    await page.evaluate(() => { delete window.__jww.onLoaded; });
    await page.waitForTimeout(800);
    const s = await state();
    const same = await page.evaluate(() => window.__jww.scene === window.__prevScene);
    const last = await lastName();
    check('表示の準備で止まった図面は、前の図面を残して知らせ、最近の一覧にも前回の図面にも入れない',
      same && s.title === 'small.jww' && !s.welcome && !s.recent.includes('throws.jww') && last === 'small.jww' && s.opening === null,
      { ...s, same, last });
  }

  // 同じ部品を何度も配置する入れ子（数 KB）：打ち切って表示し、途中までしか表示していないと知らせる
  {
    const bomb = { name: 'bomb.jww', mimeType: 'application/octet-stream', buffer: Buffer.from(nestedBomb(9, 10)) };
    const t0 = Date.now();
    await page.setInputFiles('#file', bomb);
    await titled('bomb.jww');
    const ms = Date.now() - t0;
    const hint = await page.evaluate(() => document.getElementById('hint').textContent);
    check('入れ子の部品の爆弾は、打ち切って表示し、途中までしか表示していないと知らせる',
      /途中まで/.test(hint) && ms < 60000, { ms, hint, bytes: bomb.buffer.length });
  }

  // 開いている途中で落ちた図面は、次に起動したとき自動では開かない。別の図面を開き直せば元に戻る
  {
    await page.setInputFiles('#file', small);
    await titled('small.jww');
    await page.waitForFunction(() => localStorage.getItem('jww-viewer:opening') === null, null, { timeout: 10000 });
    await page.waitForFunction(async () => (await (await import('/src/storage.ts')).loadLast())?.name === 'small.jww', null, { timeout: 10000 });
    const cleared = await state();
    check('描き終えたら、開いている途中の印を消す', cleared.opening === null, cleared);

    // 開いた直後に読み込み直しても（落ちたのではないので）、次も前回の図面を開く
    await page.setInputFiles('#file', small);
    await titled('small.jww');
    await page.reload({ waitUntil: 'networkidle' });
    let quick = true;
    await titled('small.jww').catch(() => { quick = false; });
    check('開いた直後に読み込み直しても、前回の図面を開く', quick, await state());
    await page.waitForFunction(() => localStorage.getItem('jww-viewer:opening') === null, null, { timeout: 10000 });

    // 描いている途中で落ちたのと同じ状態を作って起動し直す（落ちたときは、ページを閉じるときの後片付けが届かない）
    await page.evaluate(() => window.addEventListener('pagehide', () => localStorage.setItem('jww-viewer:opening', 'small.jww')));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.getElementById('welcome').classList.contains('hidden'), null, { timeout: 10000 });
    await page.waitForTimeout(500);
    const skipped = await state();
    check('前回その図面を開いている途中で終わっていたら、自動では開かず、最初の画面で知らせる',
      skipped.welcome && !skipped.scene && !skipped.loading && /自動では開いていません/.test(skipped.welcomeText), skipped);

    // 一覧から開き直して描き終えれば、次からはまた自動で開く
    await page.click('#btn-open-2');
    await page.click('#recent-list .recent-open');
    await titled('small.jww');
    await page.waitForFunction(() => localStorage.getItem('jww-viewer:opening') === null, null, { timeout: 10000 });
    await page.reload({ waitUntil: 'networkidle' });
    let restored = true;
    await titled('small.jww').catch(() => { restored = false; });
    check('開き直して描き終えれば、次に起動したときはまた前回の図面を開く', restored, await state());
  }

  await ctx.close();
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length, errors: errors.slice(0, 5) }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length ? 1 : 0);
