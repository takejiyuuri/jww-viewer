import { Capacitor } from '@capacitor/core';
import { fnv1a } from './storage.ts';

/**
 * iOS アプリ（Capacitor）のときだけ使う処理。Web 版では何もしない。
 * プラグインは iOS のときだけ読み込み、Web 版の読み込みを重くしない。
 */

/** iOS アプリとして動いているか */
export const isNative = Capacitor.isNativePlatform();

/** 受け取った図面を開く側 */
export interface OpenHandlers {
  /** 図面を受け取った（これから読む）。読み終わるまで待たせるあいだの知らせに使う */
  receiving?: (name: string) => void;
  /**
   * 図面を開く。読み込みと端末への保存が済むと（失敗・中止でも）決着する Promise を返せば、
   * 渡されたときの写しはそれまで消さない（途中でアプリが落とされても、写しから開き直せるように）
   */
  open: (buffer: ArrayBuffer, name: string) => void | Promise<unknown>;
  fail: (message: string) => void;
}

/** 受け取った図面を読む方法（テストで差し替えられるように分けておく） */
export interface IncomingReader {
  read: (url: string) => Promise<ArrayBuffer>;
  /** 読み終えた写しを消す（アプリの中の Inbox に写されたもの） */
  remove: (url: string) => Promise<void>;
  /** 写しを見分ける印（作られた日時・更新日時・大きさ）。写しが無ければ null。省くと調べない */
  stamp?: (url: string) => Promise<string | null>;
}

/**
 * iOS がアプリの中に作った、受け渡し用の写しか。メールなどからは Documents/Inbox/、
 * 「ファイル」アプリからは tmp/<Bundle ID>-Inbox/ に写されると報告されている。
 * このアプリはその場で開く設定にしていない（LSSupportsOpeningDocumentsInPlace が false）ので、どちらも元のファイルではない
 */
export function isInboxCopy(url: string): boolean {
  return /\/(?:Inbox|tmp\/[^/]+-Inbox)\//i.test(url.split(/[?#]/)[0]);
}

/** 片付けまで済んだ受け渡しの記録。ファイルの名前が端末に残らないよう、URL は指紋にして置く */
const HANDLED_KEY = 'jww-viewer:received';

function handledId(url: string, stamp: string | null | undefined): string {
  return `${fnv1a(new TextEncoder().encode(url)).toString(16)}:${stamp ?? ''}`;
}

function wasHandled(url: string, stamp: string | null | undefined): boolean {
  try {
    return localStorage.getItem(HANDLED_KEY) === handledId(url, stamp);
  } catch {
    return false;
  }
}

function markHandled(url: string, stamp: string | null | undefined): void {
  try {
    localStorage.setItem(HANDLED_KEY, handledId(url, stamp));
  } catch {
    // 残せなくても、写しを消していれば開き直さない（写しが無いことで分かる）
  }
}

