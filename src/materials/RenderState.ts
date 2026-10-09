/**
 * `RenderState` — the GPU state a material implies.
 *
 * Backends keep one *current* {@link RenderState} and diff the *requested* one
 * against it, so redundant driver calls disappear:
 *
 * ```ts
 * const requested = RenderState.fromMaterial(material);
 * const changed = current.diff(requested);      // ['depthWrite'] and friends
 * if (changed.length > 0) apply(current, requested, changed);
 * current.copy(requested);
 * ```
 *
 * ## Contract
 *
 *  - A state holds **only** the members a material can influence:
 *    `depthTest`, `depthWrite`, `depthFunc`, `blending`, `blendSrc`, `blendDst`,
 *    `blendEquation`, `cullFace`, `frontFace`, `colorWrite`, `alphaToCoverage` and
 *    `polygonOffset`. Viewport, scissor, line width and pixel ratio belong to the
 *    renderer, not to a material, and are deliberately absent.
 *  - Every member is a discrete setting, so comparisons are **exact**: no epsilon
 *    is involved and `equals` is transitive.
 *  - `diff` reports the changed member names in declaration order; a backend may
 *    apply only those and then {@link RenderState.copy} the requested state.
 *  - {@link RenderState.hash} is a stable numeric key suitable for sorting draws
 *    and for cache keys.
 *
 * @packageDocumentation
 */

import { hashString } from '../utils/MathUtils';
import { BlendEquation, Blending, DepthFunc, Side } from './types';
import { BlendMode, getBlendFactors } from './BlendMode';

/** Face-culling modes as they reach the driver. */
export enum CullFace {
  /** No culling. */
  None = 'none',
  /** Cull front faces. */
  Front = 'front',
  /** Cull back faces. */
  Back = 'back',
  /** Cull both; used to write depth without drawing. */
  FrontAndBack = 'front-and-back',
}

/** Front-face winding order. */
export enum FrontFace {
  /** Counter-clockwise is the front face (the library's convention). */
  CounterClockwise = 'ccw',
  /** Clockwise is the front face. */
  Clockwise = 'cw',
}

/**
 * Structural view of the material members {@link RenderState.fromMaterial} reads.
 *
 * Declared structurally so the state can be built from a material, a material-like
 * record or a test double.
 */
export interface MaterialStateLike {
  /** `true` when fragments are depth-tested. */
  depthTest: boolean;
  /** `true` when passing fragments write depth. */
  depthWrite: boolean;
  /** Comparison function used by the depth test. */
  depthFunc: DepthFunc;
  /** Sampled faces. */
  side: Side;
  /** Named blend preset. */
  blending: BlendMode;
  /** Source factor used when {@link blending} is `CustomBlending`. */
  blendSrc: Blending;
  /** Destination factor used when {@link blending} is `CustomBlending`. */
  blendDst: Blending;
  /** Equation used when {@link blending} is `CustomBlending`. */
  blendEquation: BlendEquation;
  /** `true` when the colour buffer is written. */
  colorWrite: boolean;
  /** `true` when coverage-based antialiasing replaces the alpha test. */
  alphaToCoverage: boolean;
  /** `true` when polygon offset is applied. */
  polygonOffset: boolean;
}

/** Names of every compared member, in declaration order. */
const MEMBERS: readonly string[] = [
  'depthTest',
  'depthWrite',
  'depthFunc',
  'blending',
  'blendSrc',
  'blendDst',
  'blendEquation',
  'cullFace',
  'frontFace',
  'colorWrite',
  'alphaToCoverage',
  'polygonOffset',
];

/**
 * The culling mode implied by a {@link Side}.
 *
 * `FrontSide` means front faces are visible, so back faces are culled. Passing
 * {@link FrontFace.Clockwise} flips the mapping, which is what a mirrored
 * projection (for example a reflected camera) needs.
 *
 * @param side Material side.
 * @param frontFace Winding order in use.
 */
export function cullFaceForSide(side: Side, frontFace: FrontFace = FrontFace.CounterClockwise): CullFace {
  const mirrored = frontFace === FrontFace.Clockwise;
  switch (side) {
    case Side.FrontSide:
      return mirrored ? CullFace.Front : CullFace.Back;
    case Side.BackSide:
      return mirrored ? CullFace.Back : CullFace.Front;
    case Side.DoubleSide:
    default:
      // An unknown side must not silently cull: drawing both faces is the safe
      // fallback.
      return CullFace.None;
  }
}

