/**
 * `TubeGeometry` — a circular tube swept along a 3D curve.
 *
 * ## Why parallel transport, not a Frenet frame
 *
 * The textbook approach builds a Frenet frame from the curve's tangent and its
 * derivative. That fails on any curve with a straight segment (the derivative of
 * the tangent is zero, so the normal is undefined) and flips 180° across an
 * inflection point, which makes a texture twist visibly. This implementation uses
 * **parallel transport** instead: the frame is rotated from one sample to the next
 * by the minimal rotation that carries the old tangent onto the new one. The result
 * is continuous everywhere the tangent is, including straight runs, and has no
 * sudden flips.
 *
 * Pass `uniformFrames: true` to fall back to a fixed up-vector frame, which is what
 * a hand-drawn ribbon along a nearly-planar path often wants.
 *
 * @packageDocumentation
 */

import { Quat } from '../../../math/Quat';
import { Vec3 } from '../../../math/Vec3';
import { BufferGeometry } from '../../core/BufferGeometry';
import { GeometryBuilder } from './GeometryBuilder';
import type { GeometryGeneratorOptions, TubeOptions, TubePathSource } from '../types';

/** Options accepted by {@link TubeGeometry}. */
export interface TubeGeometryOptions extends GeometryGeneratorOptions, TubeOptions {}

/** The minimum curve surface {@link createTubeGeometry} needs. */
export type { TubePathSource };

/**
 * Builds a tube around a path.
 *
 * @param path Curve providing `getPointAt` and `getTangentAt`.
 * @param options See {@link TubeGeometryOptions}.
 * @returns A new geometry with `position`, `normal` and `uv` attributes.
 */
export function createTubeGeometry(
  path: TubePathSource,
  options: TubeGeometryOptions = {},
): BufferGeometry {
  const tubularSegments = Math.max(1, Math.floor(options.tubularSegments ?? options.segments ?? 64));
  const radialSegments = Math.max(3, Math.floor(options.radialSegments ?? 8));
  const radius = options.radius ?? 1;
  const closed = options.closed ?? false;
  const uniformFrames = options.uniformFrames ?? false;

  const builder = new GeometryBuilder({
    normals: options.normals ?? true,
    uv: options.uv ?? true,
    indexed: options.indexed ?? true,
    name: options.name ?? 'TubeGeometry',
    initialCapacity: (tubularSegments + 1) * (radialSegments + 1),
  });

  /* ------------------------------------------------------------- the frames */

  /** Sample positions, tangents, normals and binormals along the path. */
  const positions: Vec3[] = [];
  const tangents: Vec3[] = [];
  const normals: Vec3[] = [];
  const binormals: Vec3[] = [];

  // First sample: seed the frame with any vector perpendicular to the tangent.
  const firstPoint = path.getPointAt(0, new Vec3());
  const firstTangent = path.getTangentAt(0, new Vec3()).normalize();
  const firstNormal = new Vec3();
  const firstBinormal = new Vec3();

  if (uniformFrames) {
    const up = Math.abs(firstTangent.y) > 0.99 ? Vec3.unitX() : Vec3.unitY();
    firstBinormal.copy(firstTangent).cross(up).normalize();
    firstNormal.copy(firstBinormal).cross(firstTangent).normalize();
  } else {
    perpendicular(firstTangent, firstNormal);
    firstBinormal.copy(firstTangent).cross(firstNormal).normalize();
  }

  positions.push(firstPoint);
  tangents.push(firstTangent);
  normals.push(firstNormal);
  binormals.push(firstBinormal);

  const rotation = new Quat();
  const scratchTangent = new Vec3();

  for (let i = 1; i <= tubularSegments; i++) {
    const t = i / tubularSegments;
    const point = path.getPointAt(t, new Vec3());
    const tangent = path.getTangentAt(t, new Vec3()).normalize();
    const previousTangent = scratchTangent.copy(tangents[i - 1]);

    let normal: Vec3;
    let binormal: Vec3;

    if (uniformFrames) {
      const up = Math.abs(tangent.y) > 0.99 ? Vec3.unitX() : Vec3.unitY();
      binormal = new Vec3().copy(tangent).cross(up).normalize();
      normal = new Vec3().copy(binormal).cross(tangent).normalize();
    } else {
      // Parallel transport: rotate the previous normal by the minimal rotation
      // taking the previous tangent onto the current one.
      rotation.setFromUnitVectors(previousTangent, tangent);
      normal = normals[i - 1].clone().applyQuat(rotation).normalize();
      // Re-orthogonalise; repeated rotations accumulate a little drift.
      normal.sub(tangent.clone().multiplyScalar(normal.dot(tangent))).normalize();
      binormal = new Vec3().copy(tangent).cross(normal).normalize();
    }

    positions.push(point);
    tangents.push(tangent);
    normals.push(normal);
    binormals.push(binormal);
  }

  /* -------------------------------------------------------------- the sweep */

  for (let i = 0; i <= tubularSegments; i++) {
    const v = i / tubularSegments;
    const point = positions[i];
    const normal = normals[i];
    const binormal = binormals[i];

    for (let j = 0; j <= radialSegments; j++) {
      const u = j / radialSegments;
      const angle = u * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      // The offset direction is exactly the surface normal of a circular tube: a
      // point at angle `a` lies at `spine + r * (cos a * n + sin a * b)`, and the
      // outward normal there is that same unit offset direction.
      const ox = cos * normal.x + sin * binormal.x;
      const oy = cos * normal.y + sin * binormal.y;
      const oz = cos * normal.z + sin * binormal.z;

      builder.pushVertex(
        point.x + radius * ox,
        point.y + radius * oy,
        point.z + radius * oz,
        ox,
        oy,
        oz,
        u,
        v,
      );
    }
  }

  for (let i = 0; i < tubularSegments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      // Layout matches the cylinder wall: `a` at (path i, angle j), `b` at
      // (path i + 1, angle j), `d` at (path i, angle j + 1).
      const a = i * (radialSegments + 1) + j;
      const b = (i + 1) * (radialSegments + 1) + j;
      const c = (i + 1) * (radialSegments + 1) + j + 1;
      const d = i * (radialSegments + 1) + j + 1;

      builder.pushTriangle(a, d, b);
      builder.pushTriangle(b, d, c);
    }
  }

  // No end caps: a tube is an open surface by definition, which is what a wire or a
  // pipe run wants. Use a closed path (`closed: true`) plus `CapsuleGeometry`-style
  // end pieces when a watertight solid is required.

  return builder.build();
}

/**
 * Writes an arbitrary unit vector perpendicular to `tangent`.
 *
 * Crosses with whichever world axis the tangent is least aligned with, which keeps
 * the result well conditioned for every input direction.
 *
 * @param tangent Unit tangent.
 * @param target Vector to write into.
 * @returns The perpendicular vector.
 */
function perpendicular(tangent: Vec3, target: Vec3): Vec3 {
  const ax = Math.abs(tangent.x);
  const ay = Math.abs(tangent.y);
  const az = Math.abs(tangent.z);

  if (ax <= ay && ax <= az) target.set(0, -tangent.z, tangent.y);
  else if (ay <= az) target.set(-tangent.z, 0, tangent.x);
  else target.set(-tangent.y, tangent.x, 0);

  return target.normalize();
}

/**
 * `TubeGeometry` — the class form of {@link createTubeGeometry}.
 */
export class TubeGeometry extends BufferGeometry {
  /** Creates a tube around a path. */
  constructor(path: TubePathSource, options: TubeGeometryOptions = {}) {
    super();
    const built = createTubeGeometry(path, options);
    this.copy(built);
    built.dispose();
  }
}
