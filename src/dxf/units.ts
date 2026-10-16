/** DXF の単位（$INSUNITS の番号）。情報パネルの選択肢にも使うので、読み取りの本体とは分けておく */

export interface DxfUnit {
  code: number;
  name: string;
  /** 1 単位が何 mm か */
  toMm: number;
}

export const DXF_UNITS: DxfUnit[] = [
  { code: 4, name: 'mm', toMm: 1 },
  { code: 5, name: 'cm', toMm: 10 },
  { code: 14, name: 'dm', toMm: 100 },
  { code: 6, name: 'm', toMm: 1000 },
  { code: 7, name: 'km', toMm: 1_000_000 },
  { code: 13, name: 'µm', toMm: 0.001 },
  { code: 1, name: 'インチ', toMm: 25.4 },
  { code: 2, name: 'フィート', toMm: 304.8 },
  { code: 10, name: 'ヤード', toMm: 914.4 },
];

/** 番号の単位。0（指定なし）や知らない番号なら mm とみなし、guessed を立てる */
export function dxfUnit(code: number): { unit: DxfUnit; guessed: boolean } {
  const hit = DXF_UNITS.find((u) => u.code === code);
  return hit ? { unit: hit, guessed: false } : { unit: DXF_UNITS[0], guessed: true };
}

/** 縮尺の選択肢（分母） */
export const DXF_SCALES = [1, 2, 5, 10, 20, 30, 50, 100, 200, 300, 500, 1000];
