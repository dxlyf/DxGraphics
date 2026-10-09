# Math conventions

The conventions every other page assumes. **Read this before writing any maths**, because
four of the five decisions below are the opposite of a common alternative, and getting one
wrong produces geometry that is subtly mirrored, transposed or rotated about the wrong axis.

Every claim here is verified against `src/math/*.ts`; the file and member are named so you can
check.

## The five rules

| Rule | Convention | The common alternative it is *not* |
| --- | --- | --- |
| Storage | **Column-major**: `elements[column * 4 + row]` | Row-major |
| Application | **`v' = M * v`** — column vectors | `v' = v * M` — row vectors |
| Composition | **`world = parentWorld * local`** | `local * parentWorld` |
| Rotation handedness | **Right-handed**: `+X` → `+Y` about `+Z` | Left-handed / `+Y` → `+X` |
| Depth range | **`[-1, 1]`** (OpenGL), so `lookAt` builds a **view matrix** | `[0, 1]` (Vulkan/D3D) |

## 1. Column-major storage

`Mat4.elements` is a `Float32Array(16)`, ordered column by column. The element at logical
row `r`, column `c` is `elements[c * 4 + r]`:

```ts
import { Mat4 } from '@dxyl/graphics';

const m = new Mat4().makeTranslation(10, 20, 30);

// The translation is stored in column 3, i.e. indices 12..14.
m.elements[12]; // 10
m.elements[13]; // 20
m.elements[14]; // 30

// `getRow`/`getColumn` make the distinction explicit rather than index arithmetic.
m.getColumn(3).toArray(); // [10, 20, 30, 1]
m.getRow(0).toArray();    // [1, 0, 0, 10] — row 0 holds the x-axis basis and the x translation
```

Two consequences worth internalising:

- **`toArray()` is column-major**, and is what you upload. `gl.uniformMatrix4fv(location,
  false, m.elements)` needs no transpose — that is the whole point.
- **`toString()` prints rows**, for readability. Do not copy a number out of `toString()` and
  use it as an index into `elements`.

If you need a row-major array for serialisation or debug output, ask for it explicitly:

```ts
m.toRowMajorArray(); // 16 numbers, row by row
```

## 2. Column vectors: `v' = M * v`

A matrix acts on a point by multiplication on the **left**:

```ts
import { Mat4, Vec3 } from '@dxyl/graphics';

const translate = Mat4.fromTranslation(new Vec3(1, 2, 3));
const point = new Vec3(4, 5, 6);

point.applyMat4(translate); // [5, 7, 9]
```

`applyMat4` is the API for transforming a point. It also **performs the perspective divide** —
it multiplies every component by `1 / (e[3]x + e[7]y + e[11]z + e[15])`, guarded so a zero `w`
falls back to `1`. That means:

```ts
// Do NOT divide by w yourself after this call; it has already happened.
const ndc = worldPoint.clone().applyMat4(projection.multiply(view));
```

> **Note:** because `applyMat4` always divides, it is the right call for projecting a point and
> the wrong call for reading a raw homogeneous clip coordinate. If you need the undivided
> `w`, compute the dot product of the bottom row yourself:
>
> ```ts
> const e = viewProjection.elements;
> const w = e[3] * p.x + e[7] * p.y + e[11] * p.z + e[15];
> ```

Matrix products follow the same order:

```ts
const a = Mat4.fromTranslation(new Vec3(1, 0, 0));
const b = new Mat4().makeRotationZ(Math.PI / 2);

// `multiplyMatrices(into, left, right)` computes `left * right`.
const ab = new Mat4().multiplyMatrices(a, b); // a * b: rotate, then translate
const ba = new Mat4().multiplyMatrices(b, a); // b * a: translate, then rotate

// `multiply` and `premultiply` mutate in place:
const m = a.clone();
m.multiply(b);    // this = this * b
m.premultiply(b); // this = b * this
```

Because the identity `M * v` applies the **rightmost** factor first, a composed matrix reads
right-to-left in application order. `scale → rotate → translate` is therefore
`T * R * S`, which is exactly what `compose` builds.

## 3. Composition: `world = parentWorld * local`

The scene graph multiplies the parent's world matrix on the **left** of the child's local
matrix. `Object3D.updateMatrixWorld` does this literally:

```ts
this.matrixWorld.multiplyMatrices(this.parent === null ? IDENTITY : this.parent.matrixWorld, this.matrix);
```

So a child at local `(0, 2, 0)` under a parent at `(10, 0, 0)` ends up at world `(10, 2, 0)`:

```ts
import { Object3D } from '@dxyl/graphics';

const parent = new Object3D();
parent.position.set(10, 0, 0);
const child = new Object3D();
child.position.set(0, 2, 0);
parent.add(child);
parent.updateMatrixWorld(true);

child.getWorldPosition().toArray(); // [10, 2, 0]
```

