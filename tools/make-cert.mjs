// iPhone から PWA として使えるように、LAN 用の自己署名証明書を作る。
// iOS は SAN と 825 日以内の有効期限を要求するため、そこに合わせて発行する。
// ルート CA は一度 iPhone に入れたら使い続けられるよう、PC の IP が変わってもサーバ証明書だけを作り直す。
import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const dir = path.join(root, 'certs');

/**
 * CA が証明できる名前を LAN の中に限る（nameConstraints）。鍵が漏れても、ほかのサイトの証明書は作れない。
 * プライベートアドレス（10/8・172.16/12・192.168/16）と 127/8、localhost と jww-viewer.local だけ
 */
const PERMITTED_IPV4 = [
  ['10.0.0.0', '255.0.0.0'],
  ['172.16.0.0', '255.240.0.0'],
  ['192.168.0.0', '255.255.0.0'],
  ['127.0.0.0', '255.0.0.0'],
];
const PERMITTED_DNS = ['localhost', 'jww-viewer.local'];

/** DER の中の nameConstraints の OID（2.5.29.30） */
const NAME_CONSTRAINTS_OID = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x1e]);

const ipToInt = (ip) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);

/** CA の名前制約の範囲に入るアドレスか */
export function isPermitted(ip) {
  const v = ipToInt(ip);
  return PERMITTED_IPV4.some(([net, mask]) => ((v & ipToInt(mask)) >>> 0) === ((ipToInt(net) & ipToInt(mask)) >>> 0));
}

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
  try {
    return execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(
        'openssl が見つかりません。証明書を作るのに使います。' +
        'Windows では Git for Windows に入っているもの（C:\\Program Files\\Git\\mingw64\\bin）を PATH に通してください',
      );
    }
    throw e;
  }
}

/** 並び順によらず同じアドレスの組か（有線と Wi-Fi の順が入れ替わっただけで作り直さない） */
const sameIps = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** 期限内で、鍵と対になっている CA なら返す */
function usableCa(caPath, caKeyPath) {
  try {
    const cert = new X509Certificate(readFileSync(caPath));
    if (!cert.ca || !cert.checkPrivateKey(createPrivateKey(readFileSync(caKeyPath)))) return null;
    if (!(Date.now() < new Date(cert.validTo).getTime())) return null;
    return cert;
  } catch {
    return null;
  }
}

/** サーバ証明書がこの CA で発行され、期限内で、いまのアドレスのままなら true */
function usableServer(ca, ips, { metaPath, keyPath, certPath }) {
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const cert = new X509Certificate(readFileSync(certPath));
    return sameIps(meta.ips, ips) &&
      cert.checkIssued(ca) && cert.verify(ca.publicKey) &&
      cert.checkPrivateKey(createPrivateKey(readFileSync(keyPath))) &&
      Date.now() < new Date(cert.validTo).getTime();
  } catch {
    return false;
  }
}

/**
 * 証明書一式を用意する。
 * ルート CA は、ない・期限切れ・force のときだけ作る（作り直すと iPhone に入れ直しになるため）。
 * サーバ証明書は、IP の組が変わったときや CA を作ったときに作り直す。
 * @returns {{key: Buffer, cert: Buffer, ca: string, ips: string[], skipped: string[], created: boolean,
 *   caCreated: boolean, constrained: boolean, fingerprint: string}}
 */
export function ensureCert({ force = false } = {}) {
  const metaPath = path.join(dir, 'meta.json');
  const keyPath = path.join(dir, 'server.key');
  const certPath = path.join(dir, 'server.crt');
  const caPath = path.join(dir, 'ca.crt');
  const caKeyPath = path.join(dir, 'ca.key');

  let ca = force ? null : usableCa(caPath, caKeyPath);
  const caCreated = !ca;
  if (!ca) {
    mkdirSync(dir, { recursive: true });
    const nameConstraints = [
      ...PERMITTED_IPV4.map(([net, mask]) => `permitted;IP:${net}/${mask}`),
      ...PERMITTED_DNS.map((name) => `permitted;DNS:${name}`),
    ].join(',');
    openssl([
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '820',
      '-subj', '/CN=JWW Viewer Local CA/O=JWW Viewer',
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-addext', `nameConstraints=critical,${nameConstraints}`,
    ]);
    ca = new X509Certificate(readFileSync(caPath));
  }

  // 名前制約のある CA では、範囲の外のアドレス（VPN の 100.64/10 など）を証明書に入れると証明書ごと弾かれる
  const constrained = ca.raw.includes(NAME_CONSTRAINTS_OID);
  const all = localAddresses();
  const ips = constrained ? all.filter(isPermitted) : all;
  const skipped = all.filter((ip) => !ips.includes(ip));
  const info = { ca: caPath, ips, skipped, caCreated, constrained, fingerprint: ca.fingerprint256 };

  if (!caCreated && usableServer(ca, ips, { metaPath, keyPath, certPath })) {
    return { key: readFileSync(keyPath), cert: readFileSync(certPath), created: false, ...info };
  }

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

  writeFileSync(metaPath, JSON.stringify({ ips, createdAt: Date.now() }, null, 2));

  return { key: readFileSync(keyPath), cert: readFileSync(certPath), created: true, ...info };
}

/** 名前制約のない（前の版で作った）CA を使い続けているときの一行の案内 */
export const RENEW_NOTE =
  '※ この CA には名前制約（LAN の中だけに使える制限）がありません。作り直すなら npm run cert -- --force を実行し、' +
  'iPhone の古い JWW Viewer Local CA のプロファイルを削除してから入れ直してください';

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  let r;
  try {
    r = ensureCert({ force: process.argv.includes('--force') });
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
  console.log(r.caCreated ? 'ルート CA とサーバ証明書を作成しました（iPhone に CA を入れ直してください）'
    : r.created ? '前の CA のまま、サーバ証明書を作り直しました' : '既存の証明書を使います');
  console.log(`  ${dir}`);
  console.log(`  対象アドレス: ${['localhost', '127.0.0.1', ...r.ips].join(', ')}`);
  if (r.skipped.length) console.log(`  LAN の外なので入れないアドレス: ${r.skipped.join(', ')}`);
  console.log(`  CA の指紋（SHA-256）: ${r.fingerprint}`);
  if (!r.constrained) console.log(`  ${RENEW_NOTE}`);
}
