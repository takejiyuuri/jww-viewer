import { DEFAULT_DISPLAY, type DisplaySettings } from './render/theme.ts';
import { DEFAULT_MEASURE_COLOR, MEASURE_COLORS } from './measure/colors.ts';
import { MEASURE_MODES, type MeasureMode } from './measure/measure.ts';

/**
 * 直近に開いた図面を IndexedDB に置いておき、次に開いたときすぐ表示する。
 * あわせて、最近開いた図面をいくつか取っておき、一覧から開き直せるようにする
 */

const DB_NAME = 'jww-viewer';
/** 直近に開いた図面（次に起動したとき出し直す）。KEY の 1 件だけ */
const STORE = 'last';
const KEY = 'file';
/** 最近開いた図面の名前・大きさ・日時（一覧を出すたびに中身まで読まないよう、中身とは分けて置く） */
const RECENT_META = 'recent-meta';
/** 最近開いた図面の中身。recentKey の鍵で RECENT_META と対にする（名前だけを鍵にしていたころのものは名前が鍵） */
const RECENT_DATA = 'recent-data';
/** 最近開いた図面を取っておく数 */
export const RECENT_MAX = 10;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // 版 2 で最近開いた図面の置き場を足した（版 1 の直近の図面はそのまま残る）
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [STORE, RECENT_META, RECENT_DATA]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 新しい版のページが版を上げようとしたら、待たせないようにすぐ閉じる
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

export interface StoredFile {
  name: string;
  buffer: ArrayBuffer;
  savedAt: number;
  /** 最近の一覧での鍵（recentKey）。これを入れる前に保存したものには無い */
  key?: string;
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

// ---------- 最近開いた図面 ----------

export interface RecentFile {
  /** 一覧での鍵（recentKey）。開く・外すときはこれで指す */
  key: string;
  name: string;
  /** バイト数 */
  size: number;
  /** 最後に開いた日時（ミリ秒） */
  openedAt: number;
}

/** FNV-1a（32 ビット）。取り違えを見分けるための短い指紋で、暗号には使わない */
export function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}

/**
 * 最近の一覧での鍵。別の現場の同じ名前の図面を黙って入れ替えないよう、名前に大きさと中身の指紋を足す。
 * 同じ図面を開き直したときは同じ鍵になるので、一覧では 1 件のまま先頭に来る
 */
export function recentKey(name: string, buffer: ArrayBuffer): string {
  return `${name}#${buffer.byteLength}-${fnv1a(new Uint8Array(buffer)).toString(16).padStart(8, '0')}`;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    // 要求の失敗（容量不足など）は取り消しより先に届き、そのときは tx.error がまだ空のことがあるので、要求の側のものを渡す
    tx.onerror = (ev) => reject((ev.target as IDBRequest | null)?.error ?? tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('保存を取り消しました', 'AbortError'));
  });
}

/**
 * 書き込みを一つのトランザクションで行い、fn の結果を返す。
 * 途中で失敗したら全体を取り消し、取り消しの元になった理由（容量不足など）を投げる
 */
async function write<T>(stores: string[], fn: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await open();
  try {
    const tx = db.transaction(stores, 'readwrite');
    const finished = done(tx);
    // 失敗は下で受け取る（受け取るまでのあいだに、受け手のない失敗として報告されないように）
    finished.catch(() => {});
    let result: T;
    try {
      result = await fn(tx);
    } catch (e) {
      try {
        tx.abort();
      } catch {
        // もう取り消されている
      }
      const reason = await finished.then(() => null, (r: unknown) => r);
      throw reason instanceof DOMException && reason.name !== 'AbortError' ? reason : e;
    }
    await finished;
    return result;
  } finally {
    db.close();
  }
}

function get<T>(store: IDBObjectStore, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function allMeta(store: IDBObjectStore): Promise<RecentFile[]> {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as Array<Partial<RecentFile> | null>)
      .filter((r): r is Partial<RecentFile> & { name: string } => !!r && typeof r.name === 'string')
      // 名前だけを鍵にしていたころのものは、名前を鍵とみなす
      .map((r) => ({ ...r, key: typeof r.key === 'string' ? r.key : r.name }) as RecentFile));
    req.onerror = () => reject(req.error);
  });
}