The order is observable rather than cosmetic: with the parent also **rotated**,
`local * parentWorld` puts the child somewhere else entirely. Two pure translations commute and
would hide the bug, which is why any test of this rule should involve a rotation.

## 4. Right-handed rotations

`makeRotationX`, `makeRotationY` and `makeRotationZ` are **instance** methods (not statics) and
produce right-handed rotations. The axis mapping, verified against the matrices the source
writes:

| Method | Maps | And |
| --- | --- | --- |
| `makeRotationX(a)` | `+Y` → `+Z` | `+Z` → `−Y` |
| `makeRotationY(a)` | `+Z` → `+X` | `+X` → `−Z` |
| `makeRotationZ(a)` | **`+X` → `+Y`** | `+Y` → `−X` |

```ts
import { Mat4, Vec3 } from '@dxyl/graphics';

const quarterTurn = new Mat4().makeRotationZ(Math.PI / 2);
const rotated = new Vec3(1, 0, 0).applyMat4(quarterTurn);

rotated.toArray(); // approximately [0, 1, 0]
```

Reading the matrix confirms the column-major layout: `elements[0]` is the x component of
column 0, and column 0 is the image of the `+X` basis vector, i.e. `(cos, sin, 0)`.

```ts
const m = new Mat4().makeRotationZ(Math.PI / 2);
m.elements[0]; // cos(pi/2) ≈ 0
m.elements[1]; // sin(pi/2) = 1
```

> **Note:** these are instance methods. `Mat4.makeRotationZ(...)` is not a thing; the statics
> are `Mat4.identity()`, `Mat4.zero()`, `Mat4.of(...)`, `Mat4.fromArray`,
> `Mat4.fromTranslation`, `Mat4.fromScale`, `Mat4.fromAxisAngle`, `Mat4.fromEuler`,
> `Mat4.fromQuat`, `Mat4.fromCompose`, `Mat4.fromPerspective`, `Mat4.fromOrthographic`,
> `Mat4.fromLookAt` and `Mat4.fromBasis`.

`makeRotationAxis(axis, angle)` normalises the axis, so a non-unit axis is safe (it falls back
to the identity for a zero-length axis rather than producing `NaN`).

## 5. `lookAt` builds a **view** matrix

`Mat4.lookAt(eye, target, up)` produces the inverse of the camera's world matrix, not the
camera's world matrix. A camera at `+Z` looking at the origin therefore maps the origin to
`−Z`:

```ts
import { Mat4, Vec3 } from '@dxyl/graphics';

const view = Mat4.fromLookAt(new Vec3(0, 0, 5), new Vec3(0, 0, 0), new Vec3(0, 1, 0));
new Vec3(0, 0, 0).applyMat4(view).toArray(); // approximately [0, 0, -5]
```

The camera looks down its `−Z` axis, which is why the origin lands at negative `z` in view
space. `Camera` and `Camera3D` expose this matrix as **`matrixWorldInverse`** — the inverse of
`matrixWorld`, which `updateMatrixWorld` refreshes.

The degenerate case is handled rather than throwing: when `up` is parallel to the view
direction, a perpendicular axis is chosen automatically.

## `Vec2` and `Vec3`: the single-number constructor

`Vec2` and `Vec3` default **each** missing component to the value of the first argument:

```ts
new Vec3(3).toArray();   // [3, 3, 3]  — ALL components become 3
new Vec3(3, 4).toArray();// [3, 4, 4]  — z falls back to y
new Vec2(3).toArray();   // [3, 3]
```

This is documented on the constructors (`constructor(x = 0, y = x, z = x)`) and it is the
reason `Vec3(1)` is a valid "one" vector. It catches people out when they mean
`new Vec3(3, 0, 0)`:

```ts
new Vec3(3, 0, 0); // [3, 0, 0] — what you usually want
new Vec3(3);       // [3, 3, 3] — all components
Vec3.zero();       // [0, 0, 0]
Vec3.one();        // [1, 1, 1]
Vec3.unitX();      // [1, 0, 0]
```

`Vec4` is the exception: `constructor(x = 0, y = 0, z = 0, w = 1)`, so `new Vec4(1)` is
`[1, 0, 0, 1]` — the point, not a filled vector. That default is deliberate, because a
homogeneous **point** is the common case while a homogeneous **direction** needs `w = 0`.

## `Color`: 0..1 by constructor, 0..255 by `setRgb`

`Color` stores float channels in `0..1`. The constructor's numeric form is therefore **0..1
floats**, while `setRgb`/`fromRgb` are **0..255 bytes** and are **not clamped**:

