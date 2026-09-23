import type { Scene } from '../render/geometry.ts';

export type SnapKind = 'endpoint' | 'center' | 'intersection' | 'midpoint' | 'online' | 'free';

/** 水平・垂直の拘束方向 */
export type Axis = 'horizontal' | 'vertical';

export interface SnapResult {
  x: number;
  y: number;
  kind: SnapKind;
  glayer: number;
  /**
   * 交点のように、どのレイヤグループの図形なのかが一意に決まらない場合に立つ。
   * 縮尺を自動で決めてしまうと計測値が何倍もずれるため、呼び出し側で避ける。
   */
  ambiguousGroup?: boolean;
}

/** 種別ごとの優先度。距離に掛けて比較するので小さいほど優先される。 */
const WEIGHT: Record<SnapKind, number> = {
  endpoint: 0.4,
  center: 0.45,
  intersection: 0.55,
  midpoint: 0.95,
  online: 2.2,
  free: 999,
};

/** 1 セルにまたがりすぎる線分は個別に持たず全件走査に回す */
const BIG_SPAN = 24;

/** 1 回のタップで見る線分の上限。これを超える密度は現実の図面では起きない */
const SCAN_MAX = 20000;

/** 点と線分の距離の 2 乗 */
function segDist2(pos: Float32Array, i: number, x: number, y: number): number {
  const ax = pos[i * 4], ay = pos[i * 4 + 1];
  const bx = pos[i * 4 + 2], by = pos[i * 4 + 3];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 1e-12 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + dx * t - x;
  const py = ay + dy * t - y;
  return px * px + py * py;
}

/**
 * 線分と単独点の一様グリッド索引。
 * TypedArray の CSR 形式で持ち、タップ位置周辺だけを走査する。
 */
export class SnapIndex {
  private cell: number;
  private gw: number;
  private gh: number;
  private minX: number;
  private minY: number;
  private offsets: Int32Array;
  private items: Int32Array;
  private big: Int32Array;

  private pOffsets: Int32Array;
  private pItems: Int32Array;
  private scene: Scene;
  /**
   * 色番号ごとに吸着させるかどうか。null なら全部。
   * 画面で隠している色の線に吸着すると、見えない所に点が乗って混乱するため。
   */
  private visibleColor: Uint8Array | null = null;

