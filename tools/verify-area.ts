// 面積・体積・角度の計算と、高さの入力の読み取りを確かめる（図面は使わない）。
import {
  MEASURE_MODES, angleAt, formatAngle, formatArea, formatVolume, inclination, measureAngles, measureArea, measureLengths,
  parseLength, polygonCenter, type MeasurePoint,
} from '../src/measure/measure.ts';
import { MEASURE_COLORS, measureInk } from '../src/measure/colors.ts';

let failures = 0;
const fail = (name: string, info?: unknown): void => {
  failures++;
  console.log(`NG: ${name}`, info ?? '');
};
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const pt = (x: number, y: number, scale: number | null = null): MeasurePoint => ({ x, y, glayer: 0, kind: 'endpoint', scale });

// ---------- 1. 四角・三角・へこんだ形の面積と外周 ----------
{
  // 図面上 100 × 60 を 1/50 で → 実寸 5000 × 3000 mm = 15 m²、外周 16 m
  const rect = [pt(0, 0, 50), pt(100, 0, 50), pt(100, 60, 50), pt(0, 60, 50)];
  const m = measureArea(rect, 1);
  if (!near(m.area, 15e6) || !near(m.perimeter, 16000) || m.scale !== 50 || m.mixed || m.crossing || m.edges.length !== 4) {
    fail('四角の面積と外周', m);
  }
  // 回る向きが逆でも同じ面積
  const back = measureArea([...rect].reverse(), 1);
  if (!near(back.area, m.area)) fail('逆回りでも同じ面積', back);
  // 三角形
  const tri = measureArea([pt(0, 0), pt(40, 0), pt(0, 30)], 100);
  if (!near(tri.area, 0.5 * 40 * 30 * 100 * 100) || !near(tri.perimeter, (40 + 30 + 50) * 100)) fail('三角形', tri);
  // L 字（へこんだ形）: 10×10 から 5×5 を欠いた 75
  const ell = measureArea([pt(0, 0), pt(10, 0), pt(10, 5), pt(5, 5), pt(5, 10), pt(0, 10)], 1);
  if (!near(ell.area, 75) || ell.crossing) fail('L 字の面積', ell);
  // 図面の原点から遠い座標でも桁落ちしない
  const off = 1e7;
  const far = measureArea([pt(off, off), pt(off + 0.1, off), pt(off + 0.1, off + 0.1), pt(off, off + 0.1)], 1);
  if (!near(far.area, 0.01, 1e-6)) fail('遠い座標でも面積が正しい', far);
  console.log(`四角・三角・L 字: ${failures === 0 ? 'OK' : 'NG'}`);
}

// ---------- 2. 点が少ないとき ----------
{
  const before = failures;
  const zero = measureArea([], 50);
  if (zero.area !== 0 || zero.edges.length !== 0 || zero.scale !== 50) fail('点なし', zero);
  const one = measureArea([pt(1, 1, 20)], 50);
  if (one.area !== 0 || one.edges.length !== 0 || one.scale !== 20) fail('1 点', one);
  // 2 点は辺が 1 本（往復しない）で、面積は 0
  const two = measureArea([pt(0, 0, 20), pt(3, 4, 20)], 50);
  if (two.area !== 0 || two.edges.length !== 1 || !near(two.edges[0], 100) || !near(two.perimeter, 100)) fail('2 点', two);
  // 一直線に並んだ 3 点は面積 0
  const line = measureArea([pt(0, 0), pt(1, 1), pt(2, 2)], 1);
  if (!near(line.area, 0)) fail('一直線の 3 点', line);
  console.log(`点が少ないとき: ${failures === before ? 'OK' : 'NG'}`);
}

