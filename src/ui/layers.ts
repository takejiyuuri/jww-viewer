import type { LayerGroupInfo } from '../jww/worker.ts';
import { hex1 } from '../jww/names.ts';

export interface LayerSnapshot {
  group: boolean[];
  layer: boolean[];
  /** 反転でグループごと表示にしたとき覚えておいた、中のレイヤの設定（グループ番号と 16 個の表示） */
  stash?: Array<[number, boolean[]]>;
}

/** 保存用の形。隠しているものだけを並べる */
export interface HiddenLayers {
  groups: number[];
  layers: number[];
  /** 反転で覚えておいた中の設定（グループ番号と、その中で隠していたレイヤ 0〜15） */
  stash: Array<[number, number[]]>;
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
   * レイヤ（0〜255）ごとの図形の数。与えられていれば、反転や見え方の比較で図形のないレイヤを無視する
   * （一覧に出ないレイヤの設定で、グループが「一部だけ表示」と誤って扱われないように）。
   */
  private counts: Uint32Array | null = null;
  /**
   * 反転で隠れていたグループを表示にするとき、中のレイヤの設定は全部表示で上書きするしかない。
   * その前の設定をここに覚えておき、もう一度反転してそのグループを隠すときに戻す。
   * グループやレイヤを直接切り替えたら（forget）、覚えておいた設定は使えなくなるので捨てる。
   */
  readonly stash = new Map<number, boolean[]>();

  /** 図形の数を覚えさせる。snapshot() / restore() では持ち回らない */
  useCounts(counts: Uint32Array | null): this {
    this.counts = counts;
    return this;
  }

  /** 図形のあるレイヤか（図形の数を知らなければ、すべてのレイヤを数える） */
  private used(k: number): boolean {
    return !this.counts || this.counts[k] > 0;
  }

  /**
   * Jw_cad で保存したときの状態にする。
   * 書込レイヤ（保存時に作図していたレイヤ）は Jw_cad でも必ず見えているので、表示にする。
   */
  resetToJw(groups: readonly LayerGroupInfo[], writeGroup: number): void {
    this.stash.clear();
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
    this.stash.clear();
    this.group.fill(true);
    this.layer.fill(true);
  }

  /** グループやレイヤを直接切り替えたとき。反転で覚えておいた中の設定を捨てる */
  forget(): void {
    this.stash.clear();
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
    this.stash.clear();
    const g = k >> 4;
    this.group.fill(false);
    this.group[g] = true;
    for (let l = 0; l < 16; l++) this.layer[(g << 4) | l] = ((g << 4) | l) === k;
  }

  /**
   * 表示と非表示を入れ替える（Jw_cad の「レイヤ反転表示」にあたる）。
   * 図形のあるレイヤの見え方がちょうど入れ替わるように、グループごとに次のようにする。
   * - グループごと隠れていた → グループを表示にして、中のレイヤを全部表示
   * - 図形のあるレイヤが全部見えていた → グループごと隠す（中の設定は残すので、グループのスイッチで戻せる）
   * - 一部だけ見えていた → 中のレイヤを 1 枚ずつ入れ替える
   */
  invert(): void {
    for (let g = 0; g < 16; g++) {
      const base = g << 4;
      if (!this.group[g]) {
        // 中の設定は全部表示で上書きするので、その前の設定を覚えておく
        this.stash.set(g, this.layer.slice(base, base + 16));
        this.group[g] = true;
        for (let l = 0; l < 16; l++) this.layer[base | l] = true;
        continue;
      }
      let all = true;
      for (let l = 0; l < 16; l++) if (this.used(base | l) && !this.layer[base | l]) { all = false; break; }
      if (all) {
        this.group[g] = false;
        // 反転で表示にしたグループをまた隠すなら、表示にする前の中の設定に戻す
        const saved = this.stash.get(g);
        if (saved) for (let l = 0; l < 16; l++) this.layer[base | l] = saved[l];
      } else {
        for (let l = 0; l < 16; l++) this.layer[base | l] = !this.layer[base | l];
      }
      this.stash.delete(g);
    }
  }

  /**
   * 図形のあるグループのスイッチと、図形のあるレイヤの設定が同じか（見え方ではなく、設定そのもの）。
   * 保存するかどうかの判断に使う。グループごと隠れていて見え方が同じでも、中の設定が違えば違うとみなす
   */
  sameSettings(other: LayerVisibility): boolean {
    for (let g = 0; g < 16; g++) {
      let used = false;
      for (let l = 0; l < 16; l++) if (this.used((g << 4) | l)) { used = true; break; }
      if (used && this.group[g] !== other.group[g]) return false;
    }
    for (let k = 0; k < 256; k++) if (this.used(k) && this.layer[k] !== other.layer[k]) return false;
    return true;
  }

  /** 図形のあるレイヤの見え方が同じか（グループとレイヤの持ち方の違いは問わない） */
  sameAs(other: LayerVisibility): boolean {
    for (let k = 0; k < 256; k++) if (this.used(k) && this.visible(k) !== other.visible(k)) return false;
    return true;
  }

  snapshot(): LayerSnapshot {
    return {
      group: [...this.group],
      layer: [...this.layer],
      stash: [...this.stash].map(([g, f]) => [g, [...f]] as [number, boolean[]]),
    };
  }

  restore(s: LayerSnapshot): void {
    for (let g = 0; g < 16; g++) this.group[g] = s.group[g] ?? true;
    for (let k = 0; k < 256; k++) this.layer[k] = s.layer[k] ?? true;
    this.stash.clear();
    for (const [g, f] of s.stash ?? []) this.stash.set(g, [...f]);
  }

  /** 保存用。隠しているものだけを並べる */
  hidden(): HiddenLayers {
    const groups: number[] = [];
    const layers: number[] = [];
    for (let g = 0; g < 16; g++) if (!this.group[g]) groups.push(g);
    for (let k = 0; k < 256; k++) if (!this.layer[k]) layers.push(k);
    const stash: Array<[number, number[]]> = [];
    for (const [g, f] of this.stash) {
      const off: number[] = [];
      for (let l = 0; l < 16; l++) if (!f[l]) off.push(l);
      stash.push([g, off]);
    }
    return { groups, layers, stash };
  }

  /** 保存しておいた「隠しているもの」を戻す */
  applyHidden(h: { groups: readonly number[]; layers: readonly number[]; stash?: ReadonlyArray<readonly [number, readonly number[]]> | null }): void {
    this.showAll();
    for (const g of h.groups) if (g >= 0 && g < 16) this.group[g] = false;
    for (const k of h.layers) if (k >= 0 && k < 256) this.layer[k] = false;
    for (const [g, off] of h.stash ?? []) {
      if (!(g >= 0 && g < 16)) continue;
      const f = new Array<boolean>(16).fill(true);
      for (const l of off) if (l >= 0 && l < 16) f[l] = false;
      this.stash.set(g, f);
    }
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
