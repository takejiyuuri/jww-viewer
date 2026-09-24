// 属性の取得とレイヤの表示状態を、サンプル図面の全図形で確かめる。
// - 図形と線分・三角形・文字の対応が食い違っていないか（レイヤ・色まで一致するか）
// - すべての図形で属性の説明とハイライトの形が作れるか
// - タップで拾う図形が、総当たりで求めた答えと一致するか（見えていない図形を拾わないか）
// - レイヤの表示状態（Jw_cad の状態・このレイヤだけ・元に戻す・保存形式）が正しく往復するか
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseJww } from '../src/jww/parser.ts';
import { buildScene, fitRange, fitScene, KIND, paperRect } from '../src/render/geometry.ts';
import type { Scene } from '../src/render/geometry.ts';
import { buildInfo } from '../src/jww/info.ts';
import { SnapIndex } from '../src/measure/snap.ts';
import { describeEntity, entityShape, pickEntity, textContains } from '../src/ui/inspect.ts';
import { LayerVisibility } from '../src/ui/layers.ts';
import { versionWarning } from '../src/jww/header.ts';

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

  // ---------- 3b. 「全体」の範囲：用紙をはみ出して続く図面は切らず、離れた点だけなら用紙に合わせる ----------
  {
    const paper = paperRect(doc.header.paperSize);
    const fb = scene.fitBounds;
    if (paper) {
      const inP = (x: number, y: number): boolean => x >= paper.minX && x <= paper.maxX && y >= paper.minY && y <= paper.maxY;
      const cross = { left: 0, right: 0, top: 0, bottom: 0 };
      // 辺ごとの、またいだ線分の外側の端
      const outer: Record<string, number[]> = { left: [], right: [], top: [], bottom: [] };
      let insideSeg = 0;
      let touching = 0;
      const pos = scene.linePos;
      const segs = pos.length / 4;
      for (let i = 0; i < segs; i++) {
        const a = inP(pos[i * 4], pos[i * 4 + 1]);
        const b = inP(pos[i * 4 + 2], pos[i * 4 + 3]);
        if (a && b) insideSeg++;
        if (a === b) continue;
        touching++;
        const ox = a ? pos[i * 4 + 2] : pos[i * 4];
        const oy = a ? pos[i * 4 + 3] : pos[i * 4 + 1];
        if (ox > paper.maxX) { cross.right++; outer.right.push(ox); }
        else if (ox < paper.minX) { cross.left++; outer.left.push(ox); }
        else if (oy > paper.maxY) { cross.top++; outer.top.push(oy); }
        else { cross.bottom++; outer.bottom.push(oy); }
      }
      // 用紙をはみ出して続く線分の外側の端は、9 割 5 分以上が「全体」に入る
      const covered = (list: number[], ok: (v: number) => boolean): number =>
        list.length ? list.filter(ok).length / list.length : 1;
      const cover = {
        right: covered(outer.right, (v) => v <= fb.maxX + 1e-6),
        left: covered(outer.left, (v) => v >= fb.minX - 1e-6),
        top: covered(outer.top, (v) => v <= fb.maxY + 1e-6),
        bottom: covered(outer.bottom, (v) => v >= fb.minY - 1e-6),
      };
      const short = Object.entries(cover).filter(([k, v]) => (cross as Record<string, number>)[k] >= 10 && v < 0.95);
      if (short.length) fail('用紙をはみ出して続く図形の外側が「全体」に入りきらない', { cover, cross });
      // 用紙の辺をまたいで続く図形が 10 本以上ある辺は、用紙の外まで見せる
      const cut: string[] = [];
      if (cross.right >= 10 && !(fb.maxX > paper.maxX)) cut.push('右');
      if (cross.left >= 10 && !(fb.minX < paper.minX)) cut.push('左');
      if (cross.top >= 10 && !(fb.maxY > paper.maxY)) cut.push('上');
      if (cross.bottom >= 10 && !(fb.minY < paper.minY)) cut.push('下');
      if (cut.length) fail('用紙をはみ出して続く図面が「全体」で切れる', { cut, cross, fb });
      // 用紙の辺をまたぐ図形がなく、線分の 9 割以上が用紙の中で、図面本体が用紙のほぼ全体（幅も高さも 85% 以上）に
      // 広がっているなら、用紙の枠そのものに合わせる
      // 図面本体の大きさは、用紙内の線分の端点の上下 1% を除いた範囲で測る（散らばった点に引きずられないように）
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < segs; i++) {
        for (const j of [0, 2]) {
          const x = pos[i * 4 + j], y = pos[i * 4 + j + 1];
          if (inP(x, y)) { xs.push(x); ys.push(y); }
        }
      }
      xs.sort((a, b) => a - b);
      ys.sort((a, b) => a - b);
      const q = (arr: number[], t: number): number => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * t)))] ?? 0;
      const fillW = (q(xs, 0.99) - q(xs, 0.01)) / (paper.maxX - paper.minX);
      const fillH = (q(ys, 0.99) - q(ys, 0.01)) / (paper.maxY - paper.minY);
      const tight = touching === 0 && insideSeg >= segs * 0.9 && Math.min(fillW, fillH) >= 0.85;
      const isPaper = Math.abs(fb.minX - paper.minX) < 1e-6 && Math.abs(fb.maxX - paper.maxX) < 1e-6
        && Math.abs(fb.minY - paper.minY) < 1e-6 && Math.abs(fb.maxY - paper.maxY) < 1e-6;
      if (tight && !isPaper) fail('用紙に収まる図面なのに「全体」が用紙の枠に合っていない', { fb, paper });
      console.log(`  全体の範囲: 用紙をまたぐ線分 ${JSON.stringify(cross)} ／ ${isPaper ? '用紙に合わせる' : '図形の範囲に合わせる'}`);
    } else {
      console.log('  全体の範囲: 用紙の大きさが分からないので図形の範囲に合わせる');
    }
  }

  // ---------- 3c. 1 つのレイヤだけ見せたときの「全体」は、そのレイヤの図形に合い、隠した図形に引きずられない ----------
  {
    const paper = paperRect(doc.header.paperSize);
    const layersWithContent = [...scene.layerCounts.keys()].filter((k) => scene.layerCounts[k] > 0);
    let checked = 0;
    let bad = 0;
    for (const k of layersWithContent) {
      const fb = fitScene(scene, (_c, l) => l === k);
      // そのレイヤの図形ごとの代表点（線・円弧は始点、文字は基点、点はその位置）
      const pointAt = new Map<number, [number, number]>();
      for (let i = 0; i < scene.snapPoint.length / 2; i++) pointAt.set(scene.snapPointEntity[i], [scene.snapPoint[i * 2], scene.snapPoint[i * 2 + 1]]);
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < e.count; i++) {
        if (e.layer[i] !== k) continue;
        if (e.lineCount[i] > 0) { xs.push(scene.linePos[e.lineStart[i] * 4]); ys.push(scene.linePos[e.lineStart[i] * 4 + 1]); }
        else if (e.text[i] >= 0) { xs.push(scene.texts[e.text[i]].x); ys.push(scene.texts[e.text[i]].y); }
        else if (e.triCount[i] > 0) { xs.push(scene.triPos[e.triStart[i] * 6]); ys.push(scene.triPos[e.triStart[i] * 6 + 1]); }
        else if (pointAt.has(i)) { const [px, py] = pointAt.get(i)!; xs.push(px); ys.push(py); }
      }
      if (xs.length < 2) continue;
      checked++;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let j = 0; j < xs.length; j++) {
        x0 = Math.min(x0, xs[j]); x1 = Math.max(x1, xs[j]);
        y0 = Math.min(y0, ys[j]); y1 = Math.max(y1, ys[j]);
      }
      // 図形そのものの広がり（線分の両端、文字の四隅）も含める。幅の広い文字は基点から遠くまで伸びる
      for (let i = 0; i < scene.lineLayer.length; i++) {
        if (scene.lineLayer[i] !== k) continue;
        for (const j of [0, 2]) {
          x0 = Math.min(x0, scene.linePos[i * 4 + j]); x1 = Math.max(x1, scene.linePos[i * 4 + j]);
          y0 = Math.min(y0, scene.linePos[i * 4 + j + 1]); y1 = Math.max(y1, scene.linePos[i * 4 + j + 1]);
        }
      }
      for (const t of scene.texts) {
        if (t.layer !== k) continue;
        const a = (t.angle * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a);
        for (const [cx, cy] of [[t.x, t.y], [t.x + ux * t.width, t.y + uy * t.width],
          [t.x + ux * t.width - uy * t.height, t.y + uy * t.width + ux * t.height], [t.x - uy * t.height, t.y + ux * t.height]]) {
          x0 = Math.min(x0, cx); x1 = Math.max(x1, cx);
          y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
        }
      }
      // 隠した図形に引きずられない：そのレイヤの図形と用紙を合わせた範囲（少し余裕を見る）の外へは広がらない
      const ux0 = Math.min(x0, paper?.minX ?? x0), ux1 = Math.max(x1, paper?.maxX ?? x1);
      const uy0 = Math.min(y0, paper?.minY ?? y0), uy1 = Math.max(y1, paper?.maxY ?? y1);
      const slack = Math.max(ux1 - ux0, uy1 - uy0) * 0.05 + 1;
      const within = fb.minX >= ux0 - slack && fb.maxX <= ux1 + slack && fb.minY >= uy0 - slack && fb.maxY <= uy1 + slack;
      // そのレイヤの図形の大部分（8 割以上）は入る。用紙の外に離れて残った小さなまとまりは外れてよい
      let covered = 0;
      for (let j = 0; j < xs.length; j++) if (xs[j] >= fb.minX - 1e-6 && xs[j] <= fb.maxX + 1e-6 && ys[j] >= fb.minY - 1e-6 && ys[j] <= fb.maxY + 1e-6) covered++;
      if (!within || covered < xs.length * 0.8) {
        bad++;
        if (bad <= 3) fail('1 つのレイヤだけの「全体」がそのレイヤの図形に合わない', { layer: k.toString(16), fb, content: { x0, x1, y0, y1 }, covered: `${covered}/${xs.length}` });
      }
    }
    console.log(`  1 つのレイヤだけの「全体」: ${checked - bad}/${checked} レイヤで図形に合う`);
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
  // 図形のあるレイヤだけで数える反転：グループの図形のあるレイヤが全部見えていれば、図形のないレイヤが
  // 隠れていてもグループごと隠す（グループのスイッチで戻せるように）。2 回で持ち方まで元どおりでなくても、見え方は戻る
  {
    const counts = new Uint32Array(256);
    counts[0x16] = 5;
    counts[0x18] = 3;
    const v = new LayerVisibility().useCounts(counts);
    for (let l = 0; l < 16; l++) v.layer[0x10 | l] = false;
    v.layer[0x16] = true;
    v.layer[0x18] = true;
    const start = v.snapshot();
    v.invert();
    if (v.group[1] || !v.layer[0x16] || !v.layer[0x18]) fail('図形のあるレイヤが全部見えているグループが、反転でグループごと隠れない', { group: v.group[1] });
    v.group[1] = true;
    if (!v.visible(0x16) || !v.visible(0x18)) fail('反転で隠したグループを、グループのスイッチで戻せない');
    v.group[1] = false;
    v.invert();
    const back = new LayerVisibility().useCounts(counts);
    back.restore(start);
    if (!v.sameAs(back)) fail('図形のあるレイヤで数える反転を 2 回しても見え方が戻らない');
  }

  // 「全体」の範囲を、作った点と線で確かめる（A3 横の用紙）
  {
    const paper = paperRect(3)!;
    const rand = rng(11);
    const all = { minX: -10000, minY: -10000, maxX: 10000, maxY: 10000 };
    type B = { minX: number; maxX: number; minY: number; maxY: number };
    const same = (a: B, b: B): boolean =>
      Math.abs(a.minX - b.minX) < 1e-6 && Math.abs(a.maxX - b.maxX) < 1e-6 && Math.abs(a.minY - b.minY) < 1e-6 && Math.abs(a.maxY - b.maxY) < 1e-6;
    // 用紙の中に図面本体（短い線 3000 本）
    const body: number[] = [];
    for (let i = 0; i < 3000; i++) {
      const x = paper.minX + 5 + rand() * (paper.maxX - paper.minX - 10);
      const y = paper.minY + 5 + rand() * (paper.maxY - paper.minY - 10);
      body.push(x, y, x + rand() * 4, y + rand() * 4);
    }
    const F = (segs: number[], marks: number[] = [], segEnt?: number[]) => {
      const pts = [...segs, ...marks];
      return fitRange({
        pts: Float32Array.from(pts), segs: Float32Array.from(segs), marks: Float32Array.from(marks),
        segEnt: segEnt ? Int32Array.from(segEnt) : undefined,
      }, all, paper);
    };
    const others = (b: B, but: keyof B): boolean =>
      (['minX', 'maxX', 'minY', 'maxY'] as const).every((k) => k === but || Math.abs(b[k] - paper[k]) < 1e-6);

    // 1. 用紙の外に離れた点が少しあるだけ → 用紙
    const strayMarks: number[] = [];
    for (let i = 0; i < 20; i++) strayMarks.push(paper.maxX + 100 + i, 0);
    if (!same(F(body, strayMarks), paper)) fail('全体：離れた点だけで用紙から広がる', F(body, strayMarks));

    // 2. 図枠が用紙の辺ちょうど（float32 の丸めでわずかに外）→ 用紙
    const edgeX = Math.fround(paper.maxX + 1e-5);
    const frame = [...body, paper.minX, paper.maxY, edgeX, paper.maxY, edgeX, paper.maxY, edgeX, paper.minY, edgeX, paper.minY, paper.minX, paper.minY];
    if (!same(F(frame), paper)) fail('全体：用紙の辺ちょうどの図枠で用紙から広がる', F(frame));

    // 3. 右の辺をまたいで 60mm 先まで続く線 12 本 → 右だけ 60mm 先まで
    const cont: number[] = [];
    for (let i = 0; i < 12; i++) cont.push(paper.maxX - 40, -50 + i * 8, paper.maxX + 60, -50 + i * 8);
    const f3 = F([...body, ...cont]);
    if (!(f3.maxX >= paper.maxX + 59.9 && f3.maxX <= paper.maxX + 60.1) || !others(f3, 'maxX')) fail('全体：辺をまたいで続く線の先まで右だけ広がらない', f3);

    // 4. 遠くまで伸びた線が 3 本だけ → 用紙
    const longs: number[] = [];
    for (let i = 0; i < 3; i++) longs.push(0, i * 10, 5000, i * 10);
    if (!same(F([...body, ...longs]), paper)) fail('全体：遠くへ伸びた数本の線に引きずられる', F([...body, ...longs]));

    // 5. 本物の続き 12 本と、遠くへ伸びた 1 本 → 続きの先（60mm）まで
    const f5 = F([...body, ...cont, 0, 0, 5000, 0]);
    if (!(f5.maxX <= paper.maxX + 60.1 && f5.maxX >= paper.maxX + 59.9)) fail('全体：1 本の遠い線に引きずられる', f5);

    // 6. 辺のすぐ外で分割された壁 12 本（外側の部分は 140mm 先まで）→ 140mm 先まで
    const split: number[] = [];
    for (let i = 0; i < 12; i++) {
      const y = -60 + i * 10;
      split.push(paper.maxX - 30, y, paper.maxX + 5, y, paper.maxX + 5, y, paper.maxX + 140, y);
    }
    const f6 = F([...body, ...split]);
    if (!(f6.maxX >= paper.maxX + 139.9) || !others(f6, 'maxX')) fail('全体：分割された壁の先が切れる', f6);

    // 7. 細かい線分でできた円弧 12 本が左の辺をまたいで 70mm 先まで → 左に 70mm 先まで
    const arcs: number[] = [];
    for (let i = 0; i < 12; i++) {
      const y0 = -60 + i * 10;
      let px = paper.minX + 30, py = y0;
      for (let t = 1; t <= 40; t++) {
        const x = paper.minX + 30 - t * 2.5;
        const y = y0 + Math.sin(t / 8) * 3;
        arcs.push(px, py, x, y);
        px = x; py = y;
      }
    }
    const f7 = F([...body, ...arcs]);
    if (!(f7.minX <= paper.minX - 69.9) || !others(f7, 'minX')) fail('全体：細かい線分でできた円弧の先が切れる', f7);

    // 8. 用紙から離れた所（80〜90mm 先）にまとまった図形 → 用紙
    const detached: number[] = [];
    for (let i = 0; i < 60; i++) detached.push(paper.maxX + 80, -30 + i, paper.maxX + 90, -30 + i);
    if (!same(F([...body, ...detached]), paper)) fail('全体：離れた所の図形まで広がる', F([...body, ...detached]));

    // 9. 図形の多くが用紙の外 → 図形と用紙を合わせた範囲（用紙より広い）
    const outside: number[] = [];
    for (let i = 0; i < 4000; i++) {
      const x = paper.maxX + 50 + rand() * 300;
      const y = rand() * 100;
      outside.push(x, y, x + 1, y + 1);
    }
    const f9 = F([...body.slice(0, 4000), ...outside]);
    if (!(f9.maxX > paper.maxX + 50)) fail('全体：図形の多くが用紙の外なのに入らない', f9);

    // 10. 用紙がずっと大きい（図形は隅の小さな範囲だけ）→ 図形の範囲（用紙より狭い）
    const tiny: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const x = rand() * 30, y = rand() * 20;
      tiny.push(x, y, x + 0.5, y + 0.5);
    }
    const f10 = F(tiny);
    if (!(f10.maxX - f10.minX < (paper.maxX - paper.minX) / 2)) fail('全体：小さな図形が用紙いっぱいに縮んで映る', f10);

    // 11. 用紙のすぐ下（5mm）の注記 13 個（文字の四隅）→ 下だけ注記の分まで
    const notes: number[] = [];
    for (let i = 0; i < 13; i++) {
      const x = -100 + i * 15, y = paper.minY - 5 - 3;
      notes.push(x, y, x + 10, y, x + 10, y + 3, x, y + 3);
    }
    const f11 = F(body, notes);
    if (!(f11.minY <= paper.minY - 7.9 && f11.minY >= paper.minY - 20) || !others(f11, 'minY')) fail('全体：用紙のすぐ外の注記の扱いがおかしい', f11);

    // 12. 長い補助線が 8 本、用紙から遠くまで伸びているだけ → 用紙
    const eight: number[] = [];
    for (let i = 0; i < 8; i++) eight.push(0, -100 + i * 25, 3000, -100 + i * 25);
    if (!same(F([...body, ...eight]), paper)) fail('全体：長い線 8 本の先まで広がる', F([...body, ...eight]));

    // 13. 用紙から離れた所の円 10 個（細かい線分でできた 1 つずつの図形）→ 用紙
    const circles: number[] = [];
    const circleEnt: number[] = [];
    for (let c = 0; c < 10; c++) {
      const cx = paper.maxX + 300, cy = -100 + c * 20, r = 50;
      for (let t = 0; t < 64; t++) {
        const a0 = (t / 64) * Math.PI * 2, a1 = ((t + 1) / 64) * Math.PI * 2;
        circles.push(cx + r * Math.cos(a0), cy + r * Math.sin(a0), cx + r * Math.cos(a1), cy + r * Math.sin(a1));
        circleEnt.push(100000 + c);
      }
    }
    const bodyEnt = Array.from({ length: body.length / 4 }, (_, i) => i);
    // 代表点は円 1 つにつき 5 点（fitScene と同じ数え方）
    const circlePts: number[] = [];
    for (let c = 0; c < 10; c++) for (let q = 0; q < 5; q++) circlePts.push(paper.maxX + 300 + 50 * Math.cos(q), -100 + c * 20 + 50 * Math.sin(q));
    const f13 = fitRange({
      pts: Float32Array.from([...body, ...circlePts]), segs: Float32Array.from([...body, ...circles]), marks: new Float32Array(0),
      segEnt: Int32Array.from([...bodyEnt, ...circleEnt]),
    }, all, paper);
    if (!same(f13, paper)) fail('全体：用紙から離れた円に引きずられる', f13);
  }

  // 反転で表示にした隠れグループは、もう一度反転すると中の設定まで戻る。
  // 間にほかのグループを切り替えても、保存して読み直しても同じ
  {
    const counts = new Uint32Array(256);
    for (const k of [0x10, 0x11, 0x12, 0x20, 0x21]) counts[k] = 3;
    const v = new LayerVisibility().useCounts(counts);
    v.layer[0x12] = false; // グループ 1 の中で 1-2 を隠している
    v.group[1] = false;    // さらにグループ 1 ごと隠す
    const before = [...v.layer.slice(0x10, 0x20)];
    v.invert();
    // 間にグループ 2 の中を反転の外で触ったとしても（覚え書きはグループごと）
    const saved = v.hidden();
    const w = new LayerVisibility().useCounts(counts);
    w.applyHidden(JSON.parse(JSON.stringify(saved)));
    w.invert();
    const after = [...w.layer.slice(0x10, 0x20)];
    if (w.group[1] || JSON.stringify(after) !== JSON.stringify(before)) {
      fail('反転で表示にした隠れグループを、読み直してから反転しても中の設定が戻らない', { before, after, group1: w.group[1] });
    }
    // 別のグループを直接切り替えても、このグループの覚え書きは残る。このグループを切り替えたら捨てる
    v.forget(0);
    if (!v.stash.has(1)) fail('別のグループを切り替えただけで、反転の覚え書きが消える');
    v.forget(1);
    if (v.stash.has(1)) fail('そのグループを直接切り替えたのに反転の覚え書きが残る');

    // スイッチは入っていて、図形のあるレイヤが全部隠れていたグループも、反転 → 読み直し → 反転で元の設定に戻る
    const x = new LayerVisibility().useCounts(counts);
    x.layer[0x20] = false;
    x.layer[0x21] = false;
    const start = { group: x.group[2], flags: [...x.layer.slice(0x20, 0x30)] };
    x.invert();
    const y = new LayerVisibility().useCounts(counts);
    y.applyHidden(JSON.parse(JSON.stringify(x.hidden())));
    y.invert();
    const end = { group: y.group[2], flags: [...y.layer.slice(0x20, 0x30)] };
    if (JSON.stringify(start) !== JSON.stringify(end)) fail('中が全部隠れていたグループが、反転・読み直し・反転で元に戻らない', { start, end });
  }

  // 反転は、無作為な状態でも見え方がちょうど入れ替わり、
  // 「スイッチは表示なのに中のレイヤが全部隠れている」グループを作らない（グループのスイッチで戻せなくなるため）
  {
    const rand = rng(7);
    let wrongFlip = 0;
    let deadGroup = 0;
    for (let n = 0; n < 5000; n++) {
      const v = new LayerVisibility();
      for (let g = 0; g < 16; g++) v.group[g] = rand() > 0.3;
      const allOn = rand() < 0.3;
      for (let k = 0; k < 256; k++) v.layer[k] = allOn ? true : rand() > 0.4;
      const was = v.mask();
      v.invert();
      for (let k = 0; k < 256; k++) if (v.visible(k) === (was[k] === 1)) { wrongFlip++; break; }
      for (let g = 0; g < 16; g++) {
        if (!v.group[g]) continue;
        let any = false;
        for (let l = 0; l < 16; l++) if (v.layer[(g << 4) | l]) any = true;
        if (!any) deadGroup++;
      }
    }
    if (wrongFlip) fail('反転で見え方がちょうど入れ替わらない状態がある', { wrongFlip });
    if (deadGroup) fail('反転で、スイッチは表示なのに中が全部隠れたグループができる', { deadGroup });
  }
  // 反転：見えていたものと隠れていたものが入れ替わり、2 回で元の見え方に戻る（グループごと隠したものも含めて）
  const inv = new LayerVisibility();
  inv.resetToJw(groups, 0);
  const was = inv.mask();
  inv.invert();
  let notFlipped = 0;
  for (let k = 0; k < 256; k++) if (inv.visible(k) === (was[k] === 1)) notFlipped++;
  if (notFlipped) fail('反転で入れ替わらないレイヤがある', { notFlipped });
  inv.invert();
  const again = new LayerVisibility();
  again.resetToJw(groups, 0);
  if (!inv.sameAs(again)) fail('2 回反転しても元の見え方に戻らない');
  console.log(`\n合成データ（Jw_cad の状態・このレイヤだけ・反転）: ${failures === before ? 'OK' : 'NG'}`);
}

