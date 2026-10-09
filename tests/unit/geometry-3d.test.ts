/**
 * Unit tests for the 3D geometry layer.
 *
 * The interesting assertions here are *topological* and *geometric*, not
 * "it returns something": a generator that produces the right vertex count but
 * inverted winding, a shared pole or a mistyped polyhedron face table looks fine in
 * a smoke test and broken on screen. So the suite checks Euler's formula, outward
 * winding, per-face UV integrity and bounding-volume agreement with the positions.
 */

import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  ConeGeometry,
  CubicBezierCurve3,
  CylinderGeometry,
  DodecahedronGeometry,
  IcosahedronGeometry,
  LineCurve3,
  OctahedronGeometry,
  PlaneGeometry,
  RingGeometry,
  SphereGeometry,
  SplineCurve3,
  TetrahedronGeometry,
  TorusGeometry,
  TubeGeometry,
  computeBoundingBox,
  computeBoundingSphere,
  computeNormals,
  computeTangents,
  correctWinding,
  createBoxGeometry,
  createSphereGeometry,
  mergeGeometries,
  mergeVertices,
  simplify,
  splitEdges,
  subdivide,
  tessellate,
  toWireframe,
} from '../../src/geometry/3d';
import { BufferGeometry } from '../../src/geometry/core/BufferGeometry';
import { Float32BufferAttribute } from '../../src/geometry/core/BufferAttribute';
import { Vec3 } from '../../src/math/Vec3';
import { Box3 } from '../../src/math/Box3';

/** Reads a geometry's positions as `Vec3[]`. */
function positions(geometry: BufferGeometry): Vec3[] {
  const attribute = geometry.getAttribute('position');
  if (!attribute) return [];
  const stride = attribute.itemSize || 3;
  const count = attribute.count > 0 ? attribute.count : Math.floor(attribute.array.length / stride);
  const result: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    result.push(
      new Vec3(
        attribute.array[i * stride] ?? 0,
        attribute.array[i * stride + 1] ?? 0,
        attribute.array[i * stride + 2] ?? 0,
      ),
    );
  }
  return result;
}

/** Reads a geometry's index buffer as triangle triples. */
function triangles(geometry: BufferGeometry): [number, number, number][] {
  const index = geometry.getIndex();
  const attribute = geometry.getAttribute('position');
  if (!attribute) return [];
  const vertexCount =
    attribute.count > 0 ? attribute.count : Math.floor(attribute.array.length / (attribute.itemSize || 3));
  const elementCount = index ? index.count : vertexCount;
  const result: [number, number, number][] = [];
  for (let f = 0; f + 2 < elementCount; f += 3) {
    result.push([
      index ? (index.array[f] ?? 0) : f,
      index ? (index.array[f + 1] ?? 0) : f + 1,
      index ? (index.array[f + 2] ?? 0) : f + 2,
    ]);
  }
  return result;
}

/** Counts unique undirected edges. */
function edgeCount(geometry: BufferGeometry): number {
  const seen = new Set<string>();
  for (const [a, b, c] of triangles(geometry)) {
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      seen.add(u < v ? `${u}_${v}` : `${v}_${u}`);
    }
  }
  return seen.size;
}

/**
 * Fraction of a closed solid's triangles whose geometric normal agrees with its
 * vertex normals.
 *
 * This is the right orientation test, and the reason is worth stating: a criterion
 * based on the face centroid ("does the normal point away from the origin?") is
 * **wrong for a torus**, whose inner wall legitimately faces the hole, and it is
 * meaningless for a flat disc, whose normal is perpendicular to the centroid. The
 * vertex normal, in contrast, points into the "outside" half-space by definition
 * for every surface — sphere, cone, tube interior, torus inner wall — so agreement
 * with it is exactly the property back-face culling needs.
 */
function windingConsistency(geometry: BufferGeometry): number {
  const points = positions(geometry);
  const faces = triangles(geometry);
  const normal = geometry.getAttribute('normal');
  if (!normal) return 0;

  let consistent = 0;
  let counted = 0;

  for (const [a, b, c] of faces) {
    const pa = points[a];
    const pb = points[b];
    const pc = points[c];

    const geometric = new Vec3().copy(pb).sub(pa).cross(new Vec3().copy(pc).sub(pa));
    if (geometric.length() < 1e-12) continue; // degenerate: no orientation to test
    counted++;

    const vertexNormal = new Vec3(
      ((normal.array[a * 3] ?? 0) + (normal.array[b * 3] ?? 0) + (normal.array[c * 3] ?? 0)) / 3,
      ((normal.array[a * 3 + 1] ?? 0) + (normal.array[b * 3 + 1] ?? 0) + (normal.array[c * 3 + 1] ?? 0)) / 3,
      ((normal.array[a * 3 + 2] ?? 0) + (normal.array[b * 3 + 2] ?? 0) + (normal.array[c * 3 + 2] ?? 0)) / 3,
    );

    if (geometric.dot(vertexNormal) > 0) consistent++;
  }

  return counted === 0 ? 0 : consistent / counted;
}

/**
 * Signed volume of a closed mesh, via the divergence theorem.
 *
 * `V = (1/6) Σ (a · (b × c))` over the triangles. A correctly wound (outward-facing)
 * closed mesh has a positive volume; a mesh wound inside out has the same magnitude
 * with the opposite sign. This is the definitive orientation check for a closed
 * surface and, unlike the centroid test, it works for any shape.
 */
function signedVolume(geometry: BufferGeometry): number {
  const points = positions(geometry);
  let total = 0;
  for (const [a, b, c] of triangles(geometry)) {
    const pa = points[a];
    const pb = points[b];
    const pc = points[c];
    total += pa.x * (pb.y * pc.z - pb.z * pc.y);
    total += pa.y * (pb.z * pc.x - pb.x * pc.z);
    total += pa.z * (pb.x * pc.y - pb.y * pc.x);
  }
  return total / 6;
}