/**
 * A comparable snapshot of the fixed-function state a draw needs.
 */
export class RenderState {
  /** `true` when fragments are depth-tested. */
  public depthTest: boolean = true;

  /** `true` when passing fragments write depth. */
  public depthWrite: boolean = true;

  /** Comparison function used by the depth test. */
  public depthFunc: DepthFunc = DepthFunc.LessEqual;

  /** Named blend preset. */
  public blending: BlendMode = BlendMode.NormalBlending;

  /** Source blend factor (used as-is for `CustomBlending`). */
  public blendSrc: Blending = Blending.SrcAlpha;

  /** Destination blend factor (used as-is for `CustomBlending`). */
  public blendDst: Blending = Blending.OneMinusSrcAlpha;

  /** Blend equation (used as-is for `CustomBlending`). */
  public blendEquation: BlendEquation = BlendEquation.Add;

  /** Face-culling mode. */
  public cullFace: CullFace = CullFace.Back;

  /** Front-face winding order. */
  public frontFace: FrontFace = FrontFace.CounterClockwise;

  /** `true` when the colour buffer is written. */
  public colorWrite: boolean = true;

  /** `true` when coverage-based antialiasing is enabled. */
  public alphaToCoverage: boolean = false;

  /** `true` when polygon offset is applied. */
  public polygonOffset: boolean = false;

  /* ---------------------------------------------------------------- static */

  /**
   * Builds a state from a material (or any {@link MaterialStateLike}).
   *
   * A non-`CustomBlending` preset always resolves to its canonical factors, even
   * if the material's own factor fields hold something else: the preset is the
   * contract, and only `CustomBlending` defers to the fields.
   *
   * @param material Material to read.
   * @param target Optional state to write into, to avoid allocating per draw.
   * @returns The populated state.
   */
  public static fromMaterial(
    material: MaterialStateLike,
    target: RenderState = new RenderState(),
  ): RenderState {
    return target.fromMaterial(material);
  }

  /* -------------------------------------------------------------- mutation */

  /**
   * Overwrites this state from a material.
   *
   * @param material Material to read.
   * @returns This state, for chaining.
   */
  public fromMaterial(material: MaterialStateLike): this {
    const factors = getBlendFactors(material.blending);
    const custom = material.blending === BlendMode.CustomBlending;

    this.depthTest = material.depthTest;
    this.depthWrite = material.depthWrite;
    this.depthFunc = material.depthFunc;
    this.blending = material.blending;
    this.blendSrc = custom ? material.blendSrc : factors.src;
    this.blendDst = custom ? material.blendDst : factors.dst;
    this.blendEquation = custom ? material.blendEquation : factors.equation;
    this.cullFace = cullFaceForSide(material.side);
    this.frontFace = FrontFace.CounterClockwise;
    this.colorWrite = material.colorWrite;
    this.alphaToCoverage = material.alphaToCoverage;
    this.polygonOffset = material.polygonOffset;
    return this;
  }

  /**
   * Copies another state.
   *
   * @param source State to read.
   * @returns This state, for chaining.
   */
  public copy(source: RenderState): this {
    this.depthTest = source.depthTest;
    this.depthWrite = source.depthWrite;
    this.depthFunc = source.depthFunc;
    this.blending = source.blending;
    this.blendSrc = source.blendSrc;
    this.blendDst = source.blendDst;
    this.blendEquation = source.blendEquation;
    this.cullFace = source.cullFace;
    this.frontFace = source.frontFace;
    this.colorWrite = source.colorWrite;
    this.alphaToCoverage = source.alphaToCoverage;
    this.polygonOffset = source.polygonOffset;
    return this;
  }

  /** Deep copy of this state. */
  public clone(): RenderState {
    return new RenderState().copy(this);
  }

  /** Resets every member to its default. */
  public reset(): this {
    this.depthTest = true;
    this.depthWrite = true;
    this.depthFunc = DepthFunc.LessEqual;
    this.blending = BlendMode.NormalBlending;
    const factors = getBlendFactors(BlendMode.NormalBlending);
    this.blendSrc = factors.src;
    this.blendDst = factors.dst;
    this.blendEquation = factors.equation;
    this.cullFace = CullFace.Back;
    this.frontFace = FrontFace.CounterClockwise;
    this.colorWrite = true;
    this.alphaToCoverage = false;
    this.polygonOffset = false;
    return this;
  }

