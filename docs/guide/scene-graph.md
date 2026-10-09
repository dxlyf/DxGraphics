# Scene graph

Nodes, local and world transforms, traversal, and reparenting without moving anything.

The library has **two** scene graphs, and picking the right one is the first decision:

| | `Node` — `src/core/Node.ts` | `Object3D` — `src/scene/3d/Object3D.ts` |
| --- | --- | --- |
| Purpose | Backend-agnostic graph | 3D scene graph |
| Rotation input | `transform` (`Transform` holds `position`/`rotation`/`quaternion`/`scale`) | `position`/`rotation`/`quaternion`/`scale` directly |
| `layers` | a `Layers` **object** | a **number** bitmask |
| `add` returns | the first added child | `this` |
| `getWorldDirection` | `−Z` (a camera's forward) | `+Z` (a billboard's forward) |
| Event payloads | tuples: `on('added', (parent, child) => …)` | objects: `on('added', ({ parent }) => …)` |
| `lookAt` | always looks down `−Z` | `−Z` for cameras, `+Z` for everything else |

Both use the same maths: **column-major matrices, column vectors**, so composing is
`world = parentWorld * local`. See [math-conventions.md](math-conventions.md).

## Building a graph with `Object3D`

```ts
import { Group3D, Object3D, Scene3D, Vec3 } from '@dxyl/graphics';

const scene = new Scene3D({ background: '#11151d' });

const rig = new Group3D({ name: 'rig' });
rig.position.set(0, 5, 0);
scene.add(rig);

const arm = new Object3D({ name: 'arm' });
arm.position.set(0, 0, -3);
arm.rotation.set(0, 0, Math.PI / 4);
rig.add(arm);

scene.updateMatrixWorld(true);

arm.getWorldPosition().toArray();  // resolved through rig's transform
arm.parent;                        // the rig
scene.getObjectByName('arm');      // depth-first search
```

`Object3D.add` returns `this`, so it chains; `Node.add` returns the child, which is why
`const child = parent.add(new Node())` works there. Both reparent automatically and both refuse
to create a cycle.

Constructor options are accepted by every node:

```ts
new Object3D({
  name: 'part',
  position: { x: 0, y: 1, z: 0 },
  rotation: { x: 0, y: 0.5, z: 0, order: 'YXZ' },
  scale: { x: 1, y: 2, z: 1 },
  visible: true,
  renderOrder: 0,
  layers: 1,
  castShadow: true,
  receiveShadow: false,
  frustumCulled: true,
  matrixAutoUpdate: true,
  userData: { tag: 'leftHand' },
});
```

## Local versus world

```ts
scene.updateMatrixWorld(true);   // recompute the whole graph

arm.matrix;          // local TRS, cached
arm.matrixWorld;     // parentWorld * local, cached
arm.matrixDirty;     // true while the local matrix is stale

arm.localToWorld(new Vec3(1, 0, 0));
arm.worldToLocal(new Vec3(10, 0, 0));

arm.updateWorldMatrix(true, false);  // climb to the root, then recompute just this node
arm.markMatrixDirty();
```

`updateMatrixWorld(force)` recurses into children; `force` propagates even when this node did
not change. `matrixAutoUpdate = false` freezes the local matrix, which is what you want for a
static prop you have already baked.

> **Note:** `Object3D.updateMatrixWorld` recomputes **every** child unconditionally, so the cost
> is linear in the node count every frame. For a large static graph, set
> `matrixAutoUpdate = false` on the static subtrees. See [performance.md](performance.md).

## Traversal

```ts
scene.traverse((node) => { /* this node and every descendant, depth-first */ });
scene.traverseVisible((node) => { /* skips invisible subtrees */ });
arm.traverseAncestors((node) => { /* this node's parents, nearest first */ });

arm.isDescendantOf(rig);   // true
rig.isAncestorOf(arm);     // true
arm.countDescendants();    // 1 when arm is a leaf
scene.getObjectById(id);
scene.getObjectByProperty('userData.tag', 'leftHand');
```

`Node` adds `traverse`, `traverseVisible`, `traverseAncestors`, `findNodes(predicate, results)`,
`getNodeById`/`Name`/`ByProperty`, `getNodeCount()` and `getRoot()`.

## Reparenting without moving: `attach` and `detach`

The operation applications actually need — move a node to a new parent while keeping its world
position — is `attach`, which rewrites the local transform so the world matrix is unchanged:

```ts
// Before: `arm` is a child of `rig`, sitting at a world position the player can see.
const before = arm.getWorldPosition();

// Move it under `hand` without it jumping.
hand.attach(arm);
hand.updateMatrixWorld(true);

arm.getWorldPosition().equals(before, 1e-5); // still where it was
```

`detach(child)` is the inverse: it detaches while preserving the world transform. Both call
`updateWorldMatrix` and `applyMatrix4`, which decomposes back into position, quaternion and
scale — so a node under a **non-uniformly scaled** parent can lose a shear it was implicitly
carrying. Reparent across a non-uniform scale only when you know the graph is shear-free.

## Rotation: Euler, quaternion, and staying in sync

`Object3D` keeps the two representations in sync through change callbacks, so there is no
"which one wins" ambiguity:

