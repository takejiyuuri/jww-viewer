// JWW の図形を Scene に書き出す。形式によらない組み立ては builder.ts、「全体」の範囲は fit.ts
import type {
  JwwArc, JwwBlockDef, JwwCommon, JwwDim, JwwDocument, JwwEntities, JwwHeader, JwwLine, JwwSolid, JwwText,
} from '../jww/types.ts';
import {
  AUX_LINE_STYLE, AUX_STYLE_PEN, Builder, DASH_STYLES, IDENTITY, KIND, MAX_EXPANSIONS, Palette, SNAP_FLAG, TRUNCATED_WARNING,
  apply, colorref, compose, finishScene, finite4, type Bounds, type ColorSource, type Scene, type Xform,
} from './builder.ts';

export * from './builder.ts';
export * from './fit.ts';

/** 図形のレイヤ（0〜255）。ブロックの中身は配置した側のレイヤを引き継ぐ */
function layerOf(c: JwwCommon, inherit: number | null): number {
  return inherit ?? (((c.glayer & 15) << 4) | (c.layer & 15));
}

/** 変換で長さが何倍になるか（ブロックの倍率）。縦横で違えば平均を取る */
function lengthScale(t: Xform): number {
  const sx = Math.hypot(t.a, t.b);
  const sy = Math.hypot(t.c, t.d);
  return (sx + sy) / 2 || 1;
}

/** 線分をひとつ出す（図形の begin/end は呼び出し側）。長さを返す */
function lineSegment(b: Builder, l: JwwLine, t: Xform, snap: boolean, color: number, layer: number): number {
  const [x1, y1] = apply(t, l.x1, l.y1);
  const [x2, y2] = apply(t, l.x2, l.y2);
  b.addSegment(x1, y1, x2, y2, color, layer, snap);
  return Math.hypot(x2 - x1, y2 - y1);
}

function emitLine(b: Builder, l: JwwLine, t: Xform, inherit: number | null, block: number): void {
  const layer = layerOf(l, inherit);
  const color = b.palette.entry(l.penColor, undefined, true, l.penStyle === AUX_LINE_STYLE);
  b.begin(KIND.line, l.penColor, l.penStyle, layer, color, block);
  const len = lineSegment(b, l, t, true, color, layer);
  b.end(len);
}

/** 円弧を折れ線に展開する。扁平率と傾きを考慮した楕円弧。 */
function emitArc(b: Builder, a: JwwArc, t: Xform, inherit: number | null, block: number): void {
  const layer = layerOf(a, inherit);
  const sweep = a.isCircle ? Math.PI * 2 : a.arcAngle;
  const n = b.arcSegments(a.radius, sweep);
  const color = b.palette.entry(a.penColor, undefined, true, a.penStyle === AUX_LINE_STYLE);
  const cos = Math.cos(a.tilt);
  const sin = Math.sin(a.tilt);
  const ry = a.radius * (a.flatness || 1);

  b.begin(a.isCircle ? KIND.circle : KIND.arc, a.penColor, a.penStyle, layer, color, block);
  // 折れ線の継ぎ目や弦の真ん中は図面上の点ではないので、端点にするのは円弧の両端だけ
  const ends = a.isCircle ? 0 : 1;
  let px = 0, py = 0;
  let length = 0;
  for (let i = 0; i <= n; i++) {
    const th = a.startAngle + (sweep * i) / n;
    const lx = a.radius * Math.cos(th);
    const ly = ry * Math.sin(th);
    const [x, y] = apply(t, a.cx + lx * cos - ly * sin, a.cy + lx * sin + ly * cos);
    if (i > 0) {
      const snap = SNAP_FLAG.on | (i === 1 ? SNAP_FLAG.start * ends : 0) | (i === n ? SNAP_FLAG.end * ends : 0);
      b.addSegment(px, py, x, y, color, layer, snap);
      length += Math.hypot(x - px, y - py);
    }
    px = x;
    py = y;
  }
  const [cx, cy] = apply(t, a.cx, a.cy);
  b.addPoint(cx, cy, layer, color);
  // 吸着で使う元の式。軸の向きの 2 本 (半径, 0)・(0, 短い半径) を傾けてから、部品の変換を掛ける
  b.addCurve(
    cx, cy,
    t.a * a.radius * cos + t.c * a.radius * sin, t.b * a.radius * cos + t.d * a.radius * sin,
    -t.a * ry * sin + t.c * ry * cos, -t.b * ry * sin + t.d * ry * cos,
    a.startAngle, sweep,
  );
  const [major, minor] = ellipseAxes(t, a.radius, ry, a.tilt);
  b.end(major, arcLength(a, t, sweep, ry, cos, sin, major, minor, length), minor);
}

