/**
 * Renderer-layer tests: Canvas2D + SVG backends, backend detection, the render
 * queue and the shared sizing helpers.
 *
 * ## Why there is a hand-written canvas double
 *
 * These tests run in Vitest's **Node** environment, where there is no `document`
 * and no `OffscreenCanvas`. Rather than depend on a DOM implementation, the file
 * below defines `createCanvasContextDouble()`: a small object implementing *only*
 * the `CanvasRenderingContext2D` members that
 * `Canvas2DRenderer`/`Canvas2DPainter` actually call. That is enough to prove the
 * renderer wires a context up, applies its DPR/camera transforms, clears, sizes
 * and disposes. Nothing is installed for it.
 *
 * Every string assertion on `SVGPath` is pure and needs no DOM at all.
 */

import { describe, expect, it } from 'vitest';

import { BackendNames } from '../../src/constants';
import {
  createMemorySink,
  getLoggingOptions,
  LogLevel,
  setLogLevel,
  setLogSink,
} from '../../src/utils/Logger';
import {
  Canvas2DRenderer,
  type Canvas2DRendererOptions,
} from '../../src/renderer/canvas2d/Canvas2DRenderer';
import { Canvas2DPainter } from '../../src/renderer/canvas2d/Canvas2DPainter';
import { Canvas2DState } from '../../src/renderer/canvas2d/Canvas2DState';
import {
  applyPixelProgram,
  BUILT_IN_PIXEL_PROGRAM_NAMES,
  BUILT_IN_PIXEL_PROGRAMS,
  Canvas2DShader,
  grayscaleProgram,
  invertProgram,
  sepiaProgram,
  thresholdProgram,
} from '../../src/renderer/canvas2d/Canvas2DShader';
import { RenderList, type Renderable2D } from '../../src/renderer/core/RenderList';
import { compareMaterialIds, RenderQueue } from '../../src/renderer/core/RenderQueue';
import { RenderState } from '../../src/renderer/core/RenderState';
import { Viewport } from '../../src/renderer/core/Viewport';
import { SVGRenderer } from '../../src/renderer/svg/SVGRenderer';
import { SVGPath } from '../../src/renderer/svg/SVGPath';
import { createCanvas, asCanvasLike, type CanvasLike } from '../../src/renderer/utils/createCanvas';
import { detectBackend, detectBackendStrict } from '../../src/renderer/utils/detectBackend';
import { getContext } from '../../src/renderer/utils/getContext';
import {
  computeMipmapCount,
  getTextureMemoryEstimate,
  isPowerOfTwoTexture,
  planPotResize,
  wouldResizeForPot,
} from '../../src/renderer/utils/textureUtils';

/* -------------------------------------------------------------------------- */
/* Hand-written canvas double                                                 */
/* -------------------------------------------------------------------------- */

/** A recorded call on the canvas double. */
interface RecordedCall {
  method: string;
  args: unknown[];
}

/**
 * Minimal `CanvasRenderingContext2D` double.
 *
 * Implements only what the renderer and painter call, and records every call so
 * the tests can assert on the transform/clear sequence.
 */
class CanvasContextDouble {
  public readonly calls: RecordedCall[] = [];

  public fillStyle: string | CanvasGradient | CanvasPattern = '#000000';
  public strokeStyle: string | CanvasGradient | CanvasPattern = '#000000';
  public lineWidth = 1;
  public lineCap = 'butt';
  public lineJoin = 'miter';
  public miterLimit = 10;
  public font = '10px sans-serif';
  public textAlign = 'start';
  public textBaseline = 'alphabetic';
  public globalAlpha = 1;
  public globalCompositeOperation: string = 'source-over';
  public shadowBlur = 0;
  public shadowColor = 'rgba(0, 0, 0, 0)';
  public shadowOffsetX = 0;
  public shadowOffsetY = 0;

  public readonly canvas = { width: 300, height: 150 };

  /** Number of `save()` calls without a matching `restore()`. */
  public depth = 0;

  /** Transformer matrix, as the canvas API exposes it. */
  private matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  /** Saved snapshots of the state members the renderer relies on. */
  private readonly stack: {
    matrix: { a: number; b: number; c: number; d: number; e: number; f: number };
    fillStyle: string | CanvasGradient | CanvasPattern;
  }[] = [];

  private record(method: string, args: unknown[] = []): void {
    this.calls.push({ method, args });
  }

  /** @returns `true` when `method` was called at least once. */
  public didCall(method: string): boolean {
    return this.calls.some((call) => call.method === method);
  }

  /** @returns The arguments of the first call to `method`, or `undefined`. */
  public firstCall(method: string): unknown[] | undefined {
    return this.calls.find((call) => call.method === method)?.args;
  }

  /** @returns Every recorded call to `method`, in order. */
  public callsOf(method: string): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  /* --------------------------------------------------------------- state stack */

  public save(): void {
    this.record('save');
    this.depth++;
    this.stack.push({ matrix: { ...this.matrix }, fillStyle: this.fillStyle });
  }

  public restore(): void {
    this.record('restore');
    this.depth--;
    const snapshot = this.stack.pop();
    if (snapshot !== undefined) {
      this.matrix = snapshot.matrix;
      this.fillStyle = snapshot.fillStyle;
    }
  }

  /* ----------------------------------------------------------------- transform */

