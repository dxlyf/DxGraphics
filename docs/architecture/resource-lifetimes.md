# Resource lifetimes

The `Disposable` contract, `addDisposable`, and what happens when a GPU context is lost.

## The problem

Graphics code owns two kinds of resources that the garbage collector cannot reclaim: GPU handles
(buffers, textures, programs, render targets) and DOM resources (canvases, event listeners, object
URLs). Both leak silently. A leaked GL buffer is invisible until the driver runs out; a leaked
listener keeps a whole scene graph alive.

Explicit ownership is the only cheap defence, so the library states it rather than inferring it.

## The `Disposable` contract

```ts
abstract class Disposable<TLabel extends string = string> implements IDisposable {
  abstract readonly label: TLabel;   // the diagnostic name, e.g. 'BufferGeometry'
  readonly id: string;               // process-unique, so it is a valid Map key

  get isDisposed(): boolean;
  get isDisposing(): boolean;
  get isUsable(): boolean;

  addDisposable<T extends IDisposable>(child: T): T;      // returns the CHILD
  addDisposables(...children: IDisposable[]): this;        // returns THIS
  removeDisposable(child: IDisposable): boolean;
  addDisposeCallback(callback: () => void): () => void;    // returns an unsubscribe

  assertUsable(): void;                                    // throws DisposedError when disposed
  dispose(): void;                                         // idempotent
  disposeWith<T>(value: T): T;                             // dispose, then return a value

  protected onDispose(): void;                             // the subclass hook
}
```

### The disposal order, and why

```ts
public dispose(): void {
  if (this.disposed || this.disposing) return;
  this.disposing = true;
  this.events.emit('dispose');

  try { this.onDispose(); } catch (error) { log.error(…); }   // 1. the native hook

  for (const child of Array.from(this.disposables)) {          // 2. children
    try { child.dispose(); } catch (error) { log.error(…); }
  }
  this.disposables.clear();

  for (const callback of Array.from(this.disposeCallbacks)) {  // 3. callbacks
    try { callback(); } catch (error) { log.error(…); }
  }
  this.disposeCallbacks.clear();

  this.disposing = false;
  this.disposed = true;
  this.events.emit('disposed');
  this.events.dispose();
}
```

Four decisions in eleven lines, each load-bearing:

1. **`onDispose()` runs first**, before children. A subclass releasing its own native handle before
   its children is the order that lets it still reference them — the reverse would release children
   out from under a still-live parent.
2. **A throwing child does not stop the loop.** Each is wrapped, so one bad release cannot leave
   the rest unreleased. A partially-released object is recoverable; an unreleased tree is a leak.
3. **`disposing` guards re-entrancy.** A child that disposes its parent (or a callback that
   disposes the object again) hits the guard rather than recursing.
4. **`Array.from(...)` before iterating.** A child that unregisters itself during disposal would
   otherwise mutate the set being iterated.

### Idempotence

`dispose()` twice is a no-op the second time. This is not a nicety: `beforeunload` can fire after an
explicit teardown, a `finally` block can run after an error path already disposed, and a React
effect cleanup can race a route change. Every one of those is a legitimate double-dispose.

### `assertUsable()` — the other half

Idempotent disposal means a use-after-dispose would otherwise be a silent no-op. `assertUsable()`
turns it into an explicit error:

```ts
public setAttribute(name: string, attribute: AnyBufferAttribute): this {
  this.assertUsable();
  this.attributes[name] = attribute;
  return this;
}
```

Subclasses call it at the top of every method that touches a released resource. The payoff is that
a bug surfaces at the call site with a label and an id, rather than as missing geometry three
frames later.

## `addDisposable` on an already-disposed owner

This is the most useful behaviour in the whole class, and the one that handles the async race:

```ts
public addDisposable<T extends IDisposable>(child: T): T {
  if (!child) return child;
  if (this.disposed) {
    child.dispose();       // the owner is gone, so the child never had a chance
    return child;
  }
  this.disposables.add(child);
  return child;
}
```

The realistic scenario it solves: a loader resolves **after** its scene was torn down.

```ts
class Viewer extends Disposable<'Viewer'> {
  public override readonly label = 'Viewer' as const;

  public async load(url: string): Promise<void> {
    const texture = await loader.load(url);       // may resolve after disposal
    this.addDisposable(texture);                   // released immediately if we are gone
  }
}
```

Without the check, the texture would be stored on a dead object and never released. `createDisposable`
exists for the same pattern on a resource that does not extend `Disposable`:

```ts
this.addDisposable(createDisposable('objectURL', () => URL.revokeObjectURL(url)));
```

### Why the return types differ

`addDisposable` returns the **child** so the common case reads as one expression:

```ts
const geometry = new BufferGeometry();
owner.addDisposable(geometry).setAttribute('position', …);
```

`addDisposables` returns **this** so several can be chained:

```ts
owner.addDisposables(texture, geometry, material).addDisposeCallback(cleanup);
```

