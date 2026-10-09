# Geometry

`BufferGeometry` and its attributes, the 2D curve/path/shape layer, and how to build a mesh from scratch when no generator exists.

## The geometry container

`BufferGeometry` is named typed arrays plus the metadata needed to draw them. It owns no
rendering API objects, which is why it is backend-agnostic.

```ts
import { BufferAttribute, BufferGeometry } from '@dxyl/graphics';

const geometry = new BufferGeometry({
  name: 'quad',
  attributes: { position: new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]), 3) },
  index: [0, 1, 2],
  groups: [{ start: 0, count: 3, materialIndex: 0 }],
  drawRange: { start: 0, count: 3 },
  userData: { source: 'generated' },
});
```

| Member | Meaning |
| --- | --- |
| `attributes` | `Record<string, AnyBufferAttribute>` — `position`, `normal`, `uv`, `tangent`, `color`, … |
| `index` | The index buffer, or `null` for non-indexed geometry |
| `groups` | Contiguous runs, each drawn with one material |
| `drawRange` | `{ start, count }`; `count` defaults to `Infinity` |
| `boundingBox` / `boundingSphere` | `null` until computed |
| `morphAttributes` | Per-target delta attributes |
| `id` | A **string**, inherited from `Disposable`, so it is a valid `Map` key for backend caches |

## Attributes

```ts
import { BufferAttribute, Float32BufferAttribute, Uint32BufferAttribute } from '@dxyl/graphics';

const position = new BufferAttribute(new Float32Array([...]), 3);
const uv = new BufferAttribute(new Float32Array([...]), 2);
const color = new BufferAttribute(new Uint8Array([...]), 4, /* normalized */ true);

geometry.setAttribute('position', position);
geometry.setAttribute('uv', uv);

geometry.getAttribute('position');        // AnyBufferAttribute | undefined
geometry.hasAttribute('uv');              // true
geometry.getAttributeNames();             // insertion order
geometry.deleteAttribute('uv');           // also disposes it
```

`BufferAttribute` exposes `array`, `itemSize`, `count`, `normalized`, `usage` and a `version`
counter that backends cache against. Accessors: `getX/getY/getZ/getW(i)`,
`setX/setY/setZ/setW(i, v)`, `setXYZ`, `setXYZW`, `getComponent(i, component)`,
`setComponent(i, component, value)`, `applyMat4(m, target?)`, `clone()`, `toJSON()`,
`dispose()`.

`setIndex` accepts a plain array (widened to `Uint32Array`) or a ready attribute:

```ts
geometry.setIndex([0, 1, 2, 0, 2, 3]);   // widened automatically
geometry.getIndex();                     // | undefined — note: undefined, not null
geometry.index;                          // | null
geometry.indexed;                        // boolean
```

## Building geometry by hand

`src/geometry/3d/` is a **placeholder** in this checkout — there is no `BoxGeometry`,
`SphereGeometry` or `PlaneGeometry`. Build the positions yourself; the container is the same one
a generator would fill.

```ts
import { BufferAttribute, BufferGeometry } from '@dxyl/graphics';

function makeCube(half: number): BufferGeometry {
  const corners: [number, number, number][] = [
    [-half, -half, -half], [half, -half, -half], [half, half, -half], [-half, half, -half],
    [-half, -half, half], [half, -half, half], [half, half, half], [-half, half, half],
  ];
  const quads: [number, number, number, number][] = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5],
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (const [a, b, c, d] of quads) {
    // Flat faces: duplicate the corners so each face carries its own normal.
    const normal = faceNormal(corners[a], corners[b], corners[c]);
    for (const corner of [a, b, c, a, c, d]) {
      indices.push(positions.length / 3);
      positions.push(...corners[corner]);
      normals.push(...normal);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
```

> **Note:** a non-indexed "soup" (three unique vertices per triangle) is the simplest way to get
> flat shading, because `computeVertexNormals` averages per **vertex**, so an indexed cube would
> be smooth-shaded and rounded at the corners.

## Normals, bounds and transforms

```ts
geometry.computeVertexNormals();   // replaces the `normal` attribute; smooth-shaded
geometry.normalizeNormals();       // normalise in place, without recomputing
geometry.computeTangents();        // requires index + position + normal + uv
geometry.computeBoundingBox();     // -> geometry.boundingBox
geometry.computeBoundingSphere();  // -> geometry.boundingSphere
geometry.applyMat4(matrix);        // transforms position, and normal by the inverse-transpose
```

