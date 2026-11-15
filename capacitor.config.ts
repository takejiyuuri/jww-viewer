import type { CapacitorConfig } from '@capacitor/cli';

/**
 * iOS アプリ（JWWミテハカール）の設定。
 * Web 版の本体（npm run build の dist）をそのままアプリに同梱し、端末の中から読み込む。
 * 公開中のサイトを読み込む server.url は使わない（電波がなくても動き、審査でも単なるサイトの枠と見なされないように）。
 */
const config: CapacitorConfig = {
  // App Store Connect に登録する Bundle ID と同じにする（最初にアップロードしたあとは変えられない）
  appId: 'io.github.takejiyuuri.mitehakaru',
  appName: 'JWWミテハカール',
  webDir: 'dist',
  backgroundColor: '#0b0c10',
  ios: {
    // 画面の端（ノッチ・ホームインジケータ）までは Web 側で safe-area を見て避ける
    contentInset: 'never',
    // 図面の移動・拡大は Web 側で指の動きを扱うので、WebView 自体は弾ませない・拡大させない
    scrollEnabled: false,
    allowsLinkPreview: false,
    backgroundColor: '#0b0c10',
  },
  plugins: {
    // 画面は暗いので、ステータスバーの文字は白で始める（白背景に切り替えたら Web 側で黒にする）
    StatusBar: {
      style: 'DARK',
    },
  },
};

export default config;