// ---------- 6. 内部バージョンの扱い：2.30 より前は断り、2.31〜2.99 は読んで注意を出す ----------
{
  const before = failures;
  const headOnly = (version: number): ArrayBuffer => {
    const b = new Uint8Array(12);
    b.set([...'JwwData.'].map((c) => c.charCodeAt(0)));
    new DataView(b.buffer).setUint32(8, version, true);
    return b.buffer;
  };
  const refused = (version: number): boolean => {
    try {
      parseJww(headOnly(version));
      return false;
    } catch (err) {
      return /未対応の JWW バージョン/.test((err as Error).message);
    }
  };
  for (const v of [0, 100, 223, 229]) if (!refused(v)) fail('2.30 より前のバージョンを断らない', { v });
  // ヘッダだけの短いデータなので先で止まるが、バージョンでは断らない
  for (const v of [230, 231, 252, 299, 300, 351, 420, 700]) if (refused(v)) fail('読めるはずのバージョンを断る', { v });
  const expect: Array<[number, string | null]> = [
    [230, null], [231, 'Ver.2.31'], [252, 'Ver.2.52'], [299, 'Ver.2.99'], [300, null], [700, null],
  ];
  for (const [v, want] of expect) {
    const got = versionWarning(v);
    if (want === null ? got !== null : !(got && got.includes(want) && got.includes('確認'))) fail('古い形式の注意の出し方が違う', { v, got });
  }
  console.log(`\n内部バージョンの扱い（2.30 未満は断る・2.31〜2.99 は注意）: ${failures === before ? 'OK' : 'NG'}`);
}

console.log(failures ? `\n失敗 ${failures} 件` : '\nすべて合格');
process.exit(failures ? 1 : 0);
