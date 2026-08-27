// 図面に入っている寸法データを使って、計測値と縮尺の解釈が正しいかを検証する。
// 寸法線の実長 × レイヤグループの縮尺 が、寸法値の文字列と一致するはず。
import { readFileSync } from 'node:fs';
import { parseJww } from '../src/jww/parser.ts';
import { buildScene } from '../src/render/geometry.ts';
import { SnapIndex } from '../src/measure/snap.ts';

for (const file of process.argv.slice(2)) {
  const raw = readFileSync(file);
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const doc = parseJww(ab);

  let checked = 0;
  let hit = 0;
  let ownWins = 0;
  const misses: string[] = [];

  for (const d of doc.entities.dims) {
    const label = d.text.text.replace(/[,\s]/g, '');
    // 単位や記号が付いた寸法値は対象外
    const m = /^([0-9]+(?:\.[0-9]+)?)$/.exec(label);
    if (!m) continue;
    const value = Number(m[1]);
    if (!(value > 0)) continue;

    const raw = Math.hypot(d.line.x2 - d.line.x1, d.line.y2 - d.line.y1);
    const s1 = doc.header.groups[d.line.glayer]?.scale ?? 1;
    const s2 = doc.header.groups[d.glayer]?.scale ?? 1;
    const e1 = Math.abs(raw * s1 - value) / value;
    const e2 = Math.abs(raw * s2 - value) / value;
    const useOwn = e2 < e1;
    if (useOwn) ownWins++;
    const scale = useOwn ? s2 : s1;
    const len = raw * scale;
    checked++;
    const err = Math.min(e1, e2);
    if (err < 0.01) hit++;
    else if (misses.length < 5) {
      misses.push(`寸法値 ${value} に対し計測 ${len.toFixed(1)} (1/${scale}, 誤差 ${(err * 100).toFixed(1)}%)`);
    }
  }

  // スナップ索引の構築時間と、端点への吸着を確認
  const scene = buildScene(doc);
  const t0 = performance.now();
  const index = new SnapIndex(scene);
  const buildMs = performance.now() - t0;

  const span = Math.max(scene.fitBounds.maxX - scene.fitBounds.minX, 1);
  const radius = span * 0.004;
  let snapped = 0;
  let queryMs = 0;
  const trials = 300;
  for (let i = 0; i < trials; i++) {
    const k = Math.floor((i / trials) * (scene.linePos.length / 4)) * 4;
    // 端点からわずかにずらした位置を突いて、端点に戻るかを見る
    const x = scene.linePos[k] + radius * 0.3;
    const y = scene.linePos[k + 1] - radius * 0.3;
    const t1 = performance.now();
    const r = index.query(x, y, radius);
    queryMs += performance.now() - t1;
    if (r.kind === 'endpoint' || r.kind === 'intersection' || r.kind === 'center') snapped++;
  }

  console.log(`\n=== ${file.split(/[\\/]/).pop()}`);
  console.log(`  寸法照合: ${hit}/${checked} 一致 (${checked ? ((hit / checked) * 100).toFixed(1) : '-'}%) ／ 寸法自身のグループが正しかった数 ${ownWins}`);
  for (const s of misses) console.log(`    ・${s}`);
  console.log(`  スナップ索引: ${buildMs.toFixed(0)}ms で構築、1 回あたり ${(queryMs / trials).toFixed(2)}ms`);
  console.log(`  端点吸着: ${snapped}/${trials}`);
}
