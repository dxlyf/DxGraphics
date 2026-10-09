/**
 * `OctahedronGeometry` — 8 faces, 6 vertices, 12 edges.
 *
 * @packageDocumentation
 */

import { BufferGeometry } from '../../core/BufferGeometry';
import { createPolyhedronGeometry } from './PolyhedronGeometry';
import { OCTAHEDRON } from './polyhedra';
import type { PolyhedronGeometryOptions } from './PolyhedronGeometry';

/** Options accepted by {@link OctahedronGeometry}. */
export type OctahedronGeometryOptions = PolyhedronGeometryOptions;

/**
 * Builds an octahedron.
 *
 * @param options See {@link PolyhedronGeometryOptions}.
 * @returns A new geometry with `position`, `normal` and `uv` attributes.
 */
export function createOctahedronGeometry(options: OctahedronGeometryOptions = {}): BufferGeometry {
  return createPolyhedronGeometry(OCTAHEDRON, { ...options, name: options.name ?? 'OctahedronGeometry' });
}

/**
 * `OctahedronGeometry` — the class form of {@link createOctahedronGeometry}.
 */
export class OctahedronGeometry extends BufferGeometry {
  /** Creates an octahedron. */
  constructor(options: OctahedronGeometryOptions = {}) {
    super();
    const built = createOctahedronGeometry(options);
    this.copy(built);
    built.dispose();
  }
}