/** 新しい順に並べて、RECENT_MAX を超えた古いものを消す */
function trim(meta: IDBObjectStore, data: IDBObjectStore, list: RecentFile[]): void {
  list.sort((a, b) => b.openedAt - a.openedAt);
  for (const old of list.slice(RECENT_MAX)) {
    meta.delete(old.key);
    data.delete(old.key);
  }
}

function isQuota(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'QuotaExceededError';
}

/** 最近開いた図面として取っておく。last なら、次に起動したとき出し直す図面にもする */
async function putFile(name: string, buffer: ArrayBuffer, key: string, last: boolean): Promise<void> {
  const openedAt = Date.now();
  await write(last ? [STORE, RECENT_META, RECENT_DATA] : [RECENT_META, RECENT_DATA], async (tx) => {
    if (last) tx.objectStore(STORE).put({ name, buffer, savedAt: openedAt, key } satisfies StoredFile, KEY);
    const meta = tx.objectStore(RECENT_META);
    const data = tx.objectStore(RECENT_DATA);
    meta.put({ key, name, size: buffer.byteLength, openedAt } satisfies RecentFile, key);
    data.put(buffer, key);
    let list = await allMeta(meta);
    // 名前だけを鍵にしていたころに取っておいた同じ図面は、入れ替える（中身が違えば別の図面として残す）
    const legacy = list.find((r) => r.key === name && r.size === buffer.byteLength);
    if (legacy) {
      const old = await get<unknown>(data, name);
      if (old instanceof ArrayBuffer && recentKey(name, old) === key) {
        meta.delete(name);
        data.delete(name);
        list = list.filter((r) => r !== legacy);
      }
    }
    trim(meta, data, list);
  });
}

/** 容量を空けるため、最近の一覧のいちばん古いもの（keep 以外）を外す。外した中身の大きさを返す。外せるものがなければ null */
async function dropOldest(keep: string): Promise<number | null> {
  return write([RECENT_META, RECENT_DATA], async (tx) => {
    const meta = tx.objectStore(RECENT_META);
    const list = (await allMeta(meta)).filter((r) => r.key !== keep).sort((a, b) => a.openedAt - b.openedAt);
    const old = list[0];
    if (!old) return null;
    meta.delete(old.key);
    tx.objectStore(RECENT_DATA).delete(old.key);
    return old.size;
  });
}

/**
 * 開けた図面を取っておく。次に起動したとき出し直す図面にし、最近の一覧の先頭にも入れる（同じ図面なら入れ替える）。
 * 容量が足りないときは、一覧の古いものから外して空け、やり直す。外した数を返す。それでも入らなければ投げる
 */
export async function saveOpened(name: string, buffer: ArrayBuffer, key = recentKey(name, buffer)): Promise<number> {
  // 別の図面（か、外したあとに開き直した同じ図面）を表示したので、表示の状態をまた記録する
  forgottenView = null;
  let freed = 0;
  let dropped = 0;
  for (;;) {
    try {
      await putFile(name, buffer, key, true);
      return dropped;
    } catch (e) {
      // 図面 2 つ分（直近の図面と一覧の中身）を空けても入らないなら、足りないのはほかの理由なので、それ以上は外さない
      if (!isQuota(e) || freed >= 2 * buffer.byteLength) throw e;
      const size = await dropOldest(key);
      if (size === null) throw e;
      freed += size;
      dropped++;
    }
  }
}

/** 図面を最近開いたものとして取っておく（次に起動したとき出し直す図面は変えない）。同じ図面なら入れ替えて先頭へ */
export async function saveRecent(name: string, buffer: ArrayBuffer): Promise<void> {
  await putFile(name, buffer, recentKey(name, buffer), false);
}

/** 最近開いた図面（新しい順） */
export async function listRecent(): Promise<RecentFile[]> {
  const db = await open();
  try {
    const tx = db.transaction(RECENT_META, 'readonly');
    const list = await allMeta(tx.objectStore(RECENT_META));
    return list.sort((a, b) => b.openedAt - a.openedAt);
  } finally {
    db.close();
  }
}

