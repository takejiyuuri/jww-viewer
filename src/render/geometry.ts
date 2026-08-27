import type {
  JwwArc, JwwBlockDef, JwwDocument, JwwEntities, JwwHeader, JwwLine, JwwSolid, JwwText,
} from '../jww/types.ts';

/**
 * 描画・計測用に平坦化したシーン。
 * 線分は「1 線分 = 4 float + 3 byte」のインスタンス配列として持ち、
 * GPU 側では単位クアッドのインスタンス描画で一括して描く。
 */
export interface Scene {
  /** 全図形を含む範囲 */
  bounds: Bounds;
  /** 用紙外に散らばった図形を外れ値として除いた、初期表示に使う範囲 */
  fitBounds: Bounds;
  /** 線分 [x1,y1,x2,y2, ...] */
  linePos: Float32Array;
  /** 線分ごとの色 RGB */
  lineCol: Uint8Array;
  /** 線分ごとのレイヤグループ番号（縮尺の判定に使う） */
  lineGroup: Uint8Array;
  /** 線分ごとのスナップ可否（寸法の補助線などは対象外） */
  lineSnap: Uint8Array;
  /** 塗り三角形の頂点 */
  triPos: Float32Array;
  /** 三角形の頂点ごとの色 */
  triCol: Uint8Array;
  /** 文字（Canvas2D で描画） */
  texts: SceneText[];
  /** 円・円弧の中心、実点などの単独スナップ点 [x,y,...] */
  snapPoint: Float32Array;
  snapPointGroup: Uint8Array;
  /** レイヤグループごとの縮尺分母 */
  scales: Float64Array;
}

export interface Bounds {
  minX: number; minY: number; maxX: number; maxY: number;
}

export interface SceneText {
  x: number; y: number;
  /** 文字列の進行方向の長さ（図面座標） */
  width: number;
  height: number;
  /** 度 */
  angle: number;
  text: string;
  r: number; g: number; b: number;
  glayer: number;
}

/** 2x3 アフィン変換 */
interface Xform {
  a: number; b: number; c: number; d: number; e: number; f: number;
}

const IDENTITY: Xform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function apply(t: Xform, x: number, y: number): [number, number] {
  return [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
}

/** p を適用した後に q を適用する合成変換 */
function compose(p: Xform, q: Xform): Xform {
  return {
    a: p.a * q.a + p.b * q.c,
    b: p.a * q.b + p.b * q.d,
    c: p.c * q.a + p.d * q.c,
    d: p.c * q.b + p.d * q.d,
    e: p.e * q.a + p.f * q.c + q.e,
    f: p.e * q.b + p.f * q.d + q.f,
  };
}

/** 線分 300 万本 / 三角形 100 万枚を超えたら打ち切る（実データは数万〜20 万本） */
const MAX_LINE_FLOATS = 3_000_000 * 4;
const MAX_TRI_FLOATS = 1_000_000 * 6;

/**
 * 円弧を折れ線にするときの許容誤差（図面上の mm）。
 * 弦と弧の最大の隔たりがこれ以内になるように分割数を決める。
 */
const ARC_TOLERANCE = 0.02;

/** 許容誤差を満たす分割数。小さな円は粗く、大きな円は細かくなる */
function arcSegments(radius: number, sweep: number): number {
  const r = Math.abs(radius);
  const abs = Math.abs(sweep);
  if (!(abs > 0)) return 1;
  if (!(r > ARC_TOLERANCE)) return Math.max(3, Math.min(8, Math.ceil(abs / (Math.PI / 2))));
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - ARC_TOLERANCE / r)));
  if (!(step > 1e-6)) return 720;
  return Math.max(4, Math.min(720, Math.ceil(abs / step)));
}

function finite4(a: number, b: number, c: number, d: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d);
}

/** COLORREF (0x00BBGGRR) を RGB に分解 */
function colorref(v: number): [number, number, number] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
}

