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

  // ---- 追加の場面（SHOT_SET=new のときだけ）：レイヤ・線色ごとの表示と、「全体」→「前の範囲」 ----
  async function runNew() {
    await waitFor(() => app() && visible('welcome'));
    await sleep(800);
    await click('btn-sample');
    await waitFor(() => $('title').textContent.endsWith('.jww'));
    await sleep(8000);
    fitZoom = app().view.zoom;
    fitCenter = { x: app().view.cx, y: app().view.cy };
    await newScenes();
  }

  /** 図面全体の表示（アプリの全体表示の計算そのまま）に戻し、その倍率と中心を覚え直す */
  const refit = async () => {
    const a = app();
    a.view = a.fitView(); a.requestDraw(true);
    await sleep(800);
    fitZoom = a.view.zoom;
    fitCenter = { x: a.view.cx, y: a.view.cy };
  };

  async function newScenes() {

    // 新①：レイヤ・線色ごとの表示。パネルを開いてから、パネルに隠れない所に図面全体を合わせる（アプリの全体表示の計算そのまま）
    const fitAboveSheet = async () => { const a = app(); a.view = a.fitView(a.visibleFit(), true); a.requestDraw(true); await sleep(800); };
    await click('btn-layers', 800);
    await fitAboveSheet();
    await shot('N1a_layers');
    await click('btn-layer-close', 400);
    await click('btn-display', 800);
    await fitAboveSheet();
    await shot('N1b_colors_all');
    const rows = [...$('color-list').querySelectorAll('.color-row')];
    await log(`colors ${rows.map((r) => r.textContent.replace(/\s+/g, ' ')).join(' / ')}`);
    const target = rows.find((r) => /線色2/.test(r.textContent)) || rows[1];
    target.click(); await sleep(1200);
    await log(`colors after: ${$('color-summary').textContent}`);
    await shot('N1c_color_hidden');
    // 元に戻す（すべて表示）
    await click('btn-color-all', 800);
    await click('btn-display-close', 600);

    // 新②：拡大中 →「全体」（押す前の範囲を囲う）→「前の範囲」（戻る）
    await setView(1, fitCenter.x, fitCenter.y);
    await setView(3.2, (X[0] + X[2]) / 2, (Y[2] + Y[4]) / 2);
    await sleep(HINT_MS);
    await shot('N2a_zoomed');
    await click('btn-fit', 1200);
    await log(`fit button: ${$('btn-fit').textContent.trim()}`);
    await shot('N2b_fit_frame');
    await click('btn-fit', 1200);
    await log(`back button: ${$('btn-fit').textContent.trim()}`);
    await shot('N2c_back');
  }

  // ---- 10 枚構成用（SHOT_SET=v10）：背景の白黒の切り替え（09）と、ボタンを隠して図面を広く見る（10） ----
  async function viewScenes() {
    const seg = async (value) => { $('seg-bg').querySelector(`[data-value=${value}]`).click(); await sleep(1200); };
    // 09：いつもの黒背景 → 「表示」の「背景」で白にする（白背景では明るい線が暗く描き直される。アプリの表示設定そのまま）
    await refit();
    await sleep(HINT_MS);
    await shot('V9a_dark_fit');
    await setView(1.8, fitCenter.x, fitCenter.y);
    await shot('V9b_dark_zoom');
    await click('btn-display', 800);
    await shot('V9c_dark_panel');
    await seg('light');
    await log(`background: ${document.body.dataset.bg}`);
    await shot('V9d_light_panel');
    await click('btn-display-close', 800);
    await shot('V9e_light_zoom');
    await setView(1, fitCenter.x, fitCenter.y);
    await refit();
    await shot('V9f_light_fit');
    // 黒背景に戻す
    await click('btn-display', 800);
    await seg('dark');
    await click('btn-display-close', 800);
    await log(`background back: ${document.body.dataset.bg}`);

    // 10：いつもの画面 → 右上のボタンで、ボタンやパネルを隠して図面を広く見る
    await refit();
    await sleep(HINT_MS);
    await shot('V10a_normal_fit');
    await click('btn-ui-hide', 1500);
    await log(`ui hidden: ${document.body.classList.contains('ui-hidden')}`);
    await shot('V10b_hidden_fit');
    await click('btn-ui-show', 1500);
    await refit();
    await setView(1.8, fitCenter.x, fitCenter.y);
    await shot('V10c_normal_zoom');
    await click('btn-ui-hide', 1500);
    await shot('V10d_hidden_zoom');
    await click('btn-ui-show', 1500);
    await log(`ui shown: ${!document.body.classList.contains('ui-hidden')}`);
  }

  /** 10 枚構成用：いつもの場面すべて → 新しい2枚の場面 → 09・10 の場面 */
  async function runV10() {
    await run();
    await sleep(HINT_MS);
    await refit();
    await newScenes();
    await refit();
    await viewScenes();
  }

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


  // ---- 1.4 用（SHOT_SET=v14）：1.4 の掲載画像 10 枚に使う場面だけを、この順に撮る ----
  /** 画面の部品の位置（CSS px）を記録に残す（拡大枠の切り出し位置を決めるため） */
  const rects = async (label, ids) => {
    const r = {};
    for (const id of ids) {
      const e = typeof id === 'string' ? $(id) || document.querySelector(id) : id;
      if (!e) continue;
      const b = e.getBoundingClientRect();
      r[typeof id === 'string' ? id : id.id] = [b.left, b.top, b.right, b.bottom].map((v) => Math.round(v * 10) / 10);
    }
    await log(`rects ${label} ${JSON.stringify({ dpr: window.devicePixelRatio, w: innerWidth, h: innerHeight, r })}`);
  };
  const setTool = async (id) => click(id, 600);
  const ruishinOn = () => $('btn-ruishin-on').getAttribute('aria-pressed') === 'true';

  /** 計測の点を「1 点戻す」で全部戻す（「すべて消去」だと「元に戻す」の帯が残るため） */
  const clearPts = async () => { for (let i = 0; i < 12 && app().points.length; i++) await click('btn-undo', 250); };

  async function runV14() {
    await waitFor(() => app() && visible('welcome'));
    const wide = app().cssW > 700; // iPad
    const F = wide ? 1.5 : 1.9;
    const zoomBottom = () => setView(F, 41, 4);
    await sleep(800);

    // ---- 01：ZIP（見本の図面 1 枚）を開いたあとの「ファイル」の画面（最近開いた図面に見本が出る） ----
    const zipBuf = await (await fetch('shot-sample.zip')).arrayBuffer();
    const openViaInput = async (file, done) => {
      const input = $('file');
      try {
        const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;
        app().pickAgreed = true; input.dispatchEvent(new Event('change'));
        await waitFor(done, 6000);
      } catch {
        await app().openPicked(file, true);
        await waitFor(done);
      }
    };
    const loaded = () => $('title').textContent.endsWith('.jww') && $('loading').classList.contains('hidden');
    await openViaInput(new File([zipBuf], '見本図面.zip', { type: 'application/zip' }), () => loaded() && (app().recent || []).length > 0);
    await log(`zip opened: ${$('title').textContent}`);
    await sleep(8000); // 上に iPadOS のお知らせが残っていても消えるまで待つ
    await refit();
    await click('btn-open', 900);
    await rects('X8a_files_panel', ['files-panel', 'btn-files-close']);
    await shot('X8a_files_panel');
    await click('btn-files-close', 600);
    await refit();
    await sleep(HINT_MS);

    // ---- 09 画面いっぱい：いつもの画面 → ボタンを隠す ----
    await rects('V10a_normal_fit', ['btn-ui-hide', 'title']);
    await shot('V10a_normal_fit');
    await click('btn-ui-hide', 1500);
    await log(`ui hidden: ${document.body.classList.contains('ui-hidden')}`);
    await shot('V10b_hidden_fit');
    await click('btn-ui-show', 1500);
    await refit();
    await sleep(HINT_MS);

    // ---- 03・04 累進寸法と起点の移動 ----
    await zoomBottom();
    await sleep(HINT_MS);
    await shot('P1a_original_dims');
    await setTool('btn-tool-ruishin');
    await click('btn-ruishin-on', HINT_MS);
    await log(`ruishin on: ${ruishinOn()}`);
    await shot('P1b_ruishin_on');
    await tapW(30, DIM_Y);
    await sleep(HINT_MS);
    await log(`chain ${app().activeChain} ${$('ruishin-title').textContent}`);
    await rects('P1c_ruishin_selected', ['ruishin-panel', 'btn-ruishin-on', 'btn-ruishin-undo']);
    await shot('P1c_ruishin_selected');
    const c = app().chains[app().activeChain];
    const o = app().origins.get(c.id);
    const outside = toS(-8, DIM_Y);
    await dragHold(toS(o.x, o.y), outside);
    await release(outside);
    const inside = toS(X[2], DIM_Y);
    await dragHold(toS(-8, DIM_Y), inside);
    await shot('X2a_origin_drag_magnifier');
    await release(inside);
    await click('btn-ruishin-undo', HINT_MS);
    await log(`undo ${$('btn-ruishin-undo').disabled} redo ${$('btn-ruishin-redo').disabled}`);
    await rects('X2b_extension_undo_redo', ['ruishin-panel']);
    await shot('X2b_extension_undo_redo');

    // ---- 10 累進寸法を見ながら、計測（1.4）：累進表示のまま「計測」で距離を測る ----
    await click('btn-ruishin-reset', 900);
    await zoomBottom();
    await tapW(41, 40); // 列の選択を外す（寸法の列から離れた所）
    await sleep(HINT_MS);
    await log(`selected after deselect: ${app().activeChain}`);
    await rects('M1a_ruishin_view', ['ruishin-panel', 'btn-tool-ruishin', 'toolbar']);
    await shot('M1a_ruishin_view');
    await setTool('btn-tool-measure');
    await log(`measure with ruishin: ${ruishinOn()}`);
    for (const [x, y] of [[X[1], Y[0]], [X[4], Y[0]]]) await tapW(x, y);
    await sleep(HINT_MS);
    await log(`measure ${readout()}`);
    await rects('M1b_measure_with_ruishin', ['btn-tool-ruishin', 'btn-tool-measure', 'toolbar', 'readout']);
    await shot('M1b_measure_with_ruishin');
    await clearPts();
    // 累進表示を切る（このあとの場面はいつもの元の寸法）
    await setTool('btn-tool-ruishin');
    if (ruishinOn()) await click('btn-ruishin-on', 900);
    await log(`ruishin off: ${!ruishinOn()}`);
    await setTool('btn-tool-measure');
    await sleep(HINT_MS);

    // ---- 02 距離 ----
    await setView(1.25, 41, 31);
    for (const [x, y] of [[X[0], Y[0]], [X[2], Y[0]], [X[5], Y[0]]]) await tapW(x, y);
    await sleep(HINT_MS);
    await log(`distance ${readout()}`);
    await rects('P2_distance', ['readout', 'measure-panel', 'toolbar']);
    await shot('P2_distance');
    await clearPts();
    await sleep(HINT_MS);

    // ---- 08 拡大鏡と吸着 ----
    await setView(2.2, X[2], 22);
    await tapW(X[1], Y[2]);
    await sleep(HINT_MS);
    const lp = toS(X[2] - 0.4, Y[2] - 0.3);
    ptr('pointerdown', lp.x, lp.y);
    await sleep(900);
    ptr('pointermove', lp.x + 2, lp.y + 1);
    await sleep(500);
    await rects('X5_magnifier_snap', ['magnifier', 'loupe']);
    await shot('X5_magnifier_snap');
    await log(`magnifier at ${JSON.stringify(toS(X[2], Y[2]))}`);
    await release({ x: lp.x + 2, y: lp.y + 1 });
    await clearPts();
    await log(`points left: ${app().points.length}, restore bar: ${visible('btn-restore')}`);
    await sleep(HINT_MS);

    // ---- 06 拡大した場所 ----
    await refit();
    await setView(3.2, (X[0] + X[2]) / 2, (Y[2] + Y[4]) / 2);
    await sleep(HINT_MS);
    await shot('N2a_zoomed');
    await click('btn-fit', 1200);
    await log(`fit button: ${$('btn-fit').textContent.trim()}`);
    await rects('N2b_fit_frame', ['toolbar', 'btn-fit']);
    await shot('N2b_fit_frame');
    await click('btn-fit', 1200);

    // ---- 07 白黒反転 ----
    const seg = async (value) => { $('seg-bg').querySelector(`[data-value=${value}]`).click(); await sleep(1200); };
    await refit();
    await setView(1.8, fitCenter.x, fitCenter.y);
    await sleep(HINT_MS);
    await shot('V9b_dark_zoom');
    await click('btn-display', 800);
    await seg('light');
    await log(`background: ${document.body.dataset.bg}`);
    await rects('V9d_light_panel', ['display-panel', 'seg-bg', 'seg-mono']);
    await shot('V9d_light_panel');
    await click('btn-display-close', 800);
    await shot('V9e_light_zoom');
    await click('btn-display', 800);
    await seg('dark');
    await click('btn-display-close', 800);
    await log(`background back: ${document.body.dataset.bg}`);

    // ---- 05 図面から、レイヤを見つける（1.4）：撮影用の見本の図面（建築・電気設備・空調設備のレイヤ） ----
    const drw = await (await fetch('shot-layers.jww')).arrayBuffer();
    await openViaInput(new File([drw], '見本（事務所の電気設備図）.jww'), () => loaded() && $('title').textContent.includes('電気設備'));
    await log(`layer drawing opened: ${$('title').textContent}`);
    await sleep(3000);
    await click('btn-layers', 1000);
    // 一覧に隠れない所に図面全体を合わせる（アプリの全体表示の計算そのまま）
    // 一覧に隠れない所に、図面の左側（事務室）を合わせる（アプリの表示の計算そのまま）
    { const a = app(); a.view = a.fitView({ minX: -4, minY: -16, maxX: 76, maxY: 70 }, true); a.requestDraw(true); await sleep(800); }
    await shot('L0_layers_open');
    // 配線（電気設備）の線をタップ：事務室の上の列の照明どうしをつなぐ線
    await tapW(26, 49);
    await sleep(1500);
    await log(`pick: ${$('layer-pick').textContent.replace(/\s+/g, ' ')}`);
    await rects('L1_layer_picked', ['layer-panel', 'layer-pick', 'layer-list', '.l-row.mark']);
    await shot('L1_layer_picked');
    await sleep(HINT_MS);
    await shot('L1b_layer_picked_settled');
  }

  ({ new: runNew, v10: runV10, v14: runV14 }[window.__SHOT_SET] || run)().then(() => shot('FINISHED')).catch(async (e) => {
    await log(`ERROR ${e && e.stack ? e.stack : e}`);
    try { await shot('ERROR'); } catch { /* 外側が時間切れで止める */ }
  });
})();
