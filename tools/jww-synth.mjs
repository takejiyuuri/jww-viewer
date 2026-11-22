// 検証用に、小さな .jww をその場で組み立てる（実際の図面は使わない）。
// ヘッダは src/jww/header.ts が読む順に、使わない項目を 0 で埋めて書く。
// 図形は線・文字・部品の配置と部品の定義だけを書ける。壊れた座標や、入れ子の部品の爆弾、同梱画像の末尾を作るのに使う。

class Out {
  constructor() {
    this.buf = new Uint8Array(1 << 16);
    this.view = new DataView(this.buf.buffer);
    this.len = 0;
  }

  room(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v) { this.room(1); this.view.setUint8(this.len, v); this.len += 1; }
  u16(v) { this.room(2); this.view.setUint16(this.len, v, true); this.len += 2; }
  u32(v) { this.room(4); this.view.setUint32(this.len, v >>> 0, true); this.len += 4; }
  f64(v) { this.room(8); this.view.setFloat64(this.len, v, true); this.len += 8; }
  zeros(n) { this.room(n); this.buf.fill(0, this.len, this.len + n); this.len += n; }
  ascii(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i) & 0xff); }

  /** JWW の文字列（ASCII のみ）。長さ 1 バイト、255 以上は 0xFF と WORD */
  str(s) {
    if (s.length < 0xff) this.u8(s.length);
    else { this.u8(0xff); this.u16(s.length); }
    this.ascii(s);
  }

  /** CObList の要素数 */
  count(n) {
    if (n < 0xffff) this.u16(n);
    else { this.u16(0xffff); this.u32(n); }
  }

  bytes() { return this.buf.slice(0, this.len); }
}

const VERSION = 700;

function header(o, scale = 1, layerNames = {}, groupNames = []) {
  o.ascii('JwwData.');
  o.u32(VERSION);
  o.str('');   // メモ
  o.u32(3);    // 用紙 A3
  o.u32(0);    // 書込レイヤグループ
  for (let g = 0; g < 16; g++) {
    o.u32(g === 0 ? 3 : 2); // 状態（書込・編集可）
    o.u32(0);               // 書込レイヤ
    o.f64(scale);           // 縮尺
    o.u32(0);               // プロテクト
    for (let l = 0; l < 16; l++) { o.u32(g === 0 && l === 0 ? 3 : 2); o.u32(0); }
  }
  o.zeros(14 * 4 + 5 * 4 + 4 + 4 + 8 * 2 + 8 + 4 + 4 + 8 + 8 * 2 + 8 * 2);
  for (let i = 0; i < 256; i++) o.str(layerNames[i] ?? ''); // レイヤ名（グループ × 16 + レイヤ の順）
  for (let i = 0; i < 16; i++) o.str(groupNames[i] ?? '');  // レイヤグループ名
  o.zeros(8 + 8 + 4 + 8 + 8 + 8 + 4);      // 日影・天空図・2.5D の計算単位
  o.f64(1); o.f64(0); o.f64(0);             // 画面倍率・原点
  o.zeros(8 * 3);
  o.zeros(8 * (8 * 3) + 4 * 8 + 8 * 3 + 4 + 8 * 3 + 4);
  o.zeros(10 * 8 + 8);
  for (let i = 0; i <= 9; i++) { o.u32(0xffffff); o.u32(1); } // 線色 0〜9 は白
  o.zeros(10 * (4 + 4 + 8) + 8 * 16 + 5 * 20 + 4 * 16);
  o.zeros(4 * 11 + 4 + 4 + 4 * 3 + 8 * 5 + 8 * 4 + 4 + 4);
  for (let n = 0; n <= 256; n++) { o.u32(0xffffff); o.u32(1); }
  for (let n = 0; n <= 256; n++) { o.str(''); o.zeros(4 + 4 + 8); }
  o.zeros(33 * 16);
  for (let n = 0; n <= 32; n++) { o.str(''); o.zeros(4 + 10 * 8); }
  o.zeros(10 * (8 * 3 + 4) + 8 * 3 + 4 * 2 + 8 * 2 + 4 + 8 * 3 + 8 * 3);
}

/**
 * .jww のバイト列を作る。
 * doc: { entities: Entity[], defs?: { no, name?, entities: Entity[] }[], images?: { name, bytes }[] }
 * Entity: { line: [x1, y1, x2, y2], color? } | { text: string, at?: [x, y], angle?, size?, color? } | { ref: defNo, at?: [x, y] }
 *   | { dim: [x1, y1, x2, y2], value: string, size?, textLayer? }（寸法図形。値は寸法線の上の中ほどに書く）
 *   | { point: [x, y] } | { solid: [x1, y1, x2, y2, x3, y3, x4, y4] }（4 点を順に回る塗り）
 *   どの図形も layer: [グループ, レイヤ]（既定 [0, 0]）を付けられる。寸法の値だけ別のレイヤにするなら textLayer
 * doc.scale はすべてのレイヤグループの縮尺の分母（既定 1）。
 * doc.layerNames は { グループ × 16 + レイヤ: 名前 }、doc.groupNames はグループ名の配列（どちらも ASCII のみ）
 */
