import type { SceneText } from './geometry.ts';
import type { View } from './renderer.ts';

const FONT_STACK = '"Hiragino Sans", "Noto Sans JP", -apple-system, system-ui, sans-serif';

/**
 * Jw_cad の特殊文字。「^」に続く 1 文字で、その後の文字の描き方が変わる。
 * u は上付き、d は下付き、c は中付き（どれも半分の大きさ）、o は丸付き、w は続く 2 文字の重ね文字
 */
type RunKind = 'normal' | 'sup' | 'sub' | 'mid' | 'circle' | 'overlay';
const SPECIAL: Record<string, RunKind> = { u: 'sup', d: 'sub', c: 'mid', o: 'circle', w: 'overlay' };

/** 特殊文字で区切った文字列のひと続き */
interface Run {
  text: string;
  kind: RunKind;
}

/** 特殊文字を解釈して区切る。後ろに文字が続かない「^」や、知らない記号の「^」はそのまま残す */
export function specialRuns(s: string): Run[] {
  const ch = Array.from(s);
  const runs: Run[] = [];
  let plain = '';
  for (let i = 0; i < ch.length; i++) {
    const kind = ch[i] === '^' ? SPECIAL[ch[i + 1]] : undefined;
    const take = kind === 'overlay' ? 2 : 1;
    if (!kind || i + 1 + take >= ch.length) {
      plain += ch[i];
      continue;
    }
    if (plain) runs.push({ text: plain, kind: 'normal' });
    plain = '';
    runs.push({ text: ch.slice(i + 2, i + 2 + take).join(''), kind });
    i += 1 + take;
  }
  if (plain) runs.push({ text: plain, kind: 'normal' });
  return runs;
}

/** 特殊文字の記号を取り除いた文字列（属性の表示などに使う） */
export function plainText(s: string): string {
  return s.includes('^') ? specialRuns(s).map((r) => r.text).join('') : s;
}

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
  /** レイヤ（0〜255）ごとに表示するかどうか */
  private layerVisible: Uint8Array = new Uint8Array(256).fill(1);

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

  /** レイヤ（0〜255）ごとの表示を差し替える */
  setLayerVisibility(visible: Uint8Array): void {
    this.layerVisible = visible;
    this.drawnAt = null;
  }

  render(view: View): void {
    const ctx = this.ctx;
    const { w, h } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this.paint(ctx, view, 0, 0, w, h);
    this.drawnAt = { ...view };
    this.canvas.style.transform = '';
  }

  /**
   * 別のキャンバスの一部（拡大鏡の中など）に、view で見た文字を描く。
   * x, y, w, h はそのキャンバスのデバイスピクセルで、切り抜きは呼び出し側で済ませておく。
   */
  renderInset(ctx: CanvasRenderingContext2D, view: View, x: number, y: number, w: number, h: number): void {
    ctx.save();
    this.paint(ctx, view, x, y, w, h);
    ctx.restore();
  }

  /** (ox, oy) を左上とする w × h の範囲の中央に view の中心が来るように描く */
  private paint(ctx: CanvasRenderingContext2D, view: View, ox: number, oy: number, w: number, h: number): void {
    const z = view.zoom;
    const cx = ox + w / 2;
    const cy = oy + h / 2;
    let font = '';
    let style = '';
    // 揃え方は毎回ここで決める。拡大鏡では計測の札と同じキャンバスに描くので、ほかの設定が残っていることがある。
    // Jw_cad の文字は始点が文字枠の左下なので、字の枠（em ボックス）の下端を始点に合わせる
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';

    for (const t of this.texts) {
      if (!this.visible[t.color] || !this.layerVisible[t.layer]) continue;
      const hpx = t.height * z;
      if (hpx < this.minHeight) continue;

      const sx = (t.x - view.cx) * z + cx;
      const sy = cy - (t.y - view.cy) * z;
      const wpx = t.width * z;
      // 回転を考慮して余裕をもたせた範囲外判定
      const margin = Math.max(wpx, hpx) + 8;
      if (sx < ox - margin || sy < oy - margin || sx > ox + w + margin || sy > oy + h + margin) continue;

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
      if (t.text.includes('^')) {
        drawRuns(ctx, specialRuns(t.text), px, wpx, next2);
        // 字の大きさを変えたので、次の文字で設定し直させる
        font = '';
        ctx.restore();
        continue;
      }
      if (wpx > 0) {
        const m = ctx.measureText(t.text).width;
        // JWW は文字幅と間隔を独立して持つので、実描画幅を始終点に合わせる
        if (m > 0.5) ctx.scale(wpx / m, 1);
      }
      ctx.fillText(t.text, 0, 0);
      ctx.restore();
    }
  }
}

/**
 * 特殊文字を含む文字列を、始点（左下）から描く。px は字の高さ、wpx は始点から終点までの長さ（画面）。
 * Jw_cad が保存している幅は、上付き・下付きの字を半分の大きさで数えた長さなので、区切りごとに同じ大きさで測って合わせる
 */
function drawRuns(ctx: CanvasRenderingContext2D, runs: Run[], px: number, wpx: number, color: string): void {
  const full = `${px}px ${FONT_STACK}`;
  const half = `${Math.round(px * 5) / 10}px ${FONT_STACK}`;
  const small = `${Math.round(px * 6.5) / 10}px ${FONT_STACK}`;
  const fontOf = (k: RunKind): string => (k === 'sup' || k === 'sub' || k === 'mid' ? half : k === 'circle' ? small : full);
  const widths = runs.map((r) => {
    ctx.font = fontOf(r.kind);
    if (r.kind === 'circle') return Math.max(ctx.measureText(r.text).width, px);
    // 重ね文字は 2 文字を同じ所に描くので、広いほうの幅
    if (r.kind === 'overlay') return Math.max(...Array.from(r.text).map((c) => ctx.measureText(c).width));
    return ctx.measureText(r.text).width;
  });
  const m = widths.reduce((a, b) => a + b, 0);
  if (wpx > 0 && m > 0.5) ctx.scale(wpx / m, 1);

  let x = 0;
  runs.forEach((r, i) => {
    const w = widths[i];
    ctx.font = fontOf(r.kind);
    switch (r.kind) {
      case 'sup': ctx.fillText(r.text, x, -px * 0.5); break;
      case 'mid': ctx.fillText(r.text, x, -px * 0.25); break;
      case 'circle': {
        ctx.fillText(r.text, x + (w - ctx.measureText(r.text).width) / 2, -px * 0.17);
        ctx.beginPath();
        ctx.arc(x + w / 2, -px / 2, px * 0.46, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, px * 0.06);
        ctx.stroke();
        break;
      }
      case 'overlay':
        for (const c of Array.from(r.text)) ctx.fillText(c, x + (w - ctx.measureText(c).width) / 2, 0);
        break;
      // 下付きとふつうの字は、字の枠の下端を始点の高さにそろえる
      default: ctx.fillText(r.text, x, 0); break;
    }
    x += w;
  });
}
