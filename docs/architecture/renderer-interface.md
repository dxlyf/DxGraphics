# The renderer interface

Why `IRenderer` is shaped the way it is, and what one frame costs inside `AbstractRenderer`.

## The split

`src/renderer/interfaces/` declares **contracts**. `src/renderer/core/AbstractRenderer.ts`
implements everything a backend should not have to think about. A concrete backend implements
**three** hooks.

```ts
abstract class AbstractRenderer implements IRenderer {
  // Owned by the base class:
  //   surface binding and sizing, device-pixel-ratio handling,
  //   viewport/scissor bookkeeping, the clear colour,
  //   the animation loop, statistics, disposal

  protected abstract onInitialise(): void;
  protected abstract clearSurface(options: { color: RGBA; depth: number; stencil: number; flags: ClearFlags }): void;
  protected abstract renderScene(scene: SceneLike | null, camera: CameraLike | null, context: RenderContext): void;
}
```

Three hooks is the whole surface a new backend has to fill. Everything else — a resize, a DPR
change, a clear, a frame counter, a double `dispose()` — is already handled and already tested.

That is why `Canvas2DRenderer` is 604 lines and `SVGRenderer` is 866, while the interface they both
satisfy is 277: the interesting code in a backend is the *drawing*, not the lifecycle.

## Why `IRenderer` is one interface rather than several

Tempting alternative: split into `IRendererLifecycle`, `IRendererSizing`, `IRendererDrawing` and
so on. The library does not, for one reason: **every consumer needs all of it.** A UI control that
sizes a canvas also draws it and also disposes it. Splitting would mean every call site declaring
three parameters instead of one, to describe a distinction nobody acts on.

The one place a narrower interface *is* right is where the consumer genuinely needs less.
`CameraLike` and `SceneLike` are structural and minimal because the renderer reads a handful of
members. `CubeRenderHost<TCamera, TScene, TTarget>` in `src/scene/3d/types.ts` declares just
`renderToCube(...)`, because `CubeCamera.update` needs exactly that and nothing more.

The rule: narrow the interface where the *consumer* is narrow, not where the *implementation* has
seams.

## The structural camera and scene types

```ts
interface CameraLike {
  readonly viewMatrix?: { elements: ArrayLike<number> } | null;
  readonly projectionMatrix?: { elements: ArrayLike<number> } | null;
  readonly isOrthographic?: boolean;
  readonly position?: { x: number; y: number; z?: number };
  readonly zoom?: number;
  readonly rotation?: number;
  readonly visible?: boolean;
}

interface SceneLike {
  readonly visible?: boolean;
  collectRenderables?(list: unknown, camera: unknown): void;
  readonly children?: readonly unknown[];
  readonly background?: unknown;
}
```

Every member is optional, which means:

- **A backend accepts anything shaped like a camera**, including a plain object literal. The
  examples rely on this: `{ position: { x, y, z }, zoom, rotation }` is the whole 2D camera.
- **The renderer never throws on a missing member.** `getCamera2DTransform` reads
  `camera.position` structurally, defaults a missing `zoom` to `1` and a missing `rotation` to
  `0`, and reports `hasCamera: false` when there is no camera at all.
- **`SceneLike.children` is `readonly unknown[]`**, so the traversal has to verify rather than
  trust. That is deliberate: a scene graph in another package, or a plain object graph, is
  accepted on the same terms.

## One frame, step by step

`renderer.render(scene, camera)` calls `renderFrame()`, which calls `beginFrame`, runs the
optional pipeline, calls the backend's `renderScene`, then `endFrame`.

### `beginFrame(timestamp, delta)`

```ts
this.frameIndex++;
const frame = this.context;              // one RenderContext, reused forever
frame.begin(this.frameIndex, delta, this.elapsed, timestamp);
frame.renderer = this;
frame.stats = this.statistics;
frame.setSurface(this.logicalWidth, this.logicalHeight, this.ratio, this.currentViewport,
                 this.scissor, this.clearState.getEffectiveColor(), this.lastCamera);
frame.renderState = this.renderState;

// Per-frame counters are zeroed here, not at the end, so a backend that throws
// mid-frame still reports a fresh frame next time.
this.statistics.drawCalls = 0;
```

`setSurface` extracts the 2D camera transform into `frame.camera2D` — which is the one place the
`position`/`zoom`/`rotation` reading happens, so every backend sees the same numbers.

**One `RenderContext`, mutated in place.** That is the allocation-light rule applied to the frame
itself: a per-frame object would be one allocation per frame, forever, for no benefit.

### The backend's `renderScene`

Backends differ, but both CPU backends follow the same shape:

```ts
const list = this.renderList;            // reused
list.reset();
const collected = this.collectScene(scene, camera, list);

context.renderList = list;               // published for passes
context.renderQueue = this.renderQueue;

this.applyCameraTransform(camera, context);
this.applyScissorClip();
this.drawBackground(context.clearColor);

if (collected) {
  const result = this.renderQueue.sort(list);
  this.paintEntries(result.order);
  context.countObject(false);
}
```

Three points of interest:

1. **`list.reset()` recycles entries into a pool** rather than discarding them, so the second
   frame allocates nothing.
2. **`collectScene`** is the three-step resolution: `collectRenderables`, then `children`, then the
   scene itself. Both CPU backends implement it identically, on purpose — a caller should not have
   to care which one it is talking to.
