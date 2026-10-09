/**
 * Regression tests for the camera/frustum contracts that `examples/3d-basic` depends
 * on, plus a headless run of that example's real software rasteriser.
 *
 * ## The bug these tests pin
 *
 * `examples/3d-basic` rendered **nothing**, and the cause was in `src/`:
 *
 *  1. **`Camera3D` never refreshed its `frustum`.** A `Frustum` starts with all six
 *     planes at `normal = (0, 0, 1), constant = 0`, and `distanceToSphere` against
 *     those is `-radius` — negative for any non-empty volume. So every
 *     `intersectsSphere` call through a stale frustum returned `false` and the example
 *     culled 100% of its geometry: a blank canvas with no error attached.
 *  2. **`BoundingVolume.update()` required an explicit matrix.** `box`/`sphere` are the
 *     world-space pair and stay empty (`radius = -1`) until `update()` runs, so reading
 *     `volume.sphere` after `setFromBox` silently rejected everything.
 *
 * The rasteriser below is a faithful transcription of the example's `SoftwareRasteriser`
 * (same view/projection composition, same near-plane test, same NDC mapping, same
 * painter sort). It draws through a stub 2D context, so the test fails if any of those
 * stages regress.
 */

import { describe, expect, it } from 'vitest';
import {
  BoundingVolume,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mat4,
  Mesh,
  PerspectiveCamera,
  Vec3,
} from '../../src/index';
import { Object3D } from '../../src/scene/3d/Object3D';

/* ----------------------------------------------------------------- stub canvas */

/** One recorded 2D call. */
interface RecordedCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

/** The subset of `CanvasRenderingContext2D` the rasteriser touches. */
interface StubContext {
  canvas: { width: number; height: number };
  calls: RecordedCall[];
  save(): void;
  restore(): void;
  resetTransform(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  fillStyle: string;
}

/** Creates a stub context that records every call. */
function makeStubContext(width: number, height: number): StubContext {
  const calls: RecordedCall[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push({ name, args });
    };

  let fillStyle = '#000';
  return {
    canvas: { width, height },
    calls,
    save: record('save'),
    restore: record('restore'),
    resetTransform: record('resetTransform'),
    setTransform: record('setTransform') as StubContext['setTransform'],
    clearRect: record('clearRect') as StubContext['clearRect'],
    fillRect: record('fillRect') as StubContext['fillRect'],
    beginPath: record('beginPath'),
    moveTo: record('moveTo') as StubContext['moveTo'],
    lineTo: record('lineTo') as StubContext['lineTo'],
    closePath: record('closePath'),
    fill: record('fill'),
    get fillStyle(): string {
      return fillStyle;
    },
    set fillStyle(value: string) {
      fillStyle = value;
      calls.push({ name: 'fillStyle', args: [value] });
    },
  };
}

/** The painter surface the example uses. */
interface StubPainter {
  getContext(): StubContext;
  resetTransform(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
}

/** Wraps a stub context in the painter interface. */
function makePainter(context: StubContext): StubPainter {
  return {
    getContext: () => context,
    resetTransform: () => context.resetTransform(),
    setTransform: (a, b, c, d, e, f) => context.setTransform(a, b, c, d, e, f),
    get fillStyle() {
      return context.fillStyle;
    },
    set fillStyle(value: string) {
      context.fillStyle = value;
    },
    fillRect: (x, y, w, h) => context.fillRect(x, y, w, h),
    beginPath: () => context.beginPath(),
    moveTo: (x, y) => context.moveTo(x, y),
    lineTo: (x, y) => context.lineTo(x, y),
    closePath: () => context.closePath(),
    fill: () => context.fill(),
  };
}

/* ------------------------------------------------------ the example's builders */

/** Builds a non-indexed geometry, as the example does. */
function makeGeometry(positions: readonly number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** An axis-aligned cube of half-extent `h`. */
function makeCube(h: number): BufferGeometry {
  const corners: [number, number, number][] = [
    [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
    [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
  ];
  const quads: [number, number, number, number][] = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5],
  ];
  const positions: number[] = [];
  for (const [a, b, c, d] of quads) {
    for (const v of [corners[a], corners[b], corners[c], corners[a], corners[c], corners[d]]) {
      positions.push(v[0], v[1], v[2]);
    }
  }
  return makeGeometry(positions);
}

/** A tube swept along the example's trefoil curve. */
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
    const normal = new Vec3(0, 0, 1).sub(tangent.clone().multiplyScalar(tangent.z)).normalize();
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
      const c = rings[next][jn];
      const d = rings[i][jn];
      for (const v of [a, b, c, a, c, d]) positions.push(v.x, v.y, v.z);
    }
  }
  return makeGeometry(positions);
}

/** Base albedo shared by every surface. */
const BASE_ALBEDO = new Color('#2f6fdf');

/** Lerps the albedo towards white by `amount`. */
function shadeColor(amount: number): string {
  return new Color()
    .copy(BASE_ALBEDO)
    .lerp(new Color(1, 1, 1, 1), Math.min(1, Math.max(0, amount)))
    .toCssString();
}

