# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- releases -->

## [Unreleased]

### Added

- **Core** — `EventEmitter`/`EventDispatcher` with a shared, fully typed
  `CoreEventMap`; `Disposable` with child ownership and idempotent teardown;
  `Lifecycle` as an async state machine; `Clock`, `Timer`, `FrameAccumulator` and
  `Countdown`; `Node`, `Scene` and `Camera`; `Layers`, `Transform`,
  `BoundingVolume`; `Renderable`/`Updateable` mixins and `UpdateScheduler`.
- **Math** — `Vec2`/`Vec3`/`Vec4`, `Mat2`/`Mat3`/`Mat4`, `Quat`, `Euler`, `Color`,
  `Rect`, `Box2`, `Box3`, `Sphere`, `Plane`, `Ray`, `Line2`, `Line3`, `Triangle`,
  `Frustum` and the intersection record types. Column-major storage, column
  vectors, right-handed rotations.
- **Geometry** — `BufferAttribute`, `InterleavedBuffer`, `BufferGeometry`,
  `InstancedBufferGeometry`, the authorable `Geometry`; 2D `Curve` hierarchy,
  `Path`, `Shape`, `Polygon`, `Polyline`, boolean operations, ear-clipping
  triangulation and adaptive tessellation; 3D primitives, curves, modifiers and
  utilities.
- **Materials / textures / shaders** — the full material family from
  `MeshBasicMaterial` to `MeshPhysicalMaterial`, plus shader-based, shadow, depth
  and normal materials; a comparable `RenderState`; every texture type, samplers
  and the format enumerations; a shader descriptor, chunk registry with include
  resolution, shader library and a bounded compile cache.
- **Scene** — 2D nodes, sprites, text, shapes, paths, meshes, particles, cameras
  and lights; 3D objects, meshes, instanced and skinned meshes, points, lines,
  sprites, cameras, six light types, bones and skeletons.
- **Renderer** — `IRenderer` and friends, a shared `AbstractRenderer`, render
  list/queue/state/pipeline, and four backends: Canvas2D, SVG, WebGL (1 and 2) and
  WebGPU, plus backend detection and context helpers.
- **Animation** — clips, mixers, actions, keyframe tracks and interpolants,
  property binding, tweens, timelines and a complete easing set.
- **Controls** — orbit, map, trackball, fly and first-person camera controls;
  pointer and touch controls; multi-touch gesture controls.
- **Picking** — `Raycaster`, 2D hit testing, GPU picking, bounding-box picking and
  per-primitive pickers.
- **Assets** — `AssetManager`, a bounded LRU `Cache`, and loaders for files,
  images, textures, fonts, JSON, GLTF/GLB, OBJ, FBX, STL, PLY and SVG.
- **Text** — fonts, glyphs, a glyph atlas, text layout, bitmap fonts, SDF
  generation and a renderer-agnostic text renderer.
- **Effects** — an effect composer with render, shader, bloom, blur, FXAA, SSAO and
  outline passes; shadow maps with cascades; linear and exponential fog; a pooled
  particle system, emitters and particle materials.
- **WASM** — a module loader with magic-number validation, caching and a graceful
  unsupported path.
- **Tooling** — `pnpm build` (assets → types → bundle → verify), `verify-build.mjs`
  which loads the emitted ESM/CJS and rejects any external import, a development
  watcher, a release script, an API index generator, a shader-source generator, and
  an asset copier.
- **Verification scripts** — `verify:structure` (the prescribed directory tree and
  root configs are all present), `verify:deps` (no file under `src/` imports a bare
  specifier, so the zero-runtime-dependency guarantee cannot rot) and
  `verify:encoding` (no source carries CP1252 mojibake). `pnpm verify` chains all
  three with the typecheck, tests and build.

### Added

