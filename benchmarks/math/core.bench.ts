/**
 * Math hot-path benchmarks.
 *
 * Run with `pnpm bench` (or `pnpm exec vitest bench --run`). Inputs are constructed
 * **outside** every `bench` callback: only the operation under test is measured.
 *
 * ## How to read the numbers
 *
 * Vitest reports `hz` (operations per second) and `mean` (milliseconds per operation).
 * A higher `hz` is better. The absolute values depend heavily on the machine, so treat
 * them as a **relative** baseline: compare a run against another run on the same host,
 * and watch for a change in the ratio between two benches rather than in either one
 * alone.
 *
 * ## What would regress these
 *
 * - **`Vec3` ops** — replacing the mutable field access in `x`/`y`/`z` with an accessor
 *   pair, adding a `notifyChange()` call to a non-observed vector, or returning a new
 *   instance from a mutator instead of `this`.
 * - **`Mat4.multiply`** — losing the hoisted scalar locals, or re-introducing property
 *   lookups on `elements` inside the inner loop.
 * - **`Quat.slerp`** — an accidental `sin`/`acos` call per component, or removing the
 *   shortest-path sign flip (which also changes behaviour).
 * - **`Vec3.applyMat4`** — removing the perspective divide, or allocating a `Vec4`.
 */

import { bench, describe } from 'vitest';

import { Mat4 } from '../../src/math/Mat4';
import { Quat } from '../../src/math/Quat';
import { Vec3 } from '../../src/math/Vec3';

/* -------------------------------------------------------------------------- */
/* Pre-built inputs (never inside a bench callback)                           */
/* -------------------------------------------------------------------------- */

const a = new Vec3(1.5, -2.25, 3.75);
const b = new Vec3(-0.5, 4.125, -1.25);
const accumulator = new Vec3();

const left = Mat4.fromArray([
  1, 0, 0, 0,
  0, 2, 0, 0,
  0, 0, 3, 0,
  4, 5, 6, 1,
]);
const right = new Mat4().makeRotationZ(0.37);
const product = new Mat4();

const rotation = new Mat4().makeRotationX(0.9);
const total = Mat4.identity();
const inverseTarget = new Mat4();

const qa = Quat.fromAxisAngle(new Vec3(0, 1, 0), 0.2);
const qb = Quat.fromAxisAngle(new Vec3(1, 0, 0), 2.8);
const qTarget = new Quat();

const transform = new Mat4().makeRotationY(0.6).multiply(new Mat4().makeTranslation(3, -2, 7));
const point = new Vec3(1.25, -0.75, 2.5);
const pointTarget = new Vec3();

/* -------------------------------------------------------------------------- */
/* Vector arithmetic                                                          */
/* -------------------------------------------------------------------------- */

describe('Vec3 arithmetic', () => {
  bench('add (mutating, returns this)', () => {
    // Typical inner-loop primitive: one call per accumulated force, per contact, per
    // vertex normal. Regresses if the mutator stops reusing `this`.
    accumulator.add(a).add(b).multiplyScalar(0.5);
  });

  bench('cross product', () => {
    // Face-normal computation. Two allocations here would show up immediately in
    // geometry generation.
    accumulator.crossVectors(a, b);
  });

  bench('normalize', () => {
    // Includes the `lengthSquared` guard and the division; called once per normal.
    accumulator.copy(b).normalize();
  });

  bench('dot product', () => {
    // The cheapest interesting op: this is the floor for anything that touches a Vec3.
    void a.dot(b);
  });

  bench('distanceToSquared', () => {
    // Used by culling and picking; avoids the square root, so it should sit just above
    // `dot product`.
    void a.distanceToSquared(b);
  });

  bench('lerp', () => {
    accumulator.copy(a).lerp(b, 0.35);
  });
});

/* -------------------------------------------------------------------------- */
/* Matrix arithmetic                                                          */
/* -------------------------------------------------------------------------- */

describe('Mat4 arithmetic', () => {
  bench('multiply (this = this * m)', () => {
    // The single hottest matrix call: one per node per frame during
    // `updateMatrixWorld`.
    product.copy(left).multiply(right);
  });

  bench('multiplyMatrices (a * b, target aliased)', () => {
    // Same work, but reading through two source matrices rather than one. The
    // difference between this and the previous bench is the cost of the extra reads.
    product.multiplyMatrices(left, right);
  });

  bench('compose from position/quaternion/scale', () => {
    // What `Object3D.updateMatrix` calls for every node that moved.
    product.compose(a, qa, b);
  });

  bench('decompose into position/quaternion/scale', () => {
    // What `getWorldPosition`/`getWorldQuaternion` and `Object3D.attach` call.
    transform.decompose(a, qa, b);
  });

  bench('invert', () => {
    // Called once per camera per frame (`matrixWorldInverse`) and once per reparent.
    // The float64 intermediate work dominates.
    inverseTarget.copy(transform).invert();
  });

  bench('accumulate 100 rotations (identity * R)', () => {
    // The pathological matrix case: `identity()` inside the loop would make this
    // allocation-bound, which is exactly the regression this bench catches.
    total.copy(left);
    for (let i = 0; i < 100; i++) total.multiply(rotation);
  });
});

/* -------------------------------------------------------------------------- */
/* Quaternions                                                                */
/* -------------------------------------------------------------------------- */

describe('Quat', () => {
  bench('slerp (t = 0.35)', () => {
    // One slerp per interpolated rotation per frame in a skeletal/animation loop. The
    // `sin`/`cos` pair dominates; allocating a temporary Quat here is the regression to
    // watch for.
    qTarget.copy(qa).slerp(qb, 0.35);
  });

  bench('multiply (a * b)', () => {
    // Composing a local rotation with a parent's.
    qTarget.copy(qa).multiply(qb);
  });

  bench('normalize', () => {
    qTarget.copy(qa).multiply(qb).normalize();
  });

  bench('setFromRotationMatrix', () => {
    // Used when converting a world matrix back into a node rotation.
    qTarget.setFromRotationMatrix(rotation);
  });
});

/* -------------------------------------------------------------------------- */
/* Projection                                                                 */
/* -------------------------------------------------------------------------- */

describe('Vec3.applyMat4', () => {
  bench('transform a point (with perspective divide)', () => {
    // Called once per vertex in the software projection path and per ray endpoint in
    // picking. The divide is part of the contract; removing it would be a behavioural
    // regression, not an optimisation.
    pointTarget.copy(point).applyMat4(transform);
  });

  bench('transform 64 points', () => {
    // Approximates one small mesh per frame, so the amortised cost is visible.
    for (let i = 0; i < 64; i++) {
      pointTarget.set(i, -i, i * 0.5).applyMat4(transform);
    }
  });
});
