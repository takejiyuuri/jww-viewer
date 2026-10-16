// JWW の Scene の指紋（ブラウザ不要）。geometry.ts を組み替えたときに、描画データが 1 バイトも変わっていないかを確かめる。
// samples/ の図面は公開できない実務の図面なので、名前も中身も出さず、番号と指紋だけを出す。
//   node tools/scene-digest.ts                 … 指紋を出す
//   node tools/scene-digest.ts --save 基準.json … 指紋を保存する
//   node tools/scene-digest.ts --check 基準.json … 保存した指紋と比べ、違えば exit 1
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseJww } from '../src/jww/parser.ts';
import { buildScene } from '../src/render/geometry.ts';
import type { Scene } from '../src/render/geometry.ts';
import { listSamples } from './samples.mjs';

/** FNV-1a（32 ビット）をバイト列に掛け続ける */
class Fnv {
  h = 0x811c9dc5;
  bytes(b: Uint8Array): void {
    let h = this.h;
    for (let i = 0; i < b.length; i++) {
      h ^= b[i];
      h = Math.imul(h, 0x01000193);
    }
    this.h = h >>> 0;
  }
  view(v: ArrayBufferView): void {
    this.num(v.byteLength);
    this.bytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }
  num(n: number): void {
    this.view0(new Float64Array([n]));
  }
  private view0(v: Float64Array): void {
    this.bytes(new Uint8Array(v.buffer));
  }
  str(s: string): void {
    const b = new TextEncoder().encode(s);
    this.num(b.length);
    this.bytes(b);
  }
  hex(): string {
    return this.h.toString(16).padStart(8, '0');
  }
}

/** Scene の、今ある項目すべての指紋（あとから足す項目は含めない） */
export function sceneDigest(scene: Scene, warnings: string[]): string {
  const f = new Fnv();
  for (const b of [scene.bounds, scene.fitBounds, scene.paper]) {
    if (!b) { f.str('null'); continue; }
    f.num(b.minX); f.num(b.minY); f.num(b.maxX); f.num(b.maxY);
  }
  const arrays: ArrayBufferView[] = [
    scene.linePos, scene.lineColor, scene.lineLayer, scene.lineSnap, scene.lineEntity, scene.lineStyle,
    scene.lineDist, scene.dashes, scene.dotPos, scene.dotColor, scene.dotLayer,
    scene.triPos, scene.triColor, scene.triLayer, scene.triEntity,
    scene.snapPoint, scene.snapPointLayer, scene.snapPointColor, scene.snapPointEntity,
    scene.scales, scene.colors, scene.colorGroup, scene.layerCounts, scene.curves,
  ];
  for (const a of arrays) f.view(a);
  const e = scene.entities;
  f.num(e.count);
  for (const a of [
    e.kind, e.layer, e.pen, e.style, e.color, e.block, e.lineStart, e.lineCount, e.triStart, e.triCount,
    e.group, e.text, e.size, e.size2, e.length, e.rgb,
  ]) f.view(a);
  for (const t of scene.texts) {
    f.num(t.x); f.num(t.y); f.num(t.width); f.num(t.height); f.num(t.angle);
    f.str(t.text); f.num(t.color); f.num(t.layer); f.num(t.entity);
  }
  for (const g of scene.groups) {
    f.num(g.penColor); f.str(g.label); f.num(g.rgb[0]); f.num(g.rgb[1]); f.num(g.rgb[2]); f.num(g.count);
  }
  for (const n of scene.blockNames) f.str(n);
  for (const w of warnings) f.str(w);
  return f.hex();
}

function digestFile(file: string): string {
  const buf = readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const doc = parseJww(ab);
  const scene = buildScene(doc);
  return sceneDigest(scene, doc.warnings);
}

const args = process.argv.slice(2);
const save = args[0] === '--save' ? args[1] : undefined;
const check = args[0] === '--check' ? args[1] : undefined;

// 公開の見本（public/sample.jww）と samples/ の .jww
const files = [fileURLToPath(new URL('../public/sample.jww', import.meta.url)), ...listSamples()];
const digests = files.map((f, i) => {
  const d = digestFile(f);
  console.log(`${i === 0 ? '見本' : `#${i}`} ${d}`);
  return d;
});

if (save) {
  writeFileSync(save, JSON.stringify(digests));
  console.log(`保存しました（${digests.length} 件）`);
}
if (check) {
  const base = JSON.parse(readFileSync(check, 'utf8')) as string[];
  let bad = 0;
  if (base.length !== digests.length) { console.log(`NG: 件数が違います ${base.length} → ${digests.length}`); bad++; }
  digests.forEach((d, i) => {
    if (base[i] !== d) { console.log(`NG: ${i === 0 ? '見本' : `#${i}`} ${base[i]} → ${d}`); bad++; }
  });
  console.log(bad ? `指紋が ${bad} 件違います` : `指紋はすべて一致（${digests.length} 件）`);
  if (bad) process.exit(1);
}
