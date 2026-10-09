/**
 * Unit tests for the geometry core and the 2D geometry layer.
 *
 * The suite deliberately tests the *contracts the rest of the library relies on*
 * rather than incidental implementation details: buffer round-trips, bounding
 * volume extents, indexed-to-non-indexed expansion, curve endpoints and analytic
 * midpoints, exact circle length, triangulation areas, polyline reduction and
 * boolean set areas.
 */

import { describe, expect, it } from 'vitest';

import { Vec2 } from '../../src/math/Vec2';
import { Mat4 } from '../../src/math/Mat4';
import {
  BufferAttribute,
  Float32BufferAttribute,
  Uint16BufferAttribute,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  BufferGeometry,
  Geometry,
} from '../../src/geometry/core';
import {
  CircleShape,
  CubicBezierCurve,
  EllipseCurve,
  LineCurve,
  Path,
  Polygon,
  Polyline,
  QuadraticBezierCurve,
  RectShape,
  SplineCurve,
  clipPolygon,
  difference,
  intersection,
  isSimplePolygon,
  polygonSelfIntersects,
  signedArea,
  triangulateShape,
  union,
} from '../../src/geometry/2d';
import { BufferGeometry as BarrelBufferGeometry, CircleShape as BarrelCircleShape } from '../../src/geometry';
import type { BoundsSource } from '../../src/core/BoundingVolume';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Total unsigned area of a flat triangulation. */
function triangulationArea(vertices: readonly number[], indices: readonly number[]): number {
  let total = 0;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 2;
    const b = indices[i + 1] * 2;
    const c = indices[i + 2] * 2;
    const cross =
      (vertices[b] - vertices[a]) * (vertices[c + 1] - vertices[a + 1]) -
      (vertices[c] - vertices[a]) * (vertices[b + 1] - vertices[a + 1]);
    total += Math.abs(cross) * 0.5;
  }
  return total;
}

/** The unit square `(0,0) (1,0) (1,1) (0,1)`. */
function unitSquare(): Vec2[] {
  return [new Vec2(0, 0), new Vec2(1, 0), new Vec2(1, 1), new Vec2(0, 1)];
}

/* -------------------------------------------------------------------------- */
/* BufferAttribute                                                            */
/* -------------------------------------------------------------------------- */

