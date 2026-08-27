import { Renderer, type View } from './render/renderer.ts';
import { TextLayer } from './render/textlayer.ts';
import { Overlay, type MagnifierBox, type OverlayState } from './render/overlay.ts';
import type { Scene } from './render/geometry.ts';
import type { LoadResponse, LoadedInfo } from './jww/worker.ts';
import { SnapIndex, type Axis, type SnapResult } from './measure/snap.ts';
import {
  SNAP_LABEL, formatArea, formatLength, measureArea, measureLengths,
  type MeasurePoint,
} from './measure/measure.ts';
import { loadLast, saveLast } from './storage.ts';

type Mode = 'distance' | 'area';

/** ルーペの拡大率 */
const MAGNIFY = 5;

const PAPER_NAMES = ['A0', 'A1', 'A2', 'A3', 'A4', '', '', '', '2A', '3A', '4A', '5A', '10m', '50m', '100m'];

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
  private mode: Mode = 'distance';
  private measureScale = 1;
  private manualScale = false;

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

  constructor() {
    this.renderer = new Renderer(el<HTMLCanvasElement>('gl'));
    this.textLayer = new TextLayer(el<HTMLCanvasElement>('text'));
    this.overlay = new Overlay(el<HTMLCanvasElement>('overlay'));
    // 描画コンテキストが戻ったら描き直す
    this.renderer.onRestored = () => this.requestDraw(true);

    this.bindUI();
    this.bindGestures();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());

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
    this.snapIndex = new SnapIndex(scene);
    this.points = [];
    this.manualScale = false;

    // 図形が最も多いレイヤグループの縮尺を既定にする
    const tally = new Map<number, number>();
    for (let i = 0; i < scene.lineGroup.length; i++) {
      const g = scene.lineGroup[i];
      tally.set(g, (tally.get(g) ?? 0) + 1);
    }
    let bestGroup = info.writeGroup;
    let bestCount = -1;
    for (const [g, c] of tally) {
      if (c > bestCount) { bestCount = c; bestGroup = g; }
    }
    this.measureScale = scene.scales[bestGroup] || 1;

    el('title').textContent = info.name;
    this.updateScaleButton();
    this.updateReadout();
    this.buildInfoPanel();
    this.fit();
    this.hint(`${info.counts.lines.toLocaleString()} 本の線を ${Math.round(info.parseMs)}ms で読み込みました`);
  }

  // ---------- ビュー ----------

  private fit(): void {
    if (!this.scene) return;
    const b = this.scene.fitBounds;
    const w = this.cssW * this.dpr;
    const h = this.cssH * this.dpr;
    const bw = Math.max(b.maxX - b.minX, 1e-6);
    const bh = Math.max(b.maxY - b.minY, 1e-6);
    const zoom = Math.min(w / bw, h / bh) * 0.94;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
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
          this.textLayer.render(this.view, null);
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

    if (this.magnifier && this.preview) {
      const m = this.magnifier;
      const k = this.dpr;
      const size = m.size * k;
      const glY = this.cssH * k - (m.y + m.size) * k;
      const zoom = this.view.zoom * MAGNIFY;
      this.renderer.drawInset(
        { cx: this.preview.x, cy: this.preview.y, zoom },
        Math.round(m.x * k), Math.round(glY), Math.round(size), Math.round(size),
        this.dpr,
      );
    }

    this.textLayer.syncTransform(this.view);
    this.clipTextForMagnifier();

    const state: OverlayState = {
      points: this.points,
      constraint: this.holding ? this.constraint : null,
      activeIndex: this.dragIndex,
      preview: this.preview,
      cursor: this.cursor,
      magnifier: this.magnifier,
      scale: this.measureScale,
      closed: this.mode === 'area' && this.points.length >= 3,
    };
    this.overlay.render(this.view, state);
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
      const grabbed = this.hitPoint(e.clientX, e.clientY);
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
      this.cancelHold();
      if (hit) {
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
      const hit = this.snapFor(e.clientX, e.clientY, null);
      if (hit) this.addPoint(hit);
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
    if (navigator.vibrate) navigator.vibrate(8);
    // 切り抜き位置と文字の位置を合わせるため、ここで transform を畳んでおく
    this.textLayer.render(this.view, null);
    this.updateHold(cssX, cssY);
    this.requestDraw();
  }

  private updateHold(cssX: number, cssY: number): void {
    this.cursor = { x: cssX, y: cssY };
    this.preview = this.snapFor(cssX, cssY, this.dragIndex, 26);
    this.magnifier = this.placeMagnifier(cssX, cssY);
  }

  /**
   * 拡大鏡は「指で隠れている場所」を見せるためのものなので、
   * 指と重ならない位置に必ず置く。横向きなど画面が低いときは指の左右に逃がす。
   */
  private placeMagnifier(cssX: number, cssY: number): MagnifierBox {
    const size = Math.round(Math.max(120, Math.min(168, Math.min(this.cssW, this.cssH) * 0.42)));
    const margin = 12;
    const topLimit = 52;     // 上部のバー
    const bottomLimit = 104; // 下部のツールバー
    const gap = 28;          // 指との間隔

    const clampX = (v: number): number =>
      Math.max(margin, Math.min(this.cssW - size - margin, v));
    const clampY = (v: number): number =>
      Math.max(topLimit, Math.min(this.cssH - bottomLimit - size, v));

    const roomAbove = cssY - gap - topLimit;
    const roomBelow = this.cssH - bottomLimit - (cssY + gap);

    if (roomAbove >= size) {
      return { x: clampX(cssX - size / 2), y: cssY - gap - size, size };
    }
    if (roomBelow >= size) {
      return { x: clampX(cssX - size / 2), y: cssY + gap, size };
    }

    // 縦に逃がせないので左右へ。指から遠い側に置く
    const y = clampY(cssY - size / 2);
    const left = cssX - gap - size;
    const right = cssX + gap;
    let x = cssX > this.cssW / 2 ? left : right;
    if (x < margin || x + size > this.cssW - margin) {
      x = cssX > this.cssW / 2 ? margin : this.cssW - size - margin;
    }
    return { x, y, size };
  }

  private cancelHold(): void {
    clearTimeout(this.holdTimer);
    this.holding = false;
    this.preview = null;
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
  private snapFor(cssX: number, cssY: number, index: number | null, radiusCssPx = 22): SnapResult | null {
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
      this.updateScaleButton();
    }
    this.points.push(p);
    this.updateReadout();
    if (navigator.vibrate) navigator.vibrate(4);
  }

  private updateReadout(): void {
    const box = el('readout');
    const value = el('readout-value');
    const sub = el('readout-sub');
    const detail = el('readout-detail');

    if (this.points.length === 0) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');

    const m = measureLengths(this.points, this.measureScale);
    const segs = m.segments;
    const total = m.total;
    const warn = m.mixed ? '　※縮尺の違う図をまたいでいます' : '';

    if (this.mode === 'area') {
      const a = measureArea(this.points, this.measureScale);
      const first = this.points[0];
      const last = this.points[this.points.length - 1];
      const closing = measureLengths([last, first], this.measureScale).total;
      value.textContent = this.points.length >= 3 ? formatArea(a.area) : '—';
      sub.textContent = `${this.points.length} 点`;
      detail.textContent = this.points.length >= 3
        ? `周長 ${formatLength(total + closing)}${a.mixed ? '　※縮尺の違う図をまたいでいます' : ''}`
        : '3 点以上をタップしてください';
      return;
    }

    if (this.points.length === 1) {
      value.textContent = '—';
      sub.textContent = SNAP_LABEL[this.points[0].kind];
      detail.textContent = '2 点目をタップしてください';
      return;
    }

    const shown = this.points[1].scale ?? this.points[0].scale ?? this.measureScale;
    value.textContent = formatLength(segs[segs.length - 1]);
    sub.textContent = `1/${formatScale(m.mixed ? this.measureScale : shown)}`;

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
    detail.textContent = text + warn;
  }

  private updateScaleButton(): void {
    el('btn-scale').textContent = `1/${formatScale(this.measureScale)}`;
  }

  private hint(text: string): void {
    const node = el('hint');
    node.textContent = text;
    node.classList.remove('hidden');
    node.style.opacity = '1';
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => {
      node.style.opacity = '0';
      window.setTimeout(() => node.classList.add('hidden'), 260);
    }, 2600);
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

    el('btn-mode').addEventListener('click', () => {
      this.mode = this.mode === 'distance' ? 'area' : 'distance';
      const btn = el('btn-mode');
      btn.textContent = this.mode === 'distance' ? '距離' : '面積';
      btn.classList.toggle('on', this.mode === 'area');
      this.updateReadout();
      this.requestDraw();
    });

    el('btn-ortho').addEventListener('click', () => {
      this.ortho = !this.ortho;
      el('btn-ortho').classList.toggle('on', this.ortho);
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
      el('info-panel').classList.remove('hidden');
      this.buildInfoPanel();
    });

    el('btn-info').addEventListener('click', () => {
      el('info-panel').classList.toggle('hidden');
      this.buildInfoPanel();
    });
    el('btn-info-close').addEventListener('click', () => el('info-panel').classList.add('hidden'));

    // デスクトップでの動作確認用
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) f.arrayBuffer().then((buf) => this.load(buf, f.name)).catch(() => this.fail('ファイルを読み取れませんでした'));
    });
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

    rows.push('<div class="group-list"><div class="sub">計測に使う縮尺（レイヤグループ）</div>');
    for (const g of info.groups) {
      if (!g.used) continue;
      const active = Math.abs(g.scale - this.measureScale) < 1e-9 ? ' active' : '';
      rows.push(
        `<div class="group-row pick${active}" data-scale="${g.scale}">` +
        `<span>グループ ${g.no}${g.name ? ` ${escapeHtml(g.name)}` : ''}</span>` +
        `<span>1/${formatScale(g.scale)}</span></div>`,
      );
    }
    rows.push('</div>');
    body.innerHTML = rows.join('');

    for (const row of body.querySelectorAll<HTMLElement>('.group-row.pick')) {
      row.addEventListener('click', () => {
        this.measureScale = Number(row.dataset.scale);
        this.manualScale = true;
        this.updateScaleButton();
        this.updateReadout();
        this.buildInfoPanel();
        this.requestDraw();
      });
    }
  }
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