- **Layer subpath exports.** `@dxyl/graphics/materials`, `…/math`, `…/scene`,
  `…/renderer` and the other fourteen layers now resolve in both ESM and CommonJS, each
  with its own type declarations. The documentation had been telling readers to import
  from these paths while the `exports` map admitted only the root entry and
  `./package.json`, so every one of them failed with
  `ERR_PACKAGE_PATH_NOT_EXPORTED` — the documented escape hatch for cross-layer name
  collisions (`MaterialLike` exists in both `scene` and `renderer`) did not work.
  `vite.config.ts` now emits one entry per layer barrel into `dist/<format>/<layer>/`,
  the manifest declares all seventeen, and `scripts/verify-build.mjs` fails the build if
  the two lists disagree or an artifact is missing.
- `scripts/verify-brand.mjs`, a check that the package name, the `DXYL` namespace
  export, the `data-dxyl-*` SVG attributes and the `__DXYL_GRAPHICS__` flag all agree
  with the scope declared in `package.json`.

### Changed

- **The package is renamed from `@lyf/graphics` to `@dxyl/graphics`.** The brand also
  appears in five other observable places, all renamed to match so the package cannot
  present two identities:
  - the namespace export `LYF` is now **`DXYL`** — `import { DXYL } from '@dxyl/graphics'`;
  - `SVGRenderer`'s DOM attributes `data-lyf-renderer` / `-background` / `-world` /
    `-node` are now **`data-dxyl-*`**. Any user CSS selecting the old names must be
    updated;
  - the embedder flag `window.__LYF_GRAPHICS__` is now **`window.__DXYL_GRAPHICS__`**;
  - the canvas hint property `__lyfWillReadFrequently` is now
    **`__dxylWillReadFrequently`**;
  - `package.json`'s `author`, the README copyright line and the CHANGELOG's
    repository URL now use `dxyl`.

  `LYF_TEST_LOG` and the playground's `lyf-playground-<id>.png` download filename were
  deliberately left alone, being a test-only switch and a local filename.
  `scripts/verify-brand.mjs` joins `pnpm verify` to keep all of these agreeing with
  the scope declared in `package.json`.
- The canvas `willReadFrequently` hint is now read through `READ_FREQUENTLY_FLAG`
  rather than a second copy of the literal string, so the marker `createCanvas`
  writes and the one `getContext` reads can no longer drift apart.
- Shader sources ship as TypeScript string constants rather than `.glsl` imports,
  so the library needs no bundler plugin.
