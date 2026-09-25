import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** public/ にあって、名前にハッシュが付かないまま取り込むファイル */
const PUBLIC_FILES = ['manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];

/**
 * ビルド結果のファイル名を Service Worker に埋め込み、install 時にまとめて取り込ませる。
 * fetch を横取りするだけの方式では、Service Worker が有効になる前に読み終えている
 * HTML・JS・CSS がいつまでもキャッシュされず、オフラインで起動できない。
 */
function serviceWorkerPlugin(): Plugin {
  return {
    name: 'jww-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const emitted = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const precache = [
        './',
        './index.html',
        ...PUBLIC_FILES.map((f) => `./${f}`),
        ...emitted.map((f) => `./${f}`),
      ];
      const unique = [...new Set(precache)];
      // public/ のファイルは名前が変わらず、取り込んだものがキャッシュから返り続けるので、
      // アイコンなどを差し替えたときも版が変わるよう中身も版番号に入れる
      const hash = createHash('sha256').update(unique.join('|'));
      for (const f of PUBLIC_FILES) hash.update(readFileSync(path.resolve(__dirname, 'public', f)));
      const version = hash.digest('hex').slice(0, 12);

      const template = readFileSync(path.resolve(__dirname, 'src/sw-template.js'), 'utf8');
      const source = template
        .replaceAll('__VERSION__', version)
        .replaceAll('__PRECACHE__', JSON.stringify(unique, null, 2));

      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
  plugins: [serviceWorkerPlugin()],
  server: {
    fs: {
      // 開発サーバは iPhone から開くために LAN へ出すので、証明書の鍵・実務の図面・検証の画面写しを配らない。
      // 指定すると Vite の既定（.env・*.crt・*.pem・.git）が置き換わるため、既定の分も並べる
      deny: ['.env', '.env.*', '*.{crt,pem,key}', '**/.git/**', '**/certs/**', '**/samples/**', '*.jww', 'e2e-*.png'],
    },
  },
});
