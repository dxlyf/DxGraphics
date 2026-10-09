/**
 * `TetrahedronGeometry` — 4 faces, 4 vertices, 6 edges.
 *
 * @packageDocumentation
 */

import { BufferGeometry } from '../../core/BufferGeometry';
import { createPolyhedronGeometry } from './PolyhedronGeometry';
import { TETRAHEDRON } from './polyhedra';
import type { PolyhedronGeometryOptions } from './PolyhedronGeometry';

/** Options accepted by {@link TetrahedronGeometry}. */
export type TetrahedronGeometryOptions = PolyhedronGeometryOptions;

/**
 * Builds a tetrahedron.
 *
 * @param options See {@link PolyhedronGeometryOptions}.
 * @returns A new geometry with `position`, `normal` and `uv` attributes.
 */
export function createTetrahedronGeometry(options: TetrahedronGeometryOptions = {}): BufferGeometry {
  return createPolyhedronGeometry(TETRAHEDRON, { ...options, name: options.name ?? 'TetrahedronGeometry' });
}

/**
 * `TetrahedronGeometry` — the class form of {@link createTetrahedronGeometry}.
 */
export class TetrahedronGeometry extends BufferGeometry {
  /** Creates a tetrahedron. */
  constructor(options: TetrahedronGeometryOptions = {}) {
    super();
    const built = createTetrahedronGeometry(options);
    this.copy(built);
    built.dispose();
  }
}