class Palette {
  private cache = new Map<number, [number, number, number]>();
  private header: JwwHeader;

  constructor(header: JwwHeader) {
    this.header = header;
  }

  get(penColor: number): [number, number, number] {
    const hit = this.cache.get(penColor);
    if (hit) return hit;
    let rgb: [number, number, number];
    if (penColor >= 100) {
      const e = this.header.sxfColors[penColor - 100];
      rgb = e ? colorref(e.rgb) : [255, 255, 255];
    } else {
      const e = this.header.penColors[penColor];
      rgb = e ? colorref(e.rgb) : [255, 255, 255];
    }
    // 黒背景に溶ける色は視認できないので持ち上げる
    if (rgb[0] + rgb[1] + rgb[2] < 24) rgb = [190, 190, 190];
    this.cache.set(penColor, rgb);
    return rgb;
  }
}

class F32Buf {
  data = new Float32Array(1 << 14);
  len = 0;

  push(...vals: number[]): void {
    if (this.len + vals.length > this.data.length) this.grow(vals.length);
    for (let i = 0; i < vals.length; i++) this.data[this.len++] = vals[i];
  }

  private grow(need: number): void {
    let size = this.data.length * 2;
    while (size < this.len + need) size *= 2;
    const next = new Float32Array(size);
    next.set(this.data);
    this.data = next;
  }

  trim(): Float32Array {
    return this.data.slice(0, this.len);
  }
}

class U8Buf {
  data = new Uint8Array(1 << 14);
  len = 0;

  push(...vals: number[]): void {
    if (this.len + vals.length > this.data.length) this.grow(vals.length);
    for (let i = 0; i < vals.length; i++) this.data[this.len++] = vals[i];
  }

  private grow(need: number): void {
    let size = this.data.length * 2;
    while (size < this.len + need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.data);
    this.data = next;
  }

  trim(): Uint8Array {
    return this.data.slice(0, this.len);
  }
}

class Builder {
  linePos = new F32Buf();
  lineCol = new U8Buf();
  lineGroup = new U8Buf();
  lineSnap = new U8Buf();
  triPos = new F32Buf();
  triCol = new U8Buf();
  texts: SceneText[] = [];
  snapPoint = new F32Buf();
  snapPointGroup = new U8Buf();
  /**
   * 初期表示の範囲を決めるための代表点。
   * 線分ごとに取ると円弧の分割数で点の数が変わり、
   * 同じ図面でも表示範囲が動いてしまうため、図形ごとに数点だけ入れる。
   */
  boundsPts = new F32Buf();
  minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
  /** 壊れたファイルで際限なく膨らむのを防ぐための打ち切り */
  truncated = false;

  readonly palette: Palette;
  readonly blockDefs: Map<number, JwwBlockDef>;

  constructor(palette: Palette, blockDefs: Map<number, JwwBlockDef>) {
    this.palette = palette;
    this.blockDefs = blockDefs;
  }

  /** 表示範囲の候補として 1 点覚える */
  sample(x: number, y: number): void {
    if (Number.isFinite(x) && Number.isFinite(y)) this.boundsPts.push(x, y);
  }

  track(x: number, y: number): void {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  }

  addSegment(
    x1: number, y1: number, x2: number, y2: number,
    rgb: [number, number, number], glayer: number, snap: boolean,
  ): void {
    // 壊れたファイルでは座標が NaN や Infinity になりうる。
    // そのまま入れると範囲計算も索引も総崩れになるので、ここで落とす。
    if (!finite4(x1, y1, x2, y2)) return;
    if (this.linePos.len >= MAX_LINE_FLOATS) { this.truncated = true; return; }
    this.linePos.push(x1, y1, x2, y2);
    this.lineCol.push(rgb[0], rgb[1], rgb[2]);
    this.lineGroup.push(glayer);
    this.lineSnap.push(snap ? 1 : 0);
    this.track(x1, y1);
    this.track(x2, y2);
  }

