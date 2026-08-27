import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
        './manifest.webmanifest',
        './icon-180.png',
        './icon-192.png',
        './icon-512.png',
        ...emitted.map((f) => `./${f}`),
      ];
      const unique = [...new Set(precache)];
      const version = createHash('sha256').update(unique.join('|')).digest('hex').slice(0, 12);

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
});
