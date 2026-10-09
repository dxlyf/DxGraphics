# Extending

How to add a backend, a material, a geometry generator, or a loader.

Four extension points, each with a real seam already in the codebase. Before starting any of them,
read [layers.md](layers.md) — every one of them is a place where a wrong-direction import is
tempting.

The scaffold tool writes the file skeleton for a new module or class:

```bash
node --experimental-strip-types tools/generator/generate.ts module mylayer
node --experimental-strip-types tools/generator/generate.ts class src/mylayer Thing
```

It deliberately does not edit `src/index.ts`; adding to the public barrel changes the published API
and the API-extractor report, so that stays a deliberate edit.

---

## 1. A backend

**Seam:** `AbstractRenderer` — implement three abstract hooks.

```ts
export abstract class AbstractRenderer implements IRenderer {
  protected abstract onInitialise(): void;
  protected abstract clearSurface(options: { color: RGBA; depth: number; stencil: number; flags: ClearFlags }): void;
  protected abstract renderScene(scene: SceneLike | null, camera: CameraLike | null, context: RenderContext): void;
}
```

### Steps

1. **Extend `AbstractRenderer`.** Call `super(options, BackendNames.YourBackend)` first, then
   acquire your context, then `this.initialise()` last — `onInitialise` assumes your fields are
   set.
2. **Declare `backend`.** `public readonly backend: BackendName = BackendNames.YourBackend;`
3. **Accept a `CanvasSurface`.** The base class resolves `canvas`, a selector, a container, an
   `OffscreenCanvas`, or a test double. Use `this.surface`, and handle a null context: the base
   class binds a *null surface* when no canvas can be created, and only `render` should throw.
4. **Implement `onInitialise()`.** Acquire the context, apply any base transform, and set
   `renderState.viewport` / `renderState.pixelRatio`.
5. **Implement `clearSurface()`** and **`renderScene()`**. In `renderScene`, reuse
   `this.renderList` and `this.renderQueue`, call `list.reset()`, collect with the same
   three-step resolution the other backends use, then `renderQueue.sort(list)` and paint
   `result.order`.
6. **Override `onSizeChanged`, `onViewportChanged`, `onScissorChanged`** if your API needs them.
7. **Override `getCapabilities()`** with a real list. This is how a consumer learns what your
   backend can do, and returning `[]` hides information rather than being conservative.
8. **Override `onDispose()`** to release the context.
9. **Leave `onCreateRenderTarget` alone** unless you can genuinely render off-screen. The default
   throws with a message naming the alternative, which is better than a stub that draws nothing.
10. **Add it to `SUPPORTED_BACKENDS`** in `AbstractRenderer.ts`, and to the canonical names if it
    is a new platform rather than a new implementation.

### Rules

- **Do not import a layer above `renderer`.** Not `scene`, not `materials`, not `geometry`. Declare
  the structural subset you read. The WebGL backend is the reference implementation of this: it
  declares `WebGLMaterialLike`, `GeometryLike`, `AttributeLike` and `TextureBindingLike` locally
  and imports none of them.
- **Reuse `this.context`.** One `RenderContext`, mutated in place. A per-frame object is an
  allocation per frame, forever.
- **Reuse `this.renderList` and `this.renderQueue`.** Same reason.
- **Return the null surface's behaviour.** Construction, `setSize`, `setPixelRatio`, `clear` and
  `dispose` must be safe with no canvas; only `render` throws. That is what makes
  `renderer.isHeadless` a usable check.
- **Guard every draw.** A renderable that throws must not kill the frame — both CPU backends wrap
  `object.render(painter)` in a `try`/`catch` and log with the object's identity. See
  `describeObject`/`describeRenderable`.
- **Do not add a capability you have not tested.** A wrong capability string is worse than a missing
  one.

### Reference

`src/renderer/canvas2d/Canvas2DRenderer.ts` (604 lines) is the smallest complete example.
`src/renderer/svg/SVGRenderer.ts` (866) shows a retained-mode backend, including the
`allowsHeadlessClear()` override.

---

## 2. A material

**Seam:** extend `Material`, or satisfy the structural `MaterialLike`.

```ts
export class Material<TLabel extends string = string> extends Disposable<TLabel> {
  public name = '';
  public visible = true;
  public transparent = false;
  public opacity = 1;
  public side: Side = Side.FrontSide;
  public wireframe = false;
  public depthTest = true;
  public depthWrite = true;
  public depthFunc: DepthFunc = DepthFunc.LessEqual;
  // … stencil, blending, alphaTest, polygonOffset, fog, toneMapped, clippingPlanes …
}
```

