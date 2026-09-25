// 拡大鏡がドラッグ中にどう動いているかを 1 フレームずつ記録して、
// 何が滑らかさを損ねているのかを数値で見る。
import { chromium, devices } from 'playwright';
import path from 'node:path';
import { startServer, projectRoot as root } from './serve.mjs';
import { defaultSample } from './samples.mjs';

const srv = await startServer({ port: 5305, host: false, quiet: true });
const sample = process.argv[2] ?? defaultSample();

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ ...devices['iPhone 14 Pro'], hasTouch: true });
const page = await context.newPage();

await page.goto(srv.url, { waitUntil: 'networkidle' });
await page.setInputFiles('#file', sample);
await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
await page.waitForTimeout(600);

// 線が多い場所まで寄せる
await page.evaluate(() => {
  const a = window.__jww;
  a.view.zoom *= 6;
  a.requestDraw(true);
});
await page.waitForTimeout(300);

// draw を包んで、各フレームの状態と内訳の所要時間を残す
await page.evaluate(() => {
  const a = window.__jww;
  window.__log = [];
  window.__parts = [];

  // 各段階に時計を挟む
  const wrap = (obj, name, label) => {
    const fn = obj[name].bind(obj);
    obj[name] = function timed(...args) {
      const t0 = performance.now();
      const r = fn(...args);
      window.__parts.push({ label, ms: performance.now() - t0 });
      return r;
    };
  };
  wrap(a.renderer, 'draw', 'gl.draw');
  wrap(a.renderer, 'drawInset', 'gl.drawInset');
  wrap(a.textLayer, 'syncTransform', 'text.sync');
  wrap(a, 'clipTextForMagnifier', 'text.clip');
  wrap(a.overlay, 'render', 'overlay');
  wrap(a, 'snapFor', 'snap');

  const orig = a.draw.bind(a);
  a.draw = function wrapped() {
    const t0 = performance.now();
    orig();
    window.__parts.push({ label: 'draw合計', ms: performance.now() - t0 });
    window.__log.push({
      t: performance.now(),
      px: a.preview ? a.preview.x : null,
      py: a.preview ? a.preview.y : null,
      kind: a.preview ? a.preview.kind : null,
      mx: a.magnifier ? a.magnifier.x : null,
      my: a.magnifier ? a.magnifier.y : null,
      cx: a.cursor ? a.cursor.x : null,
      cy: a.cursor ? a.cursor.y : null,
      zoom: a.view.zoom,
      dpr: a.dpr,
    });
  };
});

// 長押ししてから、ゆっくり大きく動かす
await page.evaluate(async () => {
  const stage = document.getElementById('stage');
  const base = { pointerId: 11, pointerType: 'touch', isPrimary: true, bubbles: true };
  const start = { x: 150, y: 300 };
  stage.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: start.x, clientY: start.y }));
  await new Promise((r) => setTimeout(r, 400));
  // 画面を斜めに横切る。1 フレームあたり数ピクセルの、実際の指の速さに近い動き
  const steps = 90;
  for (let i = 1; i <= steps; i++) {
    stage.dispatchEvent(new PointerEvent('pointermove', {
      ...base,
      clientX: start.x + (i * 200) / steps,
      clientY: start.y + (i * 320) / steps,
    }));
    await new Promise((r) => requestAnimationFrame(() => r()));
  }
  stage.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: 350, clientY: 620 }));
});
await page.waitForTimeout(300);

const log = await page.evaluate(() => window.__log);
const parts = await page.evaluate(() => window.__parts);

// 拡大鏡の中身は preview を中心に view.zoom*5 で描かれる。
// 画面上での中心の動き（拡大鏡の中でどれだけ景色が流れたか）を見る
const MAG = 3.5;
const frames = log.filter((f) => f.px !== null && f.cx !== null);
const jumps = [];
const snapJumps = [];
const fingerSteps = [];
const gaps = [];
let kindChanges = 0;

for (let i = 1; i < frames.length; i++) {
  const a = frames[i - 1];
  const b = frames[i];
  const scale = (b.zoom * MAG) / b.dpr; // 図面座標 → 拡大鏡内の CSS ピクセル
  jumps.push(Math.hypot(b.cx - a.cx, b.cy - a.cy) * MAG);
  snapJumps.push(Math.hypot(b.px - a.px, b.py - a.py) * scale);
  fingerSteps.push(Math.hypot(b.cx - a.cx, b.cy - a.cy));
  gaps.push(b.t - a.t);
  if (a.kind !== b.kind) kindChanges++;
}

const stat = (arr) => {
  if (!arr.length) return null;
  const sorted = [...arr].sort((x, y) => x - y);
  const sum = arr.reduce((x, y) => x + y, 0);
  return {
    平均: +(sum / arr.length).toFixed(1),
    中央: +sorted[Math.floor(sorted.length / 2)].toFixed(1),
    '90%': +sorted[Math.floor(sorted.length * 0.9)].toFixed(1),
    最大: +sorted[sorted.length - 1].toFixed(1),
  };
};

// 拡大鏡の枠が飛んだ回数（配置が上下左右で切り替わった）
let boxJumps = 0;
let maxBoxJump = 0;
for (let i = 1; i < frames.length; i++) {
  const d = Math.hypot(frames[i].mx - frames[i - 1].mx, frames[i].my - frames[i - 1].my);
  if (d > 20) boxJumps++;
  if (d > maxBoxJump) maxBoxJump = d;
}

// 段階ごとの所要時間
const byLabel = {};
for (const p of parts) {
  (byLabel[p.label] ??= []).push(p.ms);
}
const breakdown = {};
for (const [k, v] of Object.entries(byLabel)) {
  const sum = v.reduce((x, y) => x + y, 0);
  breakdown[k] = { 回数: v.length, 平均ms: +(sum / v.length).toFixed(2), 合計ms: +sum.toFixed(0) };
}

console.log(JSON.stringify({
  内訳: breakdown,
  フレーム数: frames.length,
  フレーム間隔ms: stat(gaps),
  指の移動量px: stat(fingerSteps),
  拡大鏡内で景色が流れた量px: stat(jumps),
  吸着先が動いた量px: stat(snapJumps),
  '流れた量が指の移動の何倍か': +(stat(jumps).平均 / Math.max(stat(fingerSteps).平均, 0.01)).toFixed(1),
  吸着先が切り替わった回数: kindChanges,
  枠が20px以上飛んだ回数: boxJumps,
  枠の最大移動px: +maxBoxJump.toFixed(1),
}, null, 2));

await browser.close();
await srv.close();
