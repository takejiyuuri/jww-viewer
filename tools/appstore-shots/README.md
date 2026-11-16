# App Store のスクリーンショットを撮る（iPad 13インチ）

Mac がなくても、Codemagic の Mac で iPad のシミュレータを動かして、JWWミテハカールの実画面を撮る仕組み。
アプリの中身（画面・機能）は変えない。撮影用のビルドにだけ、画面を順に操作する自動手順を入れる。

## 動かし方

1. Codemagic の Start new build で、このブランチと「App Store 撮影（iPad シミュレータ）」を選ぶ
   （最初から main と「iOS ビルド確認」が選ばれているので必ず選び直す）
2. 20〜30 分ほどで終わる。ビルドの画面の Artifacts から `screenshots` の PNG をダウンロードする
   （個人アカウントでは 30 日で消える）

## 中身

| ファイル | 役目 |
| --- | --- |
| `scenario.js` | 画面の中で動く自動手順。見本の図面を開き、場面を作るたびに撮影を頼む |
| `inject.mjs` | 撮影用ビルド（`NODE_ENV=development npx vite build`）の dist に scenario.js を入れる |
| `run-sim.sh` | シミュレータを起動してアプリを入れ、合図を受けて `xcrun simctl io … screenshot` で撮る |
| `local-test.mjs` | 同じ自動手順を Chromium で iPad / iPhone の大きさにして通しで試す（下見用。App Store には使わない） |

- 合図のやりとり：scenario.js が Capacitor の Filesystem でアプリの Documents に `shot-request.txt`（場面の名前）を書き、
  run-sim.sh が撮ってから `shot-done.txt` に同じ名前を書く。最後に `FINISHED`（失敗は `ERROR`、記録は `shot-log.txt`）
- 時刻・電池の表示は `simctl status_bar` で 9:41・満充電にそろえる
- 機種は `SHOT_DEVICE`（既定「iPad Pro 13-inch」。なければ「iPad Air 13-inch」）。画面は 2064×2752

## 撮る場面

| 名前 | 場面 |
| --- | --- |
| 00_welcome | 最初の画面 |
| P5_drawing_fit | 見本の図面を開いた直後（全体表示・計測） |
| P1a_original_dims | 下の寸法の列を拡大（元の寸法） |
| P1b_ruishin_on | 「累進」→「累進表示」 |
| P1c_ruishin_selected | 下の列を選択（オレンジ） |
| X2a_origin_drag_magnifier | 起点を寸法線の外へドラッグ中（拡大鏡） |
| X2b_extension_undo_redo | 延長線と、戻る・進むが両方押せる状態 |
| P2_distance | 距離 3 点 |
| P3_area | 面積（右半分を囲む） |
| X4b_volume / X4c_angle | 体積（高さ 2400）／角度 |
| X5_magnifier_snap | 計測中の拡大鏡と吸着 |
| X6a_record_badges / X6b_records_list / X6c_records_copied | 記録の札／記録の一覧／コピー |
| P4a_inspect / P4b_layers / X7c_display | 属性／レイヤ／表示 |

## 手元で試す

```bash
NODE_ENV=development npx vite build --outDir /tmp/shot-dist
node tools/appstore-shots/inject.mjs /tmp/shot-dist
node tools/appstore-shots/local-test.mjs /tmp/shot-dist /tmp/shot-out 1032 1376 2
```
