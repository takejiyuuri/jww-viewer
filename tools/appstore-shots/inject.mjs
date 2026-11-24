// 撮影用ビルドだけに、自動手順（scenario.js）を入れる：dist に写し、index.html から読み込む。
// 使い方：NODE_ENV=development npx vite build && node tools/appstore-shots/inject.mjs [dist]
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = process.argv[2] ?? path.join(here, '..', '..', 'dist');
const html = path.join(dist, 'index.html');
copyFileSync(path.join(here, 'scenario.js'), path.join(dist, 'shot-scenario.js'));
// 8 枚目（ZIP の読み込み）用：アプリの見本の図面 1 枚だけを入れた ZIP
copyFileSync(path.join(here, 'shot-sample.zip'), path.join(dist, 'shot-sample.zip'));
// 1.4 の 05（レイヤを見つける）用：撮影用の見本の図面（layer-drawing.mjs で作る。アプリには入れない）
copyFileSync(path.join(here, 'layer-drawing.jww'), path.join(dist, 'shot-layers.jww'));
const src = readFileSync(html, 'utf8');
// 撮る場面の組（SHOT_SET=new なら追加の場面だけ、v10 ならすべての場面と 09・10 用の場面）
const set = ['new', 'v10', 'v14'].includes(process.env.SHOT_SET) ? process.env.SHOT_SET : 'all';
if (!src.includes('shot-scenario.js')) {
  writeFileSync(html, src.replace('</body>', `<script>window.__SHOT_SET = '${set}';</script>\n<script src="./shot-scenario.js"></script>\n</body>`));
}
const js = readFileSync(path.join(dist, 'assets', readFileSync(html, 'utf8').match(/assets\/(index-[^"]+\.js)/)[1]), 'utf8');
if (!js.includes('__jww')) {
  console.error('ビルドに window.__jww がありません。NODE_ENV=development でビルドしてください');
  process.exit(1);
}
console.log(`撮影用の自動手順を ${dist} に入れました`);
