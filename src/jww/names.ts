/** Jw_cad の番号を画面に出すときの呼び名 */

/** レイヤグループ・レイヤ番号は Jw_cad と同じく 16 進 1 桁（0〜F）で表す */
export function hex1(n: number): string {
  return (n & 15).toString(16).toUpperCase();
}

/** レイヤ（0〜255）を「4-D」の形で */
export function layerTag(layer: number): string {
  return `${hex1(layer >> 4)}-${hex1(layer)}`;
}

/** Jw_cad の基本線種 */
const BASIC_LINE_TYPES: Record<number, string> = {
  1: '実線',
  2: '点線1',
  3: '点線2',
  4: '点線3',
  5: '一点鎖1',
  6: '一点鎖2',
  7: '二点鎖1',
  8: '二点鎖2',
  9: '補助線',
  11: 'ランダム線1',
  12: 'ランダム線2',
  13: 'ランダム線3',
  14: 'ランダム線4',
  15: 'ランダム線5',
  16: '倍長線種6',
  17: '倍長線種7',
  18: '倍長線種8',
  19: '倍長線種9',
};

/** SXF の既定線種の英名と、図面でよく使われる呼び名 */
const SXF_LINE_TYPES: Record<string, string> = {
  'continuous': '実線',
  'dashed': '破線',
  'dashed spaced': '跳び破線',
  'long dashed dotted': '一点長鎖線',
  'long dashed double-dotted': '二点長鎖線',
  'long dashed triplicate-dotted': '三点長鎖線',
  'dotted': '点線',
  'chain': '一点鎖線',
  'chain double dash': '二点鎖線',
  'dashed dotted': '一点短鎖線',
  'double-dashed dotted': '一点二短鎖線',
  'dashed double-dotted': '二点短鎖線',
  'double-dashed double-dotted': '二点二短鎖線',
  'dashed triplicate-dotted': '三点短鎖線',
  'double-dashed triplicate-dotted': '三点二短鎖線',
};

/**
 * 線種の呼び名。sxfNames はヘッダに保存されている SXF 線種名（線種番号 30 から順）。
 * 番号 30 以上は SXF の線種で、既定の英名なら日本語に、利用者が付けた名前ならそのまま出す。
 */
export function lineTypeName(style: number, sxfNames: readonly string[]): string {
  const basic = BASIC_LINE_TYPES[style];
  if (basic) return basic;
  if (style >= 30 && style <= 62) {
    const raw = (sxfNames[style - 30] ?? '').trim();
    if (!raw) return `SXF線種 ${style - 30}`;
    const ja = SXF_LINE_TYPES[raw.toLowerCase()];
    return ja ? `${ja}（SXF）` : raw;
  }
  if (style === 0) return '実線';
  return `線種 ${style}`;
}

/** Jw_cad でのレイヤの状態 */
export function layerStateName(state: number): string {
  switch (state) {
    case 0: return '非表示';
    case 1: return '表示のみ';
    case 2: return '編集可';
    case 3: return '書込';
    default: return `状態 ${state}`;
  }
}
