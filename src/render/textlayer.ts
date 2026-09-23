import type { SceneText } from './geometry.ts';
import type { View } from './renderer.ts';

const FONT_STACK = '"Hiragino Sans", "Noto Sans JP", -apple-system, system-ui, sans-serif';

/**
 * 文字専用の 2D レイヤ。
 * 毎フレーム描き直すと重いので、描画時のビューを覚えておき、
 * 操作中は CSS transform で追従させ、操作が止まってから描き直す。
 */
export class TextLayer {
  private ctx: CanvasRenderingContext2D;
  private texts: SceneText[] = [];
  private drawnAt: View | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  /** 色番号ごとの塗り色（CSS の色文字列） */
  private styles: string[] = [];
  /** 色番号ごとに表示するかどうか */
  private visible: Uint8Array = new Uint8Array(0);

  /** 画面上でこの高さ未満の文字は描かない（デバイスピクセル） */
  minHeight = 6;

  readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('2D コンテキストを取得できません');
    this.ctx = ctx;
  }

  setTexts(texts: SceneText[]): void {
    this.texts = texts;
    this.drawnAt = null;
  }

  /** 描画用のパレット（RGBA、A が 0 の色は隠す）を差し替える */
  setPalette(rgba: Uint8Array): void {
    const n = Math.floor(rgba.length / 4);
    this.styles = new Array<string>(n);
    this.visible = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      this.styles[i] = `rgb(${rgba[i * 4]},${rgba[i * 4 + 1]},${rgba[i * 4 + 2]})`;
      this.visible[i] = rgba[i * 4 + 3] > 127 ? 1 : 0;
    }
    // 色が変わったので、ずれていなくても描き直させる
    this.drawnAt = null;
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    this.dpr = dpr;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.drawnAt = null;
    }
    this.w = w;
    this.h = h;
  }

  /** 直前の描画からビューがどれだけずれたかを CSS transform で埋める */
  syncTransform(view: View): void {
    const at = this.drawnAt;
    if (!at) {
      this.canvas.style.transform = '';
      return;
    }
    const s = view.zoom / at.zoom;
    const dx = ((at.cx - view.cx) * view.zoom) / this.dpr;
    const dy = ((view.cy - at.cy) * view.zoom) / this.dpr;
    this.canvas.style.transform =
      Math.abs(s - 1) < 1e-6 && Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01
        ? ''
        : `translate(${dx}px, ${dy}px) scale(${s})`;
  }

  /** ずれが小さいうちは描き直さずに済ませる */
  needsRedraw(view: View): boolean {
    const at = this.drawnAt;
    if (!at) return true;
    if (Math.abs(view.zoom / at.zoom - 1) > 0.001) return true;
    const dx = (at.cx - view.cx) * view.zoom;
    const dy = (at.cy - view.cy) * view.zoom;
    return Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5;
  }

  render(view: View): void {
    const ctx = this.ctx;
    const { w, h } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const z = view.zoom;
    const halfW = w / 2;
    const halfH = h / 2;
    let font = '';
    let style = '';

    for (const t of this.texts) {
      if (!this.visible[t.color]) continue;
      const hpx = t.height * z;
      if (hpx < this.minHeight) continue;

      const sx = (t.x - view.cx) * z + halfW;
      const sy = halfH - (t.y - view.cy) * z;
      const wpx = t.width * z;
      // 回転を考慮して余裕をもたせた画面外判定
      const margin = Math.max(wpx, hpx) + 8;
      if (sx < -margin || sy < -margin || sx > w + margin || sy > h + margin) continue;

      const px = Math.round(hpx * 10) / 10;
      const next = `${px}px ${FONT_STACK}`;
      if (next !== font) {
        ctx.font = next;
        font = next;
      }
      const next2 = this.styles[t.color];
      if (next2 !== style) {
        ctx.fillStyle = next2;
        style = next2;
      }

      ctx.save();
      ctx.translate(sx, sy);
      if (Math.abs(t.angle) > 0.01) ctx.rotate((-t.angle * Math.PI) / 180);
      if (wpx > 0) {
        const m = ctx.measureText(t.text).width;
        // JWW は文字幅と間隔を独立して持つので、実描画幅を始終点に合わせる
        if (m > 0.5) ctx.scale(wpx / m, 1);
      }
      ctx.fillText(t.text, 0, 0);
      ctx.restore();
    }

    this.drawnAt = { ...view };
    this.canvas.style.transform = '';
  }
}