/** 最近開いた図面の中身（鍵は RecentFile.key）。無ければ null */
export async function loadRecent(key: string): Promise<ArrayBuffer | null> {
  const db = await open();
  try {
    const tx = db.transaction(RECENT_DATA, 'readonly');
    return await new Promise<ArrayBuffer | null>((resolve, reject) => {
      const req = tx.objectStore(RECENT_DATA).get(key);
      req.onsuccess = () => resolve(req.result instanceof ArrayBuffer ? req.result : null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** 一覧から外した図面を元に戻すための控え */
export interface RemovedRecent {
  meta: RecentFile;
  buffer: ArrayBuffer;
  /** 次に起動したとき出し直す図面でもあったら、その記録 */
  last: StoredFile | null;
  /** 消した表示の状態の記録（localStorage の中身そのまま） */
  view: string | null;
}

/**
 * 最近開いた図面の一覧から外し、端末に取っておいた中身も消す。
 * 次に起動したとき出し直す図面も同じ図面なら、それと表示の状態の記録も消す（外した図面が端末に残らないように）。
 * 元に戻すための控えを返す（中身がもう無かったときは null）
 */
export async function removeRecent(key: string): Promise<RemovedRecent | null> {
  const removed = await write([STORE, RECENT_META, RECENT_DATA], async (tx): Promise<RemovedRecent | null> => {
    const metaStore = tx.objectStore(RECENT_META);
    const dataStore = tx.objectStore(RECENT_DATA);
    const lastStore = tx.objectStore(STORE);
    const [meta, buffer, last] = await Promise.all([
      get<Partial<RecentFile>>(metaStore, key), get<unknown>(dataStore, key), get<StoredFile>(lastStore, KEY),
    ]);
    metaStore.delete(key);
    dataStore.delete(key);
    if (!meta || typeof meta.name !== 'string' || !(buffer instanceof ArrayBuffer)) return null;
    // 名前だけを鍵にしていたころのものや、鍵を持たない直近の図面は、中身から鍵を作って比べる
    const content = key === meta.name ? recentKey(meta.name, buffer) : key;
    const lastKey = last && last.buffer instanceof ArrayBuffer ? (last.key ?? recentKey(last.name, last.buffer)) : null;
    const same = lastKey === content;
    if (same) lastStore.delete(KEY);
    return { meta: { ...meta, key } as RecentFile, buffer, last: same ? last ?? null : null, view: null };
  });
  if (removed?.last) removed.view = forgetView(removed.meta.name);
  return removed;
}

/** removeRecent で外した図面を元に戻す */
export async function restoreRecent(r: RemovedRecent): Promise<void> {
  await write([STORE, RECENT_META, RECENT_DATA], async (tx) => {
    const meta = tx.objectStore(RECENT_META);
    const data = tx.objectStore(RECENT_DATA);
    const lastStore = tx.objectStore(STORE);
    meta.put(r.meta, r.meta.key);
    data.put(r.buffer, r.meta.key);
    // 次に起動したとき出し直す図面は、外したあとにほかの図面を開いていなければ戻す
    if (r.last && !(await get(lastStore, KEY))) lastStore.put(r.last, KEY);
    trim(meta, data, await allMeta(meta));
  });
  if (!r.last) return;
  if (forgottenView === r.meta.name) forgottenView = null;
  try {
    if (r.view && localStorage.getItem(HIDDEN_KEY) === null) localStorage.setItem(HIDDEN_KEY, r.view);
  } catch {
    // 表示の状態が戻らなくても、図面は戻る
  }
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

/**
 * 一覧から外した直近の図面の名前。表示し続けていても、その図面の表示の状態は記録しない
 * （外した図面の名前が端末に残らないように）。ほかの図面を開いて保存したら戻す
 */
let forgottenView: string | null = null;

/** 表示の状態の記録が name の図面のものなら消し、この後も記録しないようにする。消した記録を返す */
function forgetView(name: string): string | null {
  forgottenView = name;
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (!raw || (JSON.parse(raw) as { name?: unknown } | null)?.name !== name) return null;
    localStorage.removeItem(HIDDEN_KEY);
    return raw;
  } catch {
    return null;
  }
}

export function saveViewState(name: string, state: ViewState): void {
  if (name === forgottenView) return;
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify({ name, ...state }));
  } catch {
    // 保存できなくても表示には影響しない
  }
}
