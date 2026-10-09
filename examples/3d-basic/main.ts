/**
 * 3D basics — a software-rendered 3D scene built entirely from library primitives.
 *
 * Why the projection is written out by hand
 * -----------------------------------------
 * The 3D *scene graph* (`Scene3D`, `Object3D`, `Mesh`, `PerspectiveCamera`) and the
 * *geometry* container (`BufferGeometry` + `BufferAttribute`) are used here, and the
 * library does ship `src/geometry/3d/` (the primitive generators such as
 * `BoxGeometry`) and `src/materials/`. The projection is still written out by hand
 * because **Canvas2D has no depth buffer**: a GPU-free painter's-algorithm
 * rasteriser is the only way to show a depth-correct solid on that backend, and the
 * library's Canvas2D 3D path draws flat-shaded triangles without ordering them.
 *
 * So this example does the rasterisation itself, using only verified library
 * behaviour:
 *
 *   world matrix  = parentWorld * local            (`Object3D.updateMatrixWorld`)
 *   view matrix   = inverse(camera.matrixWorld)    (`Camera3D.viewMatrix` aliases it)
 *   clip          = projection * view * world       (`Vec3.applyMat4`, which divides by w)
 *   screen        = clip.xy mapped from NDC on a Y-down canvas (hence the `-y`)
 *   culling       = `BoundingVolume` + `camera.frustum.intersectsSphere`
 *   painter order = back-to-front by face centroid depth in view space
 *
 * Every matrix is **column-major with column vectors** (`v' = M * v`), and
 * `Vec3.applyMat4` already performs the perspective divide — do not divide again.
 *
 * The frustum is read after `camera.updateMatrixWorld(true)`, which is all that is
 * needed: `Camera3D.updateMatrixWorld` rebuilds `camera.frustum` from the current
 * projection and view matrices. Calling `updateFrustum()` as well is harmless but
 * redundant.
 *
 * What to look for
 * ----------------
 * A knot-shaped tube and a cube orbiting a lit-looking origin, flat-shaded with a
 * Lambert term and sorted so nearer faces cover farther ones. Drag to orbit, wheel
 * to zoom. The overlay reports FPS, backend, triangles submitted and how many
 * objects the frustum rejected.
 */

import {
  BackendNames,
  BoundingVolume,
  BufferAttribute,
  BufferGeometry,
  Canvas2DRenderer,
  Color,
  Mat4,
  Mesh,
  PerspectiveCamera,
  Vec3,
  detectBackendStrict,
  type Canvas2DPainter,
  type Renderable2D,
} from '../../src/index';
// `Object3D` has to come from its own module: the root barrel re-exports the *type*
// under that name (`export type { Object3D } from './3d/Object3D'`), so importing it
// from `../../src/index` yields a type-only binding that cannot be instantiated.
import { Object3D } from '../../src/scene/3d/Object3D';

/* -------------------------------------------------------------------------- */
/* Geometry: built by hand so the whole rasteriser stays legible end to end   */
/* -------------------------------------------------------------------------- */

/**
 * Builds a `BufferGeometry` from a triangle soup.
 *
 * A non-indexed soup is used throughout: each triangle keeps its own vertices, so
 * every face can carry its own flat normal, which is what the software shader below
 * needs.
 */
