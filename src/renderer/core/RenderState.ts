/**
 * Render state.
 *
 * A single comparable object holding every piece of fixed-function state a draw
 * depends on: culling, depth, blending, viewport, scissor and colour write masks.
 * Backends keep one "current" instance and diff it against the requested one with
 * {@link RenderState.equals} / {@link RenderState.diff}, so redundant driver calls
 * disappear without the caller having to track anything.
 *
 * @packageDocumentation
 */

import {
  BlendEquation,
  BlendFactor,
  CompareFunction,
  CullMode,
  type ScissorRect,
  type ViewportLike,
} from '../interfaces/types';

/* -------------------------------------------------------------------------- */
/* Blend state                                                                */
/* -------------------------------------------------------------------------- */

/** Blend configuration for one colour target. */
export interface BlendState {
  /** `true` when blending is applied. */
  enabled: boolean;
  /** Source factor for the RGB channels. */
  srcFactor: BlendFactor;
  /** Destination factor for the RGB channels. */
  dstFactor: BlendFactor;
  /** Blend equation for the RGB channels. */
  equation: BlendEquation;
  /** Source factor for the alpha channel. */
  srcAlphaFactor: BlendFactor;
  /** Destination factor for the alpha channel. */
  dstAlphaFactor: BlendFactor;
  /** Blend equation for the alpha channel. */
  alphaEquation: BlendEquation;
  /** Constant colour used by the `ConstantColor`/`ConstantAlpha` factors. */
  constantColor: [number, number, number, number];
  /** `true` when the RGB and alpha configurations are independent. */
  separateAlpha: boolean;
}

/** Depth-test configuration. */
export interface DepthState {
  /** `true` when fragments are depth-tested. */
  test: boolean;
  /** `true` when passing fragments write depth. */
  write: boolean;
  /** Comparison function used by the test. */
  compare: CompareFunction;
}

/** Stencil-test configuration. */
export interface StencilState {
  /** `true` when the stencil test runs. */
  enabled: boolean;
  /** Comparison function applied to the reference value. */
  compare: CompareFunction;
  /** Reference value compared against the stencil buffer. */
  reference: number;
  /** Bit mask applied to both values before comparing. */
  readMask: number;
  /** Bit mask applied to values written to the buffer. */
  writeMask: number;
}

/** Colour-write configuration. */
export interface ColorWriteState {
  /** `true` when the red channel is written. */
  r: boolean;
  /** `true` when the green channel is written. */
  g: boolean;
  /** `true` when the blue channel is written. */
  b: boolean;
  /** `true` when the alpha channel is written. */
  a: boolean;
}

/** The result of comparing two {@link RenderState} instances. */
export interface RenderStateDiff {
  /** Names of the members that differ, in the order they are declared. */
  readonly changed: readonly string[];
  /** `true` when nothing differs. */
  readonly equal: boolean;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Creates a default {@link BlendState} (alpha blending, disabled). */
export function createBlendState(): BlendState {
  return {
    enabled: false,
    srcFactor: BlendFactor.One,
    dstFactor: BlendFactor.Zero,
    equation: BlendEquation.Add,
    srcAlphaFactor: BlendFactor.One,
    dstAlphaFactor: BlendFactor.Zero,
    alphaEquation: BlendEquation.Add,
    constantColor: [0, 0, 0, 0],
    separateAlpha: false,
  };
}

/** Creates the conventional pre-multiplied source-over {@link BlendState}. */
export function createAlphaBlendState(): BlendState {
  return {
    enabled: true,
    srcFactor: BlendFactor.SrcAlpha,
    dstFactor: BlendFactor.OneMinusSrcAlpha,
    equation: BlendEquation.Add,
    srcAlphaFactor: BlendFactor.One,
    dstAlphaFactor: BlendFactor.OneMinusSrcAlpha,
    alphaEquation: BlendEquation.Add,
    constantColor: [0, 0, 0, 0],
    separateAlpha: true,
  };
}

/** Creates a default {@link DepthState} (test and write on, `Less`). */
export function createDepthState(): DepthState {
  return { test: true, write: true, compare: CompareFunction.LessEqual };
}

/** Creates a disabled {@link StencilState}. */
export function createStencilState(): StencilState {
  return { enabled: false, compare: CompareFunction.Always, reference: 0, readMask: 0xff, writeMask: 0xff };
}

/** Creates an all-channels {@link ColorWriteState}. */
export function createColorWriteState(): ColorWriteState {
  return { r: true, g: true, b: true, a: true };
}

/* -------------------------------------------------------------------------- */
/* RenderState                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Mutable, comparable snapshot of the fixed-function pipeline state.
 *
 * ```ts
 * const requested = new RenderState();
 * requested.cull = CullMode.Back;
 * const diff = current.diff(requested);   // ['cull']
 * ```
 */
export class RenderState {
  /** Polygon culling mode. */
  public cull: CullMode = CullMode.Back;

