import type { View } from './renderer.ts';
import type { MeasurePoint } from '../measure/measure.ts';
import type { Axis, SnapResult } from '../measure/snap.ts';
import { SNAP_LABEL, formatLength } from '../measure/measure.ts';

export interface MagnifierBox {
  /** CSS ピクセル、左上原点 */
  x: number;
  y: number;
  size: number;
}

export interface OverlayState {
  points: MeasurePoint[];
  /** 水平・垂直に拘束しているときの基準点と向き */
  constraint: { x: number; y: number; axis: Axis } | null;
  /** つまんで動かしている点の番号 */
  activeIndex: number | null;
  /** 長押し中のスナップ候補 */
  preview: SnapResult | null;
  /** 長押し中の指の位置（CSS ピクセル） */
  cursor: { x: number; y: number } | null;
  magnifier: MagnifierBox | null;
  /** 計測に使う縮尺分母 */
  scale: number;
}

const ACCENT = '#35d07f';
const ACCENT_SOFT = 'rgba(53, 208, 127, 0.85)';

export class Overlay {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;

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

    // 直交拘束の基準線。この線の上だけを動くことを示す
    if (s.constraint) {
      const [cx, cy] = this.toScreen(view, s.constraint.x, s.constraint.y);
      ctx.strokeStyle = 'rgba(53, 208, 127, 0.38)';
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

    // 測線
    if (pts.length >= 2) {
      ctx.strokeStyle = ACCENT_SOFT;
      ctx.lineWidth = 2 * k;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    }

    // 区間の長さ
    if (pts.length >= 2) {
      for (let i = 1; i < pts.length; i++) {
        const a = s.points[i - 1];
        const b = s.points[i];
        const len = Math.hypot(b.x - a.x, b.y - a.y) * s.scale;
        const mx = (pts[i - 1][0] + pts[i][0]) / 2;
        const my = (pts[i - 1][1] + pts[i][1]) / 2;
        this.pill(mx, my, formatLength(len), k);
      }
    }

    // 確定した点。動かしている点は大きく描く
    for (let i = 0; i < pts.length; i++) {
      const strong = i === s.activeIndex || (s.activeIndex === null && i === pts.length - 1);
      this.marker(pts[i][0], pts[i][1], k, strong);
    }

    // 長押し中のプレビュー
    if (s.preview) {
      const [px, py] = this.toScreen(view, s.preview.x, s.preview.y);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1 * k;
      ctx.setLineDash([5 * k, 5 * k]);
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(this.w, py);
      ctx.moveTo(px, 0);
      ctx.lineTo(px, this.h);
      ctx.stroke();
      ctx.setLineDash([]);

      this.marker(px, py, k, true);
      if (s.preview.kind !== 'free') {
        this.pill(px, py - 26 * k, SNAP_LABEL[s.preview.kind], k, true);
      }
    }

    // ルーペ
    if (s.magnifier) {
      const m = s.magnifier;
      const x = m.x * k;
      const y = m.y * k;
      const size = m.size * k;
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2 * k;
      this.roundRect(x, y, size, size, 14 * k);
      ctx.stroke();

      // 中央の十字（スナップ位置）。図面の線に紛れないよう縁取りを付ける
      const cx = x + size / 2;
      const cy = y + size / 2;
      const cross = (): void => {
        ctx.beginPath();
        ctx.moveTo(cx - 14 * k, cy);
        ctx.lineTo(cx + 14 * k, cy);
        ctx.moveTo(cx, cy - 14 * k);
        ctx.lineTo(cx, cy + 14 * k);
        ctx.stroke();
      };
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 4.5 * k;
      cross();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5 * k;
      cross();
      ctx.beginPath();
      ctx.arc(cx, cy, 5 * k, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private marker(x: number, y: number, k: number, strong: boolean): void {
    const ctx = this.ctx;
    const r = (strong ? 8 : 6) * k;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(11,12,16,0.65)';
    ctx.fill();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = (strong ? 2.4 : 1.8) * k;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - r * 0.55, y);
    ctx.lineTo(x + r * 0.55, y);
    ctx.moveTo(x, y - r * 0.55);
    ctx.lineTo(x, y + r * 0.55);
    ctx.stroke();
  }

  private pill(x: number, y: number, text: string, k: number, muted = false): void {
    const ctx = this.ctx;
    ctx.font = `${12 * k}px -apple-system, "Hiragino Sans", system-ui, sans-serif`;
    const w = ctx.measureText(text).width + 12 * k;
    const h = 20 * k;
    ctx.fillStyle = muted ? 'rgba(0,0,0,0.7)' : 'rgba(11,12,16,0.88)';
    this.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = muted ? '#c9cfda' : ACCENT;
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
