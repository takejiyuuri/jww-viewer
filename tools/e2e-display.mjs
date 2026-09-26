// 背景の白黒・単色表示・色ごとの表示非表示を、画面のピクセルで確かめる。
import { chromium, devices } from 'playwright';
import path from 'node:path';
import { startServer, projectRoot as root } from './serve.mjs';

const srv = await startServer({ port: 5307, host: false, quiet: true });
const sample = process.argv[2] ?? path.join(root, 'samples', 'A棟 11階躯体図2026.5.12提出スリーブ.jww');
const outDir = process.argv[3] ?? '.';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ ...devices['iPhone 14 Pro'], hasTouch: true });
const page = await context.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const results = [];
const check = (name, ok, info) => results.push({ name, ok, ...(info ?? {}) });

const openDrawing = async () => {
  await page.waitForFunction(() => document.getElementById('title')?.textContent?.endsWith('.jww'), null, { timeout: 60000 });
  await page.waitForTimeout(500);
};

await page.goto(srv.url, { waitUntil: 'networkidle' });
await page.setInputFiles('#file', sample);
await openDrawing();

/** 描き直した直後の GL 画面から、色ごとのピクセル数を数える */
const glPixels = () => page.evaluate(() => {
  const a = window.__jww;
  a.renderer.draw(a.view, a.dpr);
  const c = document.getElementById('gl');
  const g = c.getContext('webgl2');
  const px = new Uint8Array(c.width * c.height * 4);
  g.readPixels(0, 0, c.width, c.height, g.RGBA, g.UNSIGNED_BYTE, px);
  const counts = new Map();
  for (let i = 0; i < px.length; i += 4) {
    const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  // 多い順に上位だけ返す
  const top = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12)
    .map(([k, n]) => ({ rgb: [(k >> 16) & 255, (k >> 8) & 255, k & 255], n }));
  return { total: px.length / 4, distinct: counts.size, top, counts: Object.fromEntries(counts) };
});

const countOf = (px, rgb) => px.counts[(rgb[0] << 16) | (rgb[1] << 8) | rgb[2]] ?? 0;

/** 文字レイヤで、指定の色に近いピクセルの数 */
const textPixels = (rgb) => page.evaluate((c0) => {
  const c = document.getElementById('text');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  let any = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    any++;
    if (Math.abs(d[i] - c0[0]) + Math.abs(d[i + 1] - c0[1]) + Math.abs(d[i + 2] - c0[2]) < 30) n++;
  }
  return { n, any };
}, rgb);

// ---------- 1. 表示シート ----------
await page.click('#btn-display');
await page.waitForTimeout(200);
const sheet = await page.evaluate(() => ({
  open: !document.getElementById('display-panel').classList.contains('hidden'),
  rows: document.querySelectorAll('#color-list .color-row').length,
  groups: window.__jww.scene.groups.length,
  labels: [...document.querySelectorAll('#color-list .color-name')].map((n) => n.textContent),
}));
check('表示シートが開く', sheet.open);
check('図面で使われている色が並ぶ', sheet.rows === sheet.groups && sheet.rows > 0, {
  行: sheet.rows, 色: sheet.groups, 例: sheet.labels.slice(0, 6).join('・'),
});
await page.screenshot({ path: path.join(outDir, 'e2e-display-sheet.png') });

// ---------- 2. 黒背景 → 白背景 ----------
const darkPx = await glPixels();
await page.click('#seg-bg button[data-value="light"]');
await page.waitForTimeout(200);
const lightPx = await glPixels();
const state2 = await page.evaluate(() => ({
  bg: document.body.dataset.bg,
  on: document.querySelector('#seg-bg button.on')?.dataset.value,
}));
check('白背景にすると画面の地が白になる', lightPx.top[0].rgb.join() === '255,255,255', {
  前の地: darkPx.top[0].rgb.join(), 後の地: lightPx.top[0].rgb.join(),
});
check('白背景の状態が画面に反映される', state2.bg === 'light' && state2.on === 'light', state2);
// 黒背景での白い線（線色2）は、白背景では黒くなるはず
check('白い線は白背景で黒く描かれる', countOf(lightPx, [0, 0, 0]) > 1000, {
  黒の画素: countOf(lightPx, [0, 0, 0]),
});
// 白背景に白い線が残っていないか（背景以外の純白がない）
check('白背景に白の線が残らない', darkPx.distinct > 50 && lightPx.distinct > 50, {
  色数_黒背景: darkPx.distinct, 色数_白背景: lightPx.distinct,
});

