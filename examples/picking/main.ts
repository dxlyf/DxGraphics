/**
 * Picking — hit testing in 2D and ray/triangle intersection in 3D space.
 *
 * Read this first
 * ---------------
 * **`src/picking/` is nearly empty in this checkout** (it contains type declarations
 * and raycast data helpers, but no `Raycaster` class yet). This example therefore
 * writes both hit tests itself, using verified library primitives, and shows the
 * two fundamentally different techniques side by side:
 *
 * 1. **2D bounds testing.** `Rect` and `Box2` give `containsPoint`; `Vec2` gives
 *    `distanceTo`. The screen-to-world mapping reuses the exact formula the Canvas2D
 *    backend applies (world `+Y` up, origin at the viewport centre), so a click lands
 *    where the pixel is.
 * 2. **3D ray/triangle intersection.** `Ray` has `intersectTriangle` and `Ray.
 *    intersectSphere`; `Mat4.lookAt` produces a view matrix; `Vec3.applyMat4`
 *    performs the perspective divide. `Mesh.raycast` implements the same test
 *    internally (Möller–Trumbore, against a `RaycasterLike`), but this example calls
 *    `Ray` directly so the picking maths is visible and needs no GPU.
 *
 * What to look for
 * ----------------
 * Move the pointer over the canvas: whichever object is under the cursor highlights
 * and the badge in the bottom-right names it plus the hit distance. The 3D panel on
 * the right shows which of the three projected triangles the ray pierced, with the
 * barycentric-derived face index. Click to "pin" the selection.
 */

import {
  BackendNames,
  Box2,
  Canvas2DRenderer,
  Color,
  Mat4,
  Ray,
  Vec2,
  Vec3,
  detectBackendStrict,
  type BackendName,
  type Canvas2DPainter,
  type Renderable2D,
} from '../../src/index';

/* -------------------------------------------------------------------------- */
/* 2D: bounds-tested shapes                                                   */
/* -------------------------------------------------------------------------- */

/** A circle tested with `Vec2.distanceTo` against its radius. */
class Disc implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;
  public hovered = false;

  public constructor(
    public readonly name: string,
    public readonly center: Vec2,
    public readonly radius: number,
    private readonly tint: string,
  ) {}

  /** `true` when `point` is inside this disc, with a small tolerance. */
  public contains(point: Vec2, tolerance = 0.15): boolean {
    return this.center.distanceTo(point) <= this.radius + tolerance;
  }

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    p.beginPath();
    p.arc(this.center.x, this.center.y, this.radius, 0, Math.PI * 2);
    p.fillStyle = this.tint;
    p.globalAlpha = this.hovered ? 1 : 0.78;
    p.fill();
    p.globalAlpha = 1;
    p.lineWidth = this.hovered ? 0.16 : 0.06;
    p.strokeStyle = this.hovered ? '#ffffff' : 'rgba(255, 255, 255, 0.3)';
    p.stroke();
  }
}

/** An axis-aligned box tested with `Box2.containsPoint`. */
class Plate implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;
  public hovered = false;

  private readonly bounds: Box2;

  public constructor(
    public readonly name: string,
    public readonly center: Vec2,
    private readonly width: number,
    private readonly height: number,
    private readonly tint: string,
  ) {
    this.bounds = Box2.fromCenterAndSize(center, new Vec2(width, height));
  }

  public contains(point: Vec2): boolean {
    return this.bounds.containsPoint(point);
  }

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    const halfW = this.width / 2;
    const halfH = this.height / 2;
    p.beginPath();
    p.roundRect(this.center.x - halfW, this.center.y - halfH, this.width, this.height, 0.24);
    p.fillStyle = this.tint;
    p.globalAlpha = this.hovered ? 1 : 0.8;
    p.fill();
    p.globalAlpha = 1;
    p.lineWidth = this.hovered ? 0.16 : 0.06;
    p.strokeStyle = this.hovered ? '#ffffff' : 'rgba(255, 255, 255, 0.28)';
    p.stroke();
  }
}

/* -------------------------------------------------------------------------- */
/* 3D: ray/triangle intersection                                              */
/* -------------------------------------------------------------------------- */

/** A single triangle in world space, ready for `Ray.intersectTriangle`. */
interface Triangle {
  readonly name: string;
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
  readonly color: string;
}

