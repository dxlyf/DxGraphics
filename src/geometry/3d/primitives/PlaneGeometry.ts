/**
 * `PlaneGeometry` — a subdivided rectangle in the XY plane, facing `+Z`.
 *
 * The default facing and UV origin match what a texture-mapped sprite or a
 * full-screen quad needs: `u` runs `-X` to `+X`, `v` runs `-Y` to `+Y`, and the
 * winding is counter-clockwise when viewed from `+Z`.
 *
 * @packageDocumentation
 */

import { BufferGeometry } from '../../core/BufferGeometry';
import { GeometryBuilder } from './GeometryBuilder';
import type { GeometryGeneratorOptions } from '../types';

/** Options accepted by {@link PlaneGeometry}. */
export interface PlaneGeometryOptions extends GeometryGeneratorOptions {
  /** Size along X. @default 1 */
  width?: number;
  /** Size along Y. @default 1 */
  height?: number;
  /** Subdivisions along X. @default 1 */
  widthSegments?: number;
  /** Subdivisions along Y. @default 1 */
  heightSegments?: number;
}

/**
 * Builds a plane in the XY plane.
 *
 * @param options See {@link PlaneGeometryOptions}.
 * @returns A new geometry with `position`, `normal` and `uv` attributes.
 */
export function createPlaneGeometry(options: PlaneGeometryOptions = {}): BufferGeometry {
  const width = options.width ?? 1;
  const height = options.height ?? 1;
  const widthSegments = Math.max(1, Math.floor(options.widthSegments ?? 1));
  const heightSegments = Math.max(1, Math.floor(options.heightSegments ?? 1));

  const builder = new GeometryBuilder({
    normals: options.normals ?? true,
    uv: options.uv ?? true,
    indexed: options.indexed ?? true,
    name: options.name ?? 'PlaneGeometry',
    initialCapacity: (widthSegments + 1) * (heightSegments + 1),
  });

  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;

  for (let iy = 0; iy <= heightSegments; iy++) {
    const ty = iy / heightSegments;
    const y = halfHeight - height * ty;
    for (let ix = 0; ix <= widthSegments; ix++) {
      const tx = ix / widthSegments;
      const x = -halfWidth + width * tx;
      builder.pushVertex(x, y, 0, 0, 0, 1, tx, 1 - ty);
    }
  }

  const stride = widthSegments + 1;
  for (let iy = 0; iy < heightSegments; iy++) {
    for (let ix = 0; ix < widthSegments; ix++) {
      // `y` decreases as `iy` increases, so the geometric row axis points *down*
      // while the UV `v` axis points up. The counter-clockwise-in-`xy` order is
      // therefore `(a, b, c)` then `(a, c, d)` with `a` top-left.
      const a = ix + stride * iy;
      const b = ix + stride * (iy + 1);
      const c = ix + 1 + stride * (iy + 1);
      const d = ix + 1 + stride * iy;
      builder.pushTriangle(a, b, c);
      builder.pushTriangle(a, c, d);
    }
  }

  return builder.build();
}

/**
 * `PlaneGeometry` — the class form of {@link createPlaneGeometry}.
 */
export class PlaneGeometry extends BufferGeometry {
  /** Creates a plane in the XY plane. */
  constructor(options: PlaneGeometryOptions = {}) {
    super();
    const built = createPlaneGeometry(options);
    this.copy(built);
    built.dispose();
  }
}
