/**
 * WebGL2 renderer: two instanced draws per frame. Rectangles (backgrounds,
 * selection, decorations, cursor) are solid quads; glyphs sample the shared
 * atlas and are tinted per instance. Context loss (common when a phone
 * backgrounds the page) is survived by rebuilding every GPU resource.
 */

import { type AtlasGlyph, type CellMetrics, GlyphAtlas } from './glyph-atlas';
import type { RendererCallbacks, TerminalRenderer } from './renderer';
import {
  cachedRowPaint,
  type GlyphOp,
  type Overlay,
  overlayPaint,
  type RectOp,
} from './row-paint';
import type { ScreenModel, TerminalTheme } from './screen-model';

const RECT_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_rect;
layout(location=2) in vec4 a_color;
uniform vec2 u_viewport;
out vec4 v_color;
void main() {
  vec2 p = a_rect.xy + a_corner * a_rect.zw;
  vec2 clip = p / u_viewport * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = a_color;
}`;

const RECT_FS = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 o_color;
void main() { o_color = v_color; }`;

const GLYPH_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_rect;
layout(location=2) in vec4 a_color;
layout(location=3) in vec2 a_uv;
uniform vec2 u_viewport;
uniform vec2 u_atlas;
out vec4 v_color;
out vec2 v_uv;
void main() {
  vec2 p = a_rect.xy + a_corner * a_rect.zw;
  vec2 clip = p / u_viewport * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = a_color;
  v_uv = (a_uv + a_corner * a_rect.zw) / u_atlas;
}`;

/** Alpha below one half marks a colour glyph: draw the atlas texel as is. */
const GLYPH_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec4 v_color;
in vec2 v_uv;
out vec4 o_color;
void main() {
  vec4 texel = texture(u_tex, v_uv);
  o_color = v_color.a < 0.5 ? texel : vec4(v_color.rgb, texel.a);
}`;

interface Gpu {
  gl: WebGL2RenderingContext;
  rectProgram: WebGLProgram;
  glyphProgram: WebGLProgram;
  rectVao: WebGLVertexArrayObject;
  glyphVao: WebGLVertexArrayObject;
  rectBuffer: WebGLBuffer;
  rectColorBuffer: WebGLBuffer;
  glyphBuffer: WebGLBuffer;
  glyphColorBuffer: WebGLBuffer;
  texture: WebGLTexture;
}

function compile(
  gl: WebGL2RenderingContext,
  vs: string,
  fs: string,
): WebGLProgram {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('createShader failed');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) ?? 'shader compile failed');
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? 'program link failed');
  return program;
}