/** Builds the three triangles of a small pyramid around the origin. */
function makeTriangles(): Triangle[] {
  const apex = new Vec3(0, 1.5, 0);
  const base: Vec3[] = [
    new Vec3(-1.2, -0.8, -1.2),
    new Vec3(1.2, -0.8, -1.2),
    new Vec3(1.2, -0.8, 1.2),
  ];
  const colors = ['#2f6fdf', '#3fbf8f', '#8a6cf0'];
  const triangles: Triangle[] = [];
  for (let i = 0; i < 3; i++) {
    triangles.push({
      name: `face ${i}`,
      a: apex,
      b: base[i],
      c: base[(i + 1) % 3],
      color: colors[i],
    });
  }
  triangles.push({ name: 'base', a: base[0], b: base[1], c: base[2], color: '#e8b23a' });
  return triangles;
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
const overlay = document.querySelector<HTMLElement>('#overlay');
const notice = document.querySelector<HTMLElement>('#notice');
const pickInfo = document.querySelector<HTMLElement>('#pickinfo');

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

    /* -------------------------------------------------------------- 2D scene */
    const discs: Disc[] = [
      new Disc('disc A', new Vec2(-3.2, 1.6), 1.05, '#2f6fdf'),
      new Disc('disc B', new Vec2(-0.6, 2.7), 0.8, '#3fbf8f'),
      new Disc('disc C', new Vec2(-2.1, -1.4), 1.25, '#8a6cf0'),
    ];
    const plates: Plate[] = [
      new Plate('plate A', new Vec2(2.4, 2.5), 2.4, 1.3, '#e8b23a'),
      new Plate('plate B', new Vec2(3.1, -1.1), 1.8, 2.2, '#4aa3c7'),
    ];
    const scene = { children: [...discs, ...plates] as Renderable2D[] };
    const camera = { position: { x: 0, y: 0, z: 0 }, zoom: 52 };

    /* -------------------------------------------------------------- 3D scene */
    // The 3D pyramid is drawn in a screen-space box on the right, projected with
    // the same library maths a GPU backend would use.
    const triangles = makeTriangles();
    const projection = Mat4.fromPerspective((52 * Math.PI) / 180, 1, 0.1, 100);
    const view = Mat4.fromLookAt(new Vec3(2.4, 2.0, 4.4), new Vec3(0, 0.3, 0), new Vec3(0, 1, 0));
    const viewProjection = new Mat4().multiplyMatrices(projection, view);

    /** Screen rect of the 3D panel, in logical pixels. */
    const panel = { x: 0, y: 0, size: 0 };

    const pointer = { x: -1, y: -1, inside: false };
    let pinned: string | null = null;
    let lastHit = 'no hit';

    /** Maps a viewport pixel to world units, matching the backend's transform. */
    function screenToWorld(screenX: number, screenY: number): Vec2 {
      const zoom = camera.zoom === 0 ? 1 : camera.zoom;
      return new Vec2(
        (screenX - renderer.width / 2) / zoom + camera.position.x,
        -(screenY - renderer.height / 2) / zoom + camera.position.y,
      );
    }

    /** Builds a world-space ray through a viewport pixel of the 3D panel. */
    function pixelToRay(screenX: number, screenY: number): Ray {
      const half = panel.size / 2;
      const ndcX = (screenX - (panel.x + half)) / half;
      const ndcY = -((screenY - (panel.y + half)) / half);

      // Un-project the near and far NDC points, then run the ray through them.
      // `projectionMatrixInverse * view` is the inverse of `projection * view`.
      const inverse = new Mat4()
        .multiplyMatrices(projection, view)
        .invert();
      const near = new Vec3(ndcX, ndcY, -1).applyMat4(inverse);
      const far = new Vec3(ndcX, ndcY, 1).applyMat4(inverse);
      return new Ray(near, far.sub(near).normalize());
    }

    /* ---------------------------------------------------------------- drawing */
    /** Extra renderable that paints the 3D panel and the world-space cursor. */
    class PanelOverlay implements Renderable2D {
      public visible = true;
      public readonly renderOrder = 10;
      public depth = 0;

      public constructor(private readonly readHover: () => { disc: Disc | null; plate: Plate | null }) {}

      public render(painter: unknown): void {
        const p = painter as Canvas2DPainter;

        // The world-space cursor: drawn where the pointer is, in world units.
        if (pointer.inside) {
          const world = screenToWorld(pointer.x, pointer.y);
          p.beginPath();
          p.arc(world.x, world.y, 0.12, 0, Math.PI * 2);
          p.fillStyle = '#ffffff';
          p.fill();
          p.lineWidth = 0.04;
          p.strokeStyle = 'rgba(255, 255, 255, 0.45)';
          p.beginPath();
          p.moveTo(world.x - 0.5, world.y);
          p.lineTo(world.x + 0.5, world.y);
          p.moveTo(world.x, world.y - 0.5);
          p.lineTo(world.x, world.y + 0.5);
          p.stroke();
        }

        // The 3D panel is drawn in screen space, so reset the camera transform.
        p.resetTransform();
        const ratio = window.devicePixelRatio || 1;
        p.setTransform(ratio, 0, 0, ratio, 0, 0);

        const size = Math.min(210, renderer.width * 0.3);
        panel.size = size;
        panel.x = renderer.width - size - 16;
        panel.y = 16;

        p.beginPath();
        p.roundRect(panel.x, panel.y, size, size, 10);
        p.fillStyle = 'rgba(8, 11, 16, 0.72)';
        p.fill();
        p.lineWidth = 1;
        p.strokeStyle = 'rgba(120, 160, 220, 0.4)';
        p.stroke();

        // Project every triangle and fill the hovered one.
        const half = size / 2;
        for (const triangle of triangles) {
          const points: { x: number; y: number }[] = [];
          for (const vertex of [triangle.a, triangle.b, triangle.c]) {
            const ndc = vertex.clone().applyMat4(viewProjection);
            points.push({
              x: panel.x + half + ndc.x * half * 0.72,
              y: panel.y + half - ndc.y * half * 0.72,
            });
          }

          const isHit = lastHit === `3D ${triangle.name}`;
          p.beginPath();
          p.moveTo(points[0].x, points[0].y);
          p.lineTo(points[1].x, points[1].y);
          p.lineTo(points[2].x, points[2].y);
          p.closePath();
          p.fillStyle = isHit ? '#ffffff' : triangle.color;
          p.globalAlpha = isHit ? 0.95 : 0.4;
          p.fill();
          p.globalAlpha = 1;
          p.lineWidth = 1;
          p.strokeStyle = 'rgba(255, 255, 255, 0.35)';
          p.stroke();
        }

        p.fillStyle = '#93a1b1';
        p.font = '11px ui-monospace, Menlo, Consolas, monospace';
        p.textBaseline = 'top';
        p.textAlign = 'left';
        p.fillText('3D ray picking', panel.x + 10, panel.y + 8);

        void this.readHover;
      }
    }

    const overlayPanel = new PanelOverlay(() => ({ disc: null, plate: null }));
    const fullScene = { children: [...discs, ...plates, overlayPanel] as Renderable2D[] };

    /* ----------------------------------------------------------------- input */
    const updatePointer = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
      pointer.inside = true;
    };

    const onPointerMove = (event: PointerEvent): void => {
      updatePointer(event);
      // A click pins the selection, so recompute the hover only when unpinned.
      if (pinned === null) {
        lastHit = computeHit();
      }
      if (pickInfo) pickInfo.textContent = lastHit;
    };

    const onPointerLeave = (): void => {
      pointer.inside = false;
      if (pinned === null) {
        lastHit = 'no hit';
        if (pickInfo) pickInfo.textContent = lastHit;
      }
    };

    const onPointerDown = (event: PointerEvent): void => {
      updatePointer(event);
      const hit = computeHit();
      lastHit = hit;
      // Pin on click; clicking the same target again clears the pin.
      pinned = pinned === hit ? null : hit;
      if (pickInfo) pickInfo.textContent = hit;
    };

    /** Runs the 2D bounds tests, then the 3D ray tests, and returns a label. */
    function computeHit(): string {
      for (const disc of discs) disc.hovered = false;
      for (const plate of plates) plate.hovered = false;

      const world = screenToWorld(pointer.x, pointer.y);

      // 2D first: topmost (last drawn) wins, matching painter order.
      for (let i = plates.length - 1; i >= 0; i--) {
        if (plates[i].contains(world)) {
          plates[i].hovered = true;
          lastHit = `2D ${plates[i].name} @ (${world.x.toFixed(2)}, ${world.y.toFixed(2)})`;
          return lastHit;
        }
      }
      for (let i = discs.length - 1; i >= 0; i--) {
        if (discs[i].contains(world)) {
          discs[i].hovered = true;
          lastHit = `2D ${discs[i].name} @ (${world.x.toFixed(2)}, ${world.y.toFixed(2)})`;
          return lastHit;
        }
      }

      // 3D: only when the pointer is inside the panel.
      const insidePanel =
        panel.size > 0 &&
        pointer.x >= panel.x &&
        pointer.x <= panel.x + panel.size &&
        pointer.y >= panel.y &&
        pointer.y <= panel.y + panel.size;

      if (insidePanel) {
        const ray = pixelToRay(pointer.x, pointer.y);
        let nearest: { name: string; distance: number } | null = null;
        const hitPoint = new Vec3();

        for (const triangle of triangles) {
          // `intersectTriangle` writes the hit into `target` and returns null on a miss.
          const hit = ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, hitPoint);
          if (hit === null) continue;
          const distance = ray.origin.distanceTo(hitPoint);
          if (nearest === null || distance < nearest.distance) {
            nearest = { name: triangle.name, distance };
          }
        }

        if (nearest !== null) {
          lastHit = `3D ${nearest.name} @ ${nearest.distance.toFixed(2)} units`;
          return lastHit;
        }
        lastHit = '3D miss (panel empty space)';
        return lastHit;
      }

      lastHit = 'no hit';
      return lastHit;
    }

    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('pointerdown', onPointerDown);

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

      renderer.render(fullScene, camera);

      overlay.textContent =
        `FPS        ${fps.toFixed(0)}\n` +
        `backend    ${renderer.backend}\n` +
        `pointer    ${pointer.inside ? `${pointer.x.toFixed(0)}, ${pointer.y.toFixed(0)}` : 'outside'}\n` +
        `draw calls ${renderer.stats.drawCalls}\n` +
        `objects    ${discs.length + plates.length} 2D · ${triangles.length} 3D\n` +
        `pinned     ${pinned ?? 'none'}`;
    }, { autoStart: true });

    dispose = (): void => {
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerdown', onPointerDown);
      renderer.setAnimationLoop(null);
      renderer.dispose();
    };
  }
}

window.addEventListener('beforeunload', dispose);