  /** Front-face winding is counter-clockwise. */
  public frontFaceCCW: boolean = true;

  /** Depth test/write configuration. */
  public readonly depth: DepthState = createDepthState();

  /** Stencil configuration. */
  public readonly stencil: StencilState = createStencilState();

  /** Blend configuration. */
  public readonly blend: BlendState = createBlendState();

  /** Colour write mask. */
  public readonly colorWrite: ColorWriteState = createColorWriteState();

  /** Viewport rectangle in device pixels. */
  public viewport: ViewportLike = { x: 0, y: 0, width: 0, height: 0 };

  /** Scissor rectangle, or `null` when scissoring is disabled. */
  public scissor: ScissorRect | null = null;

  /** Line width in pixels, for `Line` topologies. */
  public lineWidth: number = 1;

  /** Device-pixel ratio the state was built for; affects line widths in 2D. */
  public pixelRatio: number = 1;

  /** Polygon offset factor, forwarded to `gl.polygonOffset`. */
  public polygonOffsetFactor: number = 0;

  /** Polygon offset units, forwarded to `gl.polygonOffset`. */
  public polygonOffsetUnits: number = 0;

  /**
   * Copies another state into this one.
   *
   * @param source State to read.
   * @returns This state, for chaining.
   */
  public copy(source: RenderState): this {
    this.cull = source.cull;
    this.frontFaceCCW = source.frontFaceCCW;
    copyDepth(source.depth, this.depth);
    copyStencil(source.stencil, this.stencil);
    copyBlend(source.blend, this.blend);
    copyColorWrite(source.colorWrite, this.colorWrite);
    this.viewport = { ...source.viewport };
    this.scissor = source.scissor === null ? null : { ...source.scissor };
    this.lineWidth = source.lineWidth;
    this.pixelRatio = source.pixelRatio;
    this.polygonOffsetFactor = source.polygonOffsetFactor;
    this.polygonOffsetUnits = source.polygonOffsetUnits;
    return this;
  }

  /** @returns A deep copy of this state. */
  public clone(): RenderState {
    return new RenderState().copy(this);
  }

  /** Restores every member to its default value. */
  public reset(): this {
    this.cull = CullMode.Back;
    this.frontFaceCCW = true;
    copyDepth(createDepthState(), this.depth);
    copyStencil(createStencilState(), this.stencil);
    copyBlend(createBlendState(), this.blend);
    copyColorWrite(createColorWriteState(), this.colorWrite);
    this.viewport = { x: 0, y: 0, width: 0, height: 0 };
    this.scissor = null;
    this.lineWidth = 1;
    this.pixelRatio = 1;
    this.polygonOffsetFactor = 0;
    this.polygonOffsetUnits = 0;
    return this;
  }

  /**
   * Compares this state with another.
   *
   * The comparison is exact (no epsilon): every member is a discrete setting or
   * a dimension the caller controls precisely.
   *
   * @param other State to compare against.
   * @returns `true` when every member is identical.
   */
  public equals(other: RenderState | null | undefined): boolean {
    return this.diff(other).equal;
  }

  /**
   * Lists the members that differ from another state.
   *
   * @param other State to compare against; `null` means "everything differs".
   * @returns A {@link RenderStateDiff} with the changed member names.
   */
  public diff(other: RenderState | null | undefined): RenderStateDiff {
    if (other == null) {
      return {
        changed: [
          'cull',
          'frontFaceCCW',
          'depth',
          'stencil',
          'blend',
          'colorWrite',
          'viewport',
          'scissor',
          'lineWidth',
          'pixelRatio',
          'polygonOffsetFactor',
          'polygonOffsetUnits',
        ],
        equal: false,
      };
    }

    const changed: string[] = [];
    if (this.cull !== other.cull) changed.push('cull');
    if (this.frontFaceCCW !== other.frontFaceCCW) changed.push('frontFaceCCW');
    if (!equalDepth(this.depth, other.depth)) changed.push('depth');
    if (!equalStencil(this.stencil, other.stencil)) changed.push('stencil');
    if (!equalBlend(this.blend, other.blend)) changed.push('blend');
    if (!equalColorWrite(this.colorWrite, other.colorWrite)) changed.push('colorWrite');
    if (!equalViewport(this.viewport, other.viewport)) changed.push('viewport');
    if (!equalScissor(this.scissor, other.scissor)) changed.push('scissor');
    if (this.lineWidth !== other.lineWidth) changed.push('lineWidth');
    if (this.pixelRatio !== other.pixelRatio) changed.push('pixelRatio');
    if (this.polygonOffsetFactor !== other.polygonOffsetFactor) changed.push('polygonOffsetFactor');
    if (this.polygonOffsetUnits !== other.polygonOffsetUnits) changed.push('polygonOffsetUnits');

    return { changed, equal: changed.length === 0 };
  }

