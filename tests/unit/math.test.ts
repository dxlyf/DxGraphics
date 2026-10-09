/**
 * Unit tests for the math layer.
 *
 * The suite is written against the public API and asserts numeric *values*, not
 * just shapes, because the maths is what every other layer is built on. Matrix
 * conventions (column-major, column-vector multiplication) and the three.js
 * compatible formulas are pinned here so a refactor cannot silently transpose a
 * matrix or flip a rotation.
 */

import { describe, expect, it } from 'vitest';
import {
  Box2,
  Box3,
  Color,
  Euler,
  Frustum,
  Line2,
  Line3,
  Mat2,
  Mat3,
  Mat4,
  Plane,
  Quat,
  Ray,
  Rect,
  Sphere,
  Triangle,
  Vec2,
  Vec3,
  Vec4,
  barycentric2D,
  clamp,
  clamp01,
  degToRad,
  lerp,
  seededRandom,
  smoothstep,
  wrapAngle,
} from '../../src/math';

/** Numeric tolerance for float comparisons. */
const EPS = 1e-5;

/** Asserts that a matrix equals a row-major literal. */
function expectMat4(m: Mat4, rowMajor: number[][], tolerance = EPS): void {
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      expect(m.elements[column * 4 + row]).toBeCloseTo(rowMajor[row][column], tolerance);
    }
  }
}

