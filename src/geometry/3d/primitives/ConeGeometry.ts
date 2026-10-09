/**
 * `ConeGeometry` — a cylinder with a zero top radius.
 *
 * A very small, literal subclass: every interesting decision (the sloped wall
 * normal, the separate cap vertices, the seam) already lives in
 * {@link CylinderGeometry}. Keeping it as its own class means `instanceof
 * ConeGeometry` works and the geometry's `name` is honest in a debug overlay.
 *
 * @packageDocumentation
 */

import { BufferGeometry } from '../../core/BufferGeometry';
import { CylinderGeometry, createCylinderGeometry } from './CylinderGeometry';
import type { CylinderGeometryOptions } from './CylinderGeometry';

/** Options accepted by {@link ConeGeometry}. */
export interface ConeGeometryOptions extends Omit<CylinderGeometryOptions, 'radiusTop' | 'radiusBottom'> {
  /** Base radius. @default 1 */
  radius?: number;
  /** Height along Y. @default 1 */
  height?: number;
}

/**
 * Builds a cone with its apex at `+height / 2` and its base at `-height / 2`.
 *
 * @param options See {@link ConeGeometryOptions}.
 * @returns A new geometry with `position`, `normal` and `uv` attributes.
 */
export function createConeGeometry(options: ConeGeometryOptions = {}): BufferGeometry {
  const { radius = 1, ...rest } = options;
  return createCylinderGeometry({
    ...rest,
    radiusTop: 0,
    radiusBottom: radius,
    name: options.name ?? 'ConeGeometry',
  });
}

/**
 * `ConeGeometry` — the class form of {@link createConeGeometry}.
 */
export class ConeGeometry extends BufferGeometry {
  /** Creates a cone centred on the origin. */
  constructor(options: ConeGeometryOptions = {}) {
    super();
    const built = createConeGeometry(options);
    this.copy(built);
    built.dispose();
  }
}

/** Re-exported so `ConeGeometry` can be used interchangeably where a cylinder is expected. */
export type { CylinderGeometry };
