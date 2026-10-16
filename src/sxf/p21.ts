/**
 * ISO 10303-21（STEP の物理ファイル）を読む。SXF の P21 形式の字句と構文だけを扱い、意味づけは ap202.ts。
 * 値は数・文字列（'…'。'' は '、\X2\…\X0\・\X4\…\X0\・\X\hh・\S\c を直す）・列挙（.T.）・参照（#n）・
 * $ と *（null）・リスト（入れ子）・型付きの値（LENGTH_MEASURE(1.) など）。複合インスタンス #n=(A(…)B(…)) も読む
 */
import { decodeSxf } from './sfc.ts';

/** インスタンスの数の上限 */
export const MAX_P21_INSTANCES = 5_000_000;
/** リストの入れ子の深さの上限 */
export const MAX_P21_NESTING = 32;

export type StepValue = number | string | StepRef | StepEnum | StepTyped | StepValue[] | null;
export interface StepRef { ref: number }
export interface StepEnum { enum: string }
export interface StepTyped { type: string; args: StepValue[] }

/** インスタンス。records は型名（大文字）ごとの引数（単純なインスタンスは 1 つ） */
export interface StepEntity {
  id: number;
  records: Map<string, StepValue[]>;
}

export interface P21File {
  description: string;
  schema: string;
  entities: Map<number, StepEntity>;
  warnings: string[];
}

export function isRef(v: StepValue | undefined): v is StepRef {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'ref' in v;
}
export function isEnum(v: StepValue | undefined): v is StepEnum {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'enum' in v;
}
export function isTyped(v: StepValue | undefined): v is StepTyped {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'type' in v;
}

/** 文字列の中の制御（\X2\ など）を直す */
export function decodeStepString(s: string): string {
  if (!s.includes('\\')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c !== '\\') { out += c; i++; continue; }
    const rest = s.slice(i, i + 4).toUpperCase();
    if (rest.startsWith('\\X2\\') || rest.startsWith('\\X4\\')) {
      const width = rest[2] === '2' ? 4 : 8;
      const end = s.toUpperCase().indexOf('\\X0\\', i + 4);
      const hex = s.slice(i + 4, end < 0 ? s.length : end);
      for (let k = 0; k + width <= hex.length; k += width) {
        const code = Number.parseInt(hex.slice(k, k + width), 16);
        if (Number.isFinite(code) && code <= 0x10ffff) out += String.fromCodePoint(code);
      }
      i = end < 0 ? s.length : end + 4;
      continue;
    }
    if (rest.startsWith('\\X\\')) {
      const code = Number.parseInt(s.slice(i + 3, i + 5), 16);
      if (Number.isFinite(code)) out += String.fromCharCode(code);
      i += 5;
      continue;
    }
    if (rest.startsWith('\\S\\') && i + 3 < s.length) {
      out += String.fromCharCode((s.charCodeAt(i + 3) & 0x7f) + 0x80);
      i += 4;
      continue;
    }
    if (/^\\P[A-I]\\/i.test(s.slice(i, i + 4))) { i += 4; continue; }
    if (s[i + 1] === '\\') { out += '\\'; i += 2; continue; }
    out += c;
    i++;
  }
  return out;
}

/** 字句・構文の読み手 */
class Lexer {
  readonly s: string;
  i = 0;
  depth = 0;
  constructor(s: string) { this.s = s; }

  /** 空白と注釈を飛ばす */
  ws(): void {
    const s = this.s;
    for (;;) {
      while (this.i < s.length && s.charCodeAt(this.i) <= 32) this.i++;
      if (s[this.i] === '/' && s[this.i + 1] === '*') {
        const end = s.indexOf('*/', this.i + 2);
        this.i = end < 0 ? s.length : end + 2;
        continue;
      }
      return;
    }
  }

  keyword(): string {
    const s = this.s;
    const start = this.i;
    while (this.i < s.length && /[A-Za-z0-9_!-]/.test(s[this.i])) this.i++;
    return s.slice(start, this.i).toUpperCase();
  }

