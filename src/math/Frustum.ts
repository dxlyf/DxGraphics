/**
 * `Frustum` — the six planes of a viewing frustum, used for culling.
 *
 * Built from a projection-view matrix (or a projection matrix plus a view
 * matrix). Culling is deliberately conservative: a bounding volume is only
 * rejected when it is fully outside at least one plane, so objects can never be
 * wrongly culled.
 *
 * @packageDocumentation
 */

import { Vec3 } from './Vec3';
import { Sphere } from './Sphere';
import { Plane } from './Plane';
import { Box3 } from './Box3';
import type { Mat4 } from './Mat4';

/** Plane order: left, right, bottom, top, near, far. */
export enum FrustumPlane {
  Left = 0,
  Right = 1,
  Bottom = 2,
  Top = 3,
  Near = 4,
  Far = 5,
}

/** Six-plane view frustum. */
export class Frustum {
  /** The six bounding planes, in {@link FrustumPlane} order. */
  public readonly planes: [Plane, Plane, Plane, Plane, Plane, Plane];

  /** Creates a frustum; the planes are uninitialised until a `setFrom*` call. */
  constructor() {
    this.planes = [
      new Plane(),
      new Plane(),
      new Plane(),
      new Plane(),
      new Plane(),
      new Plane(),
    ];
  }

  /* ---------------------------------------------------------------- static */

  /** Builds a frustum from a projection-view matrix. */
  public static fromProjectionMatrix(m: Mat4, target: Frustum = new Frustum()): Frustum {
    return target.setFromProjectionMatrix(m);
  }

  /** Builds a frustum from separate projection and view matrices. */
  public static fromProjectionAndView(
    projection: Mat4,
    view: Mat4,
    target: Frustum = new Frustum(),
  ): Frustum {
    return target.setFromProjectionAndView(projection, view);
  }

  /* ------------------------------------------------------------ assignment */

  /**
   * Sets the six planes from a projection-view matrix.
   *
   * The row-extraction trick (`left = row4 + row1`, ...) works for both
   * perspective and orthographic matrices and for either depth convention; the
   * `near`/`far` planes are normalised afterwards by {@link Plane.normalize}.
   */
  public setFromProjectionMatrix(m: Mat4): this {
    const e = m.elements;
    const me0 = e[0];
    const me1 = e[1];
    const me2 = e[2];
    const me3 = e[3];
    const me4 = e[4];
    const me5 = e[5];
    const me6 = e[6];
    const me7 = e[7];
    const me8 = e[8];
    const me9 = e[9];
    const me10 = e[10];
    const me11 = e[11];
    const me12 = e[12];
    const me13 = e[13];
    const me14 = e[14];
    const me15 = e[15];

    const planes = this.planes;

    planes[0].setComponents(me3 + me0, me7 + me4, me11 + me8, me15 + me12).normalize();
    planes[1].setComponents(me3 - me0, me7 - me4, me11 - me8, me15 - me12).normalize();
    planes[2].setComponents(me3 + me1, me7 + me5, me11 + me9, me15 + me13).normalize();
    planes[3].setComponents(me3 - me1, me7 - me5, me11 - me9, me15 - me13).normalize();
    planes[4].setComponents(me3 + me2, me7 + me6, me11 + me10, me15 + me14).normalize();
    planes[5].setComponents(me3 - me2, me7 - me6, me11 - me10, me15 - me14).normalize();
    return this;
  }

  /** Multiplies `projection * view` into a scratch matrix, then extracts planes. */
  public setFromProjectionAndView(projection: Mat4, view: Mat4): this {
    return this.setFromProjectionMatrix(projection.clone().multiply(view));
  }

  /** Copies another frustum. */
  public copy(frustum: Frustum): this {
    for (let i = 0; i < 6; i++) this.planes[i].copy(frustum.planes[i]);
    return this;
  }

  /** Returns a new frustum with the same planes. */
  public clone(): Frustum {
    return new Frustum().copy(this);
  }

  /* --------------------------------------------------------------- queries */

  /** `true` when `point` is inside all six planes. */
  public containsPoint(point: Vec3): boolean {
    for (let i = 0; i < 6; i++) {
      if (this.planes[i].distanceToPoint(point) < 0) return false;
    }
    return true;
  }

  /** `true` when `sphere` intersects the frustum (conservative). */
  public intersectsSphere(sphere: Sphere): boolean {
    for (let i = 0; i < 6; i++) {
      if (this.planes[i].distanceToSphere(sphere) < 0) return false;
    }
    return true;
  }

  /**
   * `true` when `box` intersects the frustum.
   *
   * Uses the "positive vertex" test: for each plane only the box corner farthest
   * along the plane normal needs to be checked.
   */
  public intersectsBox(box: Box3): boolean {
    if (box.isEmpty()) return false;

    const p = Frustum.scratchPoint;
    for (let i = 0; i < 6; i++) {
      const plane = this.planes[i];
      const normal = plane.normal;

      p.set(
        normal.x > 0 ? box.max.x : box.min.x,
        normal.y > 0 ? box.max.y : box.min.y,
        normal.z > 0 ? box.max.z : box.min.z,
      );

      if (plane.distanceToPoint(p) < 0) return false;
    }
    return true;
  }

  /** `true` when every plane matches within `tolerance`. */
  public equals(frustum: Frustum, tolerance = 1e-6): boolean {
    for (let i = 0; i < 6; i++) {
      if (!this.planes[i].equals(frustum.planes[i], tolerance)) return false;
    }
    return true;
  }

  /** A single plane by index (or enum value). */
  public getPlane(index: FrustumPlane | number): Plane {
    const plane = this.planes[index as number];
    if (!plane) throw new RangeError(`Frustum plane index out of range: ${String(index)}`);
    return plane;
  }

  /** Writes the first four components of every plane into a flat array. */
  public toArray(target: number[] = []): number[] {
    for (let i = 0; i < 6; i++) {
      const plane = this.planes[i];
      target[i * 4] = plane.normal.x;
      target[i * 4 + 1] = plane.normal.y;
      target[i * 4 + 2] = plane.normal.z;
      target[i * 4 + 3] = plane.constant;
    }
    return target;
  }

  /** JSON-friendly nested array. */
  public toJSON(): number[][] {
    return this.planes.map((plane) => [plane.normal.x, plane.normal.y, plane.normal.z, plane.constant]);
  }

  /** Human-readable representation. */
  public toString(precision: number = 4): string {
    return this.planes
      .map((plane, index) => `${FrustumPlane[index]}: ${plane.toString(precision)}`)
      .join('\n');
  }

  /** Shared scratch point for {@link intersectsBox}. */
  private static readonly scratchPoint = new Vec3();
}
