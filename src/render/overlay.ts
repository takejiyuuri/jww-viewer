import type { View } from './renderer.ts';
import type { MeasureMode, MeasurePoint } from '../measure/measure.ts';
import type { Axis, SnapResult } from '../measure/snap.ts';
import {
  SNAP_LABEL, formatArea, formatLength, formatVolume, measureArea, measureLengths, polygonCenter,
} from '../measure/measure.ts';
import type { MeasureInk } from '../measure/colors.ts';
import type { Background } from './theme.ts';

/**
 * 背景の明暗によって見え方が変わる補助線の色。
 * 白背景に白い点線を引いても見えないので、背景ごとに用意する。
 */
const INK: Record<Background, { guide: string; frame: string; halo: string; mark: string }> = {
  dark: {
    guide: 'rgba(255,255,255,0.35)',
    frame: 'rgba(255,255,255,0.5)',
    halo: 'rgba(0,0,0,0.55)',
    mark: 'rgba(255,255,255,0.72)',
  },
  light: {
    guide: 'rgba(0,0,0,0.32)',
    frame: 'rgba(0,0,0,0.42)',
    halo: 'rgba(255,255,255,0.8)',
    mark: 'rgba(0,0,0,0.72)',
  },
};

export interface MagnifierBox {
  /** CSS ピクセル、左上原点 */
  x: number;
  y: number;
  size: number;
}

/** 属性を見ている図形の形。目立たせて描く */
export interface Highlight {
  /** 線分 [x1,y1,x2,y2, ...]（図面座標） */
  lines: Float32Array;
  /** 塗り三角形 [x1,y1,x2,y2,x3,y3, ...] */
  tris: Float32Array;
  /** 文字の四隅（寸法線なら寸法値の文字） */
  box: number[] | null;
  /** 点だけの図形の位置 */
  point: [number, number] | null;
}

export interface OverlayState {
  points: MeasurePoint[];
  /** 属性を見ている図形 */
  highlight: Highlight | null;
  /** 水平・垂直に拘束しているときの基準点と向き */
  constraint: { x: number; y: number; axis: Axis } | null;
  /** つまんで動かしている点の番号 */
  activeIndex: number | null;
  /** 長押し中のスナップ候補 */
  preview: SnapResult | null;
  /** 長押し中の指の位置（CSS ピクセル） */
  cursor: { x: number; y: number } | null;
  magnifier: MagnifierBox | null;
  /** 拡大鏡が映している図面座標と倍率（指の位置が中心） */
  magnifierView: { x: number; y: number; zoom: number; dpr: number } | null;
  /** 計測に使う縮尺分母 */
  scale: number;
  /** 利用者が縮尺を選んでいて、すべての区間をその縮尺で測る */
  fixedScale: boolean;
  /** 距離・面積・体積のどれを測っているか */
  mode: MeasureMode;
  /** 体積で面積に掛ける高さ（実寸 mm） */
  height: number;
  /** 計測の印・線・数字の色 */
  ink: MeasureInk;
}

/** 属性で見ている図形を目立たせる色 */
const ACCENT = '#35d07f';

export class Overlay {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  /** いまの背景。補助線の色を決めるのに使う */
  background: Background = 'dark';
  /**
   * 拡大鏡の中に文字を描く。文字は別のキャンバスで描いているので、描き方は外から渡してもらう。
   * x, y, w, h は拡大鏡の範囲（デバイスピクセル）
   */
  drawMagnifierText: ((ctx: CanvasRenderingContext2D, view: View, x: number, y: number, w: number, h: number) => void) | null = null;

  readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('2D コンテキストを取得できません');
    this.ctx = ctx;
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    this.dpr = dpr;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.w = w;
    this.h = h;
  }

  private toScreen(view: View, x: number, y: number): [number, number] {
    return [
      (x - view.cx) * view.zoom + this.w / 2,
      this.h / 2 - (y - view.cy) * view.zoom,
    ];
  }

  render(view: View, s: OverlayState): void {
    const ctx = this.ctx;
    const k = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const pts = s.points.map((p) => this.toScreen(view, p.x, p.y));

    // 拡大鏡が出ている間は、その中に測線やラベルを描き込まない。
    // 拡大して見たいのは図面そのものなので、上に重ねると邪魔になる。
    const mag = s.magnifier;
    if (mag) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, this.w, this.h);
      ctx.rect(mag.x * k, mag.y * k, mag.size * k, mag.size * k);
      ctx.clip('evenodd');
    }

    // 属性を見ている図形。測線より下に描いて、計測の表示を隠さないようにする
    if (s.highlight) {
      this.drawHighlight(s.highlight, (x, y) => this.toScreen(view, x, y), k);
    }

    const ink = s.ink;
    // 面積・体積では、3 点以上で最後の点から最初の点へ戻して囲む
    const closed = s.mode !== 'length' && pts.length >= 3;

    // 直交拘束の基準線。この線の上だけを動くことを示す
    if (s.constraint) {
      const [cx, cy] = this.toScreen(view, s.constraint.x, s.constraint.y);
      ctx.strokeStyle = ink.guide;
      ctx.lineWidth = 1 * k;
      ctx.setLineDash([9 * k, 7 * k]);
      ctx.beginPath();
      if (s.constraint.axis === 'horizontal') {
        ctx.moveTo(0, cy);
        ctx.lineTo(this.w, cy);
      } else {
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, this.h);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 囲んだ範囲を薄く塗る
    if (closed) {
      ctx.fillStyle = ink.fill;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fill();
    }

    // 測線。囲むときの最後の点から最初の点へ戻る辺は点線にして、置いた辺と見分ける
    if (pts.length >= 2) {
      ctx.strokeStyle = ink.line;
      ctx.lineWidth = 2 * k;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
      if (closed) {
        ctx.setLineDash([7 * k, 6 * k]);
        ctx.beginPath();
        ctx.moveTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        ctx.lineTo(pts[0][0], pts[0][1]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // 辺の長さ。下の計測結果と同じ縮尺で実寸に直す
    // （距離は区間ごとに両端が乗っている図の縮尺、面積・体積は囲んだ範囲全体で一つの縮尺）
    if (pts.length >= 2) {
      const n = pts.length;
      const edges = s.mode === 'length'
        ? measureLengths(s.points, s.scale, s.fixedScale).segments
        : measureArea(s.points, s.scale, s.fixedScale).edges;
      for (let i = 0; i < edges.length; i++) {
        // 同じ所に重ねた点のあいだ（長さ 0）は、印の上に「0.0 mm」が重なるだけなので出さない
        if (!(edges[i] > 1e-6)) continue;
        const a = pts[i];
        const b = pts[(i + 1) % n];
        this.pill((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, formatLength(edges[i]), k, ink);
      }
    }

    // 確定した点。動かしている点は大きく描く
    for (let i = 0; i < pts.length; i++) {
      const strong = i === s.activeIndex || (s.activeIndex === null && i === pts.length - 1);
      this.marker(pts[i][0], pts[i][1], k, strong, ink);
    }

    // 面積・体積の値は、囲んだ範囲の真ん中に大きめに出す（辺の長さより手前に）
    if (closed) {
      const m = measureArea(s.points, s.scale, s.fixedScale);
      const c = polygonCenter(s.points);
      const [cx, cy] = this.toScreen(view, c.x, c.y);
      const text = s.mode === 'volume' ? formatVolume(m.area * s.height) : formatArea(m.area);
      this.pill(cx, cy, text, k, ink, true);
    }

    // 長押し中のプレビュー
    if (s.preview) {
      const [px, py] = this.toScreen(view, s.preview.x, s.preview.y);
      ctx.strokeStyle = INK[this.background].guide;
      ctx.lineWidth = 1 * k;
      ctx.setLineDash([5 * k, 5 * k]);
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(this.w, py);
      ctx.moveTo(px, 0);
      ctx.lineTo(px, this.h);
      ctx.stroke();
      ctx.setLineDash([]);

      this.marker(px, py, k, true, ink);
      if (s.preview.kind !== 'free') {
        this.pill(px, py - 26 * k, SNAP_LABEL[s.preview.kind], k, null);
      }
    }

    if (mag) ctx.restore();

    // ルーペ
    if (s.magnifier) {
      const m = s.magnifier;
      const x = m.x * k;
      const y = m.y * k;
      const size = m.size * k;
      const view2 = s.magnifierView;

      // 拡大鏡の中の図形は WebGL が描き直しているので、文字もここで拡大して重ねる
      if (view2 && this.drawMagnifierText) {
        ctx.save();
        this.roundRect(x, y, size, size, 14 * k);
        ctx.clip();
        this.drawMagnifierText(ctx, { cx: view2.x, cy: view2.y, zoom: view2.zoom }, x, y, size, size);
        ctx.restore();
      }

      ctx.strokeStyle = INK[this.background].frame;
      ctx.lineWidth = 2 * k;
      this.roundRect(x, y, size, size, 14 * k);
      ctx.stroke();

      const cx = x + size / 2;
      const cy = y + size / 2;

      // 拡大鏡の中にも、拾おうとしている図形を同じように目立たせる
      if (s.highlight && view2) {
        ctx.save();
        this.roundRect(x, y, size, size, 14 * k);
        ctx.clip();
        this.drawHighlight(s.highlight, (wx, wy) => [
          cx + ((wx - view2.x) * view2.zoom * k) / view2.dpr,
          cy - ((wy - view2.y) * view2.zoom * k) / view2.dpr,
        ], k);
        ctx.restore();
      }

      // 中心は指が触れている場所。吸着先の印より控えめに、けれど見える程度に
      ctx.strokeStyle = INK[this.background].halo;
      ctx.lineWidth = 3.2 * k;
      const center = () => {
        ctx.beginPath();
        ctx.moveTo(cx - 10 * k, cy);
        ctx.lineTo(cx + 10 * k, cy);
        ctx.moveTo(cx, cy - 10 * k);
        ctx.lineTo(cx, cy + 10 * k);
        ctx.stroke();
      };
      center();
      ctx.strokeStyle = INK[this.background].mark;
      ctx.lineWidth = 1.2 * k;
      center();

      // 吸着先は拡大鏡の中の該当する場所に描く。
      // 中心を吸着先に合わせてしまうと、吸着先が変わるたび景色ごと飛んで見づらい。
      const mv = s.magnifierView;
      if (mv && s.preview) {
        const sx = cx + ((s.preview.x - mv.x) * mv.zoom * k) / mv.dpr;
        const sy = cy - ((s.preview.y - mv.y) * mv.zoom * k) / mv.dpr;
        const inside =
          sx > x + 6 * k && sx < x + size - 6 * k && sy > y + 6 * k && sy < y + size - 6 * k;
        if (inside) {
          const cross = (): void => {
            ctx.beginPath();
            ctx.moveTo(sx - 13 * k, sy);
            ctx.lineTo(sx + 13 * k, sy);
            ctx.moveTo(sx, sy - 13 * k);
            ctx.lineTo(sx, sy + 13 * k);
            ctx.stroke();
          };
          // 縁取りは印と反対の明るさにする（白黒の黒でも埋もれないように）
          ctx.strokeStyle = ink.label;
          ctx.lineWidth = 4.5 * k;
          cross();
          ctx.strokeStyle = ink.stroke;
          ctx.lineWidth = 1.6 * k;
          cross();
          ctx.beginPath();
          ctx.arc(sx, sy, 5.5 * k, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
  }

  /** 図形を目立たせる。線は背景色の縁を付けた太線、塗りは薄く、文字は枠で囲む */
  private drawHighlight(h: Highlight, map: (x: number, y: number) => [number, number], k: number): void {
    const ctx = this.ctx;
    const halo = INK[this.background].halo;

    if (h.tris.length) {
      ctx.fillStyle = 'rgba(53, 208, 127, 0.3)';
      ctx.beginPath();
      for (let i = 0; i + 5 < h.tris.length; i += 6) {
        const [ax, ay] = map(h.tris[i], h.tris[i + 1]);
        const [bx, by] = map(h.tris[i + 2], h.tris[i + 3]);
        const [cx, cy] = map(h.tris[i + 4], h.tris[i + 5]);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.lineTo(cx, cy);
        ctx.closePath();
      }
      ctx.fill();
    }

    if (h.lines.length) {
      ctx.beginPath();
      for (let i = 0; i + 3 < h.lines.length; i += 4) {
        const [ax, ay] = map(h.lines[i], h.lines[i + 1]);
        const [bx, by] = map(h.lines[i + 2], h.lines[i + 3]);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      ctx.strokeStyle = halo;
      ctx.lineWidth = 6.5 * k;
      ctx.stroke();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 3 * k;
      ctx.stroke();
    }

    if (h.box) {
      const b = h.box;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const [px, py] = map(b[i * 2], b[i * 2 + 1]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(53, 208, 127, 0.16)';
      ctx.fill();
      ctx.strokeStyle = halo;
      ctx.lineWidth = 5 * k;
      ctx.stroke();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2 * k;
      ctx.stroke();
    }

    if (h.point) {
      const [px, py] = map(h.point[0], h.point[1]);
      ctx.beginPath();
      ctx.arc(px, py, 9 * k, 0, Math.PI * 2);
      ctx.strokeStyle = halo;
      ctx.lineWidth = 5 * k;
      ctx.stroke();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2.5 * k;
      ctx.stroke();
    }
  }

  private marker(x: number, y: number, k: number, strong: boolean, ink: MeasureInk): void {
    const ctx = this.ctx;
    const r = (strong ? 8 : 6) * k;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = ink.dot;
    ctx.fill();
    ctx.strokeStyle = ink.stroke;
    ctx.lineWidth = (strong ? 2.4 : 1.8) * k;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - r * 0.55, y);
    ctx.lineTo(x + r * 0.55, y);
    ctx.moveTo(x, y - r * 0.55);
    ctx.lineTo(x, y + r * 0.55);
    ctx.stroke();
  }

  /**
   * 数字などのラベル。ink が null なら控えめな色（吸着先の種類）。
   * big は面積・体積の値で、辺の長さより大きく太く、縁も付けて目立たせる
   */
  private pill(x: number, y: number, text: string, k: number, ink: MeasureInk | null, big = false): void {
    const ctx = this.ctx;
    ctx.font = big
      ? `600 ${14 * k}px -apple-system, "Hiragino Sans", system-ui, sans-serif`
      : `${12 * k}px -apple-system, "Hiragino Sans", system-ui, sans-serif`;
    const w = ctx.measureText(text).width + (big ? 18 : 12) * k;
    const h = (big ? 26 : 20) * k;
    ctx.fillStyle = ink ? ink.label : 'rgba(0,0,0,0.7)';
    this.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
    ctx.fill();
    if (big && ink) {
      ctx.strokeStyle = ink.stroke;
      ctx.lineWidth = 1.5 * k;
      ctx.stroke();
    }
    ctx.fillStyle = ink ? ink.text : '#c9cfda';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5 * k);
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
