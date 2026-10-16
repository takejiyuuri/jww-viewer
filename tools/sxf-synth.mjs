// 検証用の SXF（SFC）を合成する（答えの分かっている図形だけを並べたもの）。
//   node tools/sxf-synth.mjs 出力フォルダ … basic.sfc を書き出す
// verify-sxf.ts と e2e-sxf.mjs は、ここの関数で作った中身をそのまま使う
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shift_JIS の逆引き表（2 バイト文字をすべて復号して作る） */
let SJIS = null;
function sjisTable() {
  if (SJIS) return SJIS;
  SJIS = new Map();
  const dec = new TextDecoder('shift_jis');
  for (let a = 0x81; a <= 0xfc; a++) {
    if (a > 0x9f && a < 0xe0) continue;
    for (let b = 0x40; b <= 0xfc; b++) {
      if (b === 0x7f) continue;
      const ch = dec.decode(new Uint8Array([a, b]));
      if (ch.length === 1 && ch !== '�' && !SJIS.has(ch)) SJIS.set(ch, [a, b]);
    }
  }
  return SJIS;
}

/** 文字列を Shift_JIS に */
export function sjis(s) {
  const t = sjisTable();
  const out = [];
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c < 0x80) out.push(c);
    else if (t.has(ch)) out.push(...t.get(ch));
    else out.push(0x3f);
  }
  return new Uint8Array(out);
}

/** SFC の文字列の引数（\'…\'） */
const S = (v) => `\\'${v}\\'`;
/** 数の引数（'…'） */
const N = (v) => `'${v}'`;
/** 数のリストの引数（'(…)'） */
const L = (list) => `'(${list.join(',')})'`;

/** 文字の 12 個（flag 1, font, str, x, y, 高さ, 幅, 間隔, 角度, スラント, 基点, 向き） */
const T = (font, str, x, y, h, w, bpnt, dir = 1) => [N(1), N(font), S(str), N(x), N(y), N(h), N(w), N(0), N(0), N(0), N(bpnt), N(dir)];

/**
 * 合成の図面の中身（フィーチャ名と引数の並び）。
 * 部分図「平面図」は用紙の (100, 100) に倍率 0.01（1/100）で置き、その中の線 (0,0)-(1000,0) は実寸 1000 mm
 */
