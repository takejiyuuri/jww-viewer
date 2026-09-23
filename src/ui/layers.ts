import type { LayerGroupInfo } from '../jww/worker.ts';
import { hex1 } from '../jww/names.ts';

export interface LayerSnapshot {
  group: boolean[];
  layer: boolean[];
}

/**
 * レイヤグループ（16 個）とレイヤ（16 × 16 個）の表示状態。
 * Jw_cad と同じく、グループを隠すと中のレイヤの設定に関係なく隠れる。
 * レイヤはどこでも「上位 4 ビットがグループ、下位 4 ビットがレイヤ」の 0〜255 で扱う。
 */
export class LayerVisibility {
  readonly group = new Array<boolean>(16).fill(true);
  readonly layer = new Array<boolean>(256).fill(true);

  /**
   * Jw_cad で保存したときの状態にする。
   * 書込レイヤ（保存時に作図していたレイヤ）は Jw_cad でも必ず見えているので、表示にする。
   */
  resetToJw(groups: readonly LayerGroupInfo[], writeGroup: number): void {
    for (let g = 0; g < 16; g++) {
      const info = groups[g];
      this.group[g] = !info || info.state !== 0 || g === writeGroup;
      for (let l = 0; l < 16; l++) {
        const state = info?.layers[l]?.state ?? 2;
        const isWrite = g === writeGroup && l === info?.writeLayer;
        this.layer[(g << 4) | l] = state !== 0 || isWrite;
      }
    }
  }

  showAll(): void {
    this.group.fill(true);
    this.layer.fill(true);
  }

  /** 実際に描かれるか */
  visible(k: number): boolean {
    return this.group[k >> 4] && this.layer[k];
  }

  /** レイヤ（0〜255）ごとに 1 なら表示 */
  mask(): Uint8Array {
    const m = new Uint8Array(256);
    for (let k = 0; k < 256; k++) m[k] = this.visible(k) ? 1 : 0;
    return m;
  }

  /**
   * このレイヤだけを見せる。
   * ほかのグループはグループごと隠すだけにして、中のレイヤの設定は残す
   * （あとで一覧からグループを戻したとき、そのグループが元どおりに見えるように）。
   */
  only(k: number): void {
    const g = k >> 4;
    this.group.fill(false);
    this.group[g] = true;
    for (let l = 0; l < 16; l++) this.layer[(g << 4) | l] = ((g << 4) | l) === k;
  }

  snapshot(): LayerSnapshot {
    return { group: [...this.group], layer: [...this.layer] };
  }

  restore(s: LayerSnapshot): void {
    for (let g = 0; g < 16; g++) this.group[g] = s.group[g] ?? true;
    for (let k = 0; k < 256; k++) this.layer[k] = s.layer[k] ?? true;
  }

  /** 保存用。隠しているものだけを並べる */
  hidden(): { groups: number[]; layers: number[] } {
    const groups: number[] = [];
    const layers: number[] = [];
    for (let g = 0; g < 16; g++) if (!this.group[g]) groups.push(g);
    for (let k = 0; k < 256; k++) if (!this.layer[k]) layers.push(k);
    return { groups, layers };
  }

  /** 保存しておいた「隠しているもの」を戻す */
  applyHidden(h: { groups: readonly number[]; layers: readonly number[] }): void {
    this.showAll();
    for (const g of h.groups) if (g >= 0 && g < 16) this.group[g] = false;
    for (const k of h.layers) if (k >= 0 && k < 256) this.layer[k] = false;
  }

  /** 図形のあるレイヤのうち、いま隠れているものの数 */
  hiddenCount(counts: Uint32Array): number {
    let n = 0;
    for (let k = 0; k < 256; k++) if (counts[k] > 0 && !this.visible(k)) n++;
    return n;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function formatScale(scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0) return '1';
  return Number.isInteger(scale) ? String(scale) : scale.toFixed(3).replace(/0+$/, '');
}

/**
 * レイヤ一覧を組み立てる。図形の入っていないグループやレイヤは出さない。
 * グループの行は左側で開閉、右端のスイッチでグループごと表示・非表示。
 */
export function renderLayerList(
  container: HTMLElement,
  groups: readonly LayerGroupInfo[],
  counts: Uint32Array,
  vis: LayerVisibility,
  expanded: ReadonlySet<number>,
  highlight: number | null,
): void {
  const html: string[] = [];
  for (let g = 0; g < 16; g++) {
    let total = 0;
    for (let l = 0; l < 16; l++) total += counts[(g << 4) | l];
    if (total === 0) continue;

    const info = groups[g];
    const open = expanded.has(g);
    const gOn = vis.group[g];
    const name = info?.name?.trim() || `グループ ${hex1(g)}`;
    html.push(
      `<div class="lg${gOn ? '' : ' off'}" data-g="${g}">`,
      `<div class="lg-row">`,
      `<button class="lg-head" data-toggle="${g}" aria-expanded="${open}">`,
      `<span class="chev" aria-hidden="true"></span>`,
      `<span class="lno">${hex1(g)}</span>`,
      `<span class="lname">${escapeHtml(name)}</span>`,
      `<span class="lscale">1/${formatScale(info?.scale ?? 1)}</span>`,
      `<span class="count">${total.toLocaleString()}</span>`,
      `</button>`,
      `<button class="sw" data-group="${g}" aria-pressed="${gOn}" aria-label="${escapeHtml(name)} を表示">`,
      `<span class="switch"></span></button>`,
      `</div>`,
      `<div class="lg-layers"${open ? '' : ' hidden'}>`,
    );
    for (let l = 0; l < 16; l++) {
      const k = (g << 4) | l;
      const n = counts[k];
      if (n === 0) continue;
      const lInfo = info?.layers[l];
      const lOn = vis.layer[k];
      const lname = lInfo?.name?.trim() || `レイヤ ${hex1(l)}`;
      // Jw_cad で保存したときに非表示にしていたレイヤには印を付ける
      const jwHidden = lInfo?.state === 0 ? '<span class="lflag">Jw で非表示</span>' : '';
      const mark = highlight === k ? ' mark' : '';
      html.push(
        `<div class="l-row${lOn ? '' : ' off'}${mark}" data-k="${k}">`,
        `<span class="lno">${hex1(l)}</span>`,
        `<span class="lname">${escapeHtml(lname)}</span>`,
        jwHidden,
        `<span class="count">${n.toLocaleString()}</span>`,
        `<button class="sw" data-layer="${k}" aria-pressed="${lOn}" aria-label="${escapeHtml(lname)} を表示">`,
        `<span class="switch"></span></button>`,
        `</div>`,
      );
    }
    html.push('</div></div>');
  }
  container.innerHTML = html.join('') || '<p class="sub">図形の入ったレイヤがありません。</p>';
}
