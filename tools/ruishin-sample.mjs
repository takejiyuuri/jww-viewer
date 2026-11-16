// 累進寸法の見本の図面（public/ruishin-sample.jww）を作る。縮尺 1/100 の簡単な平面図で、
// 通り芯・壁・柱と、寸法図形の連続寸法（下・左）・全体寸法、寸法図形にしていない連続寸法（上：線と数字）を持つ。
// 実務の図面は使わない。node tools/ruishin-sample.mjs で作り直す
import { writeFileSync } from 'node:fs';
import { makeJww } from './jww-synth.mjs';

const S = 100; // 縮尺の分母。実寸 mm ÷ S = 図面の mm
const X = [0, 1820, 3640, 4550, 6370, 8190];
const Y = [0, 1820, 2730, 4550, 6370];
const p = (mm) => mm / S;

const entities = [];
const line = (x1, y1, x2, y2, color = 1, style = 1) => entities.push({ line: [p(x1), p(y1), p(x2), p(y2)], color, style });

// 通り芯（一点鎖線・赤）。寸法の列の外まで延ばす
for (const x of X) line(x, -2600, x, Y[Y.length - 1] + 2600, 2, 4);
for (const y of Y) line(-2600, y, X[X.length - 1] + 2600, y, 2, 4);

// 外壁（厚さ 150 を芯の両側に）
const W = 75;
const xmax = X[X.length - 1], ymax = Y[Y.length - 1];
for (const d of [-W, W]) {
  line(-d, -d, xmax + d, -d, 1);
  line(xmax + d, -d, xmax + d, ymax + d, 1);
  line(xmax + d, ymax + d, -d, ymax + d, 1);
  line(-d, ymax + d, -d, -d, 1);
}
// 間仕切り
for (const d of [-50, 50]) {
  line(X[2] + d, 0, X[2] + d, Y[3], 1);
  line(0, Y[2] + d, X[2], Y[2] + d, 1);
  line(X[4] + d, Y[1], X[4] + d, ymax, 1);
}
// 柱（300 角）
for (const x of [X[0], X[2], X[5]]) {
  for (const y of [Y[0], Y[4]]) {
    const h = 150;
    line(x - h, y - h, x + h, y - h, 3); line(x + h, y - h, x + h, y + h, 3);
    line(x + h, y + h, x - h, y + h, 3); line(x - h, y + h, x - h, y - h, 3);
  }
}

// 下：寸法図形の連続寸法と全体寸法
const yb = -1300;
for (let i = 0; i + 1 < X.length; i++) {
  entities.push({ dim: [p(X[i]), p(yb), p(X[i + 1]), p(yb)], value: String(X[i + 1] - X[i]), ext: p(1100) });
}
entities.push({ dim: [p(0), p(yb - 700), p(xmax), p(yb - 700)], value: String(xmax), ext: p(1800) });

// 左：寸法図形の縦の連続寸法（値は 90° 回して書く）
const xl = -1300;
for (let i = 0; i + 1 < Y.length; i++) {
  entities.push({ dim: [p(xl), p(Y[i]), p(xl), p(Y[i + 1])], value: String(Y[i + 1] - Y[i]), ext: p(1100) });
}

// 上：寸法図形にしていない連続寸法（寸法線・引出線と、線の上の数字。カンマ付き）
const yt = ymax + 1300;
for (let i = 0; i + 1 < X.length; i++) {
  line(X[i], yt, X[i + 1], yt, 1);
  const v = (X[i + 1] - X[i]).toLocaleString('en-US');
  const size = 2.5;
  const w = v.length * size * 0.8;
  entities.push({ text: v, at: [p((X[i] + X[i + 1]) / 2) - w / 2, p(yt) + 0.6], angle: 0, size });
}
for (const x of X) line(x, yt - 300, x, yt + 300, 1);

// 部屋名
entities.push({ text: 'LDK', at: [p(5000), p(3200)], angle: 0, size: 3.5, color: 1 });
entities.push({ text: 'BR', at: [p(600), p(3500)], angle: 0, size: 3.5, color: 1 });

const bytes = makeJww({ entities, scale: S });
const out = new URL('../public/ruishin-sample.jww', import.meta.url);
writeFileSync(out, bytes);
console.log(`${out.pathname}: ${bytes.length} bytes`);
