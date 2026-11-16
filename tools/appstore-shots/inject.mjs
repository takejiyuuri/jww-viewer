// 撮影用ビルドだけに、自動手順（scenario.js）を入れる：dist に写し、index.html から読み込む。
// 使い方：NODE_ENV=development npx vite build && node tools/appstore-shots/inject.mjs [dist]
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = process.argv[2] ?? path.join(here, '..', '..', 'dist');
const html = path.join(dist, 'index.html');
copyFileSync(path.join(here, 'scenario.js'), path.join(dist, 'shot-scenario.js'));
const src = readFileSync(html, 'utf8');
if (!src.includes('shot-scenario.js')) {
  writeFileSync(html, src.replace('</body>', '<script src="./shot-scenario.js"></script>\n</body>'));
}
const js = readFileSync(path.join(dist, 'assets', readFileSync(html, 'utf8').match(/assets\/(index-[^"]+\.js)/)[1]), 'utf8');
if (!js.includes('__jww')) {
  console.error('ビルドに window.__jww がありません。NODE_ENV=development でビルドしてください');
  process.exit(1);
}
console.log(`撮影用の自動手順を ${dist} に入れました`);
