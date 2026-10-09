/**
 * `TorusGeometry` — a doughnut: a circle of radius `radius` swept by a tube of
 * radius `tube`.
 *
 * The normals are analytic ($\hat{n} = (\cos\phi\cos\theta, \sin\phi,
 * \cos\phi\sin\theta)$ in the natural parameterisation), so the surface shades
 * exactly — no vertex averaging, no faceting artefacts on the silhouette.
 *
 * @packageDocumentation
 */

import { BufferGeometry } from '../../core/BufferGeometry';
import { GeometryBuilder } from './GeometryBuilder';
import type { GeometryGeneratorOptions } from '../types';

/** Options accepted by {@link TorusGeometry}. */
export interface TorusGeometryOptions extends GeometryGeneratorOptions {
  /** Distance from the centre of the torus to the centre of the tube. @default 1 */
  radius?: number;
  /** Tube radius. @default 0.4 */
  tube?: number;
  /** Divisions around the ring. @default 32 */
  radialSegments?: number;
  /** Divisions around the tube. @default 16 */
  tubularSegments?: number;
  /** Rotation of the tube's cross-section, in radians. @default 0 */
  arc?: number;
}

/**
 * Builds a torus centred on the origin in the XZ plane.
 *
 * @param options See {@link TorusGeometryOptions}.
 * @returns A new geometry with `position`, `normal` and `uv` attributes.
 */
export function createTorusGeometry(options: TorusGeometryOptions = {}): BufferGeometry {
  const radius = options.radius ?? 1;
  const tube = options.tube ?? 0.4;
  const radialSegments = Math.max(3, Math.floor(options.radialSegments ?? options.segments ?? 32));
  const tubularSegments = Math.max(3, Math.floor(options.tubularSegments ?? 16));
  const arc = options.arc ?? Math.PI * 2;

  const builder = new GeometryBuilder({
    normals: options.normals ?? true,
    uv: options.uv ?? true,
    indexed: options.indexed ?? true,
    name: options.name ?? 'TorusGeometry',
    initialCapacity: (radialSegments + 1) * (tubularSegments + 1),
  });

  const grid: number[][] = [];

  for (let i = 0; i <= radialSegments; i++) {
    const row: number[] = [];
    const u = i / radialSegments;
    const phi = u * arc; // Position around the ring.
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);

    for (let j = 0; j <= tubularSegments; j++) {
      const v = j / tubularSegments;
      const theta = v * Math.PI * 2; // Position around the tube.
      const cosTheta = Math.cos(theta);
      const sinTheta = Math.sin(theta);

      // Ring centre, then offset by the tube radius along the ring normal.
      const cx = radius * cosPhi;
      const cz = radius * sinPhi;

      const nx = cosTheta * cosPhi;
      const ny = sinTheta;
      const nz = cosTheta * sinPhi;

      row.push(
        builder.pushVertex(
          cx + tube * nx,
          tube * ny,
          cz + tube * nz,
          nx,
          ny,
          nz,
          u,
          v,
        ),
      );
    }
    grid.push(row);
  }

  for (let i = 0; i < radialSegments; i++) {
    for (let j = 0; j < tubularSegments; j++) {
      const a = grid[i][j];
      const b = grid[i + 1][j];
      const c = grid[i + 1][j + 1];
      const d = grid[i][j + 1];
      // Same layout as the cylinder wall — `a` at (ring i, tube j), `b` at
      // (ring i + 1, tube j), `d` at (ring i, tube j + 1) — so the same
      // counter-clockwise order applies.
      builder.pushTriangle(a, d, b);
      builder.pushTriangle(b, d, c);
    }
  }

  return builder.build();
}

/**
 * `TorusGeometry` — the class form of {@link createTorusGeometry}.
 */
export class TorusGeometry extends BufferGeometry {
  /** Creates a torus centred on the origin. */
  constructor(options: TorusGeometryOptions = {}) {
    super();
    const built = createTorusGeometry(options);
    this.copy(built);
    built.dispose();
  }
}