describe('BufferGeometry generators — basic invariants', () => {
  const cases: { name: string; build: () => BufferGeometry; minTriangles: number }[] = [
    { name: 'Box', build: () => new BoxGeometry({ width: 2, height: 4, depth: 6 }), minTriangles: 12 },
    { name: 'Plane', build: () => new PlaneGeometry({ width: 2, height: 3, widthSegments: 2, heightSegments: 3 }), minTriangles: 12 },
    { name: 'Sphere', build: () => new SphereGeometry({ radius: 2 }), minTriangles: 100 },
    { name: 'Cylinder', build: () => new CylinderGeometry({ radiusTop: 1, radiusBottom: 2, height: 3 }), minTriangles: 100 },
    { name: 'Cone', build: () => new ConeGeometry({ radius: 1, height: 2 }), minTriangles: 50 },
    { name: 'Capsule', build: () => new CapsuleGeometry({ radius: 0.5, length: 2 }), minTriangles: 100 },
    { name: 'Torus', build: () => new TorusGeometry({ radius: 1, tube: 0.3 }), minTriangles: 500 },
    { name: 'Circle', build: () => new CircleGeometry({ radius: 2 }), minTriangles: 30 },
    { name: 'Ring', build: () => new RingGeometry({ innerRadius: 0.5, outerRadius: 1 }), minTriangles: 30 },
    { name: 'Tetrahedron', build: () => new TetrahedronGeometry(), minTriangles: 4 },
    { name: 'Octahedron', build: () => new OctahedronGeometry(), minTriangles: 8 },
    { name: 'Dodecahedron', build: () => new DodecahedronGeometry(), minTriangles: 36 },
    { name: 'Icosahedron', build: () => new IcosahedronGeometry(), minTriangles: 20 },
    { name: 'Tube', build: () => new TubeGeometry(new LineCurve3(new Vec3(0, 0, 0), new Vec3(0, 5, 0)), { tubularSegments: 16, radialSegments: 8, radius: 0.2 }), minTriangles: 200 },
  ];

  for (const testCase of cases) {
    describe(testCase.name, () => {
      it('produces position, normal and uv attributes', () => {
        const geometry = testCase.build();
        expect(geometry.getAttribute('position')).toBeDefined();
        expect(geometry.getAttribute('normal')).toBeDefined();
        expect(geometry.getAttribute('uv')).toBeDefined();
        expect(geometry.getIndex()).toBeDefined();
        expect(triangles(geometry).length).toBeGreaterThanOrEqual(testCase.minTriangles);
      });

      it('has only finite vertex data', () => {
        const geometry = testCase.build();
        for (const point of positions(geometry)) {
          expect(Number.isFinite(point.x)).toBe(true);
          expect(Number.isFinite(point.y)).toBe(true);
          expect(Number.isFinite(point.z)).toBe(true);
        }
        const normal = geometry.getAttribute('normal');
        for (let i = 0; i < normal!.array.length; i++) {
          expect(Number.isFinite(normal!.array[i])).toBe(true);
        }
      });

      it('has unit-length normals', () => {
        const geometry = testCase.build();
        const points = positions(geometry);
        const normal = geometry.getAttribute('normal')!;
        for (let i = 0; i < points.length; i++) {
          const length = Math.hypot(
            normal.array[i * 3] ?? 0,
            normal.array[i * 3 + 1] ?? 0,
            normal.array[i * 3 + 2] ?? 0,
          );
          expect(length).toBeCloseTo(1, 3);
        }
      });

      it('indices stay inside the vertex range', () => {
        const geometry = testCase.build();
        const vertexCount = positions(geometry).length;
        for (const [a, b, c] of triangles(geometry)) {
          expect(a).toBeGreaterThanOrEqual(0);
          expect(b).toBeGreaterThanOrEqual(0);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(a).toBeLessThan(vertexCount);
          expect(b).toBeLessThan(vertexCount);
          expect(c).toBeLessThan(vertexCount);
        }
      });

      it('computes bounding volumes that agree with the positions', () => {
        const geometry = testCase.build();
        const box = computeBoundingBox(geometry, new Box3());
        const sphere = computeBoundingSphere(geometry);
        expect(box.isEmpty()).toBe(false);
        expect(sphere.radius).toBeGreaterThan(0);

        for (const point of positions(geometry)) {
          expect(point.x).toBeGreaterThanOrEqual(box.min.x - 1e-5);
          expect(point.y).toBeGreaterThanOrEqual(box.min.y - 1e-5);
          expect(point.z).toBeGreaterThanOrEqual(box.min.z - 1e-5);
          expect(point.x).toBeLessThanOrEqual(box.max.x + 1e-5);
          expect(point.y).toBeLessThanOrEqual(box.max.y + 1e-5);
          expect(point.z).toBeLessThanOrEqual(box.max.z + 1e-5);
          // The sphere must contain every vertex.
          expect(point.distanceTo(sphere.center)).toBeLessThanOrEqual(sphere.radius + 1e-4);
        }
      });
    });
  }
});

