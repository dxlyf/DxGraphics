/**
 * Effects — what the Canvas2D backend gives you instead of a post-processing pass.
 *
 * Read this first
 * ---------------
 * **`src/effects/` is an empty directory in this checkout**: there is no
 * `EffectComposer`, no bloom, no shadow-map pass and no `Fog` implementation. A GPU
 * post-processing layer needs render targets, and `Canvas2DRenderer.createRenderTarget`
 * deliberately throws — the 2D backend can only draw into its own canvas.
 *
 * What *is* available and is demonstrated here is the compositing toolkit the 2D
 * backend exposes through the painter:
 *
 * - `globalCompositeOperation` — the CSS blend modes plus `source-atop`, `destination-out`, etc.;
 * - `shadowBlur` / `shadowColor` / `shadowOffsetX` / `shadowOffsetY` for cheap glows;
 * - `createLinearGradient` / `createRadialGradient` / `createConicGradient`;
 * - `clip()` for masked work;
 * - an offscreen `<canvas>` used as a texture through `drawImage`, which is how you
 *   fake a render target on the CPU backend;
 * - `globalAlpha` for layering.
 *
 * The offscreen buffer is the important one: it is the practical substitute for
 * render-to-texture on this backend, and the example shows the full cycle of
 * allocating it once, redrawing it, and blitting it.
 *
 * What to look for
 * ----------------
 * A shadowed, gradient-lit card; a row of swatches each compositing the same two
 * shapes with a different blend mode; a masked "spotlight" region; and a rotating
 * offscreen-rendered badge blitted into the scene. The overlay names the blend mode
 * under the cursor and reports the offscreen buffer size.
 */

import {
  BackendNames,
  Canvas2DRenderer,
  Color,
  detectBackendStrict,
  type BackendName,
  type Canvas2DPainter,
  type Renderable2D,
} from '../../src/index';

/* -------------------------------------------------------------------------- */
/* Offscreen buffer: the CPU stand-in for a render target                     */
/* -------------------------------------------------------------------------- */

/**
 * Allocates and owns an offscreen canvas.
 *
 * `document.createElement('canvas')` is used rather than `OffscreenCanvas` because
 * `drawImage` accepts a plain canvas in every browser, while `OffscreenCanvas`
 * support in `drawImage` is narrower.
 */
class OffscreenBuffer {
  public readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;

  public constructor(size: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    this.context = this.canvas.getContext('2d');
  }

  /** `true` when the buffer can actually be drawn into. */
  public get isUsable(): boolean {
    return this.context !== null;
  }

