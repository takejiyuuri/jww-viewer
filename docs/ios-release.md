# iOS アプリ「JWWミテハカール」を Mac なしで App Store へ出す手順

Windows PC だけで開発し、ビルドはクラウドの Mac（Codemagic）で行い、App Store Connect → TestFlight → App Store へ進める。
Apple と Codemagic の操作は、すべて Windows のブラウザでできる（Mac も Xcode も使わない）。

```
Windows（開発・テスト） → GitHub（main に push） → Codemagic（クラウドの Mac でビルド・署名）
  → App Store Connect（アップロードを受け取る） → TestFlight（iPhone で試す） → 審査 → App Store（300 円）
```

## 仕組み

- Web 版（Vite）の本体 `dist/` を、Capacitor で iOS アプリに**同梱**する。公開中の GitHub Pages を読み込むのではなく、
  端末の中のファイルを表示するので、電波がなくても表示・計測できる（`capacitor.config.ts` に `server.url` は置かない）。
- iOS アプリだけの働き（`src/native.ts`、`ios/App/App/Info.plist`）
  - .jww を「Jw_cad 図面」という書類の種類として登録している。「ファイル」アプリの .jww や、メール・チャットなどの
    共有メニューから「JWWミテハカール」を選んで開ける
  - 最近開いた図面（10 件まで）をアプリの中に取っておき、「ファイル」の一覧から開き直せる（Web 版も同じ）
  - 点を置いた・図形を選んだときの触覚の手応え、背景の白黒に合わせたステータスバーの色
  - 縦・横どちらの向きでも使える（横向きではボタンを縦に並べる）
- iOS のプロジェクトは Swift Package Manager 方式で、CocoaPods を使わない。Windows でも `npx cap sync ios` まで済む。

## 作業の分担

| どこで | 何をする | いつ |
| --- | --- | --- |
| **Windows** | コードを直す・テスト（`npm run check`、`npm run e2e:*`）・`npm run ios:sync`・コミットして GitHub へ push | 毎回 |
| **Windows** | アイコンを変えたら `python tools/make_icons.py`（Web 版と iOS のアイコン・起動画面を作り直す） | 必要なとき |
| **Windows** | 新しい版を出すときは、版番号（`MARKETING_VERSION`）を上げる（下の「版を上げる」） | 版ごと |
| **GitHub** | main に push すると、Web 版は GitHub Actions で自動的に GitHub Pages へ出る（iOS には関係しない） | 自動 |
| **Codemagic（ブラウザ）** | 初回：アカウント・リポジトリの登録、App Store Connect API キーの登録、証明書とプロファイルの用意 | 最初だけ |
| **Codemagic（ブラウザ）** | 「iOS ビルド確認（署名なし）」「iOS → TestFlight」のワークフローを手動で始める | 毎回 |
| **Apple（ブラウザ）** | 初回：Apple Developer Program への登録、Bundle ID、API キー、アプリの登録、有料アプリの契約・税・口座 | 最初だけ |
| **Apple（ブラウザ）** | TestFlight でテスターを選ぶ、審査に出す情報（説明文・スクリーンショットなど）を入れて審査に出す | 版ごと |
| **iPhone** | TestFlight アプリから試用版を入れて確かめる | 版ごと |

## 最初の 1 回だけの準備

### 1. Apple（ブラウザ）

1. **Apple Developer Program に登録する**（https://developer.apple.com/programs/ 、年会費が必要）。
   個人か法人かで、App Store に出る「販売者名」が変わる（個人なら本名）。
2. **Bundle ID を登録する**：Certificates, Identifiers & Profiles → Identifiers → ＋ → App IDs → App。
   - Description：`JWW Mitehakaru`
   - Bundle ID（Explicit）：`io.github.takejiyuuri.mitehakaru`
   - Capabilities：何も付けなくてよい
3. **App Store Connect API キーを作る**：App Store Connect → ユーザとアクセス → 統合 → App Store Connect API → チームキー → ＋。
   - 名前：`codemagic`、アクセス：**App Manager**
   - 作ったら **Issuer ID**・**キー ID**・**.p8 ファイル**（ダウンロードは 1 回だけ）を控える
