# Migration from three.js

The API is deliberately three.js-shaped, so most of a port is mechanical. This page is the
**differences** — the places where copying code over produces something that compiles and
behaves wrongly, which are the only ones worth reading about.

> **Note:** the migration examples below use APIs verified against `src/` at the time of writing:
> `src/materials/`, `src/geometry/3d/primitives/`, `src/picking/` and `src/animation/` have all
> landed. Some modules are still being stabilised; each section says so where it applies.

## What is the same

| three.js | here |
| --- | --- |
| `Scene`, `Object3D`, `Group`, `Mesh`, `Points`, `Line`, `LineSegments` | same names |
| `PerspectiveCamera`, `OrthographicCamera`, `Camera` | same names |
| `AmbientLight`, `DirectionalLight`, `PointLight`, `SpotLight`, `HemisphereLight`, `RectAreaLight` | same names |
| `BufferGeometry`, `BufferAttribute`, `Float32BufferAttribute` | same names |
| `MeshBasicMaterial`, `MeshLambertMaterial`, `MeshPhongMaterial`, `MeshStandardMaterial`, `MeshPhysicalMaterial`, `PointsMaterial`, `LineBasicMaterial`, `ShaderMaterial` | same names |
| `Vector2`/`Vector3`/`Vector4`/`Quaternion`/`Euler`/`Matrix4` | **`Vec2`/`Vec3`/`Vec4`/`Quat`/`Euler`/`Mat4`** |
| `Raycaster` | same name, plus five other picking strategies |
| `Clock`, `AnimationClip`, `AnimationMixer`, `AnimationAction`, `KeyframeTrack` | same names |
| `BoxGeometry`, `SphereGeometry`, `PlaneGeometry`, `CylinderGeometry`, `ConeGeometry`, `TorusGeometry`, `CapsuleGeometry`, `CircleGeometry`, `RingGeometry`, the polyhedra, `TubeGeometry` | same names, options-object constructors |

So `scene.add(mesh)`, `mesh.material`, `geometry.attributes.position`, `camera.position.set(...)`
and `mixer.clipAction(clip).play()` all port unchanged.

## The differences that bite

### 1. Class names: `Vec3`, `Quat`, `Mat4`

```ts
// three.js
const v = new THREE.Vector3(1, 2, 3);
const m = new THREE.Matrix4();

// here
const v = new Vec3(1, 2, 3);
const m = new Mat4();
```

`Euler` and `Color` keep their names, which makes a search-and-replace half-done and therefore
worse than none — check every `Vector` and `Matrix` by hand.

### 2. The single-number constructor fills every component

```ts
new Vec3(3).toArray();     // [3, 3, 3]  — ALL components, not [3, 0, 0]
new Vec3(3, 0, 0).toArray(); // [3, 0, 0]
```