// ---------- 3. 縮尺の決め方 ----------
{
  const before = failures;
  const sq = (s: (i: number) => number | null) => [pt(0, 0, s(0)), pt(10, 0, s(1)), pt(10, 10, s(2)), pt(0, 10, s(3))];
  // 分かっている縮尺が一つだけなら、分からない点が混じっていてもその縮尺
  const some = measureArea(sq((i) => (i === 2 ? 20 : null)), 100);
  if (some.scale !== 20 || some.mixed || !near(some.area, 100 * 400)) fail('分かっている縮尺が一つ', some);
  // どの点も分からなければ既定の縮尺
  const none = measureArea(sq(() => null), 100);
  if (none.scale !== 100 || none.mixed) fail('縮尺が分からない', none);
  // 縮尺の違う点が混じれば既定の縮尺で測り、注意を出す
  const mixed = measureArea(sq((i) => (i < 2 ? 20 : 50)), 100);
  if (mixed.scale !== 100 || !mixed.mixed) fail('縮尺が混じっている', mixed);
  // 利用者が縮尺を選んでいればそれで測り、混じっていても注意しない
  const fixed = measureArea(sq((i) => (i < 2 ? 20 : 50)), 30, true);
  if (fixed.scale !== 30 || fixed.mixed || !near(fixed.area, 100 * 900)) fail('選んだ縮尺で測る', fixed);
  console.log(`縮尺の決め方: ${failures === before ? 'OK' : 'NG'}`);
}

// ---------- 4. 辺の交差 ----------
{
  const before = failures;
  // 蝶ネクタイ形（辺が交わる）
  const bow = measureArea([pt(0, 0), pt(10, 10), pt(10, 0), pt(0, 10)], 1);
  if (!bow.crossing) fail('蝶ネクタイ形は交差', bow);
  // 凸でも凹でも交わらない形は交差しない
  if (measureArea([pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10)], 1).crossing) fail('四角は交差しない');
  if (measureArea([pt(0, 0), pt(10, 0), pt(10, 5), pt(5, 5), pt(5, 10), pt(0, 10)], 1).crossing) fail('L 字は交差しない');
  // 頂点が別の辺にちょうど乗っているだけなら交差としない
  const touch = measureArea([pt(0, 0), pt(10, 0), pt(10, 10), pt(5, 0), pt(0, 10)], 1);
  if (touch.crossing) fail('頂点が辺に乗るだけ', touch);
  // 3 点は交差しようがない
  if (measureArea([pt(0, 0), pt(10, 0), pt(0, 10)], 1).crossing) fail('三角形は交差しない');
  console.log(`辺の交差: ${failures === before ? 'OK' : 'NG'}`);
}

// ---------- 5. ラベルを置く場所 ----------
{
  const before = failures;
  const c = polygonCenter([pt(0, 0), pt(10, 0), pt(10, 6), pt(0, 6)]);
  if (!near(c.x, 5) || !near(c.y, 3)) fail('四角の重心', c);
  // 遠い座標でも
  const o = 5e6;
  const c2 = polygonCenter([pt(o, o), pt(o + 10, o), pt(o + 10, o + 6), pt(o, o + 6)]);
  if (!near(c2.x, o + 5, 1e-9) || !near(c2.y, o + 3, 1e-9)) fail('遠い座標の重心', c2);
  // 一直線なら点の平均（重心が遠くへ飛ばない）
  const c3 = polygonCenter([pt(0, 0), pt(1, 1), pt(2, 2.0000001)]);
  if (!near(c3.x, 1, 1e-6) || !near(c3.y, 1, 1e-6)) fail('一直線は点の平均', c3);
  const c4 = polygonCenter([pt(0, 0), pt(4, 0)]);
  if (!near(c4.x, 2) || !near(c4.y, 0)) fail('2 点は真ん中', c4);
  // 角を Z の順に押して辺が交差し、面積が打ち消し合っても、ラベルは点の範囲の中に置く
  for (const z of [[pt(0, 0), pt(100, 0), pt(0, 50), pt(101, 50)], [pt(0, 0), pt(100, 0), pt(0, 50), pt(110, 50)]]) {
    const cz = polygonCenter(z);
    if (!(cz.x >= 0 && cz.x <= 110 && cz.y >= 0 && cz.y <= 50)) fail('交差した囲みでもラベルは点の範囲の中', cz);
  }
  console.log(`ラベルの場所: ${failures === before ? 'OK' : 'NG'}`);
}