describe('scalar helpers', () => {
  it('clamps, lerps and smooths', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 6);
  });

  it('converts and wraps angles', () => {
    expect(degToRad(180)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 10);
    expect(wrapAngle(-Math.PI * 1.5)).toBeCloseTo(Math.PI * 0.5, 10);
  });

  it('produces reproducible pseudo-random sequences', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const first = [a(), a(), a()];
    const second = [b(), b(), b()];
    expect(first).toEqual(second);
  });

  it('computes 2D barycentric coordinates', () => {
    const [u, v, w] = barycentric2D({ x: 0.25, y: 0.25 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 });
    expect(u + v + w).toBeCloseTo(1, 10);
    expect(u).toBeCloseTo(0.5, 10);
  });

  it('returns a degenerate barycentric triple for a zero-area triangle', () => {
    expect(barycentric2D({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toEqual([1, 0, 0]);
  });
});

describe('Vec2', () => {
  it('supports the chainable algebra', () => {
    const v = new Vec2(3, 4);
    expect(v.length()).toBe(5);
    expect(v.clone().normalize().length()).toBeCloseTo(1, 12);
    expect(v.dot(new Vec2(1, 0))).toBe(3);
    expect(new Vec2(1, 0).cross(new Vec2(0, 1))).toBe(1);
  });

  it('rotates around the origin and around a point', () => {
    const v = new Vec2(1, 0).rotateAround(Math.PI / 2);
    expect(v.x).toBeCloseTo(0, 12);
    expect(v.y).toBeCloseTo(1, 12);

    const around = new Vec2(2, 1).rotateAroundPoint(new Vec2(1, 1), Math.PI);
    expect(around.x).toBeCloseTo(0, 12);
    expect(around.y).toBeCloseTo(1, 12);
  });

  it('notifies onChange exactly once per set()', () => {
    const v = new Vec2();
    let calls = 0;
    v.onChange = () => {
      calls++;
    };
    v.set(1, 2);
    expect(calls).toBe(1);
    v.x = 5;
    expect(calls).toBe(2);
    v.x = 5; // unchanged, must not notify
    expect(calls).toBe(2);
  });

  it('accepts every documented source form', () => {
    expect(Vec2.from(3).toArray()).toEqual([3, 3]);
    expect(Vec2.from([1, 2]).toArray()).toEqual([1, 2]);
    expect(new Vec2().copy({ x: 7, y: 8 }).toArray()).toEqual([7, 8]);
  });
});

describe('Vec3', () => {
  it('computes cross products right-handed', () => {
    const x = Vec3.unitX();
    const y = Vec3.unitY();
    expect(x.clone().cross(y).equals(Vec3.unitZ(), 1e-12)).toBe(true);
    expect(y.clone().cross(x).equals(Vec3.unitZ().negate(), 1e-12)).toBe(true);
  });

  it('projects and reflects', () => {
    const v = new Vec3(2, 2, 0);
    expect(v.clone().projectOnVector(Vec3.unitX()).equals(new Vec3(2, 0, 0), EPS)).toBe(true);
    expect(new Vec3(1, -1, 0).reflect(Vec3.unitY()).equals(new Vec3(1, 1, 0), EPS)).toBe(true);
  });

  it('converts to and from spherical coordinates', () => {
    const original = new Vec3(1, 2, 3);
    const spherical = original.toSpherical();
    const restored = new Vec3().setFromSpherical(spherical);
    expect(restored.equals(original, 1e-5)).toBe(true);
  });

  it('applies a translation matrix with the w divide', () => {
    const m = new Mat4().makeTranslation(10, 20, 30);
    expect(new Vec3(1, 2, 3).applyMat4(m).equals(new Vec3(11, 22, 33), EPS)).toBe(true);
  });

  it('rotates by raw quaternion components', () => {
    const half = Math.PI / 4;
    const v = new Vec3(1, 0, 0).applyQuatElements(0, 0, Math.sin(half), Math.cos(half));
    expect(v.x).toBeCloseTo(0, 10);
    expect(v.y).toBeCloseTo(1, 10);
  });

  it('maps between arrays and matrices', () => {
    const m = new Mat4().makeTranslation(4, 5, 6);
    expect(new Vec3().setFromMatrixPosition(m).toArray()).toEqual([4, 5, 6]);
    expect(new Vec3().setFromMatrixScale(new Mat4().makeScale(2, 3, 4)).toArray()).toEqual([2, 3, 4]);
  });
});

describe('Vec4', () => {
  it('performs the perspective divide when w is non-zero', () => {
    const perspective = new Mat4().makePerspective(Math.PI / 4, 1, 1, 100);
    const point = new Vec4(0, 0, -2, 1).applyMat4(perspective);
    // A point at z = -2 with near = 1 maps to w = 2 and is divided through.
    expect(point.w).toBeCloseTo(1, 6);
    expect(point.z).toBeGreaterThan(-1);
    expect(point.z).toBeLessThan(1);
  });

  it('ignores translation for w = 0', () => {
    const translated = new Vec4(1, 0, 0, 0).applyMat4(new Mat4().makeTranslation(10, 0, 0));
    expect(translated.x).toBeCloseTo(1, 6);
    expect(translated.w).toBeCloseTo(0, 6);
  });

  it('applies a full translation and rotation like a point', () => {
    // `a.multiply(b)` applies `b` first, so this is "rotate, then translate".
    const m = new Mat4().makeTranslation(1, 2, 3).multiply(new Mat4().makeRotationZ(Math.PI / 2));
    // (1, 0, 0) -> rotate -> (0, 1, 0) -> translate -> (1, 3, 3).
    const result = new Vec4(1, 0, 0, 1).applyMat4(m);
    expect(result.x).toBeCloseTo(1, 5);
    expect(result.y).toBeCloseTo(3, 5);
    expect(result.z).toBeCloseTo(3, 5);
    expect(result.w).toBeCloseTo(1, 6);
  });

  it('leaves w = 0 direction vectors undivided under rotation', () => {
    const direction = new Vec4(1, 0, 0, 0).applyMat4(new Mat4().makeRotationZ(Math.PI / 2));
    // w stays 0 (a direction), so no divide happens and the length is preserved.
    expect(direction.w).toBeCloseTo(0, 6);
    expect(direction.x).toBeCloseTo(0, 6);
    expect(direction.y).toBeCloseTo(1, 6);
    expect(Math.hypot(direction.x, direction.y, direction.z)).toBeCloseTo(1, 6);
  });
});

describe('Mat2', () => {
  it('inverts and solves linear systems', () => {
    const m = Mat2.of(2, 0, 0, 4);
    expect(m.determinant()).toBe(8);
    expect(m.clone().invert().equals(Mat2.of(0.5, 0, 0, 0.25), EPS)).toBe(true);

    const solution = m.solve(new Vec2(4, 8));
    expect(solution?.equals(new Vec2(2, 2), EPS)).toBe(true);
  });

  it('returns null from solve for a singular matrix', () => {
    expect(Mat2.of(1, 2, 2, 4).solve(new Vec2(1, 1))).toBeNull();
  });
});

describe('Mat3', () => {
  it('round-trips through inversion', () => {
    const m = Mat3.of(2, 0, 0, 0, 3, 0, 0, 0, 4);
    expect(m.clone().invert().multiply(m).isIdentity(1e-6)).toBe(true);
  });

  it('builds a rotation that matches the axis-angle rotation of a vector', () => {
    const axis = new Vec3(0, 0, 1);
    const m = new Mat3().makeRotationAxis(axis, Math.PI / 2);
    const rotated = m.applyToVector(new Vec3(1, 0, 0));
    expect(rotated.equals(new Vec3(0, 1, 0), 1e-6)).toBe(true);
  });

  it('creates a skew-symmetric cross-product matrix', () => {
    const v = new Vec3(1, 2, 3);
    const w = new Vec3(4, 5, 6);
    const skew = Mat3.fromCrossProduct(v).applyToVector(w);
    expect(skew.equals(v.clone().cross(w), 1e-6)).toBe(true);
  });

  it('normalises a non-uniformly scaled basis correctly', () => {
    // Rotation first, then non-uniform scale (the TRS order `compose` produces).
    const model = new Mat4().compose(
      new Vec3(),
      Quat.fromAxisAngle(Vec3.unitZ(), Math.PI / 4),
      new Vec3(2, 1, 1),
    );
    const normalMatrix = new Mat3().getNormalMatrix(model);
    const transformedNormal = normalMatrix.applyToVector(new Vec3(1, 0, 0));

    // The rotated tangent and its normal must stay perpendicular after the scale.
    const tangent = new Vec3(1, 0, 0).applyMat4(model);
    const normal = new Vec3(0, 1, 0).applyMat4(model);
    expect(transformedNormal.dot(normal)).toBeCloseTo(0, 5);
    expect(tangent.length()).toBeGreaterThan(0);
  });
});

describe('Mat4', () => {
  it('stores elements column-major', () => {
    const m = Mat4.of(
      1, 2, 3, 4,
      5, 6, 7, 8,
      9, 10, 11, 12,
      13, 14, 15, 16,
    );
    expect(Array.from(m.elements)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(m.getColumn(0).toArray()).toEqual([1, 2, 3, 4]);
    expect(m.getRow(0).toArray()).toEqual([1, 5, 9, 13]);
  });

  it('composes TRS so that scale applies before rotation', () => {
    const m = new Mat4().compose(
      new Vec3(0, 0, 0),
      Quat.fromAxisAngle(Vec3.unitZ(), Math.PI / 2),
      new Vec3(2, 1, 1),
    );
    const transformed = new Vec3(1, 0, 0).applyMat4(m);
    expect(transformed.equals(new Vec3(0, 2, 0), 1e-6)).toBe(true);
  });

  it('round-trips compose/decompose', () => {
    const position = new Vec3(1, -2, 3);
    const quaternion = Quat.fromAxisAngle(new Vec3(1, 1, 0).normalize(), 0.7);
    const scale = new Vec3(2, 3, 4);
    const m = new Mat4().compose(position, quaternion, scale);

    const outPosition = new Vec3();
    const outQuaternion = new Quat();
    const outScale = new Vec3();
    expect(m.decompose(outPosition, outQuaternion, outScale)).toBe(true);
    expect(outPosition.equals(position, 1e-5)).toBe(true);
    expect(outScale.equals(scale, 1e-5)).toBe(true);
    expect(Math.abs(outQuaternion.dot(quaternion))).toBeCloseTo(1, 5);
  });

  it('builds a perspective matrix that maps the near plane to z = -1', () => {
    const near = 0.5;
    const far = 100;
    const m = new Mat4().makePerspective(Math.PI / 3, 16 / 9, near, far);
    const onNear = new Vec3(0, 0, -near).applyMat4(m);
    expect(onNear.z).toBeCloseTo(-1, 5);
    const onFar = new Vec3(0, 0, -far).applyMat4(m);
    expect(onFar.z).toBeCloseTo(1, 4);
  });

  it('builds an orthographic matrix that maps the frustum to the clip cube', () => {
    const m = new Mat4().makeOrthographic(-2, 2, 2, -2, 1, 11);
    expect(new Vec3(2, 2, -1).applyMat4(m).equals(new Vec3(1, 1, -1), EPS)).toBe(true);
    expect(new Vec3(-2, -2, -11).applyMat4(m).equals(new Vec3(-1, -1, 1), EPS)).toBe(true);
  });

  it('builds a look-at view matrix', () => {
    const m = new Mat4().lookAt(new Vec3(0, 0, 5), new Vec3(0, 0, 0), Vec3.unitY());
    expect(new Vec3(0, 0, 0).applyMat4(m).equals(new Vec3(0, 0, -5), EPS)).toBe(true);
  });

  it('falls back to a valid basis when up is parallel to the view direction', () => {
    expect(() => new Mat4().lookAt(new Vec3(0, 5, 0), new Vec3(0, 0, 0), Vec3.unitY())).not.toThrow();
    const m = new Mat4().lookAt(new Vec3(0, 5, 0), new Vec3(0, 0, 0), Vec3.unitY());
    expect(m.isFinite()).toBe(true);
  });

  it('inverts and multiplies consistently', () => {
    const m = new Mat4().compose(
      new Vec3(3, -1, 2),
      Quat.fromAxisAngle(new Vec3(0, 1, 0), 0.4),
      new Vec3(1, 2, 0.5),
    );
    expect(m.clone().invert().multiply(m).isIdentity(1e-4)).toBe(true);
    expect(m.clone().invert().multiply(m.clone())).toBeDefined();
  });

  it('multiplies matrices and applies them associatively', () => {
    // Applying `A * B` to a vector must equal applying B then A.
    const a = new Mat4().makeTranslation(1, 2, 3);
    const b = new Mat4().makeRotationZ(Math.PI / 2);
    const product = new Mat4().multiplyMatrices(a, b);

    const viaProduct = new Vec3(1, 0, 0).applyMat4(product);
    const viaSteps = new Vec3(1, 0, 0).applyMat4(b).applyMat4(a);
    expect(viaProduct.equals(viaSteps, 1e-5)).toBe(true);

    // The product of a translation with the identity is the translation.
    expect(
      new Mat4().multiplyMatrices(a, new Mat4()).equals(a, 1e-6),
    ).toBe(true);

    // Each product element must match the definition on arbitrary operands.
    const al = Array.from({ length: 16 }, (_, i) => Math.sin(i * 1.7) * 3);
    const bl = Array.from({ length: 16 }, (_, i) => Math.cos(i * 2.3) * 2);
    const computed = new Mat4().multiplyMatrices(new Mat4().fromArray(al), new Mat4().fromArray(bl));
    for (let column = 0; column < 4; column++) {
      for (let row = 0; row < 4; row++) {
        let expected = 0;
        for (let k = 0; k < 4; k++) expected += al[k * 4 + row] * bl[column * 4 + k];
        expect(computed.elements[column * 4 + row]).toBeCloseTo(expected, 5);
      }
    }
  });

  it('keeps the translation in the last column of the product', () => {
    // `translate * view` must place the translation where a point product finds it.
    const a = new Mat4().makeTranslation(4, 5, 6);
    const b = new Mat4();
    const product = new Mat4().multiplyMatrices(a, b);
    expect(product.elements[12]).toBeCloseTo(4, 6);
    expect(product.elements[13]).toBeCloseTo(5, 6);
    expect(product.elements[14]).toBeCloseTo(6, 6);
    expect(product.getTranslation().equals(new Vec3(4, 5, 6), 1e-6)).toBe(true);
  });

  it('throws on a degenerate perspective request', () => {
    expect(() => new Mat4().makePerspective(1, 1, 0, 10)).toThrow(RangeError);
    expect(() => new Mat4().makePerspective(1, 1, 10, 5)).toThrow(RangeError);
    expect(() => new Mat4().makePerspective(1, 0, 1, 10)).toThrow(RangeError);
  });

  it('reports the translation and scale of a composed matrix', () => {
    const m = new Mat4().compose(new Vec3(7, 8, 9), new Quat(), new Vec3(2, 2, 2));
    expect(m.getTranslation().toArray()).toEqual([7, 8, 9]);
    expect(m.getMaxScaleOnAxis()).toBeCloseTo(2, 6);
  });

  it('pins the handedness of every rotation path', () => {
    const half = Math.PI / 2;
    const x = Vec3.unitX();
    const y = Vec3.unitY();
    const z = Vec3.unitZ();

    // Right-handed, counter-clockwise when viewed from the positive axis:
    //   +Z rotation maps +X to +Y, +X rotation maps +Y to +Z, ...
    expect(new Vec3(1, 0, 0).applyMat4(new Mat4().makeRotationZ(half)).equals(y, 1e-6)).toBe(true);
    expect(new Vec3(0, 1, 0).applyMat4(new Mat4().makeRotationX(half)).equals(z, 1e-6)).toBe(true);
    expect(new Vec3(0, 0, 1).applyMat4(new Mat4().makeRotationY(half)).equals(x, 1e-6)).toBe(true);

    // The quaternion path must agree with the matrix path for the same rotation.
    const qz = Quat.fromAxisAngle(z, half);
    expect(qz.rotateVec3(new Vec3(1, 0, 0)).equals(new Vec3(0, 1, 0), 1e-6)).toBe(true);
    expect(new Mat4().makeRotationFromQuat(qz).equals(new Mat4().makeRotationZ(half), 1e-6)).toBe(true);

    // ... and so must Mat3 and the in-place Vec3 helper.
    expect(new Mat3().makeRotationZ(half).applyToVector(new Vec3(1, 0, 0)).equals(y, 1e-6)).toBe(true);
    expect(new Vec3(1, 0, 0).applyRotationZ(half).equals(y, 1e-6)).toBe(true);
  });

  it('matches a row-major literal for makeRotationX', () => {
    expectMat4(new Mat4().makeRotationX(Math.PI / 2), [
      [1, 0, 0, 0],
      [0, 0, -1, 0],
      [0, 1, 0, 0],
      [0, 0, 0, 1],
    ]);
  });
});

describe('Euler and Quat', () => {
  it('agrees with the matrix path for every Euler order', () => {
    const orders = ['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'] as const;
    // A generic, non-axis-aligned vector: a component-order mistake in any of the
    // six formulas moves it, whereas an axis-aligned vector can hide the error.
    const source = new Vec3(0.3, 0.7, -0.2);

    for (const order of orders) {
      const euler = new Euler(0.3, -0.4, 0.5, order);
      const viaQuat = new Quat().setFromEuler(euler).rotateVec3(source.clone());
      const viaMatrix = source.clone().applyMat4(new Mat4().makeRotationFromEuler(euler));
      expect(viaQuat.equals(viaMatrix, 1e-5)).toBe(true);
      expect(viaQuat.length()).toBeCloseTo(source.length(), 5);
    }
  });

  it('produces a unit quaternion for every Euler order', () => {
    for (const order of ['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'] as const) {
      const quaternion = new Quat().setFromEuler(new Euler(0.3, -0.4, 0.5, order));
      expect(quaternion.length()).toBeCloseTo(1, 6);
    }
  });

  it('keeps Euler.toQuatElements consistent with Quat.setFromEuler', () => {
    for (const order of ['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'] as const) {
      const euler = new Euler(0.3, -0.4, 0.5, order);
      const [x, y, z, w] = euler.toQuatElements();
      expect(new Quat(x, y, z, w).equals(new Quat().setFromEuler(euler), 1e-12)).toBe(true);
    }
  });

  it('extracts Euler angles back from a matrix', () => {
    const euler = new Euler(0.2, 0.3, 0.4, 'XYZ');
    const restored = new Euler().setFromRotationMatrix(new Mat4().makeRotationFromEuler(euler), 'XYZ');
    expect(restored.x).toBeCloseTo(0.2, 5);
    expect(restored.y).toBeCloseTo(0.3, 5);
    expect(restored.z).toBeCloseTo(0.4, 5);
  });

  it('rotates a vector by a quaternion', () => {
    const q = Quat.fromAxisAngle(Vec3.unitZ(), Math.PI / 2);
    const rotated = q.rotateVec3(new Vec3(1, 0, 0));
    expect(rotated.equals(new Vec3(0, 1, 0), 1e-6)).toBe(true);
  });

  it('applies the right-hand factor first when multiplying', () => {
    const a = Quat.fromAxisAngle(Vec3.unitY(), Math.PI / 2);
    const b = Quat.fromAxisAngle(Vec3.unitX(), Math.PI / 2);
    const combined = new Quat().multiplyQuaternions(a, b);
    // `a * b` means "apply b, then a".
    const expected = a.rotateVec3(b.rotateVec3(new Vec3(1, 0, 0)));
    const actual = combined.rotateVec3(new Vec3(1, 0, 0));
    expect(actual.equals(expected, 1e-6)).toBe(true);
    // ... and it is deliberately NOT the other order.
    const other = b.rotateVec3(a.rotateVec3(new Vec3(1, 0, 0)));
    expect(actual.equals(other, 1e-6)).toBe(false);
  });

  it('slerps the short way and stays normalised', () => {
    const a = new Quat();
    const b = Quat.fromAxisAngle(Vec3.unitZ(), Math.PI);
    const mid = new Quat().slerpQuaternions(a, b, 0.5);
    expect(mid.length()).toBeCloseTo(1, 6);
    const halfway = mid.rotateVec3(new Vec3(1, 0, 0));
    // A half-way rotation to a 180 degree turn must leave X on the Z axis plane.
    expect(halfway.z).toBeCloseTo(0, 5);
  });

  it('inverts a rotation', () => {
    const q = Quat.fromAxisAngle(new Vec3(1, 2, 3).normalize(), 1.1);
    const v = new Vec3(0.3, -0.7, 0.2);
    const roundTrip = q.clone().invert().rotateVec3(q.rotateVec3(v));
    expect(roundTrip.equals(v, 1e-6)).toBe(true);
  });

  it('builds a rotation between two unit vectors', () => {
    const q = Quat.fromUnitVectors(new Vec3(1, 0, 0), new Vec3(0, 0, 1));
    expect(q.rotateVec3(new Vec3(1, 0, 0)).equals(new Vec3(0, 0, 1), 1e-6)).toBe(true);
  });
});

describe('Color', () => {
  it('parses hex, CSS keywords and functional notation', () => {
    expect(Color.from('#ff0000').r).toBeCloseTo(1, 6);
    expect(Color.from('#ff0000').g).toBeCloseTo(0, 6);
    expect(Color.from('red').getHex()).toBe(0xff0000);
    expect(Color.from('rgb(0, 128, 255)').b).toBeCloseTo(1, 2);
    expect(Color.from(0x00ff00).g).toBeCloseTo(1, 6);
  });

  it('round-trips HSL', () => {
    const color = Color.from('#3366cc');
    const hsl = color.getHSL();
    // `h` is in degrees (0..360), `s`/`l` in 0..1.
    expect(hsl.h).toBeCloseTo(220, 3);
    expect(hsl.s).toBeCloseTo(0.6, 3);
    expect(hsl.l).toBeCloseTo(0.5, 3);

    const restored = Color.fromHsl(hsl.h, hsl.s, hsl.l);
    expect(restored.r).toBeCloseTo(color.r, 3);
    expect(restored.g).toBeCloseTo(color.g, 3);
    expect(restored.b).toBeCloseTo(color.b, 3);
  });

  it('round-trips sRGB to linear and back', () => {
    const color = Color.from('#808080');
    const original = color.r;
    color.convertSRGBToLinear();
    expect(color.r).not.toBeCloseTo(original, 3);
    color.convertLinearToSRGB();
    expect(color.r).toBeCloseTo(original, 6);
  });

  it('interpolates between colours', () => {
    const mid = new Color(0, 0, 0).lerp(new Color(1, 1, 1), 0.5);
    expect(mid.r).toBeCloseTo(0.5, 6);
  });
});

describe('Rect, Box2 and Box3', () => {
  it('computes intersection and union', () => {
    const a = Rect.fromPoints(new Vec2(0, 0), new Vec2(2, 2));
    const b = Rect.fromPoints(new Vec2(1, 1), new Vec2(3, 3));
    expect(a.area).toBe(4);
    expect(a.intersection(b)?.area).toBe(1);
    expect(a.union(b).right).toBe(3);
    expect(a.contains(new Vec2(1, 1))).toBe(true);
    expect(a.contains(new Vec2(4, 4))).toBe(false);
  });

  it('grows a Box2 to contain points', () => {
    const box = new Box2();
    box.makeEmpty();
    box.expandByPoint(new Vec2(-1, -2));
    box.expandByPoint(new Vec2(3, 4));
    expect(box.min.toArray()).toEqual([-1, -2]);
    expect(box.max.toArray()).toEqual([3, 4]);
    expect(box.getCenter().toArray()).toEqual([1, 1]);
  });

  it('transforms a Box3 through a rotation', () => {
    const box = new Box3().setFromCenterAndSize(new Vec3(0, 0, 0), new Vec3(2, 2, 2));
    box.applyMat4(new Mat4().makeRotationZ(Math.PI / 4));
    // A 45 degree rotation of a 2x2x2 box grows the X/Y extent to 2*sqrt(2).
    expect(box.max.x).toBeCloseTo(Math.SQRT2, 4);
    expect(box.max.z).toBeCloseTo(1, 4);
  });

  it('reports an empty Box3 as empty', () => {
    const box = new Box3();
    box.makeEmpty();
    expect(box.isEmpty()).toBe(true);
    box.expandByPoint(new Vec3(1, 1, 1));
    expect(box.isEmpty()).toBe(false);
  });
});

describe('Sphere, Plane and Ray', () => {
  it('reports containment and distance for a sphere', () => {
    const sphere = new Sphere(new Vec3(0, 0, 0), 2);
    expect(sphere.containsPoint(new Vec3(1, 0, 0))).toBe(true);
    expect(sphere.containsPoint(new Vec3(3, 0, 0))).toBe(false);
    expect(sphere.distanceToPoint(new Vec3(5, 0, 0))).toBeCloseTo(3, 6);
  });

  it('projects a point onto a plane', () => {
    const plane = new Plane().setFromNormalAndCoplanarPoint(Vec3.unitY(), new Vec3(0, 1, 0));
    expect(plane.distanceToPoint(new Vec3(0, 5, 0))).toBeCloseTo(4, 6);
    expect(plane.projectPoint(new Vec3(0, 5, 0)).equals(new Vec3(0, 1, 0), EPS)).toBe(true);
  });

  it('intersects a plane with a line', () => {
    const plane = new Plane().setFromNormalAndCoplanarPoint(Vec3.unitY(), new Vec3(0, 0, 0));
    const hit = plane.intersectLine(new Line3(new Vec3(0, -1, 0), new Vec3(0, 1, 0)));
    expect(hit?.equals(new Vec3(0, 0, 0), EPS)).toBe(true);
  });

  it('intersects a ray with a sphere at the expected distance', () => {
    const hit = new Ray(new Vec3(0, 0, 4), new Vec3(0, 0, -1)).intersectSphere(new Sphere(new Vec3(), 1));
    expect(hit?.equals(new Vec3(0, 0, 1), EPS)).toBe(true);
  });

  it('intersects a ray with a box using the slab method', () => {
    const box = new Box3(new Vec3(-1, -1, -1), new Vec3(1, 1, 1));
    const hit = new Ray(new Vec3(0, 0, 5), new Vec3(0, 0, -1)).intersectBox(box);
    expect(hit?.equals(new Vec3(0, 0, 1), EPS)).toBe(true);
  });

  it('never produces NaN for a ray parallel to a slab', () => {
    const box = new Box3(new Vec3(-1, -1, -1), new Vec3(1, 1, 1));
    // Parallel to X but outside the Y slab: the ray can never reach the box.
    expect(new Ray(new Vec3(0, 5, 0), new Vec3(1, 0, 0)).intersectBox(box)).toBeNull();
    // Parallel to X and inside the Y/Z slab: it enters through x = -1.
    const through = new Ray(new Vec3(-5, 0, 0), new Vec3(1, 0, 0)).intersectBox(box);
    expect(through?.equals(new Vec3(-1, 0, 0), EPS)).toBe(true);
  });
});

describe('Line2, Line3 and Triangle', () => {
  it('intersects two 2D segments', () => {
    const a = Line2.fromPoints(new Vec2(0, 0), new Vec2(2, 2));
    const b = Line2.fromPoints(new Vec2(0, 2), new Vec2(2, 0));
    expect(a.intersectSegment(b)?.equals(new Vec2(1, 1), EPS)).toBe(true);

    // The same two lines, but with `a` as a short segment that stops short of `b`.
    const short = new Line2(new Vec2(0, 0), new Vec2(Math.SQRT1_2, Math.SQRT1_2));
    expect(short.intersectSegment(b)).toBeNull();

    // Disjoint segments along the same direction never intersect.
    expect(a.intersectSegment(Line2.fromPoints(new Vec2(5, 5), new Vec2(6, 6)))).toBeNull();
    expect(a.isParallelTo(Line2.fromPoints(new Vec2(0, 1), new Vec2(1, 2)))).toBe(true);

    // Infinite-line intersection still works for the short segment.
    expect(short.intersectLine(b)?.equals(new Vec2(1, 1), EPS)).toBe(true);
  });

  it('measures the distance from a point to a segment', () => {
    const segment = new Line3(new Vec3(0, 0, 0), new Vec3(10, 0, 0));
    expect(segment.distanceToPoint(new Vec3(5, 3, 0))).toBeCloseTo(3, 6);
    expect(segment.distanceToPoint(new Vec3(-4, 3, 0))).toBeCloseTo(5, 6);
  });

  it('finds the closest approach of two segments', () => {
    const a = new Line3(new Vec3(0, 0, 0), new Vec3(10, 0, 0));
    const b = new Line3(new Vec3(5, -5, 2), new Vec3(5, 5, 2));
    expect(a.distanceToSegment(b)).toBeCloseTo(2, 5);
  });

  it('intersects a segment with a triangle', () => {
    const segment = new Line3(new Vec3(0.25, 0.25, 1), new Vec3(0.25, 0.25, -1));
    const hit = segment.intersectTriangle(
      new Vec3(0, 0, 0),
      new Vec3(1, 0, 0),
      new Vec3(0, 1, 0),
    );
    expect(hit?.equals(new Vec3(0.25, 0.25, 0), EPS)).toBe(true);
  });

  it('computes triangle area, normal and containment', () => {
    const triangle = new Triangle(new Vec3(0, 0, 0), new Vec3(1, 0, 0), new Vec3(0, 1, 0));
    expect(triangle.getArea()).toBeCloseTo(0.5, 6);
    expect(triangle.getNormalizedNormal().equals(Vec3.unitZ(), 1e-6)).toBe(true);
    expect(triangle.containsPoint(new Vec3(0.25, 0.25, 0), 1e-6)).toBe(true);
    expect(triangle.containsPoint(new Vec3(1, 1, 0), 1e-6)).toBe(false);
  });
});

describe('Frustum', () => {
  const buildFrustum = (): Frustum => {
    const projection = new Mat4().makePerspective(Math.PI / 3, 1, 0.1, 100);
    const view = new Mat4().lookAt(new Vec3(0, 0, 5), new Vec3(0, 0, 0), Vec3.unitY());
    return new Frustum().setFromProjectionAndView(projection, view);
  };

  it('contains a point in front of the camera', () => {
    expect(buildFrustum().containsPoint(new Vec3(0, 0, 0))).toBe(true);
  });

  it('rejects a point behind the camera', () => {
    expect(buildFrustum().containsPoint(new Vec3(0, 0, 100))).toBe(false);
  });

  it('rejects a sphere far to the side', () => {
    expect(buildFrustum().intersectsSphere(new Sphere(new Vec3(500, 0, 0), 1))).toBe(false);
  });

  it('accepts a box containing the origin and rejects a distant box', () => {
    const frustum = buildFrustum();
    expect(frustum.intersectsBox(new Box3(new Vec3(-1, -1, -1), new Vec3(1, 1, 1)))).toBe(true);
    expect(frustum.intersectsBox(new Box3(new Vec3(400, 0, 0), new Vec3(401, 1, 1)))).toBe(false);
  });

  it('rejects an empty box', () => {
    const box = new Box3();
    box.makeEmpty();
    expect(buildFrustum().intersectsBox(box)).toBe(false);
  });
});