### Steps

1. **Extend the right base.** `MeshBasicMaterial` for unlit, `MeshPhongMaterial` for Blinn–Phong,
   `MeshStandardMaterial` for metallic-roughness, and so on. A material that needs nothing from a
   parent can extend `Material` directly.
2. **Add your fields with the three.js-compatible names and defaults.** Porting is a stated goal,
   so `roughness = 1`, `metalness = 0` and `shininess = 30` are the defaults to use.
3. **Accept `parameters?: MaterialParameters`** and assign from it, so
   `new MyMaterial({ myField: 2 })` works. `MaterialParameters` is `Record<string, unknown>`, so an
   unknown key is a silent no-op — which means the assignment loop is the only thing that makes a
   field reachable.
4. **Implement `dispose()`** for any GPU resource you own, and use `addDisposable` for textures you
   were given. A material that owns its texture releases it; one that was handed a shared texture
   does not.
5. **Register it in `MaterialFactory`** if it should be constructible by name — that is what a
   loader needs when a file names its material type.
6. **Export it from `src/materials/index.ts`.**

### Rules

- **Do not import a backend.** A material describes shading; the backend interprets it. Use the
  structural `MaterialLike` shape and let the WebGL renderer read `vertexShader`/`fragmentShader`/
  `uniforms`/`defines`/`textures` — or supply a ready `IShader` through `shader` and let the sources
  be ignored.
- **The common state lives on the base.** Do not redeclare `transparent`, `side` or `depthWrite`.
- **`transparent` decides the render bucket**, so set it correctly rather than relying on
  `opacity < 1`. `RenderList.push` resolves transparency in a documented order.
- **Give shared materials a stable `id`.** The render queue sorts by `renderOrder`, then
  `materialId`, then depth — so a shared `id` is what groups draws and cuts state changes.
- **`uniforms` is the right place for a value that changes per material**, and the *renderable's*
  own `uniforms` for one that changes per object. The renderer applies the material's bag first and
  the renderable's second, so the renderable wins.

### Reference

`src/materials/MeshStandardMaterial.ts` is deliberately thin (three fields over
`MeshPhongMaterial`), which is the shape a new material should have. `ShaderMaterial` and
`RawShaderMaterial` show the escape hatches.

---

## 3. A geometry generator

**Seam:** return a `BufferGeometry` with `position`, `normal` and `uv`; optionally provide a
subclass.

### Steps

1. **Write a `createXGeometry(options)` function first.** It returns a plain `BufferGeometry`, which
   is what most callers want and what a test can assert against without a class.
2. **Accept a single options object**, not positional arguments, and give every field the
   three.js default. `BoxGeometryOptions` is `{ width = 1, height = 1, depth = 1, widthSegments = 1,
   heightSegments = 1, depthSegments = 1 }`.
3. **Provide a subclass** that extends `BufferGeometry` and calls the factory, for the
   `new BoxGeometry({ … })` spelling.
4. **Supply `position`, `normal` and `uv`.** All three, even when the consumer will ignore the
   third: a missing `uv` silently disables texturing, and a missing `normal` silently disables
   lighting.
5. **Compute the bounds.** Call `computeBoundingBox()` and `computeBoundingSphere()` before
   returning. A geometry without bounds cannot be culled, and `BoundingVolume.setFromGeometry`
   would then rescan the positions on every frame instead of using the cache — three orders of
   magnitude slower.
6. **Emit triangles, in a consistent winding.** Counter-clockwise when seen from outside, matching
   the right-handed convention, so back-face culling works.
7. **Export it from `src/geometry/3d/primitives/index.ts`.** The barrel re-exports the whole
   sub-layer, so adding it there is enough for `src/index.ts`.

### Rules

- **Typed arrays, built once.** Accumulate into a plain `number[]` while generating, then pass a
  single `Float32Array` to the `BufferAttribute` constructor. Do not call `setXYZ` in a loop for
  construction — that is the mutation path, not the build path.
- **Prefer indexing when vertices are shared.** An indexed cube is half the vertices of a
  non-indexed one — but a **non-indexed** cube is flat-shaded correctly, because
  `computeVertexNormals` averages per vertex and an indexed cube would round at the corners. Pick
  deliberately and say which in a comment.
