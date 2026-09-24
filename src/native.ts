import { Capacitor } from '@capacitor/core';

/**
 * iOS アプリ（Capacitor）のときだけ使う処理。Web 版では何もしない。
 * プラグインは iOS のときだけ読み込み、Web 版の読み込みを重くしない。
 */

/** iOS アプリとして動いているか */
export const isNative = Capacitor.isNativePlatform();

/** 受け取った図面を開く側 */
export interface OpenHandlers {
  open: (buffer: ArrayBuffer, name: string) => void;
  fail: (message: string) => void;
}

/** 受け取った図面を読む方法（テストで差し替えられるように分けておく） */
export interface IncomingReader {
  read: (url: string) => Promise<ArrayBuffer>;
  /** 読み終えた写しを消す（アプリの中の Inbox に写されたもの） */
  remove: (url: string) => Promise<void>;
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

/**
 * 「ファイル」アプリや共有メニューから渡された URL を受け取る口を作る。
 * 起動時の URL（getLaunchUrl）と、動いている間に届く URL（appUrlOpen）で同じものが二度来ても、一度だけ開く。
 * 開いたら true
 */
export function incomingHandler(reader: IncomingReader, h: OpenHandlers): (url: string | undefined) => Promise<boolean> {
  const seen = new Set<string>();
  return async (url) => {
    if (!url || !/^file:/i.test(url) || seen.has(url)) return false;
    seen.add(url);
    let buffer: ArrayBuffer;
    try {
      buffer = await reader.read(url);
    } catch {
      h.fail('ファイルを読み取れませんでした');
      return false;
    }
    h.open(buffer, fileNameOf(url));
    // 最近の図面としてはアプリの中に取っておくので、渡されたときの写しは消してよい
    if (/\/Inbox\//.test(url)) reader.remove(url).catch(() => {});
    return true;
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

/**
 * iOS アプリで、「ファイル」アプリや共有メニューから渡された .jww を開けるようにする。
 * 起動したときに渡された図面があれば開いて true を返す（そのときは前回の図面を出し直さない）
 */
export async function listenForFiles(h: OpenHandlers): Promise<boolean> {
  if (!isNative) return false;
  const { App } = await import('@capacitor/app');
  const handle = incomingHandler({ read: readFileUrl, remove: removeFileUrl }, h);
  await App.addListener('appUrlOpen', (e) => {
    void handle(e.url);
  });
  const launch = await App.getLaunchUrl().catch(() => undefined);
  return handle(launch?.url);
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
