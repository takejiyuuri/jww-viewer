import { KIND, type Bounds, type Scene } from './builder.ts';

/** 「全体」の範囲を求めるための図形の点と線 */
export interface FitSource {
  /**
   * 図形ごとの代表点（x, y の並び）。用紙の中にある割合と、主な範囲を求めるのに使う。
   * 線は両端、円・円弧は数か所、文字・塗りは四隅、点はその位置（細かく分けた線分の数に左右されないように）
   */
  pts: Float32Array;
  /** 線分（x1, y1, x2, y2 の並び）。用紙の外へ続いているかを数えるのに使う */
  segs: Float32Array;
  /** 線分ごとの図形の番号。同じ図形（円弧を分けた線分など）を 1 つとして数えるのに使う。なければ線分ごとに別 */
  segEnt?: Int32Array;
  /** 線分以外の点（文字・塗りの四隅、点） */
  marks: Float32Array;
  /** 点ごとの図形の番号（文字の四隅を 1 つとして数える）。なければ点ごとに別 */
  markEnt?: Int32Array;
}

/**
 * 見えている図形（visible が true を返す色・レイヤ）だけで「全体」の範囲を求める。
 * 隠したレイヤに残った図形で、図面本体が小さく映らないようにするため。
 */
export function fitScene(scene: Scene, visible: (color: number, layer: number) => boolean): Bounds {
  const e = scene.entities;
  const lp = scene.linePos;
  const tp = scene.triPos;
  const show = new Uint8Array(e.count);

  // 1 回目：数を数えて、配列を一度に確保する（大きな図面でも余計なメモリを使わないように）
  let nPts = 0, nSegs = 0, nMarks = 0;
  for (let i = 0; i < e.count; i++) {
    if (!visible(e.color[i], e.layer[i])) continue;
    show[i] = 1;
    const kind = e.kind[i];
    nSegs += e.lineCount[i];
    if ((kind === KIND.text || kind === KIND.dimText) && e.text[i] >= 0) { nPts += 4; nMarks += 4; }
    else if (e.triCount[i] > 0) { nPts += 4; nMarks += 4; }
    else if (e.lineCount[i] === 1) nPts += 2;
    else if (e.lineCount[i] > 1) nPts += 5;
  }
  const sp = scene.snapPoint;
  for (let i = 0; i < sp.length / 2; i++) {
    const ent = scene.snapPointEntity[i];
    if (show[ent] && e.kind[ent] === KIND.point) { nPts++; nMarks++; }
  }
  if (nPts === 0) return scene.paper ?? scene.bounds;

  const pts = new Float32Array(nPts * 2);
  const segs = new Float32Array(nSegs * 4);
  const segEnt = new Int32Array(nSegs);
  const marks = new Float32Array(nMarks * 2);
  const markEnt = new Int32Array(nMarks);
  let ip = 0, is = 0, im = 0;
  const pt = (x: number, y: number): void => { pts[ip++] = x; pts[ip++] = y; };
  const mark = (x: number, y: number, ent: number): void => {
    markEnt[im / 2] = ent;
    marks[im++] = x;
    marks[im++] = y;
    pt(x, y);
  };

  for (let i = 0; i < e.count; i++) {
    if (!show[i]) continue;
    const kind = e.kind[i];
    const ls = e.lineStart[i];
    const lc = e.lineCount[i];
    for (let j = ls; j < ls + lc; j++) {
      segEnt[is / 4] = i;
      segs[is++] = lp[j * 4];
      segs[is++] = lp[j * 4 + 1];
      segs[is++] = lp[j * 4 + 2];
      segs[is++] = lp[j * 4 + 3];
    }
    if ((kind === KIND.text || kind === KIND.dimText) && e.text[i] >= 0) {
      const t = scene.texts[e.text[i]];
      const a = (t.angle * Math.PI) / 180;
      const ux = Math.cos(a), uy = Math.sin(a);
      mark(t.x, t.y, i);
      mark(t.x + ux * t.width, t.y + uy * t.width, i);
      mark(t.x + ux * t.width - uy * t.height, t.y + uy * t.width + ux * t.height, i);
      mark(t.x - uy * t.height, t.y + ux * t.height, i);
    } else if (e.triCount[i] > 0) {
      // 塗りは三角形の頂点を囲む四隅で代表させる
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let t = e.triStart[i]; t < e.triStart[i] + e.triCount[i]; t++) {
        for (let v = 0; v < 3; v++) {
          const x = tp[t * 6 + v * 2], y = tp[t * 6 + v * 2 + 1];
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      mark(x0, y0, i);
      mark(x1, y0, i);
      mark(x1, y1, i);
      mark(x0, y1, i);
    } else if (lc === 1) {
      pt(lp[ls * 4], lp[ls * 4 + 1]);
      pt(lp[ls * 4 + 2], lp[ls * 4 + 3]);
    } else if (lc > 1) {
      // 円・円弧は、分けた線分のうち 4 か所の始点と最後の終点
      for (const q of [0, lc >> 2, lc >> 1, (lc * 3) >> 2]) pt(lp[(ls + q) * 4], lp[(ls + q) * 4 + 1]);
      pt(lp[(ls + lc - 1) * 4 + 2], lp[(ls + lc - 1) * 4 + 3]);
    }
  }
  for (let i = 0; i < sp.length / 2; i++) {
    const ent = scene.snapPointEntity[i];
    if (show[ent] && e.kind[ent] === KIND.point) mark(sp[i * 2], sp[i * 2 + 1], ent);
  }

  // 見えている図形がちょうど収まる範囲。図形が少ないときや用紙が分からないときの拠り所にする
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return scene.paper ?? scene.bounds;
  return fitRange({ pts, segs, segEnt, marks, markEnt }, { minX, minY, maxX, maxY }, scene.paper);
}

/**
 * 「全体」で見せる範囲。
 *
 * 図形のほとんど（9 割以上）が用紙の中にある図面は、Jw_cad の用紙全体表示と同じく用紙の枠を基本にする。
 * 用紙の外に離れて残った点や補助の図形、遠くへ伸びた数本の線に引きずられて、図面本体が小さく映らないようにするため。
 * ただし用紙の辺ごとに見て、その辺から外へ図形が途切れずに続いている所までは広げる（continuation 参照）。
 *
 * 図形の多くが用紙の外にある図面では、図形の主な範囲と用紙を合わせた範囲にする。
 * 用紙だけが極端に大きい図面（作図済みなのは一部だけ）では、図形の範囲を優先する。
 */
export function fitRange(src: FitSource, all: Bounds, paper: Bounds | null): Bounds {
  const robust = robustBounds(src.pts, all);
  if (!paper) return robust;
  const pw = paper.maxX - paper.minX;
  const ph = paper.maxY - paper.minY;
  const mx = pw * 0.02;
  const my = ph * 0.02;

  const count = src.pts.length / 2;
  let inside = 0;
  for (let i = 0; i < count; i++) {
    const x = src.pts[i * 2];
    const y = src.pts[i * 2 + 1];
    if (x >= paper.minX - mx && x <= paper.maxX + mx && y >= paper.minY - my && y <= paper.maxY + my) inside++;
  }
  if (count < 20 || inside < count * 0.9) return unite(robust, paper);

  // 図形の主な範囲が用紙に比べて小さい（幅か高さが用紙の 75% に届かない）なら、用紙ではなく図形に合わせる。
  // 用紙の一部にだけ描いた図面が、用紙いっぱいの表示で小さく映らないようにするため
  const fill = Math.min((robust.maxX - robust.minX) / pw, (robust.maxY - robust.minY) / ph);
  if (fill < 0.75) return robust;

  return {
    minX: paper.minX - continuation(src, paper, 0),
    maxX: paper.maxX + continuation(src, paper, 1),
    minY: paper.minY - continuation(src, paper, 2),
    maxY: paper.maxY + continuation(src, paper, 3),
  };
}

/** 外へ続いているとみなすのに、刻みごとに要る図形の数 */
const CONTINUE_SUPPORT = 8;
/**
 * 通り過ぎるだけの線（その刻みで終わる図形がない）が続いてよい長さ（用紙の大きさに対する割合）。
 * 数本の長い補助線や通り芯が遠くまで伸びているだけで、「全体」が広がらないようにする
 */
const CONTINUE_BARE = 0.4;

/**
 * 用紙の辺（0 左、1 右、2 下、3 上）から外へ、図形が途切れずに続いている距離。
 *
 * 辺の外側を、辺からの距離で細かく刻み（用紙の 1.5% ずつ）、それぞれの刻みを通る図形の数を数える。
 * 線分は外に出ている部分が通るすべての刻みに 1 本として数えるので、分割された壁や、細かい線分の並びで描いた
 * 円弧も、途切れずに続いていれば最後まで追える。辺に近い刻みから外へ順に見て、図形が
 * CONTINUE_SUPPORT 以上ある刻みが続く所まで（1 刻みの隙間までは続いているとみなす）を返す。
 * 数本の線が遠くへ伸びているだけ、離れた所に図形がまとまってあるだけ、では広げない。
 * 用紙の辺ちょうどに描いた図枠が丸め誤差で「外」と数えられないよう、わずかな余裕をみる。
 */
function continuation(src: FitSource, paper: Bounds, side: number): number {
  const horizontal = side < 2;
  const span = horizontal ? paper.maxX - paper.minX : paper.maxY - paper.minY;
  const across0 = horizontal ? paper.minY : paper.minX;
  const across1 = horizontal ? paper.maxY : paper.maxX;
  // 辺に沿った向きは、用紙の幅に少し余裕を持たせた帯の中だけを見る（用紙の角の先にある図形は数えない）
  const pad = (across1 - across0) * 0.02;
  const lo = across0 - pad;
  const hi = across1 + pad;
  const tol = Math.max(0.05, Math.max(paper.maxX - paper.minX, paper.maxY - paper.minY) * 1e-5);
  const step = span * 0.015;
  const bins = 400; // 用紙の 6 倍先まで
  /** 刻みごとの図形の数を、差分で数える（線分ごとに刻みを 1 つずつ数えると、長い線が多いときに遅くなる） */
  const diff = new Int32Array(bins + 1);
  /** その刻みの中で終わる図形の、いちばん外の端（通り過ぎるだけの線は数えない） */
  const ends = new Float64Array(bins);
  // 同じ図形（円弧を分けた線分、文字の四隅）は続けて並んでいるので、まとめて 1 つとして数える
  let curEnt = -2;
  let curFirst = 0;
  let curLast = -1;
  const flush = (): void => {
    if (curLast >= curFirst) {
      diff[curFirst]++;
      diff[curLast + 1]--;
    }
    curLast = -1;
  };

  /** 辺から外への距離（外なら正） */
  const out = (x: number, y: number): number => {
    switch (side) {
      case 0: return paper.minX - x;
      case 1: return x - paper.maxX;
      case 2: return paper.minY - y;
      default: return y - paper.maxY;
    }
  };
  const along = (x: number, y: number): number => (horizontal ? y : x);

  /** 外への距離が d0〜d1 の範囲にある図形（番号 ent、-1 なら番号なし）を数える */
  const count = (d0: number, d1: number, ent: number): void => {
    if (!Number.isFinite(d1) || d1 <= tol) return;
    const first = Math.floor(Math.max(d0, tol) / step);
    const end = Math.floor(d1 / step);
    const last = Math.min(bins - 1, end);
    if (end < bins && d1 > ends[end]) ends[end] = d1;
    if (first > last) return;
    if (ent < 0 || ent !== curEnt) {
      flush();
      curEnt = ent;
      curFirst = first;
      curLast = last;
    } else {
      curFirst = Math.min(curFirst, first);
      curLast = Math.max(curLast, last);
    }
  };

  const segs = src.segs;
  for (let i = 0; i < segs.length; i += 4) {
    let x1 = segs[i], y1 = segs[i + 1], x2 = segs[i + 2], y2 = segs[i + 3];
    let d1 = out(x1, y1), d2 = out(x2, y2);
    if (d1 <= tol && d2 <= tol) continue;
    // 辺に沿った帯からはみ出す部分は切り落とす
    let t0 = 0, t1 = 1;
    const a1 = along(x1, y1), a2 = along(x2, y2);
    if (a1 === a2) {
      if (a1 < lo || a1 > hi) continue;
    } else {
      const ta = (lo - a1) / (a2 - a1);
      const tb = (hi - a1) / (a2 - a1);
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
      if (t0 > t1) continue;
    }
    const nx1 = x1 + (x2 - x1) * t0, ny1 = y1 + (y2 - y1) * t0;
    const nx2 = x1 + (x2 - x1) * t1, ny2 = y1 + (y2 - y1) * t1;
    x1 = nx1; y1 = ny1; x2 = nx2; y2 = ny2;
    d1 = out(x1, y1);
    d2 = out(x2, y2);
    count(Math.max(0, Math.min(d1, d2)), Math.max(d1, d2), src.segEnt ? src.segEnt[i / 4] : -1);
  }
  flush();
  curEnt = -2;
  const marks = src.marks;
  for (let i = 0; i < marks.length; i += 2) {
    const a = along(marks[i], marks[i + 1]);
    if (a < lo || a > hi) continue;
    const d = out(marks[i], marks[i + 1]);
    count(d, d, src.markEnt ? src.markEnt[i / 2] : -1);
  }

  // 続いている刻みの中で終わる図形の端まで広げる。通り過ぎるだけの線しかない刻みが
  // 長く続く（遠くへ伸びた長い線だけ）なら、そこで打ち切る
  flush();
  const support = new Int32Array(bins);
  let run = 0;
  for (let b = 0; b < bins; b++) {
    run += diff[b];
    support[b] = run;
  }

  let extent = 0;
  let gap = 0;
  let bare = 0;
  const maxBare = span * CONTINUE_BARE;
  for (let b = 0; b < bins; b++) {
    if (support[b] >= CONTINUE_SUPPORT) {
      gap = 0;
      if (ends[b] > 0) {
        extent = Math.max(extent, ends[b]);
        bare = 0;
      } else if ((bare += step) > maxBare) {
        break;
      }
    } else if (++gap > 1) {
      break;
    }
  }
  return extent;
}

/**
 * 図形から求めた範囲に用紙の枠を合わせる。
 * 用紙に収まっている図面では Jw_cad と同じく用紙全体が見えるようにする。
 * ただし用紙だけが極端に大きい図面（作図済みなのは一部だけ）では、
 * 用紙に合わせると図面が豆粒になるので図形の範囲を優先する。
 */
function unite(a: Bounds, b: Bounds | null): Bounds {
  if (!b) return a;
  const shape = Math.hypot(a.maxX - a.minX, a.maxY - a.minY);
  const paper = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
  if (paper > shape * 1.6) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/**
 * 図面の主要部分を囲む範囲。
 * Jw_cad の図面には用紙の外に離れた図形が残っていることがあり、全体を収めると本体が豆粒になってしまう。
 * 両端の数 % を仮に除いた範囲を芯にして、そこから密に続いている点（隣との隙間が芯の幅の 1% 以下）は、
 * 芯の幅の 15% までは含め直す。離れて残った点だけを外し、本体の端にある図形は切らないようにするため。
 * fallback は見えている図形がちょうど収まる範囲（点が少ないときはそのまま使う）。
 */
function robustBounds(pts: Float32Array, fallback: Bounds): Bounds {
  const count = pts.length / 2;
  if (count < 50) return padded(fallback);

  const sampleMax = 40000;
  const step = Math.max(1, Math.floor(count / sampleMax));
  const n = Math.floor((count - 1) / step) + 1;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < count; i += step) {
    xs[k] = pts[i * 2];
    ys[k] = pts[i * 2 + 1];
    k++;
  }
  const sx = xs.subarray(0, k).slice().sort();
  const sy = ys.subarray(0, k).slice().sort();

  const q = 0.006;
  const lo = Math.floor(k * q);
  const hi = Math.min(k - 1, Math.ceil(k * (1 - q)));
  const grow = (a: Float64Array): [number, number] => {
    const core = a[hi] - a[lo];
    const gap = core * 0.01;
    const reach = core * 0.15;
    let i0 = lo;
    let i1 = hi;
    while (i0 > 0 && a[i0] - a[i0 - 1] <= gap && a[lo] - a[i0 - 1] <= reach) i0--;
    while (i1 < k - 1 && a[i1 + 1] - a[i1] <= gap && a[i1 + 1] - a[hi] <= reach) i1++;
    return [a[i0], a[i1]];
  };
  const [minX, maxX] = grow(sx);
  const [minY, maxY] = grow(sy);
  if (!(maxX - minX > 1e-6) && !(maxY - minY > 1e-6)) return padded(fallback);
  const b = padded({ minX, maxX, minY, maxY });
  return {
    minX: Math.max(fallback.minX, b.minX),
    maxX: Math.min(fallback.maxX, b.maxX),
    minY: Math.max(fallback.minY, b.minY),
    maxY: Math.min(fallback.maxY, b.maxY),
  };
}

/** 端がぎりぎりに来ないよう少しだけ広げる */
function padded(b: Bounds): Bounds {
  const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.02;
  return { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
}