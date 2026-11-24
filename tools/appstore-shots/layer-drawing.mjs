// App Store 撮影用の見本の図面「見本（事務所の電気設備図）.jww」を作る（05「図面から、レイヤを見つける。」用）。
// 建築・電気設備・空調設備のレイヤが混ざった、縮尺 1/100 の小さな事務所の平面図。実際の図面・取引先の図面は使わない。
// アプリには入れない（撮影用ビルドの dist にだけ写す）。node tools/appstore-shots/layer-drawing.mjs で作り直す
import { writeFileSync } from 'node:fs';
import { makeJww } from './jww-synth-ja.mjs';

const S = 100; // 縮尺の分母。実寸 mm ÷ S = 図面の mm
const p = (mm) => mm / S;
const X = [0, 3600, 7200, 9000, 10800];
const Y = [0, 3000, 6600];
const XM = X[X.length - 1], YM = Y[Y.length - 1];

// レイヤ：[グループ, レイヤ]
const L = {
  grid: [0, 0], wall: [0, 1], column: [0, 2], door: [0, 3], room: [0, 4], dim: [0, 5],
  light: [1, 0], outlet: [1, 1], sw: [1, 2], wire: [1, 3], panel: [1, 4],
  ac: [2, 0], duct: [2, 1],
};
const groupNames = ['建築', '電気設備', '空調設備'];
const layerNames = {};
const names = {
  grid: '通り芯', wall: '壁', column: '柱', door: '建具', room: '室名', dim: '寸法',
  light: '照明器具', outlet: 'コンセント', sw: 'スイッチ', wire: '配線', panel: '分電盤',
  ac: 'エアコン', duct: '冷媒管',
};
for (const [k, [g, l]] of Object.entries(L)) layerNames[g * 16 + l] = names[k];

// 線色（画面の色、0xBBGGRR）。黄色はレイヤ選択の強調と紛れるので使わない
const rgb = (r, g, b) => (b << 16) | (g << 8) | r;
const penRgb = [
  rgb(0, 0, 0),
  rgb(205, 210, 220), // 1 壁・建具・寸法（明るい灰色）
  rgb(235, 90, 90),   // 2 通り芯（赤）
  rgb(90, 215, 130),  // 3 配線（緑）
  rgb(120, 175, 255), // 4 照明器具（青）
  rgb(235, 120, 220), // 5 コンセント・スイッチ（桃）
  rgb(95, 215, 230),  // 6 空調（水色）
  rgb(160, 165, 175), // 7 柱・室名（灰色）
  rgb(255, 160, 80),  // 8 分電盤（だいだい）
  rgb(255, 255, 255),
];

const ents = [];
const line = (layer, x1, y1, x2, y2, color = 1, style = 1) => ents.push({ line: [p(x1), p(y1), p(x2), p(y2)], layer, color, style });
const rect = (layer, x1, y1, x2, y2, color = 1, style = 1) => {
  line(layer, x1, y1, x2, y1, color, style); line(layer, x2, y1, x2, y2, color, style);
  line(layer, x2, y2, x1, y2, color, style); line(layer, x1, y2, x1, y1, color, style);
};
const circle = (layer, cx, cy, r, color = 1, start = 0, sweep = 360) => ents.push({ arc: [p(cx), p(cy), p(r), start, sweep], layer, color });
const text = (layer, s, x, y, size, color = 7) => ents.push({ text: s, at: [p(x), p(y)], angle: 0, size, layer, color });

// ---- 建築 ----
// 通り芯（一点鎖線・赤）
for (const x of [X[0], X[2], X[4]]) line(L.grid, x, -1800, x, YM + 1200, 2, 4);
for (const y of Y) line(L.grid, -1200, y, XM + 1200, y, 2, 4);

// 外壁（厚さ 150）。建具の所は開ける
const T = 75;
const wallH = (y, x1, x2, gaps = []) => {
  const xs = [x1, ...gaps.flat(), x2];
  for (let i = 0; i < xs.length; i += 2) for (const d of [-T, T]) line(L.wall, xs[i], y + d, xs[i + 1], y + d);
  for (const [a, b] of gaps) for (const x of [a, b]) line(L.wall, x, y - T, x, y + T);
};
const wallV = (x, y1, y2, gaps = []) => {
  const ys = [y1, ...gaps.flat(), y2];
  for (let i = 0; i < ys.length; i += 2) for (const d of [-T, T]) line(L.wall, x + d, ys[i], x + d, ys[i + 1]);
  for (const [a, b] of gaps) for (const y of [a, b]) line(L.wall, x - T, y, x + T, y);
};
// 窓（下の壁）と出入口（左の壁）
const winB = [[900, 2700], [4500, 6300], [7800, 8700]];
const winT = [[900, 2700], [4500, 6300], [8100, 10200]];
wallH(Y[0] - T, -T * 2, XM + T * 2, winB);
wallH(YM + T, -T * 2, XM + T * 2, winT);
wallV(X[0] - T, -T * 2, YM + T * 2, [[3900, 4800]]);
wallV(XM + T, -T * 2, YM + T * 2);
// 間仕切り
wallV(X[2], 0, YM, [[1000, 1800], [4400, 5200]]);
wallH(Y[1], X[2], XM, [[9500, 10300]]);
wallV(X[3], 0, Y[1]);
// 窓（3 本線）
for (const [a, b] of winB) for (const d of [-T, 0, T]) line(L.door, a, Y[0] - T + d, b, Y[0] - T + d);
for (const [a, b] of winT) for (const d of [-T, 0, T]) line(L.door, a, YM + T + d, b, YM + T + d);
// 扉（開き戸：扉の線と、開く軌跡の円弧）
const doorV = (x, y1, y2, dir) => { // dir=+1 で右へ開く
  line(L.door, x, y1, x + dir * (y2 - y1), y1);
  circle(L.door, x, y1, y2 - y1, 1, dir > 0 ? 0 : 90, 90);
};
doorV(X[0] - T, 3900, 4800, 1);
doorV(X[2], 1000, 1800, 1);
doorV(X[2], 4400, 5200, 1);
line(L.door, 9500, Y[1], 9500, Y[1] - 800); circle(L.door, 9500, Y[1], 800, 1, 270, 90);
// 柱（450 角）
for (const x of [X[0], X[2], X[4]]) for (const y of [Y[0], Y[2]]) {
  const h = 225;
  rect(L.column, x - h, y - h, x + h, y + h, 7);
  ents.push({ solid: [p(x - h), p(y - h), p(x + h), p(y - h), p(x + h), p(y + h), p(x - h), p(y + h)], layer: L.column, color: 7 });
}
// 室名
text(L.room, '事務室', 4300, 2450, 3.5);
text(L.room, '会議室', 8000, 5000, 3.5);
text(L.room, '給湯室', 7400, 2300, 3.0);
text(L.room, '倉庫', 9500, 2300, 3.0);
// 寸法（下：通り芯の間）
const yb = -1100;
for (let i = 0; i + 1 < X.length; i++) {
  ents.push({ dim: [p(X[i]), p(yb), p(X[i + 1]), p(yb)], value: String(X[i + 1] - X[i]), ext: p(900), layer: L.dim });
}
ents.push({ dim: [p(0), p(yb - 600), p(XM), p(yb - 600)], value: String(XM), ext: p(1500), layer: L.dim });

