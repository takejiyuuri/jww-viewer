import { DASH_STYLES, type Scene } from './geometry.ts';

/**
 * 色番号からパレットの色を引く。パレットは 256 色ずつ横に並べたテクスチャで、
 * A が 0 の色は隠している色として扱う。
 */
const PALETTE_LOOKUP = `
uniform highp sampler2D uPalette;
vec4 paletteColor(uint index) {
  return texelFetch(uPalette, ivec2(int(index & 255u), int(index >> 8u)), 0);
}

// レイヤ（0〜255）ごとに表示するかどうかを 256 ビットで持つ
uniform uint uLayerMask[8];
bool layerVisible(uint layer) {
  return (uLayerMask[layer >> 5u] & (1u << (layer & 31u))) != 0u;
}`;

/**
 * つながった線分どうしを、継ぎ目の二等分線（マイター）で突き合わせる曲がりの上限。
 * 円弧を折った継ぎ目（最大 90°）はすべて入り、鋭く折り返す所は今までどおり端を張り出す
 */
const JOIN_MAX_TURN = (100 * Math.PI) / 180;
/** 突き合わせる曲がりの、角度の半分の tan の上限 */
const JOIN_TAN = Math.tan(JOIN_MAX_TURN / 2);
/** 前後の線分とつながっていない端の印 */
const NOT_JOINED = -32768;
/** 線種の代わりに付ける、実点の丸の印 */
const DOT_STYLE = 255;

/**
 * 破線の 1 ドットの長さ（CSS ピクセル）。Jw_cad は線種の模様を画面のドットで描くので、拡大・縮小しても変わらない。
 * パソコンの画面のドットと、手元で見る iPhone の CSS ピクセルが目にほぼ同じ大きさに見えるくらいにしている
 */
const DASH_DOT = 1.25;
/** 実点の丸の最小の半径（CSS ピクセル）。縮小しても線より太い点として見えるように */
const POINT_MIN = 1.1;

const LINE_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aSeg;
layout(location = 2) in uint aColorIndex;
layout(location = 3) in uint aLayer;
// 前後の線分とのつながり（x = 始点の側、y = 終点の側）。${NOT_JOINED} はつながっていない。
// ほかは継ぎ目で曲がる角度の半分の tan を、JOIN_TAN を 32767 として表したもの（左へ曲がるとき正）
layout(location = 4) in ivec2 aJoin;
// 線種番号（${DASH_STYLES} 以上は実線、${DOT_STYLE} は実点の丸）と、図形の始まりから線分の始点までの長さ（図面座標）。
// 実点では長さの代わりに丸の半径（用紙上の mm）
layout(location = 5) in uint aStyle;
layout(location = 6) in float aDist;

const float JOIN_TAN = ${JOIN_TAN.toFixed(9)};

uniform vec2 uCenter;
uniform vec2 uScale;
uniform vec2 uPixel;
uniform float uHalfWidth;
// 図面 1mm あたりのデバイスピクセル数と、ビューの中心のウィンドウ座標（デバイスピクセル、左下原点）
uniform float uZoom;
uniform vec2 uWinCenter;
// 破線の 1 ドットと、実点の丸の最小の半径（デバイスピクセル）
uniform float uDot;
uniform float uPointMin;
// 線種ごとの模様。2 線種ずつ（ビット列, 1 周期のビット数 | 1 ビットのドット数 << 8）を並べる
uniform uvec4 uDash[${DASH_STYLES / 2}];
${PALETTE_LOOKUP}

out vec3 vColor;
out float vEdge;
out float vHalfPx;
// 模様のビット列と 1 周期のビット数（0 は実線、${DOT_STYLE} は実点の丸）
flat out uint vDashBits;
flat out uint vDashUnit;
// 1 ビットの長さ（デバイスピクセル）
flat out float vDashStep;
// 模様を測る基準の点（ウィンドウ座標）。実点では丸の中心
flat out vec2 vDashOrigin;
// xy は線の向き、z は基準の点での模様の位置（デバイスピクセル）
flat out vec3 vDashAxis;