describe('BufferAttribute', () => {
  it('round-trips every component including w', () => {
    const attribute = new Float32BufferAttribute(new Float32Array(8), 4);
    expect(attribute.count).toBe(2);
    expect(attribute.itemSize).toBe(4);

    attribute.setXYZW(0, 1, 2, 3, 4);
    attribute.setXYZW(1, -1, -2, -3, -4);

    expect(attribute.getX(0)).toBe(1);
    expect(attribute.getY(0)).toBe(2);
    expect(attribute.getZ(0)).toBe(3);
    expect(attribute.getW(0)).toBe(4);

    expect(attribute.getX(1)).toBe(-1);
    expect(attribute.getY(1)).toBe(-2);
    expect(attribute.getZ(1)).toBe(-3);
    expect(attribute.getW(1)).toBe(-4);

    // Individual setters must write the same slots.
    attribute.setX(0, 10).setY(0, 20).setZ(0, 30).setW(0, 40);
    expect([attribute.getX(0), attribute.getY(0), attribute.getZ(0), attribute.getW(0)]).toEqual([
      10, 20, 30, 40,
    ]);

    attribute.setXY(1, 7, 8);
    expect(attribute.getX(1)).toBe(7);
    expect(attribute.getY(1)).toBe(8);
    expect(attribute.getZ(1)).toBe(-3);

    attribute.setXYZ(1, 5, 6, 7);
    expect([attribute.getX(1), attribute.getY(1), attribute.getZ(1), attribute.getW(1)]).toEqual([
      5, 6, 7, -4,
    ]);
  });

  it('reports missing components as zero instead of reading past the element', () => {
    const attribute = new Float32BufferAttribute(new Float32Array([1, 2, 3, 4, 5, 6]), 3);
    expect(attribute.getW(0)).toBe(0);
    expect(attribute.getComponent(0, 5)).toBe(0);
    expect(attribute.setZ(0, 9).getZ(0)).toBe(9);
  });

  it('tracks changes through version and needsUpdate', () => {
    const attribute = new Float32BufferAttribute(new Float32Array([0, 0, 0]), 3);
    const initial = attribute.version;
    attribute.setXYZ(0, 1, 1, 1);
    expect(attribute.version).toBeGreaterThan(initial);
    expect(attribute.needsUpdate).toBe(true);

    attribute.needsUpdate = false;
    const acknowledged = attribute.version;
    expect(attribute.needsUpdate).toBe(false);
    expect(attribute.version).toBe(acknowledged);

    attribute.needsUpdate = true;
    expect(attribute.needsUpdate).toBe(true);
    expect(attribute.version).toBeGreaterThan(acknowledged);
  });

  it('iterates [x, y, z, w] tuples and round-trips through JSON', () => {
    const attribute = new Uint16BufferAttribute([1, 2, 3, 4, 5, 6], 3);
    const tuples = [...attribute];
    expect(tuples).toEqual([
      [1, 2, 3, 0],
      [4, 5, 6, 0],
    ]);

    const restored = BufferAttribute.fromJSON(attribute.toJSON());
    expect(restored.itemSize).toBe(3);
    expect(restored.count).toBe(2);
    expect([...restored]).toEqual(tuples);
  });

  it('clones without sharing the backing array', () => {
    const attribute = new Float32BufferAttribute([1, 2, 3], 3);
    const clone = attribute.clone();
    clone.setX(0, 99);
    expect(attribute.getX(0)).toBe(1);
    expect(clone.getX(0)).toBe(99);
  });

  it('transforms positions and normals correctly', () => {
    const scaleTranslate = new Mat4().makeScale(2, 2, 2).setPosition(1, 1, 1);
    const positions = new Float32BufferAttribute([1, 0, 0, 0, 1, 0], 3);
    positions.applyMat4(scaleTranslate, 'position');
    expect(positions.getX(0)).toBeCloseTo(3, 5);
    expect(positions.getY(0)).toBeCloseTo(1, 5);
    expect(positions.getX(1)).toBeCloseTo(1, 5);
    expect(positions.getY(1)).toBeCloseTo(3, 5);

    // A non-uniform scale must not shear the normal off the surface, which is
    // exactly what the inverse-transpose buys: diag(2,1,1) is passed through as
    // diag(0.5,1,1), so (1,1,0) becomes (0.5,1,0) and normalises to (1,2,0)/√5.
    const nonUniform = new Mat4().makeScale(2, 1, 1);
    const normals = new Float32BufferAttribute([1, 1, 0], 3);
    normals.applyMat4(nonUniform, 'normal');
    expect(normals.getX(0)).toBeCloseTo(1 / Math.sqrt(5), 5);
    expect(normals.getY(0)).toBeCloseTo(2 / Math.sqrt(5), 5);
    expect(normals.getZ(0)).toBeCloseTo(0, 6);
  });
});

/* -------------------------------------------------------------------------- */
/* Interleaved buffers                                                        */
/* -------------------------------------------------------------------------- */

describe('InterleavedBuffer', () => {
  it('reads and writes views at their stride and offset', () => {
    // Two vertices of position.xyz + uv.xy => stride 5.
    const data = new InterleavedBuffer(
      new Float32Array([0, 0, 0, 0.25, 0.75, 1, 1, 1, 0.5, 1]),
      5,
    );
    const position = new InterleavedBufferAttribute(data, 3, 0, false, 'position');
    const uv = new InterleavedBufferAttribute(data, 2, 3, false, 'uv');

    expect(position.count).toBe(2);
    expect(uv.stride).toBe(5);

    expect([position.getX(1), position.getY(1), position.getZ(1)]).toEqual([1, 1, 1]);
    expect([uv.getX(0), uv.getY(0)]).toEqual([0.25, 0.75]);
    expect([uv.getX(1), uv.getY(1)]).toEqual([0.5, 1]);

    uv.setXY(0, 0.1, 0.2);
    expect(uv.getX(0)).toBeCloseTo(0.1, 6);
    expect(uv.getY(0)).toBeCloseTo(0.2, 6);
    // Writing the uv view must not disturb the position view.
    expect([position.getX(0), position.getY(0), position.getZ(0)]).toEqual([0, 0, 0]);
  });

  it('rejects a view that does not fit inside the stride', () => {
    const data = new InterleavedBuffer(new Float32Array(10), 5);
    expect(() => new InterleavedBufferAttribute(data, 4, 3)).toThrow(/does not fit/);
  });

  it('round-trips a view through JSON', () => {
    const data = new InterleavedBuffer(new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]), 3);
    const view = new InterleavedBufferAttribute(data, 3, 0, false, 'position');
    const restored = InterleavedBufferAttribute.fromJSON(view.toJSON());
    expect(restored.stride).toBe(3);
    expect([...restored]).toEqual([...view]);
  });
});