- **Do not compute normals you already know.** A box's face normals are exactly `±X`, `±Y`, `±Z`;
  `computeVertexNormals` would give you the same answer for more work, and the wrong answer on an
  indexed mesh.
- **Do not import `src/scene`.** A generator produces data.
- **Keep the visual conventions consistent**: centred on the origin, `+Y` up, and the natural axis
  for the shape (a cylinder along `Y`, a plane in `XY`).

### Reference

`src/geometry/3d/primitives/BoxGeometry.ts`, and the `GeometryBuilder` base in the same directory.
The 2D generators in `src/geometry/2d/` are a different shape — a `Curve` subclass with
`getPoint(t)` — which is what the tessellation helpers consume.

---

## 4. A loader

**Seam:** extend `Loader`, or write a function and register it with `LoaderManager`.

### Steps

1. **Extend `Loader<TValue>`** and implement the decode step.
2. **Throw on failure.** The manager's retry logic keys on a rejection, so a loader that returns
   `null` on a 404 defeats it and hands the caller a confusing failure later instead of a clear one
   now.
3. **Report progress as `(loaded, total)`** where the transport supplies it. `total` may be `0`
   when there is no `Content-Length`, so a progress bar must guard the division.
4. **Accept an `AbortSignal`** so a scene that unloads mid-load can cancel rather than resolve into
   a disposed object.
5. **Register it** with the manager so a URL or an extension resolves to it.
6. **Export it from `src/assets/index.ts`.**

### Rules

- **Return fully-formed library types.** A loader that returns a raw parsed object pushes the
  conversion into every caller. Return a `BufferGeometry`, an `AnimationClip[]`, a `Font`.
- **Do not import a backend.** A loader produces CPU-side data; uploading is the renderer's job.
  This is also what makes a loader testable in Node with no GPU.
- **Prefer a parse-only path** — `parse(text)` separate from `load(url)` — so a test can exercise
  the decoder without a fetch, and so a caller with bytes in hand does not have to create a URL.
- **Cache by URL, not by content.** `Cache` is the library's LRU; use it rather than a private
  `Map`, so the same asset requested through two loaders is still fetched once.
- **Handle the "resolves after disposal" race** with `addDisposable` on a `Disposable` owner, or
  `disposeOnAbort` with a signal. See
  [resource-lifetimes.md](resource-lifetimes.md#adddisposable-on-an-already-disposed-owner).

### Reference

`src/assets/` — `FileLoader` is the base, `ImageLoader` shows the `createImageBitmap`-with-fallback
pattern, and `GLTFLoader` shows a multi-file format.

---

## 5. Something else: a layer or a feature

If none of the four fits, the change is architectural and worth writing down before coding.

1. **Place it in the layer order.** Which band does it belong to? If it needs something from a
   higher band, the placement is wrong.
2. **Declare its structural contracts** in the consuming layer's `types.ts`, with a comment naming
   the file that provides the real class.
3. **State its lifetime.** Does it own a resource? Extend `Disposable` and say what.
4. **State whether it allocates per frame.** If it is on a hot path, follow the
   mutator-returns-`this` convention.
5. **Add it to `src/index.ts`** as an explicit `export * from './name'`, and expect to resolve a
   name collision with an explicit re-export rather than a rename.
6. **Document it**: a guide page, and an architecture page if the structure changed.
7. **Test it at the right level**, and add a bench entry if it is performance-sensitive.

## A warning about name collisions

`src/index.ts` re-exports eighteen layers with `export *`, and several names legitimately exist in
more than one. The barrel reports each as `TS2308: Module './x' has already exported a member named
'y'`, and the fix is always an explicit re-export:

```ts
// Instead of a silent `export *`:
export { GeometryLike } from './geometry';
export { GeometryLike as SceneGeometryLike } from './scene';
```

`types.ts` files are also `export type *` rather than `export *` where a name is type-only, which
avoids a value/type collision at the source rather than at the barrel. When you add a layer, expect
to spend a few minutes here — it is not a sign that the design is wrong, only that `export *` is
lossy.

## See also

- [layers.md](layers.md) — the rule every extension point obeys.
- [renderer-interface.md](renderer-interface.md) — the three hooks in detail.
- [resource-lifetimes.md](resource-lifetimes.md) — the ownership protocol.
- [events.md](events.md) — how to add an event, and why the map is shared.
- [../guide/contributing.md](../guide/contributing.md) — the review expectations.