/** One projected, shaded triangle ready for the painter. */
interface Surface {
  readonly depth: number;
  readonly points: { x: number; y: number }[];
  readonly shade: number;
}

/** What the rasteriser observed in its most recent frame. */
interface RasteriserDiagnostics {
  meshesVisited: number;
  culled: number;
  behindNear: number;
  nonFinite: number;
  surfaces: number;
}

/**
 * A faithful transcription of the example's `SoftwareRasteriser`.
 *
 * Only `window.devicePixelRatio` differs, because a Node process has no `window`;
 * every stage that decides what appears on screen is identical.
 */
class SoftwareRasteriser {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;
  public triangles = 0;
  public culled = 0;
  public readonly diagnostics: RasteriserDiagnostics = {
    meshesVisited: 0,
    culled: 0,
    behindNear: 0,
    nonFinite: 0,
    surfaces: 0,
  };

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

  public constructor(
    private readonly meshes: Mesh[],
    private readonly camera: PerspectiveCamera,
  ) {}

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
    const p = painter as StubPainter;
    const context = p.getContext();
    const ratio = 1;
    const width = context.canvas.width / ratio;
    const height = context.canvas.height / ratio;

    // Per-frame counters, not lifetime totals: the overlay reports the frame it just
    // drew, so accumulating across frames would show a number that only grows.
    this.diagnostics.meshesVisited = 0;
    this.diagnostics.culled = 0;
    this.diagnostics.behindNear = 0;
    this.diagnostics.nonFinite = 0;
    this.diagnostics.surfaces = 0;

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
      this.diagnostics.meshesVisited++;
      mesh.updateMatrixWorld(true);

      const geometry = mesh.geometry as BufferGeometry;
      const position = geometry.getAttribute('position');
      if (!position) continue;

      if (mesh.frustumCulled && geometry.boundingSphere) {
        this.worldBounds.setFromGeometry(geometry).update(mesh.matrixWorld);
        if (!frustum.intersectsSphere(this.worldBounds.sphere)) {
          culled++;
          this.diagnostics.culled++;
          continue;
        }
      }

      const total = position.count;
      for (let i = 0; i + 2 < total; i += 3) {
        this.vertexA.set(position.getX(i), position.getY(i), position.getZ(i)).applyMat4(mesh.matrixWorld);
        this.vertexB
          .set(position.getX(i + 1), position.getY(i + 1), position.getZ(i + 1))
          .applyMat4(mesh.matrixWorld);
        this.vertexC
          .set(position.getX(i + 2), position.getY(i + 2), position.getZ(i + 2))
          .applyMat4(mesh.matrixWorld);

        const viewPoint = new Vec3(
          (this.vertexA.x + this.vertexB.x + this.vertexC.x) / 3,
          (this.vertexA.y + this.vertexB.y + this.vertexC.y) / 3,
          (this.vertexA.z + this.vertexB.z + this.vertexC.z) / 3,
        ).applyMat4(this.view);
        const distance = -viewPoint.z;
        if (distance <= camera.near) {
          this.diagnostics.behindNear++;
          continue;
        }

        this.edgeA.copy(this.vertexB).sub(this.vertexA);
        this.edgeB.copy(this.vertexC).sub(this.vertexA);
        this.normal.crossVectors(this.edgeA, this.edgeB).normalize();
        const lambert = Math.abs(this.normal.dot(this.lightDirection));

        const points: { x: number; y: number }[] = [];
        let skipped = false;
        for (const vertex of [this.vertexA, this.vertexB, this.vertexC]) {
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
        if (skipped) {
          this.diagnostics.nonFinite++;
          continue;
        }

        surfaces.push({ depth: distance, points, shade: 0.1 + lambert * 0.78 });
      }
    }

