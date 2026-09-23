/**
 * JWW (Jw_cad for Windows) バイナリリーダ。
 * MFC CArchive のシリアライズ規則に沿ってリトルエンディアンで読み進める。
 */

const SJIS = new TextDecoder('shift_jis');

export class Reader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  pos = 0;

  constructor(buffer: ArrayBuffer) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
  }

  get length(): number {
    return this.bytes.length;
  }

  get eof(): boolean {
    return this.pos >= this.bytes.length;
  }

  /** 残りバイト数 */
  get rest(): number {
    return this.bytes.length - this.pos;
  }

  /**
   * 残りが足りなければここで止める。
   * subarray は末尾で黙って切り詰められるため、これが無いと pos だけが
   * 末尾を追い越し、「最後まで読めた」ように見えたまま欠けた図面を返してしまう。
   */
  private need(n: number): void {
    if (n < 0 || this.pos + n > this.bytes.length) {
      throw new Error(
        `ファイルが途中で終わっています（位置 ${this.pos} から ${n} バイト必要ですが、全長は ${this.bytes.length} です）`,
      );
    }
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }

  /** n バイトを Shift-JIS として読む */
  raw(n: number): string {
    this.need(n);
    const s = SJIS.decode(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }

  /** ASCII として n バイト読む（クラス名など） */
  ascii(n: number): string {
    this.need(n);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.bytes[this.pos + i]);
    this.pos += n;
    return s;
  }

  /**
   * JWW の文字列。長さ 1 バイト、0xFF なら続く WORD が実長。
   * 文字コードは Shift-JIS。
   */
  str(): string {
    const b = this.u8();
    if (b === 0) return '';
    const len = b === 0xff ? this.u16() : b;
    const s = this.raw(len);
    // Shift-JIS にない文字は、Jw_cad が "\U+01B0" のような形で書き込んでいる
    return s.includes('\\U+') ? s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) : s;
  }

  /**
   * CObList / CArchive の要素数。WORD、0xFFFF なら DWORD が続く。
   */
  count(): number {
    const w = this.u16();
    if (w !== 0xffff) return w;
    return this.u32();
  }
}
