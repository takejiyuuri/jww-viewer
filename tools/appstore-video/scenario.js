// App Store のプレビュー動画用の自動手順（撮影用のビルドにだけ入れる。TestFlight・App Store の版には入らない）。
// 見本の図面を開き、累進表示をオンにして、起点の丸を指で動かす流れを実際の速さで演じる。録画は外側が受け持つ：
//   - シミュレータ：Documents/shot-request.txt に REC_START / REC_STOP / FINISHED を書き、
//     外側（run-video.sh）が同じ名前を Documents/shot-done.txt に書くまで待つ
//   - ブラウザ：window.__shotHost(name) を呼ぶ（local-test.mjs が用意する）
// 指の位置は、画面の上に重ねた白い丸で見せる（シミュレータの録画には指が映らないため）。
// 字幕の時刻合わせのため、各場面の時刻（指の丸が最初に出た時を 0 とする）を shot-log.txt に書く。
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const $ = (id) => document.getElementById(id);

  // ---- 外側とのやりとり ----
  const cap = () => window.Capacitor;
  const fsCall = (method, opts) => {
    const c = cap();
    const p = c?.Plugins?.Filesystem;
    if (p && typeof p[method] === 'function') return p[method](opts);
    if (typeof c?.registerPlugin === 'function') return c.registerPlugin('Filesystem')[method](opts);
    return c.nativePromise('Filesystem', method, opts);
  };
  const fsWrite = (path, data) => fsCall('writeFile', { path, data, directory: 'DOCUMENTS', encoding: 'utf8' });
  const fsRead = async (path) => {
    try { return (await fsCall('readFile', { path, directory: 'DOCUMENTS', encoding: 'utf8' })).data; } catch { return null; }
  };
  const logLines = [];
  const log = async (text) => {
    logLines.push(`${new Date().toISOString()} ${text}`);
    if (window.__shotHost) { console.log('[video]', text); return; }
    try { await fsWrite('shot-log.txt', logLines.join('\n')); } catch { /* 記録できなくても続ける */ }
  };
  const signal = async (name) => {
    await log(`signal ${name}`);
    if (window.__shotHost) return window.__shotHost(name);
    await fsWrite('shot-request.txt', name);
    for (let i = 0; i < 600; i++) {
      if ((await fsRead('shot-done.txt')) === name) return;
      await sleep(100);
    }
    throw new Error(`合図が返ってきません: ${name}`);
  };
  let t0 = 0;
  const marks = {};
  const mark = (k) => { marks[k] = Math.round(performance.now() - t0) / 1000; };

  // ---- 指の丸 ----
  let finger;
  const makeFinger = () => {
    finger = document.createElement('div');
    Object.assign(finger.style, {
      position: 'fixed', left: '0px', top: '0px', width: '46px', height: '46px', margin: '-23px 0 0 -23px', borderRadius: '50%',
      background: 'rgba(255,255,255,0.38)', border: '2px solid rgba(255,255,255,0.9)', boxShadow: '0 2px 10px rgba(0,0,0,0.45)',
      pointerEvents: 'none', zIndex: 2147483647, opacity: '0', transform: 'scale(1)',
      transition: 'opacity 140ms ease, transform 110ms ease, background 110ms ease',
    });
    document.body.appendChild(finger);
  };
  const fingerAt = (x, y) => { finger.style.left = `${x}px`; finger.style.top = `${y}px`; };
  const fingerShow = (on) => { finger.style.opacity = on ? '1' : '0'; };
  const fingerPress = (on) => {
    finger.style.transform = on ? 'scale(0.82)' : 'scale(1)';
    finger.style.background = on ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.38)';
  };

  // ---- 図面の操作 ----
  const app = () => window.__jww;
  const toS = (x, y) => {
    const a = app();
    return { x: ((x - a.view.cx) * a.view.zoom) / a.dpr + a.cssW / 2, y: a.cssH / 2 - ((y - a.view.cy) * a.view.zoom) / a.dpr };
  };
  const ptr = (type, x, y) => $('stage').dispatchEvent(new PointerEvent(type, {
    pointerId: 9, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: x, clientY: y,
    pressure: type === 'pointerup' ? 0 : 0.5, button: 0, buttons: type === 'pointerup' ? 0 : 1,
  }));
  const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  const center = (id) => { const r = $(id).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const waitFor = async (fn, ms = 30000) => {
    const t = Date.now();
    while (!fn()) { if (Date.now() - t > ms) throw new Error('待ちきれませんでした'); await sleep(100); }
  };

  /** 指の丸を見せてからボタンを押す */
  const tapButton = async (id, after) => {
    const c = center(id);
    fingerAt(c.x, c.y); fingerShow(true); await sleep(320);
    fingerPress(true); await sleep(140);
    $(id).click();
    fingerPress(false); await sleep(160);
    fingerShow(false); await sleep(after);
  };
  /** 図面の上をタップする */
  const tapStage = async (s, after) => {
    fingerAt(s.x, s.y); fingerShow(true); await sleep(320);
    fingerPress(true); ptr('pointerdown', s.x, s.y); await sleep(90);
    ptr('pointerup', s.x, s.y); fingerPress(false); await sleep(160);
    fingerShow(false); await sleep(after);
  };
  /** 起点の丸をつまんで、なめらかに動かして離す */
  const dragOrigin = async (from, to, ms) => {
    fingerAt(from.x, from.y); fingerShow(true); await sleep(300);
    fingerPress(true); ptr('pointerdown', from.x, from.y); await sleep(180);
    const start = performance.now();
    for (;;) {
      await frame();
      const u = Math.min(1, (performance.now() - start) / ms);
      const k = ease(u);
      const x = from.x + (to.x - from.x) * k;
      const y = from.y + (to.y - from.y) * k;
      ptr('pointermove', x, y); fingerAt(x, y);
      if (u >= 1) break;
    }
    await sleep(380);
    ptr('pointerup', to.x, to.y); fingerPress(false); await sleep(160);
    fingerShow(false);
  };
  /** 表示範囲をなめらかに動かす */
  const animateView = async (target, ms) => {
    const a = app();
    const v0 = { ...a.view };
    const start = performance.now();
    for (;;) {
      await frame();
      const u = Math.min(1, (performance.now() - start) / ms);
      const k = ease(u);
      a.view.zoom = Math.exp(Math.log(v0.zoom) + (Math.log(target.zoom) - Math.log(v0.zoom)) * k);
      a.view.cx = v0.cx + (target.cx - v0.cx) * k;
      a.view.cy = v0.cy + (target.cy - v0.cy) * k;
      a.requestDraw(true);
      if (u >= 1) break;
    }
  };

  // 見本の図面（public/ruishin-sample.jww、縮尺 1/100）の座標。図面上の mm ＝ 実寸 mm ÷ 100
  const DIM_Y = -13; // 下の連続寸法の寸法線

  async function run() {
    await waitFor(() => app() && !$('welcome').classList.contains('hidden'));
    makeFinger();
    await sleep(1500);
    await signal('REC_START');
    await sleep(1600);
    t0 = performance.now();
    mark('open');
    // 1. 見本の図面を開く
    await tapButton('btn-sample', 0);
    await waitFor(() => $('title').textContent.endsWith('.jww'));
    await sleep(1700);
    // 2. 「累進」→「累進表示」
    mark('ruishinTab');
    await tapButton('btn-tool-ruishin', 650);
    mark('ruishinOn');
    await tapButton('btn-ruishin-on', 2000);
    const a = app();
    const full = { ...a.view };
    // 3. 下の列が見える大きさに寄せる（横は図面の幅いっぱい、縦はパネルと上の帯のあいだに収める）
    mark('zoom');
    const top = $('title').getBoundingClientRect().bottom + 10;
    const panelTop = $('ruishin-panel').getBoundingClientRect().top - 10;
    const pxPerMm = Math.min(a.cssW / 92, (panelTop - top) / 112);
    const zoom = pxPerMm * a.dpr;
    const midY = (top + panelTop) / 2;
    const target = { zoom, cx: 40.95, cy: 30 - ((a.cssH / 2 - midY) * a.dpr) / zoom };
    await animateView(target, 900);
    await sleep(500);
    await log(`note ${document.querySelector('#ruishin-body .note')?.textContent ?? ''}`);
    // 4. 下の列をタップして選ぶ
    mark('select');
    { const s = toS(30, DIM_Y); await tapStage({ x: s.x, y: s.y - 4 }, 500); }
    await log(`title ${$('ruishin-title').textContent}`);
    // 5. 起点を左端から通り芯の交点（4550 の位置）へ
    mark('drag1');
    {
      const chain = a.chains.filter((c) => c.uy === 0).sort((p, q) => p.offset - q.offset)[0];
      const o = a.origins.get(chain.id);
      await dragOrigin(toS(o.x, DIM_Y), toS(45.5 + 0.2, -0.15), 1100);
      await log(`origin1 ${JSON.stringify(a.origins.get(chain.id))}`);
    }
    mark('drag1End');
    await sleep(2000);
    // 6. もう一度、別の交点へ
    mark('drag2');
    {
      const chain = a.chains.filter((c) => c.uy === 0).sort((p, q) => p.offset - q.offset)[0];
      const o = a.origins.get(chain.id);
      await dragOrigin(toS(o.x, DIM_Y), toS(18.2 + 0.3, 18.2 - 0.3), 1000);
      await log(`origin2 ${JSON.stringify(a.origins.get(chain.id))}`);
    }
    await sleep(1700);
    // 7. 元の寸法に戻して、また累進に
    mark('off');
    await tapButton('btn-ruishin-on', 1300);
    mark('onAgain');
    await tapButton('btn-ruishin-on', 900);
    // 8. 全体に戻す
    mark('full');
    await animateView(full, 850);
    await sleep(2800);
    mark('end');
    await log(`marks ${JSON.stringify(marks)}`);
    await signal('REC_STOP');
    await signal('FINISHED');
  }

  run().catch(async (e) => {
    await log(`error ${e?.message ?? e}`);
    try { await signal('ERROR'); } catch { /* 外側がいなくても止まる */ }
  });
})();