  /**
   * Applies the conventional 2D state: no culling, no depth, alpha blending.
   *
   * The Canvas2D and SVG backends use this as their baseline.
   *
   * @returns This state, for chaining.
   */
  public apply2DDefaults(): this {
    this.cull = CullMode.None;
    this.frontFaceCCW = true;
    this.depth.test = false;
    this.depth.write = false;
    this.depth.compare = CompareFunction.Always;
    copyBlend(createAlphaBlendState(), this.blend);
    return this;
  }

  /** @returns A human-readable description of the state. */
  public toString(): string {
    return (
      `RenderState(cull=${this.cull}, depth=${this.depth.test ? this.depth.compare : 'off'}` +
      `${this.depth.write ? '+write' : ''}, blend=${this.blend.enabled ? `${this.blend.srcFactor}->${this.blend.dstFactor}` : 'off'}, ` +
      `viewport=${this.viewport.width}x${this.viewport.height}, scissor=${this.scissor ? 'on' : 'off'})`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Internal comparison / copy helpers                                         */
/* -------------------------------------------------------------------------- */

function copyDepth(source: DepthState, target: DepthState): void {
  target.test = source.test;
  target.write = source.write;
  target.compare = source.compare;
}

function equalDepth(a: DepthState, b: DepthState): boolean {
  return a.test === b.test && a.write === b.write && a.compare === b.compare;
}

function copyStencil(source: StencilState, target: StencilState): void {
  target.enabled = source.enabled;
  target.compare = source.compare;
  target.reference = source.reference;
  target.readMask = source.readMask;
  target.writeMask = source.writeMask;
}

function equalStencil(a: StencilState, b: StencilState): boolean {
  return (
    a.enabled === b.enabled &&
    a.compare === b.compare &&
    a.reference === b.reference &&
    a.readMask === b.readMask &&
    a.writeMask === b.writeMask
  );
}

function copyBlend(source: BlendState, target: BlendState): void {
  target.enabled = source.enabled;
  target.srcFactor = source.srcFactor;
  target.dstFactor = source.dstFactor;
  target.equation = source.equation;
  target.srcAlphaFactor = source.srcAlphaFactor;
  target.dstAlphaFactor = source.dstAlphaFactor;
  target.alphaEquation = source.alphaEquation;
  target.constantColor = [...source.constantColor] as [number, number, number, number];
  target.separateAlpha = source.separateAlpha;
}

function equalBlend(a: BlendState, b: BlendState): boolean {
  if (
    a.enabled !== b.enabled ||
    a.srcFactor !== b.srcFactor ||
    a.dstFactor !== b.dstFactor ||
    a.equation !== b.equation ||
    a.separateAlpha !== b.separateAlpha
  ) {
    return false;
  }
  if (a.separateAlpha) {
    if (a.srcAlphaFactor !== b.srcAlphaFactor || a.dstAlphaFactor !== b.dstAlphaFactor) return false;
    if (a.alphaEquation !== b.alphaEquation) return false;
  }
  for (let i = 0; i < 4; i++) {
    if (a.constantColor[i] !== b.constantColor[i]) return false;
  }
  return true;
}

function copyColorWrite(source: ColorWriteState, target: ColorWriteState): void {
  target.r = source.r;
  target.g = source.g;
  target.b = source.b;
  target.a = source.a;
}

function equalColorWrite(a: ColorWriteState, b: ColorWriteState): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

function equalViewport(a: ViewportLike, b: ViewportLike): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function equalScissor(a: ScissorRect | null, b: ScissorRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** `true` when a blend state describes ordinary alpha blending. */
export function isAlphaBlend(state: BlendState): boolean {
  return (
    state.enabled &&
    state.srcFactor === BlendFactor.SrcAlpha &&
    state.dstFactor === BlendFactor.OneMinusSrcAlpha &&
    state.equation === BlendEquation.Add
  );
}

/** `true` when a blend state describes additive blending. */
export function isAdditiveBlend(state: BlendState): boolean {
  return (
    state.enabled &&
    state.srcFactor === BlendFactor.SrcAlpha &&
    state.dstFactor === BlendFactor.One &&
    state.equation === BlendEquation.Add
  );
}
