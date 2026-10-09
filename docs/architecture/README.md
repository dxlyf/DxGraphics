# Architecture

Why the library is shaped the way it is. The [guide](../guide/README.md) answers "how do I do X";
these pages answer "why is X like that", which is what you need before changing it.

| Page | Question it answers |
| --- | --- |
| [overview.md](overview.md) | What are the layers, and what is the mental model? |
| [layers.md](layers.md) | Which layer may import which, and what enforces it? |
| [renderer-interface.md](renderer-interface.md) | Why is the renderer contract structural, and how does one frame flow? |
| [scene-2d-3d.md](scene-2d-3d.md) | Why are there two scene graphs, and two cameras? |
| [resource-lifetimes.md](resource-lifetimes.md) | Who owns what, and when is it released? |
| [events.md](events.md) | Why is there one shared event map, and why is `TEvents` unconstrained? |
| [extending.md](extending.md) | How do I add a backend, a material, a generator or a loader? |

## The five design rules, and the reasoning behind each

These are stated in `src/index.ts` and repeated in
[contributing.md](../guide/contributing.md). Here they are with the *why*:

### 1. No runtime dependencies

Nothing in `src/` imports an npm package. Everything a graphics library needs — vectors,
matrices, quaternions, PNG-free image handling, event dispatch, pooling — is either written here
or provided by the platform.

The cost is real: `Vec3` is not the fastest possible vector implementation, and the visual test
runner cannot decode a PNG. The benefit is that installing the library adds **one lockfile
entry**, and that the whole library is auditable in one repository. Both the shader tool and the
visual runner document their own limits rather than reaching for a package, which is the rule
being taken seriously rather than ceremonially.

### 2. Column-major matrices, column vectors

`v' = M * v`, and `elements[column * 4 + row]`. Every matrix produced by the library uploads to
WebGL's `uniformMatrix4fv` and WGSL's `mat4x4<f32>` **verbatim**, with no transpose and no
per-backend conversion step.

That is the whole justification: the alternative (row-major, row vectors) is equally
mathematically sound, but it means every GPU upload needs a transpose, and a forgotten transpose
is a bug that produces plausible-looking wrong geometry. Choosing the GPU's layout removes an
entire category of bug. See [math-conventions.md](../guide/math-conventions.md).

### 3. Allocation-light hot paths

Mutators return `this`; read methods take an optional `target`; `Pool` recycles per-frame
objects. The convention is enforced by consistency rather than by tooling — but it is consistent
enough that "does this allocate?" is answerable by looking at the signature.

Per-frame allocation is the dominant cause of frame stutter, and it is invisible in a profiler
until it becomes GC pauses. Making the non-allocating form the *default* spelling is the only
defence that survives contact with a deadline.

### 4. Explicit lifetimes

Anything holding GPU or DOM resources extends `Disposable`, and children are released through
`addDisposable`. Ownership is stated rather than inferred, and `dispose()` documents its exact
order: `onDispose()` hook → children → callbacks.

The payoff is the two failure modes it eliminates: a double-free (disposal is idempotent, and
`addDisposable` on a disposed owner disposes the child immediately, which is what an async load
resolving after teardown needs) and a leak (a parent cannot be released while holding an
unreleased child). See [resource-lifetimes.md](resource-lifetimes.md).

### 5. Events are opt-in, on one shared map

`EventEmitter<TEvents>` and `EventDispatcher<TEvents>` both accept a map, and the scene graph
uses the single documented `CoreEventMap`. Dispatch is fully typed — `emit('viewportchange', w, h)`
checks both the name and the argument tuple — without threading a generic parameter through
`Node` → `Camera` → `PerspectiveCamera` → every user subclass.

`TEvents` is left unconstrained (`TEvents = EventMap`) so a consumer can supply any map, and
`EventName<TEvents>` resolves to the string-literal union of its keys. See
[events.md](events.md).

## The layer map

```
                 ┌───────────────────────────────────────────┐
   application   │  scene · animation · controls · picking   │
                 │  assets · text · effects                  │
                 └────────────────────┬──────────────────────┘
                                      │  structural interfaces only
                 ┌────────────────────▼──────────────────────┐
   renderer      │  interfaces · core · canvas2d · svg        │
                 │  (webgl · webgpu — own entry points)      │
                 └────────────────────┬──────────────────────┘
                                      │
                 ┌────────────────────▼──────────────────────┐
   data          │  geometry · materials · textures · shaders │
                 └────────────────────┬──────────────────────┘
                                      │
                 ┌────────────────────▼──────────────────────┐
   foundation    │  core (nodes, events, lifecycle)          │
                 │  math · utils · constants · types         │
                 └───────────────────────────────────────────┘
```

Dependencies point **downward only**, and the two arrows that cross a band are drawn as
"structural interfaces only" because they are the ones a change is most likely to break. The
full rule, and what enforces it, is in [layers.md](layers.md).

## Reading order for a change

1. **Find the layer.** Which band does this belong to? If it needs something from a lower band,
   that is fine. If it needs something from a *higher* one, the design is wrong — see
   [layers.md](layers.md).
2. **Read that layer's `types.ts`.** The structural contracts are declared there, and they are
   the interface you are extending.
3. **Check the lifetime.** Does the new thing own a resource? Extend `Disposable` and say what it
   owns — see [resource-lifetimes.md](resource-lifetimes.md).
4. **Check whether it allocates per frame.** If it is on a hot path, follow rule 3.
5. **Write the test at the right level.** A seam → `tests/integration/`; one module →
   `tests/unit/`. See [testing.md](../guide/testing.md).
6. **If it is performance-sensitive, add a bench entry.** See
   [`benchmarks/README.md`](../../benchmarks/README.md).
