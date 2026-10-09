/**
 * 2D basics — the smallest useful `@dxyl/graphics` program.
 *
 * What it shows
 * -------------
 * 1. How a backend is chosen at runtime (`detectBackendStrict`).
 * 2. How the renderer collects work: it walks a scene **structurally**, so a plain
 *    `{ children: [...] }` object is a valid scene and any object with a
 *    `render(painter)` method is a valid renderable.
 * 3. How the Canvas2D camera maps world units onto the canvas: world `+Y` points
 *    **up**, the origin is the centre of the viewport, and `zoom` scales world
 *    units. That is the documented `Canvas2DRenderer.applyCameraTransform`
 *    behaviour and it is why nothing below flips `y` by hand.
 * 4. Frame-independent motion from the `delta` (seconds) the renderer's animation
 *    loop supplies.
 *
 * What to look for
 * ----------------
 * Three squares drifting and spinning; `depth` orders them so the lighter one
 * paints behind. The overlay reports FPS, the active backend and the draw count.
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
/* A renderable: any object with `visible` + `render(painter)`                */
/* -------------------------------------------------------------------------- */

/**
 * A spinning, drifting square in world units.
 *
 * It implements the renderer's `Renderable2D` contract directly: no scene-graph
 * base class is required. `depth` is the distance from the camera used as the
 * tertiary sort key, so a larger depth paints afterwards.
 */
class Box implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth: number;

  public x: number;
  public y: number;
  public rotation = 0;
  public readonly size: number;
  public readonly half: number;
  private readonly tint: Color;
  private vx: number;
  private vy: number;
  private readonly spin: number;

  public constructor(options: {
    x: number;
    y: number;
    size: number;
    color: string;
    depth: number;
    vx: number;
    vy: number;
    spin: number;
  }) {
    this.x = options.x;
    this.y = options.y;
    this.size = options.size;
    this.half = options.size / 2;
    this.tint = new Color(options.color);
    this.depth = options.depth;
    this.vx = options.vx;
    this.vy = options.vy;
    this.spin = options.spin;
  }

  /** Advances the square, bouncing inside `[-bound, bound]` on both axes. */
  public update(delta: number, bound: number): void {
    this.x += this.vx * delta;
    this.y += this.vy * delta;
    this.rotation += this.spin * delta;

    const limit = bound - this.half;
    if (this.x > limit || this.x < -limit) {
      this.vx = -this.vx;
      this.x = Math.min(limit, Math.max(-limit, this.x));
    }
    if (this.y > limit || this.y < -limit) {
      this.vy = -this.vy;
      this.y = Math.min(limit, Math.max(-limit, this.y));
    }
  }

  /** Draws the square through the Canvas2D painter, in world units. */
  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    p.save();
    p.translate(this.x, this.y);
    p.rotate(this.rotation);

    p.beginPath();
    p.rect(-this.half, -this.half, this.size, this.size);
    p.fillStyle = this.tint.toCssString();
    p.fill();

    p.lineWidth = 2;
    p.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    p.stroke();
    p.restore();
  }
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
const overlay = document.querySelector<HTMLElement>('#overlay');
const notice = document.querySelector<HTMLElement>('#notice');

/** Shows a readable message instead of throwing into a blank page. */
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
  // Strict detection: unlike `detectBackend`, this returns null rather than
  // silently pretending Canvas2D is usable.
  const preferred: BackendName[] = [BackendNames.Canvas2D, BackendNames.SVG];
  const backend = detectBackendStrict(preferred, canvas);

  if (backend !== BackendNames.Canvas2D) {
    showNotice(
      'This example draws through the Canvas2D backend, but no 2D canvas context could be ' +
        'created in this browser.',
    );
  } else {
    const renderer = new Canvas2DRenderer({
      canvas,
      clearColor: '#11151d',
      clearAlpha: 1,
      // Re-read the CSS size every frame, so resizing the window just works.
      autoResize: true,
    });

    // The camera is read structurally. Only `position` and `zoom` matter here.
    const camera = { position: { x: 0, y: 0, z: 0 }, zoom: 34 };

    const boxes: Box[] = [
      new Box({ x: -8, y: 2, size: 4, color: '#2f6fdf', depth: 3, vx: 1.2, vy: 0.9, spin: 0.6 }),
      new Box({ x: 6, y: -3, size: 3, color: '#e8b23a', depth: 2, vx: -0.9, vy: 1.4, spin: -0.9 }),
      new Box({ x: 0, y: 0, size: 5, color: '#3fbf8f', depth: 1, vx: 0.5, vy: -0.7, spin: 0.35 }),
    ];

    // The renderer traverses `children` because this root has no
    // `collectRenderables` method. Nothing here is a library class.
    const scene = { children: boxes as Renderable2D[] };

    let frames = 0;
    let elapsed = 0;
    let fps = 0;

    renderer.setAnimationLoop((_time, delta) => {
      for (const box of boxes) box.update(delta, 10);

      // A hand-rolled FPS estimate, refreshed a few times per second.
      frames++;
      elapsed += delta;
      if (elapsed >= 0.25) {
        fps = frames / elapsed;
        frames = 0;
        elapsed = 0;
      }

      renderer.render(scene, camera);

      overlay.textContent =
        `FPS       ${fps.toFixed(0)}\n` +
        `backend   ${renderer.backend}\n` +
        `draws     ${renderer.stats.drawCalls}\n` +
        `zoom      ${camera.zoom}`;
    }, { autoStart: true });

    dispose = (): void => {
      // Every step is idempotent, so calling this twice is safe.
      renderer.setAnimationLoop(null);
      renderer.dispose();
    };
  }
}

window.addEventListener('beforeunload', dispose);