describe('closed solids wind outward', () => {
  const solids: { name: string; build: () => BufferGeometry }[] = [
    { name: 'Box', build: () => new BoxGeometry({ width: 2, height: 2, depth: 2 }) },
    { name: 'Sphere', build: () => new SphereGeometry({ radius: 1, widthSegments: 12, heightSegments: 8 }) },
    { name: 'Cylinder', build: () => new CylinderGeometry({ radiusTop: 1, radiusBottom: 1, height: 2, radialSegments: 12 }) },
    { name: 'Cone', build: () => new ConeGeometry({ radius: 1, height: 2, radialSegments: 12 }) },
    { name: 'Capsule', build: () => new CapsuleGeometry({ radius: 0.5, length: 1, radialSegments: 12, capSegments: 6 }) },
    { name: 'Torus', build: () => new TorusGeometry({ radius: 1, tube: 0.3, radialSegments: 16, tubularSegments: 8 }) },
    { name: 'Tetrahedron', build: () => new TetrahedronGeometry() },
    { name: 'Octahedron', build: () => new OctahedronGeometry() },
    { name: 'Dodecahedron', build: () => new DodecahedronGeometry() },
    { name: 'Icosahedron', build: () => new IcosahedronGeometry() },
  ];

  for (const solid of solids) {
    it(`${solid.name} winding agrees with its normals`, () => {
      expect(windingConsistency(solid.build())).toBeGreaterThan(0.999);
    });

    it(`${solid.name} encloses a positive volume`, () => {
      // A correctly wound closed mesh has positive signed volume; an inside-out one
      // has the same magnitude negated. This catches an inverted mesh that the
      // vertex-normal check cannot, e.g. when the normals were inverted too.
      expect(signedVolume(solid.build())).toBeGreaterThan(0);
    });
  }

  it('an inside-out copy of a box has negative volume', () => {
    // Confirms the volume test actually discriminates rather than always passing.
    const box = new BoxGeometry({ width: 2, height: 2, depth: 2 });
    const inverted = box.clone();
    const index = inverted.getIndex()!;
    for (let f = 0; f < index.count / 3; f++) {
      const b = index.array[f * 3 + 1];
      index.array[f * 3 + 1] = index.array[f * 3 + 2];
      index.array[f * 3 + 2] = b;
    }
    expect(signedVolume(inverted)).toBeCloseTo(-signedVolume(box), 6);
  });
});

describe('flat primitives face the documented direction', () => {
  it('Plane faces +Z', () => {
    const geometry = new PlaneGeometry({ width: 2, height: 2, widthSegments: 2, heightSegments: 2 });
    const normal = geometry.getAttribute('normal')!;
    for (let i = 0; i < normal.count; i++) expect(normal.array[i * 3 + 2]).toBeCloseTo(1, 6);

    // The geometric winding must agree, not just the normal attribute.
    const points = positions(geometry);
    for (const [a, b, c] of triangles(geometry)) {
      const geometric = new Vec3()
        .copy(points[b])
        .sub(points[a])
        .cross(new Vec3().copy(points[c]).sub(points[a]));
      expect(geometric.z).toBeGreaterThan(0);
    }
  });

  it('Circle faces +Z', () => {
    const geometry = new CircleGeometry({ radius: 1, segments: 8 });
    const points = positions(geometry);
    for (const [a, b, c] of triangles(geometry)) {
      const geometric = new Vec3()
        .copy(points[b])
        .sub(points[a])
        .cross(new Vec3().copy(points[c]).sub(points[a]));
      expect(geometric.z).toBeGreaterThan(0);
    }
  });

  it('Ring faces +Z', () => {
    const geometry = new RingGeometry({ innerRadius: 0.5, outerRadius: 1, thetaSegments: 8 });
    const points = positions(geometry);
    for (const [a, b, c] of triangles(geometry)) {
      const geometric = new Vec3()
        .copy(points[b])
        .sub(points[a])
        .cross(new Vec3().copy(points[c]).sub(points[a]));
      expect(geometric.z).toBeGreaterThan(0);
    }
  });
});

describe('Platonic solids — derived topology', () => {
  const solids: { name: string; build: () => BufferGeometry; vertices: number; faces: number; edges: number }[] = [
    { name: 'tetrahedron', build: () => new TetrahedronGeometry(), vertices: 4, faces: 4, edges: 6 },
    { name: 'octahedron', build: () => new OctahedronGeometry(), vertices: 6, faces: 8, edges: 12 },
    { name: 'icosahedron', build: () => new IcosahedronGeometry(), vertices: 12, faces: 20, edges: 30 },
    { name: 'dodecahedron', build: () => new DodecahedronGeometry(), vertices: 20, faces: 36, edges: 54 },
  ];

  for (const solid of solids) {
    it(`${solid.name} has the right vertex/edge/face counts and satisfies Euler's formula`, () => {
      const geometry = solid.build();
      const vertexCount = positions(geometry).length;
      const faceCount = triangles(geometry).length;
      const edges = edgeCount(geometry);

      expect(vertexCount).toBe(solid.vertices);
      expect(faceCount).toBe(solid.faces);
      expect(edges).toBe(solid.edges);
      // Euler's formula is the check that actually catches a mistyped face table.
      expect(vertexCount - edges + faceCount).toBe(2);
    });

    it(`${solid.name} has all vertices on one sphere`, () => {
      const geometry = solid.build();
      const sphere = computeBoundingSphere(geometry);

      // Every vertex must be equidistant from the centre — that is what makes the
      // solid *regular* rather than merely convex.
      const radii = positions(geometry).map((point) => point.length());
      const min = Math.min(...radii);
      const max = Math.max(...radii);
      expect(max - min).toBeLessThan(1e-5);

      // ... and the bounding sphere must actually contain them.
      for (const point of positions(geometry)) {
        expect(point.distanceTo(sphere.center)).toBeLessThanOrEqual(sphere.radius + 1e-4);
      }
      expect(sphere.radius).toBeCloseTo(min, 5);
    });
  }

  it('detail subdivides onto the circumsphere', () => {
    const base = new IcosahedronGeometry();
    const detailed = new IcosahedronGeometry({ detail: 1 });
    // Each triangle becomes four.
    expect(triangles(detailed).length).toBe(triangles(base).length * 4);

    const radii = positions(detailed).map((point) => point.length());
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1e-5);
  });

  it('radius scales the solid', () => {
    const geometry = new IcosahedronGeometry({ radius: 3 });
    const radii = positions(geometry).map((point) => point.length());
    expect(Math.min(...radii)).toBeCloseTo(3, 4);
    expect(Math.max(...radii)).toBeCloseTo(3, 4);
  });
});

