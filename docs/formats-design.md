# DXF / SXF（SFC・P21）対応の設計

## 方針
- JwwDocument には寄せない。形式ごとに素直な文書モデル（DxfDocument、SxfDocument）を作り、形式をまたいで共通にするのは **Scene と LoadedInfo**。
- **JWW の経路は振る舞いを一切変えない。** geometry.ts から Builder・Palette を切り出すときは、先に `tools/scene-digest.ts`（samples/*.jww ごとに Scene の全型付き配列の FNV ハッシュ）で基準を取り、切り出し後に一致を必須にする。既存の verify・e2e・fuzz もすべて通す。
- レイヤの添字は 0〜255（Uint8）のまま。257 以上ある DXF は上位 255 に割り当て、残りを枠 255「その他のレイヤ（N 個）」にまとめて警告。

## ファイル
- `src/render/builder.ts`：Builder、Buf、arcSegments、finite4、apply/compose、上限の定数（MAX_*、MAX_COORD、TRUNCATED_WARNING）、`finishScene(b, opts)`。Palette は `ColorSource { base(pen): [r,g,b]; label(pen): string }` を受ける。Builder のオプション `{ arcTolerance, pointRadius(pen), scaleSlots }`（円弧の許容誤差は JWW では用紙 mm の 0.02。DXF は図面の範囲 ×1e-5 など）。
- `src/render/prim.ts`：`emitPolyline(b, xy, bulge?, closed, snapEnds)`（bulge は θ=4·atan(b) の円弧）、`emitConic(...)`（Scene.curves の形）、`emitFill(b, rings)`（穴付き耳切り。earcut は ISC で可）、`emitTextItem`、`emitSpline`（de Boor）、`emitClothoid`。
- `src/render/geometry.ts`：Jw の emit* と Jw の ColorSource・dashTable・paperRect を残す。`buildScene(doc: JwwDocument)` の名前と引数は変えない。
- `src/dxf/`：types.ts、tokenize.ts、parse.ts、scene.ts（buildDxfScene）、aci.ts、ltype.ts
- `src/sxf/`：types.ts（SFC と P21 で共通の SxfDocument）、sfc.ts、p21.ts、ap202.ts、scene.ts（buildSxfScene）、colors.ts
- `src/formats/`：detect.ts、load.ts（`loadDrawing(buffer, name, format) → {scene, info}`。worker と tools から共通に使う）、info.ts

## Scene と LoadedInfo（足すだけ）
- `Scene.scales` は長さ N の「縮尺の枠」の配列（JWW は 16）。entities.group に枠の番号（Uint8）。
- `Scene.origin?: [x, y]`：大きな座標は図面の中心を原点に寄せて書き出し、ずらした量を残す（Float32 の精度対策）。
- LoadedInfo：`format: 'jww'|'dxf'|'sfc'|'p21'`、`formatLabel`、`layerMode: 'jw'|'flat'`、`scaleSlots: {no,label,scale,used}[]`、`units?: {name,toMm,guessed}`、`paperLabel?`、`lineTypeNames?`、`extraCounts?`。既存の項目は残し、平らな形式では groups に 16 個の仮のグループを入れる。

## Jw_cad の前提と DXF・SXF での扱い
- レイヤ：DXF は表の順で 0..255、SXF は最大 256 なのでそのまま。layerMode='flat' では 0〜F の表記を出さず名前だけ。「Jw で非表示」の印は「元の図面で非表示」。
- レイヤ状態：DXF は表示オフ（色番号が負）・凍結（70&1）を state 0、ほかを 2。writeGroup=-1。SXF は lflag 0 を state 0。
- 色：DXF の pen は ACI 1〜255。BYLAYER/BYBLOCK はその場で解決。真の色（420）は pen=10 で図形ごとの rgb（ソリッドだけでなく全図形に広げる）。ラベルは「色 1（赤）」。SXF は既定 16 色＋利用者定義（17〜256）。
- 補助線種の枠 9 は DXF・SXF に割り当てない。
- 線種：DXF は LTYPE の長さを比にして 32 ビットの模様に近づける（2〜8,10,16〜63 に割り当て、溢れたら実線）。SXF は既定 15 種を仕様の比で、利用者定義は区切りの長さから。名前は lineTypeNames。
- 用紙：DXF は null（モデル空間）。SXF は drawing_sheet の矩形。
- 縮尺：DXF の枠 0 は「単位を mm に直す倍率 × 利用者が選んだ縮尺」。SXF の枠 0 は用紙（1/1）、部分図ごとに 1 枠（縮尺 = 1/倍率）。
- 部品：DXF はレイヤ 0 の中身だけ配置側のレイヤを継ぎ、BYBLOCK も解決。BLOCK の基点を差し引く。MINSERT も展開回数に数える。SXF は sfig_locate（作図部品・作図グループはレイヤを継がない。部分図は縮尺の枠を変える）。
- 文字：DXF は TEXT の寄せ（72/73）、MTEXT の基点（71）と書式記号（\P \f \S %%c %%d %%p \U+ \M+）。SXF は b_pnt 1〜9 と縦書き。
- 寸法：DXF の DIMENSION は匿名部品 *D… を展開し、線は KIND.dim、補助線は dimAux、MTEXT は dimText にして entText でつなぐ。SXF は linear/curve/angular/radius/diameter を同じ形で。
- KIND に polyline:9、spline:10、hatch:11（模様の線は吸着しない）を足す。inspect の KIND_LABEL・HAS_LINE_TYPE も。

## レイヤの見せ方
- `renderLayerList` に mode。'flat' はグループの行を出さず、図形のあるレイヤを名前の自然順で 1 列に。30 件を超えたら絞り込みの欄。LayerVisibility の中身（group[16]、layer[256]）はそのまま、グループは常にオン。
- 任意：Jw_cad が書き出した DXF のレイヤ名が Jw のグループ・レイヤの形なら組み直して 'jw' で出す（見本で名前の形を確かめてから）。

## 計測の縮尺
- DXF：$INSUNITS（4=mm 1、5=cm 10、6=m 1000、1=inch 25.4…）。0 は mm とみなし guessed。情報パネルに「単位」と「縮尺（1/1 既定、1/50、1/100…）」を出し、図面ごとに ViewState の dxfUnit・dxfScale に覚える。$DIMSCALE・$LTSCALE は見た目だけ。ペーパー空間は描かず警告。
- SXF：図形が属す部分図の枠の縮尺で自動。
- `toReal = 図面上の距離 × scale` の式は変えない。inspect の「図面上 mm」は形式で言い換え。

## 読み取り
- DXF（ASCII）：先頭 64KB を latin1 で読み $ACADVER と $DWGCODEPAGE。AC1021 以降は UTF-8、前で ANSI_932 は shift_jis、ほかは UTF-8 で読めなければ shift_jis。2 行ずつコード・値（行末の \r を取る）。段は HEADER、TABLES（LAYER、LTYPE、STYLE、BLOCK_RECORD）、BLOCKS、ENTITIES。図形は LINE、POINT、CIRCLE、ARC、ELLIPSE、LWPOLYLINE、POLYLINE/VERTEX/SEQEND（2D・ふくらみ）、SPLINE、TEXT、MTEXT、ATTRIB、ATTDEF（定数のみ）、INSERT（MINSERT）、DIMENSION、SOLID、TRACE、3DFACE（輪郭）、HATCH、LEADER。XLINE・RAY は範囲で切る。IMAGE・WIPEOUT・OLE・ACIS は読み飛ばして数を警告。OCS（210/220/230）は任意軸アルゴリズム。バイナリ DXF は任意。DWG（先頭 "AC10"）は「DXF で保存し直してください」と断る。
- SFC：`/*SXF … SXF*/` の中の `#n = xxx_feature(…)`。Shift_JIS（UTF-8 で読めればそちら）。引数の順は SXF Ver.3.x の「SFC ファイル仕様書」で必ず確かめる。
- P21：STEP の字句（'…'、''、\X2\…\X0\、\X\hh、\S\、$、*、.ENUM.、#n、入れ子）。#n を Map にため後から引く。複合インスタンスも。UTF-8 で読めなければ shift_jis。ap202.ts は SXF の実装規約の対応表の範囲だけを SxfDocument に。SFC と同じ buildSxfScene を使い、2 つの結果が同じかで確かめる。
- 上限：既存の MAX_* に加え、DXF のコード・値 3000 万組、部品の入れ子 16 段と自己参照の除外、MINSERT 行×列 ≤ 1 万、SPLINE 制御点 1 万、HATCH 境界頂点 100 万・模様の線 20 万本、P21 のインスタンス 500 万・参照の深さ 64・リストの入れ子 32。