## Reference counting

Some resources are shared — two meshes with one geometry, two materials with one texture. Freeing
on the first release is wrong; freeing on the last is right. `DisposableRef` does that:

```ts
const ref = new DisposableRef(geometry);

ref.retain();          // a second user
ref.refCount;          // 2
ref.release();         // 1 — nothing disposed
ref.release();         // 0 — geometry.dispose() runs here
```

The tricky part is ownership transfer: whichever object hands out the extra reference must also
give up its own. `removeDisposable(child)` is the "I no longer own this" call, and it **does not
dispose** — that is the point.

## Scene graph disposal

`Node.dispose` is depth-first and children-first:

```ts
for (const child of this.children.slice()) child.dispose();
this.children.length = 0;
this.removeFromParent();
this.emit('dispose');
this.nodesDisposed = true;
super.dispose();
```

Children first, so a parent can still read them while releasing. Idempotent via `nodesDisposed`.
`isDisposed` reports `nodesDisposed || super.isDisposed`, so both paths agree.

`Object3D.dispose` deliberately does **not** touch geometry or materials:

```ts
public dispose(): void {
  this.emit('dispose');
  this.removeFromParent();
  this.removeAllListeners();
}
```

Because two meshes may share both, and a mesh disposing its geometry would break its sibling. The
caller owns shared resources; `Scene3D.dispose` makes the same choice explicitly:

> Geometry and material ownership stays with the caller (two meshes may share both), so only the
> listeners and the parent link are released here.

That is why the examples dispose their geometries explicitly in their own `dispose()`.

## GPU resources

| Class | Owns | Released by |
| --- | --- | --- |
| `BufferGeometry` | Attribute arrays, the index buffer | `dispose()` — disposes every attribute and the index, then clears the maps |
| `BufferAttribute` | Its typed array (and, on a GPU backend, its buffer) | `dispose()` |
| `Texture` | An image, and the GPU texture derived from it | `dispose()` |
| `Material` | Uniforms, textures it was given | `dispose()` |
| `WebGLRenderer` | The GL context, program/VAO/attribute caches, the animation loop, resize listeners | `dispose()` |
| `IRenderTarget` | A framebuffer and its attachments | `dispose()`, or the renderer's `dispose()` for the bound one |

`BufferGeometry.dispose` sets `index = null` and clears `attributes` **before** calling
`super.dispose()`, so the base class cannot observe a half-released object. That ordering rule
applies to any subclass with a map of children.

## Context loss

A WebGL context can be lost at any time — a driver reset, a GPU switch, a laptop suspending, or a
tab being backgrounded with too many contexts alive. Every GPU resource becomes invalid at once,
and the application has to rebuild.

`WebGLContext` wires the two browser events and exposes:

```ts
renderer.isContextUsable;   // false while the context is lost
renderer.contextGeneration; // incremented on every loss AND every restore
renderer.contextRef;        // the WebGLContext, or null while headless
```

Two design points:

- **The renderer skips frames while the context is lost** rather than throwing. `renderScene`
  checks `webgl.isUsable`, warns once, and returns — so a loss does not produce a cascade of
  exceptions from every renderable.
- **`contextGeneration` is the observable to key on.** A resource cache that records the generation
  it was built for can detect invalidation without listening to events:

  ```ts
  if (cache.generation !== renderer.contextGeneration) {
    cache.generation = renderer.contextGeneration;
    rebuild();   // the old GPU handles are meaningless
  }
  ```

The counterpart events exist on `CoreEventMap` for a listener-based design:

```ts
renderer.events.on('contextlost', () => { showNotice('Restoring…'); });
renderer.events.on('contextrestored', () => { hideNotice(); });
```

**CPU-side data must survive a loss.** A `BufferGeometry`'s typed arrays are still valid; only the
GPU buffers derived from them are gone. So the rebuild path is "re-upload", not "re-parse", which
is why `BufferGeometry` keeps its arrays rather than freeing them after upload.

## What the caller must release

The library states ownership, so the list is short and explicit:

| You created | You release |
| --- | --- |
| A renderer | `renderer.dispose()` |
| A geometry | `geometry.dispose()` |
| A material | `material.dispose()` |
| A texture | `texture.dispose()` |
| An object URL | `URL.revokeObjectURL(url)` |
| An event listener via `on` | the returned unsubscribe function, or `off` |
| An offscreen canvas | drop the reference, and zero its dimensions to free the surface eagerly |

Everything else is released by its owner. `disposeAll(iterable)` is the convenience for a list:

```ts
disposeAll([geometry, material, texture]);   // returns how many were released
```

## See also

- [../guide/performance.md](../guide/performance.md) — why the ownership protocol is worth the
  ceremony.
- [events.md](events.md) — the `dispose`/`disposed` events on the shared map.
- [`tests/integration/resource-lifetimes.test.ts`](../../tests/integration/resource-lifetimes.test.ts)
  — the ordering, idempotence and reference-counting behaviour, asserted.
