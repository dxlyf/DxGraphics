# Events

The shared `CoreEventMap`, why `TEvents` is unconstrained, and what dispatch costs.

## The design in one paragraph

There is **one** documented event map, `CoreEventMap`, and every graph object uses it. `Node`
extends `EventDispatcher<CoreEventMap>`, so `emit('viewportchange', w, h)` checks both the event
name and the argument tuple at compile time — without threading a generic parameter through
`Node` → `Camera` → `PerspectiveCamera` → every user subclass.

## The map

`src/core/events.ts` declares it as an interface whose keys are event names and whose values are
**argument tuples**:

```ts
export interface CoreEvents {
  // ------------------------------------------------------ graph structure
  added: [parent: unknown, child: unknown];
  removed: [parent: unknown, child: unknown];
  descendantadded: [parent: unknown, child: unknown];
  descendantremoved: [parent: unknown, child: unknown];
  visibilitychange: [visible: boolean];
  layerchange: [layer: Layer | number, enabled: boolean];

  // ------------------------------------------------------------- transform
  matrixchanged: [];
  worldmatrixchanged: [];
  transformchange: [];

  // ------------------------------------------------------------- lifecycle
  dispose: [];
  disposed: [];
  updateenabled: [];
  updatedisabled: [];

  // ------------------------------------------------------------------ camera
  projectionchange: [];
  viewportchange: [width: number, height: number];
  cameraactivated: [];
  cameradeactivated: [];

  // ------------------------------------------------------------------- scene
  change: [];
  update: [];
  environmentchange: [];
  boundschange: [];

  // --------------------------------------------------------------- renderer
  backendchange: [backend: string];
  targetchange: [];
  contextlost: [];
  contextrestored: [];
  shadercompiled: [key: string, durationMs: number];

  // --------------------------------------------------------------- geometry
  attributemodified: [name: string];
  indexmodified: [];
  bufferupload: [bytes: number];
  boundsrecomputed: [];

  // ----------------------------------------------------------------- assets
  textureloaded: [];
  textureerror: [error: Error];
  textureupload: [bytes: number];
  assetloaded: [url: string];
  asseterror: [url: string, error: Error];
  loadprogress: [loaded: number, total: number];

  // -------------------------------------------------------------- animation
  animationstart: [];
  animationfinish: [];
  animationloop: [count: number];
  trackupdate: [name: string, time: number];

  // ---------------------------------------------------------------- controls
  pointerenter: [x: number, y: number];
  pointerleave: [x: number, y: number];
  pointerdown: [x: number, y: number];
  pointerup: [x: number, y: number];
  pointermove: [x: number, y: number];
  click: [x: number, y: number];
  hover: [x: number, y: number];
  drag: [dx: number, dy: number];
  pinch: [scale: number];
  controlschange: [];

  // -------------------------------------------------------------------- text
  glyphadded: [character: string];
  layoutchange: [width: number, height: number];
}

export type CoreEventMap = CoreEvents;
```

A tuple, not an object, because that is what `emit('event', a, b)` spreads. `added: [parent, child]`
means the call is `emit('added', parent, child)` and the handler is
`(parent, child) => void`.

`SceneChangeDetail` is the one structured payload in the file, carried by `Scene`'s
`environmentchange`.

## Why `TEvents` is unconstrained

```ts
export type EventName<T> = Extract<keyof T, string>;
export type EventArgs<T> = T extends unknown[] ? T : any[];
export type EventListener<A extends unknown[] = unknown[]> = (...args: A) => void;
export type EventMap = { [event: string]: any[] };

export class EventEmitter<TEvents = EventMap> {
  public on<K extends EventName<TEvents>>(
    event: K,
    listener: EventListener<EventArgs<TEvents[K]>>,
    options?: ListenerOptions,
  ): () => void;
```

`TEvents = EventMap` — a plain index signature — rather than
`TEvents extends EventMap = EventMap`. The `extends` would be the obvious thing to write, and it is
wrong here.