/* -------------------------------------------------------------------------- */
/* BufferGeometry                                                             */
/* -------------------------------------------------------------------------- */

describe('BufferGeometry', () => {
  /** A single triangle in the XY plane. */
  function triangle(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new Float32BufferAttribute(new Float32Array([0, 0, 0, 2, 0, 0, 0, 4, 0]), 3, false, 'static', 'position'),
    );
    return geometry;
  }

  it('computes the expected bounding box for a hand-built triangle', () => {
    const geometry = triangle();
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    expect(box).not.toBeNull();
    expect(box?.min.x).toBeCloseTo(0, 6);
    expect(box?.min.y).toBeCloseTo(0, 6);
    expect(box?.min.z).toBeCloseTo(0, 6);
    expect(box?.max.x).toBeCloseTo(2, 6);
    expect(box?.max.y).toBeCloseTo(4, 6);
    expect(box?.max.z).toBeCloseTo(0, 6);
  });

  it('computes a bounding sphere that encloses every vertex', () => {
    const geometry = triangle();
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere;
    expect(sphere).not.toBeNull();
    // Centre of the box (1, 2), farthest vertex distance = hypot(1, 2).
    expect(sphere?.center.x).toBeCloseTo(1, 6);
    expect(sphere?.center.y).toBeCloseTo(2, 6);
    expect(sphere?.radius).toBeCloseTo(Math.hypot(1, 2), 6);
  });

  it('expands an indexed triangle to three unique positions', () => {
    const geometry = triangle();
    geometry.setIndex([0, 1, 2]);
    expect(geometry.indexed).toBe(true);

    const expanded = geometry.toNonIndexed();
    expect(expanded.indexed).toBe(false);
    const position = expanded.getAttribute('position');
    expect(position?.count).toBe(3);
    expect(position?.getX(0)).toBeCloseTo(0, 6);
    expect(position?.getX(1)).toBeCloseTo(2, 6);
    expect(position?.getY(2)).toBeCloseTo(4, 6);
  });

  it('duplicates shared vertices when expanding an indexed quad', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new Float32BufferAttribute(
        new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
        3,
      ),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);

    const expanded = geometry.toNonIndexed();
    const position = expanded.getAttribute('position');
    expect(position?.count).toBe(6);
    // The first vertex of the quad appears twice, at both triangles' starts.
    expect(position?.getX(0)).toBeCloseTo(0, 6);
    expect(position?.getY(0)).toBeCloseTo(0, 6);
    expect(position?.getX(3)).toBeCloseTo(0, 6);
    expect(position?.getY(3)).toBeCloseTo(0, 6);
  });

  it('computes outward normals for a triangle', () => {
    const geometry = triangle();
    geometry.computeVertexNormals();
    const normal = geometry.getAttribute('normal');
    expect(normal?.count).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(normal?.getZ(i) ?? 0)).toBeCloseTo(1, 6);
    }
  });

  it('satisfies the BoundsSource contract getIndex() shape', () => {
    const geometry = triangle();
    expect(geometry.getIndex()).toBeUndefined();
    geometry.setIndex([0, 1, 2]);
    expect(geometry.getIndex()?.count).toBe(3);
    expect(geometry.getAttribute('position')?.array.length).toBe(9);
  });

  it('satisfies the BoundsSource contract structurally', () => {
    const geometry = triangle();
    geometry.setIndex([0, 1, 2]);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    // Compile-time proof: `BufferGeometry` must remain assignable to the
    // structural contract that `BoundingVolume` consumes.
    const source: BoundsSource = geometry;

    expect(source.getAttribute?.('position')?.count).toBe(3);
    expect(source.getAttribute?.('position')?.itemSize).toBe(3);
    expect(source.getIndex?.()?.array.length).toBe(3);
    expect(source.indexed).toBe(true);
    expect(source.drawRange?.count).toBe(Infinity);
    expect(source.boundingBox).not.toBeNull();
    expect(source.boundingSphere).not.toBeNull();
  });

  it('applies a matrix to positions and to the cached bounds', () => {
    const geometry = triangle();
    geometry.computeBoundingBox();
    geometry.applyMat4(new Mat4().makeTranslation(10, 0, 0));
    expect(geometry.getAttribute('position')?.getX(0)).toBeCloseTo(10, 5);
    expect(geometry.boundingBox?.min.x).toBeCloseTo(10, 5);
    expect(geometry.boundingBox?.max.x).toBeCloseTo(12, 5);
  });

  it('round-trips through JSON', () => {
    const geometry = triangle().setIndex([0, 1, 2]).addGroup(0, 3, 1);
    const restored = BufferGeometry.fromJSON(geometry.toJSON());
    expect(restored.getAttribute('position')?.count).toBe(3);
    expect(restored.getIndex()?.count).toBe(3);
    expect(restored.groups).toEqual([{ start: 0, count: 3, materialIndex: 1 }]);
  });

  it('disposes every attribute and the index', () => {
    const geometry = triangle().setIndex([0, 1, 2]);
    const position = geometry.getAttribute('position');
    geometry.dispose();
    expect(geometry.isDisposed).toBe(true);
    expect(position?.isDisposed).toBe(true);
    expect(geometry.getAttribute('position')).toBeUndefined();
  });

  it('converts the legacy Geometry representation', () => {
    const legacy = new Geometry();
    const a = legacy.addVertex(0, 0, 0);
    const b = legacy.addVertex(1, 0, 0);
    const c = legacy.addVertex(1, 1, 0);
    legacy.addTriangle(a, b, c);
    legacy.computeFaceNormals();

    const geometry = legacy.toBufferGeometry();
    const position = geometry.getAttribute('position');
    expect(position?.count).toBe(3);
    expect(position?.getX(1)).toBeCloseTo(1, 9);
    expect(position?.getY(2)).toBeCloseTo(1, 9);
    expect(geometry.indexed).toBe(false);
    expect(geometry.getAttribute('normal')).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Bezier curves                                                              */
/* -------------------------------------------------------------------------- */

describe('Bezier curves', () => {
  it('hits the endpoints and the analytic midpoint of a quadratic Bezier', () => {
    const curve = new QuadraticBezierCurve(new Vec2(0, 0), new Vec2(1, 2), new Vec2(2, 0));

    expect(curve.getPoint(0).x).toBeCloseTo(0, 9);
    expect(curve.getPoint(0).y).toBeCloseTo(0, 9);
    expect(curve.getPoint(1).x).toBeCloseTo(2, 9);
    expect(curve.getPoint(1).y).toBeCloseTo(0, 9);

    // Analytic midpoint: (v0 + 2·v1 + v2) / 4.
    const midpoint = curve.getPoint(0.5);
    expect(midpoint.x).toBeCloseTo((0 + 2 * 1 + 2) / 4, 9);
    expect(midpoint.y).toBeCloseTo((0 + 2 * 2 + 0) / 4, 9);
  });

  it('hits the endpoints and the analytic midpoint of a cubic Bezier', () => {
    const curve = new CubicBezierCurve(
      new Vec2(0, 0),
      new Vec2(0, 1),
      new Vec2(1, 1),
      new Vec2(1, 0),
    );

    expect(curve.getPoint(0).x).toBeCloseTo(0, 9);
    expect(curve.getPoint(0).y).toBeCloseTo(0, 9);
    expect(curve.getPoint(1).x).toBeCloseTo(1, 9);
    expect(curve.getPoint(1).y).toBeCloseTo(0, 9);

    // Analytic midpoint: (v0 + 3·v1 + 3·v2 + v3) / 8.
    const midpoint = curve.getPoint(0.5);
    expect(midpoint.x).toBeCloseTo((0 + 0 + 3 + 1) / 8, 9);
    expect(midpoint.y).toBeCloseTo((0 + 3 + 3 + 0) / 8, 9);
  });

  it('round-trips Bezier curves through JSON', () => {
    const curve = new CubicBezierCurve(
      new Vec2(0, 0),
      new Vec2(0, 1),
      new Vec2(1, 1),
      new Vec2(1, 0),
    );
    const restored = CubicBezierCurve.fromJSON(curve.toJSON());
    expect(restored.getPoint(0.5).x).toBeCloseTo(curve.getPoint(0.5).x, 9);
    expect(restored.getPoint(0.5).y).toBeCloseTo(curve.getPoint(0.5).y, 9);
  });
});

/* -------------------------------------------------------------------------- */
/* EllipseCurve                                                               */
/* -------------------------------------------------------------------------- */

describe('EllipseCurve', () => {
  it('reports (xRadius + aX, aY) at angle zero', () => {
    const curve = new EllipseCurve(0, 0, 5, 3, 0, Math.PI * 2, false, 0);
    const start = curve.getPoint(0);
    expect(start.x).toBeCloseTo(5 + 0, 9);
    expect(start.y).toBeCloseTo(0, 9);
  });

  it('reports (xRadius + aX, aY) at angle zero for an offset, unrotated ellipse', () => {
    const curve = new EllipseCurve(2, -1, 4, 1.5, 0, Math.PI * 2, false, 0);
    const start = curve.getPoint(0);
    expect(start.x).toBeCloseTo(4 + 2, 9);
    expect(start.y).toBeCloseTo(-1, 9);
  });

  it('measures a circle to within 0.5% of its circumference', () => {
    const curve = new EllipseCurve(0, 0, 3, 3, 0, Math.PI * 2, false, 0);
    const expected = 2 * Math.PI * 3;
    expect(Math.abs(curve.getLength() - expected) / expected).toBeLessThan(0.005);
  });
});

/* -------------------------------------------------------------------------- */
/* Path                                                                       */
/* -------------------------------------------------------------------------- */

describe('Path', () => {
  it('builds a closed circle of the right length with arc + closePath', () => {
    const path = new Path();
    path.arc(0, 0, 1, 0, Math.PI * 2, false);
    path.closePath();

    const expected = 2 * Math.PI;
    const length = path.getLength();
    expect(Math.abs(length - expected) / expected).toBeLessThan(0.005);

    // Closing a full circle must not add a chord: the path is already closed.
    const start = path.getPoint(0);
    const end = path.getPoint(1);
    expect(start.distanceTo(end)).toBeLessThan(1e-6);
  });

  it('measures a polyline path exactly', () => {
    const path = new Path();
    path.moveTo(0, 0);
    path.lineTo(3, 0);
    path.lineTo(3, 4);
    expect(path.getLength()).toBeCloseTo(7, 9);
  });

  it('reparameterises by arc length, not by segment index', () => {
    const path = new Path();
    path.moveTo(0, 0);
    path.lineTo(1, 0); // short segment
    path.lineTo(1, 10); // long segment
    // Half the total length (5.5 of 11) is 4.5 up the second segment.
    const half = path.getPointAt(0.5);
    expect(half.x).toBeCloseTo(1, 9);
    expect(half.y).toBeCloseTo(4.5, 9);
  });

  it('splits into sub-paths at move commands', () => {
    const path = new Path();
    path.moveTo(0, 0);
    path.lineTo(1, 0);
    path.moveTo(5, 5);
    path.lineTo(6, 5);
    expect(path.subPaths.length).toBe(2);
  });

  it('produces a triangulated BufferGeometry for a shape', () => {
    const geometry = new RectShape(0, 0, 2, 1).toBufferGeometry(4);
    expect(geometry.getAttribute('position')).toBeDefined();
    expect(geometry.getAttribute('uv')).toBeDefined();
    expect(geometry.indexed).toBe(true);
    expect(geometry.getIndex()?.count).toBe(6);
  });

  it('produces a line-list BufferGeometry for a path', () => {
    const path = new Path();
    path.moveTo(0, 0);
    path.lineTo(1, 0);
    path.lineTo(1, 1);

    const geometry = path.toBufferGeometry(4);
    expect(geometry.indexed).toBe(false);
    // moveTo's zero-length marker contributes no extra sample.
    expect(geometry.getAttribute('position')?.count).toBe(3);
  });

  it('round-trips through JSON', () => {
    const path = new Path();
    path.moveTo(0, 0);
    path.quadraticCurveTo(1, 2, 2, 0);
    path.bezierCurveTo(3, -2, 4, 2, 5, 0);
    path.splineThru([new Vec2(6, 0), new Vec2(7, 1)]);

    const restored = Path.fromJSON(path.toJSON());
    expect(restored.curves.length).toBe(path.curves.length);
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      expect(restored.getPoint(t).x).toBeCloseTo(path.getPoint(t).x, 6);
      expect(restored.getPoint(t).y).toBeCloseTo(path.getPoint(t).y, 6);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

describe('Shapes', () => {
  it('measures a circle shape to within 0.5% of its circumference', () => {
    const circle = CircleShape.create(0, 0, 2);
    const expected = 2 * Math.PI * 2;
    expect(Math.abs(circle.getLength() - expected) / expected).toBeLessThan(0.005);
    expect(circle.area).toBeCloseTo(Math.PI * 4, 9);
  });

  it('measures a rectangle perimeter exactly', () => {
    const rect = RectShape.create(0, 0, 3, 4);
    expect(rect.getLength()).toBeCloseTo(14, 9);
    expect(rect.area).toBeCloseTo(12, 9);
  });
});

/* -------------------------------------------------------------------------- */
/* Polyline                                                                   */
/* -------------------------------------------------------------------------- */

describe('Polyline', () => {
  it('reduces a collinear run to its endpoints', () => {
    const polyline = new Polyline([
      new Vec2(0, 0),
      new Vec2(1, 0),
      new Vec2(2, 0),
      new Vec2(3, 0),
      new Vec2(4, 0),
    ]);
    expect(polyline.count).toBe(5);

    const simplified = polyline.simplify(0.01);
    expect(simplified.count).toBe(2);
    expect(simplified.points[0].x).toBeCloseTo(0, 9);
    expect(simplified.points[1].x).toBeCloseTo(4, 9);
  });

  it('keeps a vertex that exceeds the tolerance', () => {
    const polyline = new Polyline([new Vec2(0, 0), new Vec2(1, 1), new Vec2(2, 0)]);
    expect(polyline.simplify(0.01).count).toBe(3);
    expect(polyline.simplify(2).count).toBe(2);
  });

  it('measures length and finds the closest point', () => {
    const polyline = new Polyline([new Vec2(0, 0), new Vec2(10, 0)]);
    expect(polyline.length).toBeCloseTo(10, 9);

    const closest = polyline.closestPoint(new Vec2(4, 3));
    expect(closest.distance).toBeCloseTo(3, 9);
    expect(closest.point.x).toBeCloseTo(4, 9);
    expect(closest.point.y).toBeCloseTo(0, 9);
    expect(closest.segment).toBe(0);
  });

  it('resamples uniformly by arc length', () => {
    const polyline = new Polyline([new Vec2(0, 0), new Vec2(1, 0), new Vec2(1, 9)]);
    const resampled = polyline.resample(11);
    expect(resampled.count).toBe(11);
    let previous = resampled.points[0];
    for (let i = 1; i < resampled.count; i++) {
      expect(resampled.points[i].distanceTo(previous)).toBeCloseTo(1, 6);
      previous = resampled.points[i];
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Triangulation                                                              */
/* -------------------------------------------------------------------------- */

describe('Triangulate', () => {
  it('triangulates a square into two triangles', () => {
    const result = triangulateShape(unitSquare());
    expect(result.indices.length).toBe(6);
    expect(result.vertices.length / 2).toBe(4);
    expect(triangulationArea(result.vertices, result.indices)).toBeCloseTo(1, 9);
  });

  it('accepts either winding for the outer contour', () => {
    const reversed = unitSquare().reverse();
    const result = triangulateShape(reversed);
    expect(result.indices.length).toBe(6);
    expect(triangulationArea(result.vertices, result.indices)).toBeCloseTo(1, 9);
  });

  it('triangulates a square with a square hole to outer minus hole area', () => {
    const outer = [new Vec2(0, 0), new Vec2(4, 0), new Vec2(4, 4), new Vec2(0, 4)];
    const hole = [
      new Vec2(1, 1),
      new Vec2(3, 1),
      new Vec2(3, 3),
      new Vec2(1, 3),
    ];

    const result = triangulateShape(outer, [hole]);
    expect(result.indices.length).toBeGreaterThan(0);
    expect(result.uvs.length).toBe(result.vertices.length);

    const area = triangulationArea(result.vertices, result.indices);
    const expected = 16 - 4;
    expect(Math.abs(area - expected) / expected).toBeLessThan(0.01);
  });

  it('reports the winding of a contour', () => {
    expect(signedArea(unitSquare())).toBeGreaterThan(0);
    expect(signedArea(unitSquare().reverse())).toBeLessThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Boolean operations                                                         */
/* -------------------------------------------------------------------------- */

describe('BooleanOps', () => {
  /** `(0,0) (2,0) (2,1) (0,1)` — shares a collinear bottom edge with the next. */
  const left = [new Vec2(0, 0), new Vec2(2, 0), new Vec2(2, 1), new Vec2(0, 1)];
  /** `(1,0) (3,0) (3,1) (1,1)`. */
  const right = [new Vec2(1, 0), new Vec2(3, 0), new Vec2(3, 1), new Vec2(1, 1)];

  it('unions two overlapping unit squares into an area of three', () => {
    const result = union(left, right);
    expect(result.length).toBe(1);

    const area = Math.abs(signedArea(result[0]));
    expect(Math.abs(area - 3) / 3).toBeLessThan(0.02);
  });

  it('intersects two overlapping unit squares into an area of one', () => {
    const result = intersection(left, right);
    let area = 0;
    for (const contour of result) area += Math.abs(signedArea(contour));
    expect(Math.abs(area - 1) / 1).toBeLessThan(0.02);
  });

  it('returns an empty result for a difference that removes everything', () => {
    expect(difference(left, left).length).toBe(0);
  });

  it('leaves a clockwise hole when the subtrahend is inside the minuend', () => {
    const outer = [new Vec2(0, 0), new Vec2(4, 0), new Vec2(4, 4), new Vec2(0, 4)];
    const inner = [new Vec2(1, 1), new Vec2(3, 1), new Vec2(3, 3), new Vec2(1, 3)];
    const result = difference(outer, inner);

    let net = 0;
    let hasHole = false;
    for (const contour of result) {
      const area = signedArea(contour);
      net += area;
      if (area < 0) hasHole = true;
    }
    expect(hasHole).toBe(true);
    expect(Math.abs(net - 12) / 12).toBeLessThan(0.02);
  });

  it('detects self-intersection and reports simple polygons', () => {
    const bowtie = [
      new Vec2(0, 0),
      new Vec2(2, 2),
      new Vec2(2, 0),
      new Vec2(0, 2),
    ];
    expect(polygonSelfIntersects(bowtie)).toBe(true);
    expect(isSimplePolygon(bowtie)).toBe(false);
    expect(isSimplePolygon(unitSquare())).toBe(true);
  });

  it('clips against a convex window and refuses a non-convex one', () => {
    const subject = [new Vec2(0, 0), new Vec2(4, 0), new Vec2(4, 4), new Vec2(0, 4)];
    const window = [new Vec2(1, 1), new Vec2(3, 1), new Vec2(3, 3), new Vec2(1, 3)];
    const clipped = clipPolygon(subject, window);
    expect(Math.abs(signedArea(clipped))).toBeCloseTo(4, 6);

    const nonConvex = [
      new Vec2(0, 0),
      new Vec2(4, 0),
      new Vec2(4, 4),
      new Vec2(2, 2),
      new Vec2(0, 4),
    ];
    expect(() => clipPolygon(subject, nonConvex)).toThrow(/convex/);
    // The general path still handles it.
    const viaIntersection = intersection(subject, nonConvex);
    let area = 0;
    for (const contour of viaIntersection) area += Math.abs(signedArea(contour));
    // The window is 16 - 2 * (2*2/2) = 12.
    expect(Math.abs(area - 12) / 12).toBeLessThan(0.02);
  });
});

/* -------------------------------------------------------------------------- */
/* Barrel                                                                     */
/* -------------------------------------------------------------------------- */

describe('geometry barrel', () => {
  it('re-exports the core and 2D layers through src/geometry/index.ts', () => {
    expect(typeof BarrelBufferGeometry).toBe('function');
    expect(typeof BarrelCircleShape).toBe('function');

    const geometry = new BarrelBufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3, false, 'static', 'position'));
    expect(geometry.getAttribute('position')?.count).toBe(1);
  });

  it('computes bounds from an interleaved position stream', () => {
    const data = new InterleavedBuffer(
      new Float32Array([
        0, 0, 0, 1, 1,
        4, 2, 0, 0, 0,
      ]),
      5,
    );
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new InterleavedBufferAttribute(data, 3, 0, false, 'position'));
    geometry.setAttribute('uv', new InterleavedBufferAttribute(data, 2, 3, false, 'uv'));
    geometry.computeBoundingBox();

    expect(geometry.boundingBox?.min.x).toBeCloseTo(0, 6);
    expect(geometry.boundingBox?.min.y).toBeCloseTo(0, 6);
    expect(geometry.boundingBox?.max.x).toBeCloseTo(4, 6);
    expect(geometry.boundingBox?.max.y).toBeCloseTo(2, 6);
  });
});

/* -------------------------------------------------------------------------- */
/* Curves: arc length and frames                                              */
/* -------------------------------------------------------------------------- */

describe('Curve arc length', () => {
  it('measures a straight line exactly', () => {
    const line = new LineCurve(new Vec2(0, 0), new Vec2(3, 4));
    expect(line.getLength()).toBeCloseTo(5, 9);
  });

  it('reparameterises by arc length', () => {
    const line = new LineCurve(new Vec2(0, 0), new Vec2(10, 0));
    expect(line.getPointAt(0.25).x).toBeCloseTo(2.5, 9);
  });

  it('builds per-sample frames', () => {
    const line = new LineCurve(new Vec2(0, 0), new Vec2(1, 1));
    const frames = line.computeFrenetFrames(4);
    expect(frames.tangents.length).toBe(5);
    expect(frames.normals.length).toBe(5);
    // Tangents are unit length and normals are perpendicular to them.
    for (let i = 0; i < frames.tangents.length; i++) {
      expect(frames.tangents[i].length()).toBeCloseTo(1, 6);
      expect(frames.tangents[i].dot(frames.normals[i])).toBeCloseTo(0, 9);
    }
  });

  it('interpolates its own control points', () => {
    const spline = new SplineCurve([
      new Vec2(0, 0),
      new Vec2(1, 2),
      new Vec2(3, 2),
      new Vec2(4, 0),
    ]);
    expect(spline.getPoint(0).x).toBeCloseTo(0, 9);
    expect(spline.getPoint(0).y).toBeCloseTo(0, 9);
    expect(spline.getPoint(1).x).toBeCloseTo(4, 9);
    expect(spline.getPoint(1).y).toBeCloseTo(0, 9);
    expect(spline.getLength()).toBeGreaterThan(4);
  });
});

/* -------------------------------------------------------------------------- */
/* Polygon                                                                    */
/* -------------------------------------------------------------------------- */

describe('Polygon', () => {
  it('computes area, orientation and centroid', () => {
    const polygon = new Polygon(unitSquare());
    expect(polygon.area).toBeCloseTo(1, 9);
    expect(polygon.isClockwise).toBe(false);
    expect(polygon.orientation).toBe('counter-clockwise');
    expect(polygon.centroid.x).toBeCloseTo(0.5, 9);
    expect(polygon.centroid.y).toBeCloseTo(0.5, 9);
  });

  it('tests containment including the boundary', () => {
    const polygon = new Polygon(unitSquare());
    expect(polygon.containsPoint(new Vec2(0.5, 0.5))).toBe(true);
    expect(polygon.containsPoint(new Vec2(2, 0.5))).toBe(false);
    expect(polygon.containsPoint(new Vec2(0, 0.5))).toBe(true);
    expect(polygon.pointOnEdge(new Vec2(0.5, 0), 1e-9)).toBe(true);
  });

  it('detects convexity', () => {
    expect(new Polygon(unitSquare()).isConvex).toBe(true);
    const concave = new Polygon([
      new Vec2(0, 0),
      new Vec2(2, 0),
      new Vec2(2, 2),
      new Vec2(1, 1),
      new Vec2(0, 2),
    ]);
    expect(concave.isConvex).toBe(false);
  });

  it('triangulates itself', () => {
    const result = new Polygon(unitSquare()).triangulate();
    expect(result.indices.length).toBe(6);
    expect(triangulationArea(result.vertices, result.indices)).toBeCloseTo(1, 9);
  });
});