void main() {
  vec4 pc = paletteColor(aColorIndex);
  vColor = pc.rgb;
  vHalfPx = uHalfWidth;
  vDashBits = 0u;
  vDashUnit = 0u;
  vDashStep = 1.0;
  vDashOrigin = vec2(0.0);
  vDashAxis = vec3(1.0, 0.0, 0.0);
  if (pc.a < 0.5 || !layerVisible(aLayer)) {
    // 隠している色やレイヤの線は、描画範囲の外へ追い出して描かない
    vEdge = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec2 p1 = aSeg.xy;
  vec2 p2 = aSeg.zw;
  vec2 d = p2 - p1;
  float len = length(d);
  vec2 dir = len > 0.0 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);

  // 端をぼかすぶんだけ外側に広げる。線そのものの太さは変えない
  float halfW = uHalfWidth + 0.5;
  if (aStyle == ${DOT_STYLE}u) {
    // 実点は用紙上の半径の丸（小さくなりすぎないよう下限を付ける）。四角を張って、丸く切り抜くのは FS
    float r = max(aDist * uZoom, uPointMin);
    halfW = r + 0.5;
    vHalfPx = r;
    vDashUnit = ${DOT_STYLE}u;
    vDashOrigin = (p1 - uCenter) * uZoom + uWinCenter;
  } else if (aStyle < ${DASH_STYLES}u) {
    uvec4 pair = uDash[aStyle >> 1u];
    uvec2 dash = (aStyle & 1u) == 0u ? pair.xy : pair.zw;
    uint unit = dash.y & 255u;
    if (unit > 0u) {
      vDashBits = dash.x;
      vDashUnit = unit;
      vDashStep = float(dash.y >> 8u) * uDot;
      // 模様の位置は、線の上で画面の中心にいちばん近い点を基準にして、ウィンドウ座標で測る。
      // 図形の始まりから図面座標のまま数えると、大きく拡大したときに桁が足りず模様が崩れるため。
      // 基準の点での位置は 1 周期の中に丸めておく（図形の始まりから続く模様になる）
      float t0 = clamp(dot(uCenter - p1, dir), 0.0, len);
      vDashOrigin = (p1 - uCenter + dir * t0) * uZoom + uWinCenter;
      vDashAxis = vec3(dir, mod((aDist + t0) * uZoom, float(unit) * vDashStep));
    }
  }

  // 端点は補間せずにそのまま使う。mix だと GPU によっては p2 からわずかにずれ、
  // 突き合わせた継ぎ目が大きく拡大したときに割れて見える
  vec2 base = aCorner.x < 0.5 ? p1 : p2;
  vec2 clip = (base - uCenter) * uScale;
  // 線幅ぶんの押し出しと、継ぎ目を埋めるための端の張り出し
  vec2 side = nrm * aCorner.y * halfW * uPixel;
  int join = aCorner.x < 0.5 ? aJoin.x : aJoin.y;
  float ext = halfW;
  if (join != ${NOT_JOINED}) {
    // 前後の線分とつながる端（細かく折った円弧の継ぎ目など）は、継ぎ目の二等分線で突き合わせる。
    // 曲がりの外側は伸ばし、内側は縮めるので、隙間も重なりもできない。
    // 重なると縁のぼかしが塗り重なり、短い線分の続く曲線ほど太って見える
    ext = -aCorner.y * halfW * float(join) / 32767.0 * JOIN_TAN;
    // 画面の上でとても短い線分では、内側を縮めすぎて形が裏返らないようにする
    ext = max(ext, -0.5 * len * uScale.x / uPixel.x);
  }
  vec2 cap = dir * (aCorner.x * 2.0 - 1.0) * ext * uPixel;

  gl_Position = vec4(clip + side + cap, 0.0, 1.0);
  vEdge = aCorner.y * halfW;
}`;

const TRI_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in uint aColorIndex;
layout(location = 2) in uint aLayer;

uniform vec2 uCenter;
uniform vec2 uScale;
// 塗りの色がパレットのどこから並んでいるか（線と同じ色を使うなら 0）
uniform uint uFillOffset;
${PALETTE_LOOKUP}

out vec3 vColor;

void main() {
  vec4 pc = paletteColor(aColorIndex + uFillOffset);
  vColor = pc.rgb;
  gl_Position = pc.a < 0.5 || !layerVisible(aLayer)
    ? vec4(2.0, 2.0, 2.0, 1.0)
    : vec4((aPos - uCenter) * uScale, 0.0, 1.0);
}`;