- `scripts/` are TypeScript, run through `node --experimental-strip-types`.
- The root barrel resolves its cross-layer name collisions explicitly. Several
  layers legitimately declare the same name (each declares its own structural view
  such as `MaterialLike` or `GeometryLike` rather than importing another layer's),
  which previously made `export *` drop the shadowed name and left
  `import { MaterialLike } from '@dxyl/graphics'` broken. `src/index.ts` now lists
  every colliding name with the layer that owns it; each layer keeps its local copy,
  reachable through its own barrel.
- Vite plugin options use `minify` (vite-plugin-glsl 1.6 renamed it from
  `compress`).
- `BufferGeometry`-adjacent geometry generation de-duplicates option interfaces:
  `ComputeNormalsOptions`, `ComputeTangentsOptions` and `WireframeOptions` are
  declared once in `geometry/3d/types.ts` and imported, rather than declared again
  in each utility.

### Fixed

- **The particle system never emitted anything.** Four independent defects, each of which
  alone was enough to leave the canvas blank, and none of which raised an error:
  - **`ParticleSystem`'s free list was never initialised**, so `allocateSlot()` always
    returned `-1` and `spawn()` produced zero particles for the life of the system. It hid
    because `reset()` calls `killAll()`, which *did* populate the list — so anything that
    reset before spawning worked, and only a fresh, auto-started system was silent.
  - **The free list handed out the highest slots first**, so the live particles sat at
    `capacity - 1` downward while the documented invariant — "live particles are
    `0 .. getAliveCount() - 1`" — told every consumer to read from index `0` and find
    zeros. Allocation now fills from the front, which is what makes the invariant true.
  - **`Float32BufferAttribute` copied its input instead of adopting it.** The
    `ParticleSystem` keeps its own simulation arrays and exposes
    `Float32BufferAttribute` views of them, so it writes through one buffer and consumers
    read another. All seven attributes — position, velocity, colour, size, rotation, UV
    and life — read as zeros forever, with both buffers individually valid. A typed array
    of the matching type is now adopted by reference; plain arrays and mismatched types
    are still converted.
  - **`emissionRate` defaulted to `10` and beat the emitter's own `rate`.** An
    `emitter: { rate: 200 }` was silently overridden by a system-level default the caller
    never set. `0` now means "unspecified", so the emitter's rate is used unless the system
    explicitly sets one.
- **A burst-only emitter could never fire.** `start()` enabled emission only when
  `emissionRate > 0`, but the burst branch of `update()` is itself guarded by `emitting`,
  so a system configured with `emissionRate: 0` and a `burst` was permanently silent.
  Emission is now enabled when there is anything to emit — a rate or a burst.
- **`ParticleSystem` had no way to stop emitting while letting the live particles
  finish.** `stop()` freezes the whole simulation, so the existing particles hang in
  place; there was no "turn the tap off" operation. Added `stopEmitting()` and
  `resumeEmitting()`, which toggle emission without touching `running` or restarting the
  emission clock.
- `ParticleSystem.emissionRate`'s documentation said it defaulted to `10`; it now
  documents `0` as "use the emitter's rate".
- **`Clock.getElapsedTime()` and `Clock.getDeltaMilliseconds()` were advancing reads.**
  Both called `getDelta()` first, so merely *reading* a value stepped the clock and
  produced a delta. On a `ManualClock` this was not a subtle bug: with no argument
  `getDelta()` defaulted to `performance.now()`, and the manual clock's time base starts
  at timestamp `0`, so `clock.setTime(0); clock.advance(0.5); clock.getElapsedTime()`
  returned roughly the age of the browser process (~2.35 s) instead of `0.5`. That is
  what made `examples/animation` throw
  `keyframe sampling is wrong: expected 5 at t=0.5, got 7.818999999999999` on load, and
  it was also why the example's overlay advanced the clock a second time per frame by
  reading `getDeltaMilliseconds()`. Both are now reads, and `advance()`/`getDelta(now)`
  are the only things that move time.
- **`ManualClock` inherited the wall-clock `Clock`'s timestamp defaults.** `start()`,
  `getDelta()` and `getDeltaMilliseconds()` defaulted their `now` to `Clock.now()`, so
  any call that omitted the argument mixed wall time into a clock whose whole purpose is
  determinism. `ManualClock` now defaults to its own time base.
- **`ManualClock` silently clamped every step to `MAX_DELTA` (0.1 s).** `advance(0.25)`
  moved the clock by 0.1 s and `advance(10)` did the same, so a test could not step time
  by the amount it asked for. The clamp exists to stop a backgrounded tab teleporting an
  animation, which is a property of the wall-clock `Clock`; `ManualClock` disables it.
- **`Clock.elapsed` accumulated the raw wall-clock gap while `getDelta()` returned the
  clamped delta**, so the deltas a caller was handed never summed to `getElapsedTime()`
  after a stall. `elapsed` now accumulates exactly the delta that was reported.
- A plain `new Timer(interval)` fires once and then stops, which broke the animation
  example's recurring halo pulse. `TimerOptions.repeat` defaults to `false`, so the timer
  sets `completed`/`running = false` after its first tick and every later `update()`
  returns `false` immediately — with no error. `examples/animation` and
  `docs/guide/animation.md` both registered an `onTick` handler without
  `{ repeat: true }`, so the pulse fired exactly once per page load. The default is
  deliberate and now called out in the guide; both call sites pass `repeat: true`.
- **`Camera3D` never refreshed its `frustum`, so anything that culled through it
  rejected the whole scene.** A `Frustum` starts with all six planes at
  `normal = (0, 0, 1), constant = 0`, and `distanceToSphere` against those is
  `-radius` — negative for any non-empty volume. `camera.frustum` was only built by an
  explicit `updateFrustum()` call, so the documented
  `camera.updateMatrixWorld(true)` left it stale and `intersectsSphere` returned
  `false` for every object. This is what made `examples/3d-basic` render a blank
  canvas: it culled 100% of its geometry with no error. `updateMatrixWorld` now
  rebuilds the frustum after refreshing `matrixWorldInverse`.
- **`BoundingVolume.update()` required an explicit matrix.** `box`/`sphere` are the
  world-space pair and stay empty (`Sphere.makeEmpty()` sets `radius = -1`) until
  `update()` runs, while `setFromBox`/`setFromPoints`/`setFromSphere` fill only the
  *local* pair. Reading `volume.sphere` after `setFromBox` therefore silently rejected
  everything. The matrix now defaults to the identity, which is the correct reading of
  "the local bounds are the world bounds" for an untransformed object.
- **Cylinder/cone radius interpolation was inverted**, so a `ConeGeometry` put its
  apex at the bottom and its base at the top. `radiusTop` is now the top ring.
- **Six generators wound their triangles inside out** (`PlaneGeometry`,
  `CylinderGeometry`, `ConeGeometry`, `CapsuleGeometry`, `TorusGeometry`,
  `TubeGeometry`): correct with back-face culling disabled, invisible with it on.
  `GeometryBuilder` now derives the winding from the vertex normals on every build
  via `correctWinding`, so a generator's incidental `(u, v)` handedness can no
  longer ship an inverted mesh. `CircleGeometry` and `RingGeometry`, which had been
  "fixed" the wrong way during the investigation, are back to correct.
- **The icosahedron's hard-coded face table referenced antipodal vertex pairs**,
  and the dodecahedron's was incomplete. Both are now derived from the
  connectivity (and, for the dodecahedron, as the dual of the icosahedron), with
  Euler's formula and outward winding asserted in the test suite.
- **`CatmullRomCurve3` did not interpolate its control points.** The non-uniform
  Barry–Goldman weights were wrong: the curve passed through neither endpoint of an
  interior interval. Replaced with the standard knot-parameterised form.
- **`computeNormals({ mode: 'flat' })` left a stale `normal` attribute** with the
  pre-expansion element count after converting the geometry to non-indexed.
- **`Camera3D` had no `viewMatrix`**, which the renderer contract
  (`CameraLike.viewMatrix`) reads. Without it a `PerspectiveCamera` silently fell
  back to the 2D pan/zoom path in both the WebGL backend and the Canvas2D 3D branch.
- **Neither scene graph implemented `collectRenderables`**, so the renderers' fallback
  traversal only walked `children` one level deep and anything inside a group was
  never submitted. `Scene` and `Scene3D` now traverse depth-first, skipping a hidden
  node together with its subtree.
- `Frustum.intersectsBox` and `intersectsSphere` disagreed on the same volume: the
  box test rejected a box only when its *least* inside corner was outside a plane,
  so a volume behind the near plane could pass. Both now use the standard
  most-inside-corner test.
- `Timeline.on` erased its listener's argument types to `(...args: unknown[]) => void`,
  which rejected the natural `(name: string) => ...` label listener.
- `verify-build.mjs` rejected every correct source map: it treated any `..` segment
  in `sources` as escaping the package, but those paths are relative to the map file
  and legitimately resolve back into `src/`. It now resolves each entry first.
- `tsconfig.build.json` compiled with `types: []`, so `process` and `NodeJS` were
  undeclared and the type-declaration stage could not run.
- `Glyph` mixed `??` with `&&` without parentheses, which esbuild rejects outright
  during bundling.

[Unreleased]: https://github.com/dxyl/graphics/compare/main...HEAD