  public setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.record('setTransform', [a, b, c, d, e, f]);
    this.matrix = { a, b, c, d, e, f };
  }

  public transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.record('transform', [a, b, c, d, e, f]);
    this.matrix = {
      a: this.matrix.a * a + this.matrix.c * b,
      b: this.matrix.b * a + this.matrix.d * b,
      c: this.matrix.a * c + this.matrix.c * d,
      d: this.matrix.b * c + this.matrix.d * d,
      e: this.matrix.a * e + this.matrix.c * f + this.matrix.e,
      f: this.matrix.b * e + this.matrix.d * f + this.matrix.f,
    };
  }

  public getTransform(): { a: number; b: number; c: number; d: number; e: number; f: number } {
    this.record('getTransform');
    return { ...this.matrix };
  }

  public translate(x: number, y: number): void {
    this.record('translate', [x, y]);
  }

  public rotate(radians: number): void {
    this.record('rotate', [radians]);
  }

  public scale(x: number, y: number): void {
    this.record('scale', [x, y]);
  }

  /* --------------------------------------------------------------------- paths */

  public beginPath(): void {
    this.record('beginPath');
  }

  public closePath(): void {
    this.record('closePath');
  }

  public moveTo(x: number, y: number): void {
    this.record('moveTo', [x, y]);
  }

  public lineTo(x: number, y: number): void {
    this.record('lineTo', [x, y]);
  }

  public bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.record('bezierCurveTo', [a, b, c, d, e, f]);
  }

  public quadraticCurveTo(a: number, b: number, c: number, d: number): void {
    this.record('quadraticCurveTo', [a, b, c, d]);
  }

  public arc(x: number, y: number, r: number, sa: number, ea: number, ccw?: boolean): void {
    this.record('arc', [x, y, r, sa, ea, ccw]);
  }

  public arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
    this.record('arcTo', [x1, y1, x2, y2, r]);
  }

  public ellipse(cx: number, cy: number, rx: number, ry: number): void {
    this.record('ellipse', [cx, cy, rx, ry]);
  }

  public rect(x: number, y: number, w: number, h: number): void {
    this.record('rect', [x, y, w, h]);
  }

  public roundRect(x: number, y: number, w: number, h: number, radii?: unknown): void {
    this.record('roundRect', [x, y, w, h, radii]);
  }

  public fill(): void {
    this.record('fill');
  }

  public stroke(): void {
    this.record('stroke');
  }

  public clip(path?: unknown): void {
    this.record('clip', [path]);
  }

  public fillRect(x: number, y: number, w: number, h: number): void {
    this.record('fillRect', [x, y, w, h]);
  }

  public strokeRect(x: number, y: number, w: number, h: number): void {
    this.record('strokeRect', [x, y, w, h]);
  }

  public clearRect(x: number, y: number, w: number, h: number): void {
    this.record('clearRect', [x, y, w, h]);
  }

  public drawImage(...args: unknown[]): void {
    this.record('drawImage', args);
  }

  /* ---------------------------------------------------------------------- text */

  public fillText(text: string, x: number, y: number): void {
    this.record('fillText', [text, x, y]);
  }

  public strokeText(text: string, x: number, y: number): void {
    this.record('strokeText', [text, x, y]);
  }

  public measureText(text: string): { width: number } {
    this.record('measureText', [text]);
    return { width: text.length * 8 };
  }

  /* ----------------------------------------------------------------- gradients */

  public createLinearGradient(x0: number, y0: number, x1: number, y1: number): unknown {
    this.record('createLinearGradient', [x0, y0, x1, y1]);
    return { addColorStop: () => undefined };
  }

  public createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): unknown {
    this.record('createRadialGradient', [x0, y0, r0, x1, y1, r1]);
    return { addColorStop: () => undefined };
  }

  public setLineDash(segments: number[]): void {
    this.record('setLineDash', [segments]);
  }

  /* --------------------------------------------------------------------- pixels */

  public getImageData(x: number, y: number, w: number, h: number): unknown {
    this.record('getImageData', [x, y, w, h]);
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }

  public putImageData(): void {
    this.record('putImageData');
  }
}

/** A canvas double whose `getContext` returns a {@link CanvasContextDouble}. */
class CanvasDouble implements CanvasLike {
  public width: number;
  public height: number;

  public readonly context: CanvasContextDouble = new CanvasContextDouble();

  /** `true` when `getContext` should report failure. */
  private readonly fail: boolean;

  constructor(width = 300, height = 150, fail = false) {
    this.width = width;
    this.height = height;
    this.fail = fail;
    this.context.canvas.width = width;
    this.context.canvas.height = height;
  }

  public getContext(contextId: string): unknown {
    return contextId === '2d' && !this.fail ? this.context : null;
  }

  public toDataURL(): string {
    return 'data:image/png;base64,';
  }
}

/** Builds renderer options around a canvas double. */
function canvas2dOptions(canvas: CanvasDouble, extra: Partial<Canvas2DRendererOptions> = {}): Canvas2DRendererOptions {
  return {
    // The renderer reads only `width`, `height` and `getContext` from the canvas,
    // so an untyped hand-written double is accepted at runtime by design.
    canvas: canvas as unknown as HTMLCanvasElement,
    width: 300,
    height: 150,
    pixelRatio: 1,
    clearColor: '#000000',
    ...extra,
  };
}

/* -------------------------------------------------------------------------- */
/* canvas creation                                                            */
/* -------------------------------------------------------------------------- */

