/**
 * `mergeGeometries` — concatenate several geometries into one draw call.
 *
 * The rules that matter, and that a naive implementation gets wrong:
 *
 * 1. **Attribute sets need not match.** A geometry with only `position` merges
 *    into one with `position`/`normal`/`uv`; the missing attributes are filled
 *    with a documented neutral value (see {@link NEUTRAL_ATTRIBUTE_VALUES}) so the
 *    merged buffer stays a consistent rectangle. Pass `strict: true` to require an
 *    identical attribute set instead.
 * 2. **Item sizes must match** for a shared attribute name — otherwise the values
 *    mean different things and cannot share a buffer. That is a hard error.
 * 3. **Indexed and non-indexed inputs mix.** Everything is promoted to indexed
 *    when at least one input is indexed, since dropping the index would duplicate
 *    vertices.
 * 4. **Groups are preserved and offset**, so a multi-material mesh keeps its
 *    material slots.
 *
 * @packageDocumentation
 */

import { Box3 } from '../../../math/Box3';
import { Sphere } from '../../../math/Sphere';
import { Float32BufferAttribute, Uint32BufferAttribute } from '../../core/BufferAttribute';
import { BufferGeometry } from '../../core/BufferGeometry';
import type { AnyBufferAttribute, GeometryGroup } from '../../core/types';
import type { TypedArray } from '../../../types';
import { computeBoundingBox } from './computeBoundingBox';
import { computeBoundingSphere } from './computeBoundingSphere';

/**
 * Values used to pad an attribute that some inputs do not provide.
 *
 * Chosen so the padded geometry renders *plausibly* rather than producing `NaN`
 * or a black surface: a zero normal would kill lighting, so it becomes `+Z`.
 */
export const NEUTRAL_ATTRIBUTE_VALUES: Readonly<Record<string, readonly number[]>> = {
  position: [0, 0, 0],
  normal: [0, 0, 1],
  tangent: [1, 0, 0, 1],
  uv: [0, 0],
  uv1: [0, 0],
  uv2: [0, 0],
  uv3: [0, 0],
  color: [1, 1, 1, 1],
  skinIndex: [0, 0, 0, 0],
  skinWeight: [0, 0, 0, 0],
  instanceMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  instanceColor: [1, 1, 1],
};

/** Options accepted by {@link mergeGeometries}. */
export interface MergeGeometriesOptions {
  /**
   * Require every input to declare exactly the same attributes, with the same
   * item sizes.
   *
   * @default false
   */
  strict?: boolean;
  /**
   * Also merge `groups`.
   *
   * @default true
   */
  groups?: boolean;
  /**
   * Recompute the bounding volumes from the merged positions.
   *
   * @default true
   */
  computeBounds?: boolean;
  /** Debug name for the merged geometry. */
  name?: string;
}

/** The result of a merge, including what had to be adjusted. */
export interface MergeGeometriesResult {
  /** The merged geometry, or `null` when the inputs were incompatible. */
  geometry: BufferGeometry | null;
  /** Attributes that were padded because at least one input lacked them. */
  paddedAttributes: string[];
  /** `true` when the output is indexed. */
  indexed: boolean;
  /** Total vertices in the output. */
  vertexCount: number;
  /** Total indices in the output (equal to `vertexCount` when non-indexed). */
  indexCount: number;
  /** Human-readable reason the merge failed, when `geometry` is `null`. */
  reason?: string;
}

/**
 * Merges a list of geometries.
 *
 * @param geometries Geometries to merge, in order.
 * @param options See {@link MergeGeometriesOptions}.
 * @returns The merged result; check {@link MergeGeometriesResult.geometry} for
 *   `null` and read {@link MergeGeometriesResult.reason} to find out why.
 */