export function sxfFeatures() {
  const f = [];
  const add = (name, ...args) => f.push([name, args.flat()]);
  add('pre_defined_colour_feature', S('red'));
  add('user_defined_colour_feature', N(10), N(20), N(30));
  add('pre_defined_font_feature', S('dashed'));
  add('user_defined_font_feature', S('myline'), N(4), L([2, 1, 0.5, 1]));
  add('width_feature', N('0.250000'));
  add('text_font_feature', S('ＭＳ ゴシック'));
  add('text_font_feature', S('@ＭＳ 明朝'));
  // 複合曲線は、まだどこにも属していない図形をまとめるので、ファイルの初め（複合図形の定義より前）に置く。
  // 1：外周 40 × 40（境界は見える線）、2：穴 10 × 10、3：半円（中心 (80,170)、半径 10）
  add('polyline_feature', N(0), N(0), N(0), N(0), N(5), L([0, 40, 40, 0, 0]), L([150, 150, 190, 190, 150]));
  add('composite_curve_org_feature', N(2), N(1), N(3), N(1));
  add('polyline_feature', N(0), N(0), N(0), N(0), N(5), L([10, 20, 20, 10, 10]), L([160, 160, 170, 170, 160]));
  add('composite_curve_org_feature', N(2), N(1), N(3), N(0));
  add('arc_feature', N(0), N(0), N(0), N(0), N(80), N(170), N(10), N(0), N(0), N(180));
  add('polyline_feature', N(0), N(0), N(0), N(0), N(2), L([70, 90]), L([170, 170]));
  add('composite_curve_org_feature', N(2), N(1), N(3), N(0));
  // 作図部品「部品A」：線 (0,0)-(10,0)、レイヤ 2（寸法）・赤
  add('line_feature', N(2), N(2), N(1), N(3), N(0), N(0), N(10), N(0));
  add('sfig_org_feature', S('部品A'), N(4));
  // 作図グループ「G1」：部品A を (5,5) に 90° 回して 2 倍で置く
  add('sfig_locate_feature', N(0), S('部品A'), N(5), N(5), N(90), N(2), N(2));
  add('sfig_org_feature', S('G1'), N(3));
  // 自分自身を置く作図グループ（循環。展開を止められること）
  add('sfig_locate_feature', N(0), S('LOOP'), N(0), N(0), N(0), N(1), N(1));
  add('line_feature', N(1), N(8), N(1), N(1), N(0), N(0), N(1), N(1));
  add('sfig_org_feature', S('LOOP'), N(3));
  // 部分図「平面図」（数学座標系）
  add('line_feature', N(1), N(8), N(1), N(3), N(0), N(0), N(1000), N(0));
  add('line_feature', N(1), N(8), N(2), N(3), N(0), N(100), N(1000), N(100));
  add('line_feature', N(1), N(17), N(16), N(3), N(0), N(200), N(1000), N(200));
  add('sfig_locate_feature', N(0), S('G1'), N(0), N(0), N(0), N(1), N(1));
  add('linear_dim_feature', N(2), N(2), N(1), N(3), N(0), N(-100), N(1000), N(-100),
    N(1), N(0), N(0), N(0), N(-10), N(0), N(-110),
    N(1), N(1000), N(0), N(1000), N(-10), N(1000), N(-110),
    N(1), N(1), N(0), N(-100), N(1),
    N(1), N(1), N(1000), N(-100), N(1),
    T(1, '1000', 500, -90, 250, 500, 2));
  add('arc_feature', N(1), N(2), N(1), N(3), N(500), N(500), N(100), N(0), N(0), N(90));
  add('sfig_org_feature', S('平面図'), N(1));
  // 用紙に直に置く図形
  add('sfig_locate_feature', N(0), S('平面図'), N(100), N(100), N(0), N('0.01'), N('0.01'));
  add('line_feature', N(1), N(8), N(1), N(3), N(0), N(0), N(100), N(0));
  add('text_string_feature', N(1), N(8), N(1), S('中央'), N(50), N(50), N(5), N(10), N(0), N(0), N(0), N(5), N(1));
  add('text_string_feature', N(1), N(8), N(2), S('縦書'), N(80), N(80), N(4), N(8), N(0), N(0), N(0), N(7), N(2));
  add('text_string_feature', N(3), N(8), N(1), S('隠し'), N(10), N(10), N(3), N(6), N(0), N(0), N(0), N(1), N(1));
  // 穴のある塗り（複合曲線 1 と穴 2。面積 1500）と、半円（3）の中に 45° の線を 2 mm おきに
  add('fill_area_style_colour_feature', N(1), N(17), N(1), N(1), L([2]));
  add('fill_area_style_hatching_feature', N(1), N(1), L([2, 1, 3, 0, 0, 2, 45]), N(3), N(0), L([]));
  add('spline_feature', N(1), N(8), N(1), N(3), N(0), N(4), L([0, 10, 20, 30]), L([250, 260, 250, 260]));
  add('clothoid_feature', N(1), N(8), N(1), N(3), N(200), N(150), N(50), N(0), N(0), N(0), N(50));
  add('ellipse_arc_feature', N(1), N(8), N(1), N(3), N(200), N(250), N(20), N(10), N(0), N(0), N(0), N(90));
  add('point_marker_feature', N(1), N(2), N(150), N(20), N(1), N(0), N(1));
  add('label_feature', N(1), N(8), N(1), N(3), N(2), L([300, 320]), L([20, 40]), N(1), N(1), T(1, '引出', 322, 40, 3, 6, 1));
  add('sfig_locate_feature', N(0), S('LOOP'), N(0), N(0), N(0), N(1), N(1));
  add('drawing_sheet_feature', S('合成図面'), N(3), N(1), N(0), N(0));
  add('layer_feature', S('壁'), N(1));
  add('layer_feature', S('寸法'), N(1));
  add('layer_feature', S('HIDDEN'), N(0));
  return f;
}

/** 合成の SFC（Shift_JIS） */
export function basicSfc() {
  const lines = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('SCADEC level2 feature_mode'),",
    "        '2;1');",
    "FILE_NAME('basic.sfc',",
    "        '2026-10-16T12:00:00',",
    "        (''),",
    "        (''),",
    "        'SCADEC_API_Ver3.30$$3.1',",
    "        'sxf-synth',",
    "        '');",
    "FILE_SCHEMA(('ASSOCIATIVE_DRAUGHTING'));",
    'ENDSEC;',
    'DATA;',
    '',
  ];
  let id = 10;
  for (const [name, args] of sxfFeatures()) {
    lines.push('/*SXF', `#${id} = ${name}(${args.join(',')})`, 'SXF*/', '');
    id += 10;
  }
  lines.push('ENDSEC;', 'END-ISO-10303-21;', '');
  return sjis(lines.join('\r\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? '.';
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'basic.sfc'), basicSfc());
  console.log(`書き出しました: ${out}`);
}
