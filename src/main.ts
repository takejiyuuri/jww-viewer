import { Renderer, type View } from './render/renderer.ts';
import { TextLayer } from './render/textlayer.ts';
import { Overlay, type Highlight, type MagnifierBox, type OverlayState } from './render/overlay.ts';
import type { Scene } from './render/geometry.ts';
import type { LoadResponse, LoadedInfo } from './jww/worker.ts';
import { SnapIndex, type Axis, type SnapResult } from './measure/snap.ts';
import {
  SNAP_LABEL, formatLength, measureLengths,
  type MeasurePoint,
} from './measure/measure.ts';
import {
  loadDisplay, loadLast, loadViewState, saveDisplay, saveLast, saveViewState,
} from './storage.ts';
import {
  BACKGROUND_RGB, buildPalette, displayColor, type DisplaySettings,
} from './render/theme.ts';
import { LayerVisibility, renderLayerList, type LayerSnapshot } from './ui/layers.ts';
import { describeEntity, entityShape, pickEntity } from './ui/inspect.ts';
import { KIND, fitScene, type Bounds } from './render/geometry.ts';
import { hex1, layerTag } from './jww/names.ts';
import { versionWarning } from './jww/header.ts';

/** 吸着先を探す半径（CSS ピクセル） */
const SNAP_RADIUS = 22;

/**
 * ルーペの拡大率。
 * 吸着先は指から最大 SNAP_RADIUS 離れるので、それを拡大しても
 * ルーペの中に収まる倍率にしておく（一辺 170px なら 85 ÷ 22 ≒ 3.8）。
 */
const MAGNIFY = 3.5;

const PAPER_NAMES = ['A0', 'A1', 'A2', 'A3', 'A4', '', '', '', '2A', '3A', '4A', '5A', '10m', '50m', '100m'];

type Tool = 'measure' | 'inspect';

/** 図面の見えている範囲を狭めているものの幅（CSS ピクセル） */
interface Insets {
  top: number;
  bottom: number;
  /** 横向きで右に寄せたパネル */
  right: number;
}
type Sheet = 'info-panel' | 'display-panel' | 'layer-panel';
const SHEETS: Sheet[] = ['info-panel', 'display-panel', 'layer-panel'];

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`要素が見つかりません: ${id}`);
  return node as T;
};

class App {
  private renderer: Renderer;
  private textLayer: TextLayer;
  private overlay: Overlay;
  private worker: Worker | null = null;

  private scene: Scene | null = null;
  private info: LoadedInfo | null = null;
  private snapIndex: SnapIndex | null = null;

  private view: View = { cx: 0, cy: 0, zoom: 1 };
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;

  private points: MeasurePoint[] = [];
  /** 水平・垂直に拘束して測る */
  private ortho = true;
  /** つまんで動かしている計測点。null なら新しい点を置く */
  private dragIndex: number | null = null;
  /** 拘束の基準点と向き。表示用に覚えておく */
  private constraint: { x: number; y: number; axis: Axis } | null = null;
  private measureScale = 1;
  private manualScale = false;

  /** 背景の白黒と単色表示。端末ごとの好みとして次回も使う */
  private display: DisplaySettings = loadDisplay();
  /** 隠している色グループ（scene.groups の添字） */
  private hiddenGroups = new Set<number>();
  /** レイヤグループ・レイヤの表示状態 */
  private layers = new LayerVisibility();
  /** 属性から「このレイヤだけ表示」「隠す」をする前の状態。「元に戻す」で戻す */
  private layerSnapshot: LayerSnapshot | null = null;
  /** 反転を続けて押す前の状態。反転で同じ見え方に戻ったら、グループの持ち方まで元どおりにするのに使う */
  private invertOrigin: LayerSnapshot | null = null;
  /** レイヤ一覧で開いているグループ */
  private expandedGroups = new Set<number>();
  /** いま見えている色番号とレイヤ（1 なら表示）。図形を拾うときに見えないものを除く */
  private colorVisible: Uint8Array = new Uint8Array(0);
  private layerMask: Uint8Array = new Uint8Array(256).fill(1);

  /** タップで計測点を置くか、図形の属性を見るか */
  private tool: Tool = 'measure';
  /** 属性を表示している図形（scene.entities の添字）。-1 なら無し */
  private selected = -1;
  /** 属性で長押ししている間、指の下にある図形 */
  private previewEntity = -1;
  private shapeCache: { index: number; shape: Highlight } | null = null;
  /** 見えている図形での「全体」の範囲。色・レイヤの見え方が同じなら求め直さない */
  private fitCache: { key: string; bounds: Bounds } | null = null;
  /** 長押しを始めたときの、上下のバー・パネルの幅。拡大鏡をそこに重ねないために使う */
  private insets: Insets = { top: 52, bottom: 104, right: 0 };
  /** 読み込み時に決めた既定の縮尺。「自動」に戻したときに使う */
  private defaultScale = 1;

