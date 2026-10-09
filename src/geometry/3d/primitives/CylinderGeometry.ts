/**
 * `CylinderGeometry` — a capped tube, and the base for `ConeGeometry`.
 *
 * ## Why the caps are separate geometry
 *
 * A cylinder's side wall has a normal perpendicular to the axis while a cap has a
 * normal along it. Sharing vertices across that edge would force an averaged normal
 * and produce a visibly rounded rim, so the wall, the top cap and the bottom cap
 * each get their own vertices. That is the convention a textured cylinder needs:
 * the wall's `u` wraps continuously around the axis, while a cap's `u`/`v` map to a
 * disc.
 *
 * A zero top radius produces a cone; a non-zero `radiusTop` with a shorter `height`
 * produces a frustum.
 *
 * @packageDocumentation
 */

import { BufferGeometry } from '../../core/BufferGeometry';
import { GeometryBuilder } from './GeometryBuilder';
import type { GeometryGeneratorOptions } from '../types';

/** Options accepted by {@link CylinderGeometry}. */
export interface CylinderGeometryOptions extends GeometryGeneratorOptions {
  /** Radius at the top. @default 1 */
  radiusTop?: number;
  /** Radius at the bottom. @default 1 */
  radiusBottom?: number;
  /** Height along Y. @default 1 */
  height?: number;
  /** Divisions around the axis. @default 32 */
  radialSegments?: number;
  /** Divisions along the axis. @default 1 */
  heightSegments?: number;
  /** Emit the top cap. @default true */
  capTop?: boolean;
  /** Emit the bottom cap. @default true */
  capBottom?: boolean;
  /** Angle to start at, in radians. @default 0 */
  thetaStart?: number;
  /** Angle span, in radians. @default Math.PI * 2 */
  thetaLength?: number;
}

/** Clamps a segment count to a usable minimum. */
function clampSegments(value: number | undefined, fallback: number, minimum: number): number {
  return Math.max(minimum, Math.floor(value ?? fallback));
}

/**
 * Builds a cylinder (or cone/frustum) centred on the origin, aligned with Y.
 *
 * @param options See {@link CylinderGeometryOptions}.
 * @returns A new geometry with `position`, `normal` and `uv` attributes.
 */
export function createCylinderGeometry(options: CylinderGeometryOptions = {}): BufferGeometry {
  const radiusTop = Math.max(0, options.radiusTop ?? 1);
  const radiusBottom = Math.max(0, options.radiusBottom ?? 1);
  const height = options.height ?? 1;
  const radialSegments = clampSegments(options.radialSegments ?? options.segments, 32, 3);
  const heightSegments = clampSegments(options.heightSegments, 1, 1);
  const thetaStart = options.thetaStart ?? 0;
  const thetaLength = options.thetaLength ?? Math.PI * 2;
  const capTop = options.capTop ?? options.capTop !== false;
  const capBottom = options.capBottom ?? true;

  const builder = new GeometryBuilder({
    normals: options.normals ?? true,
    uv: options.uv ?? true,
    indexed: options.indexed ?? true,
    name: options.name ?? 'CylinderGeometry',
    initialCapacity: (radialSegments + 1) * (heightSegments + 1) + radialSegments * 4,
  });

  const halfHeight = height * 0.5;
  // Rate at which the radius changes along +Y, used to tilt the wall normal so a
  // cone shades as a cone rather than as a cylinder with a seam.
  const slope = (radiusBottom - radiusTop) / height;

  // Side wall: a (radialSegments + 1) x (heightSegments + 1) grid, with the seam
  // duplicated so `u` can reach 1.
  const wall: number[][] = [];
  for (let iy = 0; iy <= heightSegments; iy++) {
    const row: number[] = [];
    // `v` runs from the **bottom** (v = 0) to the top (v = 1), so `iy = 0` is the
    // `radiusBottom` ring. Getting this the wrong way round silently produces an
    // upside-down cone: the geometry is still valid, but `radiusTop` ends up at the
    // bottom and the apex points the wrong way.
    const v = iy / heightSegments;
    const y = -halfHeight + height * v;
    const ringRadius = radiusBottom + (radiusTop - radiusBottom) * v;

    for (let ix = 0; ix <= radialSegments; ix++) {
      const u = ix / radialSegments;
      const theta = thetaStart + u * thetaLength;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);

      const x = ringRadius * sinTheta;
      const z = ringRadius * cosTheta;

      const normalLength = Math.hypot(sinTheta, slope, cosTheta) || 1;
      const nx = sinTheta / normalLength;
      const ny = slope / normalLength;
      const nz = cosTheta / normalLength;

      row.push(builder.pushVertex(x, y, z, nx, ny, nz, u, 1 - v));
    }
    wall.push(row);
  }

  for (let ix = 0; ix < radialSegments; ix++) {
    for (let iy = 0; iy < heightSegments; iy++) {
      const a = wall[iy][ix];
      const b = wall[iy + 1][ix];
      const c = wall[iy + 1][ix + 1];
      const d = wall[iy][ix + 1];
      // Winding: here `u` increases along the angle and `v` upwards, and the vertex
      // order is `a = (ix, iy)`, `b = (ix, iy + 1)` (up), `d = (ix + 1, iy)` (right).
      // The counter-clockwise order seen from outside is therefore
      // `(a, d, b)` then `(b, d, c)` — i.e. the short edge is traversed from
      // lower-left to lower-right. Emitting `(a, b, d)` instead inverts every wall
      // triangle, which renders correctly with culling disabled and disappears with
      // it enabled.
      builder.pushTriangle(a, d, b);
      builder.pushTriangle(b, d, c);
    }
  }

  /**
   * Emits a circular cap.
   *
   * @param radius Cap radius.
   * @param y Plane offset along Y.
   * @param upward `true` for the top cap (normal `+Y`).
   */
  const buildCap = (radius: number, y: number, upward: boolean): void => {
    if (radius <= 0) return;

    const center = builder.pushVertex(0, y, 0, 0, upward ? 1 : -1, 0, 0.5, 0.5);

    const ring: number[] = [];
    for (let ix = 0; ix <= radialSegments; ix++) {
      const u = ix / radialSegments;
      const theta = thetaStart + u * thetaLength;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);
      const x = radius * sinTheta;
      const z = radius * cosTheta;
      // Map the disc onto a texture square: the seam lands at the +v edge.
      ring.push(builder.pushVertex(x, y, z, 0, upward ? 1 : -1, 0, sinTheta * 0.5 + 0.5, cosTheta * 0.5 + 0.5));
    }

    for (let ix = 0; ix < radialSegments; ix++) {
      if (upward) builder.pushTriangle(center, ring[ix], ring[ix + 1]);
      else builder.pushTriangle(center, ring[ix + 1], ring[ix]);
    }
  };

  if (capTop) buildCap(radiusTop, halfHeight, true);
  if (capBottom) buildCap(radiusBottom, -halfHeight, false);

  return builder.build();
}

/**
 * `CylinderGeometry` — the class form of {@link createCylinderGeometry}.
 */
export class CylinderGeometry extends BufferGeometry {
  /** Creates a cylinder, cone or frustum centred on the origin. */
  constructor(options: CylinderGeometryOptions = {}) {
    super();
    const built = createCylinderGeometry(options);
    this.copy(built);
    built.dispose();
  }
}