/** 塗り用。そのまま出す */
const FS = `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 fragColor;
void main() {
  fragColor = vec4(vColor, 1.0);
}`;

/**
 * 線用。端の 1 ピクセルを透かして階段状のギザつきを消す。
 * 端末側の MSAA に頼らないので、拡大鏡の中でも同じように滑らかになる。
 * 破線は線に沿った位置（ウィンドウ座標で測る）が模様の 0 のビットに当たる所を描かない。
 * 実点は中心からの距離で丸く切り抜く。
 * 画面の座標とビット列を扱うので、精度は highp にする（mediump では大きな画面で位置がずれる）
 */
const LINE_FS = `#version 300 es
precision highp float;
precision highp int;
in vec3 vColor;
in float vEdge;
in float vHalfPx;
flat in uint vDashBits;
flat in uint vDashUnit;
flat in float vDashStep;
flat in vec2 vDashOrigin;
flat in vec3 vDashAxis;
out vec4 fragColor;
void main() {
  float dist = abs(vEdge);
  if (vDashUnit == ${DOT_STYLE}u) {
    dist = length(gl_FragCoord.xy - vDashOrigin);
  } else if (vDashUnit > 0u) {
    float s = dot(gl_FragCoord.xy - vDashOrigin, vDashAxis.xy) + vDashAxis.z;
    uint bit = min(uint(mod(s, float(vDashUnit) * vDashStep) / vDashStep), vDashUnit - 1u);
    if (((vDashBits >> (31u - bit)) & 1u) == 0u) discard;
  }
  float a = clamp(vHalfPx + 0.5 - dist, 0.0, 1.0);
  if (a <= 0.003) discard;
  fragColor = vec4(vColor, a);
}`;

/** パレットのテクスチャ 1 行に並べる色数 */
const PALETTE_ROW = 256;

/** 拡大して見ているときの線の太さ（CSS ピクセル） */
const LINE_WIDTH_MAX = 1.15;
/** 縮小して見ているときの線の太さ（CSS ピクセル）。ただし端末の 1 ピクセルより細くはしない */
const LINE_WIDTH_MIN = 0.55;
/**
 * 線の太さを変える倍率の範囲（用紙 1mm が画面で何 CSS ピクセルになるか）。
 * これより縮小していれば最も細く、拡大していれば最も太くし、あいだは倍率の対数に比例して太らせる。
 * iPhone の縦向きで用紙全体を表示すると、A1 でおよそ 0.45、A3 でおよそ 0.9 になる
 */
const WIDTH_ZOOM_LO = 0.5;
const WIDTH_ZOOM_HI = 4;

/**
 * 表示の倍率に合わせた線の太さ（CSS ピクセル）。
 * 画面の上で同じ太さのままだと、縮小して図面が小さくなるほど線が図面に対して太り、
 * 間の狭い線どうしがつぶれて重く見えるので、縮小するほど細くする。
 */
export function lineWidthAt(zoom: number, dpr: number): number {
  // 図面の座標は用紙上の mm なので、zoom / dpr が用紙 1mm あたりの CSS ピクセル
  const perMm = zoom / dpr;
  const t = perMm > 0 && Number.isFinite(perMm)
    ? Math.min(1, Math.max(0, Math.log(perMm / WIDTH_ZOOM_LO) / Math.log(WIDTH_ZOOM_HI / WIDTH_ZOOM_LO)))
    : 1;
  return Math.max(LINE_WIDTH_MIN * Math.pow(LINE_WIDTH_MAX / LINE_WIDTH_MIN, t), 1 / dpr);
}

