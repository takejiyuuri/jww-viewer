// 累進寸法を計測の層（Canvas2D）に描く。
// 新しい寸法線は引かない。元の寸法線・引出線はそのまま見せ、寸法値だけを累進の値に書き換える
// （元の寸法値と同じ色・同じ書体で、各寸法点に矢印、起点に小さな丸）。
// 選んだ列だけ、寸法線と値を強調の色で目立たせる。
// 値は元の寸法値と同じ側に、寸法線と直角の向きで書く（狭い間隔の寸法でも値どうしが重ならないように）。
// 選んだ列で、起点が吸着した点が寸法線から離れていれば、その点から寸法線まで点線を引く。
import type { Background } from '../render/theme.ts';
import { formatValue, onChain, ordinates, along, type Chain, type Origin } from './ordinate.ts';

export interface OrdinateLayer {
  chains: Chain[];
  /** 列の id ごとの起点（動かしている途中の起点も、ここに入れて渡す） */
  origins: Map<number, Origin>;
  /** 選んでいる列の id。無ければ -1 */
  active: number;
  /** 起点を動かしている列の id。無ければ -1 */
  dragging: number;
  /** 起点より手前の値に「-」を付ける */
  signed: boolean;
  /** 列の元の寸法値の色（CSS の色）。分からなければ null（背景に合わせた既定の色） */
  colorOf?: (c: Chain) => string | null;
}

const COLORS: Record<Background, { text: string; ink: string; halo: string; activeBand: string }> = {
  // text は選んだ列の強調の色、ink は元の寸法値の色が分からないときの色
  dark: { text: '#fb923c', ink: '#e5e7eb', halo: 'rgba(11,12,16,0.85)', activeBand: 'rgba(251,146,60,0.28)' },
  light: { text: '#c2410c', ink: '#111827', halo: 'rgba(255,255,255,0.9)', activeBand: 'rgba(194,65,12,0.22)' },
};

// 図面の文字と同じ書体（render/textlayer.ts と合わせる）
const FONT = '"Hiragino Sans", "Noto Sans JP", -apple-system, system-ui, sans-serif';

/**
 * 起点の丸の、画面での半径（デバイスピクセル）。図面の字の大きさに合わせ、縮めて見ているときは小さくする。
 * hpx は列の寸法値の、画面での高さ（デバイスピクセル）
 */
export function originRadius(k: number, hpx = Infinity): number {
  return Math.min(Math.max(hpx * 0.45, 2.5 * k), 7 * k);
}

/** 列の寸法値の、画面での高さ（CSS ピクセル）。zoom は図面 1mm あたりのデバイスピクセル、k は devicePixelRatio */
export function textHeightCss(c: Chain, zoom: number, k: number): number {
  return (c.textHeight * zoom) / k;
}

/** この大きさ（寸法値の高さ、CSS ピクセル）より小さく見えている列は、選んだり起点を動かしたりしない（全体を見ているときなど） */
export const MIN_OPERABLE_TEXT = 7;

/**
 * 累進寸法を描く。toScreen は図面座標をデバイスピクセルへ、zoom は図面 1mm あたりのデバイスピクセル、k は devicePixelRatio
 */
export function drawOrdinates(
  ctx: CanvasRenderingContext2D,
  toScreen: (x: number, y: number) => [number, number],
  zoom: number,
  k: number,
  background: Background,
  layer: OrdinateLayer,
): void {
  const col = COLORS[background];
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const labels: Label[] = [];
  for (const c of layer.chains) {
    const origin = layer.origins.get(c.id);
    if (!origin) continue;
    const active = c.id === layer.active || c.id === layer.dragging;
    const ink = active ? col.text : layer.colorOf?.(c) ?? col.ink;
    drawChain(ctx, toScreen, zoom, k, col, ink, c, origin, active, layer.signed, labels);
  }
  drawLabels(ctx, k, col, labels);
  ctx.restore();
}

/** 書く値ひとつ。置き場所は drawLabels で、ほかの値と重ならない所を選ぶ */
interface Label {
  text: string;
  font: string;
  fontPx: number;
  ink: string;
  /** 選んでいる列の値（重なっても必ず書く。先に置く） */
  active: boolean;
  /** 値を書き始める点（寸法点から引出線の向きに少し離した所） */
  x: number;
  y: number;
  /** 引出線の向き（値を伸ばす向き）の、画面での単位ベクトル */
  ox: number;
  oy: number;
  angle: number;
  flip: boolean;
  /** 字の幅 */
  w: number;
  /** 2 段目に逃がすときに引出線の向きへずらす長さ（列でいちばん長い値の幅＋すき間） */
  tier: number;
}

interface Box { x0: number; y0: number; x1: number; y1: number }

/**
 * 値を、ほかの値と重ならない所に書く。選んでいる列の値を先に置き、そのあとは列の順に置く。
 * 置き場所の候補は、引出線の脇（片側→反対側）、引出線の向きに 1 段ずらした所（片側→反対側）の順。
 * どこに置いても重なる値は書かない（拡大すると出てくる。列を選ぶと、その列の値は全部出る）
 */
