/**
 * Material-layer types.
 *
 * The enums mirror the renderer's `CompareFunction`/`BlendFactor` vocabulary but
 * are declared locally so `src/materials` never imports `src/renderer`: the
 * material layer is *below* the renderer in the dependency order, and keeping it
 * independent is what lets a headless test inspect a material without pulling in
 * a backend.
 *
 * @packageDocumentation
 */

import type { Material } from './Material';

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

/** Which faces a material draws. */
export enum Side {
  /** Draw front faces only (default); back faces are culled. */
  FrontSide = 'front',
  /** Draw back faces only; front faces are culled. */
  BackSide = 'back',
  /** Disable face culling and draw both faces. */
  DoubleSide = 'double',
}

/* -------------------------------------------------------------------------- */
/* Depth / stencil                                                            */
/* -------------------------------------------------------------------------- */

/** Comparison functions shared by the depth and stencil tests. */
export enum DepthFunc {
  Never = 'never',
  Less = 'less',
  Equal = 'equal',
  LessEqual = 'less-equal',
  Greater = 'greater',
  NotEqual = 'not-equal',
  GreaterEqual = 'greater-equal',
  Always = 'always',
}

/** Comparison function applied by the stencil test. */
export enum StencilFunc {
  Never = 'never',
  Less = 'less',
  Equal = 'equal',
  LessEqual = 'less-equal',
  Greater = 'greater',
  NotEqual = 'not-equal',
  GreaterEqual = 'greater-equal',
  Always = 'always',
}

/** Action taken by the stencil test for each outcome. */
export enum StencilOp {
  /** Keep the current value. */
  Keep = 'keep',
  /** Write zero. */
  Zero = 'zero',
  /** Write the reference value. */
  Replace = 'replace',
  /** Increment, saturating at the maximum. */
  Increment = 'increment',
  /** Increment, wrapping around. */
  IncrementWrap = 'increment-wrap',
  /** Decrement, saturating at zero. */
  Decrement = 'decrement',
  /** Decrement, wrapping around. */
  DecrementWrap = 'decrement-wrap',
  /** Bitwise-invert the current value. */
  Invert = 'invert',
}

/* -------------------------------------------------------------------------- */
/* Blending                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Blend factors.
 *
 * Named `Blending` for the material vocabulary; the renderer's equivalent enum is
 * `BlendFactor`.
 */
export enum Blending {
  Zero = 'zero',
  One = 'one',
  SrcColor = 'src-color',
  OneMinusSrcColor = 'one-minus-src-color',
  DstColor = 'dst-color',
  OneMinusDstColor = 'one-minus-dst-color',
  SrcAlpha = 'src-alpha',
  OneMinusSrcAlpha = 'one-minus-src-alpha',
  DstAlpha = 'dst-alpha',
  OneMinusDstAlpha = 'one-minus-dst-alpha',
  ConstantColor = 'constant-color',
  OneMinusConstantColor = 'one-minus-constant-color',
  ConstantAlpha = 'constant-alpha',
  OneMinusConstantAlpha = 'one-minus-constant-alpha',
  SrcAlphaSaturate = 'src-alpha-saturate',
}

/** Blend equations (`blendEquation`). */
export enum BlendEquation {
  Add = 'add',
  Subtract = 'subtract',
  ReverseSubtract = 'reverse-subtract',
  Min = 'min',
  Max = 'max',
}

/** How an environment map combines with the shaded colour. */
export enum CombineOperation {
  /** `color * envMap`. */
  Multiply = 'multiply',
  /** `mix(color, envMap, reflectivity)`. */
  Mix = 'mix',
  /** `color + envMap`. */
  Add = 'add',
}

/* -------------------------------------------------------------------------- */
/* Depth packing                                                              */
/* -------------------------------------------------------------------------- */

/** How a depth-only pass writes its depth value. */
export enum DepthPacking {
  /** Write the raw depth into every channel. */
  Basic = 'basic',
  /** Pack `[0, 1]` depth into RGBA for higher precision. */
  RGBA = 'rgba',
}

/* -------------------------------------------------------------------------- */
/* Parameters / serialisation                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A partial material parameter bag.
 *
 * Deliberately open (`unknown` values, arbitrary keys) because `setValues` is the
 * user-facing entry point for literals such as `{ color: '#ff0000' }` and is
 * specified to *ignore and log* unknown keys rather than reject the whole bag at
 * compile time.
 */
export type MaterialParameters = Record<string, unknown>;

/**
 * A material description accepted by `MaterialFactory.createMaterial`.
 *
 * Either a bare type name (`'MeshStandardMaterial'`) or a record carrying the
 * type plus the parameters to apply.
 */
export interface MaterialDescriptor {
  /** Registered material type name, e.g. `'MeshStandardMaterial'`. */
  type: string;
  /** Optional name applied to the instance. */
  name?: string;
  /** Parameters forwarded to `Material.setValues`. */
  parameters?: MaterialParameters;
  /** Any further keys are treated as parameters. */
  [key: string]: unknown;
}

/** Serialisable form of a material. */
export interface MaterialJSON {
  /** Material class name, e.g. `'MeshStandardMaterial'`. */
  type: string;
  /** Optional user name. */
  name?: string;
  /** Stable identifier of the source material. */
  id?: string;
  /** Serialised parameter values, keyed by property name. */
  parameters: Record<string, unknown>;
}

/** Constructor signature every registered material type must satisfy. */
export interface MaterialConstructor<T extends Material = Material> {
  new (parameters?: MaterialParameters): T;
}
