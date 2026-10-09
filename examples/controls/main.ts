/**
 * Controls — pan, zoom and rotate, written inline.
 *
 * Read this first
 * ---------------
 * **`src/controls/` is an empty directory in this checkout**, so there is no
 * `OrbitControls`/`MapControls`/`PointerControls` to import. This example writes the
 * pointer handling itself and shows the two halves that matter:
 *
 * 1. **Input** — `pointerdown`/`pointermove`/`pointerup` with `setPointerCapture`, so
 *    a drag that leaves the canvas keeps tracking; `wheel` with `{ passive: false }`
 *    so `preventDefault()` can suppress page scroll; and modifier-free button
 *    discrimination (`event.button`) for pan versus rotate.
 * 2. **Feeding the camera** — the renderer reads a camera **structurally**:
 *    `renderer`'s `RenderContext.getCamera2DTransform` uses `camera.position.{x,y}`,
 *    `camera.zoom` and `camera.rotation`. Nothing needs to be a library class. The
 *    transform is then `translate(centre - position * zoom) rotate(-rotation) scale(zoom, -zoom)`,
 *    which is why the world origin sits at the centre of the canvas and world `+Y`
 *    points up.
 *
 * What to look for
 * ----------------
 * Drag with the left button to pan, scroll to zoom about the cursor, drag with the
 * right button (or hold Shift while dragging) to rotate. The reference grid rotates
 * with the world, so it is obvious that rotation is a camera transform and not a
 * per-object spin. The overlay reports the live camera state and the input events
 * received.
 */

import {
  BackendNames,
  Canvas2DRenderer,
  Color,
  Vec2,
  detectBackendStrict,
  type BackendName,
  type Canvas2DPainter,
  type Renderable2D,
} from '../../src/index';

/* -------------------------------------------------------------------------- */
/* A reference world                                                          */
/* -------------------------------------------------------------------------- */

/** A square cell of the reference grid, in world units. */
class GridCell implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  public constructor(
    public readonly gx: number,
    public readonly gy: number,
    private readonly extent: number,
    private readonly tint: string,
  ) {}

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    const half = this.extent / 2;
    p.beginPath();
    p.rect(this.gx - half, this.gy - half, this.extent, this.extent);
    p.fillStyle = this.tint;
    p.fill();
    p.lineWidth = 0.06;
    p.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    p.stroke();
  }
}

/** The world axes, so rotation is unmistakable. */
class Axes implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 1;
  public depth = 999;

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    const length = 6;

    p.lineWidth = 0.12;
    p.strokeStyle = '#e05c5c';
    p.beginPath();
    p.moveTo(0, 0);
    p.lineTo(length, 0);
    p.stroke();

    p.strokeStyle = '#5ce08a';
    p.beginPath();
    p.moveTo(0, 0);
    p.lineTo(0, length);
    p.stroke();

    p.beginPath();
    p.arc(0, 0, 0.18, 0, Math.PI * 2);
    p.fillStyle = '#e6edf3';
    p.fill();
  }
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
    const renderer = new Canvas2DRenderer({ canvas, clearColor: '#11151d', autoResize: true });

    const cells: Renderable2D[] = [];
    const accent = new Color('#2f6fdf');
    for (let gy = -3; gy <= 3; gy++) {
      for (let gx = -3; gx <= 3; gx++) {
        const distance = Math.hypot(gx, gy) / 4.2;
        const tint = new Color()
          .copy(accent)
          .lerp(new Color(1, 1, 1, 1), Math.max(0, 0.55 - distance))
          .toCssString();
        cells.push(new GridCell(gx * 0.6, gy * 0.6, 0.46, tint));
      }
    }
    const axes = new Axes();
    const scene = { children: [...cells, axes] };

    /* ---------------------------------------------------------------- camera */
    // A plain object is a valid camera: the renderer reads these members
    // structurally. `zoom` is world-units-to-logical-pixels.
    const camera = { position: { x: 0, y: 0, z: 0 }, zoom: 62, rotation: 0 };

    /* ----------------------------------------------------------------- input */
    let pointerId: number | null = null;
    let mode: 'pan' | 'rotate' | null = null;
    let lastX = 0;
    let lastY = 0;
    let events = 0;

    /** Converts a viewport pixel into world units, using the same maths as the backend. */
    function screenToWorld(screenX: number, screenY: number): Vec2 {
      const zoom = camera.zoom === 0 ? 1 : camera.zoom;
      // Undo the backend transform: translate(centre - position*zoom) scale(zoom, -zoom)
      // then rotate. Solving in the rotated frame keeps zoom-about-cursor exact.
      const dx = (screenX - renderer.width / 2) / zoom + camera.position.x;
      const dy = -(screenY - renderer.height / 2) / zoom + camera.position.y;
      const cos = Math.cos(-camera.rotation);
      const sin = Math.sin(-camera.rotation);
      return new Vec2(dx * cos - dy * sin, dx * sin + dy * cos);
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (pointerId !== null) return;
      pointerId = event.pointerId;
      mode = event.button === 2 || event.shiftKey ? 'rotate' : 'pan';
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      events++;
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId || mode === null) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;

      if (mode === 'pan') {
        // Dragging right must move the world right, so the camera moves left.
        const cos = Math.cos(camera.rotation);
        const sin = Math.sin(camera.rotation);
        camera.position.x -= (dx * cos - dy * sin) / camera.zoom;
        camera.position.y += (dx * sin + dy * cos) / camera.zoom;
      } else {
        camera.rotation += dx * 0.006;
      }
      events++;
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      mode = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      events++;
    };

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const before = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);

      const factor = Math.exp(-event.deltaY * 0.0014);
      camera.zoom = Math.max(12, Math.min(260, camera.zoom * factor));

      // Keep the world point under the cursor fixed: move the camera by the delta
      // introduced by the scale change, expressed in the world frame.
      const after = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
      const cos = Math.cos(camera.rotation);
      const sin = Math.sin(camera.rotation);
      const wx = before.x - after.x;
      const wy = before.y - after.y;
      camera.position.x += wx * cos - wy * sin;
      camera.position.y += wx * sin + wy * cos;
      events++;
    };

    const onContextMenu = (event: MouseEvent): void => {
      // Right-drag is the rotate gesture, so the browser menu must not appear.
      event.preventDefault();
    };

    const onDoubleClick = (): void => {
      camera.position.x = 0;
      camera.position.y = 0;
      camera.zoom = 62;
      camera.rotation = 0;
      events++;
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('dblclick', onDoubleClick);

    let fps = 0;
    let frames = 0;
    let elapsed = 0;

    renderer.setAnimationLoop((_time, delta) => {
      frames++;
      elapsed += delta;
      if (elapsed >= 0.25) {
        fps = frames / elapsed;
        frames = 0;
        elapsed = 0;
      }

      renderer.render(scene, camera);

      overlay.textContent =
        `FPS        ${fps.toFixed(0)}\n` +
        `backend    ${renderer.backend}\n` +
        `x, y       ${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}\n` +
        `zoom       ${camera.zoom.toFixed(1)}\n` +
        `rotation   ${((camera.rotation * 180) / Math.PI).toFixed(1)}°\n` +
        `gesture    ${mode ?? 'idle'}\n` +
        `events     ${events}`;
    }, { autoStart: true });

    dispose = (): void => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('dblclick', onDoubleClick);
      renderer.setAnimationLoop(null);
      renderer.dispose();
    };
  }
}

window.addEventListener('beforeunload', dispose);