export function makeJww(doc) {
  const o = new Out();
  header(o, doc.scale ?? 1, doc.layerNames ?? {}, doc.groupNames ?? []);
  // CArchive のクラス番号。新しいクラスはそのときの番号で登録し、クラスと直後のオブジェクトで 2 つ進む
  const classes = new Map();
  let mapCount = 1;
  const tag = (name) => {
    const idx = classes.get(name);
    if (idx === undefined) {
      o.u16(0xffff); o.u16(1); o.u16(name.length); o.ascii(name);
      classes.set(name, mapCount);
      mapCount += 2;
    } else {
      o.u16(0x8000 | idx);
      mapCount += 1;
    }
  };
  const common = (penStyle = 1, color = 1, layer = [0, 0]) => {
    o.u32(0); o.u8(penStyle); o.u16(color); o.u16(1); o.u16(layer[1] & 15); o.u16(layer[0] & 15); o.u16(0);
  };
  /** 文字の中身（CDataMoji の共通部より後ろ）。始点・角度（度）・字の高さ */
  const textBody = (str, x, y, angle = 0, size = 2.5) => {
    const w = str.length * size * 0.8;
    const a = (angle * Math.PI) / 180;
    o.f64(x); o.f64(y); o.f64(x + Math.cos(a) * w); o.f64(y + Math.sin(a) * w);
    o.u32(1); o.f64(size * 0.8); o.f64(size); o.f64(0); o.f64(angle);
    o.str('');
    o.str(str);
  };
  const entity = (e) => {
    const L = e.layer ?? [0, 0];
    if (e.line) {
      tag('CDataSen');
      common(e.style ?? 1, e.color ?? 1, L);
      for (const v of e.line) o.f64(v);
    } else if (e.point) {
      tag('CDataTen');
      common(1, e.color ?? 1, L);
      o.f64(e.point[0]); o.f64(e.point[1]); o.u32(0);
    } else if (e.solid) {
      const [x1, y1, x2, y2, x3, y3, x4, y4] = e.solid;
      tag('CDataSolid');
      common(1, e.color ?? 1, L);
      // 格納順は 第1点 -> 第4点 -> 第2点 -> 第3点
      for (const v of [x1, y1, x4, y4, x2, y2, x3, y3]) o.f64(v);
    } else if (e.dim) {
      const [x1, y1, x2, y2] = e.dim;
      const size = e.size ?? 2.5;
      const a = Math.atan2(y2 - y1, x2 - x1);
      const w = e.value.length * size * 0.8;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      // 値の始点：寸法線の中ほどから、文字の幅の半分だけ戻し、少し上へ
      const tx = mx - Math.cos(a) * w / 2 - Math.sin(a) * 0.6;
      const ty = my - Math.sin(a) * w / 2 + Math.cos(a) * 0.6;
      const TL = e.textLayer ?? L;
      tag('CDataSunpou');
      common(1, 1, L);
      common(1, 1, L); for (const v of e.dim) o.f64(v);       // 寸法線
      common(0, 1, TL); textBody(e.value, tx, ty, (a * 180) / Math.PI, size); // 寸法値
      // Ver.4.20 以降：SXF の種類・補助線 2 本・矢印 2 点・基準点 2 点
      o.u16(0);
      const ext = e.ext ?? 4;
      const nx = -Math.sin(a) * ext, ny = Math.cos(a) * ext;
      common(1, 1, L); o.f64(x1 - nx); o.f64(y1 - ny); o.f64(x1 + nx * 0.3); o.f64(y1 + ny * 0.3);
      common(1, 1, L); o.f64(x2 - nx); o.f64(y2 - ny); o.f64(x2 + nx * 0.3); o.f64(y2 + ny * 0.3);
      for (const [px, py] of [[x1, y1], [x2, y2], [x1 - nx, y1 - ny], [x2 - nx, y2 - ny]]) {
        common(1, 1, L); o.f64(px); o.f64(py); o.u32(1);
      }
    } else if (e.text !== undefined) {
      const [x, y] = e.at ?? [0, 0];
      tag('CDataMoji');
      common(0, e.color ?? 1, L);
      if (e.angle !== undefined || e.size !== undefined) {
        textBody(e.text, x, y, e.angle ?? 0, e.size ?? 2.5);
      } else {
        o.f64(x); o.f64(y); o.f64(x + 10); o.f64(y);
        o.u32(1); o.f64(2.5); o.f64(2.5); o.f64(0); o.f64(0);
        o.str('');
        o.str(e.text);
      }
    } else if (e.ref !== undefined) {
      const [x, y] = e.at ?? [0, 0];
      tag('CDataBlock');
      common(1, 1, L);
      o.f64(x); o.f64(y); o.f64(1); o.f64(1); o.f64(0);
      o.u32(e.ref);
    } else {
      throw new Error('未対応の図形');
    }
  };
  o.count(doc.entities.length);
  for (const e of doc.entities) entity(e);
  const defs = doc.defs ?? [];
  o.count(defs.length);
  for (const d of defs) {
    tag('CDataList');
    common();
    o.u32(d.no); o.u32(1); o.u32(0); o.str(d.name ?? `B${d.no}`);
    o.count(d.entities.length);
    for (const e of d.entities) entity(e);
  }
  // 末尾：同梱画像の数（画像がなければ 0）と、画像ごとの名前・大きさ・中身
  const images = doc.images ?? [];
  o.u32(images.length);
  for (const img of images) {
    o.str(img.name);
    o.u32(img.bytes.length);
    for (const b of img.bytes) o.u8(b);
  }
  return o.bytes();
}

/**
 * 入れ子の部品の爆弾：定義 1〜depth のそれぞれが線 1 本と、次の定義の配置を fan 個持つ。
 * 展開すると fan^(depth-1) 個になるが、ファイルは数 KB
 */
export function nestedBomb(depth = 9, fan = 10, withLine = true) {
  const defs = [];
  for (let k = 1; k <= depth; k++) {
    const entities = withLine ? [{ line: [0, 0, 10, k] }] : [];
    if (k < depth) for (let i = 0; i < fan; i++) entities.push({ ref: k + 1, at: [i * 20, k * 5] });
    defs.push({ no: k, name: `B${k}`, entities });
  }
  return makeJww({ entities: [{ line: [0, 0, 100, 100] }, { ref: 1 }], defs });
}
