import { describe, expect, it } from 'vitest';
import { Mat4, Vec3 } from '../../src/math';

/**
 * Pins the camera/view-matrix convention: `lookAt` is documented as building a
 * **view matrix** (the inverse of the camera's world matrix), so it maps world
 * coordinates into camera space where the camera sits at the origin looking down
 * `-Z`.
 */
describe('view matrix convention', () => {
  it('puts the eye at the origin looking down -Z', () => {
    const view = new Mat4().lookAt(new Vec3(0, 0, 5), new Vec3(0, 0, 0), Vec3.unitY());

    // The eye maps to the origin.
    expect(new Vec3(0, 0, 5).applyMat4(view).equals(new Vec3(0, 0, 0), 1e-5)).toBe(true);
    // The look-at target ends up in front of the camera, i.e. at -Z.
    expect(new Vec3(0, 0, 0).applyMat4(view).equals(new Vec3(0, 0, -5), 1e-5)).toBe(true);
    // Camera-space axes keep their handedness for a camera looking down -Z.
    expect(new Vec3(1, 0, 0).applyMat4(view).equals(new Vec3(1, 0, -5), 1e-5)).toBe(true);
    expect(new Vec3(0, 1, 0).applyMat4(view).equals(new Vec3(0, 1, -5), 1e-5)).toBe(true);
  });

  it('is the inverse of the camera world matrix it implies', () => {
    const eye = new Vec3(3, -2, 7);
    const view = new Mat4().lookAt(eye, new Vec3(0, 0, 0), Vec3.unitY());

    // `lookAt` builds the inverse, so inverting it must recover a world matrix
    // that places the eye at `eye`.
    const world = view.clone().invert();
    expect(world.getTranslation().equals(eye, 1e-5)).toBe(true);
    // And `world * view` is the identity.
    expect(world.clone().multiply(view).isIdentity(1e-5)).toBe(true);
  });

  it('keeps a right-handed camera basis', () => {
    const view = new Mat4().lookAt(new Vec3(0, 0, 5), new Vec3(0, 0, 0), Vec3.unitY());
    const e = view.elements;

    // Rows 0..2 of the rotation block are the camera basis vectors in world space.
    const xAxis = new Vec3(e[0], e[4], e[8]);
    const yAxis = new Vec3(e[1], e[5], e[9]);
    const zAxis = new Vec3(e[2], e[6], e[10]);

    expect(xAxis.length()).toBeCloseTo(1, 5);
    expect(yAxis.length()).toBeCloseTo(1, 5);
    expect(zAxis.length()).toBeCloseTo(1, 5);
    expect(xAxis.dot(yAxis)).toBeCloseTo(0, 5);
    expect(xAxis.dot(zAxis)).toBeCloseTo(0, 5);
    expect(yAxis.dot(zAxis)).toBeCloseTo(0, 5);
    // Right-handed: x cross y = z.
    expect(xAxis.clone().cross(yAxis).equals(zAxis, 1e-5)).toBe(true);
  });
});
