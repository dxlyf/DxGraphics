/**
 * 2D/3D math library.
 *
 * Pure maths with **no rendering dependency** and no third-party packages. Every
 * class stores its data in plain numeric fields, mutators are chainable, and
 * read methods accept optional `target` arguments so hot loops stay
 * allocation-free.
 *
 * Memory layout: every matrix is **column-major**, matching WebGL's
 * `uniformMatrix*fv` and WGSL's `mat*<f32>` so instances upload verbatim.
 *
 * ```ts
 * import { Vec3, Mat4, Quat } from '@dxyl/graphics';
 *
 * const model = new Mat4().compose(
 *   new Vec3(1, 2, 3),
 *   Quat.fromAxisAngle(Vec3.unitY(), Math.PI / 4),
 *   Vec3.one(),
 * );
 * ```
 *
 * @packageDocumentation
 */

export * from './Vec2';
export * from './Vec3';
export * from './Vec4';
export * from './Mat2';
export * from './Mat3';
export * from './Mat4';
export * from './Quat';
export * from './Euler';
export * from './Color';
export * from './Rect';
export * from './Box2';
export * from './Box3';
export * from './Sphere';
export * from './Plane';
export * from './Ray';
export * from './Line2';
export * from './Line3';
export * from './Triangle';
export * from './Frustum';
export * from './Intersection';
export * from './MathUtils';
export type * from './types';