  /** Redraws the buffer's contents. Called at most a few times per second. */
  public redraw(phase: number, tint: string): void {
    const ctx = this.context;
    if (!ctx) return;

    const size = this.canvas.width;
    const center = size / 2;
    ctx.clearRect(0, 0, size, size);

    const sweep = ctx.createConicGradient?.(phase, center, center);
    if (sweep) {
      sweep.addColorStop(0, tint);
      sweep.addColorStop(0.5, 'rgba(13, 16, 23, 0.1)');
      sweep.addColorStop(1, tint);
      ctx.fillStyle = sweep;
    } else {
      ctx.fillStyle = tint;
    }
    ctx.beginPath();
    ctx.arc(center, center, center * 0.86, 0, Math.PI * 2);
    ctx.fill();

    // A hard cut-out, so it is obvious the buffer is a separate surface.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const angle = phase + (i / 8) * Math.PI * 2;
      ctx.arc(
        center + Math.cos(angle) * center * 0.5,
        center + Math.sin(angle) * center * 0.5,
        center * 0.14,
        0,
        Math.PI * 2,
      );
    }
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.beginPath();
    ctx.arc(center, center, center * 0.86, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/* -------------------------------------------------------------------------- */
/* Renderables                                                                */
/* -------------------------------------------------------------------------- */

/** The blend-mode swatch row. Each swatch composites the same two shapes. */
class BlendSwatches implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  /** Name of the blend mode currently under the pointer, or `null`. */
  public hovered: string | null = null;

  /** Layout of the swatches, so the pointer test can reuse it. */
  public readonly rects: { name: string; x: number; y: number; size: number }[] = [];

  private static readonly MODES = [
    'source-over',
    'multiply',
    'screen',
    'overlay',
    'difference',
    'lighter',
    'hue',
    'color-dodge',
  ];

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    p.resetTransform();
    const ratio = window.devicePixelRatio || 1;
    p.setTransform(ratio, 0, 0, ratio, 0, 0);

    const startX = 26;
    const startY = 150;
    const size = 46;
    const gap = 12;
    const labelHeight = 18;

    this.rects.length = 0;

    p.font = '600 13px ui-sans-serif, system-ui, sans-serif';
    p.fillStyle = '#93a1b1';
    p.textAlign = 'left';
    p.textBaseline = 'alphabetic';
    p.fillText('globalCompositeOperation', startX, startY - 12);

    for (let i = 0; i < BlendSwatches.MODES.length; i++) {
      const mode = BlendSwatches.MODES[i];
      const x = startX + i * (size + gap);
      const y = startY;

      // Base layer: a gradient square.
      const gradient = p.createLinearGradient(x, y, x + size, y + size);
      if (gradient) {
        gradient.addColorStop(0, '#2f6fdf');
        gradient.addColorStop(1, '#8a6cf0');
        p.fillStyle = gradient;
      } else {
        p.fillStyle = '#2f6fdf';
      }
      p.fillRect(x, y, size, size);

      // Blend layer: a lighter disc, composited with the mode under test.
      p.globalCompositeOperation = mode;
      p.beginPath();
      p.arc(x + size * 0.62, y + size * 0.42, size * 0.42, 0, Math.PI * 2);
      p.fillStyle = 'rgba(232, 178, 58, 0.85)';
      p.fill();
      p.globalCompositeOperation = 'source-over';

      // Frame, highlighted when hovered.
      const isHovered = this.hovered === mode;
      p.lineWidth = isHovered ? 2 : 1;
      p.strokeStyle = isHovered ? '#ffffff' : 'rgba(255, 255, 255, 0.25)';
      p.strokeRect(x, y, size, size);

      p.font = '10px ui-monospace, Menlo, Consolas, monospace';
      p.fillStyle = isHovered ? '#ffffff' : '#93a1b1';
      p.fillText(mode.length > 9 ? `${mode.slice(0, 9)}…` : mode, x, y + size + labelHeight - 6);

      this.rects.push({ name: mode, x, y, size });
    }
  }
}

/** A shadowed, gradient-lit card with a clipped spotlight. */
class EffectsCard implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  public constructor(private readonly buffer: OffscreenBuffer) {}

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    p.resetTransform();
    const ratio = window.devicePixelRatio || 1;
    p.setTransform(ratio, 0, 0, ratio, 0, 0);

    const width = Math.min(420, rendererWidth() - 60);
    const height = 190;
    const x = rendererWidth() - width - 26;
    const y = 90;
    if (y + height > rendererHeight() - 20 || x < 520) return;

    /* ------------------------------------------------- shadowed, lit card */
    p.save();
    p.shadowBlur = 26;
    p.shadowColor = 'rgba(0, 0, 0, 0.7)';
    p.shadowOffsetY = 10;
    p.beginPath();
    p.roundRect(x, y, width, height, 14);
    p.fillStyle = '#141a24';
    p.fill();
    p.restore();

    const sheen = p.createLinearGradient(x, y, x + width, y + height);
    if (sheen) {
      sheen.addColorStop(0, 'rgba(47, 111, 223, 0.35)');
      sheen.addColorStop(0.5, 'rgba(138, 108, 240, 0.12)');
      sheen.addColorStop(1, 'rgba(63, 191, 143, 0.3)');
      p.fillStyle = sheen;
    } else {
      p.fillStyle = 'rgba(47, 111, 223, 0.25)';
    }
    p.beginPath();
    p.roundRect(x, y, width, height, 14);
    p.fill();

    p.lineWidth = 1;
    p.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    p.beginPath();
    p.roundRect(x + 0.5, y + 0.5, width - 1, height - 1, 14);
    p.stroke();

    /* ------------------------------------------------ clipped glow spotlight */
    p.save();
    p.beginPath();
    p.roundRect(x, y, width, height, 14);
    p.clip();

    const glow = p.createRadialGradient(
      x + width * 0.3,
      y + height * 0.7,
      4,
      x + width * 0.3,
      y + height * 0.7,
      width * 0.55,
    );
    if (glow) {
      glow.addColorStop(0, 'rgba(232, 178, 58, 0.75)');
      glow.addColorStop(1, 'rgba(232, 178, 58, 0)');
      p.fillStyle = glow;
      p.fillRect(x, y, width, height);
    }
    p.restore();

    /* ------------------------------------------------------ blitted badge */
    if (this.buffer.isUsable) {
      const badgeSize = 96;
      p.save();
      p.shadowBlur = 18;
      p.shadowColor = 'rgba(0, 0, 0, 0.6)';
      p.drawImage(this.buffer.canvas, {
        dx: x + width - badgeSize - 22,
        dy: y + height - badgeSize - 22,
        dw: badgeSize,
        dh: badgeSize,
      });
      p.restore();

      p.font = '11px ui-monospace, Menlo, Consolas, monospace';
      p.fillStyle = '#93a1b1';
      p.textAlign = 'left';
      p.textBaseline = 'alphabetic';
      p.fillText(
        `offscreen ${this.buffer.canvas.width}×${this.buffer.canvas.height} → drawImage`,
        x + 18,
        y + height - 16,
      );
    }

    p.font = '600 15px ui-sans-serif, system-ui, sans-serif';
    p.fillStyle = '#e6edf3';
    p.textAlign = 'left';
    p.textBaseline = 'alphabetic';
    p.fillText('shadowBlur + gradients + clip() + drawImage', x + 18, y + 30);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers that read the live canvas size                                     */
