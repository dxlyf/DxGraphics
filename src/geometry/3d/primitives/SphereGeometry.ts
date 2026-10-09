/**
 * `SphereGeometry` — a UV sphere with optional polar caps and phi/theta ranges.
 *
 * ## Why the poles get their own vertices
 *
 * A UV sphere is singular at the poles: every triangle in the top ring shares the
 * pole, where `u` is undefined. Emitting a single pole vertex pinches the texture
 * there. The standard fix, used here, is to emit **one pole vertex per longitude
 * segment** so each polar triangle carries its own `u`. The extra vertices
 * coincide in space, costing a few floats and removing the pinch.
 *
 * `phiStart`/`phiLength` slice the sphere around its axis (longitude) and
 * `thetaStart`/`thetaLength` cut towards the poles (latitude): pass
 * `thetaLength: Math.PI / 2` for a dome, `Math.PI` for a full sphere and a partial
 * `phiLength` for a wedge.
 *
 * @packageDocumentation
 */

import { BufferGeometry } from '../../core/BufferGeometry';
import { GeometryBuilder } from './GeometryBuilder';
import type { GeometryGeneratorOptions } from '../types';

/** Options accepted by {@link SphereGeometry}. */
export interface SphereGeometryOptions extends GeometryGeneratorOptions {
  /** Sphere radius. @default 1 */
  radius?: number;
  /** Longitude divisions. @default 32 */
  widthSegments?: number;
  /** Latitude divisions. @default 16 */
  heightSegments?: number;
  /** Longitude to start at, in radians. @default 0 */
  phiStart?: number;
  /** Longitude span, in radians. @default Math.PI * 2 */
  phiLength?: number;
  /** Latitude to start at, in radians (`0` is the north pole). @default 0 */
  thetaStart?: number;
  /** Latitude span, in radians. @default Math.PI */
  thetaLength?: number;
}

/** Clamps a segment count to a usable minimum. */
function clampSegments(value: number | undefined, fallback: number, minimum: number): number {
  return Math.max(minimum, Math.floor(value ?? fallback));
}

/**
 * Builds a sphere centred on the origin.
 *
 * @param options See {@link SphereGeometryOptions}.
 * @returns A new geometry with `position`, `normal` and `uv` attributes.
 */
export function createSphereGeometry(options: SphereGeometryOptions = {}): BufferGeometry {
  const radius = options.radius ?? 1;
  const widthSegments = clampSegments(options.widthSegments ?? options.segments, 32, 3);
  const heightSegments = clampSegments(options.heightSegments, 16, 2);
  const phiStart = options.phiStart ?? 0;
  const phiLength = options.phiLength ?? Math.PI * 2;
  const thetaStart = options.thetaStart ?? 0;
  const thetaLength = options.thetaLength ?? Math.PI;

  const builder = new GeometryBuilder({
    normals: options.normals ?? true,
    uv: options.uv ?? true,
    indexed: options.indexed ?? true,
    name: options.name ?? 'SphereGeometry',
    initialCapacity: (widthSegments + 1) * (heightSegments + 1) + widthSegments * 2,
  });

  const thetaEnd = thetaStart + thetaLength;
  const hasNorthPole = thetaStart <= 1e-9;
  const hasSouthPole = thetaEnd >= Math.PI - 1e-9;
  // Latitude rows `1 .. heightSegments - 1` are the non-singular rings; when a
  // cap is absent the corresponding boundary row is a real ring instead.
  const firstRing = hasNorthPole ? 1 : 0;
  const lastRing = hasSouthPole ? heightSegments - 1 : heightSegments;
  const inverseRadius = radius > 0 ? 1 / radius : 0;

  /**
   * Emits a vertex at longitude index `ix` (may be fractional for a pole apex) and
   * latitude index `iy`.
   *
   * @param ix Longitude index.
   * @param iy Latitude index.
   * @returns The new vertex index.
   */
  const push = (ix: number, iy: number): number => {
    const u = ix / widthSegments;
    const v = iy / heightSegments;

    const phi = phiStart + u * phiLength;
    const theta = thetaStart + v * thetaLength;

    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);

    const x = -radius * Math.cos(phi) * sinTheta;
    const y = radius * cosTheta;
    const z = radius * Math.sin(phi) * sinTheta;

    // A sphere's normal is its position direction, so this is exact and free.
    return builder.pushVertex(
      x,
      y,
      z,
      x * inverseRadius,
      y * inverseRadius,
      z * inverseRadius,
      u,
      1 - v,
    );
  };

  // Ring vertices, row by row, plus a per-segment apex for each cap.
  const rings: number[][] = [];
  for (let iy = firstRing; iy <= lastRing; iy++) {
    const row: number[] = [];
    for (let ix = 0; ix <= widthSegments; ix++) row.push(push(ix, iy));
    rings.push(row);
  }

  const northApex: number[] = [];
  if (hasNorthPole) {
    for (let ix = 0; ix < widthSegments; ix++) northApex.push(push(ix + 0.5, 0));
  }

  const southApex: number[] = [];
  if (hasSouthPole) {
    for (let ix = 0; ix < widthSegments; ix++) southApex.push(push(ix + 0.5, heightSegments));
  }

  for (let segment = 0; segment < widthSegments; segment++) {
    const north = hasNorthPole ? northApex[segment] : -1;
    const south = hasSouthPole ? southApex[segment] : -1;

    for (let ring = 0; ring < rings.length - 1; ring++) {
      const topLeft = rings[ring][segment];
      const topRight = rings[ring][segment + 1];
      const bottomLeft = rings[ring + 1][segment];
      const bottomRight = rings[ring + 1][segment + 1];

      if (hasNorthPole && ring === 0) {
        // The top row is the first ring, one step below the pole, so this quad is
        // a triangle from the apex down to that ring.
        builder.pushTriangle(north, bottomLeft, bottomRight);
      } else if (hasSouthPole && ring === rings.length - 2) {
        // Mirror case: a triangle from the last ring down to the south apex.
        builder.pushTriangle(topLeft, bottomLeft, south);
      } else {
        // A sphere's `(u, v)` frame is right-handed with the outward normal: `u`
        // runs along increasing longitude (+theta) and `v` runs towards the south
        // pole, and `dP/du x dP/dv` points outward. So the counter-clockwise order
        // seen from outside is `(topLeft, bottomLeft, bottomRight)` then
        // `(topLeft, bottomRight, topRight)`.
        builder.pushTriangle(topLeft, bottomLeft, bottomRight);
        builder.pushTriangle(topLeft, bottomRight, topRight);
      }
    }
  }

  return builder.build();
}

/**
 * `SphereGeometry` — the class form of {@link createSphereGeometry}.
 */
export class SphereGeometry extends BufferGeometry {
  /** Creates a sphere centred on the origin. */
  constructor(options: SphereGeometryOptions = {}) {
    super();
    const built = createSphereGeometry(options);
    this.copy(built);
    built.dispose();
  }
}