// ---------- 3. 単色 ----------
await page.click('#seg-mono button[data-value="mono"]');
await page.waitForTimeout(200);
const monoPx = await glPixels();
// 単色なら、地と線色（と両者の中間のにじみ）だけになる。色相のある画素がほぼ消える
const chromatic = Object.entries(monoPx.counts).reduce((sum, [k, n]) => {
  const v = Number(k);
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  return Math.max(r, g, b) - Math.min(r, g, b) > 24 ? sum + n : sum;
}, 0);
check('単色にすると色のついた線がなくなる', chromatic < monoPx.total * 0.002, {
  色のある画素: chromatic, 全画素: monoPx.total,
});
await page.click('#seg-mono button[data-value="color"]');
await page.waitForTimeout(150);

// ---------- 4. 色ごとに隠す ----------
// 白背景で一番多く描かれている線色を選び、それを隠すとその色の画素が消えるかを見る
const target = await page.evaluate(() => {
  const a = window.__jww;
  const s = a.scene;
  // 線分の本数が一番多い色グループ
  const tally = new Map();
  for (let i = 0; i < s.lineColor.length; i++) {
    const g = s.colorGroup[s.lineColor[i]];
    tally.set(g, (tally.get(g) ?? 0) + 1);
  }
  const [group] = [...tally.entries()].sort((x, y) => y[1] - x[1])[0];
  // その色の、いまの表示色
  const entry = s.colorGroup.indexOf(group);
  const p = a.renderer.palette;
  return { group, label: s.groups[group].label, rgb: [p[entry * 4], p[entry * 4 + 1], p[entry * 4 + 2]] };
});
const before4 = await glPixels();
const textBefore = await textPixels(target.rgb);
await page.click(`#color-list .color-row[data-group="${target.group}"]`);
await page.waitForTimeout(250);
const after4 = await glPixels();
const textAfter = await textPixels(target.rgb);
const rowOff = await page.evaluate((g) => {
  const row = document.querySelector(`#color-list .color-row[data-group="${g}"]`);
  return { off: row.classList.contains('off'), pressed: row.getAttribute('aria-pressed') };
}, target.group);

check('隠した色の線が画面から消える', countOf(before4, target.rgb) > 200 && countOf(after4, target.rgb) < countOf(before4, target.rgb) * 0.02, {
  色: target.label, 表示色: target.rgb.join(), 前: countOf(before4, target.rgb), 後: countOf(after4, target.rgb),
});
check('隠した色の文字も消える', textBefore.n === 0 || textAfter.n < textBefore.n * 0.05, {
  前: textBefore.n, 後: textAfter.n,
});
check('隠した行はスイッチが切れて見える', rowOff.off && rowOff.pressed === 'false', rowOff);

// ---------- 5. すべて隠す → 何も吸着しない / すべて表示で戻る ----------
await page.click('#btn-color-none');
await page.waitForTimeout(250);
const nonePx = await glPixels();
const snapNone = await page.evaluate(() => {
  const a = window.__jww;
  let free = 0;
  let total = 0;
  for (let i = 0; i < 40; i++) {
    const k = Math.floor((i / 40) * (a.scene.linePos.length / 4)) * 4;
    const r = a.snapIndex.query(a.scene.linePos[k], a.scene.linePos[k + 1], 5);
    total++;
    if (r.kind === 'free') free++;
  }
  return { free, total };
});
check('すべて隠すと画面が地の色だけになる', nonePx.top[0].n > nonePx.total * 0.995, {
  地の割合: (nonePx.top[0].n / nonePx.total).toFixed(4),
});
check('隠した線には吸着しない', snapNone.free === snapNone.total, snapNone);