```ts
import { Color } from '@dxyl/graphics';

new Color(1, 0.5, 0.25).toArray();      // [1, 0.5, 0.25, 1]  — 0..1 floats
new Color().setRgb(255, 128, 64).toArray(); // [1, 0.502, 0.251, 1] — divided by 255

Color.fromRgb(255, 128, 64).getHexString(); // '#ff8040'
new Color(1, 0.5, 0.25).getHexString();     // '#ff8040'
```

The byte path does not clamp, so values above `255` behave like HDR input:

```ts
new Color().setRgb(510, 0, 0).r; // 2 — not clamped to 1
```

`getRGB()` returns unrounded bytes, so `setRgb(...getRGB())` round-trips exactly.

### Strings, alpha and the colour-management flag

```ts
new Color('#336699').getHexString();   // '#336699'
new Color(0x336699).getHexString();    // '#336699'
new Color('rebeccapurple').getHexString();
new Color('rgba(0, 0, 0, 0.5)').a;     // 0.5 — alpha is parsed from the string
new Color({ r: 0.2, g: 0.4, b: 0.6 }); // 0..1 channels
```

`Color.managementEnabled` is a **static boolean, default `false`**. With it off, hex and CSS
input is stored verbatim and every round-trip is exact. With it on, stored channels become
linear light and `getHex`/`getStyle` re-encode; hex round-trips still hold to float precision.
The `colorSpace` field is metadata only — no method branches on it.

`getStyle()` returns `rgb(r, g, b)` for an opaque colour and `rgba(...)` otherwise;
`toCssString()` always returns `rgba(...)`, which is what an SVG or Canvas attribute wants.

## `Euler`: order semantics

`Euler(x, y, z, order)` stores radians and an order from
`'XYZ' | 'YXZ' | 'ZXY' | 'ZYX' | 'YZX' | 'XZY'` (the `EULER_ORDERS` array, default `'XYZ'`).

**The order lists the axes in the order they are applied**, and the composition is the
corresponding matrix product read left to right:

| `order` | Composed as | Meaning |
| --- | --- | --- |
| `'XYZ'` | `Rx * Ry * Rz` | rotate about X, then Y, then Z |
| `'YXZ'` | `Ry * Rx * Rz` | rotate about Y, then X, then Z |

Because matrices apply right-to-left to a column vector, `'XYZ'` means the **Z** rotation is
applied to the vector *first*, then Y, then X. Read the table as "the named axis is the
outermost transform, applied last to the point".

The implementation composes the three axis rotations rather than expanding a per-order closed
form, so it agrees exactly with `makeRotationX`/`Y`/`Z` instead of drifting from them.

```ts
import { Euler, Mat4, Quat } from '@dxyl/graphics';

const euler = new Euler(0, Math.PI / 2, 0, 'XYZ');

const matrix = new Mat4().makeRotationFromEuler(euler);  // or: euler.toMat4(new Mat4())
const quat = Quat.fromEuler(euler);                      // or: euler.toQuat(new Quat())

// The Euler triple and the quaternion agree.
quat.equals(Quat.fromRotationMatrix(matrix), 1e-5); // true
```

Two behaviours that matter in animation:

- **`order` is part of the identity.** `Euler(0, 1, 0, 'XYZ')` and `Euler(0, 1, 0, 'YXZ')` are
  different rotations. Compare with `euler.equals(other)` for the tuple and
  `euler.representsSameRotation(other)` for the rotation.
- **`Euler.toQuat`/`toMat4` take a target and return it**, so an animation loop can avoid
  allocating. Same for `Quat.toEuler(target, order?)`.

`Euler.setFromQuat(quat, order)` and `Euler.setFromRotationMatrix(m, order)` are the inverse
paths. `Euler.wrap()` folds angles into a canonical range without changing the rotation.

## `Quat`

`Quat(x = 0, y = 0, z = 0, w = 1)` — the identity by default. Radians throughout.

```ts
import { Quat, Vec3 } from '@dxyl/graphics';

const q = Quat.fromAxisAngle(new Vec3(0, 1, 0), Math.PI / 2);
new Vec3(0, 0, 1).applyQuat(q).toArray(); // approximately [1, 0, 0]

q.slerp(Quat.identity(), 0.5);       // mutate towards the identity
q.slerpQuaternions(a, b, 0.25);      // q = slerp(a, b, 0.25), no temporaries
q.multiply(other);                   // q = q * other
q.premultiply(other);                // q = other * q
```

`multiply`/`premultiply` are not commutative, and `premultiply` is the one that applies a
**world-space** rotation to an already-rotated object — which is what
`Object3D.rotateOnWorldAxis` uses.

