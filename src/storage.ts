import { DEFAULT_DISPLAY, type DisplaySettings } from './render/theme.ts';
import { DEFAULT_MEASURE_COLOR, MEASURE_COLORS } from './measure/colors.ts';
import { MEASURE_MODES, type MeasureMode } from './measure/measure.ts';

/** 直近に開いた図面を IndexedDB に置いておき、次に開いたときすぐ表示する */

const DB_NAME = 'jww-viewer';
const STORE = 'last';
const KEY = 'file';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface StoredFile {
  name: string;
  buffer: ArrayBuffer;
  savedAt: number;
}

export async function saveLast(name: string, buffer: ArrayBuffer): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ name, buffer, savedAt: Date.now() } satisfies StoredFile, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadLast(): Promise<StoredFile | null> {
  const db = await open();
  const result = await new Promise<StoredFile | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve((req.result as StoredFile | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

// ---------- 表示設定 ----------
// 端末ごとの好みなので localStorage に置く。使えない環境（プライベートブラウズ等）でも
// 画面が壊れないよう、読み書きの失敗は既定値で受け流す。

const DISPLAY_KEY = 'jww-viewer:display';
const HIDDEN_KEY = 'jww-viewer:hidden';

export function loadDisplay(): DisplaySettings {
  try {
    const raw = localStorage.getItem(DISPLAY_KEY);
    if (!raw) return { ...DEFAULT_DISPLAY };
    const v = JSON.parse(raw) as Partial<DisplaySettings>;
    return {
      background: v.background === 'light' ? 'light' : 'dark',
      mono: v.mono === true,
    };
  } catch {
    return { ...DEFAULT_DISPLAY };
  }
}

export function saveDisplay(d: DisplaySettings): void {
  try {
    localStorage.setItem(DISPLAY_KEY, JSON.stringify(d));
  } catch {
    // 保存できなくても表示には影響しない
  }
}

/** 計測の好み（色・種類・体積の高さ）。端末ごとに次回も使う */
export interface MeasurePrefs {
  color: string;
  mode: MeasureMode;
  /** 体積で面積に掛ける高さ（実寸 mm） */
  height: number;
}

const MEASURE_KEY = 'jww-viewer:measure';
export const DEFAULT_HEIGHT = 1000;

export function loadMeasurePrefs(): MeasurePrefs {
  const prefs: MeasurePrefs = { color: DEFAULT_MEASURE_COLOR, mode: 'length', height: DEFAULT_HEIGHT };
  try {
    const v = JSON.parse(localStorage.getItem(MEASURE_KEY) ?? 'null') as Partial<MeasurePrefs> | null;
    if (!v) return prefs;
    if (MEASURE_COLORS.some((c) => c.id === v.color)) prefs.color = v.color as string;
    if (MEASURE_MODES.includes(v.mode as MeasureMode)) prefs.mode = v.mode as MeasureMode;
    if (typeof v.height === 'number' && Number.isFinite(v.height) && v.height > 0) prefs.height = v.height;
  } catch {
    // 読めなければ既定のまま
  }
  return prefs;
}

export function saveMeasurePrefs(p: MeasurePrefs): void {
  try {
    localStorage.setItem(MEASURE_KEY, JSON.stringify(p));
  } catch {
    // 保存できなくても計測には影響しない
  }
}

/** 図面ごとに覚えておく表示の状態 */
export interface ViewState {
  /** 隠している線色番号 */
  pens: number[];
  /**
   * 隠しているレイヤグループ（0〜15）とレイヤ（0〜255）。
   * null のときは記録がないので、Jw_cad で保存したときの状態から始める。
   */
  groups: number[] | null;
  layers: number[] | null;
  /**
   * 記録したときの、図面に保存されていたレイヤの状態の要約。
   * 図面の側が変わっていたら（同じ名前の別の図面など）、レイヤの記録は当てない
   */
  jw: string | null;
  /** 反転で覚えておいた設定（グループ番号、その中で隠していたレイヤ 0〜15、グループのスイッチが入っていたら 1） */
  stash: Array<[number, number[], number?]> | null;
}

const EMPTY_VIEW: ViewState = { pens: [], groups: null, layers: null, jw: null, stash: null };

function stashList(v: unknown): Array<[number, number[], number?]> | null {
  if (!Array.isArray(v)) return null;
  const out: Array<[number, number[], number?]> = [];
  for (const e of v) {
    if (!Array.isArray(e) || e.length < 2 || e.length > 3) continue;
    const [g, off, on] = e as unknown[];
    const list = intList(off, 16);
    if (!(Number.isInteger(g) && (g as number) >= 0 && (g as number) < 16 && list)) continue;
    out.push(on === 1 ? [g as number, list, 1] : [g as number, list]);
  }
  return out;
}

function intList(v: unknown, max: number): number[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((p): p is number => Number.isInteger(p) && p >= 0 && p < max);
}

/**
 * 最後に開いた図面の表示状態。
 * 同じ図面を開き直したときだけ戻し、別の図面では最初から（色は全部、レイヤは Jw_cad の状態）。
 * 色だけを覚えていた以前の形式もそのまま読める。
 */
export function loadViewState(name: string): ViewState {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? 'null') as Record<string, unknown> | null;
    if (!v || v.name !== name) return { ...EMPTY_VIEW };
    return {
      pens: intList(v.pens, 1 << 16) ?? [],
      groups: intList(v.groups, 16),
      layers: intList(v.layers, 256),
      jw: typeof v.jw === 'string' ? v.jw : null,
      stash: stashList(v.stash),
    };
  } catch {
    return { ...EMPTY_VIEW };
  }
}

export function saveViewState(name: string, state: ViewState): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify({ name, ...state }));
  } catch {
    // 保存できなくても表示には影響しない
  }
}