`applyMat4` is the transform method — **not** `applyMatrix4`. It transforms `position` as a
point, `normal` by the inverse-transpose of the matrix, `tangent` as a direction with handedness
correction, and updates the cached bounds. Every other attribute is left alone, because there is
no way to know whether it holds a direction, a colour or an index.

`computeBoundingSphere`'s fit is the standard cheap one — the centre of the bounding box, and
the largest distance from that centre to any vertex. It never underestimates, so it is safe for
culling, but it can be up to ~15% larger than the minimal enclosing sphere.

## Combining geometries

```ts
const merged = new BufferGeometry().copy(base);
merged.merge(extra);        // throws when the attribute sets or itemSize do not match identically
merged.addGroup(start, count, materialIndex);
const expanded = merged.toNonIndexed();   // one vertex per index; no sharing
```

`merge` requires both geometries to be **both indexed or both non-indexed** and to expose the
same attribute names with the same `itemSize`. It offsets index values and group starts for you.

## Copies, serialisation and disposal

```ts
const clone = geometry.clone();               // deep-copies every attribute and the index
const json = geometry.toJSON();               // bounding volumes included
const restored = BufferGeometry.fromJSON(json);

geometry.dispose();                            // disposes every attribute and the index
```

`copy` and `clone` deep-copy, so two clones never share a GPU buffer. `dispose` is idempotent;
it releases each attribute once and clears the attribute map.

## The 2D layer

`src/geometry/2d/` is complete and is built around `Curve`, an abstract parametric curve.

```ts
import { CircleShape, Path, Polygon, RectShape, RoundedRectShape, Vec2 } from '@dxyl/graphics';

const path = new Path();
path.moveTo(0, 0).lineTo(4, 0).quadraticCurveTo(6, 2, 4, 4).closePath();
path.getPoints(24);            // 24 sampled Vec2 points
path.getLength();
path.getBoundingBox();         // { min, max }
path.toBufferGeometry(24);     // a `BufferGeometry` of the sampled points
```

| Class | Constructor |
| --- | --- |
| `LineCurve` | `(v1, v2)` |
| `QuadraticBezierCurve` | `(v0, v1, v2)` |
| `CubicBezierCurve` | `(v0, v1, v2, v3)` |
| `ArcCurve` | `(x, y, radius, startAngle, endAngle, clockwise)` |
| `EllipseCurve` | `(x, y, xRadius, yRadius, startAngle, endAngle, clockwise, rotation)` |
| `SplineCurve` | `(points)` |
| `Path` | `(points?)` — a list of curve segments |
| `Shape` | `(points?)` — a `Path` with holes and triangulation |
| `RectShape` | `(x, y, width, height)` |
| `CircleShape` | `(x, y, radius)` |
| `EllipseShape` | `(x, y, xRadius, yRadius, rotation)` |
| `RoundedRectShape` | `(x, y, width, height, radius)` |
| `Polygon` | `(points)` — with `area`, `centroid`, `containsPoint`, `triangulate` |
| `Polyline` | `(points)` — with `closestPoint`, `resample`, `simplify`, `smooth` |

`Shape.triangulate(divisions)` returns a `TriangulationResult`; `Triangulate.ts` exports the
primitives it is built from (`earClip`, `removeHoles`, `bridgeHole`, `pointInPolygon`), and
`Tessellate.ts` the flattening helpers (`tessellateCurve`, `tessellatePath`, `flatnessError`).

```ts
const badge = new RoundedRectShape(0, 0, 48, 20, 6);
const points = badge.getPoints(16);
const polygon = Polygon.fromPoints(points);
polygon.containsPoint(new Vec2(24, 10));   // true
polygon.triangulateIndices();              // index triples into `points`
```

## Picking against geometry

`Mesh.raycast` implements Möller–Trumbore against the local-space ray, so it handles instancing,
scaling and non-uniform parents:

```ts
mesh.raycast(
  { ray: { origin, direction }, near: 0, far: Infinity, layers: 1, params: { backfaceCulling: false } },
  intersects,   // hits are pushed here as { distance, point, object, faceIndex?, uv? }
);
```

There is no `Raycaster` class in this checkout — see [picking.md](picking.md) for the whole
picture.

## See also

- [../benchmarks/README.md](../../benchmarks/README.md) — `computeBoundingBox`,
  `computeVertexNormals` and `clone` costs.
- [performance.md](performance.md) — when to cache bounds and when to weld vertices.