`EventMap` is `{ [event: string]: any[] }`, which is an **index signature**. A concrete map like
`CoreEventMap` is an interface with specific keys. Under `strict`, an interface with specific keys
is **not** assignable to a type with a string index signature — because it does not promise to
handle arbitrary string keys:

```ts
// This fails:
interface Specific { added: [unknown, unknown] }
const m: EventMap = null as unknown as Specific;   // TS2322: Index signature is missing
```

So `TEvents extends EventMap` would reject `CoreEventMap`, `Object3DEventMap` and any user map —
the exact opposite of the intent. Leaving `TEvents` unconstrained, and letting
`EventName<TEvents> = Extract<keyof TEvents, string>` derive the name union, accepts a specific map
*and* keeps `emit` fully typed.

The conditional `EventArgs<T>` handles the other half: a map value is either a tuple (the normal
case) or `unknown[]` for an untyped map. `T extends unknown[] ? T : any[]` resolves both without a
cast at the call site.

### What this buys

```ts
const node = new Node();

node.on('added', (parent, child) => { /* parent and child are typed */ });

node.emit('added', node, other);        // OK
node.emit('nope');                       // error: not a key of CoreEventMap
node.emit('viewportchange', 800);        // error: expected 2 arguments
node.emit('visibilitychange', 'yes');    // error: expected boolean
```

Every one of those four is a compile error, and none of them needed a generic parameter on `Node`.

## Two payload shapes in the scene graph

This is the sharpest edge in the event system, and it is a genuine inconsistency rather than a
design:

```ts
// core Node — tuple payloads, emitted on the ACTOR
parent.on('added', (parentNode, childNode) => {});
parent.add(child);                        // emits 'added' on `parent`

// scene/3d Object3D — object payloads, emitted on the node itself
mesh.on('added', ({ parent }) => {});
mesh.on('childadded', ({ child }) => {});
```

| | `Node` / `EventDispatcher<CoreEventMap>` | `Object3D` / `TypedEventEmitter<Object3DEventMap>` |
| --- | --- | --- |
| Base | `EventDispatcher` | `TypedEventEmitter` |
| Payload | tuples | objects |
| `dispose` event | `'dispose'` and `'disposed'` | `'dispose'` |
| Bubbling | `dispatchEvent` walks `parent` | none |
| `onDispatch` | yes | no |

`Object3D` wraps a `TypedEventEmitter<Object3DEventMap>` (`src/scene/internal/emitter.ts`), which
is a different implementation from `EventDispatcher`. The reason is history: the two were written
against different needs, and `Object3D`'s graph is not the same graph as `Node`'s.

The practical rule: **read the class's own `EventMap` before writing a handler.** Both are
documented on the class, and both are exported.

## Registration

```ts
on(event, listener, options?): () => void      // returns an UNSUBSCRIBE FUNCTION
once(event, listener, options?): () => void
prependListener(event, listener, priority?): () => void
off(event, listener): boolean
hasListener(event, listener?): boolean
listenerCount(event): number
toggleListener(event, listener): boolean
removeAllListeners(event?): this
removeAll(event?): this
```

**`on` returns a function, not `this`**, which is why `emitter.on(a).on(b)` does not compile. That
is deliberate: the returned unsubscribe is what `dispose()` paths need, and chaining is not worth
losing it for.

```ts
const cleanups: (() => void)[] = [];

cleanups.push(node.on('matrixchanged', () => updateOverlay()));
cleanups.push(camera.on('viewportchange', (w, h) => resize(w, h)));

function dispose(): void {
  for (const off of cleanups) off();
  cleanups.length = 0;
  renderer.dispose();
}
```

Two behaviours to know:

- **Listeners are deduplicated by identity** (with the `once` flag as part of the key), so
  registering the same function twice returns an unsubscribe without adding a second record.