function drawLabels(ctx: CanvasRenderingContext2D, k: number, col: (typeof COLORS)[Background], labels: Label[]): void {
  if (labels.length === 0) return;
  const order = labels.map((_, i) => i).sort((a, b) => Number(labels[b].active) - Number(labels[a].active) || a - b);
  const CELL = 64 * k;
  const grid = new Map<number, Box[]>();
  const key = (cx: number, cy: number): number => cx * 100003 + cy;
  const cells = (b: Box, f: (key: number) => boolean | void): boolean => {
    for (let cx = Math.floor(b.x0 / CELL); cx <= Math.floor(b.x1 / CELL); cx++) {
      for (let cy = Math.floor(b.y0 / CELL); cy <= Math.floor(b.y1 / CELL); cy++) if (f(key(cx, cy))) return true;
    }
    return false;
  };
  const hits = (b: Box): boolean => cells(b, (kk) => grid.get(kk)?.some((o) => b.x0 < o.x1 && o.x0 < b.x1 && b.y0 < o.y1 && o.y0 < b.y1));
  const add = (b: Box): void => {
    cells(b, (kk) => {
      const list = grid.get(kk);
      if (list) list.push(b); else grid.set(kk, [b]);
    });
  };
  const pad = 1.5 * k;
  const margin = 1 * k;

  ctx.textBaseline = 'middle';
  for (const i of order) {
    const l = labels[i];
    const f = l.fontPx;
    // 候補：引出線の向きへのずれ（段）と、引出線をはさんだ脇へのずれ
    const cands: [number, number][] = [[0, -0.62 * f], [0, 0.62 * f], [l.tier, -0.62 * f], [l.tier, 0.62 * f]];
    let chosen: { tx: number; ty: number; shift: number; box: Box } | null = null;
    for (const [o, shift] of cands) {
      const tx = l.x + l.ox * o, ty = l.y + l.oy * o;
      const box = boxOf(tx, ty, l.angle, l.flip ? -l.w - pad : -pad, l.flip ? pad : l.w + pad, shift - f * 0.55, shift + f * 0.55, margin);
      if (!hits(box)) { chosen = { tx, ty, shift, box }; break; }
      if (l.active && !chosen) chosen = { tx, ty, shift, box };
    }
    if (!chosen) continue;
    add(chosen.box);
    ctx.save();
    ctx.translate(chosen.tx, chosen.ty);
    ctx.rotate(l.angle);
    ctx.font = l.font;
    ctx.textAlign = l.flip ? 'right' : 'left';
    // 下の線（引出線のはみ出しなど）が字を貫いて「-」に見えないよう、字の下を背景の色で塗る
    ctx.fillStyle = col.halo;
    ctx.fillRect(l.flip ? -l.w - pad : -pad, chosen.shift - f * 0.55, l.w + pad * 2, f * 1.1);
    ctx.fillStyle = l.ink;
    ctx.fillText(l.text, 0, chosen.shift);
    ctx.restore();
  }
}

/** (tx, ty) に置いて angle 回した、x0..x1 × y0..y1 の枠を囲む、画面の向きの四角 */
function boxOf(tx: number, ty: number, angle: number, x0: number, x1: number, y0: number, y1: number, m: number): Box {
  const c = Math.cos(angle), s = Math.sin(angle);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    const px = tx + c * x - s * y, py = ty + s * x + c * y;
    bx0 = Math.min(bx0, px); by0 = Math.min(by0, py); bx1 = Math.max(bx1, px); by1 = Math.max(by1, py);
  }
  // 斜めの列でも重なりを見落とさないよう、外接する四角で比べる（少し縮めて、接しているだけのものは重なりにしない）
  return { x0: bx0 + m, y0: by0 + m, x1: bx1 - m, y1: by1 - m };
}