    surfaces.sort((a, b) => b.depth - a.depth);
    this.diagnostics.surfaces = surfaces.length;

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

/* ---------------------------------------------------------------------- tests */

describe('Camera3D.frustum', () => {
  it('is built by updateMatrixWorld alone, with no explicit updateFrustum call', () => {
    // A stale `Frustum` has every plane at `(0, 0, 1), constant = 0`, against which
    // `distanceToSphere` is `-radius` and so negative for every non-empty volume. Any
    // consumer that culls through `camera.frustum` after the documented
    // `updateMatrixWorld(true)` would therefore reject the whole scene.
    const camera = new PerspectiveCamera({ fov: 50, aspect: 1, near: 0.1, far: 100 });
    camera.position.set(0, 0, 10);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    // A built frustum has unit-length plane normals; an untouched one does not.
    for (const plane of camera.frustum.planes) {
      expect(plane.normal.length()).toBeCloseTo(1, 5);
    }

    // A point at the origin is 10 units in front of the camera and must be visible.
    expect(camera.frustum.containsPoint(new Vec3(0, 0, 0))).toBe(true);

    // A unit box there must intersect: it sits well inside 0.1..100.
    const inside = new BoundingVolume()
      .setFromBox(new Box3(new Vec3(-1, -1, -1), new Vec3(1, 1, 1)))
      .update();
    expect(camera.frustum.intersectsSphere(inside.sphere)).toBe(true);
    expect(camera.frustum.intersectsBox(inside.box)).toBe(true);
  });

  it('stays current when the camera moves', () => {
    const camera = new PerspectiveCamera({ fov: 50, aspect: 1, near: 0.1, far: 100 });
    camera.position.set(0, 0, 10);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    expect(camera.frustum.containsPoint(new Vec3(0, 0, 0))).toBe(true);

    // Move the eye behind the origin: the same world point is now behind the camera.
    camera.position.set(0, 0, -10);
    camera.updateMatrixWorld(true);
    expect(camera.frustum.containsPoint(new Vec3(0, 0, 0))).toBe(false);
  });

  it('rejects a volume pushed past the far plane', () => {
    const camera = new PerspectiveCamera({ fov: 50, aspect: 1, near: 0.1, far: 100 });
    camera.position.set(0, 0, 10);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    // `Mat4.fromTranslation` takes a `Vec3`; `makeTranslation` takes three numbers.
    const beyond = new BoundingVolume()
      .setFromBox(new Box3(new Vec3(-1, -1, -1), new Vec3(1, 1, 1)))
      .update(Mat4.fromTranslation(new Vec3(0, 0, -200)));

    expect(beyond.sphere.center.z).toBeCloseTo(-200, 6);
    expect(camera.frustum.intersectsSphere(beyond.sphere)).toBe(false);
    expect(camera.frustum.intersectsBox(beyond.box)).toBe(false);
  });
});

describe('BoundingVolume.update', () => {
  it('publishes world bounds when called without a matrix', () => {
    // `box`/`sphere` are the world-space pair and stay empty (`radius = -1`) until
    // `update()` runs. Defaulting the matrix to identity means "the local bounds are
    // the world bounds", which removes the trap where reading `volume.sphere` straight
    // after `setFromBox` silently rejected everything.
    const volume = new BoundingVolume().setFromBox(new Box3(new Vec3(-1, -1, -1), new Vec3(1, 1, 1)));

    expect(volume.sphere.radius).toBeLessThan(0);
    expect(volume.localSphere.radius).toBeCloseTo(Math.sqrt(3), 5);

    volume.update();

    expect(volume.hasWorldBounds).toBe(true);
    expect(volume.sphere.radius).toBeCloseTo(Math.sqrt(3), 5);
    expect(volume.sphere.center.toArray()).toEqual([0, 0, 0]);
    expect(volume.box.min.toArray()).toEqual([-1, -1, -1]);
    expect(volume.box.max.toArray()).toEqual([1, 1, 1]);
  });
});

describe('examples/3d-basic, headless', () => {
  it('draws the cube once the frustum is current', () => {
    const context = makeStubContext(880, 560);
    const painter = makePainter(context);

    const camera = new PerspectiveCamera({ fov: 50, near: 0.1, far: 120 });
    const cube = new Mesh({ name: 'cube', geometry: makeCube(1), material: {} });
    const pivot = new Object3D({ name: 'pivot' });
    pivot.add(cube);
    cube.position.set(2.9, 0, 0);
    cube.scale.setScalar(0.9);

    const rasteriser = new SoftwareRasteriser([cube], camera);
    rasteriser.orbit(0.6, 0.35, 9);
    rasteriser.render(painter);

    // A cube is 12 triangles, and none of them may be culled.
    expect(rasteriser.diagnostics.meshesVisited).toBe(1);
    expect(rasteriser.culled).toBe(0);
    expect(rasteriser.triangles).toBe(12);
    expect(context.calls.filter((call) => call.name === 'fill')).toHaveLength(12);
    // The frame is cleared before anything is drawn.
    expect(context.calls.filter((call) => call.name === 'fillRect')).toHaveLength(1);
  });

  it('draws both meshes of the full scene on every orbited frame', () => {
    const context = makeStubContext(880, 560);
    const painter = makePainter(context);

    const camera = new PerspectiveCamera({ fov: 50, near: 0.1, far: 120 });
    const cube = new Mesh({ name: 'cube', geometry: makeCube(1), material: {} });
    const tube = new Mesh({ name: 'tube', geometry: makeTube(1.5, 0.3, 60, 7), material: {} });

    const pivot = new Object3D({ name: 'pivot' });
    pivot.add(cube);
    cube.position.set(2.9, 0, 0);
    cube.scale.setScalar(0.9);
    tube.scale.setScalar(0.8);

    const rasteriser = new SoftwareRasteriser([tube, cube], camera);

    let minimum = Infinity;
    let yaw = 0.6;
    for (let frame = 0; frame < 12; frame++) {
      tube.rotation.y += 0.05;
      yaw += 0.5;
      rasteriser.orbit(yaw, 0.35, 9);
      rasteriser.render(painter);

      // 60 x 7 x 2 = 840 tube triangles, plus 12 for the cube.
      expect(rasteriser.diagnostics.meshesVisited).toBe(2);
      expect(rasteriser.culled).toBe(0);
      minimum = Math.min(minimum, rasteriser.triangles);
    }

    expect(minimum).toBeGreaterThanOrEqual(852);
  });
});
