// Service Worker のひな型。版番号と取り込み一覧はビルド時に埋め込まれる。
// 目的は「一度開いたら、電波の入らない現場でもそのまま使えること」。
const VERSION = '__VERSION__';
const PREFIX = 'jww-viewer-';
const CACHE = `${PREFIX}${VERSION}`;
const PRECACHE = __PRECACHE__;
// 配信側が Vary: Accept-Encoding を返すと、取り込んだ内容と参照時の条件が食い違って
// キャッシュに当たらなくなる。同一 URL なら同じものとして扱う。
const MATCH = { ignoreVary: true };
// ページ遷移で配信元の応答を待つ長さ（ミリ秒）。電波が弱くて返事が来ないときは、これを過ぎたらキャッシュで起動する
const NAVIGATE_TIMEOUT = 3000;

// 今の版のキャッシュを先に見る（caches.match は作った順に探すので、残してある直前の版の同じ URL を先に返してしまう）。
// 無ければほかの版も見る（前の版のまま開いているページが読み込むワーカーなど）
function lookup(req) {
  return caches.open(CACHE)
    .then((c) => c.match(req, MATCH))
    .then((hit) => hit || caches.match(req, MATCH));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // ブラウザのキャッシュを経由せず、配信元から取り直したものを入れる
      .then((cache) => cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
      // 取り込みに失敗したら半端なキャッシュを残さない（次の版が「直前の版」と取り違えないように）
      .catch((e) => caches.delete(CACHE).then(() => { throw e; }))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => {
        // 古い版は消すが、直前の版は残す。新しい版に切り替わったあとも、前の版のまま開いているページが
        // 図面を開くたびに読み込む解析用のワーカーなどを、そこから返せるように（配信元からは消えている）。
        // keys は作った順に並ぶ。同じオリジンのほかのサイトのキャッシュには触らない
        const old = keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE);
        return Promise.all(old.slice(0, -1).map((k) => caches.delete(k)));
      })
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // ページ遷移だけは新しい内容を優先し、つながらなければキャッシュを返す。
  // 電波が弱くて返事が来ないまま待たされるときも、NAVIGATE_TIMEOUT を過ぎたらキャッシュで起動する
  if (req.mode === 'navigate') {
    let saved = Promise.resolve();
    const network = fetch(req).then((res) => {
      // 502 や 404 をそのまま保存すると、次にオフラインになったとき
      // エラーページが「キャッシュ済みの本体」として返ってしまう
      if (res.ok) {
        const copy = res.clone();
        saved = caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    });
    const cached = () => lookup(req).then((hit) => hit || lookup('./index.html'));
    // キャッシュで先に起動しても、取得は裏で続けて次に備えて入れ替えておく
    event.waitUntil(network.then(() => saved, () => {}));
    let timer = 0;
    const late = new Promise((resolve) => { timer = setTimeout(resolve, NAVIGATE_TIMEOUT); })
      .then(cached)
      .then((hit) => hit || network);
    const stop = () => clearTimeout(timer);
    network.then(stop, stop);
    event.respondWith(Promise.race([network, late]).catch(cached));
    return;
  }

  // ハッシュ付きの資産は中身が変わらないので、キャッシュを先に見る。
  // ここでナビゲーション用の HTML を代わりに返すと、スクリプトとして読み込まれて壊れるため決して返さない。
  event.respondWith(
    lookup(req).then((hit) => {
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