  /* -------------------------------------------------------------- queries */

  /**
   * Exact equality.
   *
   * @param other State to compare against; `null`/`undefined` never equals.
   */
  public equals(other: RenderState | null | undefined): boolean {
    if (other == null) return false;
    if (other === this) return true;
    return this.diff(other).length === 0;
  }

  /**
   * Names of the members that differ from another state.
   *
   * @param other State to compare against; `null` means "everything differs".
   * @returns The changed member names, in declaration order; empty when equal.
   */
  public diff(other: RenderState | null | undefined): string[] {
    if (other == null) return [...MEMBERS];

    const changed: string[] = [];
    if (this.depthTest !== other.depthTest) changed.push('depthTest');
    if (this.depthWrite !== other.depthWrite) changed.push('depthWrite');
    if (this.depthFunc !== other.depthFunc) changed.push('depthFunc');
    if (this.blending !== other.blending) changed.push('blending');
    // For a preset the factors are derived from `blending`, so comparing them
    // again would report a phantom change; only custom blending has free factors.
    if (this.blending === BlendMode.CustomBlending || other.blending === BlendMode.CustomBlending) {
      if (this.blendSrc !== other.blendSrc) changed.push('blendSrc');
      if (this.blendDst !== other.blendDst) changed.push('blendDst');
      if (this.blendEquation !== other.blendEquation) changed.push('blendEquation');
    }
    if (this.cullFace !== other.cullFace) changed.push('cullFace');
    if (this.frontFace !== other.frontFace) changed.push('frontFace');
    if (this.colorWrite !== other.colorWrite) changed.push('colorWrite');
    if (this.alphaToCoverage !== other.alphaToCoverage) changed.push('alphaToCoverage');
    if (this.polygonOffset !== other.polygonOffset) changed.push('polygonOffset');
    return changed;
  }

  /**
   * Stable numeric key for the state.
   *
   * **Algorithm**: the twelve members are written in the fixed order of
   * {@link MEMBERS} as their canonical string values (booleans as `'1'`/`'0'`),
   * joined with `'|'`, and hashed with the library-wide FNV-1a `hashString`
   * (`utils/MathUtils`). It is stable because
   *
   *  - the field order is hard-coded, never `Object.keys` order;
   *  - every member is discrete (no floats), so no rounding can differ;
   *  - the values are the enum's own string literals, which are part of the public
   *    API — renaming one is already a breaking change;
   *  - FNV-1a is a pure function of the string, so the same state maps to the same
   *    32-bit number in any process, on any platform, in any bundle order.
   *
   * Two states that are {@link equals} always hash the same; a hash collision is
   * possible in principle, which is why the renderer only uses it to bucket draws
   * and still calls {@link diff} before applying anything.
   */
  public hash(): number {
    return hashString(this.toKey());
  }

  /** The canonical string {@link hash} hashes, exposed as a readable cache key. */
  public toKey(): string {
    return [
      this.depthTest ? '1' : '0',
      this.depthWrite ? '1' : '0',
      this.depthFunc,
      this.blending,
      this.blendSrc,
      this.blendDst,
      this.blendEquation,
      this.cullFace,
      this.frontFace,
      this.colorWrite ? '1' : '0',
      this.alphaToCoverage ? '1' : '0',
      this.polygonOffset ? '1' : '0',
    ].join('|');
  }

  /** Serialises the state as plain strings and booleans. */
  public toJSON(): Record<string, string | boolean> {
    return {
      depthTest: this.depthTest,
      depthWrite: this.depthWrite,
      depthFunc: this.depthFunc,
      blending: this.blending,
      blendSrc: this.blendSrc,
      blendDst: this.blendDst,
      blendEquation: this.blendEquation,
      cullFace: this.cullFace,
      frontFace: this.frontFace,
      colorWrite: this.colorWrite,
      alphaToCoverage: this.alphaToCoverage,
      polygonOffset: this.polygonOffset,
    };
  }

  /** Human-readable description, for logs and debug overlays. */
  public toString(): string {
    return (
      `RenderState(depth=${this.depthTest ? this.depthFunc : 'off'}${this.depthWrite ? '+write' : ''}, ` +
      `blend=${this.blending}(${this.blendSrc}->${this.blendDst}), cull=${this.cullFace}, ` +
      `colorWrite=${this.colorWrite ? 'on' : 'off'}, polygonOffset=${this.polygonOffset ? 'on' : 'off'})`
    );
  }
}
