/**
 * Material layer.
 *
 * Backend-neutral descriptions of how a surface is shaded and how the
 * fixed-function pipeline must be configured. Nothing here imports
 * `src/renderer`, so a material can be created, cloned and diffed in a Node test
 * run with no GPU; `RenderState` is the bridge the backends consume.
 *
 * ```ts
 * import { MeshStandardMaterial, RenderState, BlendMode } from '@dxyl/graphics';
 *
 * const material = new MeshStandardMaterial({ roughness: 0.35 });
 * const requested = RenderState.fromMaterial(material);
 * requested.hash();       // stable key for sorting/bucketing draws
 * ```
 *
 * | Group | Types |
 * | --- | --- |
 * | Mesh | `MeshBasicMaterial`, `MeshLambertMaterial`, `MeshPhongMaterial`, `MeshStandardMaterial`, `MeshPhysicalMaterial` |
 * | Primitives | `BasicMaterial` (abstract), `LineBasicMaterial`, `LineDashedMaterial`, `PointsMaterial`, `SpriteMaterial` |
 * | Custom programs | `ShaderMaterial`, `RawShaderMaterial` |
 * | Special purpose | `ShadowMaterial`, `DepthMaterial`, `NormalMaterial` |
 * | Infrastructure | `Material`, `MaterialFactory`, `BlendMode`, `RenderState`, `types` |
 *
 * ## Reactivity
 *
 * Fields are plain data properties and `version` is an explicit revision bumped by
 * `markNeedsUpdate()`, `needsUpdate = true` or `setValues()`. See `Material`'s
 * module documentation for why that trade-off was chosen over per-field setters.
 *
 * ## Name resolution
 *
 * `RenderState` also exists in `renderer/core`, and `PixelFormat`/`TextureFilter`
 * exist in `renderer/interfaces/types`. `export *` treats a duplicated name as
 * ambiguous, so a module that imports both barrels — `src/index.ts` does — cannot
 * re-export those names. Import them from `@dxyl/graphics/materials` (or the
 * owning renderer module) when both layers are in scope.
 *
 * @packageDocumentation
 */

export * from './types';
export * from './BlendMode';
export * from './RenderState';
export * from './Material';
export * from './BasicMaterial';
export * from './LineBasicMaterial';
export * from './LineDashedMaterial';
export * from './PointsMaterial';
export * from './SpriteMaterial';
export * from './MeshBasicMaterial';
export * from './MeshLambertMaterial';
export * from './MeshPhongMaterial';
export * from './MeshStandardMaterial';
export * from './MeshPhysicalMaterial';
export * from './ShaderMaterial';
export * from './RawShaderMaterial';
export * from './ShadowMaterial';
export * from './DepthMaterial';
export * from './NormalMaterial';
export * from './MaterialFactory';