## 見分け方と読み込みの流れ
- `detectFormat(head, name?)`：`JwwData.` は jww、`PK\3\4` は zip、`0\nSECTION`（999 の注釈可）は dxf、バイナリの印は dxfb、`ISO-10303-21;` は先頭に `/*SXF` があれば sfc なければ p21、"AC10" は dwg。拡張子は内容で決まらないときだけ。
- main.ts：rejectReason を detectFormat で書き直す。openPicked は先頭 4096 バイト。load() は形式を worker に渡す。ZIP は「図面（.jww/.dxf/.sfc/.p21）がありません」。既定の縮尺は JWW は今どおり、DXF は枠 0、SXF は線の多い枠。buildInfoPanel は形式ごと。jwFingerprint を drawingFingerprint（形式を含む）に。file.accept は `.jww,.dxf,.sfc,.p21,.zip,application/octet-stream`。
- worker：LoadRequest に format。DXF・SXF の読み取りは `await import()` で別チャンク（JWW の速さを保つ）。事前キャッシュに入ることを e2e:pwa で確かめる。
- zip.ts：drawingsInZip（.jww/.dxf/.sfc/.p21）。
- 保存：ViewState に dxfUnit?・dxfScale? を足すだけ。native.ts の既定名は形式に合わせて拡張子を付け直す。
- Info.plist：UTImportedTypeDeclarations に com.autodesk.dxf（dxf）、jp.or.jacic.sxf.sfc（sfc）、jp.or.jacic.sxf.p21（p21）。DocumentTypes は DXF と P21 は Alternate、SFC は Default、Role は Viewer。.stp/.step は扱わない。