/** ファイルの URL（file:///…/Inbox/%E5%9B%B3.jww）から、画面に出す名前（図.jww）を取り出す */
export function fileNameOf(url: string): string {
  const last = url.split(/[?#]/)[0].replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/').filter(Boolean).pop() ?? '';
  try {
    return decodeURIComponent(last) || '図面.jww';
  } catch {
    return last || '図面.jww';
  }
}

/** 同じ URL が続けて届いたとき、同じ受け渡しとみなす間（ミリ秒） */
const DUPLICATE_MS = 5000;

/**
 * 「ファイル」アプリや共有メニューから渡された URL を受け取る口を作る。開いたら true。
 * 起動したときは、同じ URL が起動時の URL（getLaunchUrl）と動いている間の URL（appUrlOpen）の両方からほぼ同時に届くので、
 * 一度だけ開き、どちらにも同じ結果を返す。少し経ってから同じ URL が届いたときは（同じ名前の図面をまた渡されると、
 * iOS は消した写しと同じ場所に写す）、新しく渡されたものとして開き直す。
 * 起動時の URL（atLaunch）は、最後に渡された URL がアプリの動いている間ずっと返り、WebView が読み直されたときにもまた届く。
 * 写しがもう無いか、片付けまで済んだ写しなら開き直さずに false を返す（前回の図面を出し直す）
 */
export function incomingHandler(
  reader: IncomingReader,
  h: OpenHandlers,
  now: () => number = Date.now,
): (url: string | undefined, atLaunch?: boolean) => Promise<boolean> {
  const recent = new Map<string, { at: number; result: Promise<boolean> }>();
  return (url, atLaunch = false) => {
    if (!url || !/^file:/i.test(url)) return Promise.resolve(false);
    const t = now();
    const prev = recent.get(url);
    if (prev && t - prev.at < DUPLICATE_MS) return prev.result;
    const result = (async () => {
      const stamp = reader.stamp ? await reader.stamp(url).catch(() => undefined) : undefined;
      if (atLaunch && (stamp === null || (stamp !== undefined && wasHandled(url, stamp)))) return false;
      h.receiving?.(fileNameOf(url));
      let buffer: ArrayBuffer;
      try {
        buffer = await reader.read(url);
      } catch {
        markHandled(url, stamp);
        h.fail('ファイルを読み取れませんでした');
        return false;
      }
      // 最近の図面としてはアプリの中に取っておくので、渡されたときの写しは消してよい。
      // ただし消すのは、読み込みと保存が済んでから（途中でアプリが落とされたら、読み直したあと写しから開き直す）
      Promise.resolve(h.open(buffer, fileNameOf(url)))
        .catch(() => {})
        .then(() => {
          markHandled(url, stamp);
          if (isInboxCopy(url)) return reader.remove(url);
        })
        .catch(() => {});
      return true;
    })();
    recent.set(url, { at: t, result });
    return result;
  };
}

/** 端末の中のファイルを読む。WebView から直接読める道を使い、だめなら Filesystem プラグインで読む */
async function readFileUrl(url: string): Promise<ArrayBuffer> {
  try {
    const res = await fetch(Capacitor.convertFileSrc(url));
    if (res.ok) return await res.arrayBuffer();
  } catch {
    // 下の方法で読む
  }
  const { Filesystem } = await import('@capacitor/filesystem');
  const { data } = await Filesystem.readFile({ path: url });
  if (typeof data !== 'string') return await data.arrayBuffer();
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function removeFileUrl(url: string): Promise<void> {
  const { Filesystem } = await import('@capacitor/filesystem');
  await Filesystem.deleteFile({ path: url });
}

/** 写しの作られた日時・更新日時・大きさ。同じ名前でまた渡されると、同じ場所でも別の写しとして見分けられる。無ければ null */
async function stampFileUrl(url: string): Promise<string | null> {
  const { Filesystem } = await import('@capacitor/filesystem');
  try {
    const s = await Filesystem.stat({ path: url });
    return `${s.ctime ?? ''}:${s.mtime}:${s.size}`;
  } catch {
    return null;
  }
}

/**
 * iOS アプリで、「ファイル」アプリや共有メニューから渡された .jww を開けるようにする。
 * 起動したときに渡された図面があれば開いて true を返す（そのときは前回の図面を出し直さない）
 */
export async function listenForFiles(h: OpenHandlers): Promise<boolean> {
  if (!isNative) return false;
  const { App } = await import('@capacitor/app');
  const handle = incomingHandler({ read: readFileUrl, remove: removeFileUrl, stamp: stampFileUrl }, h);
  await App.addListener('appUrlOpen', (e) => {
    void handle(e.url);
  });
  const launch = await App.getLaunchUrl().catch(() => undefined);
  return handle(launch?.url, true);
}

/** 点を置いた・図形を選んだときの、軽い手応え（iOS アプリだけ） */
export function tapFeedback(): void {
  if (!isNative) return;
  import('@capacitor/haptics')
    .then(({ Haptics, ImpactStyle }) => Haptics.impact({ style: ImpactStyle.Light }))
    .catch(() => {});
}

/** ステータスバーの文字の色を、図面の背景に合わせる（黒い背景なら白、白い背景なら黒） */
export function statusBarFor(background: 'dark' | 'light'): void {
  if (!isNative) return;
  import('@capacitor/status-bar')
    .then(({ StatusBar, Style }) => StatusBar.setStyle({ style: background === 'light' ? Style.Light : Style.Dark }))
    .catch(() => {});
}
