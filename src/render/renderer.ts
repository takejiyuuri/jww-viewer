import type { Scene } from './geometry.ts';

const LINE_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aSeg;
layout(location = 2) in vec3 aColor;

uniform vec2 uCenter;
uniform vec2 uScale;
uniform vec2 uPixel;
uniform float uHalfWidth;

out vec3 vColor;

void main() {
  vec2 p1 = aSeg.xy;
  vec2 p2 = aSeg.zw;
  vec2 d = p2 - p1;
  float len = length(d);
  vec2 dir = len > 0.0 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);

  vec2 base = mix(p1, p2, aCorner.x);
  vec2 clip = (base - uCenter) * uScale;
  // 線幅ぶんの押し出しと、継ぎ目を埋めるための端の張り出し
  vec2 side = nrm * aCorner.y * uHalfWidth * uPixel;
  vec2 cap = dir * (aCorner.x * 2.0 - 1.0) * uHalfWidth * uPixel;

  gl_Position = vec4(clip + side + cap, 0.0, 1.0);
  vColor = aColor;
}`;

const TRI_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec3 aColor;

uniform vec2 uCenter;
uniform vec2 uScale;

out vec3 vColor;

void main() {
  gl_Position = vec4((aPos - uCenter) * uScale, 0.0, 1.0);
  vColor = aColor;
}`;

const FS = `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 fragColor;
void main() {
  fragColor = vec4(vColor, 1.0);
}`;

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

export class Renderer {
  private gl: WebGL2RenderingContext;
  private lineProg: WebGLProgram;
  private triProg: WebGLProgram;
  private lineVao: WebGLVertexArrayObject | null = null;
  private triVao: WebGLVertexArrayObject | null = null;
  private lineCount = 0;
  private triCount = 0;
  private buffers: WebGLBuffer[] = [];

  private uLine: { center: WebGLUniformLocation; scale: WebGLUniformLocation; pixel: WebGLUniformLocation; hw: WebGLUniformLocation };
  private uTri: { center: WebGLUniformLocation; scale: WebGLUniformLocation };

  /** 線の太さ（CSS ピクセル） */
  lineWidth = 1.15;
  background: [number, number, number] = [0.043, 0.047, 0.063];

  readonly canvas: HTMLCanvasElement;

  /** 描画に使っているシーン。コンテキストが失われたときに積み直すために持つ */
  private scene: Scene | null = null;
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

    this.lineProg = link(gl, LINE_VS, FS);
    this.triProg = link(gl, TRI_VS, FS);

    this.uLine = {
      center: gl.getUniformLocation(this.lineProg, 'uCenter')!,
      scale: gl.getUniformLocation(this.lineProg, 'uScale')!,
      pixel: gl.getUniformLocation(this.lineProg, 'uPixel')!,
      hw: gl.getUniformLocation(this.lineProg, 'uHalfWidth')!,
    };
    this.uTri = {
      center: gl.getUniformLocation(this.triProg, 'uCenter')!,
      scale: gl.getUniformLocation(this.triProg, 'uScale')!,
    };

    // iOS ではタブを裏に回したり、他のアプリで GPU を使ったりすると
    // コンテキストが取り上げられる。既定では二度と戻らないので、自前で組み直す。
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.buffers = [];
      this.lineVao = null;
      this.triVao = null;
      this.lineCount = 0;
      this.triCount = 0;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.rebuild();
    });
  }

  /** コンテキストが戻ったあとに、プログラムとバッファを作り直す */
  private rebuild(): void {
    const gl = this.gl;
    this.lost = false;
    this.lineProg = link(gl, LINE_VS, FS);
    this.triProg = link(gl, TRI_VS, FS);
    this.uLine = {
      center: gl.getUniformLocation(this.lineProg, 'uCenter')!,
      scale: gl.getUniformLocation(this.lineProg, 'uScale')!,
      pixel: gl.getUniformLocation(this.lineProg, 'uPixel')!,
      hw: gl.getUniformLocation(this.lineProg, 'uHalfWidth')!,
    };
    this.uTri = {
      center: gl.getUniformLocation(this.triProg, 'uCenter')!,
      scale: gl.getUniformLocation(this.triProg, 'uScale')!,
    };
    if (this.scene) this.setScene(this.scene);
    this.onRestored?.();
  }

  /** 描画できる状態か */
  get isLost(): boolean {
    return this.lost || this.gl.isContextLost();
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

    this.newBuffer(gl.ARRAY_BUFFER, scene.lineCol);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.vertexAttribDivisor(2, 1);

    // --- 塗り三角形 ---
    this.triCount = scene.triPos.length / 2;
    this.triVao = gl.createVertexArray();
    gl.bindVertexArray(this.triVao);

    this.newBuffer(gl.ARRAY_BUFFER, scene.triPos);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.newBuffer(gl.ARRAY_BUFFER, scene.triCol);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.UNSIGNED_BYTE, true, 0, 0);

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
    this.paint(view, w, h, dpr);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  private paint(view: View, w: number, h: number, dpr: number): void {
    const gl = this.gl;

    gl.clearColor(this.background[0], this.background[1], this.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const sx = (2 * view.zoom) / w;
    const sy = (2 * view.zoom) / h;

    if (this.triCount > 0) {
      gl.useProgram(this.triProg);
      gl.uniform2f(this.uTri.center, view.cx, view.cy);
      gl.uniform2f(this.uTri.scale, sx, sy);
      gl.bindVertexArray(this.triVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.triCount);
    }

    if (this.lineCount > 0) {
      gl.useProgram(this.lineProg);
      gl.uniform2f(this.uLine.center, view.cx, view.cy);
      gl.uniform2f(this.uLine.scale, sx, sy);
      gl.uniform2f(this.uLine.pixel, 2 / w, 2 / h);
      gl.uniform1f(this.uLine.hw, (this.lineWidth * dpr) / 2);
      gl.bindVertexArray(this.lineVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.lineCount);
    }

    gl.bindVertexArray(null);
  }
}