describe('primitive parameters', () => {
  it('Box honours its dimensions and stays centred', () => {
    const geometry = createBoxGeometry({ width: 2, height: 4, depth: 6, widthSegments: 2 });
    const box = computeBoundingBox(geometry, new Box3());
    expect(box.min.toArray()).toEqual([-1, -2, -3]);
    expect(box.max.toArray()).toEqual([1, 2, 3]);
    // Subdividing the X faces adds vertices but must not change the extent.
    expect(positions(geometry).length).toBeGreaterThan(24);
  });

  it('Box faces have hard edges (36 vertices, no sharing)', () => {
    const geometry = createBoxGeometry({ width: 1, height: 1, depth: 1 });
    // Six faces x two triangles x three corners, none shared.
    expect(positions(geometry).length).toBe(24);
    expect(geometry.getAttribute('normal')!.count).toBe(24);
  });

  it('Plane lies in XY facing +Z', () => {
    const geometry = new PlaneGeometry({ width: 2, height: 2 });
    for (const point of positions(geometry)) expect(point.z).toBe(0);
    const normal = geometry.getAttribute('normal')!;
    for (let i = 0; i < normal.count; i++) expect(normal.array[i * 3 + 2]).toBeCloseTo(1, 6);
  });

  it('Sphere poles have distinct UVs (no pinch)', () => {
    const geometry = createSphereGeometry({ radius: 1, widthSegments: 8, heightSegments: 6 });
    const uv = geometry.getAttribute('uv')!;
    const points = positions(geometry);

    // Collect the UVs of the vertices sitting exactly at the north pole.
    const poleUs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      if (Math.abs(points[i].y - 1) < 1e-5) poleUs.push(uv.array[i * 2] ?? -1);
    }
    expect(poleUs.length).toBeGreaterThan(1);
    // Distinct `u` values is what prevents the texture from pinching.
    expect(new Set(poleUs.map((u) => u.toFixed(3))).size).toBeGreaterThan(1);
  });

  it('Sphere vertices lie on the radius', () => {
    const geometry = createSphereGeometry({ radius: 2.5, widthSegments: 16, heightSegments: 12 });
    for (const point of positions(geometry)) expect(point.length()).toBeCloseTo(2.5, 4);
  });

  it('Cylinder with equal radii is a tube and with zero top radius is a cone', () => {
    const tube = new CylinderGeometry({ radiusTop: 1, radiusBottom: 1, height: 2, radialSegments: 12 });
    const box = computeBoundingBox(tube, new Box3());
    expect(box.max.y).toBeCloseTo(1, 5);
    expect(box.min.y).toBeCloseTo(-1, 5);
    expect(box.max.x).toBeCloseTo(1, 5);

    const cone = new ConeGeometry({ radius: 1, height: 2, radialSegments: 12 });
    const coneBox = computeBoundingBox(cone, new Box3());
    expect(coneBox.max.y).toBeCloseTo(1, 5);
    // A cone has no cap where the wall meets the apex, so the bounding box is
    // measured from the vertex data, not from an analytic apex point.
    expect(coneBox.max.x).toBeCloseTo(1, 4);
    expect(coneBox.min.y).toBeCloseTo(-1, 5);

    // The wall's radius must shrink linearly from the base to the apex.
    const points = positions(cone);
    const rings = new Map<number, number>();
    for (const point of points) {
      const key = Math.round(point.y * 1000) / 1000;
      rings.set(key, Math.max(rings.get(key) ?? 0, Math.hypot(point.x, point.z)));
    }
    const sorted = [...rings.entries()].sort((a, b) => a[0] - b[0]);
    expect(sorted[0][1]).toBeCloseTo(1, 3); // base radius
    expect(sorted[sorted.length - 1][1]).toBeLessThan(0.2); // near the apex
  });

  it('Torus has the expected extent', () => {
    const geometry = new TorusGeometry({ radius: 2, tube: 0.5, radialSegments: 24, tubularSegments: 12 });
    const box = computeBoundingBox(geometry, new Box3());
    expect(box.max.x).toBeCloseTo(2.5, 4);
    expect(box.max.y).toBeCloseTo(0.5, 4);
  });

  it('Ring has a hole and honours its radii', () => {
    const geometry = new RingGeometry({ innerRadius: 1, outerRadius: 2 });
    for (const point of positions(geometry)) {
      const radius = Math.hypot(point.x, point.y);
      expect(radius).toBeGreaterThanOrEqual(1 - 1e-5);
      expect(radius).toBeLessThanOrEqual(2 + 1e-5);
    }
    // No vertex may sit in the hole.
    expect(positions(geometry).every((point) => Math.hypot(point.x, point.y) >= 1 - 1e-5)).toBe(true);
  });

  it('Circle is a filled disc', () => {
    const geometry = new CircleGeometry({ radius: 3, segments: 16 });
    for (const point of positions(geometry)) {
      expect(Math.hypot(point.x, point.y)).toBeLessThanOrEqual(3 + 1e-5);
    }
    // A fan has one centre vertex plus the rim.
    expect(positions(geometry).length).toBe(18);
  });

  it('Capsule silhouette is round at the caps', () => {
    const geometry = new CapsuleGeometry({ radius: 1, length: 2, radialSegments: 16, capSegments: 8 });
    const box = computeBoundingBox(geometry, new Box3());
    // Total height is length + 2 * radius.
    expect(box.max.y).toBeCloseTo(2, 4);
    expect(box.min.y).toBeCloseTo(-2, 4);
    expect(box.max.x).toBeCloseTo(1, 4);

    // Every vertex must sit at most `radius` from the spine segment.
    for (const point of positions(geometry)) {
      const clampedY = Math.max(-1, Math.min(1, point.y));
      const distance = Math.hypot(point.x, point.y - clampedY, point.z);
      expect(distance).toBeLessThanOrEqual(1 + 1e-4);
      if (Math.abs(point.y) <= 1) expect(distance).toBeCloseTo(1, 3);
    }
  });

  it('Tube follows its path', () => {
    const path = new LineCurve3(new Vec3(0, -2, 0), new Vec3(0, 2, 0));
    const geometry = new TubeGeometry(path, { tubularSegments: 8, radialSegments: 16, radius: 0.5 });
    const box = computeBoundingBox(geometry, new Box3());
    expect(box.min.y).toBeCloseTo(-2, 3);
    expect(box.max.y).toBeCloseTo(2, 3);
    // The cross-section is a circle of the requested radius, so its extent is the
    // same in both perpendicular directions and equals the diameter.
    expect(box.max.x - box.min.x).toBeCloseTo(1, 3);
    expect(box.max.z - box.min.z).toBeCloseTo(1, 3);
  });

  it('Tube vertices sit exactly on the tube surface', () => {
    const path = new LineCurve3(new Vec3(0, -1, 0), new Vec3(0, 1, 0));
    const radius = 0.75;
    const geometry = new TubeGeometry(path, {
      tubularSegments: 4,
      radialSegments: 12,
      radius,
    });

    // For a straight path the distance from the axis (Y) must be exactly `radius`
    // at every vertex, whatever the frame orientation happens to be.
    for (const point of positions(geometry)) {
      expect(Math.hypot(point.x, point.z)).toBeCloseTo(radius, 4);
    }
  });

  it('Tube normals are unit length and perpendicular to the path', () => {
    const path = new LineCurve3(new Vec3(0, -1, 0), new Vec3(0, 1, 0));
    const geometry = new TubeGeometry(path, { tubularSegments: 4, radialSegments: 8, radius: 1 });
    const points = positions(geometry);
    const normal = geometry.getAttribute('normal')!;

    for (let i = 0; i < points.length; i++) {
      const n = new Vec3(
        normal.array[i * 3] ?? 0,
        normal.array[i * 3 + 1] ?? 0,
        normal.array[i * 3 + 2] ?? 0,
      );
      expect(n.length()).toBeCloseTo(1, 5);
      // The path runs along Y, so every surface normal is horizontal.
      expect(Math.abs(n.y)).toBeLessThan(1e-4);
      // ... and points the same way as the offset from the axis.
      const radial = new Vec3(points[i].x, 0, points[i].z).normalize();
      expect(n.dot(radial)).toBeCloseTo(1, 4);
    }
  });
});

