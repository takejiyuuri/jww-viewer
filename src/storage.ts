import { DEFAULT_DISPLAY, type DisplaySettings } from './render/theme.ts';

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

/**
 * 最後に開いた図面で隠していた線色番号。
 * 同じ図面を開き直したときだけ戻し、別の図面では全部表示から始める。
 */
export function loadHiddenPens(name: string): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? 'null') as { name?: string; pens?: unknown } | null;
    if (v && v.name === name && Array.isArray(v.pens)) {
      return v.pens.filter((p): p is number => Number.isInteger(p));
    }
  } catch {
    // 壊れていたら無視する
  }
  return [];
}

export function saveHiddenPens(name: string, pens: number[]): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify({ name, pens }));
  } catch {
    // 保存できなくても表示には影響しない
  }
}
