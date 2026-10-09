/**
 * Geometry modifiers: post-process an existing geometry.
 *
 * Every modifier follows the same shape: a `*Modifier` **class** holding options
 * plus a `modify(geometry)` method, and a matching free **function** for callers
 * that prefer a pipeline of calls. Modifiers return a **new** geometry and never
 * mutate the input, so a source mesh can feed several modifiers.
 *
 * | Modifier | Changes topology? | Use it for |
 * | --- | --- | --- |
 * | `SubdivisionModifier` | yes (×3 faces per pass) | smoothing a low-poly mesh |
 * | `SimplifyModifier` | yes (fewer vertices) | LOD generation |
 * | `TessellateModifier` | yes (more vertices, same shape) | displacement, vertex effects |
 * | `EdgeSplitModifier` | yes (only at creases) | hard-surface shading |
 * | `MergeModifier` | yes (fewer vertices) | welding an imported mesh |
 *
 * @packageDocumentation
 */

export { subdivide, SubdivisionModifier } from './SubdivisionModifier';
export type { SubdivisionOptions } from './SubdivisionModifier';

export { simplify, SimplifyModifier } from './SimplifyModifier';
export type { SimplifyOptions } from './SimplifyModifier';

export { tessellate, TessellateModifier } from './TessellateModifier';
export type { TessellateOptions, TessellateResult } from './TessellateModifier';

export { splitEdges, EdgeSplitModifier } from './EdgeSplitModifier';
export type { EdgeSplitOptions, EdgeSplitResult } from './EdgeSplitModifier';

export { mergeVertices, MergeModifier } from './MergeModifier';
export type { MergeOptions, MergeVerticesResult } from './MergeModifier';