`Object3D` keeps the quaternion authoritative and mirrors it into `rotation` (and back) through
change callbacks, so the two representations cannot drift. Assigning to `rotation.x` updates
the quaternion; assigning through `quaternion` updates the Euler triple.

## Primitives and intersections

| Type | Constructor | Notes |
| --- | --- | --- |
| `Box3` | `(min?, max?)` | `Box3.empty()` starts inverted so `expandByPoint` works. `isEmpty()` is the test, not `min > max`. |
| `Sphere` | `(center?, radius = -1)` | Radius `-1` means empty; `makeEmpty()` resets it. |
| `Plane` | `(normal?, constant = 0)` | `distanceToPoint` follows the sign convention `n·p + d`. |
| `Ray` | `(origin?, direction?)` | `intersectTriangle`, `intersectBox`, `intersectSphere`, `intersectPlane` all take an optional `target` and return `null` on a miss. |
| `Frustum` | `()` | Fill with `setFromProjectionMatrix(m)` or `Frustum.fromProjectionAndView(proj, view)`. Six planes in `FrustumPlane` order. |
| `Rect` | `(x?, y?, width?, height?)` | 2D, `x`/`y` is the top-left. |
| `Box2` | `(min?, max?)` | 2D bounds with `containsPoint`. |

```ts
import { Box3, Frustum, Mat4, Sphere, Vec3 } from '@dxyl/graphics';

const box = new Box3();
box.makeEmpty();
box.expandByPoint(new Vec3(1, 2, 3));
box.expandByPoint(new Vec3(-1, 0, 1));
box.getSize().toArray(); // [2, 2, 2]

const frustum = Frustum.fromProjectionAndView(projection, view);
frustum.intersectsBox(box);
frustum.intersectsSphere(new Sphere(new Vec3(0, 1, 1), 0.5));
```

`BoundingVolume` combines the local and world forms and is what culling should use, because it
picks up a geometry's cached volumes instead of rescanning vertices:

```ts
import { BoundingVolume } from '@dxyl/graphics';

const volume = new BoundingVolume().setFromGeometry(geometry).update(node.matrixWorld);
frustum.intersectsSphere(volume.sphere);
```

`update` scales the world sphere radius by `getMaxScaleOnAxis()`, which stays conservative
under non-uniform scaling.

## Precision

`EPSILON` is `1e-6` and is the default tolerance for every `equals`. Interpolation produces
tiny residuals, so `MathUtils.isPowerOfTwo`-style exact comparisons are avoided in favour of a
documented epsilon. `Mat4` stores `Float32Array`, so a value round-tripped through `elements`
carries float32 precision even though the arithmetic is `number` (float64).

```ts
import { EPSILON } from '@dxyl/graphics';

new Vec3(0.1 + 0.2, 0, 0).equals(new Vec3(0.3, 0, 0), 1e-9); // true
```

## A worked example

Everything above in one passable snippet — a model matrix, a look-at view matrix, a
projection, and a round trip:

```ts
import { Mat4, Quat, Vec3 } from '@dxyl/graphics';

// 1. Model: scale, then rotate, then translate — composed right to left as T * R * S.
const model = new Mat4().compose(
  new Vec3(0, 1, 0),                                  // translation
  Quat.fromAxisAngle(new Vec3(0, 1, 0), Math.PI / 4),  // rotation
  new Vec3(2, 2, 2),                                  // scale
);

// 2. View: `lookAt` already returns the inverse of the camera's world matrix.
const view = Mat4.fromLookAt(new Vec3(0, 2, 8), new Vec3(0, 0, 0), new Vec3(0, 1, 0));

// 3. Projection: right-handed, OpenGL depth range [-1, 1].
const projection = Mat4.fromPerspective((50 * Math.PI) / 180, 16 / 9, 0.1, 200);

// 4. A world-space point on the model's local +X axis.
const localCorner = new Vec3(1, 0, 0);
const worldCorner = localCorner.clone().applyMat4(model);

// 5. Project to NDC. `applyMat4` divides by w for you.
const viewProjection = new Mat4().multiplyMatrices(projection, view);
const ndc = worldCorner.clone().applyMat4(viewProjection);

// 6. Un-project. `inverse(projection) * world` maps NDC back to world space.
const unproject = new Mat4().multiplyMatrices(projection, view).invert();
const recovered = ndc.clone().applyMat4(unproject);

recovered.equals(worldCorner, 1e-4); // true
```

Step 6 is the one to be careful with: `inverse(projection * view)` is
`inverse(view) * inverse(projection)`, and because `applyMat4` divides by `w`, un-projecting
through it needs the *inverse* of the combined matrix rather than a pair of inverse matrices
multiplied the other way round.