function drawChain(
  ctx: CanvasRenderingContext2D,
  toScreen: (x: number, y: number) => [number, number],
  zoom: number,
  k: number,
  col: (typeof COLORS)[Background],
  ink: string,
  c: Chain,
  origin: Origin,
  active: boolean,
  signed: boolean,
  labels: Label[],
): void {
  const stops = ordinates(c, origin);
  if (stops.length === 0) return;

  // 選んでいる列は、元の寸法線を強調の色でなぞり、まわりをぼかして見分ける（選んでいない列には線を引かない）
  if (active) {
    const [x1, y1] = toScreen(...onChain(c, Math.min(c.stops[0], stops[0].t)));
    const [x2, y2] = toScreen(...onChain(c, Math.max(c.stops[c.stops.length - 1], stops[stops.length - 1].t)));
    ctx.strokeStyle = col.activeBand;
    ctx.lineWidth = 10 * k;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.strokeStyle = col.text;
    ctx.lineWidth = 2.2 * k;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // 値を書く向き：元の寸法値の側へ、寸法線と直角に。逆さにならないよう、左向きになるときは 180° 回して右に寄せる
  const sx = c.nx * c.side, sy = -c.ny * c.side; // 画面は y が下向き
  let angle = Math.atan2(sy, sx);
  let flip = false;
  if (angle > Math.PI / 2 + 1e-6 || angle < -Math.PI / 2 - 1e-6) {
    angle += Math.PI;
    flip = true;
  }

  // 字の大きさは元の寸法値と同じにする（大きく拡大したときだけ上限で止める）。
  // 図面の文字と同じく、小さすぎて読めない（縮めて見ている）ときは値を書かない
  const hpx = c.textHeight * zoom;
  const showText = hpx >= 6;
  const fontPx = Math.min(hpx, 24 * k);
  const gap = Math.max(fontPx * 0.35, 3 * k);

  // 字が読めないほど縮めて見ているときは、図面の文字と同じく何も描かない（選んだ列は寸法線の強調だけ残る）
  if (!showText) return;

  const font = `${active ? 700 : 400} ${fontPx}px ${FONT}`;
  ctx.font = font;
  // 画面の外（の、さらに 1 画面ぶん外）の値は置かない。重なりを調べる数を抑える
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const chainLabels: Label[] = [];

  const t0 = along(c, origin.x, origin.y);

  // 列の向きの、画面での単位ベクトル（画面は y が下向き）
  const dx = c.ux, dy = -c.uy;
  // 矢印も図面の字に合わせた大きさにし、縮めて見ているときは小さくする
  const arrowLen = Math.min(Math.max(hpx * 0.7, 2.5 * k), (active ? 15 : 12) * k);
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    const [px, py] = toScreen(s.x, s.y);
    if (!s.isOrigin) {
      // 寸法点の矢印：起点から離れる向きに、寸法点を先にして描く
      const dir = s.t >= t0 ? 1 : -1;
      // 起点側の隣の点（または起点）との間隔に収まる長さにする
      const prev = stops[i - dir];
      const room = prev ? Math.hypot(...sub(toScreen(prev.x, prev.y), [px, py])) : Infinity;
      const len = Math.max(Math.min(arrowLen, room * 0.45), 2 * k);
      arrow(ctx, px, py, dx * dir, dy * dir, len, ink);
    }
    // 起点には値（0）を書かない。丸だけで起点と分かる
    if (s.isOrigin) continue;
    if (px < -W || px > 2 * W || py < -H || py > 2 * H) continue;
    // 値は引出線の真上ではなく、引出線の脇に書く（置き場所は drawLabels で決める）
    const text = formatValue(s.value, c.format, signed);
    chainLabels.push({
      text, font, fontPx, ink, active,
      x: px + sx * gap, y: py + sy * gap, ox: sx, oy: sy, angle, flip,
      w: ctx.measureText(text).width, tier: 0,
    });
  }
  const tier = Math.max(0, ...chainLabels.map((l) => l.w)) + gap * 2;
  for (const l of chainLabels) {
    l.tier = tier;
    labels.push(l);
  }

  // 起点：寸法線の上の丸。選んだ列で、吸着した点が離れていれば、そこから点線で結ぶ
  const [ox, oy] = toScreen(...onChain(c, t0));
  const [rx, ry] = toScreen(origin.x, origin.y);
  if (active && Math.hypot(rx - ox, ry - oy) > 2 * k) {
    ctx.strokeStyle = col.text;
    ctx.lineWidth = 1.2 * k;
    ctx.setLineDash([5 * k, 4 * k]);
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.lineTo(ox, oy);
    ctx.stroke();
    ctx.setLineDash([]);
    // 吸着した点の印（×）
    const m = 4.5 * k;
    ctx.lineWidth = 1.6 * k;
    ctx.beginPath();
    ctx.moveTo(rx - m, ry - m); ctx.lineTo(rx + m, ry + m);
    ctx.moveTo(rx - m, ry + m); ctx.lineTo(rx + m, ry - m);
    ctx.stroke();
  }
  const r = originRadius(k, hpx) * (active ? 1.25 : 0.75);
  ctx.fillStyle = col.halo;
  ctx.beginPath();
  ctx.arc(ox, oy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.min((active ? 2.6 : 1.4) * k, r * 0.4);
  ctx.stroke();
  // 中に小さな点（基準点の印）
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.arc(ox, oy, Math.min((active ? 1.8 : 1.3) * k, r * 0.3), 0, Math.PI * 2);
  ctx.fill();
}

function sub(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] - b[0], a[1] - b[1]];
}

/** 塗りつぶしの矢印。先端が (x, y)、(ux, uy) の向きを指す。len は長さ（デバイスピクセル） */
function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, ux: number, uy: number, len: number, color: string): void {
  const half = len * 0.33;
  const bx = x - ux * len, by = y - uy * len;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(bx - uy * half, by + ux * half);
  ctx.lineTo(bx + uy * half, by - ux * half);
  ctx.closePath();
  ctx.fill();
}