// ---- 電気設備 ----
// 照明器具（円に × のシーリングライト）
const lights = [[1200, 1500], [3600, 1500], [6000, 1500], [1200, 4900], [3600, 4900], [6000, 4900], [9000, 4200], [9000, 5700], [8100, 1500], [9900, 1500]];
for (const [x, y] of lights) {
  circle(L.light, x, y, 260, 4);
  const d = 184;
  line(L.light, x - d, y - d, x + d, y + d, 4); line(L.light, x - d, y + d, x + d, y - d, 4);
}
// 配線（照明どうしと、スイッチへ）
const wire = (pts) => { for (let i = 0; i + 1 < pts.length; i++) line(L.wire, ...pts[i], ...pts[i + 1], 3); };
wire([[1460, 1500], [3340, 1500]]); wire([[3860, 1500], [5740, 1500]]);
wire([[1460, 4900], [3340, 4900]]); wire([[3860, 4900], [5740, 4900]]);
wire([[3600, 1760], [3600, 4640]]);
wire([[6260, 4900], [6800, 4900], [6800, 5500]]); // 事務室のスイッチへ
wire([[9000, 4460], [9000, 5440]]);
wire([[8740, 4200], [7700, 4200], [7700, 4600]]);  // 会議室のスイッチへ
wire([[8360, 1500], [9640, 1500]]);
wire([[1200, 1240], [1200, 700], [500, 700]]);     // 分電盤へ
// スイッチ（黒丸）
for (const [x, y] of [[6800, 5650], [7700, 4750], [600, 4950]]) {
  circle(L.sw, x, y, 150, 5);
  ents.push({ solid: [p(x - 90), p(y - 90), p(x + 90), p(y - 90), p(x + 90), p(y + 90), p(x - 90), p(y + 90)], layer: L.sw, color: 5 });
}
// コンセント（壁ぎわの円と 2 本線）
const outlet = (x, y, vertical) => {
  circle(L.outlet, x, y, 160, 5);
  if (vertical) { line(L.outlet, x - 60, y - 160, x - 60, y - 320, 5); line(L.outlet, x + 60, y - 160, x + 60, y - 320, 5); }
  else { line(L.outlet, x + 160, y - 60, x + 320, y - 60, 5); line(L.outlet, x + 160, y + 60, x + 320, y + 60, 5); }
};
for (const [x, y] of [[1800, 6250], [5400, 6250], [8100, 6250], [10000, 6250]]) outlet(x, y, true);
for (const [x, y] of [[7500, 400], [9400, 400]]) outlet(x, y + 300, true);
for (const [x, y] of [[350, 2400]]) outlet(x, y, false);
// 分電盤（塗りの四角と記号）
rect(L.panel, 150, 300, 450, 1200, 8);
ents.push({ solid: [p(150), p(300), p(450), p(300), p(450), p(1200), p(150), p(1200)], layer: L.panel, color: 8 });
text(L.panel, 'L-1', 600, 650, 2.5, 8);

// ---- 空調設備 ----
const acs = [[2400, 3300], [5600, 3300], [9900, 5000]];
for (const [x, y] of acs) {
  rect(L.ac, x - 450, y - 450, x + 450, y + 450, 6);
  rect(L.ac, x - 250, y - 250, x + 250, y + 250, 6);
}
const duct = (pts) => { for (let i = 0; i + 1 < pts.length; i++) line(L.duct, ...pts[i], ...pts[i + 1], 6, 2); };
duct([[2850, 3300], [5150, 3300]]); duct([[6050, 3300], [7200, 3300], [7200, 2700], [XM, 2700]]);
duct([[10350, 5000], [10600, 5000], [10600, 2700]]);

const bytes = makeJww({ entities: ents, scale: S, layerNames, groupNames, penRgb });
const out = new URL('./layer-drawing.jww', import.meta.url);
writeFileSync(out, bytes);
console.log(`${out.pathname}: ${bytes.length} bytes, ${ents.length} entities`);