function makeGeometry(positions: readonly number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** An axis-aligned cube of half-extent `h`. */
function makeCube(h: number): BufferGeometry {
  const c: [number, number, number][] = [
    [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
    [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
  ];
  const quads: [number, number, number, number][] = [
    [0, 3, 2, 1], // -Z
    [4, 5, 6, 7], // +Z
    [0, 1, 5, 4], // -Y
    [3, 7, 6, 2], // +Y
    [0, 4, 7, 3], // -X
    [1, 2, 6, 5], // +X
  ];
  const positions: number[] = [];
  for (const [a, b, cc, d] of quads) {
    for (const v of [c[a], c[b], c[cc], c[a], c[cc], c[d]]) {
      positions.push(v[0], v[1], v[2]);
    }
  }
  return makeGeometry(positions);
}

/**
 * A tube swept along a trefoil curve, giving a knot-like silhouette.
 *
 * The curve is sampled with plain trigonometry; `BufferGeometry` only needs the
 * resulting positions, which keeps this example independent of the 2D curve layer.
 */
function makeTube(radius: number, tube: number, segments = 110, radial = 7): BufferGeometry {
  const rings: Vec3[][] = [];

  const curve = (t: number): Vec3 => {
    const p = 2;
    const q = 3;
    const phi = t * Math.PI * 2;
    const r = radius * (2 + Math.cos(q * phi)) * 0.5;
    return new Vec3(r * Math.cos(p * phi), r * Math.sin(p * phi), radius * Math.sin(q * phi) * 0.5);
  };

  const epsilon = 0.001;
  for (let i = 0; i < segments; i++) {
    const t = i / segments;
    const center = curve(t);
    const tangent = curve(t + epsilon).sub(curve(t - epsilon)).normalize();
    // Any vector not parallel to the tangent gives a stable frame for this shape.
    const normal = new Vec3(0, 0, 1)
      .sub(tangent.clone().multiplyScalar(tangent.z))
      .normalize();
    const binormal = new Vec3().crossVectors(tangent, normal).normalize();

    const ring: Vec3[] = [];
    for (let j = 0; j < radial; j++) {
      const angle = (j / radial) * Math.PI * 2;
      ring.push(
        new Vec3(
          center.x + (normal.x * Math.cos(angle) + binormal.x * Math.sin(angle)) * tube,
          center.y + (normal.y * Math.cos(angle) + binormal.y * Math.sin(angle)) * tube,
          center.z + (normal.z * Math.cos(angle) + binormal.z * Math.sin(angle)) * tube,
        ),
      );
    }
    rings.push(ring);
  }

  const positions: number[] = [];
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    for (let j = 0; j < radial; j++) {
      const jn = (j + 1) % radial;
      const a = rings[i][j];
      const b = rings[next][j];
      const cc = rings[next][jn];
      const d = rings[i][jn];
      for (const v of [a, b, cc, a, cc, d]) positions.push(v.x, v.y, v.z);
    }
  }
  return makeGeometry(positions);
}

/* -------------------------------------------------------------------------- */
/* The software rasteriser, exposed as a normal renderable                    */
/* -------------------------------------------------------------------------- */

/** One projected, shaded triangle ready for the painter. */
interface Surface {
  /** Distance from the camera; larger is farther and paints first. */
  readonly depth: number;
  readonly points: { x: number; y: number }[];
  readonly shade: number;
}

/** Base albedo shared by every surface; shading lerps it towards white. */
const BASE_ALBEDO = new Color('#2f6fdf');

/** Lerps the albedo towards white by `amount`, clamped to `0..1`. */
function shadeColor(amount: number): string {
  return new Color()
    .copy(BASE_ALBEDO)
    .lerp(new Color(1, 1, 1, 1), Math.min(1, Math.max(0, amount)))
    .toCssString();
}

/**
 * Projects, shades and painter-sorts the meshes of a `Scene3D`.
 *
 * It satisfies the renderer's `Renderable2D` contract, so it is submitted like any
 * other object; the renderer calls `render(painter)` once per frame.
 */
class SoftwareRasteriser implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  /** Meshes to draw. Their `matrixWorld` is what positions them. */
  public readonly meshes: Mesh[];
  public readonly camera: PerspectiveCamera;

  /** Triangles submitted by the most recent frame. */
  public triangles = 0;

  /** Objects rejected by the frustum test in the most recent frame. */
  public culled = 0;

  /** Reused every frame so the hot loop allocates nothing per vertex. */
  private readonly view = new Mat4();
  private readonly viewProjection = new Mat4();
  private readonly worldPoint = new Vec3();
  private readonly vertexA = new Vec3();
  private readonly vertexB = new Vec3();
  private readonly vertexC = new Vec3();
  private readonly edgeA = new Vec3();
  private readonly edgeB = new Vec3();
  private readonly normal = new Vec3();
  private readonly worldBounds = new BoundingVolume();
  private readonly lightDirection = new Vec3(0.4, 0.75, 0.6).normalize();

  public constructor(meshes: Mesh[], camera: PerspectiveCamera) {
    this.meshes = meshes;
    this.camera = camera;
  }

  /** Places `camera` on an orbit of `distance` around the origin. */
  public orbit(yaw: number, pitch: number, distance: number): void {
    this.camera.position.set(
      Math.cos(pitch) * Math.sin(yaw) * distance,
      Math.sin(pitch) * distance,
      Math.cos(pitch) * Math.cos(yaw) * distance,
    );
    this.camera.lookAt(new Vec3(0, 0, 0));
  }

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    const context = p.getContext();
    if (!context) return;

    const ratio = window.devicePixelRatio || 1;
    const width = context.canvas.width / ratio;
    const height = context.canvas.height / ratio;
    if (width <= 0 || height <= 0) return;

    // Per-frame counters, not lifetime totals: the overlay reports the frame it just
    // drew, so accumulating across frames would show a number that only ever grows.
    this.triangles = 0;
    this.culled = 0;

    // The renderer applied the (2D) camera transform to the painter. This scene
    // owns its own projection, so work in raw logical pixels instead.
    p.resetTransform();
    p.setTransform(ratio, 0, 0, ratio, 0, 0);

    const camera = this.camera;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    this.view.copy(camera.matrixWorldInverse);
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, this.view);
    const frustum = camera.frustum;

    const surfaces: Surface[] = [];
    let culled = 0;

    for (const mesh of this.meshes) {
      if (!mesh.visible || !mesh.geometry) continue;
      mesh.updateMatrixWorld(true);

      const geometry = mesh.geometry as BufferGeometry;
      const position = geometry.getAttribute('position');
      if (!position) continue;

      // Cross-layer frustum culling: the geometry's local sphere, fitted to the
      // mesh's world matrix, tested against the camera's frustum.
      if (mesh.frustumCulled && geometry.boundingSphere) {
        this.worldBounds.setFromGeometry(geometry).update(mesh.matrixWorld);
        if (!frustum.intersectsSphere(this.worldBounds.sphere)) {
          culled++;
          continue;
        }
      }

      const total = position.count;
      for (let i = 0; i + 2 < total; i += 3) {
        this.vertexA
          .set(position.getX(i), position.getY(i), position.getZ(i))
          .applyMat4(mesh.matrixWorld);
        this.vertexB
          .set(position.getX(i + 1), position.getY(i + 1), position.getZ(i + 1))
          .applyMat4(mesh.matrixWorld);
        this.vertexC
          .set(position.getX(i + 2), position.getY(i + 2), position.getZ(i + 2))
          .applyMat4(mesh.matrixWorld);

        // Camera-space centroid: -z is the distance in front of the eye.
        const viewPoint = new Vec3(
          (this.vertexA.x + this.vertexB.x + this.vertexC.x) / 3,
          (this.vertexA.y + this.vertexB.y + this.vertexC.y) / 3,
          (this.vertexA.z + this.vertexB.z + this.vertexC.z) / 3,
        ).applyMat4(this.view);
        const distance = -viewPoint.z;
        if (distance <= camera.near) continue;

        // Flat normal, from the world-space edges.
        this.edgeA.copy(this.vertexB).sub(this.vertexA);
        this.edgeB.copy(this.vertexC).sub(this.vertexA);
        this.normal.crossVectors(this.edgeA, this.edgeB).normalize();
        const lambert = Math.abs(this.normal.dot(this.lightDirection));

        const points: { x: number; y: number }[] = [];
        let skipped = false;
        for (const vertex of [this.vertexA, this.vertexB, this.vertexC]) {
          // `applyMat4` divides by w, so this is already an NDC point.
          this.worldPoint.copy(vertex).applyMat4(this.viewProjection);
          if (!Number.isFinite(this.worldPoint.x) || !Number.isFinite(this.worldPoint.y)) {
            skipped = true;
            break;
          }
          points.push({
            x: (this.worldPoint.x * 0.5 + 0.5) * width,
            y: (-this.worldPoint.y * 0.5 + 0.5) * height,
          });
        }
        if (skipped) continue;

        surfaces.push({ depth: distance, points, shade: 0.1 + lambert * 0.78 });
      }
    }

    // Painter's algorithm: farthest first, because there is no depth buffer.
    surfaces.sort((a, b) => b.depth - a.depth);

    p.fillStyle = '#11151d';
    p.fillRect(0, 0, width, height);

    for (const surface of surfaces) {
      p.beginPath();
      p.moveTo(surface.points[0].x, surface.points[0].y);
      p.lineTo(surface.points[1].x, surface.points[1].y);
      p.lineTo(surface.points[2].x, surface.points[2].y);
      p.closePath();
      p.fillStyle = shadeColor(surface.shade);
      p.fill();
    }

    this.triangles = surfaces.length;
    this.culled = culled;
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
} else if (detectBackendStrict(BackendNames.Canvas2D, canvas) !== BackendNames.Canvas2D) {
  showNotice(
    'This example software-rasterises a 3D scene onto the Canvas2D backend, but no 2D ' +
      'canvas context could be created in this browser.',
  );
} else {
  const renderer = new Canvas2DRenderer({ canvas, clearColor: '#11151d', autoResize: true });

  // A real library camera: it owns projectionMatrix, projectionMatrixInverse,
  // matrixWorldInverse and the frustum, which is everything the projection needs.
  const camera = new PerspectiveCamera({ fov: 50, near: 0.1, far: 120 });

  const cubeGeometry = makeCube(1);
  const tubeGeometry = makeTube(1.5, 0.3);
  const cube = new Mesh({ name: 'cube', geometry: cubeGeometry, material: {} });
  const tube = new Mesh({ name: 'tube', geometry: tubeGeometry, material: {} });

  const pivot = new Object3D({ name: 'pivot' });
  pivot.add(cube);
  cube.position.set(2.9, 0, 0);
  cube.scale.setScalar(0.9);
  tube.scale.setScalar(0.8);

  const rasteriser = new SoftwareRasteriser([tube, cube], camera);

  // Orbit state, driven by pointer input written inline so the example has no
  // input-layer dependency; see `examples/controls` for the real controls layer.
  let yaw = 0.6;
  let pitch = 0.35;
  let distance = 9;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (event: PointerEvent): void => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) return;
    yaw -= (event.clientX - lastX) * 0.008;
    pitch = Math.max(-1.35, Math.min(1.35, pitch + (event.clientY - lastY) * 0.008));
    lastX = event.clientX;
    lastY = event.clientY;
  };
  const onPointerUp = (event: PointerEvent): void => {
    dragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    distance = Math.max(3.5, Math.min(26, distance * (1 + Math.sign(event.deltaY) * 0.08)));
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  let fps = 0;
  let frames = 0;
  let elapsed = 0;

  renderer.setAnimationLoop((_time, delta) => {
    tube.rotation.y += delta * 0.4;
    tube.rotation.x += delta * 0.17;
    pivot.rotation.y += delta * 0.9;
    rasteriser.orbit(yaw, pitch, distance);

    frames++;
    elapsed += delta;
    if (elapsed >= 0.25) {
      fps = frames / elapsed;
      frames = 0;
      elapsed = 0;
    }

    // `null` camera: the rasteriser owns the projection and the renderer only
    // needs to hand it a painter.
    renderer.render(rasteriser, null);

    overlay.textContent =
      `FPS        ${fps.toFixed(0)}\n` +
      `backend    ${renderer.backend}\n` +
      `triangles  ${rasteriser.triangles}\n` +
      `culled     ${rasteriser.culled}\n` +
      `distance   ${distance.toFixed(1)}`;
  }, { autoStart: true });

  dispose = (): void => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    renderer.setAnimationLoop(null);
    renderer.dispose();
    // Both meshes share their geometry with the builders, so release it here.
    tubeGeometry.dispose();
    cubeGeometry.dispose();
  };
}

window.addEventListener('beforeunload', dispose);