/* -------------------------------------------------------------------------- */

let liveCanvas: HTMLCanvasElement | null = null;

function rendererWidth(): number {
  return liveCanvas ? liveCanvas.width / (window.devicePixelRatio || 1) : 880;
}

function rendererHeight(): number {
  return liveCanvas ? liveCanvas.height / (window.devicePixelRatio || 1) : 560;
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
const overlay = document.querySelector<HTMLElement>('#overlay');
const notice = document.querySelector<HTMLElement>('#notice');

function showNotice(message: string): void {
  if (!notice) return;
  notice.textContent = message;
  notice.hidden = false;
  if (overlay) overlay.textContent = 'backend unavailable';
}

let dispose = (): void => undefined;

if (!canvas || !overlay) {
  showNotice('This example needs the #stage canvas and the #overlay element to exist.');
} else {
  const preferred: BackendName[] = [BackendNames.Canvas2D];
  if (detectBackendStrict(preferred, canvas) !== BackendNames.Canvas2D) {
    showNotice('This example needs a 2D canvas context, which this browser could not create.');
  } else {
    liveCanvas = canvas;
    const renderer = new Canvas2DRenderer({ canvas, clearColor: '#11151d', autoResize: true });

    const buffer = new OffscreenBuffer(128);
    const swatches = new BlendSwatches();
    const card = new EffectsCard(buffer);
    const scene = { children: [swatches, card] as Renderable2D[] };

    // The offscreen buffer only needs redrawing a few times per second, which is
    // the whole point of keeping it separate from the frame loop.
    let bufferPhase = 0;
    let bufferAccumulator = 0;
    const bufferTint = new Color('#8a6cf0');
    buffer.redraw(0, bufferTint.toCssString());

    const onPointerMove = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      swatches.hovered = null;
      for (const swatch of swatches.rects) {
        if (
          x >= swatch.x &&
          x <= swatch.x + swatch.size &&
          y >= swatch.y &&
          y <= swatch.y + swatch.size
        ) {
          swatches.hovered = swatch.name;
          break;
        }
      }
    };

    const onPointerLeave = (): void => {
      swatches.hovered = null;
    };

    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);

    let fps = 0;
    let frames = 0;
    let elapsed = 0;

    renderer.setAnimationLoop((_time, delta) => {
      bufferPhase += delta * 0.9;
      bufferAccumulator += delta;
      if (bufferAccumulator >= 0.2) {
        bufferAccumulator = 0;
        buffer.redraw(bufferPhase, bufferTint.toCssString());
      }

      frames++;
      elapsed += delta;
      if (elapsed >= 0.25) {
        fps = frames / elapsed;
        frames = 0;
        elapsed = 0;
      }

      renderer.render(scene, null);

      overlay.textContent =
        `FPS            ${fps.toFixed(0)}\n` +
        `backend        ${renderer.backend}\n` +
        `blend mode     ${swatches.hovered ?? '—'}\n` +
        `offscreen      ${buffer.canvas.width}×${buffer.canvas.height} ${buffer.isUsable ? 'usable' : 'UNAVAILABLE'}\n` +
        `canvas         ${Math.round(rendererWidth())}×${Math.round(rendererHeight())}\n` +
        `painter ops    ${renderer.painter.commandCount}`;
    }, { autoStart: true });

    dispose = (): void => {
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      renderer.setAnimationLoop(null);
      renderer.dispose();
      // Release the offscreen surface explicitly.
      buffer.canvas.width = 1;
      buffer.canvas.height = 1;
      liveCanvas = null;
    };
  }
}

window.addEventListener('beforeunload', dispose);