export function mergeGeometries(
  geometries: readonly BufferGeometry[],
  options: MergeGeometriesOptions = {},
): MergeGeometriesResult {
  const strict = options.strict ?? false;
  const mergeGroups = options.groups ?? true;
  const computeBounds = options.computeBounds ?? true;

  if (geometries.length === 0) {
    return {
      geometry: null,
      paddedAttributes: [],
      indexed: false,
      vertexCount: 0,
      indexCount: 0,
      reason: 'no geometries were supplied',
    };
  }

  if (geometries.length === 1) {
    const single = geometries[0];
    return {
      geometry: single.clone(),
      paddedAttributes: [],
      indexed: Boolean(single.getIndex()),
      vertexCount: vertexCountOf(single),
      indexCount: single.getIndex()?.count ?? vertexCountOf(single),
    };
  }

  /* ------------------------------------------------------ attribute schema */

  const schema = new Map<string, number>();
  for (const geometry of geometries) {
    for (const name of geometry.getAttributeNames()) {
      const attribute = geometry.getAttribute(name);
      if (!attribute) continue;
      const itemSize = attribute.itemSize;
      const known = schema.get(name);
      if (known === undefined) schema.set(name, itemSize);
      else if (known !== itemSize) {
        return {
          geometry: null,
          paddedAttributes: [],
          indexed: false,
          vertexCount: 0,
          indexCount: 0,
          reason: `attribute "${name}" has itemSize ${itemSize} in one geometry and ${known} in another`,
        };
      }
    }
  }

  if (strict) {
    for (const geometry of geometries) {
      const names = new Set(geometry.getAttributeNames());
      for (const name of schema.keys()) {
        if (!names.has(name)) {
          return {
            geometry: null,
            paddedAttributes: [],
            indexed: false,
            vertexCount: 0,
            indexCount: 0,
            reason: `strict merge: a geometry is missing attribute "${name}"`,
          };
        }
      }
    }
  }

  const paddedAttributes = [...schema.keys()].filter((name) =>
    geometries.some((geometry) => !geometry.getAttribute(name)),
  );

  /* --------------------------------------------------------------- sizing */

  const counts = geometries.map(vertexCountOf);
  const totalVertices = counts.reduce((sum, count) => sum + count, 0);
  const anyIndexed = geometries.some((geometry) => Boolean(geometry.getIndex()));

  /* ------------------------------------------------------------ attributes */

  const merged = new BufferGeometry();
  if (options.name !== undefined) merged.name = options.name;

  for (const [name, itemSize] of schema) {
    const data = new Float32Array(totalVertices * itemSize);
    const neutral = NEUTRAL_ATTRIBUTE_VALUES[name] ?? new Array(itemSize).fill(0);
    let write = 0;

    for (let g = 0; g < geometries.length; g++) {
      const attribute = geometries[g].getAttribute(name);
      const count = counts[g];
      if (!attribute) {
        // Pad this geometry's slice with the neutral value.
        for (let i = 0; i < count; i++) {
          for (let c = 0; c < itemSize; c++) {
            data[write++] = neutral[c] ?? 0;
          }
        }
        continue;
      }

      const source = attribute.array;
      const stride = attribute.itemSize;
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < itemSize; c++) {
          data[write++] = source[i * stride + c] ?? 0;
        }
      }
    }

    merged.setAttribute(name, new Float32BufferAttribute(data, itemSize, false, 'static', name));
  }

  /* ----------------------------------------------------------------- index */

  if (anyIndexed) {
    const totalIndices = geometries.reduce((sum, geometry, g) => {
      const index = geometry.getIndex();
      return sum + (index ? index.count : counts[g]);
    }, 0);

    const indices = new Uint32Array(totalIndices);
    let write = 0;
    let base = 0;

    for (let g = 0; g < geometries.length; g++) {
      const geometry = geometries[g];
      const index = geometry.getIndex();
      const count = counts[g];

      if (index) {
        for (let i = 0; i < index.count; i++) indices[write++] = (index.array[i] ?? 0) + base;
      } else {
        for (let i = 0; i < count; i++) indices[write++] = base + i;
      }
      base += count;
    }

    if (write !== totalIndices) {
      merged.setIndex(new Uint32BufferAttribute(indices.subarray(0, write), 1));
    } else {
      merged.setIndex(new Uint32BufferAttribute(indices, 1));
    }
  }

  /* ---------------------------------------------------------------- groups */

  if (mergeGroups) {
    let indexBase = 0;
    let vertexBase = 0;
    for (let g = 0; g < geometries.length; g++) {
      const source = geometries[g];
      const index = source.getIndex();
      const count = index ? index.count : counts[g];
      const groups = source.groups as GeometryGroup[];

      if (groups.length === 0) {
        merged.addGroup(anyIndexed ? indexBase : vertexBase, count, 0);
      } else {
        for (const group of groups) {
          merged.addGroup(
            (anyIndexed ? indexBase : vertexBase) + group.start,
            group.count,
            group.materialIndex ?? 0,
          );
        }
      }

      indexBase += count;
      vertexBase += counts[g];
    }
  }

  /* ---------------------------------------------------------------- bounds */

  if (computeBounds) {
    computeBoundingBox(merged);
    computeBoundingSphere(merged);
  }

  return {
    geometry: merged,
    paddedAttributes,
    indexed: anyIndexed,
    vertexCount: totalVertices,
    indexCount: merged.getIndex()?.count ?? totalVertices,
  };
}

/**
 * Merges geometries and returns the geometry directly.
 *
 * @param geometries Geometries to merge.
 * @param options See {@link MergeGeometriesOptions}.
 * @returns The merged geometry.
 * @throws When the inputs are incompatible; use {@link mergeGeometries} to handle
 *   that case without an exception.
 */
export function mergeGeometriesOrThrow(
  geometries: readonly BufferGeometry[],
  options: MergeGeometriesOptions = {},
): BufferGeometry {
  const result = mergeGeometries(geometries, options);
  if (!result.geometry) throw new Error(`mergeGeometries failed: ${result.reason ?? 'unknown reason'}`);
  return result.geometry;
}

/** Number of vertices in a geometry. */
function vertexCountOf(geometry: BufferGeometry): number {
  const position = geometry.getAttribute('position');
  if (!position) return 0;
  if (position.count > 0) return position.count;
  const stride = position.itemSize > 0 ? position.itemSize : 3;
  return Math.floor(position.array.length / stride);
}

/** Re-exported for callers that build merged geometries by hand. */
export type { AnyBufferAttribute, TypedArray, Box3, Sphere };
