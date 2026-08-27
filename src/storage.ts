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
