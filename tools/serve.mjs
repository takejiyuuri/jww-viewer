// 開発サーバー / プレビューサーバーの起動をひとまとめにする。
// 検証スクリプトから使うと、サーバーの起動と後片付けをテスト側で完結できる。
import { createServer, preview } from 'vite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCert } from './make-cert.mjs';

export const projectRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

/**
 * @param {{ port?: number, https?: boolean, preview?: boolean, host?: boolean }} opts
 */
export async function startServer(opts = {}) {
  const port = opts.port ?? 5173;
  const useHttps = opts.https ?? false;
  const usePreview = opts.preview ?? false;
  const host = opts.host ?? true;

  const cert = useHttps ? ensureCert() : null;

  const caPlugin = {
    name: 'serve-ca-certificate',
    configureServer: attach,
    configurePreviewServer: attach,
  };

  function attach(server) {
    // iPhone に CA をインストールしてもらうための配布口
    server.middlewares.use((req, res, next) => {
      if (!cert || req.url !== '/ca.crt') return next();
      res.setHeader('Content-Type', 'application/x-x509-ca-cert');
      res.setHeader('Content-Disposition', 'attachment; filename="jww-viewer-ca.crt"');
      res.end(readFileSync(cert.ca));
    });
  }

  const httpsOption = cert ? { key: cert.key, cert: cert.cert } : undefined;
  const common = {
    root: projectRoot,
    configFile: path.join(projectRoot, 'vite.config.ts'),
    plugins: [caPlugin],
    logLevel: opts.quiet ? 'error' : 'info',
  };

  let server;
  if (usePreview) {
    server = await preview({
      ...common,
      preview: { host, port, strictPort: true, https: httpsOption },
    });
  } else {
    server = await createServer({
      ...common,
      server: { host, port, strictPort: true, https: httpsOption },
    });
    await server.listen();
  }

  const origin = `${useHttps ? 'https' : 'http'}://localhost:${port}/`;
  return {
    server,
    url: origin,
    cert,
    async close() {
      await server.close();
    },
  };
}