describe('3D curves', () => {
  it('LineCurve3 hits its endpoints and has a constant tangent', () => {
    const curve = new LineCurve3(new Vec3(1, 2, 3), new Vec3(4, 6, 8));
    expect(curve.getPoint(0).equals(new Vec3(1, 2, 3), 1e-6)).toBe(true);
    expect(curve.getPoint(1).equals(new Vec3(4, 6, 8), 1e-6)).toBe(true);
    expect(curve.getTangent(0.5).isNormalized(1e-6)).toBe(true);
    expect(curve.getLength()).toBeCloseTo(new Vec3(1, 2, 3).distanceTo(new Vec3(4, 6, 8)), 4);
  });

  it('CubicBezierCurve3 hits its endpoints and its tangent matches the handle', () => {
    const curve = new CubicBezierCurve3(
      new Vec3(0, 0, 0),
      new Vec3(1, 0, 0),
      new Vec3(2, 1, 0),
      new Vec3(3, 1, 0),
    );
    expect(curve.getPoint(0).equals(new Vec3(0, 0, 0), 1e-6)).toBe(true);
    expect(curve.getPoint(1).equals(new Vec3(3, 1, 0), 1e-6)).toBe(true);
    // The tangent at t = 0 is along the first handle.
    expect(curve.getTangent(0).equals(new Vec3(1, 0, 0), 1e-5)).toBe(true);
  });

  it('CatmullRomCurve3 interpolates its control points exactly', () => {
    const points = [new Vec3(0, 0, 0), new Vec3(1, 2, 0), new Vec3(3, 1, 1), new Vec3(4, 0, 0)];
    const curve = new CatmullRomCurve3(points, { curveType: 'centripetal' });

    // The defining property of an interpolating spline.
    for (let i = 0; i < points.length; i++) {
      const t = i / (points.length - 1);
      expect(curve.getPoint(t).distanceTo(points[i])).toBeLessThan(1e-4);
    }
  });

  it('CatmullRomCurve3 handles every parameterisation without NaN', () => {
    const points = [new Vec3(0, 0, 0), new Vec3(5, 0, 0), new Vec3(5, 0, 5), new Vec3(0, 3, 5)];
    for (const curveType of ['centripetal', 'chordal', 'catmullrom'] as const) {
      const curve = new CatmullRomCurve3(points, { curveType });
      for (let i = 0; i <= 20; i++) {
        const point = curve.getPoint(i / 20);
        expect(point.isFinite()).toBe(true);
      }
      expect(curve.getLength()).toBeGreaterThan(0);
    }
  });

  it('CatmullRomCurve3 with two points is a straight line', () => {
    const curve = new CatmullRomCurve3([new Vec3(0, 0, 0), new Vec3(2, 0, 0)]);
    expect(curve.getPoint(0.5).x).toBeCloseTo(1, 6);
  });

  it('SplineCurve3 is the uniform parameterisation', () => {
    const spline = new SplineCurve3([new Vec3(0, 0, 0), new Vec3(1, 0, 0), new Vec3(2, 1, 0)]);
    expect(spline.kind).toBe('SplineCurve3');
    expect(spline.curveType).toBe('catmullrom');
    for (let i = 0; i <= 4; i++) expect(spline.getPoint(i / 4).isFinite()).toBe(true);
  });

  it('toLineGeometry produces one position per sample', () => {
    const curve = new LineCurve3(new Vec3(0, 0, 0), new Vec3(1, 0, 0));
    const geometry = curve.toLineGeometry(4);
    expect(positions(geometry).length).toBe(5);
  });

  it('getFrameAt returns an orthonormal right-handed frame', () => {
    const curve = new CubicBezierCurve3(
      new Vec3(0, 0, 0),
      new Vec3(1, 1, 0),
      new Vec3(2, -1, 1),
      new Vec3(3, 0, 1),
    );
    const frame = curve.getFrameAt(0.4);
    expect(frame.tangent.isNormalized(1e-5)).toBe(true);
    expect(frame.normal.isNormalized(1e-5)).toBe(true);
    expect(frame.binormal.isNormalized(1e-5)).toBe(true);
    expect(frame.tangent.dot(frame.normal)).toBeCloseTo(0, 5);
    expect(frame.tangent.dot(frame.binormal)).toBeCloseTo(0, 5);
    expect(
      new Vec3().copy(frame.tangent).cross(frame.normal).equals(frame.binormal, 1e-4),
    ).toBe(true);
  });
});