- **Listeners are ordered by descending priority, then insertion order.** `prependListener` uses a
  non-zero priority.

## Dispatch

```ts
emit(event, ...args): boolean                   // true when at least one listener ran
emitAsync(event, ...args): Promise<boolean>     // dispatched on the microtask queue
dispatchEvent(event, detail?): DispatchEvent<this>   // EventDispatcher only; bubbles
dispatchEventLocal(event, ...args): boolean
onDispatch(type, listener): () => void
onError(handler | null): this
```

### A throwing listener never breaks the loop

```ts
for (const record of snapshot) {
  if (!this.hasRecord(event, record)) continue;      // a listener may remove another
  try {
    record.listener.apply(record.context, args);
  } catch (error) {
    this.handleError({ event, error, listener: record.original });
  }
}
```

`handleError` routes to the handler installed with `onError`, or logs. An exception in one handler
therefore cannot prevent the others from running — which matters because a resize listener that
throws should not stop the sibling that fixes the layout.

### The snapshot optimisation

```ts
const snapshot = records.length > 1 || records[0].once ? records.slice() : records;
```

With a single persistent listener, the live array is iterated with no copy — the hot path for the
common "one listener per event" case. A copy is only made when dispatch could mutate the list,
which is when there is more than one listener or a `once` is present.

### Bubbling

`EventDispatcher.dispatchEvent` walks the `parent` chain, so a listener registered with
`onDispatch(type, handler)` on an ancestor sees events from descendants:

```ts
scene.onDispatch('pointerdown', (event) => {
  event.currentTarget;            // changes as the event bubbles
  event.stopPropagation();
  event.immediatePropagationStopped;
});
```

Note the split: `on`/`emit` are **local**, and `dispatchEvent`/`onDispatch` are **bubbling**. They
are separate registries (`listeners` versus `bubbleListeners`), so an `emit` does not reach a
bubbling listener and a `dispatchEvent` does not reach a plain `on` listener. The `dispatchEvent`
record has `type`, `target`, `currentTarget`, `propagationStopped` and
`immediatePropagationStopped`, plus the matching stop methods.

## Cost

| Operation | Complexity |
| --- | --- |
| `on` | O(listeners for that event) — the dedupe scan |
| `emit` | O(listeners), plus one `Map.get`; no allocation in the single-listener case |
| `emit` with several or a `once` | one array copy |
| `dispatchEvent` | O(listeners) per node in the ancestor chain |
| `emitCounts` bookkeeping | one `Map.set` per emit, always |

The `emitCounts` map is updated on every emit even though it is documented as diagnostics-only.
That is one `Map.set` per event per frame, which is measurable on a hot path — and the reason a
per-frame event on a large graph is worth avoiding. Prefer polling a value over emitting one.

`emit` returns `false` immediately when there are no listeners, without touching `emitCounts`, so
an event nobody listens to costs one `Map.get`.

## When not to use events

Events are for **notifications about something that happened**, not for state. Three cases where a
direct call or a read is better:

| Instead of | Use |
| --- | --- |
| An event per node per frame to mark a transform change | Compare `matrixWorld` version fields, or update the known-moving branch |
| Emitting a position every frame | The renderer reads `matrixWorld` directly |
| A `change` event to invalidate a cache | A `version` counter — `BoundingVolume.version`, `Renderable2D`'s `depth`, `BufferAttribute.version` |

The `version`-counter pattern is the one the library reaches for whenever a consumer needs to know
"has this changed since I last looked", because it costs an integer comparison rather than a `Map`
lookup and an array walk.

## See also

- [resource-lifetimes.md](resource-lifetimes.md) — the `dispose`/`disposed` events, and why
  disposal is idempotent.
- [`tests/integration/event-propagation.test.ts`](../../tests/integration/event-propagation.test.ts)
  — the payload shapes and the actor-broadcasts rule, asserted.
- [../guide/scene-graph.md](../guide/scene-graph.md#events) — the practical usage.