describe('renderer/utils/createCanvas', () => {
  it('yields a canvas or throws a descriptive error, never both', () => {
    const hasCanvasImplementation =
      typeof (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas === 'function' ||
      typeof document !== 'undefined';

    if (hasCanvasImplementation) {
      const canvas = createCanvas({ width: 64, height: 32 });
      expect(canvas.width).toBeGreaterThanOrEqual(64);
      expect(canvas.height).toBeGreaterThanOrEqual(32);
      return;
    }

    // Node: no OffscreenCanvas and no DOM.
    expect(() => createCanvas({ width: 4, height: 4 })).toThrowError(/no canvas implementation is available/i);
  });

  it('names both accepted implementations in the error message', () => {
    try {
      createCanvas({ width: 4, height: 4 });
    } catch (error) {
      expect((error as Error).message).toContain('OffscreenCanvas');
      expect((error as Error).message).toContain('createElement');
      return;
    }
    // A canvas implementation exists here, so there is nothing to assert.
    expect(true).toBe(true);
  });

  it('recognises canvas-like objects through asCanvasLike', () => {
    const canvas = new CanvasDouble();
    expect(asCanvasLike(canvas)).toBe(canvas);
    expect(asCanvasLike({ width: 1, height: 1 })).toBeNull();
    expect(asCanvasLike(null)).toBeNull();
    expect(asCanvasLike('canvas')).toBeNull();
  });

  it('getContext throws a descriptive error when the context is missing', () => {
    const failing = new CanvasDouble(10, 10, true);
    expect(() => getContext(failing, '2d')).toThrowError(/could not create a '2d' context/i);
    expect(getContext(failing, '2d', { optional: true })).toBeNull();

    const canvas = new CanvasDouble();
    expect(getContext(canvas, '2d')).toBe(canvas.context);
  });
});

/* -------------------------------------------------------------------------- */
/* backend detection                                                          */
/* -------------------------------------------------------------------------- */

describe('renderer/utils/detectBackend', () => {
  it('falls back to canvas2d, and reports null in the strict variant', () => {
    const hasCanvas2d =
      typeof (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas === 'function' ||
      typeof document !== 'undefined';

    if (hasCanvas2d) {
      // In a canvas-capable runtime one of the usable backends is reported.
      expect(Object.values(BackendNames)).toContain(detectBackend());
      return;
    }

    // Node has no document, no OffscreenCanvas and no WebGL prototype, so nothing
    // is strictly usable; the non-strict call still honours the canvas2d fallback.
    expect(detectBackendStrict()).toBeNull();
    expect(detectBackend()).toBe(BackendNames.Canvas2D);
  });

  it('honours an explicit preference list and rejects unknown names', () => {
    const hasSvgDom =
      typeof document !== 'undefined' && typeof document.createElementNS === 'function';

    // A preferred backend is only honoured when it is actually usable.
    expect(detectBackend([BackendNames.SVG])).toBe(hasSvgDom ? BackendNames.SVG : BackendNames.Canvas2D);
    expect(detectBackendStrict([BackendNames.SVG])).toBe(hasSvgDom ? BackendNames.SVG : null);

    // Unknown names are dropped, leaving the documented fallback.
    expect(detectBackend('not-a-backend' as never)).toBe(BackendNames.Canvas2D);
  });

  it('detects a usable backend from a supplied canvas', () => {
    const canvas = new CanvasDouble();
    expect(detectBackend(undefined, canvas)).toBe(BackendNames.Canvas2D);
    expect(detectBackendStrict(undefined, canvas)).toBe(BackendNames.Canvas2D);

    const failing = new CanvasDouble(10, 10, true);
    expect(detectBackendStrict(undefined, failing)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* texture sizing helpers                                                     */
/* -------------------------------------------------------------------------- */

describe('renderer/utils/textureUtils', () => {
  it('computes mipmap counts for 1/2/64/300', () => {
    expect(computeMipmapCount(1, 1)).toBe(1);
    expect(computeMipmapCount(2, 2)).toBe(2);
    expect(computeMipmapCount(64, 64)).toBe(7);
    expect(computeMipmapCount(300, 300)).toBe(9);
  });

  it('uses the larger dimension and tolerates degenerate sizes', () => {
    expect(computeMipmapCount(64, 1)).toBe(7);
    expect(computeMipmapCount(0, 0)).toBe(1);
    expect(computeMipmapCount(Number.NaN, 8)).toBe(1);
  });

  it('detects power-of-two textures and plans resizes', () => {
    expect(isPowerOfTwoTexture({ width: 64, height: 64 })).toBe(true);
    expect(isPowerOfTwoTexture({ width: 300, height: 150 })).toBe(false);

    expect(wouldResizeForPot({ width: 64, height: 64 })).toBe(false);
    expect(wouldResizeForPot({ width: 300, height: 150 })).toBe(true);

    expect(planPotResize({ width: 300, height: 150 })).toMatchObject({
      ok: false,
      width: 512,
      height: 256,
      resized: true,
    });
    expect(planPotResize({ width: 64, height: 32 })).toMatchObject({ ok: true, resized: false, scaleX: 1 });
  });

  it('estimates texture memory including the mip chain', () => {
    // 4x4 rgba8 = 64 bytes. `computeMipmapCount(4, 4)` is 3, so the chain is
    // 4x4 + 2x2 + 1x1 = 64 + 16 + 4 = 84 bytes.
    expect(getTextureMemoryEstimate({ width: 4, height: 4 }, { includeMipmaps: false })).toBe(64);
    expect(getTextureMemoryEstimate({ width: 4, height: 4 })).toBe(84);
    expect(getTextureMemoryEstimate({ width: 4, height: 4 }, { faceCount: 6 })).toBe(84 * 6);
  });
});

/* -------------------------------------------------------------------------- */
/* Canvas2DRenderer                                                           */
/* -------------------------------------------------------------------------- */

describe('renderer/canvas2d/Canvas2DRenderer', () => {
  it('constructs with an injected canvas double and sizes the drawing buffer', () => {
    const canvas = new CanvasDouble();
    const renderer = new Canvas2DRenderer(canvas2dOptions(canvas, { width: 200, height: 100, pixelRatio: 2 }));

    expect(renderer.backend).toBe(BackendNames.Canvas2D);
    expect(renderer.isHeadless).toBe(false);
    expect(renderer.width).toBe(200);
    expect(renderer.height).toBe(100);
    expect(renderer.pixelRatio).toBe(2);
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(200);
    expect(renderer.getContext()).toBe(canvas.context);

    renderer.dispose();
    expect(renderer.isDisposed()).toBe(true);
  });

  it('supports clear(), setSize() and dispose() in any order', () => {
    const canvas = new CanvasDouble();
    const renderer = new Canvas2DRenderer(canvas2dOptions(canvas));

    expect(() => renderer.clear()).not.toThrow();
    expect(canvas.context.didCall('setTransform')).toBe(true);
    expect(canvas.context.didCall('fillRect')).toBe(true);
    expect(canvas.context.depth).toBe(0);

    expect(() => renderer.setSize(320, 240)).not.toThrow();
    expect(renderer.width).toBe(320);
    expect(renderer.height).toBe(240);
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(240);

    expect(() => renderer.setPixelRatio(3)).not.toThrow();
    expect(renderer.getPixelRatio()).toBe(3);
    expect(canvas.width).toBe(960);

    expect(() => renderer.clear('#ff0000')).not.toThrow();
    expect(() => renderer.dispose()).not.toThrow();
    expect(() => renderer.dispose()).not.toThrow(); // idempotent
  });

  it('applies the DPR base transform and clears to the configured colour', () => {
    const canvas = new CanvasDouble();
    const renderer = new Canvas2DRenderer(canvas2dOptions(canvas, { pixelRatio: 2, clearColor: '#102030' }));

    // The base transform is installed during construction: logical pixels in,
    // device pixels out.
    expect(canvas.context.firstCall('setTransform')).toEqual([2, 0, 0, 2, 0, 0]);

    canvas.context.calls.length = 0;
    renderer.clear();

    // clear() temporarily resets to device-pixel space so the background covers
    // the whole drawing buffer...
    expect(canvas.context.firstCall('setTransform')).toEqual([1, 0, 0, 1, 0, 0]);
    // 300x150 logical => 600x300 device pixels.
    expect(canvas.context.firstCall('fillRect')).toEqual([0, 0, 600, 300]);
    // ...and the DPR base transform is restored afterwards (the context double
    // implements save/restore including the transform).
    expect(canvas.context.getTransform()).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 });
    expect(renderer.clearColor).toMatchObject({ a: 1 });

    renderer.dispose();
  });

  it('dispatches render(painter) to collected 2D nodes', () => {
    const canvas = new CanvasDouble();
    const renderer = new Canvas2DRenderer(canvas2dOptions(canvas, { pixelRatio: 1 }));

    const seen: Canvas2DPainter[] = [];
    const node = {
      visible: true,
      id: 'node-a',
      render(painter: unknown): void {
        const surface = painter as Canvas2DPainter;
        seen.push(surface);
        surface.fillStyle = '#00ff00';
        surface.fillRect(1, 2, 3, 4);
      },
    };

    renderer.render({ visible: true, children: [node] }, { position: { x: 0, y: 0 }, zoom: 1 });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(renderer.painter);
    expect(canvas.context.didCall('fillRect')).toBe(true);
    expect(renderer.stats.drawCalls).toBeGreaterThan(0);

    renderer.dispose();
  });

  it('clips to the scissor rectangle instead of drawing outside it', () => {
    const canvas = new CanvasDouble();
    const renderer = new Canvas2DRenderer(canvas2dOptions(canvas));

    renderer.setScissor({ x: 10, y: 20, width: 30, height: 40 });
    expect(renderer.scissor).toEqual({ x: 10, y: 20, width: 30, height: 40 });

    // The rect() call carries the scissor rectangle.
    renderer.applyScissorClip();
    const rectArgs = canvas.context.callsOf('rect');
    expect(rectArgs).toContainEqual([10, 20, 30, 40]);
    expect(canvas.context.didCall('clip')).toBe(true);

    renderer.setScissor(null);
    expect(renderer.scissor).toBeNull();
    renderer.dispose();
  });

  it('clamps a scissor to the drawing buffer and drops an oversized one', () => {
    const canvas = new CanvasDouble();
    const renderer = new Canvas2DRenderer(canvas2dOptions(canvas, { width: 100, height: 50, pixelRatio: 1 }));

    renderer.setScissor({ x: -10, y: -10, width: 1000, height: 1000 });
    expect(renderer.scissor).toEqual({ x: 0, y: 0, width: 100, height: 50 });

    renderer.setScissor({ x: 500, y: 500, width: 10, height: 10 });
    expect(renderer.scissor).toMatchObject({ width: 0, height: 0 });
    renderer.dispose();
  });

  it('supports clear() and setSize() without a usable context, and warns on render()', () => {
    // A canvas that refuses a context: the renderer still constructs, sizes and
    // disposes cleanly, which is the documented Node degradation path.
    const failing = new CanvasDouble(320, 200, true);
    const renderer = new Canvas2DRenderer(canvas2dOptions(failing));

    expect(renderer.painter.headless).toBe(true);
    expect(renderer.getContext()).toBeNull();

    // Sizing/clearing/disposal stay safe...
    expect(() => renderer.setSize(64, 64)).not.toThrow();
    expect(() => renderer.clear()).not.toThrow();
    expect(renderer.width).toBe(64);

    // ...and render() reports the problem instead of failing silently.
    // `tests/setup.ts` raises the level to `Error`, so it is lowered for the
    // capture and restored immediately afterwards.
    const memory = createMemorySink();
    const previousLevel = getLoggingOptions().level;
    setLogLevel(LogLevel.Warn);
    setLogSink(memory.sink);
    try {
      expect(() => renderer.render(null, null)).not.toThrow();
    } finally {
      setLogSink(null);
      setLogLevel(previousLevel);
    }
    expect(memory.records.some((record) => /without a 2D context/.test(record.message))).toBe(true);

    expect(() => renderer.dispose()).not.toThrow();
  });

  it('reports info, stats and capabilities', () => {
    const canvas = new CanvasDouble();
    const renderer = new Canvas2DRenderer(canvas2dOptions(canvas, { width: 128, height: 64, pixelRatio: 2 }));

    const info = renderer.info;
    expect(info.backend).toBe(BackendNames.Canvas2D);
    expect(info.width).toBe(256);
    expect(info.height).toBe(128);
    expect(info.logicalWidth).toBe(128);
    expect(info.pixelRatio).toBe(2);
    expect(info.capabilities).toContain('immediate-mode');

    expect(renderer.stats).toMatchObject({ frame: 0, drawCalls: 0, triangles: 0 });
    expect(() => renderer.resetStats()).not.toThrow();

    renderer.dispose();
  });

  it('exposes a working Canvas2DPainter over the double', () => {
    const canvas = new CanvasDouble();
    const painter = new Canvas2DPainter(canvas.context as unknown as CanvasRenderingContext2D);

    painter.save();
    painter.beginPath();
    painter.moveTo(0, 0);
    painter.lineTo(10, 10);
    painter.bezierCurveTo(1, 1, 2, 2, 3, 3);
    painter.quadraticCurveTo(4, 4, 5, 5);
    painter.arc(0, 0, 5, 0, Math.PI);
    painter.arcTo(1, 1, 2, 2, 3);
    painter.rect(0, 0, 10, 10);
    painter.roundRect(0, 0, 10, 10, 2);
    painter.closePath();
    painter.fill();
    painter.stroke();
    painter.clip();
    painter.fillRect(0, 0, 1, 1);
    painter.strokeRect(0, 0, 1, 1);
    painter.clearRect(0, 0, 1, 1);
    painter.fillText('hi', 0, 0);
    painter.strokeText('hi', 0, 0);
    painter.setAlpha(0.5);
    painter.setLineDash([4, 2]);
    painter.polygon([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }], true);
    painter.restore();

    expect(painter.measureText('abc').width).toBe(24);
    expect(painter.fillStyle).toBeDefined();
    expect(painter.strokeStyle).toBeDefined();
    expect(painter.lineWidth).toBe(1);
    expect(painter.lineCap).toBe('butt');
    expect(painter.lineJoin).toBe('miter');
    expect(painter.miterLimit).toBe(10);
    expect(painter.font).toContain('sans-serif');
    expect(painter.textAlign).toBe('start');
    expect(painter.textBaseline).toBe('alphabetic');
    expect(painter.globalCompositeOperation).toBe('source-over');
    expect(painter.shadowBlur).toBe(0);
    expect(painter.shadowColor).toBeDefined();
    expect(painter.shadowOffsetX).toBe(0);
    expect(painter.shadowOffsetY).toBe(0);
    expect(painter.globalAlpha).toBeCloseTo(0.5);

    expect(painter.depth).toBe(0);
    expect(painter.commandCount).toBeGreaterThan(10);
    expect(painter.getTransform()).toHaveLength(6);
    expect(canvas.context.depth).toBe(0);
  });

  it('makes the painter a safe no-op without a context', () => {
    const painter = new Canvas2DPainter(null);
    expect(painter.headless).toBe(true);
    expect(painter.isReady).toBe(false);

    expect(() => {
      painter.save();
      painter.beginPath();
      painter.arc(0, 0, 1, 0, 1);
      painter.fill();
      painter.stroke();
      painter.clip();
      painter.fillRect(0, 0, 1, 1);
      painter.clearRect(0, 0, 1, 1);
      painter.fillText('x', 0, 0);
      painter.setAlpha(0.25);
      painter.setLineDash([1]);
      painter.restore();
      painter.restore(); // unbalanced, must not throw
    }).not.toThrow();

    expect(painter.measureText('x').width).toBe(0);
    expect(painter.createLinearGradient(0, 0, 1, 1)).toBeNull();
    expect(painter.createRadialGradient(0, 0, 0, 1, 1, 1)).toBeNull();
    expect(painter.getImageData(0, 0, 1, 1)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Canvas2DState                                                              */
/* -------------------------------------------------------------------------- */

describe('renderer/canvas2d/Canvas2DState', () => {
  it('clones, compares and applies', () => {
    const state = new Canvas2DState();
    state.fillStyle = '#ff0000';
    state.lineWidth = 3;
    state.globalAlpha = 0.5;

    const copy = state.clone();
    expect(copy.equals(state)).toBe(true);
    expect(copy.diff(state)).toEqual([]);
    expect(copy).not.toBe(state);

    copy.lineCap = 'round';
    expect(copy.equals(state)).toBe(false);
    expect(copy.diff(state)).toEqual(['lineCap']);

    const canvas = new CanvasDouble();
    copy.apply(canvas.context as unknown as Parameters<Canvas2DState['apply']>[0]);
    expect(canvas.context.lineCap).toBe('round');
    expect(canvas.context.lineWidth).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* SVGPath                                                                    */
/* -------------------------------------------------------------------------- */

describe('renderer/svg/SVGPath', () => {
  it('builds absolute line commands', () => {
    expect(new SVGPath().moveTo(0, 0).lineTo(10, 20).toString()).toBe('M 0 0 L 10 20');
    expect(new SVGPath().addSegment('M 0 0').horizontalTo(5).verticalTo(6).toString()).toBe('M 0 0 H 5 V 6');
  });

  it('builds relative commands with lower-case letters', () => {
    expect(new SVGPath().moveTo(1, 2).moveBy(3, 4).lineBy(5, 6).toString()).toBe('M 1 2 m 3 4 l 5 6');
    expect(new SVGPath().horizontalBy(7).verticalBy(8).toString()).toBe('h 7 v 8');
    expect(new SVGPath().close().toString()).toBe('Z');
  });

  it('builds rectangle paths', () => {
    expect(SVGPath.fromRect({ x: 1, y: 2, width: 3, height: 4 }).toString()).toBe(
      'M 1 2 L 4 2 L 4 6 L 1 6 Z',
    );
    expect(new SVGPath().addRect({ x: 0, y: 0, width: 2, height: 5 }).toString()).toBe(
      'M 0 0 h 2 v 5 h -2 Z',
    );
  });

  it('builds arc paths', () => {
    // Start at angle 0 => (1, 0); end at PI/2 => (~0, 1).
    const arc = SVGPath.fromArc(0, 0, 1, 0, Math.PI / 2).toString();
    expect(arc).toBe('M 1 0 A 1 1 0 0 1 0 1');

    // A quarter turn sweeps in the negative direction, so `sweep` stays 0.
    const clockwise = SVGPath.fromArc(0, 0, 1, 0, -Math.PI / 2).toString();
    expect(clockwise).toBe('M 1 0 A 1 1 0 0 0 0 -1');

    // Over half a turn the large-arc flag flips to 1.
    const large = new SVGPath().arc(2, 3, 45, true, false, 10, 10).toString();
    expect(large).toBe('A 2 3 45 1 0 10 10');

    expect(SVGPath.fromArc(0, 0, 0, 0, 1).toString()).toBe('');
    expect(SVGPath.fromArc(0, 0, 1, 1, 1).toString()).toBe('');
  });

  it('builds cubic and quadratic bezier paths', () => {
    expect(new SVGPath().curveTo(1, 2, 3, 4, 5, 6).toString()).toBe('C 1 2 3 4 5 6');
    expect(new SVGPath().curveBy(1, 2, 3, 4, 5, 6).toString()).toBe('c 1 2 3 4 5 6');
    expect(new SVGPath().smoothCurveTo(1, 2, 3, 4).toString()).toBe('S 1 2 3 4');
    expect(new SVGPath().smoothCurveBy(1, 2, 3, 4).toString()).toBe('s 1 2 3 4');
    expect(new SVGPath().quadraticTo(1, 2, 3, 4).toString()).toBe('Q 1 2 3 4');
    expect(new SVGPath().quadraticBy(1, 2, 3, 4).toString()).toBe('q 1 2 3 4');
    expect(new SVGPath().smoothQuadraticTo(1, 2).toString()).toBe('T 1 2');
    expect(new SVGPath().smoothQuadraticBy(1, 2).toString()).toBe('t 1 2');
  });

  it('builds point, polyline and polygon paths', () => {
    expect(SVGPath.fromPoints([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }]).toString()).toBe(
      'M 0 0 L 1 1 L 2 0 Z',
    );
    expect(SVGPath.fromPolyline([[0, 0], [1, 1]]).toString()).toBe('M 0 0 L 1 1');
    expect(SVGPath.fromPolygon([[0, 0], [1, 1]]).toString()).toBe('M 0 0 L 1 1 Z');
    expect(SVGPath.fromPoints([]).toString()).toBe('');
  });

  it('samples parametric curves structurally, without importing geometry', () => {
    // Anything exposing getPoint(t) works; this is a hand-rolled line curve.
    const line = { getPoint: (t: number) => ({ x: t * 10, y: t * 20 }) };
    const path = SVGPath.fromCurve(line, 2).toString();
    expect(path).toBe('M 0 0 L 5 10 L 10 20');

    // Divisions are clamped to at least one segment.
    expect(SVGPath.fromCurve(line, 0).toString()).toBe('M 0 0 L 10 20');
  });

  it('formats numbers without -0 and respects precision', () => {
    expect(new SVGPath().moveTo(-0, 0).toString()).toBe('M 0 0');
    expect(new SVGPath(2).moveTo(1.23456, 0).toString()).toBe('M 1.23 0');
    // Rounding a tiny negative value down to -0 must still serialise as 0.
    expect(new SVGPath(4).lineTo(-1e-9, 0).toString()).toBe('L 0 0');
  });

  it('reports length/isEmpty and supports clone/reset', () => {
    const path = new SVGPath().moveTo(0, 0).lineTo(1, 1);
    expect(path.length).toBe(2);
    expect(path.isEmpty).toBe(false);
    expect(path.getCommands()).toHaveLength(2);
    expect(path.toAttribute()).toBe(path.toString());

    const copy = path.clone();
    copy.lineTo(2, 2);
    expect(copy.length).toBe(3);
    expect(path.length).toBe(2);

    expect(path.reset().isEmpty).toBe(true);
    expect(new SVGPath().toString()).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* SVG renderer in Node                                                       */
/* -------------------------------------------------------------------------- */

describe('renderer/svg/SVGRenderer', () => {
  it('constructs, sizes, clears and disposes without a DOM', () => {
    const renderer = new SVGRenderer({ width: 400, height: 300, pixelRatio: 2 });

    expect(renderer.backend).toBe(BackendNames.SVG);
    expect(renderer.isHeadless).toBe(true);
    expect(renderer.isLive).toBe(false);
    expect(renderer.svg).toBeNull();
    expect(renderer.domElement).toBeNull();

    expect(() => renderer.setSize(320, 240)).not.toThrow();
    expect(renderer.width).toBe(320);
    expect(renderer.height).toBe(240);

    expect(() => renderer.clear()).not.toThrow();
    expect(() => renderer.setClearAlpha(0.5)).not.toThrow();
    expect(() => renderer.dispose()).not.toThrow();
    expect(renderer.isDisposed()).toBe(true);
  });

  it('throws from render() because there is nothing to paint into', () => {
    const renderer = new SVGRenderer({ width: 10, height: 10 });
    expect(() => renderer.render(null, null)).toThrowError(/SVGRenderer: render\(\) requires a DOM/);
    renderer.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* RenderQueue                                                                */
/* -------------------------------------------------------------------------- */

describe('renderer/core/RenderQueue', () => {
  /** Builds a renderable with an explicit id/material/renderOrder. */
  function makeRenderable(id: string, materialId?: string | number, renderOrder = 0): Renderable2D {
    return {
      visible: true,
      id,
      renderOrder,
      material: materialId === undefined ? null : { id: materialId },
      render(painter: unknown): void {
        void painter;
      },
    };
  }

  /** Builds a list entry directly, so depth/sequence can be controlled exactly. */
  function entry(
    object: Renderable2D,
    depth: number,
    sequence: number,
    renderOrder = 0,
    materialId?: string | number,
  ) {
    return { object, renderOrder, materialId, depth, transparent: false, sequence };
  }

  function sortEntries(items: ReturnType<typeof entry>[]) {
    const list = new RenderList<Renderable2D>();
    list.opaque.push(...items);
    const queue = new RenderQueue<Renderable2D>();
    queue.sort(list);
    return queue.order.map((item) => item.object.id);
  }

  it('sorts by renderOrder first', () => {
    const order = sortEntries([
      entry(makeRenderable('c'), 0, 0, 2),
      entry(makeRenderable('a'), 0, 1, -1),
      entry(makeRenderable('b'), 0, 2, 0),
    ]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('sorts by material id second', () => {
    const order = sortEntries([
      entry(makeRenderable('third'), 0, 0, 0, 30),
      entry(makeRenderable('first'), 0, 1, 0, 10),
      entry(makeRenderable('second'), 0, 2, 0, 20),
    ]);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('sorts by depth third', () => {
    const order = sortEntries([
      entry(makeRenderable('far'), 100, 0, 0, 1),
      entry(makeRenderable('near'), 1, 1, 0, 1),
      entry(makeRenderable('mid'), 50, 2, 0, 1),
    ]);
    expect(order).toEqual(['near', 'mid', 'far']);
  });

  it('falls back to submission order, making the sort stable', () => {
    const order = sortEntries([
      entry(makeRenderable('first'), 5, 0, 0, 1),
      entry(makeRenderable('second'), 5, 1, 0, 1),
      entry(makeRenderable('third'), 5, 2, 0, 1),
    ]);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('compares the three keys in the documented precedence', () => {
    // `renderOrder` is equal across all four entries, so the material key decides
    // first and depth only breaks ties inside one material.
    const order = sortEntries([
      entry(makeRenderable('materialB'), 999, 0, 0, 2),
      entry(makeRenderable('materialA'), 999, 1, 0, 1),
      entry(makeRenderable('materialADepthNear'), 1, 2, 0, 1),
      entry(makeRenderable('materialADepthFar'), 2, 3, 0, 1),
    ]);
    expect(order).toEqual(['materialADepthNear', 'materialADepthFar', 'materialA', 'materialB']);
  });

  it('lets renderOrder override material and depth', () => {
    const order = sortEntries([
      entry(makeRenderable('materialWins'), 999, 0, 0, 1),
      entry(makeRenderable('renderOrderWins'), 999, 1, -5, 999),
    ]);
    expect(order).toEqual(['renderOrderWins', 'materialWins']);
  });

  it('keeps the ordered bucket ahead of the opaque bucket', () => {
    const list = new RenderList<Renderable2D>();
    list.opaque.push(entry(makeRenderable('opaque'), 0, 0));
    list.ordered.push(entry(makeRenderable('ordered'), 0, 1, 3));
    const queue = new RenderQueue<Renderable2D>();
    queue.sort(list);
    expect(queue.order.map((item) => item.object.id)).toEqual(['ordered', 'opaque']);
  });

  it('puts identified materials before anonymous ones', () => {
    expect(compareMaterialIds(2, 10)).toBeLessThan(0);
    expect(compareMaterialIds('b', 'a')).toBeGreaterThan(0);
    expect(compareMaterialIds(1, 'a')).toBeLessThan(0); // numbers first
    expect(compareMaterialIds('a', 1)).toBeGreaterThan(0);
    expect(compareMaterialIds(undefined, 1)).toBeGreaterThan(0); // absent last
    expect(compareMaterialIds(1, undefined)).toBeLessThan(0);
    expect(compareMaterialIds(4, 4)).toBe(0);
  });

  it('sorts the transparent bucket back-to-front', () => {
    const list = new RenderList<Renderable2D>();
    list.transparent.push(
      entry(makeRenderable('near'), 1, 0),
      entry(makeRenderable('far'), 100, 1),
      entry(makeRenderable('mid'), 50, 2),
    );
    const queue = new RenderQueue<Renderable2D>();
    queue.sort(list);
    expect(queue.order.map((item) => item.object.id)).toEqual(['far', 'mid', 'near']);
  });

  it('reports a changed flag and produces a draw order', () => {
    const list = new RenderList<Renderable2D>();
    list.push(makeRenderable('a', 1));
    const queue = new RenderQueue<Renderable2D>();
    expect(queue.sort(list).changed).toBe(true);
    expect(queue.sort(list).changed).toBe(false);
    expect(queue.length).toBe(1);
    expect(queue.isEmpty).toBe(false);
    expect(queue.isSorted()).toBe(true);

    const drawOrder = queue.getDrawOrder();
    expect(drawOrder).toHaveLength(1);
    expect(drawOrder[0].index).toBe(0);

    queue.reset();
    expect(queue.isEmpty).toBe(true);
    expect(queue.isSorted()).toBe(false);
  });

  it('rejects invisible objects but counts them', () => {
    const list = new RenderList<Renderable2D>();
    const invisible = { ...makeRenderable('hidden'), visible: false } as Renderable2D;
    expect(list.push(invisible)).toBeNull();
    expect(list.culledCount).toBe(1);
    expect(list.isEmpty).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* RenderState                                                                */
/* -------------------------------------------------------------------------- */

describe('renderer/core/RenderState', () => {
  it('diffs to nothing when two states match', () => {
    const a = new RenderState();
    const b = new RenderState();
    expect(a.equals(b)).toBe(true);
    expect(a.diff(b)).toEqual({ changed: [], equal: true });
  });

  it('reports changed members in declaration order', () => {
    const current = new RenderState();
    const requested = new RenderState();
    requested.cull = current.cull === 'back' ? ('none' as never) : ('back' as never);
    requested.depth.write = !current.depth.write;
    requested.viewport = { x: 0, y: 0, width: 100, height: 50 };

    const diff = current.diff(requested);
    expect(diff.equal).toBe(false);
    expect(diff.changed).toContain('cull');
    expect(diff.changed).toContain('depth');
    expect(diff.changed).toContain('viewport');
    expect(diff.changed).not.toContain('blend');
    expect(diff.changed).not.toContain('scissor');
    expect(current.equals(requested)).toBe(false);
  });

  it('treats null as "everything differs"', () => {
    const state = new RenderState();
    expect(state.equals(null)).toBe(false);
    expect(state.diff(undefined).changed.length).toBeGreaterThan(6);
  });

  it('detects scissor and blend differences', () => {
    const current = new RenderState();
    const requested = current.clone();
    expect(current.equals(requested)).toBe(true);

    requested.scissor = { x: 1, y: 2, width: 3, height: 4 };
    expect(current.diff(requested).changed).toEqual(['scissor']);

    const blended = current.clone();
    blended.blend.enabled = true;
    blended.blend.srcFactor = blended.blend.srcFactor === 'one' ? ('src-alpha' as never) : ('one' as never);
    expect(current.diff(blended).changed).toEqual(['blend']);

    const written = current.clone();
    written.colorWrite.a = !current.colorWrite.a;
    expect(current.diff(written).changed).toEqual(['colorWrite']);
  });

  it('clone, copy and reset are consistent', () => {
    const state = new RenderState();
    state.cull = state.cull === 'back' ? ('none' as never) : ('back' as never);
    state.viewport = { x: 1, y: 1, width: 2, height: 2 };

    const copy = new RenderState().copy(state);
    expect(copy.equals(state)).toBe(true);
    expect(copy.viewport).not.toBe(state.viewport);

    const clone = state.clone();
    expect(clone.equals(state)).toBe(true);

    copy.reset();
    expect(copy.equals(state)).toBe(false);
    expect(copy.scissor).toBeNull();
  });

  it('exposes the documented 2D defaults', () => {
    const state = new RenderState();
    state.apply2DDefaults();
    expect(state.cull).toBe('none');
    expect(state.depth.test).toBe(false);
    expect(state.depth.write).toBe(false);
    expect(state.blend.enabled).toBe(true);
    expect(state.toString()).toContain('RenderState(');
  });
});

/* -------------------------------------------------------------------------- */
/* Canvas2DShader (pixel-program emulation)                                    */
/* -------------------------------------------------------------------------- */

describe('renderer/canvas2d/Canvas2DShader', () => {
  it('binds the nine built-in pixel programs and rejects real shader source', () => {
    expect(BUILT_IN_PIXEL_PROGRAM_NAMES).toEqual([
      'grayscale',
      'sepia',
      'invert',
      'brightness',
      'contrast',
      'saturate',
      'threshold',
      'blur',
      'tint',
    ]);
    for (const name of BUILT_IN_PIXEL_PROGRAM_NAMES) {
      expect(typeof BUILT_IN_PIXEL_PROGRAMS[name]).toBe('function');
    }

    const shader = new Canvas2DShader('grayscale');
    expect(shader.isCompiled).toBe(true);
    expect(shader.use()).toBe(true);
    expect(shader.pixelProgram).toBe(BUILT_IN_PIXEL_PROGRAMS['grayscale']);

    const glsl = shader.compile(null, 'void main() { gl_FragColor = vec4(1.0); }');
    expect(glsl.success).toBe(false);
    expect(glsl.log).toContain('GLSL/WGSL cannot be executed');
    expect(glsl.log).toContain('grayscale');
    expect(shader.isCompiled).toBe(false);
    expect(shader.pixelProgram).toBeNull();

    const wgsl = shader.compile(null, '@fragment\nfn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }');
    expect(wgsl.success).toBe(false);

    // An unknown *name* (no shader syntax) is rejected with the program list.
    expect(shader.compile(null, 'notAProgram').success).toBe(false);
    expect(shader.compile(null, 'invert').success).toBe(true);

    expect(shader.getAttributeLocation('position')).toBe(-1);
    expect(shader.getUniformLocation('amount')).toBe('amount');
    expect(shader.getUniformLocation('nope')).toBeNull();

    shader.dispose();
    expect(shader.isDisposed).toBe(true);
    expect(shader.use()).toBe(false);
  });

  it('applies a pixel program to a raw RGBA buffer', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);

    applyPixelProgram(data, 2, 1, invertProgram);
    expect(Array.from(data)).toEqual([0, 255, 255, 255, 255, 0, 255, 255]);

    // Grayscale collapses the channels to the luminance.
    applyPixelProgram(data, 2, 1, grayscaleProgram);
    expect(data[0]).toBe(data[1]);
    expect(data[1]).toBe(data[2]);

    const sepia = new Uint8ClampedArray([255, 255, 255, 255]);
    applyPixelProgram(sepia, 1, 1, sepiaProgram);
    expect(sepia[0]).toBeGreaterThan(sepia[2]); // warm tone

    const thresholded = new Uint8ClampedArray([10, 10, 10, 255, 250, 250, 250, 255]);
    applyPixelProgram(thresholded, 2, 1, thresholdProgram, { threshold: 128 });
    expect(Array.from(thresholded)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });
});

/* -------------------------------------------------------------------------- */
/* Barrel                                                                     */
/* -------------------------------------------------------------------------- */

describe('renderer/index', () => {
  it('re-exports the interfaces, core, utils, canvas2d and svg layers', async () => {
    const barrel = await import('../../src/renderer/index');

    // Interfaces (value + type vocabulary). `BackendNames` itself lives in
    // `src/constants.ts`, not in the renderer layer.
    expect(barrel.ClearFlags.All).toBe(7);
    expect(barrel.CullMode.Back).toBe('back');
    expect(barrel.PixelFormat.RGBA8).toBe('rgba8');
    expect(barrel.BlendFactor.SrcAlpha).toBe('src-alpha');
    expect(barrel.TextureFilter.Linear).toBe('linear');
    expect(barrel.PrimitiveTopology.Triangles).toBe('triangles');

    // Core.
    expect(typeof barrel.AbstractRenderer).toBe('function');
    expect(typeof barrel.RenderQueue).toBe('function');
    expect(typeof barrel.RenderState).toBe('function');
    expect(typeof barrel.RenderTarget).toBe('function');
    expect(typeof barrel.Viewport).toBe('function');
    expect(typeof barrel.Scissor).toBe('function');
    expect(typeof barrel.ClearState).toBe('function');

    // Utils.
    expect(typeof barrel.createCanvas).toBe('function');
    expect(typeof barrel.getContext).toBe('function');
    expect(typeof barrel.detectBackend).toBe('function');
    expect(typeof barrel.normalizeColor).toBe('function');
    expect(typeof barrel.computeMipmapCount).toBe('function');

    // Backends.
    expect(typeof barrel.Canvas2DRenderer).toBe('function');
    expect(typeof barrel.Canvas2DPainter).toBe('function');
    expect(typeof barrel.Canvas2DShader).toBe('function');
    expect(typeof barrel.Canvas2DTexture).toBe('function');
    expect(typeof barrel.SVGRenderer).toBe('function');
    expect(typeof barrel.SVGPainter).toBe('function');
    expect(typeof barrel.SVGPath).toBe('function');
    expect(typeof barrel.SVGDefs).toBe('function');
    expect(typeof barrel.SVGNodeFactory).toBe('function');
    expect(typeof barrel.SVGStyle).toBe('function');

    // A `Viewport` from the barrel is constructible, i.e. the class -- not the
    // structural interface -- wins the name collision.
    const viewport = new barrel.Viewport(1, 2, 3, 4);
    expect(viewport.toArray()).toEqual([1, 2, 3, 4]);
    expect(viewport.aspect).toBeCloseTo(0.75);
  });
});


/* -------------------------------------------------------------------------- */
/* Viewport                                                                   */
/* -------------------------------------------------------------------------- */

describe('renderer/core/Viewport', () => {
  it('computes aspect, area and arrays, and can be built from a canvas', () => {
    const viewport = new Viewport();
    viewport.setFromCanvas({ width: 1920, height: 1080 });
    expect(viewport.toArray()).toEqual([0, 0, 1920, 1080]);
    expect(viewport.aspect).toBeCloseTo(16 / 9);
    expect(viewport.area).toBe(1920 * 1080);
    expect(viewport.isEmpty).toBe(false);
    expect(viewport.equals({ x: 0, y: 0, width: 1920, height: 1080 })).toBe(true);

    const clone = viewport.clone();
    expect(clone.equals(viewport)).toBe(true);
    expect(clone).not.toBe(viewport);

    clone.set(1, 2, 0, 0);
    expect(clone.isEmpty).toBe(true);
    expect(clone.aspect).toBe(0);
    expect(clone.toObject()).toEqual({ x: 1, y: 2, width: 0, height: 0 });
  });
});
