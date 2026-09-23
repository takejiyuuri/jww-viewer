// 属性の取得とレイヤの表示状態を、サンプル図面の全図形で確かめる。
// - 図形と線分・三角形・文字の対応が食い違っていないか（レイヤ・色まで一致するか）
// - すべての図形で属性の説明とハイライトの形が作れるか
// - タップで拾う図形が、総当たりで求めた答えと一致するか（見えていない図形を拾わないか）
// - レイヤの表示状態（Jw_cad の状態・このレイヤだけ・元に戻す・保存形式）が正しく往復するか
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseJww } from '../src/jww/parser.ts';
import { buildScene, KIND } from '../src/render/geometry.ts';
import type { Scene } from '../src/render/geometry.ts';
import { buildInfo } from '../src/jww/info.ts';
import { SnapIndex } from '../src/measure/snap.ts';
import { describeEntity, entityShape, pickEntity, textContains } from '../src/ui/inspect.ts';
import { LayerVisibility } from '../src/ui/layers.ts';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('使い方: node tools/verify-inspect.ts samples/*.jww');
  process.exit(1);
}

let failures = 0;
const fail = (msg: string, detail?: unknown): void => {
  failures++;
  if (failures <= 30) console.log(`  NG ${msg}`, detail ?? '');
};

/** 再現できる乱数 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function segDist(pos: Float32Array, i: number, x: number, y: number): number {
  const ax = pos[i * 4], ay = pos[i * 4 + 1];
  const bx = pos[i * 4 + 2], by = pos[i * 4 + 3];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + dx * t - x, ay + dy * t - y);
}

/** 図形の線分のうち、点にいちばん近いものまでの距離 */
function entityDist(scene: Scene, e: number, x: number, y: number): number {
  const s = scene.entities.lineStart[e];
  const n = scene.entities.lineCount[e];
  let best = Infinity;
  for (let j = s; j < s + n; j++) best = Math.min(best, segDist(scene.linePos, j, x, y));
  return best;
}

