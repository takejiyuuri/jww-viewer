import type { Reader } from './reader.ts';
import type { JwwHeader, JwwLayerGroup } from './types.ts';

/** SXF 拡張色の色番号オフセット */
const SXCOL_EXT = 100;

/**
 * JWW ヘッダを読む。
 * 図形データの開始位置を正しく決めるため、使わない項目も全て読み進める必要がある。
 * バージョン分岐は jwwlib (LibreCAD) の実装および Jw_cad 公開データ形式に準拠。
 */
export function parseHeader(r: Reader): JwwHeader {
  const magic = r.ascii(8);
  if (magic !== 'JwwData.') {
    throw new Error(`JWW ファイルではありません (先頭 8 バイトが "${magic}")`);
  }
  const version = r.u32();
  if (version !== 230 && version < 300) {
    throw new Error(`未対応の JWW バージョンです (内部バージョン ${version})`);
  }

  const memo = r.str();
  const paperSize = r.u32();
  const writeGroup = r.u32();

  const groups: JwwLayerGroup[] = [];
  for (let g = 0; g < 16; g++) {
    const state = r.u32();
    const writeLayer = r.u32();
    const scale = r.f64();
    const protect = r.u32();
    const layers = [];
    for (let l = 0; l < 16; l++) {
      layers.push({ state: r.u32(), protect: r.u32(), name: '' });
    }
    groups.push({ state, writeLayer, scale, protect, name: '', layers });
  }

  r.skip(14 * 4); // ダミー
  r.skip(5 * 4);  // 寸法設定 m_lnSunpou1-5
  r.skip(4);      // ダミー
  r.skip(4);      // 線描画の最大幅
  r.skip(8 * 2);  // プリンタ出力範囲の原点
  r.skip(8);      // プリンタ出力倍率
  r.skip(4);      // プリンタ 90 度回転出力
  r.skip(4);      // 目盛設定モード
  r.skip(8);      // 目盛表示最小間隔ドット
  r.skip(8 * 2);  // 目盛表示間隔 X,Y
  r.skip(8 * 2);  // 目盛基準点 X,Y

  for (let g = 0; g < 16; g++) {
    for (let l = 0; l < 16; l++) groups[g].layers[l].name = r.str();
  }
  for (let g = 0; g < 16; g++) groups[g].name = r.str();

  r.skip(8);  // 日影 測定面高さ
  r.skip(8);  // 日影 緯度
  r.skip(4);  // 日影 9-15 時測定
  r.skip(8);  // 壁面日影測定面高さ
  if (version >= 300) {
    r.skip(8); // 天空図 測定面高さ
    r.skip(8); // 天空図 半径*2
  }
  r.skip(4);  // 2.5D の計算単位

  const zoom = r.f64();
  const originX = r.f64();
  const originY = r.f64();

  r.skip(8 * 3); // 範囲記憶倍率と基準点

  if (version >= 300) {
    r.skip(8 * (8 * 3) + 4 * 8); // マークジャンプ 8 個 (倍率,X,Y,レイヤグループ)
    r.skip(8 * 3 + 4 + 8 * 3);   // 文字の描画状態 (ダミー含む)
    r.skip(4);                   // m_nMojiBG
  } else {
    r.skip(4 * (8 * 3)); // マークジャンプ 4 個 (倍率,X,Y)
  }

  r.skip(10 * 8); // 複線間隔
  r.skip(8);      // 両側複線の留線出

  const penColors: { rgb: number; width: number }[] = [];
  for (let i = 0; i <= 9; i++) {
    penColors.push({ rgb: r.u32(), width: r.u32() });
  }
  for (let i = 0; i <= 9; i++) {
    r.skip(4 + 4 + 8); // プリンタ出力色・線幅・実点半径
  }
  for (let i = 2; i <= 9; i++) r.skip(4 * 4);   // 線種 2-9
  for (let i = 11; i <= 15; i++) r.skip(4 * 5); // ランダム線 1-5
  for (let i = 16; i <= 19; i++) r.skip(4 * 4); // 倍長線種 6-9

  r.skip(4 * 11); // 実点描画〜表示のみレイヤ非出力 の各フラグ
  r.skip(4);      // 作図時間
  r.skip(4);      // 2.5D 視点設定済フラグ
  r.skip(4 * 3);  // 2.5D 視点水平角
  r.skip(8 * 5);  // 2.5D 視点高さ・離れ・垂直角
  r.skip(8 * 4);  // 線長・矩形寸法 XY・円半径の最終値
  r.skip(4);      // ソリッド任意色フラグ
  r.skip(4);      // ソリッド任意色

  const sxfColors: { rgb: number; width: number }[] = [];
  const sxfColorNames: string[] = [];
  const sxfLineTypeNames: string[] = [];
  if (version >= 420) {
    for (let n = 0; n <= 256; n++) {
      sxfColors.push({ rgb: r.u32(), width: r.u32() });
    }
    for (let n = 0; n <= 256; n++) {
      sxfColorNames.push(r.str()); // 線色名
      r.skip(4 + 4 + 8); // プリンタ出力色・線幅・点半径
    }
    for (let n = 0; n <= 32; n++) r.skip(4 * 4); // SXF 線種パターン
    for (let n = 0; n <= 32; n++) {
      sxfLineTypeNames.push(r.str()); // 線種名
      r.skip(4);     // セグメント数
      r.skip(10 * 8); // ピッチ
    }
  }

  for (let i = 1; i <= 10; i++) r.skip(8 * 3 + 4); // 文字種 1-10
  r.skip(8 * 3);  // 書込み文字 幅・高さ・間隔
  r.skip(4 * 2);  // 書込み文字 色番号・文字番号
  r.skip(8 * 2);  // 文字位置整理 行間・文字数
  r.skip(4);      // 文字基準点ずれ使用フラグ
  r.skip(8 * 3);  // 文字基準点 横ずれ 左中右
  r.skip(8 * 3);  // 文字基準点 縦ずれ 下中上

  return {
    version,
    memo,
    paperSize,
    writeGroup,
    groups,
    penColors,
    sxfColors,
    sxfColorNames,
    sxfLineTypeNames,
    zoom,
    originX,
    originY,
  };
}

export { SXCOL_EXT };