/**
 * 線分ごとに、直前・直後の線分とのつながりを調べる（始点の側・終点の側の 2 つずつ）。
 * 端点が一致し、色とレイヤも同じ（表示・非表示がそろう）で、曲がりが JOIN_MAX_TURN 以下のものだけをつながりとみなし、
 * 継ぎ目で曲がる角度の半分の tan（左へ曲がるとき正）を、JOIN_TAN を 32767 とした整数で入れる。
 */
function joinTangents(pos: Float32Array, color: Uint16Array, layer: Uint8Array): Int16Array {
  const n = Math.floor(pos.length / 4);
  const out = new Int16Array(n * 2).fill(NOT_JOINED);
  const minCos = Math.cos(JOIN_MAX_TURN);
  for (let i = 1; i < n; i++) {
    const a = (i - 1) * 4;
    const b = i * 4;
    if (pos[a + 2] !== pos[b] || pos[a + 3] !== pos[b + 1]) continue;
    if (color[i - 1] !== color[i] || layer[i - 1] !== layer[i]) continue;
    const ux = pos[a + 2] - pos[a], uy = pos[a + 3] - pos[a + 1];
    const vx = pos[b + 2] - pos[b], vy = pos[b + 3] - pos[b + 1];
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    const dot = ux * vx + uy * vy;
    if (!(lu > 0 && lv > 0) || dot / (lu * lv) < minCos) continue;
    // tan(θ/2) = sinθ / (1 + cosθ)
    const tan = (ux * vy - uy * vx) / (lu * lv + dot);
    const q = Math.max(-32767, Math.min(32767, Math.round((tan / JOIN_TAN) * 32767)));
    out[(i - 1) * 2 + 1] = q;
    out[i * 2] = q;
  }
  return out;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`シェーダのコンパイルに失敗: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`シェーダのリンクに失敗: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

export interface View {
  /** 画面中心の図面座標 */
  cx: number;
  cy: number;
  /** 図面 1mm あたりのデバイスピクセル数 */
  zoom: number;
}

interface LineUniforms {
  center: WebGLUniformLocation;
  scale: WebGLUniformLocation;
  pixel: WebGLUniformLocation;
  hw: WebGLUniformLocation;
  palette: WebGLUniformLocation;
  layers: WebGLUniformLocation;
  zoom: WebGLUniformLocation;
  winCenter: WebGLUniformLocation;
  dot: WebGLUniformLocation;
  pointMin: WebGLUniformLocation;
  dash: WebGLUniformLocation;
}

interface TriUniforms {
  center: WebGLUniformLocation;
  scale: WebGLUniformLocation;
  palette: WebGLUniformLocation;
  layers: WebGLUniformLocation;
  fillOffset: WebGLUniformLocation;
}

/** WebGL2 が使えない（ロックダウンモードなどで止められている）ときに投げる */
export class NoWebGL2Error extends Error {
  constructor() {
    super('WebGL2 が利用できません');
    this.name = 'NoWebGL2Error';
  }
}

export class Renderer {
  private gl: WebGL2RenderingContext;
  private lineProg!: WebGLProgram;
  private triProg!: WebGLProgram;
  private lineVao: WebGLVertexArrayObject | null = null;
  private triVao: WebGLVertexArrayObject | null = null;
  private dotVao: WebGLVertexArrayObject | null = null;
  private lineCount = 0;
  private triCount = 0;
  private dotCount = 0;
  /** 線種ごとの模様（uDash にそのまま渡す） */
  private dashes = new Uint32Array(DASH_STYLES * 2);
  private buffers: WebGLBuffer[] = [];
  private paletteTex: WebGLTexture | null = null;

  private uLine!: LineUniforms;
  private uTri!: TriUniforms;

  /** 背景色（0〜1） */
  private background: [number, number, number] = [0.043, 0.047, 0.063];

  readonly canvas: HTMLCanvasElement;

  /** 描画に使っているシーン。コンテキストが失われたときに積み直すために持つ */
  private scene: Scene | null = null;
  /** いま使っているパレット（RGBA）。同じく積み直し用 */
  private palette: Uint8Array = new Uint8Array([255, 255, 255, 255]);
  /** レイヤごとの表示（256 ビット）。既定はすべて表示 */
  private layerMask = new Uint32Array(8).fill(0xffffffff);
  private lost = false;
  /** コンテキストが戻ったときに呼ばれる。再描画のきっかけに使う */
  onRestored: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      desynchronized: true,
    });
    if (!gl) throw new NoWebGL2Error();
    this.gl = gl;
    this.setupPrograms();
    this.uploadPalette();

    // iOS ではタブを裏に回したり、他のアプリで GPU を使ったりすると
    // コンテキストが取り上げられる。既定では二度と戻らないので、自前で組み直す。
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.buffers = [];
      this.lineVao = null;
      this.triVao = null;
      this.dotVao = null;
      this.paletteTex = null;
      this.lineCount = 0;
      this.triCount = 0;
      this.dotCount = 0;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.rebuild();
    });
  }

  private setupPrograms(): void {
    const gl = this.gl;
    this.lineProg = link(gl, LINE_VS, LINE_FS);
    this.triProg = link(gl, TRI_VS, FS);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.uLine = {
      center: gl.getUniformLocation(this.lineProg, 'uCenter')!,
      scale: gl.getUniformLocation(this.lineProg, 'uScale')!,
      pixel: gl.getUniformLocation(this.lineProg, 'uPixel')!,
      hw: gl.getUniformLocation(this.lineProg, 'uHalfWidth')!,
      palette: gl.getUniformLocation(this.lineProg, 'uPalette')!,
      layers: gl.getUniformLocation(this.lineProg, 'uLayerMask')!,
      zoom: gl.getUniformLocation(this.lineProg, 'uZoom')!,
      winCenter: gl.getUniformLocation(this.lineProg, 'uWinCenter')!,
      dot: gl.getUniformLocation(this.lineProg, 'uDot')!,
      pointMin: gl.getUniformLocation(this.lineProg, 'uPointMin')!,
      dash: gl.getUniformLocation(this.lineProg, 'uDash')!,
    };
    this.uTri = {
      center: gl.getUniformLocation(this.triProg, 'uCenter')!,
      scale: gl.getUniformLocation(this.triProg, 'uScale')!,
      palette: gl.getUniformLocation(this.triProg, 'uPalette')!,
      layers: gl.getUniformLocation(this.triProg, 'uLayerMask')!,
      fillOffset: gl.getUniformLocation(this.triProg, 'uFillOffset')!,
    };
  }

  /** コンテキストが戻ったあとに、プログラムとバッファを作り直す */
  private rebuild(): void {
    this.lost = false;
    this.setupPrograms();
    this.uploadPalette();
    if (this.scene) this.setScene(this.scene);
    this.onRestored?.();
  }

  /** 描画できる状態か */
  get isLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }

  /** 背景色（0〜255） */
  setBackground(rgb: [number, number, number]): void {
    this.background = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
  }

  /**
   * 色番号ごとの表示色（RGBA、1 色 4 byte）を差し替える。
   * 背景の白黒や色ごとの表示・非表示はこれだけで反映され、線のバッファは作り直さない。
   * 色番号の数の 2 倍の色があれば、後ろの半分を塗り（三角形）の色に使う（buildPalette 参照）。
   */
  setPalette(rgba: Uint8Array): void {
    this.palette = rgba;
    if (this.isLost) return;
    this.uploadPalette();
  }

  /**
   * レイヤ（0〜255）ごとの表示を差し替える。1 なら表示。
   * 毎フレーム uniform で渡すので、コンテキストが戻ったときも自然に復元される。
   */
  setLayerVisibility(visible: Uint8Array): void {
    const mask = new Uint32Array(8);
    for (let k = 0; k < 256; k++) {
      if (visible[k]) mask[k >> 5] |= 1 << (k & 31);
    }
    this.layerMask = mask;
  }

  private uploadPalette(): void {
    const gl = this.gl;
    const count = Math.max(1, Math.ceil(this.palette.length / 4));
    const rows = Math.ceil(count / PALETTE_ROW);
    const data = new Uint8Array(PALETTE_ROW * rows * 4);
    data.set(this.palette.subarray(0, Math.min(this.palette.length, data.length)));

    if (!this.paletteTex) this.paletteTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PALETTE_ROW, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private newBuffer(target: number, data: ArrayBufferView): WebGLBuffer {
    const gl = this.gl;
    const buf = gl.createBuffer()!;
    gl.bindBuffer(target, buf);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    this.buffers.push(buf);
    return buf;
  }

  setScene(scene: Scene): void {
    this.scene = scene;
    if (this.isLost) return;
    const gl = this.gl;
    for (const b of this.buffers) gl.deleteBuffer(b);
    this.buffers = [];
    if (this.lineVao) gl.deleteVertexArray(this.lineVao);
    if (this.triVao) gl.deleteVertexArray(this.triVao);
    if (this.dotVao) gl.deleteVertexArray(this.dotVao);
    this.dotVao = null;

    // --- 線分（単位クアッドのインスタンス描画） ---
    this.lineCount = scene.linePos.length / 4;
    this.lineVao = gl.createVertexArray();
    gl.bindVertexArray(this.lineVao);

    const corners = new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]);
    const cornerBuf = this.newBuffer(gl.ARRAY_BUFFER, corners);
    const n = this.lineCount;
    this.lineAttributes(
      cornerBuf, scene.linePos, scene.lineColor, scene.lineLayer,
      joinTangents(scene.linePos, scene.lineColor, scene.lineLayer),
      // 線種を持たないシーン（検証で組み立てたものなど）は実線で描く
      scene.lineStyle ?? new Uint8Array(n), scene.lineDist ?? new Float32Array(n),
    );
    this.dashes = new Uint32Array(DASH_STYLES * 2);
    if (scene.dashes) this.dashes.set(scene.dashes.subarray(0, this.dashes.length));

    // --- 実点の丸（長さ 0 の線分として、線と同じシェーダで描く） ---
    const dots = scene.dotPos ?? new Float32Array(0);
    this.dotCount = Math.floor(dots.length / 3);
    if (this.dotCount > 0) {
      const m = this.dotCount;
      const pos = new Float32Array(m * 4);
      const radius = new Float32Array(m);
      for (let i = 0; i < m; i++) {
        pos[i * 4] = pos[i * 4 + 2] = dots[i * 3];
        pos[i * 4 + 1] = pos[i * 4 + 3] = dots[i * 3 + 1];
        radius[i] = dots[i * 3 + 2];
      }
      this.dotVao = gl.createVertexArray();
      gl.bindVertexArray(this.dotVao);
      this.lineAttributes(
        cornerBuf, pos, scene.dotColor, scene.dotLayer,
        new Int16Array(m * 2).fill(NOT_JOINED), new Uint8Array(m).fill(DOT_STYLE), radius,
      );
    }

    // --- 塗り三角形 ---
    this.triCount = scene.triPos.length / 2;
    this.triVao = gl.createVertexArray();
    gl.bindVertexArray(this.triVao);

    this.newBuffer(gl.ARRAY_BUFFER, scene.triPos);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.newBuffer(gl.ARRAY_BUFFER, scene.triColor);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_SHORT, 0, 0);

    this.newBuffer(gl.ARRAY_BUFFER, scene.triLayer);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_BYTE, 0, 0);

    gl.bindVertexArray(null);
  }

  /** いま結んでいる VAO に、線のシェーダの入力（線分ごとのインスタンス）を結ぶ */
  private lineAttributes(
    corners: WebGLBuffer, pos: Float32Array, color: Uint16Array, layer: Uint8Array,
    join: Int16Array, style: Uint8Array, dist: Float32Array,
  ): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.newBuffer(gl.ARRAY_BUFFER, pos);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    // 色番号は整数のままシェーダへ渡す
    this.newBuffer(gl.ARRAY_BUFFER, color);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_SHORT, 0, 0);
    gl.vertexAttribDivisor(2, 1);

    this.newBuffer(gl.ARRAY_BUFFER, layer);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_BYTE, 0, 0);
    gl.vertexAttribDivisor(3, 1);

    this.newBuffer(gl.ARRAY_BUFFER, join);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribIPointer(4, 2, gl.SHORT, 0, 0);
    gl.vertexAttribDivisor(4, 1);

    this.newBuffer(gl.ARRAY_BUFFER, style);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribIPointer(5, 1, gl.UNSIGNED_BYTE, 0, 0);
    gl.vertexAttribDivisor(5, 1);

    this.newBuffer(gl.ARRAY_BUFFER, dist);
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 1, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(6, 1);
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  draw(view: View, dpr: number): void {
    if (this.isLost) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.paint(view, 0, 0, this.canvas.width, this.canvas.height, dpr);
  }

  /**
   * 画面の一部を切り取って別のビューで描く（ルーペ用）。
   * x, y は左下原点のデバイスピクセル座標。
   */
  drawInset(view: View, x: number, y: number, w: number, h: number, dpr: number): void {
    if (this.isLost) return;
    const gl = this.gl;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, w, h);
    gl.viewport(x, y, w, h);
    // 拡大して見ている場所なので、線もそれらしく太くする
    this.paint(view, x, y, w, h, dpr, 1.6);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /** 左下が (x, y)、大きさ w × h のビューポート（デバイスピクセル）に描く */
  private paint(view: View, x: number, y: number, w: number, h: number, dpr: number, widthScale = 1): void {
    const gl = this.gl;

    gl.clearColor(this.background[0], this.background[1], this.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const sx = (2 * view.zoom) / w;
    const sy = (2 * view.zoom) / h;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);

    if (this.triCount > 0) {
      // パレットに塗り用の色が続いていれば、塗りはそちらで描く
      const colors = this.scene?.colorGroup?.length ?? 0;
      const fillOffset = colors > 0 && this.palette.length >= colors * 8 ? colors : 0;
      gl.useProgram(this.triProg);
      gl.uniform1i(this.uTri.palette, 0);
      gl.uniform1uiv(this.uTri.layers, this.layerMask);
      gl.uniform2f(this.uTri.center, view.cx, view.cy);
      gl.uniform2f(this.uTri.scale, sx, sy);
      gl.uniform1ui(this.uTri.fillOffset, fillOffset);
      gl.bindVertexArray(this.triVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.triCount);
    }

    if (this.lineCount > 0 || this.dotCount > 0) {
      gl.useProgram(this.lineProg);
      gl.uniform1i(this.uLine.palette, 0);
      gl.uniform1uiv(this.uLine.layers, this.layerMask);
      gl.uniform2f(this.uLine.center, view.cx, view.cy);
      gl.uniform2f(this.uLine.scale, sx, sy);
      gl.uniform2f(this.uLine.pixel, 2 / w, 2 / h);
      gl.uniform1f(this.uLine.hw, (lineWidthAt(view.zoom, dpr) * widthScale * dpr) / 2);
      gl.uniform1f(this.uLine.zoom, view.zoom);
      gl.uniform2f(this.uLine.winCenter, x + w / 2, y + h / 2);
      // 破線の模様と実点の大きさは画面の上で決まった大きさ。拡大鏡では線と同じく大きくする
      gl.uniform1f(this.uLine.dot, DASH_DOT * dpr * widthScale);
      gl.uniform1f(this.uLine.pointMin, POINT_MIN * dpr * widthScale);
      gl.uniform4uiv(this.uLine.dash, this.dashes);
      if (this.lineCount > 0) {
        gl.bindVertexArray(this.lineVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.lineCount);
      }
      // 実点は線の上に描く
      if (this.dotCount > 0 && this.dotVao) {
        gl.bindVertexArray(this.dotVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.dotCount);
      }
    }

    gl.bindVertexArray(null);
  }
}