  // ジェスチャ
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; midX: number; midY: number } | null = null;
  private downAt = 0;
  private moved = 0;
  /** 一連の操作で同時に触れた最大本数。2 本以上ならタップとして確定しない */
  private maxPointers = 0;
  private holdTimer = 0;
  private holding = false;
  private preview: SnapResult | null = null;
  private cursor: { x: number; y: number } | null = null;
  private magnifier: MagnifierBox | null = null;

  private frameHandle = 0;
  private textTimer = 0;
  private loadTimer = 0;
  private hintTimer = 0;
  private hintHideTimer = 0;

  constructor() {
    this.renderer = new Renderer(el<HTMLCanvasElement>('gl'));
    this.textLayer = new TextLayer(el<HTMLCanvasElement>('text'));
    this.overlay = new Overlay(el<HTMLCanvasElement>('overlay'));
    // 描画コンテキストが戻ったら描き直す
    this.renderer.onRestored = () => this.requestDraw(true);
    this.overlay.drawMagnifierText = (ctx, view, x, y, w, h) => this.textLayer.renderInset(ctx, view, x, y, w, h);

    this.bindUI();
    this.bindGestures();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());

    this.applyDisplay();
    void this.restoreLast();
  }

  // ---------- 座標変換 ----------

  /** CSS ピクセル → 図面座標 */
  private toWorld(cssX: number, cssY: number): { x: number; y: number } {
    const px = cssX * this.dpr;
    const py = cssY * this.dpr;
    const w = this.cssW * this.dpr;
    const h = this.cssH * this.dpr;
    return {
      x: (px - w / 2) / this.view.zoom + this.view.cx,
      y: (h / 2 - py) / this.view.zoom + this.view.cy,
    };
  }

  /** 図面座標での 1 CSS ピクセル相当 */
  private worldPerCssPx(): number {
    return this.dpr / this.view.zoom;
  }

  // ---------- 読み込み ----------

  private async restoreLast(): Promise<void> {
    try {
      const last = await loadLast();
      if (last) this.load(last.buffer, last.name, false);
    } catch {
      // 復元できなくても起動は続ける
    }
  }

  private load(buffer: ArrayBuffer, name: string, persist = true): void {
    el('welcome').classList.add('hidden');
    el('loading').classList.remove('hidden');
    el('loading-text').textContent = `${name} を読み込み中…`;

    if (persist) {
      // 転送で中身が失われる前に保存用の複製を取る
      const copy = buffer.slice(0);
      saveLast(name, copy).catch(() => {
        // 保存できなくても閲覧には支障がないので黙って続ける
      });
    }

    this.worker?.terminate();
    clearTimeout(this.loadTimer);
    this.worker = new Worker(new URL('./jww/worker.ts', import.meta.url), { type: 'module' });
    // 解析が返ってこないまま読み込み画面で固まらないように区切りをつける
    this.loadTimer = window.setTimeout(() => {
      this.worker?.terminate();
      this.worker = null;
      el('loading').classList.add('hidden');
      this.fail('解析に時間がかかりすぎたため中止しました');
    }, 60000);
    this.worker.onmessage = (ev: MessageEvent<LoadResponse>) => {
      clearTimeout(this.loadTimer);
      el('loading').classList.add('hidden');
      const res = ev.data;
      if (!res.ok) {
        this.fail(res.error);
        return;
      }
      this.onLoaded(res.scene, res.info);
    };
    this.worker.onerror = (ev) => {
      clearTimeout(this.loadTimer);
      el('loading').classList.add('hidden');
      this.fail(ev.message || '読み込みに失敗しました');
    };
    this.worker.postMessage({ buffer, name }, [buffer]);
  }

  private fail(message: string): void {
    const w = el('welcome');
    w.classList.remove('hidden');
    const body = w.querySelector('.welcome-body p');
    if (body) {
      body.textContent = `読み込めませんでした: ${message}`;
      body.classList.add('error');
    }
  }

  private onLoaded(scene: Scene, info: LoadedInfo): void {
    this.scene = scene;
    this.info = info;
    this.renderer.setScene(scene);
    this.textLayer.setTexts(scene.texts);
    const index = new SnapIndex(scene);
    this.snapIndex = index;
    this.points = [];
    this.manualScale = false;
    this.selected = -1;
    this.previewEntity = -1;
    this.shapeCache = null;
    this.layerSnapshot = null;
    this.invertOrigin = null;
    this.fitCache = null;
    this.layers.useCounts(scene.layerCounts);

    // 同じ図面を開き直したときは、前に隠していた色とレイヤをそのまま隠す。
    // 記録がなければ、レイヤは Jw_cad で保存したときの表示状態から始める
    const saved = loadViewState(info.name);
    const hiddenPens = new Set(saved.pens);
    this.hiddenGroups = new Set();
    scene.groups.forEach((g, i) => {
      if (hiddenPens.has(g.penColor)) this.hiddenGroups.add(i);
    });
    // 図面の側でレイヤの状態が変わっていたら（別の図面・保存し直した図面）、記録は使わない
    if (saved.groups && saved.layers && saved.jw === jwFingerprint(info)) {
      this.layers.applyHidden({ groups: saved.groups, layers: saved.layers, stash: saved.stash });
    } else {
      this.layers.resetToJw(info.groups, info.writeGroup);
    }
    // 図形の入ったグループが一つだけなら、最初からレイヤを並べておく
    this.expandedGroups.clear();
    const usedGroups = info.groups.filter((g) => g.used);
    if (usedGroups.length === 1) this.expandedGroups.add(usedGroups[0].no);

    this.applyDisplay(false);
    this.buildDisplayPanel();
    this.buildLayerPanel();

    // 見えている線が最も多いレイヤグループの縮尺を既定にする
    const tally = new Map<number, number>();
    for (let i = 0; i < scene.lineLayer.length; i++) {
      if (!index.lineVisible(i)) continue;
      const g = scene.entities.group[scene.lineEntity[i]];
      tally.set(g, (tally.get(g) ?? 0) + 1);
    }
    let bestGroup = info.writeGroup;
    let bestCount = -1;
    for (const [g, c] of tally) {
      if (c > bestCount) { bestCount = c; bestGroup = g; }
    }
    this.measureScale = scene.scales[bestGroup] || 1;
    this.defaultScale = this.measureScale;

    el('title').textContent = info.name;
    this.updatePanels();
    this.updateReadout();
    this.updateInspect();
    this.buildInfoPanel();
    this.fit();
    const hiddenLayers = this.layers.hiddenCount(scene.layerCounts);
    // 資料どおりに読んでいるが実物で確かめていない古い形式は、ほかの知らせより優先して長めに出す
    const old = versionWarning(info.version);
    if (old) {
      this.hint(old, 6000);
    } else {
      this.hint(hiddenLayers > 0
        ? `読み込みました。${hiddenLayers} 個のレイヤが非表示です`
        : `${info.counts.lines.toLocaleString()} 本の線を ${Math.round(info.parseMs)}ms で読み込みました`);
    }
  }

  // ---------- ビュー ----------

  /** 見えている図形での「全体」の範囲（色・レイヤの見え方ごとに覚えておく） */
  private visibleFit(): Bounds {
    const scene = this.scene!;
    const key = `${this.layerMask.join('')}|${this.colorVisible.join('')}`;
    if (this.fitCache?.key !== key) {
      const bounds = fitScene(scene, (color, layer) => this.colorVisible[color] === 1 && this.layerMask[layer] === 1);
      this.fitCache = { key, bounds };
    }
    return this.fitCache.bounds;
  }

  private fit(): void {
    if (!this.scene) return;
    // 見えている図形（色・レイヤ）だけで範囲を決める。隠したレイヤに残った図形で図面が小さくならないように
    const b = this.visibleFit();
    // 上のバーと下（横向きでは右）のパネルに隠れない範囲に収める。狭すぎるときは画面全体に
    const ins = this.measureInsets();
    let top = ins.top;
    let availH = this.cssH - ins.top - ins.bottom;
    if (availH < this.cssH * 0.4) {
      top = 0;
      availH = this.cssH;
    }
    let availW = this.cssW - ins.right;
    if (availW < this.cssW * 0.4) availW = this.cssW;
    const w = availW * this.dpr;
    const h = availH * this.dpr;
    const bw = Math.max(b.maxX - b.minX, 1e-6);
    const bh = Math.max(b.maxY - b.minY, 1e-6);
    const zoom = Math.min(w / bw, h / bh) * 0.94;
    // 見えている範囲の中央に図面の中央が来るように、画面の中央からずらす
    const midX = (availW / 2) * this.dpr;
    const midY = (top + availH / 2) * this.dpr;
    const cx = (b.minX + b.maxX) / 2 - (midX - (this.cssW * this.dpr) / 2) / zoom;
    const cy = (b.minY + b.maxY) / 2 + (midY - (this.cssH * this.dpr) / 2) / zoom;
    this.view = Number.isFinite(zoom) && zoom > 0 && Number.isFinite(cx) && Number.isFinite(cy)
      ? { cx, cy, zoom }
      : { cx: 0, cy: 0, zoom: 1 };
    this.textLayer.setTexts(this.scene.texts);
    this.requestDraw(true);
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.cssW = window.innerWidth;
    this.cssH = window.innerHeight;
    this.renderer.resize(this.cssW, this.cssH, this.dpr);
    this.textLayer.resize(this.cssW, this.cssH, this.dpr);
    this.overlay.resize(this.cssW, this.cssH, this.dpr);
    this.requestDraw(true);
  }

  private requestDraw(redrawText = false): void {
    if (redrawText) {
      clearTimeout(this.textTimer);
      this.textTimer = window.setTimeout(() => {
        if (this.scene && this.textLayer.needsRedraw(this.view)) {
          this.textLayer.render(this.view);
        }
      }, 110);
    }
    if (this.frameHandle) return;
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = 0;
      this.draw();
    });
  }

  private draw(): void {
    if (!this.scene) return;
    this.renderer.draw(this.view, this.dpr);

    // ルーペの中心は指が触れている場所。吸着先を中心にすると、
    // 吸着先が別の図形に移った瞬間に景色ごと大きく飛んでしまう。
    const magView = this.magnifier && this.cursor
      ? { ...this.toWorld(this.cursor.x, this.cursor.y), zoom: this.view.zoom * MAGNIFY }
      : null;

    if (this.magnifier && magView) {
      const m = this.magnifier;
      const k = this.dpr;
      const size = m.size * k;
      const glY = this.cssH * k - (m.y + m.size) * k;
      this.renderer.drawInset(
        { cx: magView.x, cy: magView.y, zoom: magView.zoom },
        Math.round(m.x * k), Math.round(glY), Math.round(size), Math.round(size),
        this.dpr,
      );
    }

    this.textLayer.syncTransform(this.view);
    this.clipTextForMagnifier();

    const state: OverlayState = {
      points: this.points,
      highlight: this.currentHighlight(),
      constraint: this.holding ? this.constraint : null,
      activeIndex: this.dragIndex,
      preview: this.preview,
      cursor: this.cursor,
      magnifier: this.magnifier,
      magnifierView: magView ? { ...magView, dpr: this.dpr } : null,
      scale: this.measureScale,
      fixedScale: this.manualScale,
    };
    this.overlay.render(this.view, state);
  }

  /** 属性で見ている図形（長押し中は指の下の図形）の形 */
  private currentHighlight(): Highlight | null {
    if (!this.scene || this.tool !== 'inspect') return null;
    const i = this.holding ? this.previewEntity : this.selected;
    if (i < 0) return null;
    if (this.shapeCache?.index !== i) {
      const shape = entityShape(this.scene, i);
      // 寸法線・補助線では寸法値の枠も示すが、その文字が隠れているなら何もない所を囲むことになる
      const e = this.scene.entities;
      const t = this.scene.texts[e.text[i]];
      if ((e.kind[i] === KIND.dim || e.kind[i] === KIND.dimAux) && t
        && !(this.colorVisible[t.color] === 1 && this.layerMask[t.layer] === 1)) {
        shape.box = null;
      }
      this.shapeCache = { index: i, shape };
    }
    return this.shapeCache.shape;
  }

  /**
   * ルーペの中は WebGL が拡大して描き直しているのに、
   * 文字レイヤは等倍のまま重なってしまう。その部分だけ切り抜く。
   */
  private clipTextForMagnifier(): void {
    const style = this.textLayer.canvas.style;
    const m = this.magnifier;
    if (!m) {
      if (style.clipPath) style.clipPath = '';
      return;
    }
    const x1 = `${m.x}px`;
    const y1 = `${m.y}px`;
    const x2 = `${m.x + m.size}px`;
    const y2 = `${m.y + m.size}px`;
    // 外周を時計回り、穴を反時計回りに描いて中央を抜く
    style.clipPath =
      `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ` +
      `${x1} ${y1}, ${x1} ${y2}, ${x2} ${y2}, ${x2} ${y1}, ${x1} ${y1})`;
  }

  // ---------- ジェスチャ ----------

  private bindGestures(): void {
    const stage = el('stage');
    stage.addEventListener('pointerdown', (e) => this.onDown(e as PointerEvent));
    stage.addEventListener('pointermove', (e) => this.onMove(e as PointerEvent));
    stage.addEventListener('pointerup', (e) => this.onUp(e as PointerEvent));
    stage.addEventListener('pointercancel', (e) => this.onCancel(e as PointerEvent));
    stage.addEventListener('wheel', (e) => this.onWheel(e as WheelEvent), { passive: false });
    // iOS Safari のダブルタップズーム・ピンチによるページ拡大を抑止
    stage.addEventListener('dblclick', (e) => e.preventDefault());
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
    // 図面へのタップのあとに互換の click が出ると、その間に大きさの変わったパネルのボタンに当たることがある。
    // 図面は pointer イベントだけで扱っているので、図面で始まったタッチの click は出さない
    stage.addEventListener('touchend', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    }
  }

  private onDown(e: PointerEvent): void {
    try {
      // 捕捉できないポインタもある。ここで例外が出ると以降の処理が丸ごと止まる
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // 捕捉なしでも操作は続けられる
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    this.maxPointers = Math.max(this.maxPointers, this.pointers.size);

    if (this.pointers.size === 1) {
      this.downAt = performance.now();
      this.moved = 0;
      clearTimeout(this.holdTimer);

      // 置いた点をつまんだなら、その場で動かし始める
      const grabbed = this.tool === 'measure' ? this.hitPoint(e.clientX, e.clientY) : null;
      if (grabbed !== null) {
        this.dragIndex = grabbed;
        this.startHold(e.clientX, e.clientY);
        return;
      }
      this.holdTimer = window.setTimeout(() => this.startHold(e.clientX, e.clientY), 260);
    } else {
      this.cancelHold();
      // 3 本目が触れても基準の 2 点が入れ替わることがあるので必ず取り直す
      this.pinch = this.pinchState();
    }
  }

  private onMove(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 1) {
      this.moved += Math.hypot(dx, dy);
      if (this.holding) {
        this.updateHold(e.clientX, e.clientY);
        this.requestDraw();
        return;
      }
      if (this.moved > 8) this.cancelHold();
      // パン
      this.view.cx -= (dx * this.dpr) / this.view.zoom;
      this.view.cy += (dy * this.dpr) / this.view.zoom;
      this.requestDraw(true);
      return;
    }

    if (this.pointers.size >= 2) {
      const now = this.pinchState();
      if (!now) return;
      const prevPinch = this.pinch;
      if (prevPinch && now.dist > 0 && prevPinch.dist > 0) {
        const world = this.toWorld(prevPinch.midX, prevPinch.midY);
        const factor = now.dist / prevPinch.dist;
        this.setZoom(this.view.zoom * factor);
        // 指の中点が同じ図面位置を掴み続けるように中心をずらす
        const w = this.cssW * this.dpr;
        const h = this.cssH * this.dpr;
        this.view.cx = world.x - (now.midX * this.dpr - w / 2) / this.view.zoom;
        this.view.cy = world.y - (h / 2 - now.midY * this.dpr) / this.view.zoom;
      }
      this.pinch = now;
      this.requestDraw(true);
    }
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    // 残った指で基準の 2 点が入れ替わると倍率が飛ぶので、その場で張り直す
    this.pinch = this.pointers.size >= 2 ? this.pinchState() : null;

    if (this.holding) {
      const hit = this.preview;
      const index = this.dragIndex;
      const entity = this.previewEntity;
      const inspecting = this.tool === 'inspect';
      this.cancelHold();
      if (inspecting) {
        this.select(entity);
      } else if (hit) {
        if (index !== null) this.movePoint(index, hit);
        else this.addPoint(hit);
      }
      this.finishStroke();
      this.requestDraw(true);
      return;
    }

    clearTimeout(this.holdTimer);
    const quick = performance.now() - this.downAt < 400;
    // 2 本以上触れていた操作はピンチなので、点を打たない
    if (this.pointers.size === 0 && this.maxPointers === 1 && quick && this.moved < 9) {
      if (this.tool === 'inspect') {
        this.select(this.pickAt(e.clientX, e.clientY));
      } else {
        const hit = this.snapFor(e.clientX, e.clientY, null);
        if (hit) this.addPoint(hit);
      }
    }
    this.finishStroke();
    this.requestDraw(true);
  }

  /** システムにジェスチャを奪われたとき。タップとしては確定させない */
  private onCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    this.pinch = this.pointers.size >= 2 ? this.pinchState() : null;
    this.cancelHold();
    this.finishStroke();
    this.requestDraw(true);
  }

  private finishStroke(): void {
    if (this.pointers.size === 0) {
      this.maxPointers = 0;
      this.moved = 0;
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const world = this.toWorld(e.clientX, e.clientY);
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.setZoom(this.view.zoom * factor);
    const w = this.cssW * this.dpr;
    const h = this.cssH * this.dpr;
    this.view.cx = world.x - (e.clientX * this.dpr - w / 2) / this.view.zoom;
    this.view.cy = world.y - (h / 2 - e.clientY * this.dpr) / this.view.zoom;
    this.requestDraw(true);
  }

  private setZoom(z: number): void {
    if (!this.scene) return;
    const b = this.scene.bounds;
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1e-6);
    const min = (this.cssW * this.dpr) / (span * 40);
    const max = (this.cssW * this.dpr) / 0.02;
    this.view.zoom = Math.max(min, Math.min(max, z));
  }

  private pinchState(): { dist: number; midX: number; midY: number } | null {
    const list = [...this.pointers.values()];
    if (list.length < 2) return null;
    const a = list[0];
    const b = list[1];
    return {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
    };
  }

  // ---------- 長押し（拡大鏡） ----------

  private startHold(cssX: number, cssY: number): void {
    if (!this.scene) return;
    this.holding = true;
    // 開いているシートも避ける（シートの上に見えている図面でも長押しできるので）
    this.insets = this.measureInsets(true);
    if (navigator.vibrate) navigator.vibrate(8);
    // 切り抜き位置と文字の位置を合わせるため、ここで transform を畳んでおく
    this.textLayer.render(this.view);
    this.updateHold(cssX, cssY);
    this.requestDraw();
  }

  private updateHold(cssX: number, cssY: number): void {
    this.cursor = { x: cssX, y: cssY };
    if (this.tool === 'inspect') {
      this.preview = null;
      this.previewEntity = this.pickAt(cssX, cssY);
    } else {
      this.preview = this.snapFor(cssX, cssY, this.dragIndex);
    }
    this.magnifier = this.placeMagnifier(cssX, cssY);
  }

  /**
   * 図面の見えている範囲を狭めているもの（上のバー、下のパネルとツールバー、横向きで右に寄せたパネル）。
   * withSheets なら開いているシートも数える。全体表示では一時的なシートは数えない。
   */
  private measureInsets(withSheets = false): Insets {
    const bar = document.getElementById('topbar')?.getBoundingClientRect();
    let bottomEdge = this.cssH;
    let rightEdge = this.cssW;
    const ids: string[] = ['toolbar', 'readout', 'inspect-panel'];
    if (withSheets) ids.push(...SHEETS);
    for (const id of ids) {
      const node = document.getElementById(id);
      if (!node || node.classList.contains('hidden')) continue;
      const r = node.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      // 横に広いものは下を、右に寄せた細いもの（横向きのパネル）は右を塞ぐ
      if (r.width >= this.cssW * 0.6) bottomEdge = Math.min(bottomEdge, r.top);
      else if (r.left > this.cssW / 2) rightEdge = Math.min(rightEdge, r.left);
    }
    return {
      top: bar && bar.height > 0 ? bar.bottom + 4 : 52,
      bottom: this.cssH - bottomEdge + 8,
      right: rightEdge < this.cssW ? this.cssW - rightEdge + 8 : 0,
    };
  }

  /**
   * 拡大鏡は「指で隠れている場所」を見せるためのものなので、
   * 指と重ならない位置に必ず置く。横向きなど画面が低いときは指の左右に逃がす。
   */
  private placeMagnifier(cssX: number, cssY: number): MagnifierBox {
    const margin = 12;
    const topLimit = this.insets.top;       // 上部のバー
    const bottomLimit = this.insets.bottom; // 下部のパネルとツールバー（開いているシートも）
    const rightLimit = this.insets.right;   // 横向きで右に寄せたパネル
    const gap = 28;                         // 指との間隔
    // 横向きやシートを開いているときは、見えている範囲に収まるまで小さくする
    const roomH = this.cssH - topLimit - bottomLimit;
    const roomW = this.cssW - rightLimit - margin * 2;
    const size = Math.round(Math.max(64, Math.min(180, Math.min(this.cssW, this.cssH) * 0.44, roomH, roomW)));
    const maxX = this.cssW - rightLimit - size - margin;

    const clampX = (v: number): number => Math.max(margin, Math.min(maxX, v));

    const roomAbove = cssY - gap - topLimit;
    const roomBelow = this.cssH - bottomLimit - (cssY + gap);

    if (roomAbove >= size) {
      // パネルの横（パネルと同じ高さ）で押したときも、拡大鏡はパネルの上端より上に収める
      return { x: clampX(cssX - size / 2), y: Math.min(cssY - gap - size, this.cssH - bottomLimit - size), size };
    }
    if (roomBelow >= size) {
      return { x: clampX(cssX - size / 2), y: cssY + gap, size };
    }

    // 縦に逃がせないので左右へ。指から遠い側に置き、そこに入りきらなければ入る大きさまで小さくする
    // （指の上に重ねると、指で隠れた所を見せるという役目を果たせないため）
    const mid = (this.cssW - rightLimit) / 2;
    const leftRoom = cssX - gap - margin;
    const rightRoom = this.cssW - rightLimit - margin - (cssX + gap);
    const useLeft = cssX > mid ? leftRoom >= 64 || leftRoom >= rightRoom : !(rightRoom >= 64 || rightRoom >= leftRoom);
    const s2 = Math.round(Math.max(48, Math.min(size, useLeft ? leftRoom : rightRoom)));
    const y = Math.max(topLimit, Math.min(this.cssH - bottomLimit - s2, cssY - s2 / 2));
    const x = useLeft ? Math.max(margin, cssX - gap - s2) : Math.min(this.cssW - rightLimit - margin - s2, cssX + gap);
    return { x, y, size: s2 };
  }

  private cancelHold(): void {
    clearTimeout(this.holdTimer);
    this.holding = false;
    this.preview = null;
    this.previewEntity = -1;
    this.cursor = null;
    this.magnifier = null;
    this.constraint = null;
    this.dragIndex = null;
  }

  // ---------- 計測 ----------

  /**
   * 拘束の基準になる点。
   * 新しく置くときは直前の点、既にある点を動かすときはその手前（無ければ次）の点。
   */
  private anchorFor(index: number | null): MeasurePoint | null {
    if (index === null) return this.points[this.points.length - 1] ?? null;
    return this.points[index - 1] ?? this.points[index + 1] ?? null;
  }

  /**
   * 指の位置から吸着先を決める。
   * 直交が入っているときは基準点から水平／垂直に伸ばした線の上だけを探し、
   * その線が図形と交わるところに吸着する。
   */
  private snapFor(cssX: number, cssY: number, index: number | null, radiusCssPx = SNAP_RADIUS): SnapResult | null {
    if (!this.snapIndex) return null;
    const w = this.toWorld(cssX, cssY);
    const radius = radiusCssPx * this.worldPerCssPx();

    const anchor = this.ortho ? this.anchorFor(index) : null;
    if (!anchor) {
      this.constraint = null;
      return this.snapIndex.query(w.x, w.y, radius);
    }

    // 指の向きが横寄りか縦寄りかで、どちらに拘束するかを決める
    const axis: Axis = Math.abs(w.x - anchor.x) >= Math.abs(w.y - anchor.y) ? 'horizontal' : 'vertical';
    this.constraint = { x: anchor.x, y: anchor.y, axis };
    return this.snapIndex.queryOnAxis(anchor.x, anchor.y, axis, w.x, w.y, radius);
  }

  /** 指を置いた場所に既にある計測点があればその番号 */
  private hitPoint(cssX: number, cssY: number): number | null {
    if (this.points.length === 0) return null;
    const w = this.toWorld(cssX, cssY);
    const r = 24 * this.worldPerCssPx();
    let best: number | null = null;
    let bestD = Infinity;
    for (let i = 0; i < this.points.length; i++) {
      const d = Math.hypot(this.points[i].x - w.x, this.points[i].y - w.y);
      if (d <= r && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** 既にある計測点を動かす */
  private movePoint(index: number, hit: SnapResult): void {
    if (index < 0 || index >= this.points.length) return;
    this.points[index] = this.toMeasurePoint(hit);
    this.updateReadout();
    if (navigator.vibrate) navigator.vibrate(4);
  }

  private toMeasurePoint(hit: SnapResult): MeasurePoint {
    // 縮尺が決め手を欠く点（何もない場所、縮尺の違う 2 本の交点）は null にして、
    // 区間ごとの計算で取り違えないようにする
    const known = hit.kind !== 'free' && !hit.ambiguousGroup && this.scene;
    const scale = known ? (this.scene!.scales[hit.glayer] || null) : null;
    return { x: hit.x, y: hit.y, glayer: hit.glayer, kind: hit.kind, scale };
  }

  private addPoint(hit: SnapResult): void {
    const p = this.toMeasurePoint(hit);

    // 最初の点が乗ったレイヤグループの縮尺を既定にする
    if (!this.manualScale && this.points.length === 0 && p.scale != null) {
      this.measureScale = p.scale;
      this.buildInfoPanel();
    }
    this.points.push(p);
    this.updateReadout();
    // 1 点目を置くと計測パネルが 2 段に伸びる。置いた点がその下に隠れたら、図面をずらす
    if (this.points.length === 1) this.keepClearOfPanel(p.x, p.y);
    if (navigator.vibrate) navigator.vibrate(4);
  }

  /**
   * 図面座標の点が計測パネルに隠れていたら、見える所まで図面をずらす。
   * 下に広がるパネルなら上へ、横向きで右に寄せたパネルなら左へ。隠れていなければ動かさない。
   */
  private keepClearOfPanel(x: number, y: number): void {
    const r = el('readout').getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const k = this.dpr / this.view.zoom;
    const sx = (x - this.view.cx) / k + this.cssW / 2;
    const sy = this.cssH / 2 - (y - this.view.cy) / k;
    const m = 16;
    // 計測パネルかツールバーに隠れた（またはその縁にかかった）ら、その上端より上へずらす。
    // 横向きで右に寄せたパネルでも上へずらすのは、直交で続けて測る行がパネルの下に入らないようにするため
    let target = Infinity;
    for (const box of [r, el('toolbar').getBoundingClientRect()]) {
      if (box.width <= 0 || box.height <= 0) continue;
      if (sx < box.left - m || sx > box.right + m || sy < box.top - m || sy > box.bottom + m) continue;
      target = Math.min(target, box.top - m);
    }
    if (!Number.isFinite(target) || sy <= target) return;
    const topLimit = this.measureInsets().top + m;
    if (target >= topLimit) {
      this.view.cy -= (sy - target) * k;
    } else {
      // 上へずらすと上のバーに入ってしまう（とても低い横画面）ときだけ、左へ
      this.view.cx += (sx - (r.left - m)) * k;
    }
    this.requestDraw(true);
  }

  private updateReadout(): void {
    const value = el('readout-value');
    const detail = el('readout-detail');
    const scale = el('btn-scale');
    const n = this.points.length;
    el<HTMLButtonElement>('btn-undo').disabled = n === 0;
    el<HTMLButtonElement>('btn-clear').disabled = n === 0;
    // 点がないときは操作の段だけにして、図面を広く見せる。
    // 操作の段は動かないので、「戻す」を続けて押してもボタンが指の下から逃げない
    el('readout').classList.toggle('idle', n === 0);

    if (n < 2) {
      value.textContent = '—';
      scale.textContent = `1/${formatScale(this.measureScale)}`;
      detail.textContent = n === 0 ? '' : `1 点目は${SNAP_LABEL[this.points[0].kind]}。2 点目をタップしてください`;
      return;
    }

    const m = measureLengths(this.points, this.measureScale, this.manualScale);
    const segs = m.segments;
    const total = m.total;
    // 縮尺違いの注意は、2 行に切り詰めても消えないように先頭に置く
    const warn = m.mixed ? '※縮尺の違う図をまたいでいます　' : '';

    value.textContent = formatLength(segs[segs.length - 1]);
    // 表示している長さ（最後の区間）に使った縮尺
    scale.textContent = `1/${formatScale(m.scales[m.scales.length - 1])}`;

    let text: string;
    if (segs.length > 1) {
      text = `合計 ${formatLength(total)} ／ ${segs.map((s) => formatLength(s)).join(' + ')}`;
    } else {
      const a = this.points[0];
      const b = this.points[1];
      const scale = m.scales[0];
      const dx = Math.abs(b.x - a.x) * scale;
      const dy = Math.abs(b.y - a.y) * scale;
      // 斜めに測ったときだけ、水平と垂直の内訳を添える
      text = dx > 1e-6 && dy > 1e-6
        ? `水平 ${formatLength(dx)} ／ 垂直 ${formatLength(dy)}`
        : `${SNAP_LABEL[a.kind]} → ${SNAP_LABEL[b.kind]}`;
    }
    detail.textContent = warn + text;
  }

  // ---------- 属性 ----------

  /** 指の位置にある図形。見えていない色・レイヤの図形は拾わない */
  private pickAt(cssX: number, cssY: number): number {
    if (!this.scene || !this.snapIndex) return -1;
    const w = this.toWorld(cssX, cssY);
    const r = SNAP_RADIUS * this.worldPerCssPx();
    return pickEntity(this.scene, this.snapIndex, w.x, w.y, r,
      (color, layer) => this.colorVisible[color] === 1 && this.layerMask[layer] === 1);
  }

  private entityVisible(i: number): boolean {
    const e = this.scene?.entities;
    if (!e || i < 0 || i >= e.count) return false;
    return this.colorVisible[e.color[i]] === 1 && this.layerMask[e.layer[i]] === 1;
  }

  private select(i: number): void {
    // 別の図形を選んだら、属性パネルは先頭（種類とレイヤ）から見せる
    if (i !== this.selected) el('inspect-panel').scrollTop = 0;
    this.selected = i;
    this.updateInspect();
    // レイヤ一覧を開いたままなら、印と開いているグループも新しい図形に合わせる
    if (!el('layer-panel').classList.contains('hidden')) {
      if (i >= 0 && this.scene) this.expandedGroups.add(this.scene.entities.layer[i] >> 4);
      this.buildLayerPanel();
    }
    if (i >= 0) this.reveal(i);
    this.requestDraw(true);
    if (i >= 0 && navigator.vibrate) navigator.vibrate(4);
  }

  /**
   * 属性パネルが伸びて、選んだ図形がその下に隠れたときは、図面をずらして見えるようにする。
   * 図形が見えている範囲より大きいときは、上端（左端）を合わせる。
   */
  private reveal(i: number): void {
    const shape = this.currentHighlight() ?? (this.scene ? entityShape(this.scene, i) : null);
    if (!shape) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const add = (arr: ArrayLike<number>): void => {
      for (let k = 0; k + 1 < arr.length; k += 2) {
        const x = arr[k], y = arr[k + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    };
    add(shape.lines);
    add(shape.tris);
    if (shape.box) add(shape.box);
    if (shape.point) add(shape.point);
    if (!Number.isFinite(minX)) return;

    const k = this.dpr / this.view.zoom; // 1 CSS ピクセルあたりの図面座標
    const left = (minX - this.view.cx) / k + this.cssW / 2;
    const right = (maxX - this.view.cx) / k + this.cssW / 2;
    const top = this.cssH / 2 - (maxY - this.view.cy) / k;
    const bottom = this.cssH / 2 - (minY - this.view.cy) / k;
    const ins = this.measureInsets();
    const pad = 16;

    let dy = 0;
    const limitBottom = this.cssH - ins.bottom - pad;
    if (bottom > limitBottom) dy = Math.min(bottom - limitBottom, top - (ins.top + pad));
    let dx = 0;
    const limitRight = this.cssW - ins.right - pad;
    if (ins.right > 0 && right > limitRight) dx = Math.min(right - limitRight, left - pad);
    if (dy <= 0 && dx <= 0) return;
    // 図形を上（左）へ動かす
    if (dy > 0) this.view.cy -= dy * k;
    if (dx > 0) this.view.cx += dx * k;
  }

  /**
   * 色番号の見本（style 属性の中身）。いまの背景の上で、色分けしたときの線の色。
   * パネルは背景に関係なく暗いので、見本は図面の地色の輪の中に描く。
   */
  private swatchColor(color: number): string {
    const c = this.scene?.colors;
    if (!c) return '';
    const [r, g, b] = displayColor(c[color * 3], c[color * 3 + 1], c[color * 3 + 2],
      { background: this.display.background, mono: false });
    const paper = BACKGROUND_RGB[this.display.background];
    return `--ink:rgb(${r},${g},${b});--paper:rgb(${paper.join(',')})`;
  }

  private updateInspect(): void {
    const kind = el('inspect-kind');
    const tag = el('inspect-tag');
    const body = el('inspect-body');
    const scene = this.scene;
    const info = this.info;
    const i = this.selected;
    // 「表示を反転」は図形を選んでいなくても使える。「レイヤだけ表示」「隠す」は選んだ図形のレイヤに対して
    el('btn-layer-back').classList.toggle('hidden', this.layerSnapshot === null);

    if (!scene || !info || i < 0) {
      kind.textContent = '属性';
      tag.classList.add('hidden');
      body.innerHTML = '<div class="inspect-empty">図形をタップすると、レイヤ・線色・線種・長さを表示します。長押しすると拡大鏡で選べます</div>';
      el<HTMLButtonElement>('btn-layer-only').disabled = true;
      el<HTMLButtonElement>('btn-layer-hide').disabled = true;
      return;
    }

    const d = describeEntity(scene, info, i, (c) => this.swatchColor(c));
    kind.textContent = d.kind;
    tag.textContent = layerTag(d.layer);
    tag.classList.remove('hidden');
    body.innerHTML = d.rows
      .map((r) => `<span class="k">${escapeHtml(r.label)}</span><span class="v">${r.html}</span>`)
      .join('');
    el<HTMLButtonElement>('btn-layer-only').disabled = false;
    el<HTMLButtonElement>('btn-layer-hide').disabled = false;
  }

  /** 反転したあと、いくつのレイヤが見えるようになったかを知らせる */
  private hintInverted(): void {
    const counts = this.scene?.layerCounts;
    if (!counts) return;
    let used = 0;
    for (let k = 0; k < 256; k++) if (counts[k] > 0) used++;
    const shown = used - this.layers.hiddenCount(counts);
    this.hint(`表示と非表示を入れ替えました（${used} レイヤ中 ${shown} を表示）`);
  }

  private setTool(tool: Tool): void {
    if (this.tool === tool) return;
    this.cancelHold();
    this.tool = tool;
    this.updatePanels();
    this.requestDraw();
    this.hint(tool === 'inspect' ? '図形をタップすると属性を表示します' : 'タップで計測点を置きます');
  }

  /** 下のパネル（計測・属性）とツールボタンの状態を、いまのツールに合わせる */
  private updatePanels(): void {
    const loaded = this.scene !== null;
    el('readout').classList.toggle('hidden', !loaded || this.tool !== 'measure');
    el('inspect-panel').classList.toggle('hidden', !loaded || this.tool !== 'inspect');
    for (const [id, t] of [['btn-tool-measure', 'measure'], ['btn-tool-inspect', 'inspect']] as const) {
      const on = this.tool === t;
      el(id).classList.toggle('on', on);
      el(id).setAttribute('aria-pressed', String(on));
    }
  }

  /** 下から出るシートは同時に一つだけ。null ならすべて閉じる */
  private openSheet(id: Sheet | null): void {
    for (const s of SHEETS) el(s).classList.toggle('hidden', s !== id);
    el('btn-layers').setAttribute('aria-expanded', String(id === 'layer-panel'));
    el('btn-display').setAttribute('aria-expanded', String(id === 'display-panel'));
  }

  private toggleSheet(id: Sheet): boolean {
    const open = el(id).classList.contains('hidden');
    this.openSheet(open ? id : null);
    return open;
  }

  private hint(text: string, ms = 2600): void {
    const node = el('hint');
    node.textContent = text;
    node.classList.remove('hidden');
    node.style.opacity = '1';
    // 前のヒントが消えかけている途中でも、新しいヒントを巻き込んで消さないように両方止める
    clearTimeout(this.hintTimer);
    clearTimeout(this.hintHideTimer);
    this.hintTimer = window.setTimeout(() => {
      node.style.opacity = '0';
      this.hintHideTimer = window.setTimeout(() => node.classList.add('hidden'), 260);
    }, ms);
  }

  // ---------- UI ----------

  private bindUI(): void {
    const file = el<HTMLInputElement>('file');
    const pick = (): void => file.click();
    el('btn-open').addEventListener('click', pick);
    el('btn-open-2').addEventListener('click', pick);

    file.addEventListener('change', () => {
      const f = file.files?.[0];
      if (!f) return;
      f.arrayBuffer().then((buf) => this.load(buf, f.name)).catch(() => this.fail('ファイルを読み取れませんでした'));
      file.value = '';
    });

    el('btn-tool-measure').addEventListener('click', () => this.setTool('measure'));
    el('btn-tool-inspect').addEventListener('click', () => this.setTool('inspect'));

    el('btn-ortho').addEventListener('click', () => {
      this.ortho = !this.ortho;
      el('btn-ortho').classList.toggle('on', this.ortho);
      el('btn-ortho').setAttribute('aria-pressed', String(this.ortho));
      this.hint(this.ortho ? '水平・垂直に測ります' : '自由な向きで測ります');
      this.requestDraw();
    });

    el('btn-undo').addEventListener('click', () => {
      this.points.pop();
      this.updateReadout();
      this.requestDraw();
    });

    el('btn-clear').addEventListener('click', () => {
      this.points = [];
      this.updateReadout();
      this.requestDraw();
    });

    el('btn-fit').addEventListener('click', () => this.fit());

    el('btn-scale').addEventListener('click', () => {
      this.openSheet('info-panel');
      this.buildInfoPanel();
    });

    el('btn-info').addEventListener('click', () => {
      if (this.toggleSheet('info-panel')) this.buildInfoPanel();
    });
    el('btn-info-close').addEventListener('click', () => this.openSheet(null));

    // ---- 属性 ----
    el('btn-layer-only').addEventListener('click', () => {
      if (!this.scene || this.selected < 0) return;
      const k = this.scene.entities.layer[this.selected];
      // 続けて操作しても、「元に戻す」は最初の状態に戻す
      if (!this.layerSnapshot) this.layerSnapshot = this.layers.snapshot();
      this.layers.only(k);
      this.afterLayerChange(false);
      this.hint(`レイヤ ${layerTag(k)} だけを表示しています`);
    });
    el('btn-layer-hide').addEventListener('click', () => {
      if (!this.scene || this.selected < 0) return;
      const k = this.scene.entities.layer[this.selected];
      if (!this.layerSnapshot) this.layerSnapshot = this.layers.snapshot();
      this.layers.forget(k >> 4);
      this.layers.layer[k] = false;
      this.afterLayerChange(false);
      this.hint(`レイヤ ${layerTag(k)} を隠しました`);
    });
    el('btn-layer-invert').addEventListener('click', () => this.invertLayers(true));
    el('btn-layer-back').addEventListener('click', () => {
      if (!this.layerSnapshot) return;
      this.layers.restore(this.layerSnapshot);
      this.layerSnapshot = null;
      this.afterLayerChange(false);
    });

    // ---- レイヤ ----
    el('btn-layers').addEventListener('click', () => {
      if (!this.toggleSheet('layer-panel')) return;
      // 属性を見ている図形のレイヤが見えるように、そのグループを開いておく
      if (this.scene && this.selected >= 0) this.expandedGroups.add(this.scene.entities.layer[this.selected] >> 4);
      this.buildLayerPanel();
      el('layer-list').querySelector('.l-row.mark')?.scrollIntoView({ block: 'center' });
    });
    el('btn-layer-close').addEventListener('click', () => this.openSheet(null));
    el('btn-layer-jw').addEventListener('click', () => {
      if (!this.info) return;
      this.layers.resetToJw(this.info.groups, this.info.writeGroup);
      this.afterLayerChange(true);
      this.hint('Jw_cad で保存したときの表示に戻しました');
    });
    el('btn-layer-all').addEventListener('click', () => {
      this.layers.showAll();
      this.afterLayerChange(true);
    });
    el('btn-layer-invert-all').addEventListener('click', () => this.invertLayers(false));
    el('layer-list').addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const sw = target.closest<HTMLElement>('.sw');
      const head = target.closest<HTMLElement>('.lg-head');
      const row = target.closest<HTMLElement>('.l-row');
      if (sw?.dataset.group !== undefined) {
        const g = Number(sw.dataset.group);
        this.layers.forget(g);
        this.layers.group[g] = !this.layers.group[g];
        this.afterLayerChange(true);
      } else if (head) {
        const g = Number(head.dataset.toggle);
        if (this.expandedGroups.has(g)) this.expandedGroups.delete(g);
        else this.expandedGroups.add(g);
        this.buildLayerPanel();
      } else if (row) {
        // 行のどこを触っても、そのレイヤの表示を切り替える
        this.toggleLayer(Number(row.dataset.k));
      }
    });

    // ---- 表示 ----
    el('btn-display').addEventListener('click', () => {
      if (this.toggleSheet('display-panel')) this.buildDisplayPanel();
    });
    el('btn-display-close').addEventListener('click', () => this.openSheet(null));

    el('seg-bg').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!b) return;
      this.setDisplay({ ...this.display, background: b.dataset.value === 'light' ? 'light' : 'dark' });
    });
    el('seg-mono').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!b) return;
      this.setDisplay({ ...this.display, mono: b.dataset.value === 'mono' });
    });

    el('color-list').addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.color-row');
      if (!row) return;
      const g = Number(row.dataset.group);
      if (this.hiddenGroups.has(g)) this.hiddenGroups.delete(g);
      else this.hiddenGroups.add(g);
      this.afterVisibilityChange();
    });
    el('btn-color-all').addEventListener('click', () => {
      this.hiddenGroups.clear();
      this.afterVisibilityChange();
    });
    el('btn-color-none').addEventListener('click', () => {
      if (!this.scene) return;
      this.scene.groups.forEach((_, i) => this.hiddenGroups.add(i));
      this.afterVisibilityChange();
    });

    // デスクトップでの動作確認用
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) f.arrayBuffer().then((buf) => this.load(buf, f.name)).catch(() => this.fail('ファイルを読み取れませんでした'));
    });
  }

  // ---------- 表示 ----------

  private setDisplay(next: DisplaySettings): void {
    this.display = next;
    saveDisplay(next);
    this.applyDisplay();
    this.buildDisplayPanel();
    // 属性の色見本も背景に合わせる
    this.updateInspect();
  }

  /**
   * 図面ごとの表示状態（隠した色・レイヤ）を覚えておく。
   * 「このレイヤだけ表示」「隠す」は一時的なものなので、その前の状態を覚える。
   * レイヤが Jw_cad の状態のままなら記録しない（図面の側の状態にいつも従うように）。
   */
  private saveViewState(): void {
    const info = this.info;
    const scene = this.scene;
    if (!info || !scene) return;
    const layers = this.layerSnapshot ? this.layersFrom(this.layerSnapshot) : this.layers;
    const jw = new LayerVisibility().useCounts(scene.layerCounts);
    jw.resetToJw(info.groups, info.writeGroup);
    const hidden = layers.hidden();
    // 図形のあるグループのスイッチとレイヤの設定が Jw_cad の状態と同じで、反転の覚え書きもなければ記録しない。
    // グループごと隠れていて見え方が同じでも、中の設定を変えていれば残す
    const same = layers.stash.size === 0 && layers.sameSettings(jw);
    saveViewState(info.name, {
      pens: [...this.hiddenGroups].map((i) => scene.groups[i].penColor),
      groups: same ? null : hidden.groups,
      layers: same ? null : hidden.layers,
      stash: same || hidden.stash.length === 0 ? null : hidden.stash,
      jw: jwFingerprint(info),
    });
  }

  private afterVisibilityChange(): void {
    this.saveViewState();
    this.applyDisplay();
    this.buildDisplayPanel();
  }

  /**
   * レイヤの表示を変えたあと。
   * fromList はレイヤ一覧で変えたとき。一覧で手を入れたら、属性からの「元に戻す」は意味が変わるので捨てる。
   */
  private afterLayerChange(fromList: boolean): void {
    if (fromList) this.layerSnapshot = null;
    // 反転以外で表示を変えたら、反転を続けて押す前の状態は忘れる（反転からは invertLayers が戻し直す）
    this.invertOrigin = null;
    this.saveViewState();
    this.applyDisplay();
    this.buildLayerPanel();
    this.updateInspect();
  }

  /** 図形の数を覚えさせた LayerVisibility を、覚えておいた状態から作る */
  private layersFrom(s: LayerSnapshot): LayerVisibility {
    const v = new LayerVisibility().useCounts(this.scene?.layerCounts ?? null);
    v.restore(s);
    return v;
  }

  /**
   * 表示を反転する。temporary は属性パネルからの一時的な操作（「元に戻す」で戻せ、保存しない）。
   * 反転を続けて押して同じ見え方に戻ったら、グループの持ち方まで元どおりにする
   * （反転だけでは、グループごと隠していたときの中の設定までは戻せないため）。
   */
  private invertLayers(temporary: boolean): void {
    if (!this.scene) return;
    if (temporary && !this.layerSnapshot) this.layerSnapshot = this.layers.snapshot();
    const origin = this.invertOrigin ?? this.layers.snapshot();
    this.layers.invert();
    let keep: LayerSnapshot | null = origin;
    if (this.layers.sameAs(this.layersFrom(origin))) {
      this.layers.restore(origin);
      keep = null;
    }
    // 属性からの操作の前と同じ見え方に戻ったなら、その状態に戻して「元に戻す」をしまう
    if (this.layerSnapshot && this.layers.sameAs(this.layersFrom(this.layerSnapshot))) {
      this.layers.restore(this.layerSnapshot);
      this.layerSnapshot = null;
    }
    this.afterLayerChange(!temporary);
    this.invertOrigin = keep;
    this.hintInverted();
  }

  /**
   * レイヤ一つの表示を切り替える。
   * グループごと隠れているレイヤを表示にしたときは、グループを表示にして、そのレイヤだけを見せる
   * （グループ内のほかのレイヤまで一度に現れると、何を出したのか分からなくなる）。
   */
  private toggleLayer(k: number): void {
    const g = k >> 4;
    this.layers.forget(g);
    if (!this.layers.group[g]) {
      this.layers.group[g] = true;
      for (let l = 0; l < 16; l++) this.layers.layer[(g << 4) | l] = false;
      this.layers.layer[k] = true;
    } else {
      this.layers.layer[k] = !this.layers.layer[k];
    }
    this.afterLayerChange(true);
  }

  private buildLayerPanel(): void {
    const list = el('layer-list');
    const summary = el('layer-summary');
    const scene = this.scene;
    const info = this.info;
    if (!scene || !info) {
      list.innerHTML = '<p class="sub">図面が読み込まれていません。</p>';
      summary.textContent = '';
      return;
    }
    const mark = this.selected >= 0 ? scene.entities.layer[this.selected] : null;
    renderLayerList(list, info.groups, scene.layerCounts, this.layers, this.expandedGroups, mark);

    let used = 0;
    for (let k = 0; k < 256; k++) if (scene.layerCounts[k] > 0) used++;
    const hidden = this.layers.hiddenCount(scene.layerCounts);
    summary.textContent = hidden === 0
      ? `${used} レイヤ・すべて表示`
      : `${used} レイヤ中 ${hidden} を非表示`;
  }

  /**
   * いまの表示設定を描画に反映する。
   * 線のバッファは作り直さず、色番号ごとの表示色（パレット）だけを差し替える。
   * textNow が true なら文字もその場で描き直す（読み込み直後はこのあと全体表示で描くので不要）。
   */
  private applyDisplay(textNow = true): void {
    const s = this.display;
    this.renderer.setBackground(BACKGROUND_RGB[s.background]);
    this.overlay.background = s.background;
    document.body.dataset.bg = s.background;

    const scene = this.scene;
    if (scene) {
      const palette = buildPalette(scene.colors, scene.colorGroup, this.hiddenGroups, s);
      this.renderer.setPalette(palette);
      this.textLayer.setPalette(palette);
      // 隠した色・レイヤの図形には吸着させない
      const n = scene.colorGroup.length;
      const visible = new Uint8Array(n);
      for (let i = 0; i < n; i++) visible[i] = palette[i * 4 + 3] > 127 ? 1 : 0;
      this.colorVisible = visible;
      this.snapIndex?.setVisibleColors(visible);

      const mask = this.layers.mask();
      this.layerMask = mask;
      this.shapeCache = null;
      this.renderer.setLayerVisibility(mask);
      this.textLayer.setLayerVisibility(mask);
      this.snapIndex?.setVisibleLayers(mask);

      // 属性を見ていた図形が隠れたら、選択を外す
      if (this.selected >= 0 && !this.entityVisible(this.selected)) {
        this.selected = -1;
        this.updateInspect();
      }
      if (textNow) this.textLayer.render(this.view);
    }
    this.requestDraw();
  }

  private buildDisplayPanel(): void {
    for (const b of el('seg-bg').querySelectorAll<HTMLButtonElement>('button')) {
      const on = b.dataset.value === this.display.background;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    for (const b of el('seg-mono').querySelectorAll<HTMLButtonElement>('button')) {
      const on = (b.dataset.value === 'mono') === this.display.mono;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }

    const list = el('color-list');
    const scene = this.scene;
    if (!scene) {
      list.innerHTML = '<p class="sub">図面が読み込まれていません。</p>';
      return;
    }

    // 見本はいまの背景の上に、色分けしたときの線色で描く（単色表示中でもどの色か分かるように）
    const paper = BACKGROUND_RGB[this.display.background];
    const sample: DisplaySettings = { background: this.display.background, mono: false };
    const order = scene.groups
      .map((_, i) => i)
      .sort((a, b) => scene.groups[a].penColor - scene.groups[b].penColor);

    list.innerHTML = order.map((i) => {
      const g = scene.groups[i];
      const [r, gg, b] = displayColor(g.rgb[0], g.rgb[1], g.rgb[2], sample);
      const shown = !this.hiddenGroups.has(i);
      return `<button class="color-row${shown ? '' : ' off'}" data-group="${i}" aria-pressed="${shown}">` +
        `<span class="swatch" style="--paper: rgb(${paper.join(',')}); --ink: rgb(${r},${gg},${b})"></span>` +
        `<span class="color-name">${escapeHtml(g.label)}</span>` +
        `<span class="color-count">${g.count.toLocaleString()}</span>` +
        `<span class="switch" aria-hidden="true"></span>` +
        `</button>`;
    }).join('');

    const hidden = this.hiddenGroups.size;
    el('color-summary').textContent = hidden === 0
      ? `${scene.groups.length} 色`
      : `${scene.groups.length} 色中 ${hidden} 色を隠しています`;
  }

  private buildInfoPanel(): void {
    const body = el('info-body');
    const info = this.info;
    if (!info) {
      body.innerHTML = '<p class="sub">図面が読み込まれていません。</p>';
      return;
    }
    const c = info.counts;
    const paper = PAPER_NAMES[info.paperSize] || `#${info.paperSize}`;
    const rows: string[] = [
      `<dl class="kv">`,
      `<dt>ファイル</dt><dd>${escapeHtml(info.name)}</dd>`,
      `<dt>バージョン</dt><dd>Jw_cad ${(info.version / 100).toFixed(2)}</dd>`,
      `<dt>用紙</dt><dd>${paper}</dd>`,
      info.memo.trim() ? `<dt>メモ</dt><dd>${escapeHtml(info.memo.trim())}</dd>` : '',
      `<dt>図形</dt><dd>線 ${c.lines.toLocaleString()} ／ 円弧 ${c.arcs.toLocaleString()} ／ 文字 ${c.texts.toLocaleString()}</dd>`,
      `<dt></dt><dd>寸法 ${c.dims.toLocaleString()} ／ ソリッド ${c.solids.toLocaleString()} ／ 点 ${c.points.toLocaleString()}</dd>`,
      `<dt>読み込み</dt><dd>${Math.round(info.parseMs)} ms</dd>`,
      `</dl>`,
    ];
    if (info.warnings.length) {
      rows.push(`<p class="sub">${escapeHtml(info.warnings.join(' / '))}</p>`);
    }

    // 「自動」は区間ごとに点が乗った図形の縮尺で測る。グループを選ぶとすべての区間をその縮尺で測る
    rows.push('<div class="group-list"><div class="sub">計測に使う縮尺</div>');
    rows.push(
      `<div class="group-row pick${this.manualScale ? '' : ' active'}" data-auto="1">` +
      '<span>自動（点が乗った図形の縮尺）</span><span></span></div>',
    );
    for (const g of info.groups) {
      if (!g.used) continue;
      const active = this.manualScale && Math.abs(g.scale - this.measureScale) < 1e-9 ? ' active' : '';
      rows.push(
        `<div class="group-row pick${active}" data-scale="${g.scale}">` +
        `<span>グループ ${hex1(g.no)}${g.name ? ` ${escapeHtml(g.name)}` : ''}</span>` +
        `<span>1/${formatScale(g.scale)}</span></div>`,
      );
    }
    rows.push('</div>');
    body.innerHTML = rows.join('');

    for (const row of body.querySelectorAll<HTMLElement>('.group-row.pick')) {
      row.addEventListener('click', () => {
        if (row.dataset.auto) {
          this.manualScale = false;
          this.measureScale = this.points[0]?.scale ?? this.defaultScale;
        } else {
          this.measureScale = Number(row.dataset.scale);
          this.manualScale = true;
        }
        this.updateReadout();
        this.buildInfoPanel();
        this.requestDraw();
      });
    }
  }
}

/**
 * 図面に保存されているレイヤの状態の要約。
 * 同じ名前でも中身が変わった図面には、前に覚えたレイヤの表示を当てないために使う。
 */
function jwFingerprint(info: LoadedInfo): string {
  return JSON.stringify([
    info.writeGroup,
    info.groups.map((g) => [g.state, g.writeLayer, g.layers.map((l) => l.state)]),
  ]);
}

function formatScale(scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0) return '1';
  return Number.isInteger(scale) ? String(scale) : scale.toFixed(3).replace(/0+$/, '');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

const app = new App();

// 開発サーバーでのみ、検証スクリプトから内部状態を触れるようにする
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__jww = app;
}

// 開発中はキャッシュが邪魔になるだけなので、本番ビルドでのみ登録する
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js', { scope: './' });
  });
}