// ---------- 6. 表し方 ----------
{
  const before = failures;
  const cases: Array<[string, string]> = [
    [formatArea(15e6), '15.000 m²'],
    [formatArea(1e4), '0.010 m²'],
    [formatArea(9999), '9999.0 mm²'],
    [formatArea(0), '0.0 mm²'],
    [formatVolume(36e9), '36.000 m³'],
    [formatVolume(1e7), '0.010 m³'],
    // 0.01 m³ 未満は cm³（m³ の小数 3 桁では有効数字が 1 桁になる）
    [formatVolume(1.4e6), '1400.0 cm³'],
    [formatVolume(5e5), '500.0 cm³'],
  ];
  for (const [got, want] of cases) if (got !== want) fail('表し方', { got, want });
  console.log(`表し方: ${failures === before ? 'OK' : 'NG'}`);
}

// ---------- 7. 高さの入力の読み取り ----------
{
  const before = failures;
  const ok: Array<[string, number]> = [
    ['2400', 2400], ['2,400', 2400], ['２４００', 2400], ['２，４００', 2400], [' 150 ', 150],
    ['2400mm', 2400], ['12.5', 12.5], ['.5', 0.5], ['3.', 3], ['１２．５', 12.5],
  ];
  for (const [text, want] of ok) if (parseLength(text) !== want) fail('読める入力', { text, got: parseLength(text), want });
  const bad = ['', '0', '-5', 'abc', '1e3', '12..5', '1.2.3', '10000000', 'Infinity', '・'];
  for (const text of bad) if (parseLength(text) !== null) fail('読まない入力', { text, got: parseLength(text) });
  console.log(`高さの入力: ${failures === before ? 'OK' : 'NG'}`);
}

// ---------- 8. 計測の色 ----------
{
  const before = failures;
  const ids = new Set(MEASURE_COLORS.map((c) => c.id));
  if (ids.size !== MEASURE_COLORS.length) fail('色の名前が重なっている');
  for (const c of MEASURE_COLORS) {
    for (const bg of ['dark', 'light'] as const) {
      const ink = measureInk(c.id, bg);
      if (Object.values(ink).some((v) => typeof v !== 'string' || !v)) fail('色が欠けている', { id: c.id, bg, ink });
      // 数字は地と違う色で書く
      if (ink.text === ink.label) fail('数字と地が同じ色', { id: c.id, bg });
    }
  }
  // 白黒は背景と反対の色
  if (measureInk('mono', 'dark').stroke !== '#ffffff' || measureInk('mono', 'light').stroke !== '#111318') fail('白黒の色');
  // 知らない名前は最初の色
  if (measureInk('nothing', 'dark').stroke !== MEASURE_COLORS[0].hex) fail('知らない色の名前');
  console.log(`計測の色: ${failures === before ? 'OK' : 'NG'}`);
}