4. **アプリを登録する**：App Store Connect → アプリ → ＋ → 新規 App。
   - プラットフォーム：iOS / 名前：`JWWミテハカール` / プライマリ言語：日本語 /
     バンドル ID：`io.github.takejiyuuri.mitehakaru` / SKU：`mitehakaru-ios`（自由な管理用の文字）/ ユーザアクセス：フルアクセス
   - 作ったあと「App 情報」に出る **Apple ID（数字）** を、`codemagic.yaml` の `vars` に `APP_STORE_APPLE_ID: 1234567890` の形で
     1 行足して push する（任意。足すとビルド番号を TestFlight の続きにする。空の値は書けないので、分かるまでは行ごと置かない）
5. **有料アプリの準備**（300 円で売るのに必要。TestFlight だけなら後でもよい）：
   App Store Connect → ビジネス → **有料 App 契約**に同意し、**税務情報**と**銀行口座**を登録する。
   あわせて **EU デジタルサービス法（DSA）のトレーダー申告**も済ませる（最初の提出の前に必要）。
   EU の国で有料アプリを売るとトレーダーとなり、住所・電話・メールが EU のストアに公開される。
   公開したくなければ「価格および配信状況」で EU の国・地域を外し、トレーダーではないと申告する。

### 2. Codemagic（ブラウザ）

1. https://codemagic.io に GitHub アカウントで登録し、`takejiyuuri/jww-viewer` を Add application する
   （種類は「Other」または codemagic.yaml を使う設定。ルートの `codemagic.yaml` が読まれる）。
2. **API キーを登録**：Team settings → Team integrations → Developer Portal → Manage keys → Add key。
   - 名前は **`codemagic-asc`**（`codemagic.yaml` の `integrations.app_store_connect` と同じ名前にする）
   - Issuer ID・キー ID・.p8 ファイルを入れる
3. **配布用の証明書を用意**：Team settings → codemagic.yaml settings → Code signing identities → iOS certificates →
   **Generate certificate**（種類は Apple Distribution）。Codemagic が作って保管する（Mac の「キーチェーン」は要らない）。
4. **プロファイルを用意**：同じ画面の iOS provisioning profiles → **Fetch profiles** で、
   `io.github.takejiyuuri.mitehakaru` の **App Store** 用プロファイルを取り込む（無ければ Apple Developer の Profiles で
   「App Store Connect」配布のプロファイルを作ってから取り込む）。
5. まず **「iOS ビルド確認（署名なし）」**（`ios-check`）を始めて、iOS プロジェクトがビルドできることを確かめる。
   Apple 側の準備が済む前から使える。
6. **「iOS → TestFlight」**（`ios-testflight`）を始める。成功すると App Store Connect にビルドが届き、処理が済むと
   （数分〜数十分）社内テスターがそのまま TestFlight で入れられる。社外のテスターに配るときは、TestFlight → テスト情報を
   入れてから `codemagic.yaml` の `submit_to_testflight` を `true` にする（社外向けは毎回 Beta App Review の審査がある）。

### 3. TestFlight で試す

1. App Store Connect → アプリ → TestFlight → 内部テスト → テスターを追加（App Store Connect のユーザ。最大 100 人）。
2. iPhone に **TestFlight** アプリを入れ、届いた招待から「JWWミテハカール」を入れる。
3. 確かめること：「ファイル」アプリの .jww をタップ →共有 →「JWWミテハカール」で開ける／メールの添付 .jww から開ける／
   「ファイル」の一覧から最近の図面を開き直せる／機内モードでも開いて測れる／縦横の回転／計測・拡大鏡・レイヤ。

## Apple 側で必要な情報の一覧

