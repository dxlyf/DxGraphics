/**
 * `BoxGeometry` — an axis-aligned rectangular box, optionally subdivided.
 *
 * Six independent faces, each with its own vertices, so a cube has hard edges and
 * a per-face UV mapping without needing a split pass. That is what a texture atlas
 * and a normal map expect: per-face tangents are well defined, whereas a shared
 * corner vertex would have an ambiguous frame.
 *
 * @packageDocumentation
 */

import { BufferGeometry } from '../../core/BufferGeometry';
import { GeometryBuilder } from './GeometryBuilder';
import type { GeometryGeneratorOptions } from '../types';

/** Options accepted by {@link BoxGeometry}. */
export interface BoxGeometryOptions extends GeometryGeneratorOptions {
  /** Size along X. @default 1 */
  width?: number;
  /** Size along Y. @default 1 */
  height?: number;
  /** Size along Z. @default 1 */
  depth?: number;
  /** Subdivisions along X. @default 1 */
  widthSegments?: number;
  /** Subdivisions along Y. @default 1 */
  heightSegments?: number;
  /** Subdivisions along Z. @default 1 */
  depthSegments?: number;
}

/**
 * Builds a box centred on the origin.
 *
 * @param options See {@link BoxGeometryOptions}.
 * @returns A new geometry with `position`, `normal` and `uv` attributes.
 */
export function createBoxGeometry(options: BoxGeometryOptions = {}): BufferGeometry {
  const width = options.width ?? 1;
  const height = options.height ?? 1;
  const depth = options.depth ?? 1;

  const widthSegments = Math.max(1, Math.floor(options.widthSegments ?? 1));
  const heightSegments = Math.max(1, Math.floor(options.heightSegments ?? 1));
  const depthSegments = Math.max(1, Math.floor(options.depthSegments ?? 1));

  const builder = new GeometryBuilder({
    normals: options.normals ?? true,
    uv: options.uv ?? true,
    indexed: options.indexed ?? true,
    name: options.name ?? 'BoxGeometry',
    initialCapacity: (widthSegments * heightSegments + widthSegments * depthSegments + depthSegments * heightSegments) * 8,
  });

  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  const halfDepth = depth * 0.5;

  /**
   * Emits one face.
   *
   * @param u Unit vector along the face's horizontal axis.
   * @param v Unit vector along the face's vertical axis.
   * @param w Face normal (and the axis the face is offset along).
   * @param uSegments Subdivisions along `u`.
   * @param vSegments Subdivisions along `v`.
   * @param uSize Extent along `u`.
   * @param vSize Extent along `v`.
   * @param depthOffset Offset of the face plane along `w`.
   */
  const buildFace = (
    u: readonly [number, number, number],
    v: readonly [number, number, number],
    w: readonly [number, number, number],
    uSegments: number,
    vSegments: number,
    uSize: number,
    vSize: number,
    depthOffset: number,
  ): void => {
    const base = builder.vertexCount;
    const halfU = uSize * 0.5;
    const halfV = vSize * 0.5;

    for (let iy = 0; iy <= vSegments; iy++) {
      const tv = iy / vSegments;
      const vOffset = halfV - vSize * tv;
      for (let ix = 0; ix <= uSegments; ix++) {
        const tu = ix / uSegments;
        const uOffset = -halfU + uSize * tu;

        const x = w[0] * depthOffset + u[0] * uOffset + v[0] * vOffset;
        const y = w[1] * depthOffset + u[1] * uOffset + v[1] * vOffset;
        const z = w[2] * depthOffset + u[2] * uOffset + v[2] * vOffset;

        builder.pushVertex(x, y, z, w[0], w[1], w[2], tu, 1 - tv);
      }
    }

    const stride = uSegments + 1;
    for (let iy = 0; iy < vSegments; iy++) {
      for (let ix = 0; ix < uSegments; ix++) {
        const a = base + ix + stride * iy;
        const b = base + ix + stride * (iy + 1);
        const c = base + ix + 1 + stride * (iy + 1);
        const d = base + ix + 1 + stride * iy;
        builder.pushTriangle(a, b, d);
        builder.pushTriangle(b, c, d);
      }
    }
  };

  // +X, -X, +Y, -Y, +Z, -Z. Each face's `u`/`v` are chosen so the winding stays
  // counter-clockwise when seen from outside.
  buildFace([0, 0, -1], [0, 1, 0], [1, 0, 0], depthSegments, heightSegments, depth, height, halfWidth);
  buildFace([0, 0, 1], [0, 1, 0], [-1, 0, 0], depthSegments, heightSegments, depth, height, halfWidth);
  buildFace([1, 0, 0], [0, 0, -1], [0, 1, 0], widthSegments, depthSegments, width, depth, halfHeight);
  buildFace([1, 0, 0], [0, 0, 1], [0, -1, 0], widthSegments, depthSegments, width, depth, halfHeight);
  buildFace([1, 0, 0], [0, 1, 0], [0, 0, 1], widthSegments, heightSegments, width, height, halfDepth);
  buildFace([-1, 0, 0], [0, 1, 0], [0, 0, -1], widthSegments, heightSegments, width, height, halfDepth);

  return builder.build();
}

/**
 * `BoxGeometry` — the class form of {@link createBoxGeometry}.
 *
 * Provided so both idioms work: `new BoxGeometry({ width: 2 })` and
 * `createBoxGeometry({ width: 2 })`.
 */
export class BoxGeometry extends BufferGeometry {
  /** Creates a box centred on the origin. */
  constructor(options: BoxGeometryOptions = {}) {
    super();
    const built = createBoxGeometry(options);
    this.copy(built);
    built.dispose();
  }
}