/**
 * 変換後の楕円の半径（長いほう・短いほう）。
 * 半径 (rx, ry) を傾き tilt で回した楕円に、ブロックの変換 t を掛けたものの特異値になる。
 */
function ellipseAxes(t: Xform, rx: number, ry: number, tilt: number): [number, number] {
  const c = Math.cos(tilt), s = Math.sin(tilt);
  // M = [[t.a, t.c], [t.b, t.d]] に R(tilt)·diag(rx, ry) を掛けた 2x2 行列
  const m00 = (t.a * c + t.c * s) * rx, m01 = (-t.a * s + t.c * c) * ry;
  const m10 = (t.b * c + t.d * s) * rx, m11 = (-t.b * s + t.d * c) * ry;
  const sum = m00 * m00 + m01 * m01 + m10 * m10 + m11 * m11;
  const det = m00 * m11 - m01 * m10;
  const root = Math.sqrt(Math.max(0, sum * sum - 4 * det * det));
  const major = Math.sqrt(Math.max(0, (sum + root) / 2));
  const minor = Math.sqrt(Math.max(0, (sum - root) / 2));
  // 真円どうしは誤差で食い違わないよう同じ値にそろえる
  return [major, Math.abs(major - minor) <= major * 1e-7 ? major : minor];
}

/**
 * 円弧の長さ。描画用に分割した折れ線の長さは弦の和なので実際より短い。
 * 真円なら半径 × 角度で正確に、楕円はずっと細かく分けて足し合わせる。
 */
