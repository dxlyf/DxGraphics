/**
 * `RingGeometry` — an annulus (a disc with a hole) in the XY plane.
 *
 * The inner and outer rims have independent radii, so the same generator produces
 * a washer, a flat torus outline or a radial gradient quad. Unlike `CircleGeometry`
 * there is no centre vertex, and the UVs are mapped to the **unit square** by
 * default (`uvMode: 'square'`) so a ring can be textured by a ring-shaped image;
 * `uvMode: 'polar'` maps `u` to the angle and `v` to the radius instead, which is
 * what a repeating radial pattern wants.
 *
 * @packageDocumentation
 */

import { BufferGeometry } from '../../core/BufferGeometry';
import { GeometryBuilder } from './GeometryBuilder';
import type { GeometryGeneratorOptions } from '../types';

/** How a ring's texture coordinates are laid out. */
export type RingUvMode = 'square' | 'polar';

/** Options accepted by {@link RingGeometry}. */
export interface RingGeometryOptions extends GeometryGeneratorOptions {
  /** Inner radius. @default 0.5 */
  innerRadius?: number;
  /** Outer radius. @default 1 */
  outerRadius?: number;
  /** Divisions around the ring. @default 32 */
  thetaSegments?: number;
  /** Divisions across the ring's width. @default 1 */
  phiSegments?: number;
  /** Angle to start at, in radians. @default 0 */
  thetaStart?: number;
  /** Angle span, in radians. @default Math.PI * 2 */
  thetaLength?: number;
  /** UV layout. @default 'square' */
  uvMode?: RingUvMode;
}

/**
 * Builds an annulus in the XY plane.
 *
 * @param options See {@link RingGeometryOptions}.
 * @returns A new geometry with `position`, `normal` and `uv` attributes.
 */
export function createRingGeometry(options: RingGeometryOptions = {}): BufferGeometry {
  const innerRadius = Math.max(0, options.innerRadius ?? 0.5);
  const outerRadius = Math.max(innerRadius, options.outerRadius ?? 1);
  const thetaSegments = Math.max(3, Math.floor(options.thetaSegments ?? options.segments ?? 32));
  const phiSegments = Math.max(1, Math.floor(options.phiSegments ?? 1));
  const thetaStart = options.thetaStart ?? 0;
  const thetaLength = options.thetaLength ?? Math.PI * 2;
  const uvMode = options.uvMode ?? 'square';

  const builder = new GeometryBuilder({
    normals: options.normals ?? true,
    uv: options.uv ?? true,
    indexed: options.indexed ?? true,
    name: options.name ?? 'RingGeometry',
    initialCapacity: (thetaSegments + 1) * (phiSegments + 1),
  });

  const radiusStep = (outerRadius - innerRadius) / phiSegments;
  const grid: number[][] = [];

  for (let iy = 0; iy <= phiSegments; iy++) {
    const row: number[] = [];
    const radius = innerRadius + iy * radiusStep;
    const v = phiSegments === 0 ? 0 : iy / phiSegments;

    for (let ix = 0; ix <= thetaSegments; ix++) {
      const u = ix / thetaSegments;
      const theta = thetaStart + u * thetaLength;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);

      const x = radius * cosTheta;
      const y = radius * sinTheta;

      const uv: [number, number] =
        uvMode === 'polar'
          ? [u, v]
          : [x / outerRadius * 0.5 + 0.5, y / outerRadius * 0.5 + 0.5];

      row.push(builder.pushVertex(x, y, 0, 0, 0, 1, uv[0], uv[1]));
    }
    grid.push(row);
  }

  for (let iy = 0; iy < phiSegments; iy++) {
    for (let ix = 0; ix < thetaSegments; ix++) {
      const a = grid[iy][ix];
      const b = grid[iy + 1][ix];
      const c = grid[iy + 1][ix + 1];
      const d = grid[iy][ix + 1];
      // Counter-clockwise seen from +Z.
      builder.pushTriangle(a, b, d);
      builder.pushTriangle(b, c, d);
    }
  }

  return builder.build();
}

/**
 * `RingGeometry` — the class form of {@link createRingGeometry}.
 */
export class RingGeometry extends BufferGeometry {
  /** Creates an annulus in the XY plane. */
  constructor(options: RingGeometryOptions = {}) {
    super();
    const built = createRingGeometry(options);
    this.copy(built);
    built.dispose();
  }
}