## 段階
- **A**：土台（builder.ts・prim.ts の切り出し、ColorSource、Scene/LoadedInfo の追加、detect・load、worker の振り分け）と DXF の基本（文字コード、LAYER・LTYPE、LINE/ARC/CIRCLE/ELLIPSE/LWPOLYLINE/POLYLINE/POINT/TEXT/SOLID、ACI と真の色、INSERT（属性なし））、平らなレイヤ一覧、単位と縮尺の選択、ZIP、accept。
- **B**：DXF の細部（MTEXT の書式、TEXT の寄せ、ATTRIB、MINSERT、DIMENSION、HATCH、SPLINE、LEADER、OCS の全般、257 レイヤ以上、Jw_cad 書き出しのレイヤ名の組み直し）。
- **C**：SFC。**D**：P21。**E**：iOS・README・e2e-files・tools を loadDrawing 経由に。**F**（必要なら）：レイヤを Uint16 に。

## 検証
- 合成の見本：tools/dxf-synth.mjs、tools/sxf-synth.mjs（ふくらみの半円＝πr、楕円 1/4、入れ子・回転・反転の INSERT と基点、ATTRIB、R2000＋ANSI_932 の Shift_JIS、AC1021 の UTF-8、\U+、押し出し -1、穴のある HATCH の面積、実測値 42 の DIMENSION、1/100 の部分図の線の実寸、SFC と P21 で同じ Scene のハッシュ、\X2\、循環参照で暴走しないこと）。
- `tools/verify-formats.ts`（npm `verify:formats`）：同じ図面の .jww/.dxf/.sfc/.p21 を loadDrawing で読み、種類ごとの数、枠ごとの実寸の範囲（0.1% 以内）、線の実寸の長さの一致率とずれの最大、寸法値、文字列の一致率（件数とハッシュだけ）、レイヤ・色の数、塗りの面積を比べる。閾値を下回れば exit 1。**samples/ のファイル名や中身は出力しない。**
- 非公開でない見本：利用者が test1.jww（public/sample.jww と同じ図面）を Jw_cad で DXF・SFC・P21 に書き出してくれる予定（デスクトップの test1 フォルダ）。届いたら tools の見本として使う。