export class WebGl2Renderer implements TerminalRenderer {
  readonly kind = 'webgl2' as const;
  private gpu: Gpu | null = null;
  private atlas: GlyphAtlas | null = null;
  private metrics: CellMetrics | null = null;
  private theme: TerminalTheme | null = null;
  private themeVersion = 0;
  private uploadedGeneration = -1;
  private lost = false;
  private suspended = false;
  private rectFloats = new Float32Array(4096);
  private rectColors = new Uint8Array(4096);
  private glyphFloats = new Float32Array(4096);
  private glyphColors = new Uint8Array(4096);
  private readonly onLost = (event: Event) => {
    event.preventDefault();
    this.lost = true;
    this.gpu = null;
  };
  private readonly onRestored = () => {
    this.lost = false;
    try {
      this.gpu = this.createGpu();
      this.uploadedGeneration = -1;
      this.callbacks.invalidated();
    } catch {
      this.callbacks.failed();
    }
  };

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: RendererCallbacks,
  ) {
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
  }

  /** Null when the browser offers no WebGL2. */
  static create(
    canvas: HTMLCanvasElement,
    callbacks: RendererCallbacks,
  ): WebGl2Renderer | null {
    const renderer = new WebGl2Renderer(canvas, callbacks);
    try {
      renderer.gpu = renderer.createGpu();
      return renderer;
    } catch {
      renderer.dispose();
      return null;
    }
  }

  private context(): WebGL2RenderingContext {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    return gl;
  }

  private createGpu(): Gpu {
    const gl = this.context();
    const rectProgram = compile(gl, RECT_VS, RECT_FS);
    const glyphProgram = compile(gl, GLYPH_VS, GLYPH_FS);
    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    const vao = (withUv: boolean) => {
      const array = gl.createVertexArray();
      gl.bindVertexArray(array);
      gl.bindBuffer(gl.ARRAY_BUFFER, corners);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const floats = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, floats);
      const stride = (withUv ? 6 : 4) * 4;
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
      gl.vertexAttribDivisor(1, 1);
      if (withUv) {
        gl.enableVertexAttribArray(3);
        gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 16);
        gl.vertexAttribDivisor(3, 1);
      }
      const colors = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, colors);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.vertexAttribDivisor(2, 1);
      gl.bindVertexArray(null);
      return { array, floats, colors };
    };
    const rect = vao(false);
    const glyph = vao(true);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    return {
      gl,
      rectProgram,
      glyphProgram,
      rectVao: rect.array,
      glyphVao: glyph.array,
      rectBuffer: rect.floats,
      rectColorBuffer: rect.colors,
      glyphBuffer: glyph.floats,
      glyphColorBuffer: glyph.colors,
      texture,
    };
  }

  resize(cols: number, rows: number, metrics: CellMetrics): void {
    const metricsChanged =
      !this.metrics ||
      this.metrics.width !== metrics.width ||
      this.metrics.height !== metrics.height ||
      this.metrics.font !== metrics.font;
    this.metrics = metrics;
    this.canvas.width = Math.max(1, cols * metrics.width);
    this.canvas.height = Math.max(1, rows * metrics.height);
    this.canvas.style.width = `${(cols * metrics.width) / metrics.dpr}px`;
    this.canvas.style.height = `${(rows * metrics.height) / metrics.dpr}px`;
    if (!this.atlas) {
      const max =
        this.gpu?.gl.getParameter(this.gpu.gl.MAX_TEXTURE_SIZE) ?? 2048;
      this.atlas = new GlyphAtlas(metrics, Math.min(2048, max));
    } else if (metricsChanged) this.atlas.setMetrics(metrics);
  }

  setTheme(theme: TerminalTheme): void {
    this.theme = theme;
    this.themeVersion += 1;
  }

  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    // Give the context back so hidden terminals do not hold GPU memory or
    // count against the browser's context limit.
    this.gpu?.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    if (this.lost) {
      const ext = this.canvas
        .getContext('webgl2')
        ?.getExtension('WEBGL_lose_context');
      ext?.restoreContext();
    }
  }

  render(model: ScreenModel, overlay: Overlay): void {
    const gpu = this.gpu;
    const metrics = this.metrics;
    const theme = this.theme;
    const atlas = this.atlas;
    if (!gpu || !metrics || !theme || !atlas || this.lost || this.suspended)
      return;
    const colors = model.colors;
    if (!colors) return;

    const key = `${this.themeVersion}:${metrics.width}x${metrics.height}`;
    const baseRects: RectOp[] = [];
    const baseGlyphs: GlyphOp[] = [];
    model.rows.forEach((row, y) => {
      const paint = cachedRowPaint(row, colors, theme, metrics, key);
      const top = y * metrics.height;
      for (const r of paint.rects) baseRects.push({ ...r, y: r.y + top });
      for (const g of paint.glyphs) baseGlyphs.push({ ...g, y: g.y + top });
    });
    const over = overlayPaint(model, theme, metrics, overlay);

    // Rasterize missing glyphs; on overflow clear the atlas and try once more.
    const all = [...baseGlyphs, ...over.glyphs];
    let tiles = this.tiles(all);
    if (!tiles) {
      atlas.reset();
      tiles = this.tiles(all) ?? [];
    }
    this.uploadAtlas(gpu, atlas);

    const gl = gpu.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const bg = colors.background;
    gl.clearColor(
      ((bg >> 16) & 0xff) / 255,
      ((bg >> 8) & 0xff) / 255,
      (bg & 0xff) / 255,
      1,
    );
    gl.clear(gl.COLOR_BUFFER_BIT);
    // Row backgrounds and decorations, row glyphs, then cursor and link marks.
    this.drawRects(gpu, baseRects);
    this.drawGlyphs(gpu, atlas, baseGlyphs, tiles.slice(0, baseGlyphs.length));
    this.drawRects(gpu, over.rects);
    this.drawGlyphs(gpu, atlas, over.glyphs, tiles.slice(baseGlyphs.length));
    gl.bindVertexArray(null);
  }

  private drawRects(gpu: Gpu, rects: RectOp[]): void {
    if (!rects.length) return;
    const gl = gpu.gl;
    this.ensure(rects.length, 0);
    rects.forEach((r, i) => {
      this.rectFloats.set([r.x, r.y, r.width, r.height], i * 4);
      this.rectColors.set(
        [
          (r.color >> 16) & 0xff,
          (r.color >> 8) & 0xff,
          r.color & 0xff,
          Math.round(r.alpha * 255),
        ],
        i * 4,
      );
    });
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook.
    gl.useProgram(gpu.rectProgram);
    gl.uniform2f(
      gl.getUniformLocation(gpu.rectProgram, 'u_viewport'),
      this.canvas.width,
      this.canvas.height,
    );
    gl.bindVertexArray(gpu.rectVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.rectBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.rectFloats.subarray(0, rects.length * 4),
      gl.STREAM_DRAW,
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.rectColorBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.rectColors.subarray(0, rects.length * 4),
      gl.STREAM_DRAW,
    );
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, rects.length);
  }

  private drawGlyphs(
    gpu: Gpu,
    atlas: GlyphAtlas,
    glyphs: GlyphOp[],
    tiles: AtlasGlyph[],
  ): void {
    if (!glyphs.length) return;
    const gl = gpu.gl;
    this.ensure(0, glyphs.length);
    let count = 0;
    glyphs.forEach((op, i) => {
      const tile = tiles[i];
      if (!tile) return;
      this.glyphFloats.set(
        [op.x, op.y, tile.width, tile.height, tile.x, tile.y],
        count * 6,
      );
      this.glyphColors.set(
        [
          (op.color >> 16) & 0xff,
          (op.color >> 8) & 0xff,
          op.color & 0xff,
          tile.colored ? 0 : 255,
        ],
        count * 4,
      );
      count += 1;
    });
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook.
    gl.useProgram(gpu.glyphProgram);
    gl.uniform2f(
      gl.getUniformLocation(gpu.glyphProgram, 'u_viewport'),
      this.canvas.width,
      this.canvas.height,
    );
    gl.uniform2f(
      gl.getUniformLocation(gpu.glyphProgram, 'u_atlas'),
      atlas.size,
      atlas.size,
    );
    gl.uniform1i(gl.getUniformLocation(gpu.glyphProgram, 'u_tex'), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, gpu.texture);
    gl.bindVertexArray(gpu.glyphVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.glyphBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.glyphFloats.subarray(0, count * 6),
      gl.STREAM_DRAW,
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.glyphColorBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.glyphColors.subarray(0, count * 4),
      gl.STREAM_DRAW,
    );
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
  }

  private tiles(glyphs: GlyphOp[]): AtlasGlyph[] | null {
    const atlas = this.atlas!;
    const out: AtlasGlyph[] = [];
    for (const op of glyphs) {
      const tile = atlas.glyph(
        op.text,
        op.codepoint,
        op.span,
        op.bold,
        op.italic,
      );
      if (!tile) return null;
      out.push(tile);
    }
    return out;
  }

  private uploadAtlas(gpu: Gpu, atlas: GlyphAtlas): void {
    const gl = gpu.gl;
    gl.bindTexture(gl.TEXTURE_2D, gpu.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (this.uploadedGeneration !== atlas.generation) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        atlas.size,
        atlas.size,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      this.uploadedGeneration = atlas.generation;
    }
    const dirty = atlas.takeDirty();
    if (dirty && dirty.width > 0 && dirty.height > 0)
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        dirty.x,
        dirty.y,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        atlas.imageData(dirty),
      );
  }

  private ensure(rects: number, glyphs: number): void {
    if (this.rectFloats.length < rects * 4) {
      this.rectFloats = new Float32Array(rects * 8);
      this.rectColors = new Uint8Array(rects * 8);
    }
    if (this.glyphFloats.length < glyphs * 6) {
      this.glyphFloats = new Float32Array(glyphs * 12);
      this.glyphColors = new Uint8Array(glyphs * 8);
    }
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.gpu?.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.gpu = null;
  }
}
