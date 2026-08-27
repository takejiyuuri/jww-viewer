import { readFileSync } from 'node:fs';
import { parseJww } from '../src/jww/parser.ts';

for (const file of process.argv.slice(2)) {
  const buf = readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const t0 = performance.now();
  console.log(`\n=== ${file}`);
  try {
    const doc = parseJww(ab);
    const ms = performance.now() - t0;
    const e = doc.entities;
    console.log(`  version=${doc.header.version} paper=${doc.header.paperSize} ${ms.toFixed(0)}ms`);
    console.log(`  線=${e.lines.length} 円弧=${e.arcs.length} 点=${e.points.length} 文字=${e.texts.length}`);
    console.log(`  ソリッド=${e.solids.length} 寸法=${e.dims.length} ブロック参照=${e.blocks.length} ブロック定義=${doc.blockDefs.size}`);
    if (doc.warnings.length) console.log(`  警告: ${doc.warnings.join(' / ')}`);
    const l = e.lines[0];
    if (l) {
      console.log(`  線[0]: (${l.x1.toFixed(2)},${l.y1.toFixed(2)})-(${l.x2.toFixed(2)},${l.y2.toFixed(2)}) 色=${l.penColor} レイヤ=${l.glayer}-${l.layer}`);
    }
    const t = e.texts.find((x) => x.text.trim().length > 0);
    if (t) {
      console.log(`  文字例: ${JSON.stringify(t.text)} font=${JSON.stringify(t.fontName)} size=${t.sizeX}x${t.sizeY}`);
    }
  } catch (err) {
    console.log(`  失敗: ${(err as Error).message}`);
  }
}
