import type { Scene } from './geometry.ts';

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

const LINE_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aSeg;
layout(location = 2) in uint aColorIndex;
layout(location = 3) in uint aLayer;

uniform vec2 uCenter;
uniform vec2 uScale;
uniform vec2 uPixel;
uniform float uHalfWidth;
${PALETTE_LOOKUP}

out vec3 vColor;
out float vEdge;
out float vHalfPx;

void main() {
  vec4 pc = paletteColor(aColorIndex);
  vColor = pc.rgb;
  vHalfPx = uHalfWidth;
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

  vec2 base = mix(p1, p2, aCorner.x);
  vec2 clip = (base - uCenter) * uScale;
  // 線幅ぶんの押し出しと、継ぎ目を埋めるための端の張り出し
  vec2 side = nrm * aCorner.y * halfW * uPixel;
  vec2 cap = dir * (aCorner.x * 2.0 - 1.0) * halfW * uPixel;

  gl_Position = vec4(clip + side + cap, 0.0, 1.0);
  vEdge = aCorner.y * halfW;
}`;

const TRI_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in uint aColorIndex;
layout(location = 2) in uint aLayer;

uniform vec2 uCenter;
uniform vec2 uScale;
${PALETTE_LOOKUP}

out vec3 vColor;

void main() {
  vec4 pc = paletteColor(aColorIndex);
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
 */
const LINE_FS = `#version 300 es
precision mediump float;
in vec3 vColor;
in float vEdge;
in float vHalfPx;
out vec4 fragColor;
void main() {
  float dist = abs(vEdge);
  float a = clamp(vHalfPx + 0.5 - dist, 0.0, 1.0);
  if (a <= 0.003) discard;
  fragColor = vec4(vColor, a);
}`;

/** パレットのテクスチャ 1 行に並べる色数 */
const PALETTE_ROW = 256;

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
}

interface TriUniforms {
  center: WebGLUniformLocation;
  scale: WebGLUniformLocation;
  palette: WebGLUniformLocation;
  layers: WebGLUniformLocation;
}

export class Renderer {
  private gl: WebGL2RenderingContext;
  private lineProg!: WebGLProgram;
  private triProg!: WebGLProgram;
  private lineVao: WebGLVertexArrayObject | null = null;
  private triVao: WebGLVertexArrayObject | null = null;
  private lineCount = 0;
  private triCount = 0;
  private buffers: WebGLBuffer[] = [];
  private paletteTex: WebGLTexture | null = null;

  private uLine!: LineUniforms;
  private uTri!: TriUniforms;

  /** 線の太さ（CSS ピクセル） */
  lineWidth = 1.15;
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
    if (!gl) throw new Error('WebGL2 が利用できません');
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
      this.paletteTex = null;
      this.lineCount = 0;
      this.triCount = 0;
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
    };
    this.uTri = {
      center: gl.getUniformLocation(this.triProg, 'uCenter')!,
      scale: gl.getUniformLocation(this.triProg, 'uScale')!,
      palette: gl.getUniformLocation(this.triProg, 'uPalette')!,
      layers: gl.getUniformLocation(this.triProg, 'uLayerMask')!,
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

    // --- 線分（単位クアッドのインスタンス描画） ---
    this.lineCount = scene.linePos.length / 4;
    this.lineVao = gl.createVertexArray();
    gl.bindVertexArray(this.lineVao);

    const corners = new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]);
    this.newBuffer(gl.ARRAY_BUFFER, corners);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.newBuffer(gl.ARRAY_BUFFER, scene.linePos);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    // 色番号は整数のままシェーダへ渡す
    this.newBuffer(gl.ARRAY_BUFFER, scene.lineColor);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_SHORT, 0, 0);
    gl.vertexAttribDivisor(2, 1);

    this.newBuffer(gl.ARRAY_BUFFER, scene.lineLayer);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_BYTE, 0, 0);
    gl.vertexAttribDivisor(3, 1);

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
    this.paint(view, this.canvas.width, this.canvas.height, dpr);
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
    this.paint(view, w, h, dpr, 1.6);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  private paint(view: View, w: number, h: number, dpr: number, widthScale = 1): void {
    const gl = this.gl;

    gl.clearColor(this.background[0], this.background[1], this.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const sx = (2 * view.zoom) / w;
    const sy = (2 * view.zoom) / h;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);

    if (this.triCount > 0) {
      gl.useProgram(this.triProg);
      gl.uniform1i(this.uTri.palette, 0);
      gl.uniform1uiv(this.uTri.layers, this.layerMask);
      gl.uniform2f(this.uTri.center, view.cx, view.cy);
      gl.uniform2f(this.uTri.scale, sx, sy);
      gl.bindVertexArray(this.triVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.triCount);
    }

    if (this.lineCount > 0) {
      gl.useProgram(this.lineProg);
      gl.uniform1i(this.uLine.palette, 0);
      gl.uniform1uiv(this.uLine.layers, this.layerMask);
      gl.uniform2f(this.uLine.center, view.cx, view.cy);
      gl.uniform2f(this.uLine.scale, sx, sy);
      gl.uniform2f(this.uLine.pixel, 2 / w, 2 / h);
      gl.uniform1f(this.uLine.hw, (this.lineWidth * widthScale * dpr) / 2);
      gl.bindVertexArray(this.lineVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.lineCount);
    }

    gl.bindVertexArray(null);
  }
}
