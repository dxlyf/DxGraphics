/**
 * `IcosahedronGeometry` — 20 faces, 12 vertices, 30 edges.
 *
 * The best Platonic solid to subdivide: `detail: 1` already reads as a sphere at
 * moderate distance, because the base solid's faces are the closest of the five to
 * equilateral.
 *
 * @packageDocumentation
 */

import { BufferGeometry } from '../../core/BufferGeometry';
import { createPolyhedronGeometry } from './PolyhedronGeometry';
import { ICOSAHEDRON } from './polyhedra';
import type { PolyhedronGeometryOptions } from './PolyhedronGeometry';

/** Options accepted by {@link IcosahedronGeometry}. */
export type IcosahedronGeometryOptions = PolyhedronGeometryOptions;

/**
 * Builds an icosahedron.
 *
 * @param options See {@link PolyhedronGeometryOptions}.
 * @returns A new geometry with `position`, `normal` and `uv` attributes.
 */
export function createIcosahedronGeometry(options: IcosahedronGeometryOptions = {}): BufferGeometry {
  return createPolyhedronGeometry(ICOSAHEDRON, { ...options, name: options.name ?? 'IcosahedronGeometry' });
}

/**
 * `IcosahedronGeometry` — the class form of {@link createIcosahedronGeometry}.
 */
export class IcosahedronGeometry extends BufferGeometry {
  /** Creates an icosahedron. */
  constructor(options: IcosahedronGeometryOptions = {}) {
    super();
    const built = createIcosahedronGeometry(options);
    this.copy(built);
    built.dispose();
  }
}