3. **`renderQueue.sort(list)` never mutates the list's buckets.** It sorts a *copy* of each, so a
   caller can still inspect submission order afterward. That is what makes
   `tests/integration/render-queue-order.test.ts` able to assert both orders at once.

### `endFrame(timestamp, delta)`

```ts
this.statistics.frame = this.frameIndex;
this.statistics.frameTime = delta > 0 ? delta * 1000 : Math.max(0, now() - timestamp);
this.statistics.fps = updateFps(this.statistics.fps, this.statistics.frameTime);
this.elapsed += delta;
```

`fps` is an **exponential moving average** (`FPS_SMOOTHING = 0.1`), so it is meaningless for the
first few frames and should be guarded with `> 0` before display. A raw per-frame reciprocal would
flicker too much to read.

## Headless behaviour

A renderer with no drawing surface still constructs, tracks its size, and supports `setSize`,
`setPixelRatio`, `clear` and `dispose`. Only `render` throws, with an explanatory message.

That asymmetry is deliberate, and it is what makes `renderer.isHeadless` a usable check rather
than a fatal condition: a test can construct a renderer in Node and exercise its sizing; an
application can construct one and show a message instead of catching an exception from the
constructor.

```ts
private requireReady(): void {
  if (!this.headless) return;
  throw new Error(
    `${this.backend}: the renderer has no drawing surface, so this operation cannot be ` +
      'performed. Provide `options.canvas` … Construction, `setSize`, `setPixelRatio`, `clear` ' +
      'and `dispose` remain safe in this state.',
  );
}
```

`SVGRenderer` overrides `allowsHeadlessClear()` to return `true`, because clearing an SVG document
with no DOM is a no-op rather than an error — the output lives in the DOM, so there is simply
nothing to fill.

## Canvas semantics

```ts
width / height          // logical (CSS) pixels
canvas.width / height    // device pixels = logical * pixelRatio, rounded
setViewport / setScissor // device pixels, relative to the top-left
```

This is documented on `IRenderer` and is the one place the two coordinate systems are separated.
Mixing them is the most common sizing bug: a viewport set from logical pixels is half-size on a
2× display, which looks like "the scene is in the corner" rather than like a units error.

## The three hooks

### `onInitialise()`

Called exactly once from `initialise()`, and only when a real surface exists. This is where a
backend acquires its context and applies its base transform:

```ts
// Canvas2DRenderer
this.renderState.apply2DDefaults();
this.renderState.viewport = { x: 0, y: 0, width: this.surface.width, height: this.surface.height };
this.applyBaseTransform();   // setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
```

After `applyBaseTransform`, the painter works in **logical** pixels while the drawing buffer is in
device pixels — which is why every backend can compute layout in CSS units.

### `clearSurface(options)`

Receives a resolved `{ color, depth, stencil, flags }`. Canvas2D resets the transform so the clear
covers the buffer exactly, then reapplies the camera transform, because the clear must not be
affected by the camera.

### `renderScene(scene, camera, context)`

See above. This is the only hook with real freedom, and the reason `AbstractRenderer` exists at all
is so that everything around it does not have to be rewritten per backend.

## Optional hooks

| Hook | Default | Overridden by |
| --- | --- | --- |
| `getCapabilities()` | `[]` | Every backend, with a real list |
| `onSizeChanged(w, h, ratio)` | no-op | Both CPU backends, to resize the viewport |
| `onViewportChanged(viewport)` | no-op | WebGL, to call `gl.viewport` |
| `onScissorChanged(scissor)` | no-op | WebGL |
| `onCreateRenderTarget(options)` | **throws** | WebGL — the CPU backends do not override it, on purpose |
| `onDispose()` | no-op | Every backend, to release its context |
| `allowsHeadlessClear()` | `false` | SVG |

`onCreateRenderTarget`'s default throwing is a design decision worth noting: a backend that cannot
render off-screen says so with a message naming the alternative, rather than returning a stub that
draws nothing.

## Statistics

`RenderStats` carries `frame`, `drawCalls`, `triangles`, `vertices`, `lines`, `points`, `objects`,
`culled`, `textureUploads`, `bufferUploads`, `programCompiles`, `stateChanges`, `frameTime` and
`fps`.

The counters are per-frame and reset in `beginFrame`; `frameTime` and `fps` are derived in
`endFrame`. Three of them are diagnostics for a specific class of bug:

- **`programCompiles` still rising** → shader cache misses.
- **`bufferUploads` rising every frame** → a geometry's `version` is being bumped.
- **`stateChanges` climbing** → on the 2D backends this counts `save()`/`restore()` pairs, so a
  growing number means an unbalanced stack.

## Why `RenderContext` is separate from the renderer

Passes need per-frame state without reaching back into the renderer — otherwise a pass would need
to know which backend it is running on, which is exactly the coupling the layer rule forbids.
`RenderContext` is the hand-off: the renderer fills it, a pass reads it, and `context.values` is a
scratch `Map` one pass uses to hand a value to the next.

`RenderPipeline` is the slot: `pipeline.render(frame)` runs before `renderScene`, and
`pipeline.notifyResize(...)` is called on every size change. That is the seam an `EffectComposer`
would plug into — see [../guide/effects.md](../guide/effects.md).