  addTriangle(
    x1: number, y1: number, x2: number, y2: number, x3: number, y3: number,
    rgb: [number, number, number],
  ): void {
    if (!finite4(x1, y1, x2, y2) || !finite4(x3, y3, 0, 0)) return;
    if (this.triPos.len >= MAX_TRI_FLOATS) { this.truncated = true; return; }
    this.triPos.push(x1, y1, x2, y2, x3, y3);
    this.triCol.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
    this.track(x1, y1);
    this.track(x2, y2);
    this.track(x3, y3);
  }

  addPoint(x: number, y: number, glayer: number): void {
    if (!finite4(x, y, 0, 0)) return;
    this.snapPoint.push(x, y);
    this.snapPointGroup.push(glayer);
  }
}

/**
 * ブロックの中身は定義時のレイヤ番号を持ったままだが、
 * 実際にどの縮尺で描かれるかは配置した側のレイヤグループで決まる。
 * group に値が入っていればそちらを使う。
 */
function emitLine(b: Builder, l: JwwLine, t: Xform, snap: boolean, group: number | null): void {
  const [x1, y1] = apply(t, l.x1, l.y1);
  const [x2, y2] = apply(t, l.x2, l.y2);
  b.addSegment(x1, y1, x2, y2, b.palette.get(l.penColor), group ?? l.glayer, snap);
  b.sample(x1, y1);
  b.sample(x2, y2);
}

/** 円弧を折れ線に展開する。扁平率と傾きを考慮した楕円弧。 */
function emitArc(b: Builder, a: JwwArc, t: Xform, snap: boolean, group: number | null): void {
  const sweep = a.isCircle ? Math.PI * 2 : a.arcAngle;
  const n = arcSegments(a.radius, sweep);
  const rgb = b.palette.get(a.penColor);
  const cos = Math.cos(a.tilt);
  const sin = Math.sin(a.tilt);
  const ry = a.radius * (a.flatness || 1);

  let px = 0, py = 0;
  for (let i = 0; i <= n; i++) {
    const th = a.startAngle + (sweep * i) / n;
    // 代表点は始点・中間・終点だけにして、分割数に左右されないようにする
    
    const lx = a.radius * Math.cos(th);
    const ly = ry * Math.sin(th);
    const [x, y] = apply(t, a.cx + lx * cos - ly * sin, a.cy + lx * sin + ly * cos);
    if (i > 0) b.addSegment(px, py, x, y, rgb, group ?? a.glayer, snap);
    if (i === 0 || i === n || i * 2 === n) b.sample(x, y);
    px = x;
    py = y;
  }
  if (snap) {
    const [cx, cy] = apply(t, a.cx, a.cy);
    b.addPoint(cx, cy, group ?? a.glayer);
  }
}

