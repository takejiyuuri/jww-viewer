// HTTPS で開発サーバーを立ち上げる。
// iPhone で「ホーム画面に追加」してオフラインでも使うには Service Worker が要り、
// そのためには信頼された HTTPS で配信する必要がある。
import { startServer } from './serve.mjs';
import { RENEW_NOTE } from './make-cert.mjs';

// ポートは -- の付かない最初の引数（--preview の前でも後でもよい）。数でなければ 5173
const portArg = Number(process.argv.slice(2).find((a) => !a.startsWith('--')));
const port = Number.isInteger(portArg) && portArg > 0 && portArg < 65536 ? portArg : 5173;
// --preview を付けると dist をそのまま配信する（本番と同じ形で確かめたいとき。先に npm run build）
const usePreview = process.argv.includes('--preview');

let started;
try {
  started = await startServer({ port, https: true, preview: usePreview });
} catch (e) {
  // openssl がない・dist がないなどは、やることが分かる一文だけを出す
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
const { server, cert } = started;

server.printUrls?.();

const ip = cert.ips[0];
if (ip) {
  console.log(`
  iPhone から使う手順
  ─────────────────
  1. Safari で  https://${ip}:${port}/ca.crt  を開く
     → 「プロファイルがダウンロードされました」と出る
       （最初は証明書の警告が出ます。「詳細」→「このWebサイトを閲覧」で進んでください）
  2. 設定 → 一般 → VPN とデバイス管理 → ダウンロード済みプロファイル
     → JWW Viewer Local CA をインストール
       （詳細に出る SHA-256 が、下の「CA の指紋」と同じか確かめる。違えば入れない）
  3. 設定 → 一般 → 情報 → 証明書信頼設定
     → JWW Viewer Local CA のスイッチをオン
  4. Safari で  https://${ip}:${port}/  を開く（警告なしで開けば成功）
  5. 共有ボタン →「ホーム画面に追加」

  CA の指紋（SHA-256）: ${cert.fingerprint}
  ※ 1〜3 は CA を新しく作ったときだけです（PC の IP が変わってもそのまま使えます）。
    ${cert.caCreated
      ? '今回 CA を新しく作りました。前の JWW Viewer Local CA が iPhone に残っていれば、先に削除してください。'
      : '今回は前の CA のままなので、iPhone に入れてあればやり直す必要はありません。'}
`);
  if (cert.ips.length > 1) console.log(`  ほかのアドレス: ${cert.ips.slice(1).join(', ')}`);
  if (cert.skipped.length) console.log(`  LAN の外なので証明書に入れていないアドレス: ${cert.skipped.join(', ')}`);
  if (!cert.constrained) console.log(`  ${RENEW_NOTE}`);
}