| 項目 | 入れる所 | 値・決めること | 状態 |
| --- | --- | --- | --- |
| Apple Developer Program | developer.apple.com | 個人／法人、年会費 | 要登録 |
| Bundle ID | Identifiers | `io.github.takejiyuuri.mitehakaru`（最初のアップロード後は変えられない） | 決定（変えるなら今） |
| App Store Connect API キー | ユーザとアクセス → 統合 | Issuer ID・キー ID・.p8、権限 App Manager | 要作成 |
| 配布用証明書 | Codemagic で生成 | Apple Distribution | 要作成 |
| プロファイル | Codemagic で取り込み | App Store 用、Bundle ID は上と同じ | 要作成 |
| アプリ名 | 新規 App | `JWWミテハカール`（30 文字以内。ほかのアプリと同じ名前は不可） | 決定 |
| サブタイトル | App 情報 | 30 文字以内。例：「Jw_cad 図面を見て測る」 | 要決定 |
| プライマリ言語 | 新規 App | 日本語 | 決定 |
| SKU | 新規 App | 例：`mitehakaru-ios` | 要決定 |
| カテゴリ | App 情報 | 例：仕事効率化（副：ユーティリティ） | 要決定 |
| 価格 | 価格および配信状況 | **300 円**（買い切り）、配信する国・地域 | 決定 |
| 有料 App 契約・税務・銀行口座 | ビジネス | 売るのに必要 | 要登録 |
| EU デジタルサービス法（DSA）のトレーダー申告 | ビジネス（または初回提出時） | 最初の提出の前に必ず申告。EU で売るなら住所・電話・メールが公開される。公開したくなければ EU を配信先から外して「トレーダーではない」と申告 | 要決定 |
| 著作権 | App 情報 | 例：`2026 takejiyuuri` | 要決定 |
| 年齢制限 | App 情報 → 年齢制限 | 質問にすべて「なし」→ 4+ の見込み | 要回答 |
| App のプライバシー | App のプライバシー | 「データを収集しない」 | 決定 |
| プライバシーポリシー URL | App 情報 | https://takejiyuuri.github.io/jww-viewer/privacy.html | 用意済み |
| サポート URL | バージョン情報 | https://takejiyuuri.github.io/jww-viewer/support.html（問い合わせ先は GitHub Issues。メールにするなら直す） | 用意済み（要確認） |
| 説明文・キーワード・このバージョンの新機能 | バージョン情報 | 説明文 4,000 文字以内、キーワード 100 文字以内 | 要作成 |
| スクリーンショット | バージョン情報 | iPhone 6.9 インチ（1320×2868 など）を 3〜10 枚。**顧客の図面は使わない**（見本の図面で撮る） | 要作成 |
| 輸出コンプライアンス（暗号） | ビルドごと | 暗号を使っていないので「いいえ」。`ITSAppUsesNonExemptEncryption = NO` を入れてあるので毎回は聞かれない | 設定済み |
| プライバシーマニフェスト | アプリに同梱 | `ios/App/App/PrivacyInfo.xcprivacy`：追跡なし・収集なし。ファイルの日時を読む API（ファイル操作のプラグインが使う）を理由 C617.1 で申告 | 設定済み |
| 審査用メモ | App Review に関する情報 | 審査員が試せる**見本の .jww**（顧客の図面でないもの）の入手方法。連絡先の氏名・電話・メール | 要準備 |

## 審査で「単なる Web サイトの枠」と見なされないために

- 本体をアプリに同梱し、電波がなくても表示・計測できる（公開中のサイトを読み込まない）。
- iOS の書類として .jww を登録し、「ファイル」アプリや共有メニューから開ける。最近開いた図面をアプリの中に持つ。
- 触覚の手応え、ステータスバー、縦横の回転など、端末の働きに合わせている。
- 審査員が図面を持っていないと「何もできないアプリ」に見えるので、**見本の .jww を必ず渡す**
  （審査用メモに入手方法を書く。できれば、顧客の図面ではない見本を用意してもらえれば、アプリに「見本を開く」を付けられる）。

## 版を上げる（2 回目以降の提出）

- App Store に出る版番号は `ios/App/App.xcodeproj/project.pbxproj` の `MARKETING_VERSION`（2 か所、今は `1.0`）。
  新しい版を出すときは、Windows のエディタで 2 か所とも `1.1` などに書き換えてコミットする。
- ビルド番号（`CURRENT_PROJECT_VERSION`）は Codemagic が自動で上げる。

## うまくいかないとき

- Codemagic のビルドが失敗したら、まず `ios-check`（署名なし）で通るかを見る。通るなら署名の設定（API キーの名前、
  証明書、プロファイルの Bundle ID）を見直す。
- `npm ci` で失敗するときは、Windows で `npm install` し直して `package-lock.json` をコミットする。
- Codemagic の画面で「無効な yaml 設定」「検証エラー」と出たら、`codemagic.yaml` の書き方の誤り。赤い印を押すと場所が出る
  （たとえば `vars` に空の値 `""` は書けない）。