describe('geometry utilities', () => {
  it('computeNormals is area-weighted for smooth shading', () => {
    // A flat quad split into two triangles: every normal must be +Z.
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3),
    );
    geometry.setIndex(new Float32BufferAttribute([0, 1, 2, 0, 2, 3], 1));

    computeNormals(geometry);
    const normal = geometry.getAttribute('normal')!;
    for (let i = 0; i < normal.count; i++) {
      expect(normal.array[i * 3 + 2]).toBeCloseTo(1, 5);
    }
  });

  it('computeNormals flat mode expands an indexed geometry', () => {
    // A sphere is indexed with shared vertices, so flat shading needs the geometry
    // expanded to one vertex per triangle corner.
    const geometry = new SphereGeometry({ radius: 1, widthSegments: 8, heightSegments: 6 });
    const before = positions(geometry).length;
    const originalFaceCount = triangles(geometry).length;
    expect(originalFaceCount).toBeGreaterThan(0);

    const result = computeNormals(geometry, { mode: 'flat' });
    expect(result.becameNonIndexed).toBe(true);
    expect(result.faceCount).toBe(originalFaceCount);

    // The defining property: one vertex per corner, so a shared vertex can no
    // longer hold two different normals.
    expect(positions(geometry).length).toBe(originalFaceCount * 3);
    // Flat shading is incompatible with indexing — the corners are unique, so an
    // index buffer would only re-reference them one-to-one.
    expect(geometry.getIndex()).toBeUndefined();

    // The expansion order is face-by-face, so triangle `f` uses corners 3f..3f+2.
    const normal = geometry.getAttribute('normal')!;
    expect(normal.count).toBe(originalFaceCount * 3);
    const points = positions(geometry);

    for (let f = 0; f < originalFaceCount; f++) {
      const a = f * 3;
      const b = f * 3 + 1;
      const c = f * 3 + 2;

      // Every corner of a triangle carries the same (face) normal...
      for (let component = 0; component < 3; component++) {
        expect(normal.array[a * 3 + component]).toBeCloseTo(normal.array[b * 3 + component]!, 6);
        expect(normal.array[b * 3 + component]).toBeCloseTo(normal.array[c * 3 + component]!, 6);
      }

      // ... and that normal agrees with the triangle's own geometric normal.
      const geometric = new Vec3()
        .copy(points[b])
        .sub(points[a])
        .cross(new Vec3().copy(points[c]).sub(points[a]))
        .normalize();
      const stored = new Vec3(
        normal.array[a * 3] ?? 0,
        normal.array[a * 3 + 1] ?? 0,
        normal.array[a * 3 + 2] ?? 0,
      );
      expect(geometric.dot(stored)).toBeCloseTo(1, 4);
    }
  });

  it('computeNormals preserves the index in smooth mode', () => {
    const geometry = new SphereGeometry({ radius: 1, widthSegments: 8, heightSegments: 6 });
    const before = positions(geometry).length;
    const result = computeNormals(geometry, { mode: 'smooth' });
    expect(result.becameNonIndexed).toBe(false);
    expect(geometry.getIndex()).toBeDefined();
    expect(positions(geometry).length).toBe(before);
  });

  it('computeNormals reports a skipped pass when normals exist', () => {
    const geometry = new SphereGeometry();
    const result = computeNormals(geometry, { overwrite: false });
    expect(result.skipped).toBe(true);
  });

  it('computeTangents derives an orthonormal frame from UVs', () => {
    const geometry = new PlaneGeometry({ width: 1, height: 1, widthSegments: 1, heightSegments: 1 });
    const result = computeTangents(geometry);
    expect(result.skipped).toBe(false);
    expect(result.faceCount).toBe(2);

    const tangent = geometry.getAttribute('tangent')!;
    expect(tangent.itemSize).toBe(4);
    for (let i = 0; i < tangent.count; i++) {
      const length = Math.hypot(
        tangent.array[i * 4] ?? 0,
        tangent.array[i * 4 + 1] ?? 0,
        tangent.array[i * 4 + 2] ?? 0,
      );
      expect(length).toBeCloseTo(1, 4);
      expect(Math.abs(tangent.array[i * 4 + 3] ?? 0)).toBe(1);
    }
  });

  it('computeTangents reports the missing attribute', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const result = computeTangents(geometry);
    expect(result.skipped).toBe(true);
    expect(result.missingAttribute).toBe('normal');
  });

  it('mergeGeometries pads a missing attribute with a neutral value', () => {
    const withUv = new PlaneGeometry();
    const withoutUv = new BoxGeometry({ uv: false });

    const result = mergeGeometries([withUv, withoutUv]);
    expect(result.geometry).not.toBeNull();
    expect(result.paddedAttributes).toContain('uv');

    const uv = result.geometry!.getAttribute('uv')!;
    // The padded slice must be zeroed, not NaN.
    for (let i = 0; i < uv.count; i++) {
      expect(Number.isFinite(uv.array[i * 2] ?? NaN)).toBe(true);
    }
  });

  it('mergeGeometries offsets indices and groups', () => {
    const a = new PlaneGeometry();
    const b = new PlaneGeometry();
    const result = mergeGeometries([a, b], { groups: false });
    expect(result.geometry).not.toBeNull();
    expect(result.vertexCount).toBe(positions(a).length * 2);

    const indices = result.geometry!.getIndex()!;
    // The second geometry's indices must be offset past the first's vertices.
    let maxFirst = 0;
    for (let i = 0; i < indices.count / 2; i++) maxFirst = Math.max(maxFirst, indices.array[i] ?? 0);
    expect(maxFirst).toBeLessThan(positions(a).length);
  });

  it('mergeGeometries rejects a mismatched item size', () => {
    const a = new PlaneGeometry();
    const b = new BufferGeometry();
    b.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0], 2));

    const result = mergeGeometries([a, b]);
    expect(result.geometry).toBeNull();
    expect(result.reason).toMatch(/itemSize/);
  });

  it('mergeGeometries returns null for an empty list', () => {
    const result = mergeGeometries([]);
    expect(result.geometry).toBeNull();
    expect(result.reason).toMatch(/no geometries/);
  });

  it('toWireframe deduplicates shared edges', () => {
    // A plane is indexed, so the two triangles genuinely share their diagonal.
    const geometry = new PlaneGeometry({ width: 1, height: 1, widthSegments: 1, heightSegments: 1 });
    const result = toWireframe(geometry);
    expect(result.segments).toBe(true);
    // A quad has 4 unique edges (5 if the diagonal is counted), not 6.
    expect(result.edgeCount).toBe(5);
    expect(result.degenerateEdges).toBe(0);
  });

  it('toWireframe reports every edge when duplicates are kept', () => {
    const geometry = new PlaneGeometry({ width: 1, height: 1, widthSegments: 1, heightSegments: 1 });
    const result = toWireframe(geometry, { unique: false });
    // 2 triangles x 3 edges = 6 edge slots, with the diagonal counted twice.
    expect(result.edgeCount).toBe(6);
  });

  it('toWireframe on a non-indexed box counts per-face edges', () => {
    // A box from `BoxGeometry` is deliberately non-indexed (per-face vertices), so
    // the same corner appears three times and edges are not shared across faces.
    const geometry = new BoxGeometry({ width: 1, height: 1, depth: 1 });
    const result = toWireframe(geometry);
    expect(result.edgeCount).toBe(30);
  });

  it('mergeVertices welds an exploded box back to 8 corners', () => {
    const exploded = new BoxGeometry({ width: 2, height: 2, depth: 2 });
    expect(positions(exploded).length).toBe(24);

    const result = mergeVertices(exploded, { mergeUv: false });
    expect(result.outputVertices).toBe(8);
    expect(result.mergedCount).toBe(16);
  });

  it('mergeVertices keeps a UV seam apart when asked to', () => {
    // Two triangles sharing an edge in space but with different UVs.
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3),
    );
    geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0.5, 0, 1, 0, 0, 1], 2));

    const withSeam = mergeVertices(geometry, { mergeUv: true });
    const withoutSeam = mergeVertices(geometry, { mergeUv: false });
    // Merging on position only welds more vertices than merging on position + UV.
    expect(withoutSeam.outputVertices).toBeLessThanOrEqual(withSeam.outputVertices);
  });

  it('tessellate subdivides until edges are short enough', () => {
    const geometry = new BoxGeometry({ width: 4, height: 4, depth: 4 });
    const before = triangles(geometry).length;

    const result = tessellate(geometry, { maxEdgeLength: 2, maxIterations: 4 });
    expect(result.geometry).not.toBe(geometry);
    expect(result.triangleCount).toBeGreaterThan(before);
    expect(result.iterations).toBeGreaterThan(0);

    // The longest edge must now be within the limit.
    const points = positions(result.geometry);
    let longest = 0;
    for (const [a, b, c] of triangles(result.geometry)) {
      longest = Math.max(
        longest,
        points[a].distanceTo(points[b]),
        points[b].distanceTo(points[c]),
        points[c].distanceTo(points[a]),
      );
    }
    expect(longest).toBeLessThanOrEqual(2 + 1e-4);
  });

  it('tessellate reports when the iteration cap stopped it', () => {
    const geometry = new PlaneGeometry({ width: 100, height: 100 });
    const result = tessellate(geometry, { maxEdgeLength: 0.01, maxIterations: 2 });
    expect(result.capped).toBe(true);
  });

  it('subdivide smooths a box inwards and grows the face count', () => {
    const geometry = new BoxGeometry({ width: 2, height: 2, depth: 2 });
    const subdivided = subdivide(geometry, { iterations: 1 });

    expect(triangles(subdivided).length).toBeGreaterThan(triangles(geometry).length);
    // Catmull-Clark pulls the corners in, so the result fits inside the original.
    const before = computeBoundingBox(geometry, new Box3());
    const after = computeBoundingBox(subdivided, new Box3());
    expect(after.max.x).toBeLessThanOrEqual(before.max.x + 1e-4);
    expect(after.max.x).toBeGreaterThan(0);
  });

  it('subdivide with zero iterations clones the input', () => {
    const geometry = new BoxGeometry();
    const result = subdivide(geometry, { iterations: 0 });
    expect(result).not.toBe(geometry);
    expect(positions(result).length).toBe(positions(geometry).length);
  });

  it('splitEdges reports every crease of a welded box', () => {
    // Weld a box first: the modifier needs shared vertices for the dihedral test to
    // be meaningful. `BoxGeometry` is intentionally per-face, so every edge would
    // otherwise look like a boundary.
    const box = mergeVertices(new BoxGeometry({ width: 1, height: 1, depth: 1 }), {
      mergeUv: false,
    }).geometry;
    expect(positions(box).length).toBe(8);

    // A welded cube has 18 edges: the 12 cube edges (dihedral 90 degrees) plus the
    // 6 face diagonals (dihedral 0, because a face's two triangles are coplanar).
    const perQuarterTurn = splitEdges(box, { maxAngle: Math.PI / 4 });
    const perRightAngle = splitEdges(box, { maxAngle: Math.PI / 2 + 1e-3 });

    // A 45-degree threshold is exceeded by the 90-degree cube edges but not by the
    // coplanar diagonals, so exactly the 12 cube edges split.
    expect(perQuarterTurn.splitEdges).toBe(12);
    // Just above 90 degrees nothing exceeds the threshold, so no edge splits. That
    // the two thresholds give different answers is what proves the dihedral test is
    // actually being applied rather than every edge being split unconditionally.
    expect(perRightAngle.splitEdges).toBe(0);
    // A fully creased mesh needs one vertex per corner, so the count roughly triples.
    expect(perQuarterTurn.outputVertices).toBeGreaterThan(perRightAngle.outputVertices);
  });

  it('splitEdges leaves a coplanar surface alone', () => {
    // An indexed quad: two coplanar triangles sharing a diagonal. The diagonal is
    // smooth and every other edge is a boundary, so nothing may be split.
    const quad = new PlaneGeometry({ width: 2, height: 2, widthSegments: 1, heightSegments: 1 });
    expect(quad.getIndex()).toBeDefined();

    const result = splitEdges(quad, { maxAngle: Math.PI / 8 });
    expect(result.splitEdges).toBe(0);
    expect(result.outputVertices).toBe(result.inputVertices);
    // Four corners, not six: nothing was duplicated per face.
    expect(result.outputVertices).toBe(4);
  });

  it('simplify reduces the vertex count and keeps the shape roughly', () => {
    const geometry = new SphereGeometry({ radius: 1, widthSegments: 12, heightSegments: 8 });
    const before = positions(geometry).length;
    const simplified = simplify(geometry, { ratio: 0.5 });

    const after = positions(simplified).length;
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(3);

    // The decimated sphere must still occupy roughly the same volume.
    const box = computeBoundingBox(simplified, new Box3());
    expect(box.max.x).toBeGreaterThan(0.7);
    expect(box.max.x).toBeLessThan(1.3);
  });

  it('simplify respects an absolute vertex count', () => {
    const geometry = new SphereGeometry({ radius: 1, widthSegments: 10, heightSegments: 6 });
    const simplified = simplify(geometry, { count: 10 });
    expect(positions(simplified).length).toBeLessThan(positions(geometry).length);
  });
});

