// Service Worker のひな型。版番号と取り込み一覧はビルド時に埋め込まれる。
// 目的は「一度開いたら、電波の入らない現場でもそのまま使えること」。
const VERSION = '__VERSION__';
const CACHE = `jww-viewer-${VERSION}`;
const PRECACHE = __PRECACHE__;
// 配信側が Vary: Accept-Encoding を返すと、取り込んだ内容と参照時の条件が食い違って
// キャッシュに当たらなくなる。同一 URL なら同じものとして扱う。
const MATCH = { ignoreVary: true };

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // ブラウザのキャッシュを経由せず、配信元から取り直したものを入れる
      .then((cache) => cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // ページ遷移だけは新しい内容を優先し、つながらなければキャッシュを返す
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // 502 や 404 をそのまま保存すると、次にオフラインになったとき
          // エラーページが「キャッシュ済みの本体」として返ってしまう
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req, MATCH).then((hit) => hit || caches.match('./index.html', MATCH)))
    );
    return;
  }

  // ハッシュ付きの資産は中身が変わらないので、キャッシュを先に見る。
  // ここでナビゲーション用の HTML を代わりに返すと、スクリプトとして読み込まれて壊れるため決して返さない。
  event.respondWith(
    caches.match(req, MATCH).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