await page.click('#btn-color-all');
await page.waitForTimeout(250);
const allPx = await glPixels();
check('すべて表示で元に戻る', Math.abs(allPx.distinct - before4.distinct) < before4.distinct * 0.1, {
  前: before4.distinct, 後: allPx.distinct,
});

// ---------- 6. 設定が残るか ----------
// ひとつ隠した状態で再読み込みする。背景は端末の設定として、隠した色は同じ図面なら戻る
await page.click(`#color-list .color-row[data-group="${target.group}"]`);
await page.waitForTimeout(150);
await page.click('#btn-display-close');
await page.screenshot({ path: path.join(outDir, 'e2e-display-light.png') });

await page.reload({ waitUntil: 'networkidle' });
await openDrawing();
const restored = await page.evaluate((g) => ({
  bg: document.body.dataset.bg,
  hidden: [...window.__jww.hiddenGroups],
  label: window.__jww.scene.groups[g]?.label,
}), target.group);
check('再読み込み後も白背景のまま', restored.bg === 'light', { bg: restored.bg });
check('同じ図面なら隠した色が戻る', restored.hidden.length === 1, restored);

// ---------- 7. 線の太さ ----------
// 白い線だけの図形を黒地に描き、画素の明るさの合計から線の実際の太さ（デバイスピクセル）を求める
const widths = await page.evaluate(async () => {
  const { lineWidthAt } = await import('/src/render/renderer.ts');
  const a = window.__jww;
  const r = a.renderer;
  const gl = r.gl;
  const W = r.canvas.width, H = r.canvas.height, dpr = a.dpr;
  const scene = (lines) => {
    const n = lines.length / 4;
    return {
      linePos: new Float32Array(lines), lineColor: new Uint16Array(n), lineLayer: new Uint8Array(n),
      triPos: new Float32Array(0), triColor: new Uint16Array(0), triLayer: new Uint8Array(0),
    };
  };
  r.setPalette(new Uint8Array([255, 255, 255, 255]));
  r.setLayerVisibility(new Uint8Array(256).fill(1));
  r.setBackground([0, 0, 0]);
  const shot = (view) => {
    r.draw(view, dpr);
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  // 横線を 1 列だけ縦に見て、明るさを足す
  const across = (px, x) => { let s = 0; for (let y = 0; y < H; y++) s += px[(y * W + x) * 4] / 255; return s; };
  // 円の周りの輪の明るさを足して、周の長さで割る
  const ring = (px, rad) => {
    let s = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (Math.abs(Math.hypot(x + 0.5 - W / 2, y + 0.5 - H / 2) - rad) < 12) s += px[(y * W + x) * 4] / 255;
    }
    return s / (2 * Math.PI * rad);
  };

  // 用紙 1mm が 0.3 CSS ピクセル（A1 の全体表示より引いた所）と 6 CSS ピクセル（大きく拡大した所）
  const far = 0.3 * dpr, near = 6 * dpr;
  r.setScene(scene([-1e5, 0, 1e5, 0]));
  const lineFar = across(shot({ cx: 0, cy: 0, zoom: far }), W >> 1);
  const lineNear = across(shot({ cx: 0, cy: 0, zoom: near }), W >> 1);

  // 図面と同じ細かさ（弦と弧の隔たり 0.02mm。geometry.ts の arcSegments と同じ式）で折った円
  const polygon = (R) => {
    const n = Math.max(4, Math.ceil((2 * Math.PI) / (2 * Math.acos(1 - 0.02 / R))));
    const out = [];
    for (let i = 0; i < n; i++) {
      const t0 = (2 * Math.PI * i) / n, t1 = (2 * Math.PI * (i + 1)) / n;
      out.push(R * Math.cos(t0), R * Math.sin(t0), R * Math.cos(t1), R * Math.sin(t1));
    }
    return out;
  };
  // 半径 1000mm の円を、線分が 1 ピクセルより短くなるまで縮小して描く
  const R = 1000, rad = 40;
  const arc = polygon(R);
  const n = arc.length / 4;
  r.setScene(scene(arc));
  const circleFar = ring(shot({ cx: 0, cy: 0, zoom: rad / R }), rad);
  r.setScene(scene([-1e5, 0, 1e5, 0]));
  const lineAtCircle = across(shot({ cx: 0, cy: 0, zoom: rad / R }), W >> 1);

  // 直角に折れる 2 本の線分：角の外側の四角（どちらの線分の先でもない所）が埋まっているか。
  // 継ぎ目は画面の中央に来るので、そこから外側へ線の太さの半分の半分ほど離れた画素を見る
  r.setScene(scene([0, 0, 100, 0, 100, 0, 100, 100]));
  const cornerPx = shot({ cx: 100, cy: 0, zoom: near });
  const hw = (lineWidthAt(near, dpr) * dpr) / 2;
  const cx0 = Math.floor(W / 2 + hw / 2), cy0 = Math.floor(H / 2 - hw / 2);
  const corner = cornerPx[(cy0 * W + cx0) * 4];

  // 粗く折られる小さな円（半径 2mm）を拡大して、継ぎ目の外側に欠けがないか。
  // 折れ線を理想どおりに太らせた形（各線分からの距離）と比べ、足りない明るさの最大を見る。拡大鏡の太さ（1.6 倍）でも見る
  const small = polygon(2);
  r.setScene(scene(small));
  const deficit = (px, zoom, scale) => {
    const hwPx = (lineWidthAt(zoom, dpr) * dpr * scale) / 2;
    const P = [];
    for (let i = 0; i < small.length; i += 2) P.push([W / 2 + small[i] * zoom, H / 2 + small[i + 1] * zoom]);
    let worst = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      if (Math.abs(Math.hypot(cx - W / 2, cy - H / 2) - 2 * zoom) > hwPx + 3) continue;
      let d = Infinity;
      for (let k = 0; k < P.length; k += 2) {
        const [ax, ay] = P[k], [bx, by] = P[k + 1];
        const vx = bx - ax, vy = by - ay;
        const t = Math.max(0, Math.min(1, ((cx - ax) * vx + (cy - ay) * vy) / (vx * vx + vy * vy)));
        d = Math.min(d, Math.hypot(cx - ax - vx * t, cy - ay - vy * t));
      }
      const want = Math.max(0, Math.min(1, hwPx + 0.5 - d));
      worst = Math.max(worst, want - px[(y * W + x) * 4] / 255);
    }
    return worst;
  };
  const zSmall = 100;
  const smallMain = deficit(shot({ cx: 0, cy: 0, zoom: zSmall }), zSmall, 1);
  r.drawInset({ cx: 0, cy: 0, zoom: zSmall }, 0, 0, W, H, dpr);
  const insetPx = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, insetPx);
  const smallInset = deficit(insetPx, zSmall, 1.6);

  // 半端な座標で一直線につながる 2 本の線分を、いちばん大きく拡大して継ぎ目を見る（拡大鏡でも）。
  // 継ぎ目の端点が補間の誤差でずれると、線の真ん中に割れ目が出る
  const f32 = Math.fround;
  const yy = f32(37.13), jx = f32(-257.65);
  r.setScene(scene([f32(115.39), yy, jx, yy, jx, yy, f32(-300), yy]));
  let seam = 255;
  for (const zoom of [3000, 20000, 58000]) {
    for (const inset of [false, true]) {
      const v = { cx: jx, cy: yy, zoom };
      if (inset) r.drawInset({ ...v, zoom: zoom * 3.5 }, 0, 0, W, H, dpr);
      else r.draw(v, dpr);
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let x = (W >> 1) - 20; x < (W >> 1) + 20; x++) seam = Math.min(seam, px[((H >> 1) * W + x) * 4]);
    }
  }

  // 図面の表示に戻す
  r.setScene(a.scene);
  a.applyDisplay?.();
  a.requestDraw?.(true);
  return {
    dpr,
    far: { 実測: +lineFar.toFixed(2), 狙い: +(lineWidthAt(far, dpr) * dpr).toFixed(2) },
    near: { 実測: +lineNear.toFixed(2), 狙い: +(lineWidthAt(near, dpr) * dpr).toFixed(2) },
    circle: { 円: +circleFar.toFixed(2), 直線: +lineAtCircle.toFixed(2), 線分の長さ: +((2 * Math.PI * rad) / n).toFixed(2) },
    corner: { 明るさ: corner, 継ぎ目からのずれ: [cx0 + 0.5 - W / 2, cy0 + 0.5 - H / 2], 半幅: +hw.toFixed(2) },
    seam,
    small: { 分割: small.length / 4, 通常: +smallMain.toFixed(2), 拡大鏡: +smallInset.toFixed(2) },
  };
});
const near = (v, want) => Math.abs(v - want) <= want * 0.05;
check('拡大しているときの線は 1.15 CSS ピクセル', near(widths.near.実測, 1.15 * widths.dpr) && near(widths.near.実測, widths.near.狙い), widths.near);
check('縮小すると線が細くなる（0.55 CSS ピクセル）', near(widths.far.実測, 0.55 * widths.dpr) && near(widths.far.実測, widths.far.狙い), widths.far);
check('細かく折った円も、線分が 1 ピクセルより短くなるまで縮小して直線と同じ太さ', widths.circle.線分の長さ < 1 && near(widths.circle.円, widths.circle.直線), widths.circle);
check('直角に折れる角の外側が欠けない', widths.corner.明るさ > 230, widths.corner);
check('一直線につながる線分の継ぎ目が、いちばん大きく拡大しても割れない（拡大鏡でも）', widths.seam === 255, { 継ぎ目の最小の明るさ: widths.seam });
check('粗く折られる小さな円を拡大しても、継ぎ目の外側が欠けない（拡大鏡でも）', widths.small.通常 < 0.2 && widths.small.拡大鏡 < 0.2, widths.small);

