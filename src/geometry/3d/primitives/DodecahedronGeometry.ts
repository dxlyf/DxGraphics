/**
 * `DodecahedronGeometry` — 12 pentagonal faces (36 triangles), 20 vertices.
 *
 * The face table is derived at module load rather than hand-typed; see
 * {@link DODECAHEDRON} for why, and `tests/unit/geometry-3d.test.ts` for the
 * topological checks that keep it honest.
 *
 * @packageDocumentation
 */

import { BufferGeometry } from '../../core/BufferGeometry';
import { createPolyhedronGeometry } from './PolyhedronGeometry';
import { DODECAHEDRON } from './polyhedra';
import type { PolyhedronGeometryOptions } from './PolyhedronGeometry';

/** Options accepted by {@link DodecahedronGeometry}. */
export type DodecahedronGeometryOptions = PolyhedronGeometryOptions;

/**
 * Builds a dodecahedron.
 *
 * @param options See {@link PolyhedronGeometryOptions}.
 * @returns A new geometry with `position`, `normal` and `uv` attributes.
 */
export function createDodecahedronGeometry(
  options: DodecahedronGeometryOptions = {},
): BufferGeometry {
  return createPolyhedronGeometry(DODECAHEDRON, { ...options, name: options.name ?? 'DodecahedronGeometry' });
}

/**
 * `DodecahedronGeometry` — the class form of {@link createDodecahedronGeometry}.
 */
export class DodecahedronGeometry extends BufferGeometry {
  /** Creates a dodecahedron. */
  constructor(options: DodecahedronGeometryOptions = {}) {
    super();
    const built = createDodecahedronGeometry(options);
    this.copy(built);
    built.dispose();
  }
}