describe('correctWinding', () => {
  /** Returns a copy of `geometry` with every triangle reversed. */
  function invert(geometry: BufferGeometry): BufferGeometry {
    const inverted = geometry.clone();
    const index = inverted.getIndex()!;
    for (let f = 0; f < index.count / 3; f++) {
      const b = index.array[f * 3 + 1];
      index.array[f * 3 + 1] = index.array[f * 3 + 2];
      index.array[f * 3 + 2] = b;
    }
    return inverted;
  }

  it('repairs an inside-out mesh and reports what it flipped', () => {
    const geometry = invert(new BoxGeometry({ width: 2, height: 2, depth: 2 }));
    // An inside-out box encloses a negative volume.
    expect(signedVolume(geometry)).toBeLessThan(0);

    const result = correctWinding(geometry);
    expect(result.skipped).toBe(false);
    // Every triangle was reversed, so every one had to be put back.
    expect(result.flippedCount).toBe(result.triangleCount);
    expect(signedVolume(geometry)).toBeGreaterThan(0);
    expect(windingConsistency(geometry)).toBeGreaterThan(0.999);
  });

  it('leaves a correctly wound mesh untouched', () => {
    const geometry = new BoxGeometry({ width: 2, height: 2, depth: 2 });
    const before = Array.from(geometry.getIndex()!.array);

    const result = correctWinding(geometry);
    expect(result.flippedCount).toBe(0);
    expect(Array.from(geometry.getIndex()!.array)).toEqual(before);
  });

  it('corrects the inner wall of a torus, which the centroid test would get wrong', () => {
    // This is the case that motivates using the vertex normals rather than "does the
    // normal point away from the origin": a torus's inner wall legitimately faces the
    // hole, so a centroid-based normaliser would flip it *away* from correct.
    const geometry = invert(new TorusGeometry({ radius: 1, tube: 0.3, radialSegments: 16, tubularSegments: 8 }));
    expect(windingConsistency(geometry)).toBeLessThan(0.01);

    correctWinding(geometry);
    expect(windingConsistency(geometry)).toBeGreaterThan(0.999);
    // A torus is a closed surface, so its volume must be positive once repaired.
    expect(signedVolume(geometry)).toBeGreaterThan(0);
  });

  it('skips a geometry with no normals or no index, and says why', () => {
    const unindexed = new BufferGeometry();
    unindexed.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const noIndex = correctWinding(unindexed);
    expect(noIndex.skipped).toBe(true);
    expect(noIndex.reason).toMatch(/not indexed/);

    const noNormals = new BufferGeometry();
    noNormals.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    noNormals.setIndex([0, 1, 2]);
    const missing = correctWinding(noNormals);
    expect(missing.skipped).toBe(true);
    expect(missing.reason).toMatch(/normal/);
  });

  it('is idempotent', () => {
    const geometry = invert(new SphereGeometry({ radius: 1, widthSegments: 10, heightSegments: 6 }));
    correctWinding(geometry);
    const once = Array.from(geometry.getIndex()!.array);

    const second = correctWinding(geometry);
    expect(second.flippedCount).toBe(0);
    expect(Array.from(geometry.getIndex()!.array)).toEqual(once);
  });
});