## 段階 A で設計から変えたこと
- **真の色の線色番号は 10 ではなく 1100（`TRUE_COLOR_PEN`）。** ACI の 10 番は実在の色（赤）なので重ねられない。呼び名は「真の色」。図形ごとの rgb は JWW と同じ COLORREF（0xBBGGRR）で entities.rgb に入れる。Palette の任意色は線色番号によらず custom があれば RGB ごとの色番号にする（JWW は今も 10 のときだけ渡すので結果は同じ）。
- **fit.ts を足した。** fitScene・fitRange などの「全体」の範囲は geometry.ts から fit.ts へ移し、finishScene から循環なく使えるようにした。geometry.ts は builder.ts・fit.ts を再輸出するので、既存の import はそのまま。
- Builder のオプションは `{ arcTolerance, pointRadius(pen) }` だけ。縮尺は finishScene に `{ paper, dashes, scales, origin? }` で渡す。部品名は `blockOf(key, name())`（JWW は定義番号、DXF は大文字の名前）。
- **DXF の Scene.scales も長さ 16（すべて同じ値）**、entities.group は 0。`layer >> 4` で縮尺を引く古い経路があっても壊れないように。LoadedInfo.scaleSlots は 1 枠（「モデル空間」）。paperLabel はまだ使わないので足していない。
- 利用者が選ぶ単位・縮尺は worker では掛けず、画面側（main.ts の applyDxfScale）で scene.scales を書き換え、置いてある点の縮尺も入れ直す。ViewState には dxfUnit（$INSUNITS の番号、null は図面の指定）と dxfScale（分母）。
- drawingFingerprint：JWW は今までと同じ文字列（覚えてある表示の状態を無駄にしない）。ほかの形式は先頭に形式名を入れる。
- LoadedInfo の型は src/formats/info.ts に置き、jww/info.ts と jww/worker.ts から再輸出。
- ~~LWPOLYLINE・POLYLINE のふくらみの弧は Scene.curves に入れない。~~ → 段階 B で解消（下の「段階 B で設計から変えたこと」）。
- 線種の模様は 1 周期およそ 24 ビット、1 ビット 1 ドット。割り当ては 2〜8, 10, 16〜63 の順で、溢れたら実線。
- 円弧の許容誤差は $EXTMIN・$EXTMAX（なければモデル空間の図形の代表点）の大きいほうの辺 × 1e-5。座標を寄せるのは、範囲の中心が原点から「大きさの 4 倍」かつ 1e4 単位以上離れているときだけ。
- OCS は押し出しの z が負のときだけ（x の反転）。CIRCLE・ARC・LWPOLYLINE・POLYLINE・TEXT・SOLID・INSERT は反転の変換を掛け、ELLIPSE（WCS）は短軸の向きを逆にする。任意軸アルゴリズムは B。
- TEXT は 10/20 を左下として描く（72/73 の寄せは B）。文字列の長さは「全角 1・半角 0.5 × 高さ × 幅係数」の見積もり。%%c・%%d・%%p・%%%・\U+XXXX は A で直す。
- MINSERT は 1 つだけ置き、「MINSERT の繰り返し」として読み飛ばしの数に出す。ATTRIB は黙って読み飛ばす。
- 平らなレイヤ一覧のために LayerVisibility に `flat` を足した（「このレイヤだけ」と反転はレイヤだけで行い、グループは常に表示）。属性の「レイヤ」も名前だけにする。
- 開けないファイルの知らせは「JWW・DXF ファイルではありません」に変えた（e2e:robust の期待も合わせた）。file.accept は iOS アプリで `.jww,.dxf,.zip,application/octet-stream`（.sfc・.p21 は C・D で足す）。Web 版はもともと accept なし。
- Info.plist の UTImportedTypeDeclarations と native.ts の既定名は E にまわした。
- e2e は tools/e2e-dxf.mjs（ポート 5324、npm run e2e:dxf）に分けた。e2e:files には ZIP の中の .dxf を足した。既存の吸着の決まりで、線の上ちょうどを触ると「線上」が端点に勝つので、端を測るときは端の少し外側を触る。