function emitSolid(b: Builder, s: JwwSolid, t: Xform, group: number | null): void {
  const rgb = s.penColor === 10 && s.rgb !== undefined ? colorref(s.rgb) : b.palette.get(s.penColor);

  if (s.penStyle >= 101) {
    // 円系ソリッド。CDataSolid を流用しており各点の意味が異なる。
    //   p1=中心, p4=(半径, 扁平率), p2=(傾き角, 開始角), p3=(円弧角, 種別)
    const cx = s.x1, cy = s.y1;
    const radius = s.x4;
    const flat = s.y4 || 1;
    const tilt = s.x2;
    const start = s.y2;
    const kind = s.y3;
    const sweep = kind === 100 ? Math.PI * 2 : s.x3;
    const n = arcSegments(radius, sweep);
    const cos = Math.cos(tilt), sin = Math.sin(tilt);
    // 円環ソリッドでは p3.y が内側の半径
    const inner = (s.penStyle === 105 || s.penStyle === 106) ? kind : 0;

    const pt = (th: number, rr: number): [number, number] => {
      const lx = rr * Math.cos(th);
      const ly = rr * flat * Math.sin(th);
      return apply(t, cx + lx * cos - ly * sin, cy + lx * sin + ly * cos);
    };

    if (inner > 0) {
      let [ax, ay] = pt(start, radius);
      let [bx, by] = pt(start, inner);
      for (let i = 1; i <= n; i++) {
        const th = start + (sweep * i) / n;
        const [cx2, cy2] = pt(th, radius);
        const [dx2, dy2] = pt(th, inner);
        b.addTriangle(ax, ay, bx, by, cx2, cy2, rgb);
        b.addTriangle(bx, by, dx2, dy2, cx2, cy2, rgb);
        ax = cx2; ay = cy2; bx = dx2; by = dy2;
      }
    } else {
      const [ox, oy] = apply(t, cx, cy);
      let [px, py] = pt(start, radius);
      for (let i = 1; i <= n; i++) {
        const th = start + (sweep * i) / n;
        const [qx, qy] = pt(th, radius);
        b.addTriangle(ox, oy, px, py, qx, qy, rgb);
        px = qx; py = qy;
      }
    }
    const [ox, oy] = apply(t, cx, cy);
    b.addPoint(ox, oy, group ?? s.glayer);
    b.sample(ox - radius, oy - radius);
    b.sample(ox + radius, oy + radius);
    return;
  }

  const [x1, y1] = apply(t, s.x1, s.y1);
  const [x2, y2] = apply(t, s.x2, s.y2);
  const [x3, y3] = apply(t, s.x3, s.y3);
  const [x4, y4] = apply(t, s.x4, s.y4);
  b.addTriangle(x1, y1, x2, y2, x3, y3, rgb);
  b.addTriangle(x1, y1, x3, y3, x4, y4, rgb);
  b.sample(x1, y1);
  b.sample(x2, y2);
  b.sample(x3, y3);
  b.sample(x4, y4);
}

function emitText(b: Builder, m: JwwText, t: Xform, group: number | null): void {
  if (!m.text) return;
  const [x1, y1] = apply(t, m.x1, m.y1);
  const [x2, y2] = apply(t, m.x2, m.y2);
  if (!finite4(x1, y1, x2, y2) || !Number.isFinite(m.sizeY)) return;
  const rgb = b.palette.get(m.penColor);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const width = Math.hypot(dx, dy);
  // 始終点から実際の描画角度を得る（ブロックの回転もこれで反映される）
  const angle = width > 1e-9 ? (Math.atan2(dy, dx) * 180) / Math.PI : m.angle;
  const sy = Math.hypot(t.c, t.d) || 1;
  b.texts.push({
    x: x1, y: y1,
    width: width || m.sizeX * m.text.length,
    height: m.sizeY * sy,
    angle,
    text: m.text,
    r: rgb[0], g: rgb[1], b: rgb[2],
    glayer: group ?? m.glayer,
  });
  b.track(x1, y1);
  b.track(x2, y2);
  b.sample(x1, y1);
  b.sample(x2, y2);
}

function emitEntities(
  b: Builder, e: JwwEntities, t: Xform, depth: number,
  open: Set<number>, group: number | null,
): void {
  for (const l of e.lines) emitLine(b, l, t, true, group);
  for (const a of e.arcs) emitArc(b, a, t, true, group);
  for (const s of e.solids) emitSolid(b, s, t, group);
  for (const m of e.texts) emitText(b, m, t, group);

  for (const p of e.points) {
    if (p.temporary) continue;
    const [x, y] = apply(t, p.x, p.y);
    b.addPoint(x, y, group ?? p.glayer);
    b.track(x, y);
    b.sample(x, y);
  }

  for (const d of e.dims) {
    emitLine(b, d.line, t, true, group);
    emitText(b, d.text, t, group);
    if (d.extras) {
      emitLine(b, d.extras.aux1, t, false, group);
      emitLine(b, d.extras.aux2, t, false, group);
    }
  }

  if (depth >= 16) return;
  for (const ref of e.blocks) {
    // 自分や祖先を参照し返すブロックがあると際限なく展開されるので、
    // 展開中の定義番号を覚えておいて、戻る辺を捨てる。
    if (open.has(ref.defNo)) continue;
    const def = b.blockDefs.get(ref.defNo);
    if (!def) continue;
    const cos = Math.cos(ref.angle);
    const sin = Math.sin(ref.angle);
    const local: Xform = {
      a: ref.scaleX * cos, b: ref.scaleX * sin,
      c: -ref.scaleY * sin, d: ref.scaleY * cos,
      e: ref.x, f: ref.y,
    };
    open.add(ref.defNo);
    emitEntities(b, def.entities, compose(local, t), depth + 1, open, ref.glayer);
    open.delete(ref.defNo);
  }
}