  constructor(scene: Scene) {
    this.scene = scene;
    const { bounds } = scene;
    const w = Math.max(bounds.maxX - bounds.minX, 1e-6);
    const h = Math.max(bounds.maxY - bounds.minY, 1e-6);
    const segCount = scene.linePos.length / 4;

    // 1 セルあたり数本になるようにセル数を決める
    const targetCells = Math.max(64, Math.min(1 << 18, segCount));
    this.cell = Math.max(Math.sqrt((w * h) / targetCells), 1e-6);
    this.gw = Math.max(1, Math.ceil(w / this.cell));
    this.gh = Math.max(1, Math.ceil(h / this.cell));
    this.minX = bounds.minX;
    this.minY = bounds.minY;

    const cells = this.gw * this.gh;
    const counts = new Int32Array(cells);
    const bigList: number[] = [];

    const pos = scene.linePos;
    const snap = scene.lineSnap;

    // 1 パス目: セルごとの件数を数える
    for (let i = 0; i < segCount; i++) {
      if (!snap[i]) continue;
      const r = this.cellRange(pos[i * 4], pos[i * 4 + 1], pos[i * 4 + 2], pos[i * 4 + 3]);
      if ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) > BIG_SPAN) {
        bigList.push(i);
        continue;
      }
      for (let gy = r.y0; gy <= r.y1; gy++) {
        for (let gx = r.x0; gx <= r.x1; gx++) counts[gy * this.gw + gx]++;
      }
    }

    this.offsets = new Int32Array(cells + 1);
    for (let i = 0; i < cells; i++) this.offsets[i + 1] = this.offsets[i] + counts[i];
    this.items = new Int32Array(this.offsets[cells]);

    // 2 パス目: 実際に詰める
    const cursor = this.offsets.slice(0, cells);
    for (let i = 0; i < segCount; i++) {
      if (!snap[i]) continue;
      const r = this.cellRange(pos[i * 4], pos[i * 4 + 1], pos[i * 4 + 2], pos[i * 4 + 3]);
      if ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) > BIG_SPAN) continue;
      for (let gy = r.y0; gy <= r.y1; gy++) {
        for (let gx = r.x0; gx <= r.x1; gx++) {
          const c = gy * this.gw + gx;
          this.items[cursor[c]++] = i;
        }
      }
    }
    this.big = Int32Array.from(bigList);

    // 単独点も同じグリッドに載せる
    const pts = scene.snapPoint;
    const pCount = pts.length / 2;
    const pCounts = new Int32Array(cells);
    for (let i = 0; i < pCount; i++) {
      pCounts[this.cellOf(pts[i * 2], pts[i * 2 + 1])]++;
    }
    this.pOffsets = new Int32Array(cells + 1);
    for (let i = 0; i < cells; i++) this.pOffsets[i + 1] = this.pOffsets[i] + pCounts[i];
    this.pItems = new Int32Array(this.pOffsets[cells]);
    const pCursor = this.pOffsets.slice(0, cells);
    for (let i = 0; i < pCount; i++) {
      const c = this.cellOf(pts[i * 2], pts[i * 2 + 1]);
      this.pItems[pCursor[c]++] = i;
    }
  }

  /** 色番号ごとの表示状態（1 なら表示）を渡す。隠した色には吸着しなくなる */
  setVisibleColors(visible: Uint8Array | null): void {
    this.visibleColor = visible;
  }

  private pointVisible(i: number): boolean {
    const v = this.visibleColor;
    return !v || v[this.scene.snapPointColor[i]] === 1;
  }

  private clampGx(v: number): number {
    return v < 0 ? 0 : v >= this.gw ? this.gw - 1 : v;
  }

  private clampGy(v: number): number {
    return v < 0 ? 0 : v >= this.gh ? this.gh - 1 : v;
  }

  private cellOf(x: number, y: number): number {
    const gx = this.clampGx(Math.floor((x - this.minX) / this.cell));
    const gy = this.clampGy(Math.floor((y - this.minY) / this.cell));
    return gy * this.gw + gx;
  }

  private cellRange(x1: number, y1: number, x2: number, y2: number) {
    return {
      x0: this.clampGx(Math.floor((Math.min(x1, x2) - this.minX) / this.cell)),
      x1: this.clampGx(Math.floor((Math.max(x1, x2) - this.minX) / this.cell)),
      y0: this.clampGy(Math.floor((Math.min(y1, y2) - this.minY) / this.cell)),
      y1: this.clampGy(Math.floor((Math.max(y1, y2) - this.minY) / this.cell)),
    };
  }

  /**
   * 半径 r 以内の線分を、タップ位置に近い順で最大 limit 本返す。
   * グリッドの走査順で先着順に打ち切ると、指の真下の線分が候補から漏れて
   * 遠い線分に吸着してしまうので、必ず距離で選び直す。
   */
  private nearbySegments(x: number, y: number, r: number, limit: number): number[] {
    const out: number[] = [];
    const gx0 = this.clampGx(Math.floor((x - r - this.minX) / this.cell));
    const gx1 = this.clampGx(Math.floor((x + r - this.minX) / this.cell));
    const gy0 = this.clampGy(Math.floor((y - r - this.minY) / this.cell));
    const gy1 = this.clampGy(Math.floor((y + r - this.minY) / this.cell));
    const seen = new Set<number>();
    const pos = this.scene.linePos;
    const lineColor = this.scene.lineColor;
    const vis = this.visibleColor;
    const r2 = r * r;
    const dist: number[] = [];

    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const c = gy * this.gw + gx;
        for (let k = this.offsets[c]; k < this.offsets[c + 1]; k++) {
          const i = this.items[k];
          if (seen.has(i)) continue;
          seen.add(i);
          if (vis && !vis[lineColor[i]]) continue;
          const d2 = segDist2(pos, i, x, y);
          if (d2 > r2) continue;
          out.push(i);
          dist.push(d2);
        }
      }
      if (out.length >= SCAN_MAX) break;
    }
    // 長い線分（通り芯や外形線）はセルに載せていないので必ず合流させる
    for (let k = 0; k < this.big.length; k++) {
      const i = this.big[k];
      if (seen.has(i)) continue;
      seen.add(i);
      if (vis && !vis[lineColor[i]]) continue;
      const d2 = segDist2(pos, i, x, y);
      if (d2 > r2) continue;
      out.push(i);
      dist.push(d2);
    }

    if (out.length <= limit) return out;
    // 距離は計算済みなので、並べ替えは添字だけで済ませる
    const order = out.map((_, k) => k);
    order.sort((a, b) => dist[a] - dist[b]);
    const picked = new Array<number>(limit);
    for (let k = 0; k < limit; k++) picked[k] = out[order[k]];
    return picked;
  }

  /**
   * タップ位置に最も相応しいスナップ点を返す。
   * radius は図面座標での許容半径。
   */
  query(x: number, y: number, radius: number): SnapResult {
    const pos = this.scene.linePos;
    const group = this.scene.lineGroup;
    const r2 = radius * radius;

    let best: SnapResult = { x, y, kind: 'free', glayer: 0 };
    let bestScore = Infinity;

    const consider = (
      px: number, py: number, kind: SnapKind, glayer: number, ambiguous = false,
    ): void => {
      const dx = px - x;
      const dy = py - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) return;
      const score = Math.sqrt(d2) * WEIGHT[kind];
      if (score < bestScore) {
        bestScore = score;
        best = ambiguous
          ? { x: px, y: py, kind, glayer, ambiguousGroup: true }
          : { x: px, y: py, kind, glayer };
      }
    };

    // 単独点（円中心・実点）
    const pts = this.scene.snapPoint;
    const pg = this.scene.snapPointGroup;
    const gx0 = this.clampGx(Math.floor((x - radius - this.minX) / this.cell));
    const gx1 = this.clampGx(Math.floor((x + radius - this.minX) / this.cell));
    const gy0 = this.clampGy(Math.floor((y - radius - this.minY) / this.cell));
    const gy1 = this.clampGy(Math.floor((y + radius - this.minY) / this.cell));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const c = gy * this.gw + gx;
        for (let k = this.pOffsets[c]; k < this.pOffsets[c + 1]; k++) {
          const i = this.pItems[k];
          if (!this.pointVisible(i)) continue;
          consider(pts[i * 2], pts[i * 2 + 1], 'center', pg[i]);
        }
      }
    }

    const segs = this.nearbySegments(x, y, radius, 400);

    for (const i of segs) {
      const ax = pos[i * 4], ay = pos[i * 4 + 1];
      const bx = pos[i * 4 + 2], by = pos[i * 4 + 3];
      const g = group[i];
      consider(ax, ay, 'endpoint', g);
      consider(bx, by, 'endpoint', g);
      consider((ax + bx) / 2, (ay + by) / 2, 'midpoint', g);

      // 線上の最近点
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 > 1e-12) {
        let t = ((x - ax) * dx + (y - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        consider(ax + dx * t, ay + dy * t, 'online', g);
      }
    }

    // 交点は組み合わせが増えるので、近い順に並んだ先頭だけを掛け合わせる
    const cross = segs.length > 60 ? segs.slice(0, 60) : segs;
    for (let a = 0; a < cross.length; a++) {
      const i = cross[a];
      const ax = pos[i * 4], ay = pos[i * 4 + 1];
      const bx = pos[i * 4 + 2], by = pos[i * 4 + 3];
      for (let b = a + 1; b < cross.length; b++) {
        const j = cross[b];
        const cx = pos[j * 4], cy = pos[j * 4 + 1];
        const dx2 = pos[j * 4 + 2], dy2 = pos[j * 4 + 3];
        const p = intersect(ax, ay, bx, by, cx, cy, dx2, dy2);
        if (!p) continue;
        // 交わる 2 本のレイヤグループが違うと、どちらの縮尺で測るべきか決まらない。
        // 近い方を採ったうえで、決め手がないことを呼び出し側に伝える。
        const gi = group[i];
        const gj = group[j];
        if (gi === gj) {
          consider(p[0], p[1], 'intersection', gi);
        } else {
          const near = segDist2(pos, i, x, y) <= segDist2(pos, j, x, y) ? gi : gj;
          const sameScale = this.scene.scales[gi] === this.scene.scales[gj];
          consider(p[0], p[1], 'intersection', near, !sameScale);
        }
      }
    }

    return best;
  }

  /**
   * 基準点から水平（または垂直）に伸ばした線の上だけで吸着先を探す。
   * 「この面から真横に、あの壁まで」のような測り方をするための経路で、
   * 拘束線と図形が交わる位置、拘束線の近くにある点、の順に優先する。
   */
  queryOnAxis(
    originX: number, originY: number, axis: Axis,
    targetX: number, targetY: number, radius: number,
  ): SnapResult {
    const horizontal = axis === 'horizontal';
    // 拘束線に落とした位置。ここが基準になる
    const px = horizontal ? targetX : originX;
    const py = horizontal ? originY : targetY;

    const pos = this.scene.linePos;
    const group = this.scene.lineGroup;

    let best: SnapResult = { x: px, y: py, kind: 'free', glayer: 0 };
    let bestScore = Infinity;

    /** 拘束線に沿った向きでの隔たり（この距離が近いほど良い） */
    const along = (x: number, y: number): number =>
      Math.abs(horizontal ? x - targetX : y - targetY);

    const consider = (x: number, y: number, kind: SnapKind, glayer: number, ambiguous = false): void => {
      const d = along(x, y);
      if (d > radius) return;
      const score = d * WEIGHT[kind];
      if (score < bestScore) {
        bestScore = score;
        best = ambiguous
          ? { x, y, kind, glayer, ambiguousGroup: true }
          : { x, y, kind, glayer };
      }
    };

    for (const i of this.nearbySegments(px, py, radius, 400)) {
      const ax = pos[i * 4], ay = pos[i * 4 + 1];
      const bx = pos[i * 4 + 2], by = pos[i * 4 + 3];

      if (horizontal) {
        // 拘束線と平行な線分とは交点が定まらないので、端点だけを見る
        if (ay === by) {
          if (Math.abs(ay - originY) <= 1e-9) {
            consider(ax, ay, 'endpoint', group[i]);
            consider(bx, by, 'endpoint', group[i]);
          }
          continue;
        }
        if ((ay - originY) * (by - originY) > 0) continue;
        const t = (originY - ay) / (by - ay);
        consider(ax + (bx - ax) * t, originY, 'intersection', group[i]);
      } else {
        if (ax === bx) {
          if (Math.abs(ax - originX) <= 1e-9) {
            consider(ax, ay, 'endpoint', group[i]);
            consider(bx, by, 'endpoint', group[i]);
          }
          continue;
        }
        if ((ax - originX) * (bx - originX) > 0) continue;
        const t = (originX - ax) / (bx - ax);
        consider(originX, ay + (by - ay) * t, 'intersection', group[i]);
      }
    }

    // 円の中心や実点は、拘束線の近くにあれば拾う（真上に乗ることは稀なため）
    const pts = this.scene.snapPoint;
    const pg = this.scene.snapPointGroup;
    const near = radius * 0.25;
    const gx0 = this.clampGx(Math.floor((px - radius - this.minX) / this.cell));
    const gx1 = this.clampGx(Math.floor((px + radius - this.minX) / this.cell));
    const gy0 = this.clampGy(Math.floor((py - radius - this.minY) / this.cell));
    const gy1 = this.clampGy(Math.floor((py + radius - this.minY) / this.cell));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const c = gy * this.gw + gx;
        for (let k = this.pOffsets[c]; k < this.pOffsets[c + 1]; k++) {
          const i = this.pItems[k];
          if (!this.pointVisible(i)) continue;
          const x = pts[i * 2];
          const y = pts[i * 2 + 1];
          const off = horizontal ? Math.abs(y - originY) : Math.abs(x - originX);
          if (off > near) continue;
          // 拘束線上に落として使う
          consider(horizontal ? x : originX, horizontal ? originY : y, 'center', pg[i]);
        }
      }
    }

    return best;
  }
}

/** 2 線分の交点。交差しなければ null */
function intersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): [number, number] | null {
  const r0 = bx - ax, r1 = by - ay;
  const s0 = dx - cx, s1 = dy - cy;
  const denom = r0 * s1 - r1 * s0;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((cx - ax) * s1 - (cy - ay) * s0) / denom;
  const u = ((cx - ax) * r1 - (cy - ay) * r0) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [ax + r0 * t, ay + r1 * t];
}