three.js requires all three arguments, so `new Vector3(3)` is not something you would have
written — but `Vec3.from(3)` and `setScalar` are, and their meaning here is the same. The trap is
a ported helper that passes one argument. See
[math-conventions.md](math-conventions.md#vec2-and-vec3-the-single-number-constructor).

`Vec4` is the exception (`w` defaults to `1`, so `new Vec4(1)` is a point), which matches
three.js.

### 3. Matrix construction is instance-based, not static

```ts
// three.js
const m = new THREE.Matrix4().makeRotationZ(Math.PI / 2);

// here — the same, these are instance methods…
const m = new Mat4().makeRotationZ(Math.PI / 2);

// …and the static forms that do exist are named differently:
Mat4.fromTranslation(new Vec3(1, 2, 3));
Mat4.fromScale(new Vec3(2, 2, 2));
Mat4.fromAxisAngle(axis, angle);
Mat4.fromEuler(euler);
Mat4.fromQuat(quat);
Mat4.fromCompose(position, quaternion, scale);
Mat4.fromPerspective(fovY, aspect, near, far);
Mat4.fromOrthographic(left, right, top, bottom, near, far);
Mat4.fromLookAt(eye, target, up);
```

`Mat4.makeRotationZ(...)` as a **static** call is the mistake to watch for: it is an instance
method, so a ported `THREE.Matrix4.makeRotationZ(...)` becomes `new Mat4().makeRotationZ(...)`.

### 4. `applyMatrix4` is `applyMat4` on geometry, and it divides by `w` on a vector

```ts
// three.js
geometry.applyMatrix4(matrix);          // geometry
vector.applyMatrix4(matrix);            // vector
vector.applyMatrix4(camera.projectionMatrix);  // no perspective divide!
```

```ts
// here
geometry.applyMat4(matrix);             // geometry — note the name
vector.applyMat4(matrix);               // vector
vector.applyMat4(projection);           // DIVIDES BY w
```

Two changes in one. The geometry method is renamed, and **`Vec3.applyMat4` performs the
perspective divide**, where `Vector3.applyMatrix4` does not. A ported line that projects and then
divides by hand will divide twice and produce a wrong NDC.

If you need the undivided clip coordinate, compute the `w` yourself:

```ts
const e = viewProjection.elements;
const w = e[3] * p.x + e[7] * p.y + e[11] * p.z + e[15];
```

See [math-conventions.md](math-conventions.md#2-column-vectors-v--m--v).

### 5. `geometry.getIndex()` returns `undefined`, not `null`

```ts
// three.js
if (geometry.index === null) { /* non-indexed */ }

// here — the property is null, the getter is undefined
if (geometry.index === null) { /* property: null */ }
if (geometry.getIndex() === undefined) { /* getter: undefined */ }
```

The getter returns `undefined` so it satisfies the optional `BoundsSource.getIndex` contract
exactly. Checking `getIndex() === null` is always false, so an indexed path would run on
non-indexed geometry and read `undefined` out of the index buffer.

### 6. Layers are different types on the two scene graphs

```ts
// Object3D (3D): a NUMBER bitmask, like three.js
mesh.layers = 1 << 2;

// Node (core): a Layers OBJECT
node.layers.enable(Layer.Transparent);
node.layers.set(1 << 3);

// Node2D (2D): no layers; it uses zIndex
node2d.zIndex = 5;
```

On `Object3D`, `layers` is a plain number, so `mesh.layers.enable(...)` is a type error rather
than a silent no-op — which is the good outcome. On `Node` it is a `Layers` instance with
`enable`/`disable`/`test`/`mask`.

### 7. `getWorldDirection` points the other way on `Node`

```ts
object3d.getWorldDirection(target);   // +Z  — matches three.js
node.getWorldDirection(target);       // -Z  — the camera's forward
```

The core `Node` answers "which way does this camera look", while `Object3D` answers "which way
does this billboard face". If you port code that used a three.js `Object3D.getWorldDirection` for
a billboard, use the `Object3D` version.

### 8. `add()` returns different things

```ts
const child = parent.add(new Node());     // Node: the first added child
parent.add(child);                        // Object3D: returns `this`

// three.js also returns `this` for Object3D, so 3D code ports unchanged.
```

The `Node` variant exists so `const child = parent.add(new Node())` reads well; code ported from
three.js into the core graph may rely on chaining, which will not work there.

### 9. Events have two payload shapes

```ts
// Object3D — objects, like nothing in three.js (which has no node events)
mesh.on('added', ({ parent }) => {});

// Node — tuples, and the event fires on the ACTOR
parent.on('added', (parentNode, childNode) => {});
```

three.js has no per-node event system, so this is new code rather than a port. The thing to get
right is which object emits: `parent.add(child)` emits `'added'` **on the parent**, not the child.
See [../architecture/events.md](../architecture/events.md).

### 10. `on()` returns an unsubscribe function

```ts
// here
const off = emitter.on('change', handler);
off();                                  // unsubscribes
emitter.off('change', handler);          // equivalent, returns a boolean
```

three.js returns `this` from `addEventListener`. Chaining `emitter.on(a).on(b)` will not compile
here.

## Materials

> **Note:** `src/materials/` has landed with `Material`, `MeshBasicMaterial`,
> `MeshLambertMaterial`, `MeshPhongMaterial`, `MeshStandardMaterial`, `MeshPhysicalMaterial`,
> `ShaderMaterial`, `RawShaderMaterial`, `PointsMaterial`, `LineBasicMaterial`,
> `LineDashedMaterial`, `SpriteMaterial`, `ShadowMaterial`, `DepthMaterial`, `NormalMaterial` and
> `MaterialFactory`.

Most of the port is direct:

```ts
// three.js
const material = new THREE.MeshStandardMaterial({ color: 0x2f6fdf, roughness: 0.4, metalness: 0.05 });

// here — the same shape
const material = new MeshStandardMaterial({ color: 0x2f6fdf, roughness: 0.4, metalness: 0.05 });
```

Two things to check:

- **The parameter bag is `MaterialParameters`, typed `Record<string, unknown>`.** The constructor
  accepts any key, so an unknown parameter is a silent no-op rather than a compile error. The
  material's own fields are typed: `roughness`, `metalness`, `envMapIntensity` on `Standard`;
  `shininess`, `bumpScale`, `displacementScale`, `displacementBias` on `Phong`; `vertexColors`,
  `flatShading`, `wireframeLinewidth` on `Basic`.
- **Common state lives on the `Material` base**, with the same names and defaults three.js uses:
  `visible`, `transparent`, `opacity`, `side`, `wireframe`, `depthTest`, `depthWrite`,
  `depthFunc`, the stencil block, `blending`, `blendSrc`, `blendDst`, `blendEquation`,
  `premultipliedAlpha`, `alphaTest`, `alphaToCoverage`, `colorWrite`, the polygon-offset pair,
  `fog`, `toneMapped`, `clippingPlanes`, `clipShadows`, `shadowSide`.

Materials extend `Disposable`, so `material.dispose()` is the release path, and
`material.addDisposable(child)` is how a material owns a texture.

## Geometry generators

> **Note:** `src/geometry/3d/primitives/` has landed with `BoxGeometry`, `PlaneGeometry`,
> `SphereGeometry`, `CylinderGeometry`, `ConeGeometry`, `CapsuleGeometry`, `TorusGeometry`,
> `CircleGeometry`, `RingGeometry`, `TubeGeometry`, the four polyhedra, and a `GeometryBuilder`
> base.

The **constructors take an options object**, not positional arguments:

```ts
// three.js
new THREE.BoxGeometry(1, 2, 3, 4, 4, 4);

// here
new BoxGeometry({ width: 1, height: 2, depth: 3, widthSegments: 4, heightSegments: 4, depthSegments: 4 });
```

Every field is optional and defaults to the three.js default (`width`/`height`/`depth` = `1`,
segments = `1`). There is also a functional form, `createBoxGeometry(options)`, which returns a
plain `BufferGeometry` — useful when you want the data without the subclass.

Because the generators subclass `BufferGeometry`, everything else ports unchanged:
`geometry.attributes.position`, `geometry.getAttribute('uv')`, `geometry.dispose()`.

Also landed under `src/geometry/3d/`: the 3D curves (`CatmullRomCurve3`, `CubicBezierCurve3`,
`QuadraticBezierCurve3`, `LineCurve3`, `SplineCurve3`, `Curve3`) and the modifiers
(`EdgeSplitModifier`, `MergeModifier`, `SimplifyModifier`, `SubdivisionModifier`,
`TessellateModifier`).

## Renderers

The biggest structural difference: **there is no `WebGLRenderer` on the root export**, and there
is no `WebGPURenderer` at all.

```ts
// three.js
const renderer = new THREE.WebGLRenderer({ antialias: true });
document.body.appendChild(renderer.domElement);
renderer.setSize(w, h);
renderer.setAnimationLoop(frame);
renderer.render(scene, camera);

// here — Canvas2D on the root export
const renderer = new Canvas2DRenderer({ canvas, autoResize: true });
renderer.setAnimationLoop(frame, { autoStart: true });
renderer.render(scene, camera);

// or WebGL, from its own module
import { WebGLRenderer } from './renderer/webgl/WebGLRenderer';
const gl = new WebGLRenderer({ canvas, preferWebGL2: true });
```

Further differences:

- **`setAnimationLoop(callback, { autoStart })`**, and the callback receives
  `(timeMs, deltaSeconds)` — seconds, so `delta` needs no `/1000`.
- **`setAnimationLoop(null)`** clears it; `start()`/`stop()` control the loop separately.
- **`dispose()`** is idempotent and releases the context, the listeners and the pending frame.
- **The 2D backends have no depth buffer.** You sort; there is no z-test. That is what
  `Renderable2D.depth` is for.
- **No `renderer.outputColorSpace`, no `toneMapping`** configuration on the CPU backends.
- **The scene graph is traversed structurally**, so `renderer.render` accepts anything with a
  `children` array whose members have a `render(painter)` method — not only a `Scene`.
- **`renderer.isHeadless`** tells you construction succeeded without a drawing surface, which is
  the idiomatic "show the user a message" check.

### The `camera.viewMatrix` caveat

The 3D branch of `Canvas2DRenderer` and `WebGLRenderer.uploadAutomaticUniforms` read
`camera.viewMatrix`. The library's cameras expose `matrixWorldInverse`, not `viewMatrix`. If you
pass a `PerspectiveCamera` to `Canvas2DRenderer.render`, it silently falls back to the 2D
pan/zoom transform. See
[rendering-backends.md](rendering-backends.md#webgl-specifics) for the small adapter.

## Picking

`Raycaster` ports directly, and there are five more strategies when you need them:

```ts
// three.js
const raycaster = new THREE.Raycaster();
raycaster.setFromCamera(ndc, camera);
const hits = raycaster.intersectObjects(scene.children, true);

// here — identical
const raycaster = new Raycaster();
raycaster.setFromCamera(ndc, camera);
const hits = raycaster.intersectObjects(scene.children, true);
```

New and worth adopting:

- **`Raycaster.ndcFromPointer(clientX, clientY, rect)`** converts a DOM position to NDC with the
  Y flip handled. three.js code usually does this by hand, and usually gets the sign wrong once.
- **`MeshPicker`** when you need interpolated UVs or barycentric data.
- **`BoundingBoxPicker`** for a broad phase before a precise pass.
- **`GPUPicking`** when the scene is too large to test on the CPU — three.js has no equivalent.
- **`HitTest2D`** for the 2D graph.

Note that `Raycaster.layers` is a bitmask compared against `Object3D.layers` (a number) — the same
as three.js — but `Node.layers` is a `Layers` object, so the comparison differs there.

## Animation

```ts
// three.js
const mixer = new THREE.AnimationMixer(root);
mixer.clipAction(clip).play();
mixer.update(clock.getDelta());

// here — the same
const mixer = new AnimationMixer(root);
mixer.clipAction(clip).play();
mixer.update(clock.getDelta());
```

What is different:

- **`mixer.update(delta)` returns a count** of the actions it advanced, which is a cheap
  "is anything animating" check.
- **`mixer.sample(time)`** evaluates every track at a time without advancing the mixer, which is
  what a scrub bar wants.
- **`AnimationClip.validate()` / `getValidationError()`** report why an imported clip is malformed
  rather than throwing from inside an interpolant.
- **`clip.optimize(tolerance)`** removes keyframes linear interpolation already reproduces.
- **`Timeline` and `Tween`** are an imperative alternative to the clip system, for UI and camera
  motion.

`Clock` ports directly, and `ManualClock` is the addition that makes an animation test
deterministic.

## What has no three.js equivalent

| Here | Purpose |
| --- | --- |
| `Canvas2DRenderer` / `SVGRenderer` | Real CPU and vector backends with the same contract as the GPU ones. three.js has no SVG backend, and its `CanvasRenderer` was removed. |
| `detectBackend`, `detectBackendStrict`, `getSupportedBackendNames` | Runtime backend selection by actually probing the runtime. |
| `Disposable` + `addDisposable` + `disposeAll` | A stated ownership protocol, rather than `dispose()` per class. |
| `Pool`, `ArrayPool`, `Cursor` | Per-frame recycling as part of the API surface. |
| `BoundingVolume` | Local and world box/sphere in one object, with a `version` for memoisation. |
| `RenderList` / `RenderQueue` | The bucketing and sort as an inspectable, testable object. |
| `Layers` (core), `Layer2D`, `Layer2D.cameraScale` | 2D layers with a camera-scale flag. |
| `HitTest2D`, `SpritePicker`, `GPUPicking` | Picking strategies three.js does not ship. |
| `wasm` | Optional WebAssembly acceleration modules. |

## What is missing relative to three.js

- **`WebGPURenderer`** — implemented in `src/renderer/webgpu/`, but treat it as unproven on real
  hardware: check `detectBackendStrict('webgpu')` and await `renderer.readiness` before relying on
  it. Device acquisition is asynchronous.
- **`src/effects/`** covers post-processing: `EffectComposer` with render, shader, bloom, blur,
  FXAA, SSAO and outline passes, shadow maps with cascades, fog and a pooled particle system. What
  three.js has and this does not: `UnrealBloomPass`'s specific look, `OutputPass`, and a GPU-backed
  `EffectComposer` for the Canvas2D/SVG backends (those composite on the CPU). See
  [effects.md](effects.md).
- **`renderer.shadowMap`** — `ShadowMap` exists in `src/effects/shadows/` and the shadow shaders are
  in place (`ShaderLib.shadow`, `ShadowMaterial`); what is missing is the automatic integration into
  `renderer.render` (three.js's `renderer.shadowMap.enabled`).
- **`TextureLoader`** — `src/assets/` ships `FileLoader`, `ImageLoader`, `TextureLoader`,
  `FontLoader`, `JSONLoader`, `GLTFLoader`, `OBJLoader`, `FBXLoader`, `STLLoader`, `PLYLoader` and
  `SVGLoader`. The caveat is coverage of each format's optional features, not the loader's absence.
- **`PMREMGenerator`, `CubeCamera` environment bake**, and the material-editor-style helpers.

## A checklist for the port

1. Rename `Vector2`/`Vector3`/`Vector4`/`Quaternion`/`Matrix4` → `Vec2`/`Vec3`/`Vec4`/`Quat`/`Mat4`.
   Check every one by hand.
2. Replace `geometry.applyMatrix4` with `geometry.applyMat4`.
3. Audit every `vector.applyMatrix4(projection)` — the divide is now automatic.
4. Replace `geometry.getIndex() === null` with `=== undefined`.
5. Convert positional geometry constructors to options objects.
6. Pick a backend explicitly; there is no default `WebGLRenderer`.
7. Add the `viewMatrix` adapter if you render 3D through `Canvas2DRenderer` or `WebGLRenderer`.
8. Replace `addEventListener`/`removeEventListener` with `on`/`off`, and keep the returned
   unsubscribe function.
9. Confirm whether you want `Node` or `Object3D` — the core graph's `layers`, `getWorldDirection`
   and `add` return value differ.
10. Convert any manual `ndc` maths to `Raycaster.ndcFromPointer`.
11. Add `dispose()` calls where three.js relied on the garbage collector; the library states
    lifetimes rather than hoping.
12. Run `pnpm exec tsc --noEmit` and read every error — most of them are the traps above, caught
    at compile time.
