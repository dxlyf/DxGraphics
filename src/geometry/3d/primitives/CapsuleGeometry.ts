/**
 * `CapsuleGeometry` — a cylinder with hemispherical caps.
 *
 * ## Why this is not "a sphere plus a cylinder"
 *
 * Concatenating a sphere and a cylinder produces a visible seam and T-junctions
 * where the two surfaces meet. Instead the capsule is generated as one swept
 * surface: for each ring along the axis, the radius and the normal are taken from
 * the *sphere* equation, so the silhouette is exactly round and the normals are
 * continuous across the cap/wall junction.
 *
 * `capSegments` controls the latitude divisions inside each cap and
 * `radialSegments` the longitude divisions around the axis.
 *
 * @packageDocumentation
 */

import { BufferGeometry } from '../../core/BufferGeometry';
import { GeometryBuilder } from './GeometryBuilder';
import type { GeometryGeneratorOptions } from '../types';

/** Options accepted by {@link CapsuleGeometry}. */
export interface CapsuleGeometryOptions extends GeometryGeneratorOptions {
  /** Capsule radius. @default 0.5 */
  radius?: number;
  /** Length of the cylindrical section (excluding the caps). @default 1 */
  length?: number;
  /** Longitude divisions. @default 16 */
  radialSegments?: number;
  /** Latitude divisions inside each cap. @default 8 */
  capSegments?: number;
  /** Divisions along the cylindrical section. @default 1 */
  heightSegments?: number;
}

/**
 * Builds a capsule aligned with Y and centred on the origin.
 *
 * @param options See {@link CapsuleGeometryOptions}.
 * @returns A new geometry with `position`, `normal` and `uv` attributes.
 */
export function createCapsuleGeometry(options: CapsuleGeometryOptions = {}): BufferGeometry {
  const radius = Math.max(1e-6, options.radius ?? 0.5);
  const length = Math.max(0, options.length ?? 1);
  const radialSegments = Math.max(3, Math.floor(options.radialSegments ?? options.segments ?? 16));
  const capSegments = Math.max(1, Math.floor(options.capSegments ?? 8));
  const heightSegments = Math.max(1, Math.floor(options.heightSegments ?? 1));

  const builder = new GeometryBuilder({
    normals: options.normals ?? true,
    uv: options.uv ?? true,
    indexed: options.indexed ?? true,
    name: options.name ?? 'CapsuleGeometry',
    initialCapacity: (radialSegments + 1) * (capSegments * 2 + heightSegments + 2),
  });

  const halfLength = length * 0.5;

  /**
   * Emits one ring of vertices.
   *
   * @param y Centre height of the ring.
   * @param ringRadius Radius of the ring.
   * @param normalY Y component of the unit normal for this ring.
   * @param v Vertical texture coordinate.
   * @returns The ring's vertex indices, `radialSegments + 1` of them.
   */
  const pushRing = (y: number, ringRadius: number, normalY: number, v: number): number[] => {
    const ring: number[] = [];
    // The horizontal part of the normal shrinks as the ring approaches a pole.
    const horizontal = Math.sqrt(Math.max(0, 1 - normalY * normalY));

    for (let ix = 0; ix <= radialSegments; ix++) {
      const u = ix / radialSegments;
      const theta = u * Math.PI * 2;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);

      ring.push(
        builder.pushVertex(
          ringRadius * sinTheta,
          y,
          ringRadius * cosTheta,
          horizontal * sinTheta,
          normalY,
          horizontal * cosTheta,
          u,
          v,
        ),
      );
    }
    return ring;
  };

  // Bottom cap: sweep the latitude from the south pole up to the equator.
  const rings: number[][] = [];
  const totalSegments = capSegments * 2 + heightSegments;
  let segment = 0;

  for (let i = 0; i <= capSegments; i++) {
    const t = i / capSegments;
    // Latitude from -PI/2 (south pole) to 0 (equator).
    const latitude = -Math.PI * 0.5 + t * (Math.PI * 0.5);
    const ringRadius = radius * Math.cos(latitude);
    const normalY = Math.sin(latitude);
    const y = -halfLength + radius * normalY;
    const v = segment / totalSegments;
    rings.push(pushRing(y, ringRadius, normalY, v));
    segment++;
  }

  // Cylindrical section: the normal is horizontal, so only `y` changes.
  for (let i = 1; i <= heightSegments; i++) {
    const t = i / (heightSegments + 1);
    const y = -halfLength + length * t;
    const v = segment / totalSegments;
    rings.push(pushRing(y, radius, 0, v));
    segment++;
  }

  // Top cap: equator up to the north pole.
  for (let i = 0; i <= capSegments; i++) {
    const t = i / capSegments;
    const latitude = t * (Math.PI * 0.5);
    const ringRadius = radius * Math.cos(latitude);
    const normalY = Math.sin(latitude);
    const y = halfLength + radius * normalY;
    const v = segment / totalSegments;
    rings.push(pushRing(y, ringRadius, normalY, v));
    segment++;
  }

  for (let r = 0; r < rings.length - 1; r++) {
    for (let ix = 0; ix < radialSegments; ix++) {
      const a = rings[r][ix];
      const b = rings[r + 1][ix];
      const c = rings[r + 1][ix + 1];
      const d = rings[r][ix + 1];
      // Winding note: the rings are generated from the **south** pole upwards, so
      // `v` (the ring index) increases towards +Y — the opposite of the cylinder
      // wall, where `v` increases away from the base. That flips the handedness, so
      // the counter-clockwise order here is `(a, d, b)` then `(b, d, c)`.
      builder.pushTriangle(a, d, b);
      builder.pushTriangle(b, d, c);
    }
  }

  return builder.build();
}

/**
 * `CapsuleGeometry` — the class form of {@link createCapsuleGeometry}.
 */
export class CapsuleGeometry extends BufferGeometry {
  /** Creates a capsule aligned with Y. */
  constructor(options: CapsuleGeometryOptions = {}) {
    super();
    const built = createCapsuleGeometry(options);
    this.copy(built);
    built.dispose();
  }
}
