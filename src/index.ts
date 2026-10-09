/**
 * `@dxyl/graphics` — a dependency-free 2D/3D graphics library with pluggable
 * backends.
 *
 * ## What it is
 *
 * One library that renders the same scene through **Canvas2D**, **SVG**,
 * **WebGL** (1 and 2) or **WebGPU**, chosen at runtime by `detectBackend()`. The
 * layers above the renderer are backend-agnostic: math, geometry, materials,
 * textures, shaders, scene graph, animation, controls, picking, assets, text and
 * post-processing do not import a backend.
 *
 * ## Design rules
 *
 * 1. **No runtime dependencies.** Nothing in `src/` imports an npm package.
 * 2. **Column-major matrices, column vectors.** `v' = M * v`, right-handed
 *    rotations: `Mat4.makeRotationZ(Math.PI / 2)` maps `+X` to `+Y`. Every matrix
 *    uploads to WebGL/WGSL verbatim.
 * 3. **Allocation-light hot paths.** Mutators return `this`; read methods take an
 *    optional `target`. `Pool` recycles per-frame objects.
 * 4. **Explicit lifetimes.** Anything holding GPU or DOM resources extends
 *    `Disposable`; children are released with `addDisposable`.
 * 5. **Events are opt-in.** `EventEmitter`/`EventDispatcher` share one documented
 *    event map (`CoreEventMap`), so `emit(name, ...args)` is fully typed.
 *
 * ## Quick start
 *
 * ```ts
 * import {
 *   Scene,
 *   PerspectiveCamera,
 *   Mesh,
 *   MeshStandardMaterial,
 *   BoxGeometry,
 *   WebGLRenderer,
 *   detectBackend,
 * } from '@dxyl/graphics';
 *
 * const renderer = new WebGLRenderer({ canvas: '#stage' });
 * const scene = new Scene({ background: '#101018' });
 * const camera = new PerspectiveCamera(50, renderer.aspect, 0.1, 100);
 * camera.position.set(0, 0, 5);
 *
 * scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
 *
 * renderer.setAnimationLoop((frame) => {
 *   mesh.rotation.y += frame.delta;
 *   renderer.render(scene, camera);
 * });
 * ```
 *
 * ## Package layout
 *
 * | Namespace | Contents |
 * | --- | --- |
 * | `math` | vectors, matrices, quaternions, colours, primitives, intersections |
 * | `geometry` | buffer geometry, 2D curves/paths/shapes, 3D primitives, modifiers |
 * | `materials` | material descriptions and GPU render state |
 * | `textures` | texture types, samplers and formats |
 * | `shaders` | shader descriptors, chunk registry, compilation cache |
 * | `scene` | 2D and 3D scene objects, cameras and lights |
 * | `renderer` | backend interfaces plus Canvas2D, SVG, WebGL and WebGPU |
 * | `animation` | clips, mixers, keyframe tracks, tweens, timelines, easing |
 * | `controls` | camera, pointer and gesture controls |
 * | `picking` | raycasting, 2D hit testing and GPU picking |
 * | `assets` | loaders for images, models, fonts and data |
 * | `text` | fonts, glyph atlases, layout and SDF text |
 * | `effects` | post-processing passes, shadows, fog and particles |
 * | `core` | events, lifecycle, timing, scene-graph root, cameras |
 * | `utils` | math, array, object, path, DOM, browser, logging helpers |
 * | `wasm` | optional WebAssembly acceleration modules |
 *
 * @packageDocumentation
 */

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

export * from './version';
export * from './constants';
export type * from './types';

/* -------------------------------------------------------------------------- */
/* Layers                                                                     */
/* -------------------------------------------------------------------------- */

/*
 * The layer barrels below deliberately do not agree on every name: several layers
 * describe the same concept from their own angle (`MaterialLike`, `GeometryLike`,
 * `TextureLike` and friends are structural views each layer declares so it needs no
 * import from the others), and a few helpers are implemented twice for good reasons
 * (the renderer's private `hashString` exists so the WebGL backend has no dependency
 * on the public utility layer's hashing contract).
 *
 * `export *` from both would silently drop the later name, leaving
 * `import { MaterialLike } from '@dxyl/graphics'` broken with a confusing TS2308.
 * So the names that collide are listed explicitly below with the layer that owns
 * them; everything else is re-exported wholesale.
 *
 * The rule for choosing an owner is: the layer that *defines* the value (runtime
 * exports win over type-only ones), then the layer a user of the public API would
 * look in first. When a duplicate existed purely because a layer needed a local
 * view of someone else's concept, the defining layer wins and the local view stays
 * reachable through that layer's own barrel (e.g. `@dxyl/graphics/scene`).
 */

