// App Store のスクリーンショット用の自動手順（撮影用のビルドにだけ入れる。TestFlight・App Store の版には入らない）。
// アプリに同梱の見本の図面を開き、累進・計測・記録・属性・レイヤの画面を順に作って、場面ごとに撮影を頼む。
// 撮影は外側（シミュレータなら run-sim.sh、ブラウザなら local-test.mjs）が受け持つ：
//   - シミュレータ：Capacitor の Filesystem で Documents/shot-request.txt に場面の名前を書き、
//     撮り終わった合図（Documents/shot-done.txt に同じ名前）が来るまで待つ
//   - ブラウザ：window.__shotHost(name) を呼ぶ（Playwright が用意する）
// 図面の座標と表示範囲は、開発用の窓口 window.__jww（NODE_ENV=development でビルドしたときだけ出る）から読む。
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const HINT_MS = 3200; // 案内の帯（約 2.6 秒）が消えるまで待つ

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
    if (window.__shotHost) { console.log('[shot]', text); return; }
    try { await fsWrite('shot-log.txt', logLines.join('\n')); } catch { /* 記録できなくても続ける */ }
  };
  const shot = async (name) => {
    await log(`shot ${name}`);
    if (window.__shotHost) return window.__shotHost(name);
    await fsWrite('shot-request.txt', name);
    for (let i = 0; i < 600; i++) {
      if ((await fsRead('shot-done.txt')) === name) return;
      await sleep(200);
    }
    throw new Error(`撮影の合図が返ってきません: ${name}`);
  };

  // ---- 図面の操作 ----
  const app = () => window.__jww;
  /** 図面の座標（図面上の mm）→ 画面の座標（CSS px） */
  const toS = (x, y) => {
    const a = app();
    return { x: ((x - a.view.cx) * a.view.zoom) / a.dpr + a.cssW / 2, y: a.cssH / 2 - ((y - a.view.cy) * a.view.zoom) / a.dpr };
  };
  const ptr = (type, x, y) => $('stage').dispatchEvent(new PointerEvent(type, {
    pointerId: 9, pointerType: 'touch', isPrimary: true, bubbles: true, clientX: x, clientY: y,
    pressure: type === 'pointerup' ? 0 : 0.5, button: 0, buttons: type === 'pointerup' ? 0 : 1,
  }));
  const tapS = async (s) => { ptr('pointerdown', s.x, s.y); await sleep(60); ptr('pointerup', s.x, s.y); await sleep(350); };
  const tapW = (x, y) => tapS(toS(x, y));
  /** 押したまま動かす（離さない） */
  const dragHold = async (from, to, holdMs = 80) => {
    ptr('pointerdown', from.x, from.y);
    await sleep(holdMs);
    for (let i = 1; i <= 12; i++) {
      ptr('pointermove', from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
      await sleep(30);
    }
    await sleep(400);
  };
  const release = async (p) => { ptr('pointerup', p.x, p.y); await sleep(500); };
  let fitZoom = 1;
  let fitCenter = { x: 0, y: 0 };
  /** 全体表示の倍率に対する倍率 f で、図面の点 (cx, cy) を画面の真ん中にする */
  const setView = async (f, cx, cy) => {
    const a = app();
    a.view.zoom = fitZoom * f; a.view.cx = cx; a.view.cy = cy; a.requestDraw(true);
    await sleep(500);
  };
  const click = async (id, wait = 400) => { $(id).click(); await sleep(wait); };
  const visible = (id) => !$(id).classList.contains('hidden');
  const waitFor = async (fn, ms = 30000) => {
    const t0 = Date.now();
    while (!fn()) { if (Date.now() - t0 > ms) throw new Error('待ちきれませんでした'); await sleep(100); }
  };
  const readout = () => `${$('readout-value').textContent} | ${$('readout-detail').textContent}`;
  const hintText = () => ($('hint').classList.contains('hidden') ? '' : $('hint').textContent);

  // 見本の図面（public/ruishin-sample.jww、縮尺 1/100）の座標。図面上の mm ＝ 実寸 mm ÷ 100
  const X = [0, 18.2, 36.4, 45.5, 63.7, 81.9];
  const Y = [0, 18.2, 27.3, 45.5, 63.7];
  const DIM_Y = -13; // 下の連続寸法の寸法線

  async function run() {
    await waitFor(() => app() && visible('welcome'));
    const wide = app().cssW > 700; // iPad
    // 下の寸法の列を画面の幅いっぱいにする倍率（iPad は画面が広いので控えめ）
    const F = wide ? 1.5 : 1.9;
    const zoomBottom = () => setView(F, 41, 4);
    await sleep(800);
    await shot('00_welcome');

    await click('btn-sample');
    await waitFor(() => $('title').textContent.endsWith('.jww'));
    await sleep(8000); // 上に iPadOS のお知らせが残っていても消えるまで待つ
    fitZoom = app().view.zoom;
    fitCenter = { x: app().view.cx, y: app().view.cy };
    await shot('P5_drawing_fit');

    // ---- 累進寸法 ----
    await zoomBottom();
    await shot('P1a_original_dims');
    await click('btn-tool-ruishin', 300);
    await click('btn-ruishin-on', HINT_MS);
    await shot('P1b_ruishin_on');
    await tapW(30, DIM_Y);
    await sleep(HINT_MS);
    await log(`chain ${app().activeChain} ${$('ruishin-title').textContent}`);
    await shot('P1c_ruishin_selected');

    // 起点のドラッグ（寸法線の外へ → 交点へ → 戻る）
    const c = app().chains[app().activeChain];
    const o = app().origins.get(c.id);
    const outside = toS(-8, DIM_Y);
    await dragHold(toS(o.x, o.y), outside);
    await release(outside);
    // 拡大鏡は、線の交わる所へ動かしている途中を撮る（外側の何もない所だと拡大鏡の中が空になるため）
    const inside = toS(X[2], DIM_Y);
    await dragHold(toS(-8, DIM_Y), inside);
    await shot('X2a_origin_drag_magnifier');
    await release(inside);
    await click('btn-ruishin-undo', HINT_MS);
    await log(`undo ${$('btn-ruishin-undo').disabled} redo ${$('btn-ruishin-redo').disabled}`);
    await shot('X2b_extension_undo_redo');

    // ---- 計測 ----
    await click('btn-tool-measure', 300);
    await setView(1.25, 41, 31);
    for (const [x, y] of [[X[0], Y[0]], [X[2], Y[0]], [X[5], Y[0]]]) await tapW(x, y);
    await sleep(HINT_MS);
    await log(`distance ${readout()}`);
    await shot('P2_distance');
    await click('btn-record', 300);

    await click('btn-clear', 300);
    $('seg-mode').querySelector('[data-mode=area]').click(); await sleep(300);
    for (const [x, y] of [[X[2], Y[0]], [X[5], Y[0]], [X[5], Y[4]], [X[2], Y[4]], [X[2], Y[0]]]) await tapW(x, y);
    await sleep(HINT_MS);
    await log(`area ${readout()}`);
    await shot('P3_area');
    await click('btn-record', 300);

    await click('btn-clear', 300);
    $('seg-mode').querySelector('[data-mode=volume]').click(); await sleep(600);
    if (visible('height-dialog')) {
      $('height-input').value = '2400';
      $('height-input').dispatchEvent(new Event('input', { bubbles: true }));
      await click('btn-height-ok', 400);
    }
    for (const [x, y] of [[X[0], Y[2]], [X[2], Y[2]], [X[2], Y[4]], [X[0], Y[4]], [X[0], Y[2]]]) await tapW(x, y);
    await sleep(HINT_MS);
    await log(`volume ${readout()}`);
    await shot('X4b_volume');
    await click('btn-record', 300);

    await click('btn-clear', 300);
    $('seg-mode').querySelector('[data-mode=angle]').click(); await sleep(300);
    for (const [x, y] of [[X[5], Y[0]], [X[0], Y[0]], [X[2], Y[4]]]) await tapW(x, y);
    await sleep(HINT_MS);
    await log(`angle ${readout()}`);
    await shot('X4c_angle');
    await click('btn-record', 300);

    // 拡大鏡と吸着
    await click('btn-clear', 300);
    $('seg-mode').querySelector('[data-mode=length]').click(); await sleep(300);
    await setView(2.2, X[2], 22);
    await tapW(X[1], Y[2]);
    await sleep(HINT_MS);
    const lp = toS(X[2] - 0.4, Y[2] - 0.3);
    ptr('pointerdown', lp.x, lp.y);
    await sleep(900);
    ptr('pointermove', lp.x + 2, lp.y + 1);
    await sleep(500);
    await shot('X5_magnifier_snap');
    await release({ x: lp.x + 2, y: lp.y + 1 });
    await click('btn-clear', HINT_MS);

    // 記録（「全体」ボタンは押すと「前の範囲」の枠が出るので、全体表示の倍率に直接戻す）
    await setView(1, fitCenter.x, fitCenter.y);
    await sleep(HINT_MS);
    await shot('X6a_record_badges');
    await click('btn-records', 700);
    await shot('X6b_records_list');
    await click('btn-records-copy', 300);
    await log(`copy hint: ${hintText()}`);
    await shot('X6c_records_copied');
    await sleep(HINT_MS);
    // 属性を主役にするため、アプリの「すべて消す」で計測の記録を消してから撮る
    // （確かめの画面は、人が「OK」を押したのと同じ扱いにする）
    const realConfirm = window.confirm;
    window.confirm = () => true;
    try { await click('btn-records-clear', 300); } finally { window.confirm = realConfirm; }
    await log(`records cleared: ${hintText()}`);
    await click('btn-records-close', 300);
    await sleep(HINT_MS);

    // 属性・レイヤ・表示
    await click('btn-tool-inspect', 300);
    await zoomBottom();
    await tapW(X[2] + 0.75, 40);
    await sleep(HINT_MS);
    await log(`inspect ${$('inspect-kind').textContent} ${$('inspect-body').textContent}`);
    await shot('P4a_inspect');
    await click('btn-layers', 800);
    await shot('P4b_layers');
    await click('btn-layer-close', 400);
    await click('btn-display', 800);
    await shot('X7c_display');
    await click('btn-display-close', 400);

    // ---- 8. ZIP の読み込み ----
    // 計測に戻してから開く（開いた直後は計測が選ばれた、いつもの画面にする）
    await click('btn-tool-measure', 600);
    // 「ファイルから選ぶ」で ZIP（見本の図面 1 枚だけ）を選んだのと同じに、ファイルの選択欄へ渡す
    // （iOS のファイル選択の画面は自動では押せないため。そのあとの読み込みはアプリの処理そのまま）
    const zipBuf = await (await fetch('shot-sample.zip')).arrayBuffer();
    const zipFile = new File([zipBuf], '見本図面.zip', { type: 'application/zip' });
    const input = $('file');
    let viaInput = false;
    try {
      const dt = new DataTransfer();
      dt.items.add(zipFile);
      input.files = dt.files;
      app().pickAgreed = true;
      input.dispatchEvent(new Event('change'));
      viaInput = true;
    } catch { /* 下で直接渡す */ }
    const opened = () => $('title').textContent.endsWith('.jww') && $('loading').classList.contains('hidden')
      && (app().recent || []).length > 0;
    try { await waitFor(opened, 6000); } catch {
      viaInput = false;
      await app().openPicked(zipFile, true);
      await waitFor(opened);
    }
    await log(`zip opened (${viaInput ? 'input' : 'direct'}): ${$('title').textContent}`);
    await sleep(HINT_MS);
    await shot('X8b_zip_opened');
    await click('btn-open', 900);
    await log(`files: ${$('files-panel').textContent.replace(/\s+/g, ' ').slice(0, 200)}`);
    await shot('X8a_files_panel');
    await click('btn-files-close', 400);
  }

  run().then(() => shot('FINISHED')).catch(async (e) => {
    await log(`ERROR ${e && e.stack ? e.stack : e}`);
    try { await shot('ERROR'); } catch { /* 外側が時間切れで止める */ }
  });
})();
