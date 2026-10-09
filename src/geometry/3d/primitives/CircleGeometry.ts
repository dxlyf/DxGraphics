/**
 * `CircleGeometry` — a filled disc in the XY plane, facing `+Z`.
 *
 * Built as a triangle fan around a centre vertex, which is the cheapest possible
 * disc and gives the texture mapping a disc wants: the centre is `(0.5, 0.5)` and
 * the rim maps onto the unit circle.
 *
 * @packageDocumentation
 */

import { BufferGeometry } from '../../core/BufferGeometry';
import { GeometryBuilder } from './GeometryBuilder';
import type { GeometryGeneratorOptions } from '../types';

/** Options accepted by {@link CircleGeometry}. */
export interface CircleGeometryOptions extends GeometryGeneratorOptions {
  /** Disc radius. @default 1 */
  radius?: number;
  /** Divisions around the rim. @default 32 */
  segments?: number;
  /** Angle to start at, in radians. @default 0 */
  thetaStart?: number;
  /** Angle span, in radians. @default Math.PI * 2 */
  thetaLength?: number;
}

/**
 * Builds a disc in the XY plane.
 *
 * @param options See {@link CircleGeometryOptions}.
 * @returns A new geometry with `position`, `normal` and `uv` attributes.
 */
export function createCircleGeometry(options: CircleGeometryOptions = {}): BufferGeometry {
  const radius = options.radius ?? 1;
  const segments = Math.max(3, Math.floor(options.segments ?? 32));
  const thetaStart = options.thetaStart ?? 0;
  const thetaLength = options.thetaLength ?? Math.PI * 2;

  const builder = new GeometryBuilder({
    normals: options.normals ?? true,
    uv: options.uv ?? true,
    indexed: options.indexed ?? true,
    name: options.name ?? 'CircleGeometry',
    initialCapacity: segments + 2,
  });

  const center = builder.pushVertex(0, 0, 0, 0, 0, 1, 0.5, 0.5);

  const ring: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const theta = thetaStart + t * thetaLength;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    ring.push(
      builder.pushVertex(
        radius * cosTheta,
        radius * sinTheta,
        0,
        0,
        0,
        1,
        cosTheta * 0.5 + 0.5,
        sinTheta * 0.5 + 0.5,
      ),
    );
  }

  for (let i = 0; i < segments; i++) {
    // Counter-clockwise seen from +Z, which is the documented facing.
    builder.pushTriangle(center, ring[i], ring[i + 1]);
  }

  return builder.build();
}

/**
 * `CircleGeometry` — the class form of {@link createCircleGeometry}.
 */
export class CircleGeometry extends BufferGeometry {
  /** Creates a disc in the XY plane. */
  constructor(options: CircleGeometryOptions = {}) {
    super();
    const built = createCircleGeometry(options);
    this.copy(built);
    built.dispose();
  }
}