## 段階 B で設計から変えたこと
- **1 つの図形に複数の曲線の式。** `Scene.curveLines?: Uint32Array`（式ごとに [最初の線分, 本数]）を足し、snap.ts の curveIndex は「線分 → 式」の表を返す（無い古い Scene は図形の線分すべて）。Builder.addCurve は省略できる from を取り、JWW は今までどおり呼ぶだけ（指紋は同じ）。折れ線のふくらみの弧は式を持ち、線上・交点・弧の中点・中心が弧の上になる。HATCH の境界は描かないので式は持たない。
- KIND.spline=10、KIND.hatch=11 を足した（inspect の呼び名も）。HATCH の entities.size は塗った面積（模様だけなら 0）。
- OCS は任意軸アルゴリズムで、OCS の点 (x, y, 高さ) を WCS の XY に写す 2x3 の変換（ocs.ts）。座標が OCS の図形（CIRCLE・ARC・LWPOLYLINE/POLYLINE・TEXT・ATTRIB・SOLID/TRACE・INSERT・HATCH）に掛ける。ELLIPSE は短軸を N × 長軸で求める。傾いた押し出しの円は楕円に写る。
- TEXT の寄せ：縦の「下」（73=1）は基線と同じに扱う。両端揃え（72=3）は 2 点の間に収まるよう高さも変え、フィット（72=5）は長さだけ。文字の長さは今までどおりの見積もり。
- MTEXT は行ごとに SceneText を 1 つ（図形は 1 つ、entText は 1 行目）。\S の積み重ねは「a/b」の 1 行、\f・\C などの書体・色は使わず外す。行間は 5/3 × 高さ × 44。幅（41）があれば見積もりの長さで折り返す（空白があればそこで）。
- DIMENSION：匿名部品の中で、補助線の起点（13・14）を通る向きの線を dimAux（吸着しない）、ほかの線・弧・矢印を dim、文字を dimText にして、全部の entText を寸法値の文字へ。定義点の POINT は描かない。実測値（42）は buildDxfScene の戻り値 `dimensions` に残す（verify-dxf で寸法値・寸法線の長さと突き合わせる）。寸法の中身は線・文字の数に入れず、図面情報の寸法の数は DIMENSION の数。
- ATTRIB は配置した側の座標でそのまま描く（見えない 70&1 は描かない）。ATTDEF は定数（70&2）だけ部品の中の文字として描く。
- MINSERT は列・行の間隔に回転だけ掛けて並べる（倍率は掛けない）。行 × 列が 1 万を超えたら行を減らして警告。1 つずつ展開の数に数える。
- HATCH：境界（折れ線とふくらみ、線・円弧・楕円弧・スプラインの辺）を点列にし、輪の入れ子の深さで外周と穴に分けて（偶奇）earcut で塗る。時計回りの辺の角度は x 軸で裏返して読む。模様の線は DXF に書かれた族（角度・基点・ずれ・破線。すでに縮尺と角度が掛かったもの）を輪で切る。点（長さ 0）は描かない。図面全体で 20 万本、交わりの計算 2000 万回で打ち切って警告。グラデーションは描かない。
- SPLINE は de Boor（有理も）。節点の区間ごとに、真ん中の点と弦の隔たりが円弧の許容誤差以内になるまで分ける。節点が使えなければ両端固定の一様な節点。通過点だけのものは Catmull-Rom で近似。吸着は折れ線の上（両端だけ端点）。
- LEADER は折れ線と、始めの点の塗りの矢印（大きさは $DIMASZ × $DIMSCALE、無ければメートル系 2.5・インチ系 0.18）。スプラインの経路は Catmull-Rom。図形の種類は折れ線。
- XLINE・RAY は図面の範囲（$EXTMIN/$EXTMAX、なければ代表点）を 5% 広げた矩形で切る。切った端は端点にしない（RAY の始点だけ端点）。
- 3DFACE は見える辺だけの輪郭（折れ線）、TRACE は SOLID と同じ。
- 257 個以上のレイヤは段階 A のまま（255 番に「その他のレイヤ（N 個）」）で、verify-dxf で確かめた。
- **Jw_cad 書き出しのレイヤ名の組み直しと verify-formats.ts はまだ。** 見本（デスクトップの test1 フォルダの test1.dxf・.sfc・.p21）がまだ無く、名前の形を確かめられないため。

## 段階 B の残り（見本が届いたら）
- test1.dxf のレイヤ名の形を確かめ、Jw_cad の形ならグループ・レイヤを組み直して layerMode='jw' で出す。
- tools/verify-formats.ts（npm `verify:formats`）：test1.jww と test1.dxf を loadDrawing で読み、枠ごとの実寸の範囲、線の長さの多重集合、文字の多重集合、寸法値を比べる。
