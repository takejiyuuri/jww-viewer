// HTTPS で開発サーバーを立ち上げる。
// iPhone で「ホーム画面に追加」してオフラインでも使うには Service Worker が要り、
// そのためには信頼された HTTPS で配信する必要がある。
import { startServer } from './serve.mjs';

const port = Number(process.argv[2] ?? 5173);
// --preview を付けると dist をそのまま配信する（本番と同じ形で確かめたいとき）
const usePreview = process.argv.includes('--preview');

const { server, cert } = await startServer({ port, https: true, preview: usePreview });

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
  3. 設定 → 一般 → 情報 → 証明書信頼設定
     → JWW Viewer Local CA のスイッチをオン
  4. Safari で  https://${ip}:${port}/  を開く（警告なしで開けば成功）
  5. 共有ボタン →「ホーム画面に追加」

  ※ 1〜3 は最初の 1 回だけです。
`);
}
