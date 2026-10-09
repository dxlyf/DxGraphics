/**
 * `Curve3` — base class for the 3D curve family.
 *
 * The heavy lifting already lives in the generic `Curve` base, which is
 * parameterised over `Vec2 | Vec3` and therefore already solves arc length, point
 * spacing, tangents and Frenet frames in three dimensions. `Curve3` exists to:
 *
 *  - give the 3D family a single, self-documenting base (`Curve3` rather than
 *    `Curve<Vec3>`) so signatures in this directory read clearly;
 *  - add 3D-only conveniences: {@link Curve3.getPoints3}, {@link Curve3.getFrameAt}
 *    and {@link Curve3.toLineGeometry}, which is the bridge to `Line` and
 *    `TubeGeometry`.
 *
 * ```ts
 * class Helix extends Curve3 {
 *   public readonly type = 'LineCurve3' as const;
 *   public override getPoint(t: number, target: Vec3 = new Vec3()): Vec3 {
 *     return target.set(Math.cos(t * Math.PI * 2), t * 2, Math.sin(t * Math.PI * 2));
 *   }
 * }
 *
 * new Helix().getLength();        // arc length, integrated once and cached
 * new Helix().getPoints3(64);     // 65 evenly-in-parameter samples
 * new Helix().toLineGeometry(64); // ready for a `Line` object
 * ```
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../../math/Vec3';
import { Float32BufferAttribute } from '../../core/BufferAttribute';
import { BufferGeometry } from '../../core/BufferGeometry';
import { Curve } from '../../2d/Curve';
import type { FrenetFrames3D } from '../../2d/types';

/** A unit tangent, normal and binormal at one point on a 3D curve. */
export interface Curve3Frame {
  /** Position on the curve. */
  point: Vec3;
  /** Unit tangent (direction of travel). */
  tangent: Vec3;
  /** Unit normal, perpendicular to the tangent. */
  normal: Vec3;
  /** Unit binormal, `tangent × normal`. */
  binormal: Vec3;
}

/**
 * Abstract base for every 3D curve.
 *
 * Subclasses implement {@link Curve.getPoint} and declare {@link Curve.type};
 * everything else is inherited.
 */
export abstract class Curve3 extends Curve<Vec3> {
  /** Creates the curve; subclasses call `super()`. */
  protected constructor() {
    super();
  }

  /**
   * Samples the curve at `divisions + 1` parameters uniform in `t`.
   *
   * A `Vec3`-typed convenience over {@link Curve.getPoints}, whose declared return
   * type is the base class's `Vec2 | Vec3` union.
   *
   * @param divisions Number of intervals; the result has `divisions + 1` entries.
   * @returns A new array of points.
   */
  public getPoints3(divisions: number = this.arcLengthDivisions): Vec3[] {
    const points: Vec3[] = [];
    for (let d = 0; d <= divisions; d++) {
      points.push(this.getPoint(d / divisions, new Vec3()));
    }
    return points;
  }

  /**
   * Samples the curve at `divisions + 1` parameters **uniform in arc length**.
   *
   * @param divisions Number of intervals.
   * @returns A new array of points, evenly spaced along the curve.
   */
  public getSpacedPoints3(divisions: number = this.arcLengthDivisions): Vec3[] {
    const points: Vec3[] = [];
    for (let d = 0; d <= divisions; d++) {
      points.push(this.getPointAt(d / divisions, new Vec3()));
    }
    return points;
  }

  /**
   * Returns the full Frenet frame at one parameter.
   *
   * Derived from the curve's own tangent, so it costs one evaluation rather than a
   * lookup into the table {@link Curve.computeFrenetFrames} builds.
   *
   * @param t Normalised parameter in `[0, 1]`.
   * @param target Frame to write into.
   * @returns The populated frame.
   */
  public getFrameAt(t: number, target: Curve3Frame = createFrame()): Curve3Frame {
    this.getPoint(t, target.point);
    this.getTangent(t, target.tangent).normalize();
    this.getNormal(t, target.tangent, target.normal);
    target.binormal.copy(target.tangent).cross(target.normal).normalize();
    return target;
  }

  /**
   * Picks a unit normal perpendicular to `tangent`.
   *
   * The default crosses with whichever world axis the tangent points along least,
   * which avoids the degenerate case a fixed up-vector hits when a curve runs
   * vertically. Override to force a specific up direction.
   *
   * @param _t Parameter; unused by the default implementation.
   * @param tangent Unit tangent.
   * @param target Vector to write into.
   * @returns The unit normal.
   */
  public getNormal(_t: number, tangent: Vec3, target: Vec3 = new Vec3()): Vec3 {
    const ax = Math.abs(tangent.x);
    const ay = Math.abs(tangent.y);
    const az = Math.abs(tangent.z);

    if (ax <= ay && ax <= az) target.set(0, -tangent.z, tangent.y);
    else if (ay <= az) target.set(-tangent.z, 0, tangent.x);
    else target.set(-tangent.y, tangent.x, 0);

    return target.normalize();
  }

  /**
   * Builds a `BufferGeometry` whose `position` attribute is the sampled curve.
   *
   * Draw the result with `Line` (a strip), not `LineSegments`.
   *
   * @param divisions Number of intervals to sample.
   * @param spaced Sample uniformly in arc length rather than in parameter.
   * @returns A non-indexed point cloud carrying only `position`.
   */
  public toLineGeometry(
    divisions: number = this.arcLengthDivisions,
    spaced: boolean = false,
  ): BufferGeometry {
    const points = spaced ? this.getSpacedPoints3(divisions) : this.getPoints3(divisions);
    const positions = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      positions[i * 3] = points[i].x;
      positions[i * 3 + 1] = points[i].y;
      positions[i * 3 + 2] = points[i].z;
    }

    const geometry = new BufferGeometry();
    geometry.name = this.type;
    geometry.setAttribute(
      'position',
      new Float32BufferAttribute(positions, 3, false, 'static', 'position'),
    );
    return geometry;
  }

  /**
   * Arc-length-uniform Frenet frames for the whole curve.
   *
   * A `Vec3`-typed alias of {@link Curve.computeFrenetFrames}.
   *
   * @param segments Number of samples.
   * @param closed Treat the curve as a loop.
   * @returns Parallel arrays of tangents, normals and binormals.
   */
  public getFrenetFrames3(
    segments: number = this.arcLengthDivisions,
    closed: boolean = false,
  ): FrenetFrames3D {
    return this.computeFrenetFrames(segments, closed) as FrenetFrames3D;
  }
}

/** Creates a zeroed frame; exported so callers can preallocate one. */
export function createFrame(): Curve3Frame {
  return {
    point: new Vec3(),
    tangent: new Vec3(),
    normal: new Vec3(),
    binormal: new Vec3(),
  };
}

/**
 * Coerces a point-like value into a `Vec3` without allocating when it already is
 * one.
 *
 * The curve constructors accept `Vec3`, plain `{ x, y, z }` objects and
 * `[x, y, z]` tuples, because importers produce all three.
 *
 * @param value Source point.
 * @param fallback Used when `value` is undefined.
 * @returns A `Vec3`; the input itself when it already was one.
 */
export function toVec3(
  value: Vec3 | { x: number; y: number; z?: number } | readonly [number, number, number] | undefined,
  fallback: Vec3 = new Vec3(),
): Vec3 {
  if (value === undefined) return fallback;
  if (value instanceof Vec3) return value;
  if (Array.isArray(value)) return new Vec3(value[0], value[1], value[2]);
  const point = value as { x: number; y: number; z?: number };
  return new Vec3(point.x, point.y, point.z ?? 0);
}