function inTri(px: number, py: number, t: Float32Array, i: number): boolean {
  const [ax, ay, bx, by, cx, cy] = [t[i * 6], t[i * 6 + 1], t[i * 6 + 2], t[i * 6 + 3], t[i * 6 + 4], t[i * 6 + 5]];
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

type Branch = 'line-near' | 'text' | 'line' | 'point' | 'tri' | 'none';

/** pickEntity と同じ優先順位を、索引を使わずに総当たりで求める */
function brute(
  scene: Scene, x: number, y: number, r: number,
  visible: (color: number, layer: number) => boolean,
): { branch: Branch; entity: number; dist: number } {
  const pos = scene.linePos;
  let bestLine = -1;
  let bestD = Infinity;
  for (let i = 0; i < pos.length / 4; i++) {
    if (!visible(scene.lineColor[i], scene.lineLayer[i])) continue;
    const d = segDist(pos, i, x, y);
    if (d <= r && d < bestD) { bestD = d; bestLine = i; }
  }
  if (bestLine >= 0 && bestD <= r * 0.35) return { branch: 'line-near', entity: scene.lineEntity[bestLine], dist: bestD };

  let textHit = -1;
  let area = Infinity;
  for (let i = 0; i < scene.texts.length; i++) {
    const t = scene.texts[i];
    if (!visible(t.color, t.layer)) continue;
    if (!textContains(t, x, y, r * 0.15)) continue;
    const a = t.width * t.height;
    if (a < area) { area = a; textHit = i; }
  }
  if (textHit >= 0) return { branch: 'text', entity: scene.texts[textHit].entity, dist: area };
  if (bestLine >= 0) return { branch: 'line', entity: scene.lineEntity[bestLine], dist: bestD };

  const pts = scene.snapPoint;
  let bestP = -1;
  let bestPD = (r * 0.6) ** 2;
  for (let i = 0; i < pts.length / 2; i++) {
    if (!visible(scene.snapPointColor[i], scene.snapPointLayer[i])) continue;
    const d = (pts[i * 2] - x) ** 2 + (pts[i * 2 + 1] - y) ** 2;
    if (d <= bestPD) { bestPD = d; bestP = i; }
  }
  if (bestP >= 0) return { branch: 'point', entity: scene.snapPointEntity[bestP], dist: Math.sqrt(bestPD) };

  const tri = scene.triPos;
  for (let i = tri.length / 6 - 1; i >= 0; i--) {
    if (!visible(scene.triColor[i * 3], scene.triLayer[i * 3])) continue;
    if (inTri(x, y, tri, i)) return { branch: 'tri', entity: scene.triEntity[i], dist: 0 };
  }
  return { branch: 'none', entity: -1, dist: Infinity };
}

for (const file of files) {
  const t0 = performance.now();
  const buf = readFileSync(file);
  const doc = parseJww(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const scene = buildScene(doc);
  const info = buildInfo(doc, scene, path.basename(file), 0);
  const e = scene.entities;
  console.log(`\n${path.basename(file)}  図形 ${e.count.toLocaleString()}  線分 ${(scene.linePos.length / 4).toLocaleString()}`);
  const before = failures;

  // ---------- 1. 図形と描画データの対応 ----------
  const lineOwner = new Int32Array(scene.linePos.length / 4).fill(-1);
  let mismatch = 0;
  for (let i = 0; i < e.count; i++) {
    for (let j = e.lineStart[i]; j < e.lineStart[i] + e.lineCount[i]; j++) {
      lineOwner[j] = i;
      if (scene.lineEntity[j] !== i || scene.lineLayer[j] !== e.layer[i] || scene.lineColor[j] !== e.color[i]) mismatch++;
    }
    for (let j = e.triStart[i]; j < e.triStart[i] + e.triCount[i]; j++) {
      if (scene.triEntity[j] !== i || scene.triLayer[j * 3] !== e.layer[i] || scene.triColor[j * 3] !== e.color[i]) mismatch++;
    }
    const kind = e.kind[i];
    if (kind === KIND.text || kind === KIND.dimText) {
      const t = scene.texts[e.text[i]];
      if (!t || t.entity !== i || t.layer !== e.layer[i] || t.color !== e.color[i]) mismatch++;
    }
  }
  const orphan = lineOwner.filter((o) => o < 0).length;
  if (mismatch) fail('図形と描画データのレイヤ・色・持ち主が食い違う', { mismatch });
  if (orphan) fail('どの図形にも属さない線分がある', { orphan });
  for (let i = 0; i < scene.texts.length; i++) {
    const owner = scene.texts[i].entity;
    if (owner < 0 || owner >= e.count || e.text[owner] !== i) { fail('文字の持ち主が食い違う', { i, owner }); break; }
  }
  const layerCount = new Uint32Array(256);
  for (let i = 0; i < e.count; i++) layerCount[e.layer[i]]++;
  if (layerCount.some((n, k) => n !== scene.layerCounts[k])) fail('レイヤごとの図形数が合わない');

  // ---------- 2. すべての図形で属性とハイライトを作る ----------
  const kinds = new Map<string, number>();
  let emptyShape = 0;
  for (let i = 0; i < e.count; i++) {
    let d;
    try {
      d = describeEntity(scene, info, i, () => '--ink:#fff');
    } catch (err) {
      fail('属性の説明で例外', { i, err: (err as Error).message });
      continue;
    }
    kinds.set(d.kind, (kinds.get(d.kind) ?? 0) + 1);
    const html = d.rows.map((r) => r.html).join('');
    if (d.kind === '図形' || d.rows.length < 2 || d.rows[0].label !== 'レイヤ' || /undefined|NaN|Infinity/.test(html)) {
      fail('属性の説明がおかしい', { i, d });
    }
    const s = entityShape(scene, i);
    if (s.lines.length === 0 && s.tris.length === 0 && !s.box && !s.point) emptyShape++;
  }
  if (emptyShape) fail('ハイライトの形が空の図形がある', { emptyShape });
  console.log('  種類:', Object.fromEntries(kinds));

  // ---------- 2b. 寸法は寸法値と同じ縮尺で実寸になる ----------
  let dimChecked = 0;
  let dimHit = 0;
  let dimGroupSplit = 0;
  for (let i = 0; i < e.count; i++) {
    const kind = e.kind[i];
    if (kind !== KIND.dim && kind !== KIND.dimAux && kind !== KIND.dimText) continue;
    const ti = e.text[i];
    if (ti >= 0 && e.group[scene.texts[ti].entity] !== e.group[i]) dimGroupSplit++;
    if (kind !== KIND.dim || ti < 0) continue;
    const m = /^([0-9]+(?:\.[0-9]+)?)$/.exec(scene.texts[ti].text.replace(/[,\s]/g, ''));
    if (!m || !(Number(m[1]) > 0)) continue;
    const value = Number(m[1]);
    const real = e.size[i] * (scene.scales[e.group[i]] || 1);
    dimChecked++;
    if (Math.abs(real - value) / value < 0.01) dimHit++;
  }
  if (dimGroupSplit) fail('同じ寸法の部材で縮尺のグループが違う', { dimGroupSplit });
  if (dimHit !== dimChecked) fail('寸法線の実寸が寸法値と合わない', { dimHit, dimChecked });
  console.log(`  寸法線の実寸と寸法値: ${dimHit}/${dimChecked} 一致`);

  // ---------- 2c. 円弧の長さは弦の和より長く、楕円の径は長いほうが先 ----------
  let arcBad = 0;
  let ellipses = 0;
  for (let i = 0; i < e.count; i++) {
    if (e.kind[i] !== KIND.arc && e.kind[i] !== KIND.circle) continue;
    if (e.size2[i] > e.size[i] * (1 + 1e-6) || !(e.size2[i] >= 0)) arcBad++;
    if (Math.abs(e.size[i] - e.size2[i]) > e.size[i] * 1e-6) ellipses++;
    if (e.kind[i] !== KIND.arc) continue;
    let chords = 0;
    for (let j = e.lineStart[i]; j < e.lineStart[i] + e.lineCount[i]; j++) {
      chords += Math.hypot(scene.linePos[j * 4 + 2] - scene.linePos[j * 4], scene.linePos[j * 4 + 3] - scene.linePos[j * 4 + 1]);
    }
    // 弦の和は実際の弧より短い。いちばん粗い 4 分割の全周でも弧は弦の和の 1.11 倍まで。
    // 座標は float32 なので、ごく小さな円弧では弦の和のほうが丸めでわずかに長く出ることがある
    if (e.length[i] < chords - 1e-3 || e.length[i] > chords * 1.12 + 1e-3) arcBad++;
  }
  if (arcBad) fail('円弧の長さか径がおかしい', { arcBad });
  console.log(`  円・円弧の長さと径: 異常 ${arcBad} ／ 楕円 ${ellipses}`);

  // ---------- 3. タップで拾う図形を総当たりと突き合わせる ----------
  const index = new SnapIndex(scene);
  const layers = new LayerVisibility();
  const b = scene.fitBounds;
  const random = rng(20260923);
  const n = scene.linePos.length / 4;

  const states: { name: string; setup: () => { color: Uint8Array; layer: Uint8Array } }[] = [
    {
      name: 'すべて表示',
      setup: () => {
        layers.showAll();
        return { color: new Uint8Array(scene.colorGroup.length).fill(1), layer: layers.mask() };
      },
    },
    {
      name: 'Jw_cad の状態',
      setup: () => {
        layers.resetToJw(info.groups, info.writeGroup);
        return { color: new Uint8Array(scene.colorGroup.length).fill(1), layer: layers.mask() };
      },
    },
    {
      name: '色とレイヤを無作為に隠す',
      setup: () => {
        layers.showAll();
        for (let k = 0; k < 256; k++) if (random() < 0.3) layers.layer[k] = false;
        for (let g = 0; g < 16; g++) if (random() < 0.1) layers.group[g] = false;
        const color = new Uint8Array(scene.colorGroup.length);
        const hiddenGroups = new Set<number>();
        scene.groups.forEach((_, gi) => { if (random() < 0.25) hiddenGroups.add(gi); });
        for (let c = 0; c < color.length; c++) color[c] = hiddenGroups.has(scene.colorGroup[c]) ? 0 : 1;
        return { color, layer: layers.mask() };
      },
    },
  ];

  for (const st of states) {
    const { color, layer } = st.setup();
    index.setVisibleColors(color);
    index.setVisibleLayers(layer);
    const visible = (c: number, l: number): boolean => color[c] === 1 && layer[l] === 1;

    const taps: { x: number; y: number }[] = [];
    // 線の上（中点）、文字の中、図面の中の無作為な点
    for (let k = 0; k < 500; k++) {
      const i = Math.floor(random() * n);
      taps.push({ x: (scene.linePos[i * 4] + scene.linePos[i * 4 + 2]) / 2, y: (scene.linePos[i * 4 + 1] + scene.linePos[i * 4 + 3]) / 2 });
    }
    for (let k = 0; k < 200 && scene.texts.length; k++) {
      const t = scene.texts[Math.floor(random() * scene.texts.length)];
      const a = (t.angle * Math.PI) / 180;
      const u = t.width / 2, v = t.height / 2;
      taps.push({ x: t.x + u * Math.cos(a) - v * Math.sin(a), y: t.y + u * Math.sin(a) + v * Math.cos(a) });
    }
    for (let k = 0; k < 500; k++) {
      taps.push({ x: b.minX + random() * (b.maxX - b.minX), y: b.minY + random() * (b.maxY - b.minY) });
    }

    let agree = 0;
    let checked = 0;
    const branches = new Map<Branch, number>();
    for (const { x, y } of taps) {
      for (const r of [0.4, 2, 8]) {
        checked++;
        const got = pickEntity(scene, index, x, y, r, visible);
        const want = brute(scene, x, y, r, visible);
        branches.set(want.branch, (branches.get(want.branch) ?? 0) + 1);
        if (got >= 0 && !visible(e.color[got], e.layer[got])) {
          fail(`[${st.name}] 見えていない図形を拾った`, { x, y, r, got });
          continue;
        }
        let ok = got === want.entity;
        // 同じ距離の線が重なっているときは、どちらを拾っても正しい
        if (!ok && got >= 0 && (want.branch === 'line-near' || want.branch === 'line')) {
          ok = Math.abs(entityDist(scene, got, x, y) - want.dist) <= 1e-9 + want.dist * 1e-9;
        }
        // 同じ場所の点が重なっているときも同様
        if (!ok && got >= 0 && want.branch === 'point' && e.kind[got] === KIND.point) ok = true;
        if (ok) agree++;
        else fail(`[${st.name}] 拾った図形が総当たりと違う`, { x, y, r, got, want, gotKind: got >= 0 ? e.kind[got] : null });
      }
    }
    console.log(`  ${st.name}: ${agree}/${checked} 一致`, Object.fromEntries(branches));
  }

  // ---------- 4. レイヤの表示状態 ----------
  layers.resetToJw(info.groups, info.writeGroup);
  let jwHidden = 0;
  for (let g = 0; g < 16; g++) {
    for (let l = 0; l < 16; l++) {
      const k = (g << 4) | l;
      const gi = info.groups[g];
      const isWrite = g === info.writeGroup && l === gi.writeLayer;
      const expect = isWrite || ((gi.state !== 0 || g === info.writeGroup) && gi.layers[l].state !== 0);
      if (layers.visible(k) !== expect) fail('Jw_cad の状態と表示が違う', { k, expect });
      if (!expect && scene.layerCounts[k] > 0) jwHidden++;
    }
  }
  if (!layers.visible((info.writeGroup << 4) | info.groups[info.writeGroup].writeLayer)) fail('書込レイヤが隠れている');
  if (layers.hiddenCount(scene.layerCounts) !== jwHidden) fail('隠れているレイヤ数が合わない');

  const snap = layers.snapshot();
  const saved = layers.hidden();
  const target = scene.layerCounts.findIndex((c) => c > 0);
  layers.only(target);
  for (let k = 0; k < 256; k++) if (layers.visible(k) !== (k === target)) { fail('このレイヤだけ表示が効かない', { k }); break; }
  layers.restore(snap);
  const back = layers.hidden();
  if (JSON.stringify(back) !== JSON.stringify(saved)) fail('元に戻すで戻らない');
  const other = new LayerVisibility();
  other.applyHidden(JSON.parse(JSON.stringify(saved)));
  if (JSON.stringify([...other.mask()]) !== JSON.stringify([...layers.mask()])) fail('保存形式から戻らない');

  const jwStates = info.groups.flatMap((g) => g.layers.map((l) => l.state));
  console.log(`  Jw_cad で隠れているレイヤ（図形あり）: ${jwHidden}  状態の内訳:`,
    Object.fromEntries([0, 1, 2, 3].map((s) => [s, jwStates.filter((x) => x === s).length])));
  console.log(`  ${failures === before ? 'OK' : 'NG'}  ${Math.round(performance.now() - t0)} ms`);
}

// ---------- 5. Jw_cad の状態の読み方を、答えを決め打ちした合成データで確かめる ----------
{
  const before = failures;
  const layer = (no: number, state: number) => ({ no, name: '', state });
  const group = (no: number, state: number, writeLayer: number, states: number[]) => ({
    no, scale: 1, name: '', used: true, state, writeLayer, layers: states.map((st, j) => layer(j, st)),
  });
  const all2 = new Array<number>(16).fill(2);
  const groups = [
    // 0: 書込グループ。グループ自体は非表示だが書込なので見える。書込レイヤ 3 は状態 0 でも見える、レイヤ 5 は隠れる
    group(0, 0, 3, all2.map((v, j) => (j === 3 || j === 5 ? 0 : v))),
    // 1: 非表示のグループ。中のレイヤが編集可でも全部隠れる
    group(1, 0, 0, all2),
    // 2: 表示のみのグループ。レイヤ 7 だけ非表示
    group(2, 1, 0, all2.map((v, j) => (j === 7 ? 0 : v))),
    // 3: レイヤが 4 つしかない（足りない分は見える扱い）。レイヤ 0 は非表示
    group(3, 2, 0, [0, 1, 2, 3]),
  ];
  // 4〜15 は情報がない（見える扱い）
  const lv = new LayerVisibility();
  lv.resetToJw(groups, 0);
  const expectHidden = new Set<number>([0x05, ...Array.from({ length: 16 }, (_, l) => 0x10 | l), 0x27, 0x30]);
  for (let k = 0; k < 256; k++) {
    if (lv.visible(k) === expectHidden.has(k)) fail('合成データで Jw_cad の状態の読み方が違う', { k: k.toString(16), visible: lv.visible(k) });
  }
  // このレイヤだけ → ほかのグループを戻すと、そのグループの中の設定は残っている
  lv.showAll();
  lv.layer[0x25] = false;
  lv.only(0x13);
  let others = 0;
  for (let k = 0; k < 256; k++) if (lv.visible(k) && k !== 0x13) others++;
  if (others) fail('このレイヤだけ表示で、ほかのレイヤが見えている', { others });
  lv.group[2] = true;
  let shown2 = 0;
  for (let l = 0; l < 16; l++) if (lv.visible(0x20 | l)) shown2++;
  if (shown2 !== 15) fail('このレイヤだけ表示のあと、別のグループを戻しても中身が戻らない', { shown2 });
  console.log(`\n合成データ（Jw_cad の状態・このレイヤだけ）: ${failures === before ? 'OK' : 'NG'}`);
}

console.log(failures ? `\n失敗 ${failures} 件` : '\nすべて合格');
process.exit(failures ? 1 : 0);