function arcLength(
  a: JwwArc, t: Xform, sweep: number, ry: number, cos: number, sin: number,
  major: number, minor: number, chords: number,
): number {
  if (major === minor) return major * Math.abs(sweep);
  const steps = 2048;
  let length = 0;
  let px = 0, py = 0;
  for (let i = 0; i <= steps; i++) {
    const th = a.startAngle + (sweep * i) / steps;
    const lx = a.radius * Math.cos(th);
    const ly = ry * Math.sin(th);
    const [x, y] = apply(t, a.cx + lx * cos - ly * sin, a.cy + lx * sin + ly * cos);
    if (i > 0) length += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return Number.isFinite(length) ? length : chords;
}

function emitSolid(b: Builder, s: JwwSolid, t: Xform, inherit: number | null, block: number): void {
  const layer = layerOf(s, inherit);
  const custom = s.penColor === 10 ? s.rgb : undefined;
  const color = b.palette.entry(s.penColor, custom);
  b.begin(KIND.solid, s.penColor, s.penStyle, layer, color, block, custom ?? -1);

  if (s.penStyle >= 101) {
    // 円系ソリッド。CDataSolid を流用しており各点の意味が異なる。
    //   p1=中心, p4=(半径, 扁平率), p2=(傾き角, 開始角), p3=(円弧角, 種別)
    // 種別は 101 では -1:外側円弧 0:扇形 5:弓形 100:全円、111（円周ソリッド）では 0:円弧 100:全円、
    // 105・106（円環ソリッド）では内側の半径
    const cx = s.x1, cy = s.y1;
    const radius = s.x4;
    const flat = s.y4 || 1;
    const tilt = s.x2;
    const start = s.y2;
    const kind = s.y3;
    const sweep = kind === 100 ? Math.PI * 2 : s.x3;
    const n = b.arcSegments(radius, sweep);
    const cos = Math.cos(tilt), sin = Math.sin(tilt);
    const inner = (s.penStyle === 105 || s.penStyle === 106) ? kind : 0;

    const local = (lx: number, ly: number): [number, number] =>
      apply(t, cx + lx * cos - ly * sin, cy + lx * sin + ly * cos);
    const pt = (th: number, rr: number): [number, number] => local(rr * Math.cos(th), rr * flat * Math.sin(th));

    if (s.penStyle === 111) {
      // 円周ソリッドは円周を線として描く（中は塗らない）
      let [px, py] = pt(start, radius);
      for (let i = 1; i <= n; i++) {
        const [qx, qy] = pt(start + (sweep * i) / n, radius);
        b.addSegment(px, py, qx, qy, color, layer, false);
        px = qx; py = qy;
      }
    } else if (inner > 0) {
      // 円環「2」（106）の楕円は、外側と内側の差を長軸・短軸とも同じ幅にする
      const gap = radius - inner;
      const inside = (th: number): [number, number] => s.penStyle === 106 && flat !== 1
        ? local((radius - gap) * Math.cos(th), (radius * flat - gap) * Math.sin(th))
        : pt(th, inner);
      let [ax, ay] = pt(start, radius);
      let [bx, by] = inside(start);
      for (let i = 1; i <= n; i++) {
        const th = start + (sweep * i) / n;
        const [cx2, cy2] = pt(th, radius);
        const [dx2, dy2] = inside(th);
        b.addTriangle(ax, ay, bx, by, cx2, cy2, color, layer);
        b.addTriangle(bx, by, dx2, dy2, cx2, cy2, color, layer);
        ax = cx2; ay = cy2; bx = dx2; by = dy2;
      }
    } else {
      // 弧の点を要から扇に結んで塗る。要は、扇形・全円では中心、弓形では弧の始点（弦と弧のあいだを塗る）、
      // 外側円弧では両端の接線の交点（弧と 2 本の接線のあいだ、隅の丸面の外側を塗る）
      let [ox, oy] = apply(t, cx, cy);
      if (s.penStyle === 101 && kind === 5) {
        [ox, oy] = pt(start, radius);
      } else if (s.penStyle === 101 && kind === -1 && Math.cos(sweep / 2) > 1e-6) {
        // 楕円でも、円で求めた交点を同じ変換で移せば接線の交点になる
        [ox, oy] = pt(start + sweep / 2, radius / Math.cos(sweep / 2));
      }
      let [px, py] = pt(start, radius);
      for (let i = 1; i <= n; i++) {
        const th = start + (sweep * i) / n;
        const [qx, qy] = pt(th, radius);
        // 弓形の最初の三角形は要と始点が重なって面積がないので出さない
        if (!(s.penStyle === 101 && kind === 5 && i === 1)) b.addTriangle(ox, oy, px, py, qx, qy, color, layer);
        px = qx; py = qy;
      }
    }
    const [ox, oy] = apply(t, cx, cy);
    b.addPoint(ox, oy, layer, color);
    b.end(Math.abs(radius) * lengthScale(t));
    return;
  }

  const [x1, y1] = apply(t, s.x1, s.y1);
  const [x2, y2] = apply(t, s.x2, s.y2);
  const [x3, y3] = apply(t, s.x3, s.y3);
  const [x4, y4] = apply(t, s.x4, s.y4);
  b.addTriangle(x1, y1, x2, y2, x3, y3, color, layer);
  b.addTriangle(x1, y1, x3, y3, x4, y4, color, layer);
  b.end();
}

/** 文字をひとつ出す（図形の begin/end は呼び出し側）。texts の添字を返す。出さなければ -1 */
function textItem(b: Builder, m: JwwText, t: Xform, color: number, layer: number, entity: number): number {
  if (!m.text) return -1;
  const [x1, y1] = apply(t, m.x1, m.y1);
  const [x2, y2] = apply(t, m.x2, m.y2);
  if (!finite4(x1, y1, x2, y2) || !Number.isFinite(m.sizeY)) return -1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const width = Math.hypot(dx, dy);
  // 始終点から実際の描画角度を得る（ブロックの回転もこれで反映される）
  const angle = width > 1e-9 ? (Math.atan2(dy, dx) * 180) / Math.PI : m.angle;
  const sy = Math.hypot(t.c, t.d) || 1;
  const index = b.texts.length;
  b.texts.push({
    x: x1, y: y1,
    width: width || m.sizeX * m.text.length,
    height: m.sizeY * sy,
    angle,
    text: m.text,
    color,
    layer,
    entity,
  });
  b.track(x1, y1);
  b.track(x2, y2);
  return index;
}

function emitText(b: Builder, m: JwwText, t: Xform, inherit: number | null, block: number): void {
  if (!m.text) return;
  const layer = layerOf(m, inherit);
  const color = b.palette.entry(m.penColor);
  // 文字の penStyle は線種ではなく基点位置なので、線種としては持たない
  const e = b.begin(KIND.text, m.penColor, 0, layer, color, block);
  const index = textItem(b, m, t, color, layer, e);
  b.entText.data[e] = index;
  b.end(m.sizeY * (Math.hypot(t.c, t.d) || 1));
}

/**
 * 寸法。寸法線（と補助線）と寸法値は、それぞれ自分のレイヤで表示が決まる。
 * 実際の図面では寸法線だけが非表示の補助線レイヤにあり、値は見えている、ということがある。
 * そのため寸法線と寸法値は別の図形として扱い、互いに参照できるようにしておく。
 */
function emitDim(b: Builder, d: JwwDim, t: Xform, inherit: number | null, block: number): void {
  // 寸法線と寸法値が縮尺の違うグループに載っていることがある。寸法値と合うのは寸法そのもののグループ
  const group = layerOf(d, inherit) >> 4;
  const lineLayer = layerOf(d.line, inherit);
  const lineColor = b.palette.entry(d.line.penColor, undefined, true, d.line.penStyle === AUX_LINE_STYLE);
  const lineEnt = b.begin(KIND.dim, d.line.penColor, d.line.penStyle, lineLayer, lineColor, block, -1, group);
  const len = lineSegment(b, d.line, t, true, lineColor, lineLayer);
  b.end(len);
  const members = [lineEnt];
  if (d.extras) {
    // 補助線は計測の吸着先にしない。レイヤと線色はそれぞれが持つものに従うので、図形としても分けておく
    for (const aux of [d.extras.aux1, d.extras.aux2]) {
      const auxLayer = layerOf(aux, inherit);
      const auxColor = b.palette.entry(aux.penColor, undefined, false, aux.penStyle === AUX_LINE_STYLE);
      members.push(b.begin(KIND.dimAux, aux.penColor, aux.penStyle, auxLayer, auxColor, block, -1, group));
      b.end(lineSegment(b, aux, t, false, auxColor, auxLayer));
    }
  }

  if (!d.text.text) return;
  const textLayer = layerOf(d.text, inherit);
  const textColor = b.palette.entry(d.text.penColor);
  const textEnt = b.begin(KIND.dimText, d.text.penColor, 0, textLayer, textColor, block, -1, group);
  const index = textItem(b, d.text, t, textColor, textLayer, textEnt);
  b.entText.data[textEnt] = index;
  for (const m of members) b.entText.data[m] = index;
  b.end(len);
}

function emitEntities(
  b: Builder, defs: Map<number, JwwBlockDef>, e: JwwEntities, t: Xform, depth: number,
  open: Set<number>, inherit: number | null, block: number,
): void {
  // 上限に達したら、それ以上は展開しない（同じ部品を何重にも配置した入れ子で、時間とメモリを使い果たさないように）
  if (b.truncated) return;
  if (++b.expanded > MAX_EXPANSIONS) { b.truncated = true; return; }
  for (const l of e.lines) emitLine(b, l, t, inherit, block);
  for (const a of e.arcs) emitArc(b, a, t, inherit, block);
  for (const s of e.solids) emitSolid(b, s, t, inherit, block);
  for (const m of e.texts) emitText(b, m, t, inherit, block);

  for (const p of e.points) {
    if (p.temporary) continue;
    const [x, y] = apply(t, p.x, p.y);
    const layer = layerOf(p, inherit);
    const color = b.palette.entry(p.penColor);
    b.begin(KIND.point, p.penColor, 0, layer, color, block);
    b.addPoint(x, y, layer, color);
    // 画面にも小さな丸で描く（寸法の端の●など）
    b.addDot(x, y, b.pointRadius(p.penColor), color, layer);
    b.end();
    b.track(x, y);
  }

  for (const d of e.dims) emitDim(b, d, t, inherit, block);

  if (depth >= 16) return;
  for (const ref of e.blocks) {
    if (b.truncated) return;
    // 自分や祖先を参照し返すブロックがあると際限なく展開されるので、
    // 展開中の定義番号を覚えておいて、戻る辺を捨てる。
    if (open.has(ref.defNo)) continue;
    const def = defs.get(ref.defNo);
    if (!def) continue;
    const cos = Math.cos(ref.angle);
    const sin = Math.sin(ref.angle);
    const local: Xform = {
      a: ref.scaleX * cos, b: ref.scaleX * sin,
      c: -ref.scaleY * sin, d: ref.scaleY * cos,
      e: ref.x, f: ref.y,
    };
    open.add(ref.defNo);
    // 部品の中身は、いちばん外側で配置したレイヤに従って表示・非表示が決まる。
    // 部品の名前は、その図形をじかに含んでいる部品のものを使う。
    emitEntities(
      b, defs, def.entities, compose(local, t), depth + 1, open,
      inherit ?? layerOf(ref, null), b.blockOf(ref.defNo, () => blockName(def, ref.defNo)),
    );
    open.delete(ref.defNo);
  }
}

/** 部品名。Ver.4.10 以降の名前に付く "@@SfigorgFlag@@..." は取り除く */
function blockName(def: JwwBlockDef, defNo: number): string {
  return def.name.split('@@SfigorgFlag@@')[0].trim() || `部品 ${defNo}`;
}

/** Jw_cad の線色。元の色は図面に保存されている画面色 */
function jwColors(header: JwwHeader): ColorSource {
  return {
    base(penColor: number): [number, number, number] {
      if (penColor >= 100) {
        const e = header.sxfColors[penColor - 100];
        return e ? colorref(e.rgb) : [255, 255, 255];
      }
      const e = header.penColors[penColor];
      return e ? colorref(e.rgb) : [255, 255, 255];
    },
    label(penColor: number): string {
      if (penColor >= 1 && penColor <= 8) return `線色${penColor}`;
      if (penColor === 9) return '補助線色';
      if (penColor === 10) return '任意色';
      if (penColor === AUX_STYLE_PEN) return '補助線種';
      if (penColor >= 100) {
        const name = (header.sxfColorNames[penColor - 100] ?? '').trim();
        return name ? `SXF ${name}` : `SXF色 ${penColor - 100}`;
      }
      return `色番号 ${penColor}`;
    },
  };
}

export function buildScene(doc: JwwDocument): Scene {
  const h = doc.header;
  const b = new Builder(new Palette(jwColors(h)), {
    arcTolerance: 0.02,
    /**
     * 実点を描く半径（用紙上の mm）。Jw_cad で「実点を画面描画時の指定半径で描画」にしていれば、
     * 線色ごとの実点半径。そうでなければ 0（Jw_cad の画面と同じく、拡大しても変わらない小さな点で描く）。
     * プリンタ出力だけの指定では使わない。拡大すると大きな●が端点や交点を覆い、指したい所が見えなくなるため
     */
    pointRadius(penColor: number): number {
      if (!h.drawPointRadius) return 0;
      const r = h.pointRadius[penColor];
      return r !== undefined && Number.isFinite(r) && r > 0 && r < 100 ? r : 0;
    },
  });
  emitEntities(b, doc.blockDefs, doc.entities, IDENTITY, 0, new Set(), null, -1);
  if (b.truncated) {
    doc.warnings.push(TRUNCATED_WARNING);
  }

  const scales = new Float64Array(16);
  for (let i = 0; i < 16; i++) scales[i] = h.groups[i]?.scale || 1;
  return finishScene(b, { paper: paperRect(h.paperSize), dashes: dashTable(h), scales });
}

/**
 * 線種ごとの画面表示の模様（Scene.dashes）。Jw_cad の基本設定の「線種」に保存されているものを使う。
 * パターンは 32 ビットで、上位のビットから「1 周期のビット数」ぶんを繰り返し、1 のビットを描く。
 * 1 ビットの長さは「ピッチ」のドット数（Jw_cad は画面のドット単位で描くので、拡大・縮小しても模様の大きさは変わらない）。
 * SXF 線種（30〜62）も、Jw_cad が画面表示用に作ったパターンを持っているのでそれを使う。
 * ランダム線（11〜15）は波打つ線で破線ではないので実線にする。模様が読めない・空の線種も、線が消えないよう実線にする
 */
function dashTable(h: JwwHeader): Uint32Array {
  const out = new Uint32Array(DASH_STYLES * 2);
  for (let s = 2; s < DASH_STYLES; s++) {
    if (s >= 11 && s <= 15) continue;
    const t = h.lineTypes?.[s];
    if (!t) continue;
    const unit = t.unit >>> 0;
    const pitch = t.pitch >>> 0;
    if (unit < 1 || unit > 32 || pitch < 1 || pitch > 64) continue;
    const bits = (t.pattern >>> 0) >>> (32 - unit);
    const full = unit === 32 ? 0xffffffff : 2 ** unit - 1;
    // 描くビットが 1 つもない、またはすべて描く模様は実線
    if (bits === 0 || bits === full) continue;
    out[s * 2] = t.pattern >>> 0;
    out[s * 2 + 1] = unit | (pitch << 8);
  }
  return out;
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

export function paperRect(paperSize: number): Bounds | null {
  const size = PAPER_SIZES[paperSize];
  if (!size) return null;
  return { minX: -size[0] / 2, maxX: size[0] / 2, minY: -size[1] / 2, maxY: size[1] / 2 };
}