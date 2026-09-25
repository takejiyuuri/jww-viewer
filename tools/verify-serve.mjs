// 開発サーバが LAN に配ってはいけないもの（証明書の鍵・実務の図面・検証の画面写し）を配らず、
// アプリに要るものは配ることを、Vite の判定だけで確かめる（サーバは起動しない。図面も使わない）。
import { isFileLoadingAllowed, normalizePath, resolveConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const config = await resolveConfig(
  { root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error' },
  'serve',
);

const denied = [
  'certs/ca.key', 'certs/server.key', 'certs/ca.crt', 'certs/server.crt', 'certs/meta.json', 'certs/ca.srl',
  'samples/図面.jww', 'samples/memo.txt', '図面.jww', 'tools/図面.JWW',
  'e2e-2-drawing.png', 'e2e-layers-1-inspect.png',
  '.env', '.env.local', '.git/config',
];
const allowed = ['index.html', 'src/main.ts', 'src/style.css', 'public/icon-192.png', 'public/manifest.webmanifest'];

let failures = 0;
const loadable = (p) => isFileLoadingAllowed(config, normalizePath(path.join(root, p)));
for (const p of denied) {
  if (loadable(p)) {
    failures++;
    console.log(`NG: 配ってはいけないものが配られる ${p}`);
  }
}
for (const p of allowed) {
  if (!loadable(p)) {
    failures++;
    console.log(`NG: アプリに要るものが配られない ${p}`);
  }
}
console.log(failures === 0 ? `開発サーバの配信範囲: ${denied.length} 件を止め、${allowed.length} 件を配る。すべて合格` : `${failures} 件の不合格`);
process.exit(failures === 0 ? 0 : 1);