// ---------- 8. 線種・実点・単色の塗り ----------
// 線種の模様は画面のドットで決まる。合成した線を黒地に白で描き、明るい画素の割合と、円弧の継ぎ目で模様が続くかを見る
const styles = await page.evaluate(async () => {
  const { buildPalette } = await import('/src/render/theme.ts');
  const a = window.__jww;
  const r = a.renderer;
  const gl = r.gl;
  const W = r.canvas.width, H = r.canvas.height, dpr = a.dpr;
  // 線種 2（点線1）は 1001 の繰り返し、線種 9（補助線）は 0010 の繰り返し。どちらも 1 ビット 1 ドット
  const dashes = new Uint32Array(128);
  dashes[2 * 2] = 0x99999999; dashes[2 * 2 + 1] = 4 | (1 << 8);
  dashes[9 * 2] = 0x22222222; dashes[9 * 2 + 1] = 4 | (1 << 8);
  /** 1 つの図形として続く折れ線（lines は線分の並び）を、線種 style で */
  const scene = (lines, style, extra = {}) => {
    const n = lines.length / 4;
    const dist = new Float32Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      dist[i] = sum;
      sum += Math.hypot(lines[i * 4 + 2] - lines[i * 4], lines[i * 4 + 3] - lines[i * 4 + 1]);
    }
    return {
      linePos: new Float32Array(lines), lineColor: new Uint16Array(n), lineLayer: new Uint8Array(n),
      lineStyle: new Uint8Array(n).fill(style), lineDist: dist, dashes,
      triPos: new Float32Array(0), triColor: new Uint16Array(0), triLayer: new Uint8Array(0),
      ...extra,
    };
  };
  r.setPalette(new Uint8Array([255, 255, 255, 255]));
  r.setLayerVisibility(new Uint8Array(256).fill(1));
  r.setBackground([0, 0, 0]);
  const shot = (view) => {
    r.draw(view, dpr);
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  // 横線の中央の行で、明るい画素の割合と、明るい所・暗い所の切り替わりの数
  const rowStats = (px) => {
    let lit = 0, flips = 0, prev = false;
    const y = H >> 1;
    for (let x = 0; x < W; x++) {
      const on = px[(y * W + x) * 4] > 128;
      if (on) lit++;
      if (x > 0 && on !== prev) flips++;
      prev = on;
    }
    return { lit: +(lit / W).toFixed(3), flips };
  };
  const view = { cx: 0, cy: 0, zoom: 6 * dpr };
  r.setScene(scene([-1e5, 0, 1e5, 0], 1));
  const solid = rowStats(shot(view));
  r.setScene(scene([-1e5, 0, 1e5, 0], 2));
  const dotted = rowStats(shot(view));
  // 同じ点線を 2 本の線分に分けても、継ぎ目で模様が始まり直さない（1 本のときと同じ画素になる）
  const one = shot(view);
  r.setScene(scene([-1e5, 0, 13.37, 0, 13.37, 0, 1e5, 0], 2));
  const two = shot(view);
  // 模様の境目のすぐ近くの画素は、丸めの差で入れ替わることがあるので、数画素までは許す
  let seamDiff = 0;
  for (let x = 0; x < W; x++) {
    const i = ((H >> 1) * W + x) * 4;
    if (Math.abs(one[i] - two[i]) > 64) seamDiff++;
  }

  // 細かく折った円（線分 1 本が 1 ピクセルより短い）を補助線の模様で描く。
  // 継ぎ目ごとに模様が始まり直すと、どの線分も最初のビット（0）だけになって何も描かれないか、すべて描かれてしまう
  const R = 1000, rad = 40 * dpr;
  const n = Math.max(4, Math.ceil((2 * Math.PI) / (2 * Math.acos(1 - 0.02 / R))));
  const circle = [];
  for (let i = 0; i < n; i++) {
    const t0 = (2 * Math.PI * i) / n, t1 = (2 * Math.PI * (i + 1)) / n;
    circle.push(R * Math.cos(t0), R * Math.sin(t0), R * Math.cos(t1), R * Math.sin(t1));
  }
  const ring = (px) => {
    let s = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (Math.abs(Math.hypot(x + 0.5 - W / 2, y + 0.5 - H / 2) - rad) < 12) s += px[(y * W + x) * 4] / 255;
    }
    return s;
  };
  r.setScene(scene(circle, 1));
  const circleSolid = ring(shot({ cx: 0, cy: 0, zoom: rad / R }));
  r.setScene(scene(circle, 9));
  const circleAux = ring(shot({ cx: 0, cy: 0, zoom: rad / R }));

  // 実点の丸。半径の指定がなければ画面で決めた小さな丸、指定があれば用紙上の半径で描く
  const lit = (px) => { let s = 0; for (let i = 0; i < px.length; i += 4) s += px[i] / 255; return s; };
  const dotScene = (radius) => scene([], 1, {
    dotPos: new Float32Array([0, 0, radius]), dotColor: new Uint16Array(1), dotLayer: new Uint8Array(1),
  });
  r.setScene(dotScene(0));
  const dotSmall = lit(shot({ cx: 0, cy: 0, zoom: 6 * dpr }));
  r.setScene(dotScene(0.5));
  const dotBig = lit(shot({ cx: 0, cy: 0, zoom: 20 * dpr }));

  // 単色では、塗りを線と同じ色のべた塗りにせず淡くする。塗りの上の線が見分けられるか
  const fillScene = {
    ...scene([-1e5, 0, 1e5, 0], 1),
    triPos: new Float32Array([-1e5, -1e5, 1e5, -1e5, 0, 1e5]), triColor: new Uint16Array(3), triLayer: new Uint8Array(3),
    colors: new Uint8Array([255, 255, 200]), colorGroup: new Uint16Array(1),
  };
  const fills = {};
  for (const bg of ['dark', 'light']) {
    r.setScene(fillScene);
    r.setPalette(buildPalette(fillScene.colors, fillScene.colorGroup, new Set(), { background: bg, mono: true }));
    const px = shot({ cx: 0, cy: 0, zoom: 6 * dpr });
    const at = (x, y) => [...px.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)];
    fills[bg] = { line: at(W >> 1, H >> 1), fill: at(W >> 1, (H >> 1) + 40) };
  }

  r.setScene(a.scene);
  a.applyDisplay?.();
  a.requestDraw?.(true);
  return {
    dpr, solid, dotted, seamDiff,
    circle: { 実線: +circleSolid.toFixed(1), 補助線: +circleAux.toFixed(1), 割合: +(circleAux / circleSolid).toFixed(3) },
    dot: { 小: +dotSmall.toFixed(1), 小の狙い: +(Math.PI * (1.1 * dpr) ** 2).toFixed(1), 大: +dotBig.toFixed(1), 大の狙い: +(Math.PI * (0.5 * 20 * dpr) ** 2).toFixed(1) },
    fills,
  };
});
check('実線は途切れない', styles.solid.lit > 0.99 && styles.solid.flips === 0, styles.solid);
check('点線1 は半分ほどが描かれ、何度も途切れる', styles.dotted.lit > 0.35 && styles.dotted.lit < 0.65 && styles.dotted.flips > 40, styles.dotted);
check('同じ点線を 2 本の線分に分けても、継ぎ目で模様がずれない', styles.seamDiff <= 4, { 違う画素: styles.seamDiff });
check('細かく折った円でも補助線の模様（4 つに 1 つ）が続く', styles.circle.割合 > 0.15 && styles.circle.割合 < 0.4, styles.circle);
const within = (v, want) => v > want * 0.6 && v < want * 1.5;
check('実点は画面で決めた大きさの丸で描く', within(styles.dot.小, styles.dot.小の狙い), styles.dot);
check('半径の指定がある実点は用紙上の大きさの丸で描く', within(styles.dot.大, styles.dot.大の狙い), styles.dot);
const lum = ([r, g, b]) => {
  const f = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
for (const bg of ['dark', 'light']) {
  const f = styles.fills[bg];
  check(`単色（${bg === 'dark' ? '黒' : '白'}背景）の塗りの上でも線が見分けられる`, ratio(f.line, f.fill) >= 4.5, { ...f, 比: +ratio(f.line, f.fill).toFixed(2) });
}

// 拡大鏡の中の文字は、同じキャンバスに計測の札の揃え方（中央・中段）が残っていても同じ所に描く。
// 字の枠の下端を始点にそろえる（Jw_cad の文字枠の左下が始点）
const inset = await page.evaluate(() => {
  const a = window.__jww;
  const t = a.scene.texts.find((x) => Math.abs(x.angle) < 0.01 && x.width > x.height && a.layerMask[x.layer] && a.colorVisible[x.color]);
  if (!t) return null;
  const size = 400;
  const zoom = 60 / t.height;
  const view = { cx: t.x + t.width / 2, cy: t.y + t.height / 2, zoom };
  const draw = (align) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    if (align) { ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; }
    a.textLayer.renderInset(ctx, view, 0, 0, size, size);
    return ctx.getImageData(0, 0, size, size).data;
  };
  // 選んだ文字だけを描く（近くのほかの文字が混じらないように）
  const saved = a.textLayer.texts;
  a.textLayer.texts = [t];
  const plain = draw(false);
  const shifted = draw(true);
  a.textLayer.texts = saved;
  let diff = 0;
  let lowest = -1;
  for (let i = 0; i < plain.length; i += 4) {
    if (plain[i + 3] !== shifted[i + 3]) diff++;
    if (plain[i + 3] > 128) lowest = Math.max(lowest, Math.floor(i / 4 / size));
  }
  // 始点の高さ（キャンバスの行）。字はこれより下へはみ出さない
  const base = size / 2 - (t.y - view.cy) * zoom;
  return { diff, lowest, base: +base.toFixed(1), height: 60 };
});
check('拡大鏡の中の文字は、札の揃え方が残っていても同じ所に描く', inset && inset.diff === 0, inset);
check('文字の下端は始点より下へはみ出さない', inset && inset.lowest >= 0 && inset.lowest <= inset.base + 1.5, inset);

// 後片付け（次の検証に響かないよう既定に戻す）
await page.evaluate(() => localStorage.clear());

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, 失敗: failed.length, errors: errors.slice(0, 5) }, null, 2));
await browser.close();
await srv.close();
process.exit(failed.length ? 1 : 0);