  /** 引数の並び（'(' の後から ')' まで） */
  list(): StepValue[] {
    const out: StepValue[] = [];
    if (++this.depth > MAX_P21_NESTING) throw new Error('リストの入れ子が深すぎます');
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      if (c === undefined) throw new Error('ファイルが途中で終わっています');
      if (c === ')') { this.i++; break; }
      if (c === ',') { this.i++; continue; }
      out.push(this.value());
    }
    this.depth--;
    return out;
  }

  value(): StepValue {
    const s = this.s;
    const c = s[this.i];
    if (c === "'") {
      let str = '';
      this.i++;
      for (;;) {
        const j = s.indexOf("'", this.i);
        if (j < 0) throw new Error('文字列が閉じていません');
        str += s.slice(this.i, j);
        this.i = j + 1;
        if (s[this.i] === "'") { str += "'"; this.i++; continue; }
        break;
      }
      return decodeStepString(str);
    }
    if (c === '#') {
      this.i++;
      const start = this.i;
      while (this.i < s.length && s[this.i] >= '0' && s[this.i] <= '9') this.i++;
      return { ref: Number(s.slice(start, this.i)) };
    }
    if (c === '$' || c === '*') { this.i++; return null; }
    if (c === '.') {
      const j = s.indexOf('.', this.i + 1);
      if (j < 0) throw new Error('列挙が閉じていません');
      const v = s.slice(this.i + 1, j).toUpperCase();
      this.i = j + 1;
      return { enum: v };
    }
    if (c === '(') { this.i++; return this.list(); }
    if (c === '"') {
      const j = s.indexOf('"', this.i + 1);
      this.i = j < 0 ? s.length : j + 1;
      return null;
    }
    if (c === '-' || c === '+' || (c >= '0' && c <= '9')) {
      const m = /^[+-]?[0-9]*\.?[0-9]*(?:[eE][+-]?[0-9]+)?/.exec(s.slice(this.i, this.i + 64));
      const t = m ? m[0] : c;
      this.i += Math.max(1, t.length);
      return Number.parseFloat(t);
    }
    if (/[A-Za-z]/.test(c)) {
      const type = this.keyword();
      this.ws();
      if (s[this.i] === '(') { this.i++; return { type, args: this.list() }; }
      return { enum: type };
    }
    throw new Error(`読めない値です（${c}）`);
  }
}

export function parseP21(buffer: ArrayBuffer): P21File {
  const text = decodeSxf(buffer);
  const file: P21File = { description: '', schema: '', entities: new Map(), warnings: [] };
  const head = text.slice(0, 8192);
  const desc = /FILE_DESCRIPTION\s*\(\s*\(\s*'([^']*)'/i.exec(head);
  if (desc) file.description = decodeStepString(desc[1]);
  const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/i.exec(head);
  if (schema) file.schema = schema[1];

  const data = /\bDATA\s*(\([^)]*\))?\s*;/i.exec(text);
  if (!data) throw new Error('P21 の DATA 節がありません');
  const lx = new Lexer(text);
  lx.i = data.index + data[0].length;
  let broken = 0;
  for (;;) {
    lx.ws();
    if (lx.i >= text.length) break;
    if (/^ENDSEC/i.test(text.slice(lx.i, lx.i + 6))) break;
    const start = lx.i;
    try {
      if (text[lx.i] !== '#') throw new Error('#n がありません');
      lx.i++;
      const idStart = lx.i;
      while (text[lx.i] >= '0' && text[lx.i] <= '9') lx.i++;
      const id = Number(text.slice(idStart, lx.i));
      lx.ws();
      if (text[lx.i] !== '=') throw new Error('= がありません');
      lx.i++;
      lx.ws();
      const records = new Map<string, StepValue[]>();
      lx.depth = 0;
      if (text[lx.i] === '(') {
        // 複合インスタンス
        lx.i++;
        for (;;) {
          lx.ws();
          if (text[lx.i] === ')') { lx.i++; break; }
          const type = lx.keyword();
          if (!type) throw new Error('複合インスタンスの型名がありません');
          lx.ws();
          if (text[lx.i] !== '(') throw new Error('( がありません');
          lx.i++;
          records.set(type, lx.list());
        }
      } else {
        const type = lx.keyword();
        lx.ws();
        if (!type || text[lx.i] !== '(') throw new Error('型名がありません');
        lx.i++;
        records.set(type, lx.list());
      }
      lx.ws();
      if (text[lx.i] === ';') lx.i++;
      file.entities.set(id, { id, records });
      if (file.entities.size >= MAX_P21_INSTANCES) {
        file.warnings.push(`インスタンスが多すぎるため、${MAX_P21_INSTANCES.toLocaleString()} 個で読むのをやめました`);
        break;
      }
    } catch {
      broken++;
      // 次の ; まで飛ばす（文字列の中の ; は気にしない）
      const j = text.indexOf(';', Math.max(start + 1, lx.i));
      if (j < 0) break;
      lx.i = j + 1;
    }
  }
  if (broken) file.warnings.push(`読めないインスタンスを ${broken} 個読み飛ばしました`);
  return file;
}