export * from './utils';
export * from './math';
export * from './core';
export * from './geometry';
export * from './materials';
export * from './textures';
export * from './shaders';
export * from './scene';
export * from './renderer';
export * from './animation';
export * from './controls';
export * from './picking';
export * from './assets';
export * from './text';
export * from './effects';
export * from './wasm';

/* -------------------------------------------------------------------------- */
/* Collision resolution                                                       */
/* -------------------------------------------------------------------------- */

/*
 * Each name below is exported by more than one layer. The owner is the layer that
 * *defines* the concept; a layer that merely redeclares a structural view of someone
 * else's concept keeps its local copy (that is what a backend is written against) but
 * does not win the public name.
 *
 * Every one of these is also reachable through its own layer barrel, so nothing is
 * lost: `import type { MaterialLike } from '@dxyl/graphics/renderer'` still works for
 * code written against the backend contract.
 *
 * Types and values are listed separately because `isolatedModules` requires a
 * type-only re-export to say so (`export type { ... }`); mixing them would make the
 * project's own `tsc --noEmit` fail even though the emitted JavaScript is fine.
 */

/* ---------------------------------------------------------------- values --- */

export { polygonArea, isPowerOfTwo, hashString } from './math';
export { LifecycleState, describeRenderable } from './core';
export { isNode, isArrayLike, createCanvas, smoothstep, smootherstep, cubicBezier } from './utils';
export { computeBoundingSphereFromPoints } from './geometry';

export { BlendMode, RenderState, BlendEquation } from './materials';

/*
 * `PixelFormat` and `TextureFilter` are **enums** (runtime values), not types, so they
 * must be re-exported as values — an `export type` of an enum emits nothing and leaves
 * the name `undefined` at run time.
 *
 * `PixelFormat` is also the one colliding name that is *not* a duplicate of the same
 * concept, so aliasing is the honest resolution:
 *
 * - `textures.PixelFormat` describes how pixel **data** is laid out in memory (used by
 *   `DataTexture`, `TextureFormat` and the loaders);
 * - `renderer.PixelFormat` describes a GPU **internal** format (`BGRA8`,
 *   `Depth24Stencil8`, `RGBA16F`) used by render targets and backends.
 *
 * The plain name goes to `textures`, which is what a caller writing a texture reaches
 * for. The GPU enum is re-exported as `GPUPixelFormat`, imported from its *defining
 * module* rather than from `./renderer` — `export * from './renderer'` would carry the
 * original name along and re-introduce the collision. It stays unaliased in
 * `@dxyl/graphics/renderer`.
 */
export { PixelFormat as GPUPixelFormat } from './renderer/interfaces/types';

export {
  PixelFormat,
  TextureFilter,
  computeMipmapCount,
  getTextureByteSize,
  isDepthFormat,
  isFloatFormat,
  isIntegerFormat,
} from './textures';

export { FontLoader, fontLoader } from './assets';
export { parseBMFont, parseBMFontJSON, parseBMFontText } from './text';

/*
 * `HitTest2D` exists twice: `math/Intersection` declares a *type* describing a hit
 * result, and `picking/HitTest2D` declares a *class* that produces one. The class is
 * the one a caller instantiates, so it owns the public name; the math type stays
 * available from `@dxyl/graphics/math`.
 */
export { HitTest2D } from './picking';

/* ----------------------------------------------------------------- types --- */

export type { RectLike, RayLike, BoundsIntersection } from './math';
export type { IDisposable, BoundingVolumeOptions, EventMap, FogLike, EventTargetLike } from './core';

/*
 * Structural views. `renderer`, `animation`, `picking` and the others each declare
 * their own so they can be compiled and shipped independently; the public name comes
 * from the layer that models the concept, because that is the definition a caller
 * writing new code should target.
 */
export type {
  AttributeLike,
  GeometryLike,
  MaterialLike,
  TextureLike,
  SkeletonLike,
  Vector2Like,
  Vector3Like,
  HitTestOptions,
  Node2DLike,
  RaycasterLike,
} from './scene';

export type { CameraLike } from './renderer';
export type { Object3DLike } from './picking';
export type { ShaderStage, UniformValue } from './shaders';
export type { CubeFace } from './textures';

export type { PostProcessOptions, SceneLike, RenderPassOptions, PointLike } from './effects';
export type { FontLoadOptions } from './assets';

/* -------------------------------------------------------------------------- */
/* Convenience umbrella                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every module namespace in one object.
 *
 * Useful for browsers, playground code and `console` poking:
 *
 * ```ts
 * import { DXYL } from '@dxyl/graphics';
 * const v = new DXYL.math.Vec3(1, 2, 3);
 * ```
 *
 * Prefer named imports in application code: the namespace object defeats
 * tree-shaking because it references every module eagerly.
 */
export * as DXYL from './namespace';
