/**
 * MTEXT の書式記号を外して、段落（行）ごとの文字列と字の高さにする。
 * 扱うもの：\P（改行）、\~（空白）、\\ \{ \}（その字）、{ }（まとまり。高さを元に戻す）、
 * \H（高さ。x 付きは倍率）、\S（積み重ね。a/b の形で 1 行に）、\U+XXXX、\M+nXXXX（2 バイトの字）、%%c %%d %%p。
 * \f \F \C \c \T \Q \W \A \p は「;」まで読み飛ばし、\L \l \O \o \K \k \N と知らない記号は記号だけ外す
 */

/**
 * TEXT の文字列の制御記号を直す。%%c（直径）・%%d（度）・%%p（±）・%%%、
 * 下線・上線の切り替え（%%u・%%o）は外す。\U+XXXX は Unicode の文字
 */
export function decodeText(s: string): string {
  return s
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/%%([cCdDpPuUoO%]|\d{3})/g, (_, c: string) => {
      switch (c.toLowerCase()) {
        case 'c': return 'Ø';
        case 'd': return '°';
        case 'p': return '±';
        case '%': return '%';
        case 'u': case 'o': return '';
        default: return String.fromCharCode(Number.parseInt(c, 10));
      }
    });
}

/** \M+n の n ごとの文字コード */
const MBCS: Record<string, string> = { '1': 'shift_jis', '2': 'big5', '3': 'euc-kr', '4': 'euc-kr', '5': 'gbk' };

/** 「;」まで読み飛ばす記号 */
const WITH_ARG = new Set(['f', 'F', 'C', 'c', 'T', 'Q', 'W', 'A', 'p', 'H']);

export interface MtextLine {
  text: string;
  height: number;
}

/** \M+nXXXX の 2 バイトを文字に */
function mbcs(page: string, hex: string): string {
  const enc = MBCS[page];
  if (!enc) return '';
  try {
    return new TextDecoder(enc).decode(new Uint8Array([Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16)]));
  } catch {
    return '';
  }
}

export function parseMtext(raw: string, height: number): MtextLine[] {
  const lines: MtextLine[] = [];
  let text = '';
  let lineHeight = 0;
  let h = height;
  /** { } の入れ子ごとの、入る前の高さ */
  const stack: number[] = [];
  const put = (s: string): void => {
    if (!s) return;
    text += s;
    if (h > lineHeight) lineHeight = h;
  };
  const newline = (): void => {
    lines.push({ text: decodeText(text), height: lineHeight || h });
    text = '';
    lineHeight = 0;
  };
  // ^J は改行、^I はタブ（キャレットの記法）
  const s = raw.replace(/\^J/g, '\\P').replace(/\^I/g, ' ');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') { stack.push(h); continue; }
    if (ch === '}') { if (stack.length) h = stack.pop()!; continue; }
    if (ch !== '\\' || i + 1 >= s.length) { put(ch); continue; }
    const c = s[i + 1];
    i++;
    switch (c) {
      case 'P': case 'X': newline(); break;
      case '~': put(' '); break;
      case '\\': case '{': case '}': put(c); break;
      case 'U': {
        const m = /^\+([0-9A-Fa-f]{4})/.exec(s.slice(i + 1, i + 6));
        if (m) { put(String.fromCharCode(Number.parseInt(m[1], 16))); i += 5; }
        break;
      }
      case 'M': {
        const m = /^\+([1-5])([0-9A-Fa-f]{4})/.exec(s.slice(i + 1, i + 7));
        if (m) { put(mbcs(m[1], m[2])); i += 6; }
        break;
      }
      case 'S': {
        // 積み重ね：\Sa^b; \Sa/b; \Sa#b; を a/b にする
        const end = s.indexOf(';', i + 1);
        const body = end < 0 ? s.slice(i + 1) : s.slice(i + 1, end);
        put(body.replace(/\\(.)/g, '$1').replace(/\s*[\^#/]\s*/, '/').trim());
        i = end < 0 ? s.length : end;
        break;
      }
      default: {
        if (!WITH_ARG.has(c)) break;
        const end = s.indexOf(';', i + 1);
        const arg = end < 0 ? s.slice(i + 1) : s.slice(i + 1, end);
        if (c === 'H') {
          const v = Number.parseFloat(arg);
          if (v > 0 && Number.isFinite(v)) h = /x\s*$/i.test(arg) ? h * v : v;
        }
        i = end < 0 ? s.length : end;
      }
    }
  }
  newline();
  // 末尾の空行は出さない（先頭・途中の空行は行間として残す）
  while (lines.length > 1 && !lines[lines.length - 1].text) lines.pop();
  return lines;
}
