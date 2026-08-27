// iPhone から PWA として使えるように、LAN 用の自己署名証明書を作る。
// iOS は SAN と 825 日以内の有効期限を要求するため、そこに合わせて発行する。
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const dir = path.join(root, 'certs');

export function localAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return [...new Set(out)];
}

function openssl(args, opts = {}) {
  return execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/**
 * 証明書一式を用意する。IP が変わっていたら作り直す。
 * @returns {{key: Buffer, cert: Buffer, ca: string, ips: string[], created: boolean}}
 */
export function ensureCert({ force = false } = {}) {
  const ips = localAddresses();
  const metaPath = path.join(dir, 'meta.json');
  const keyPath = path.join(dir, 'server.key');
  const certPath = path.join(dir, 'server.crt');
  const caPath = path.join(dir, 'ca.crt');

  let reuse = false;
  if (!force && existsSync(metaPath) && existsSync(keyPath) && existsSync(certPath) && existsSync(caPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      const sameIps = JSON.stringify(meta.ips) === JSON.stringify(ips);
      const notExpired = Date.now() < meta.expiresAt;
      reuse = sameIps && notExpired;
    } catch {
      reuse = false;
    }
  }

  if (reuse) {
    return {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
      ca: caPath,
      ips,
      created: false,
    };
  }

  mkdirSync(dir, { recursive: true });

  // ルート CA
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
    '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '820',
    '-subj', '/CN=JWW Viewer Local CA/O=JWW Viewer',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ]);

  // サーバ鍵と CSR
  openssl([
    'req', '-newkey', 'rsa:2048', '-nodes', '-sha256',
    '-keyout', 'server.key', '-out', 'server.csr',
    '-subj', '/CN=jww-viewer.local/O=JWW Viewer',
  ]);

  const san = ['DNS:localhost', 'DNS:jww-viewer.local', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');
  const extPath = path.join(dir, 'server.ext');
  writeFileSync(extPath, [
    `subjectAltName=${san}`,
    'extendedKeyUsage=serverAuth',
    'basicConstraints=CA:FALSE',
    'keyUsage=digitalSignature,keyEncipherment',
    '',
  ].join('\n'));

  // iOS の要求上、サーバ証明書は 825 日以内
  openssl([
    'x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
    '-CAcreateserial', '-out', 'server.crt', '-days', '800', '-sha256',
    '-extfile', 'server.ext',
  ]);

  rmSync(extPath, { force: true });
  rmSync(path.join(dir, 'server.csr'), { force: true });

  writeFileSync(metaPath, JSON.stringify({
    ips,
    createdAt: Date.now(),
    expiresAt: Date.now() + 800 * 24 * 3600 * 1000,
  }, null, 2));

  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
    ca: caPath,
    ips,
    created: true,
  };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const r = ensureCert({ force: process.argv.includes('--force') });
  console.log(r.created ? '証明書を作成しました' : '既存の証明書を使います');
  console.log(`  ${dir}`);
  console.log(`  対象アドレス: ${['localhost', '127.0.0.1', ...r.ips].join(', ')}`);
}