export function buildScene(doc: JwwDocument): Scene {
  const b = new Builder(new Palette(doc.header), doc.blockDefs);
  emitEntities(b, doc.entities, IDENTITY, 0, new Set(), null);
  if (b.truncated) {
    doc.warnings.push('図形が多すぎたため、描画データを途中で打ち切りました');
  }

  const scales = new Float64Array(16);
  for (let i = 0; i < 16; i++) scales[i] = doc.header.groups[i]?.scale || 1;

  const paper = paperRect(doc.header.paperSize);
  const empty = !Number.isFinite(b.minX);
  const bounds: Bounds = empty
    ? { minX: 0, minY: 0, maxX: 100, maxY: 100 }
    : { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };

  const linePos = b.linePos.trim();
  return {
    bounds,
    fitBounds: unite(robustBounds(b.boundsPts.trim(), bounds), paper),
    linePos,
    lineCol: b.lineCol.trim(),
    lineGroup: b.lineGroup.trim(),
    lineSnap: b.lineSnap.trim(),
    triPos: b.triPos.trim(),
    triCol: b.triCol.trim(),
    texts: b.texts,
    snapPoint: b.snapPoint.trim(),
    snapPointGroup: b.snapPointGroup.trim(),
    scales,
  };
}

/**
 * 用紙の寸法（mm）。JWW の座標は用紙中心を原点に取る。
 * 0〜4:A0〜A4、8〜11:2A〜5A、12〜14:10m/50m/100m
 */
const PAPER_SIZES: Record<number, [number, number]> = {
  0: [1189, 841],
  1: [841, 594],
  2: [594, 420],
  3: [420, 297],
  4: [297, 210],
  8: [1682, 1189],
  9: [2378, 1682],
  10: [3364, 2378],
  11: [4756, 3364],
  12: [10000, 7071],
  13: [50000, 35355],
  14: [100000, 70711],
};

function paperRect(paperSize: number): Bounds | null {
  const size = PAPER_SIZES[paperSize];
  if (!size) return null;
  return { minX: -size[0] / 2, maxX: size[0] / 2, minY: -size[1] / 2, maxY: size[1] / 2 };
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
 * Jw_cad の図面には用紙の外に離れた図形が残っていることがあり、
 * 全体を収めると本体が豆粒になってしまうため、端の数 % を切り捨てる。
 */
function robustBounds(pts: Float32Array, fallback: Bounds): Bounds {
  const count = pts.length / 2;
  if (count < 50) return fallback;

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
  const r: Bounds = { minX: sx[lo], maxX: sx[hi], minY: sy[lo], maxY: sy[hi] };

  const w = r.maxX - r.minX;
  const h = r.maxY - r.minY;
  if (!(w > 1e-6) || !(h > 1e-6)) return fallback;

  // 切り落とした端がぎりぎりに来ないよう少しだけ広げる
  const pad = Math.max(w, h) * 0.02;
  return {
    minX: Math.max(fallback.minX, r.minX - pad),
    maxX: Math.min(fallback.maxX, r.maxX + pad),
    minY: Math.max(fallback.minY, r.minY - pad),
    maxY: Math.min(fallback.maxY, r.maxY + pad),
  };
}
