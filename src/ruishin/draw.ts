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

/** 起点の丸の、画面での半径（デバイスピクセル）。当たり判定にも使う */
export function originRadius(k: number): number {
  return 7 * k;
}

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
  for (const c of layer.chains) {
    const origin = layer.origins.get(c.id);
    if (!origin) continue;
    const active = c.id === layer.active || c.id === layer.dragging;
    const ink = active ? col.text : layer.colorOf?.(c) ?? col.ink;
    drawChain(ctx, toScreen, zoom, k, col, ink, c, origin, active, layer.signed);
  }
  ctx.restore();
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

  // 字の大きさは元の寸法値に合わせ、読める大きさに収める。小さすぎる（縮小しすぎ）ときは値を書かない
  const hpx = c.textHeight * zoom;
  const showText = hpx >= 3.5 * k;
  const fontPx = Math.min(Math.max(hpx, 10 * k), 24 * k);
  const gap = Math.max(fontPx * 0.35, 3 * k);

  ctx.font = `${active ? 700 : 400} ${fontPx}px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = flip ? 'right' : 'left';

  const t0 = along(c, origin.x, origin.y);

  // 列の向きの、画面での単位ベクトル（画面は y が下向き）
  const dx = c.ux, dy = -c.uy;
  const arrowLen = Math.min(Math.max(fontPx * 0.7, 8 * k), (active ? 15 : 12) * k);
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    const [px, py] = toScreen(s.x, s.y);
    if (!s.isOrigin) {
      // 寸法点の矢印：起点から離れる向きに、寸法点を先にして描く
      const dir = s.t >= t0 ? 1 : -1;
      // 起点側の隣の点（または起点）との間隔に収まる長さにする
      const prev = stops[i - dir];
      const room = prev ? Math.hypot(...sub(toScreen(prev.x, prev.y), [px, py])) : Infinity;
      const len = Math.max(Math.min(arrowLen, room * 0.45), 4 * k);
      arrow(ctx, px, py, dx * dir, dy * dir, len, ink);
    }
    // 起点には値（0）を書かない。丸だけで起点と分かる
    if (!showText || s.isOrigin) continue;
    const label = formatValue(s.value, c.format, signed);
    ctx.save();
    ctx.translate(px + sx * gap, py + sy * gap);
    ctx.rotate(angle);
    // 下の線（引出線のはみ出しなど）が字を貫いて「-」に見えないよう、字の下を背景の色で塗る
    // 値は引出線の真上ではなく、引出線の脇（字の高さの 6 割ほど手前）に書く
    const shift = -fontPx * 0.62;
    const w = ctx.measureText(label).width;
    const pad = 1.5 * k;
    ctx.fillStyle = col.halo;
    ctx.fillRect(flip ? -w - pad : -pad, shift - fontPx * 0.55, w + pad * 2, fontPx * 1.1);
    ctx.fillStyle = ink;
    ctx.fillText(label, 0, shift);
    ctx.restore();
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
  const r = originRadius(k) * (active ? 1.25 : 0.75);
  ctx.fillStyle = col.halo;
  ctx.beginPath();
  ctx.arc(ox, oy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = (active ? 2.6 : 1.4) * k;
  ctx.stroke();
  // 中に小さな点（基準点の印）
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.arc(ox, oy, (active ? 1.8 : 1.3) * k, 0, Math.PI * 2);
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