```ts
arm.rotation.set(0, Math.PI / 2, 0, 'YXZ');  // updates the quaternion
arm.quaternion.setFromAxisAngle(Vec3.unitY(), Math.PI / 4);  // updates the Euler triple

arm.rotateOnAxis(Vec3.unitY(), 0.1);        // local-space axis
arm.rotateOnWorldAxis(Vec3.unitY(), 0.1);   // world-space axis (premultiplies)
arm.applyQuaternion(q);                     // world-space rotation
```

The **order** is part of the rotation's identity; `'XYZ'` composes as `Rx * Ry * Rz`. See
[math-conventions.md](math-conventions.md#euler-order-semantics).

## `lookAt`

```ts
camera.lookAt(new Vec3(0, 0, 0));    // cameras look down -Z
mesh.lookAt(new Object3D());          // other nodes look down +Z (billboard convention)
```

`Object3D.lookAt` accepts a vector-like, a `[x, y, z]` tuple, three numbers, or another
`Object3D`. It reads the **world** position, so the local rotation it computes is correct for a
parented node. The up vector is per-node (`node.up`), defaulting to `+Y`; when it is parallel to
the look direction a perpendicular axis is chosen automatically rather than producing `NaN`.

## Visibility, layers and culling

```ts
node.visible = false;        // hides the node AND its whole subtree
node.frustumCulled = false;  // skips the frustum test for this node
node.layers = 1 << 2;        // Object3D: a numeric bitmask (bit 0 is set by default)
node.layers.enable(Layer.Transparent);  // Node: a Layers object
```

`traverseVisible` skips hidden subtrees entirely, so hiding a group is cheaper than hiding its
members. `frustumCulled: false` is the correct setting for anything whose bounds do not
describe what it draws — a skydome, a full-screen quad, or a node whose geometry is generated
in a shader.

## Bounds and culling through `BoundingVolume`

```ts
import { BoundingVolume } from '@dxyl/graphics';

const volume = new BoundingVolume().setFromGeometry(geometry);
volume.update(mesh.matrixWorld);

if (camera.frustum.intersectsSphere(volume.sphere)) {
  // visible
}
```

`setFromGeometry` prefers a geometry's cached `boundingBox`/`boundingSphere` and only scans the
position attribute when neither exists, so calling `geometry.computeBoundingBox()` once after
building or deforming a geometry makes culling far cheaper. `update` transforms the local
volumes by the world matrix and scales the sphere radius by `getMaxScaleOnAxis()`, which stays
conservative under non-uniform scaling.

`Scene.computeBounds(force)` aggregates every child that exposes a `boundingVolume` into the
scene's own world bounds — useful for framing a camera on a loaded model.

## The 2D graph

`Node2D` is the flat-transform counterpart, with `x`/`y`/`rotation`/`scaleX`/`scaleY`/`skew`
and a `zIndex`:

```ts
import { Camera2D, Group2D, Node2D, Scene2D } from '@dxyl/graphics';

const scene2d = new Scene2D({ background: '#11151d' });
const layer = scene2d.addLayer('hud', 10);

const group = new Group2D({ name: 'panel', x: 40, y: 30, alpha: 0.9 });
layer.add(group);

const leaf = new Node2D({ name: 'row', x: 0, y: 24, zIndex: 2 });
group.add(leaf);

leaf.getBounds();        // local bounds `Rect`, or null
leaf.getWorldBounds();
leaf.containsPoint(new Vec2(12, 30), 2);   // tolerance in local units
leaf.hitTest(new Vec2(12, 30), { includeChildren: true });
```

`Node2D.render(painter)` is a no-op in this checkout: the 2D nodes describe themselves but do
not yet paint. Draw with a custom `Renderable2D` (see
[getting-started.md](getting-started.md#the-scene-contract)) or call `Shape2D.buildPath(painter)`
yourself, which does issue the path commands.

`Scene2D.addLayer(name, zIndex)` creates and indexes a `Layer2D`; `getLayer(name)` looks one up.
`Camera2D` adds `moveTo(x, y)`, `setRotation(radians)`, `rotateCamera(radians)`,
`setViewport(width, height)`, `screenToWorld`, `worldToScreen` and `containsWorldPoint`.

## Events

```ts
// Object3D: payloads are objects.
mesh.on('added', ({ parent }) => {});
mesh.on('childadded', ({ child }) => {});
mesh.on('change', () => {});           // the local transform changed
mesh.on('dispose', () => {});

// Node: payloads are tuples, and the event fires on the object that acted.
parent.on('added', (parentNode, childNode) => {});
child.on('matrixchanged', () => {});
child.on('worldmatrixchanged', () => {});
```

`on`/`once` return an **unsubscribe function**; `off(name, listener)` returns whether a listener
was removed. `EventDispatcher.dispatchEvent(name, detail?)` bubbles up `parent`, and
`onDispatch(name, listener)` registers a bubble-aware listener. See
[events.md](../architecture/events.md) for why there is one shared event map.

## Disposal

```ts
scene.dispose();   // releases listeners and detaches, depth-first, children before parents
```

`Node.dispose` walks the subtree and emits `'dispose'` on each node bottom-up, so a parent can
still read its children while releasing. It is idempotent, and `isDisposed` reports whether it
has run. `Object3D.dispose` releases listeners and detaches but **does not** dispose geometry or
materials, because two meshes may share them — the caller owns those.