// ---------- 9. 角度 ----------
{
  const before = failures;
  const cases: Array<[MeasurePoint, MeasurePoint, MeasurePoint, number]> = [
    [pt(10, 0), pt(0, 0), pt(0, 10), 90],
    [pt(10, 0), pt(0, 0), pt(10, 10), 45],
    [pt(10, 0), pt(0, 0), pt(-10, 0), 180],
    [pt(10, 0), pt(0, 0), pt(5, 0), 0],
    [pt(1, 0), pt(0, 0), pt(-1, Math.sqrt(3)), 120],
    // 向きを入れ替えても同じ角（0〜180）
    [pt(0, 10), pt(0, 0), pt(10, 0), 90],
    [pt(-10, -10), pt(0, 0), pt(10, -10), 90],
    // 大きな座標と、とても小さな角
    [pt(100000 + 1000, 50000), pt(100000, 50000), pt(100000 + 1000, 50000 + 0.001), (Math.atan2(0.001, 1000) * 180) / Math.PI],
  ];
  for (const [a, v, b, want] of cases) {
    const got = angleAt(a, v, b);
    if (got === null || !near(got, want, 1e-9)) fail('角度', { a, v, b, got, want });
  }
  // 頂点と同じ所の点では角度を出さない
  if (angleAt(pt(0, 0), pt(0, 0), pt(1, 0)) !== null || angleAt(pt(1, 0), pt(0, 0), pt(0, 0)) !== null) fail('長さ 0 の辺の角');
  // 途中の頂点ごとの角
  const zig = measureAngles([pt(0, 0), pt(10, 0), pt(10, 10), pt(20, 20)]);
  if (zig.length !== 2 || !near(zig[0]!, 90) || !near(zig[1]!, 135)) fail('頂点ごとの角', zig);
  if (measureAngles([pt(0, 0), pt(1, 1)]).length !== 0) fail('2 点では頂点がない');
  // 線の傾き（水平から左回り、0 以上 180 未満。向きによらない）
  const incl: Array<[MeasurePoint, MeasurePoint, number]> = [
    [pt(0, 0), pt(10, 0), 0], [pt(10, 0), pt(0, 0), 0], [pt(0, 0), pt(10, 10), 45], [pt(10, 10), pt(0, 0), 45],
    [pt(0, 0), pt(0, 10), 90], [pt(0, 0), pt(-10, 10), 135], [pt(0, 0), pt(10, -10), 135],
    [pt(0, 0), pt(-10, -1e-9), 0],
  ];
  for (const [a, b, want] of incl) {
    const got = inclination(a, b);
    if (got === null || !near(got, want, 1e-6) || got < 0 || got >= 180) fail('線の傾き', { a, b, got, want });
  }
  if (inclination(pt(3, 3), pt(3, 3)) !== null) fail('長さ 0 の線の傾き');
  // 表示：0.01° まで、末尾の 0 は付けない
  const fmt: Array<[number, string]> = [[90, '90°'], [45.000001, '45°'], [33.6900675, '33.69°'], [12.5, '12.5°'], [0, '0°'], [-0.001, '0°'], [179.999, '180°']];
  for (const [v, want] of fmt) if (formatAngle(v) !== want) fail('角度の表示', { v, got: formatAngle(v), want });
  if (!MEASURE_MODES.includes('angle')) fail('角度が計測の種類にない');
  console.log(`角度: ${failures === before ? 'OK' : 'NG'}`);
}

// ---------- 10. 距離の縮尺の決め方（区間ごと） ----------
{
  const before = failures;
  // 図面上 10 の区間を、両端の縮尺と既定の縮尺でどう実寸に直すか
  const cases: Array<[string, number | null, number | null, number, boolean, number, boolean]> = [
    ['両端が同じ縮尺', 50, 50, 100, false, 500, false],
    ['縮尺の違う点をまたぐと既定の縮尺で、注意を出す', 50, 20, 100, false, 1000, true],
    ['始点だけ分からなければ終点の縮尺', null, 20, 100, false, 200, false],
    ['終点だけ分からなければ始点の縮尺', 50, null, 100, false, 500, false],
    ['どちらも分からなければ既定の縮尺', null, null, 100, false, 1000, false],
    ['選んだ縮尺ならすべてそれで、混じっていても注意しない', 50, 20, 30, true, 300, false],
  ];
  for (const [name, a, b, fallback, fixed, want, mixed] of cases) {
    const m = measureLengths([pt(0, 0, a), pt(10, 0, b)], fallback, fixed);
    if (m.segments.length !== 1 || !near(m.segments[0], want) || !near(m.total, want) || m.mixed !== mixed) fail(name, m);
  }
  // 区間ごとに縮尺を決め、合計はその和
  const run = measureLengths([pt(0, 0, 50), pt(10, 0, 50), pt(10, 10, 20), pt(10, 20, 20)], 100);
  if (!near(run.total, 500 + 1000 + 200) || run.scales.join() !== '50,100,20' || !run.mixed) fail('区間ごとの縮尺と合計', run);
  if (measureLengths([pt(0, 0, 50)], 100).segments.length !== 0) fail('1 点では区間がない');
  console.log(`距離の縮尺の決め方: ${failures === before ? 'OK' : 'NG'}`);
}

console.log(failures === 0 ? 'すべて合格' : `${failures} 件の不合格`);
process.exit(failures === 0 ? 0 : 1);
