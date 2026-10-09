/**
 * Redundant-state-change eliminator for the WebGL backend.
 *
 * Browsers validate every `gl.*` call, and the fixed-function pipeline state is
 * exactly where a naive renderer issues thousands of pointless calls per frame.
 * This class owns the shadow copy of the state the driver currently has and makes
 * every setter a no-op when the requested value already matches.
 *
 * ## Testability contract
 *
 * The class only ever touches the driver through `gl.*`, so a hand-written object
 * that records its calls is a complete stand-in. Nothing here reads canvas
 * dimensions, DOM state or extension objects, which is what makes
 * {@link WebGLState.getSnapshot} a faithful, comparable description of the shadow
 * state.
 *
 * ## Nesting
 *
 * {@link WebGLState.pushState} snapshots the shadow state and
 * {@link WebGLState.popState} re-applies it through the ordinary setters. Because
 * every setter diffs first, a `popState` that restores exactly what was active
 * emits no GL calls at all; only the members a nested block actually changed are
 * written back.
 *
 * ## Context loss
 *
 * A lost context resets the driver to its defaults but leaves this shadow state
 * untouched, which would silently skip the calls needed to rebuild it.
 * {@link WebGLState.invalidate} therefore marks every cached value unknown, so the
 * next frame re-issues the full state.
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
import type { BlendState, ColorWriteState, DepthState, RenderState, StencilState } from '../core/RenderState';
import { clamp } from '../../utils/MathUtils';
import { createLogger } from '../../utils/Logger';
import {
  glConst,
  toGLBlendEquation,
  toGLBlendFactor,
  toGLCompareFunction,
  toGLCullFace,
  toGLFrontFace,
  type GL,
} from './WebGLUtils';

/** Logger for state diagnostics. */
const log = createLogger('renderer:webgl:state');

/* -------------------------------------------------------------------------- */
/* Sentinels                                                                  */
/* -------------------------------------------------------------------------- */

/** Wildcard used for "the shadow copy does not know this value". */
export const UNKNOWN = Symbol('webgl-state-unknown');

/** Cached value, or {@link UNKNOWN}. */
type Maybe<T> = T | typeof UNKNOWN;

/** Cached capability flag. */
type MaybeBool = Maybe<boolean>;

/* -------------------------------------------------------------------------- */
/* Snapshot                                                                   */
/* -------------------------------------------------------------------------- */

/** One bound texture, as reported by {@link WebGLState.getSnapshot}. */
export interface WebGLBoundTexture {
  /** Texture unit the binding lives on. */
  readonly unit: number;
  /** GL texture target (`TEXTURE_2D`, `TEXTURE_CUBE_MAP`, ...). */
  readonly target: number;
  /** Bound texture, or `null` when nothing is bound. */
  readonly texture: WebGLTexture | null;
}

/**
 * Comparable description of the shadow state.
 *
 * Two snapshots are equal exactly when the driver state they describe is equal,
 * which is what the unit tests assert against.
 */
export interface WebGLStateSnapshot {
  readonly depthTest: boolean;
  readonly depthWrite: boolean;
  readonly depthFunc: CompareFunction;
  readonly blend: boolean;
  readonly blendSrc: BlendFactor;
  readonly blendDst: BlendFactor;
  readonly blendEquation: BlendEquation;
  readonly blendSrcAlpha: BlendFactor;
  readonly blendDstAlpha: BlendFactor;
  readonly blendAlphaEquation: BlendEquation;
  readonly blendSeparate: boolean;
  readonly blendColor: readonly [number, number, number, number];
  readonly cullFace: CullMode;
  readonly frontFaceCCW: boolean;
  readonly colorMask: readonly [boolean, boolean, boolean, boolean];
  readonly scissor: ScissorRect | null;
  readonly viewport: ViewportLike;
  readonly stencilTest: boolean;
  readonly stencilFunc: CompareFunction;
  readonly stencilReference: number;
  readonly stencilReadMask: number;
  readonly stencilWriteMask: number;
  readonly activeTexture: number;
  readonly boundTextures: readonly WebGLBoundTexture[];
  readonly boundArrayBuffer: WebGLBuffer | null;
  readonly boundElementArrayBuffer: WebGLBuffer | null;
  readonly boundVertexArray: WebGLVertexArrayObject | WebGLVertexArrayObjectOES | null;
  readonly currentProgram: WebGLProgram | null;
  readonly lineWidth: number;
  readonly polygonOffsetFactor: number;
  readonly polygonOffsetUnits: number;
}

/* -------------------------------------------------------------------------- */
/* WebGLState                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Shadow copy of the WebGL fixed-function state.
 *
 * ```ts
 * const state = new WebGLState(gl, { isWebGL2: true });
 * state.setDepthTest(true);   // emits gl.enable(DEPTH_TEST)
 * state.setDepthTest(true);   // emits nothing
 * ```
 */
export class WebGLState {
  /** Context every call is issued against. */
  private readonly gl: GL;

  /** `true` when the context is WebGL2. */
  private readonly isWebGL2: boolean;

  /* ------------------------------------------------------------- cached state */

  private cachedDepthTest: MaybeBool = UNKNOWN;
  private cachedDepthWrite: MaybeBool = UNKNOWN;
  private cachedDepthFunc: Maybe<number> = UNKNOWN;

  private cachedBlend: MaybeBool = UNKNOWN;
  private cachedBlendSrc: Maybe<number> = UNKNOWN;
  private cachedBlendDst: Maybe<number> = UNKNOWN;
  private cachedBlendEquation: Maybe<number> = UNKNOWN;
  private cachedBlendSrcAlpha: Maybe<number> = UNKNOWN;
  private cachedBlendDstAlpha: Maybe<number> = UNKNOWN;
  private cachedBlendAlphaEquation: Maybe<number> = UNKNOWN;
  private cachedBlendSeparate: MaybeBool = UNKNOWN;
  private readonly cachedBlendColor: [number, number, number, number] = [NaN, NaN, NaN, NaN];

  private cachedCullEnabled: MaybeBool = UNKNOWN;
  private cachedCullFace: Maybe<number> = UNKNOWN;
  private cachedFrontFace: Maybe<number> = UNKNOWN;
  private cachedColorMask: Maybe<number> = UNKNOWN;
  private cachedPolygonOffsetEnabled: MaybeBool = UNKNOWN;

  private cachedScissorTest: MaybeBool = UNKNOWN;
  private cachedScissor: Maybe<ScissorRect | null> = UNKNOWN;
  private readonly cachedViewport: ViewportLike = { x: NaN, y: NaN, width: NaN, height: NaN };
  private viewportKnown: boolean = false;

  private cachedStencilTest: MaybeBool = UNKNOWN;
  private cachedStencilFunc: Maybe<number> = UNKNOWN;
  private cachedStencilReference: Maybe<number> = UNKNOWN;
  private cachedStencilReadMask: Maybe<number> = UNKNOWN;
  private cachedStencilWriteMask: Maybe<number> = UNKNOWN;

  private cachedActiveTexture: number = -1;
  private readonly cachedTextures: Map<number, Map<number, WebGLTexture | null>> = new Map();

  private cachedArrayBuffer: WebGLBuffer | null | undefined = undefined;
  private cachedElementArrayBuffer: WebGLBuffer | null | undefined = undefined;
  private cachedVertexArray: WebGLVertexArrayObject | WebGLVertexArrayObjectOES | null | undefined = undefined;
  private cachedProgram: WebGLProgram | null | undefined = undefined;

  private cachedLineWidth: number = -1;
  private cachedPolygonOffsetFactor: number = NaN;
  private cachedPolygonOffsetUnits: number = NaN;

  /* ---------------------------------------------------------------- bookkeeping */

  /** Number of GL calls this object has issued since construction. */
  private issuedCalls: number = 0;

  /** Number of times a setter actually changed something. */
  private changes: number = 0;

  /** Snapshot stack used by {@link WebGLState.pushState}. */
  private readonly stack: WebGLStateSnapshot[] = [];

  /**
   * Creates the shadow state.
   *
   * @param gl Context to issue calls against.
   * @param options WebGL version selection.
   */
  constructor(gl: GL, options: { isWebGL2?: boolean } = {}) {
    this.gl = gl;
    this.isWebGL2 = options.isWebGL2 ?? true;
  }

  /** `true` when the shadow state targets a WebGL2 context. */
  public get webgl2(): boolean {
    return this.isWebGL2;
  }

  /** GL calls issued so far. */
  public get callCount(): number {
    return this.issuedCalls;
  }

  /** Setters that actually changed a value. */
  public get changeCount(): number {
    return this.changes;
  }

  /** Number of snapshots currently on the stack. */
  public get depth(): number {
    return this.stack.length;
  }

  /* ------------------------------------------------------------------ helpers */

  /** Records one issued GL call. */
  private count(): void {
    this.issuedCalls++;
  }

  /** Records one effective state change. */
  private change(): void {
    this.changes++;
  }

  /**
   * Enables or disables a GL capability, skipping the call when it already matches.
   *
   * @param cap GL capability enumeration.
   * @param enabled Requested value.
   * @param cached Current shadow value.
   * @returns The new shadow value.
   */
  private applyCapability(cap: number, enabled: boolean, cached: MaybeBool): boolean {
    if (cached === enabled) return enabled;
    if (enabled) {
      this.gl.enable(cap);
    } else {
      this.gl.disable(cap);
    }
    this.count();
    this.change();
    return enabled;
  }

  /* ------------------------------------------------------------------- depth */

  /**
   * Enables or disables the depth test.
   *
   * @param enabled Requested value.
   * @returns This state, for chaining.
   */
  public setDepthTest(enabled: boolean): this {
    this.cachedDepthTest = this.applyCapability(
      glConst(this.gl, 'DEPTH_TEST', 0x0b71),
      enabled,
      this.cachedDepthTest,
    );
    return this;
  }

  /**
   * Enables or disables depth writes.
   *
   * @param enabled Requested value.
   * @returns This state, for chaining.
   */
  public setDepthWrite(enabled: boolean): this {
    if (this.cachedDepthWrite === enabled) return this;
    this.gl.depthMask(enabled);
    this.cachedDepthWrite = enabled;
    this.count();
    this.change();
    return this;
  }

  /**
   * Sets the depth comparison function.
   *
   * @param compare Requested comparison.
   * @returns This state, for chaining.
   */
  public setDepthFunc(compare: CompareFunction): this {
    const value = toGLCompareFunction(this.gl, compare);
    if (this.cachedDepthFunc === value) return this;
    this.gl.depthFunc(value);
    this.cachedDepthFunc = value;
    this.count();
    this.change();
    return this;
  }

  /**
   * Applies a whole {@link DepthState}.
   *
   * @param depth Depth configuration.
   * @returns This state, for chaining.
   */
  public setDepthState(depth: Readonly<DepthState>): this {
    this.setDepthTest(depth.test);
    this.setDepthWrite(depth.write);
    this.setDepthFunc(depth.compare);
    return this;
  }

  /* ------------------------------------------------------------------- blend */

  /**
   * Enables or disables blending.
   *
   * @param enabled Requested value.
   * @returns This state, for chaining.
   */
  public setBlend(enabled: boolean): this {
    this.cachedBlend = this.applyCapability(glConst(this.gl, 'BLEND', 0x0be2), enabled, this.cachedBlend);
    return this;
  }

  /**
   * Sets the RGB blend factors.
   *
   * @param src Source factor.
   * @param dst Destination factor.
   * @returns This state, for chaining.
   */
  public setBlendFunc(src: BlendFactor, dst: BlendFactor): this {
    const srcGL = toGLBlendFactor(this.gl, src);
    const dstGL = toGLBlendFactor(this.gl, dst);
    if (this.cachedBlendSrc === srcGL && this.cachedBlendDst === dstGL) return this;
    this.gl.blendFunc(srcGL, dstGL);
    this.cachedBlendSrc = srcGL;
    this.cachedBlendDst = dstGL;
    this.count();
    this.change();
    return this;
  }

  /**
   * Sets independent RGB and alpha blend factors.
   *
   * @param srcRGB Source factor for RGB.
   * @param dstRGB Destination factor for RGB.
   * @param srcAlpha Source factor for alpha.
   * @param dstAlpha Destination factor for alpha.
   * @returns This state, for chaining.
   */
  public setBlendFuncSeparate(
    srcRGB: BlendFactor,
    dstRGB: BlendFactor,
    srcAlpha: BlendFactor,
    dstAlpha: BlendFactor,
  ): this {
    const a = toGLBlendFactor(this.gl, srcRGB);
    const b = toGLBlendFactor(this.gl, dstRGB);
    const c = toGLBlendFactor(this.gl, srcAlpha);
    const d = toGLBlendFactor(this.gl, dstAlpha);
    if (
      this.cachedBlendSeparate === true &&
      this.cachedBlendSrc === a &&
      this.cachedBlendDst === b &&
      this.cachedBlendSrcAlpha === c &&
      this.cachedBlendDstAlpha === d
    ) {
      return this;
    }
    this.gl.blendFuncSeparate(a, b, c, d);
    this.cachedBlendSeparate = true;
    this.cachedBlendSrc = a;
    this.cachedBlendDst = b;
    this.cachedBlendSrcAlpha = c;
    this.cachedBlendDstAlpha = d;
    this.count();
    this.change();
    return this;
  }

  /**
   * Sets the RGB blend equation.
   *
   * @param equation Requested equation.
   * @returns This state, for chaining.
   */
  public setBlendEquation(equation: BlendEquation): this {
    const value = toGLBlendEquation(this.gl, equation);
    if (this.cachedBlendEquation === value) return this;
    this.gl.blendEquation(value);
    this.cachedBlendEquation = value;
    this.count();
    this.change();
    return this;
  }

  /**
   * Sets independent RGB and alpha blend equations.
   *
   * @param rgb Equation for the RGB channels.
   * @param alpha Equation for the alpha channel.
   * @returns This state, for chaining.
   */
  public setBlendEquationSeparate(rgb: BlendEquation, alpha: BlendEquation): this {
    const a = toGLBlendEquation(this.gl, rgb);
    const b = toGLBlendEquation(this.gl, alpha);
    if (this.cachedBlendEquation === a && this.cachedBlendAlphaEquation === b) return this;
    this.gl.blendEquationSeparate(a, b);
    this.cachedBlendEquation = a;
    this.cachedBlendAlphaEquation = b;
    this.count();
    this.change();
    return this;
  }

  /**
   * Sets the constant blend colour used by the `Constant*` factors.
   *
   * @param r Red channel in 0..1.
   * @param g Green channel in 0..1.
   * @param b Blue channel in 0..1.
   * @param a Alpha channel in 0..1.
   * @returns This state, for chaining.
   */
  public setBlendColor(r: number, g: number, b: number, a: number): this {
    const cached = this.cachedBlendColor;
    if (cached[0] === r && cached[1] === g && cached[2] === b && cached[3] === a) return this;
    this.gl.blendColor(r, g, b, a);
    cached[0] = r;
    cached[1] = g;
    cached[2] = b;
    cached[3] = a;
    this.count();
    this.change();
    return this;
  }

  /**
   * Applies a whole {@link BlendState}.
   *
   * @param blend Blend configuration.
   * @returns This state, for chaining.
   */
  public setBlendState(blend: Readonly<BlendState>): this {
    this.setBlend(blend.enabled);
    if (!blend.enabled) return this;

    if (blend.separateAlpha) {
      this.setBlendFuncSeparate(blend.srcFactor, blend.dstFactor, blend.srcAlphaFactor, blend.dstAlphaFactor);
      this.setBlendEquationSeparate(blend.equation, blend.alphaEquation);
    } else {
      this.setBlendFunc(blend.srcFactor, blend.dstFactor);
      this.setBlendEquation(blend.equation);
    }

    const [r, g, b, a] = blend.constantColor;
    if (r !== 0 || g !== 0 || b !== 0 || a !== 0) this.setBlendColor(r, g, b, a);
    return this;
  }

  /* -------------------------------------------------------------------- cull */

  /**
   * Sets the face-culling mode.
   *
   * @param mode Requested mode.
   * @returns This state, for chaining.
   */
  public setCullFace(mode: CullMode): this {
    const face = toGLCullFace(this.gl, mode);
    const cap = glConst(this.gl, 'CULL_FACE', 0x0b44);

    if (face === null) {
      this.cachedCullEnabled = this.applyCapability(cap, false, this.cachedCullEnabled);
      return this;
    }

    this.cachedCullEnabled = this.applyCapability(cap, true, this.cachedCullEnabled);
    if (this.cachedCullFace === face) return this;
    this.gl.cullFace(face);
    this.cachedCullFace = face;
    this.count();
    this.change();
    return this;
  }

  /**
   * Sets the front-face winding order.
   *
   * @param counterClockwise `true` for counter-clockwise front faces.
   * @returns This state, for chaining.
   */
  public setFrontFace(counterClockwise: boolean): this {
    const value = toGLFrontFace(this.gl, counterClockwise);
    if (this.cachedFrontFace === value) return this;
    this.gl.frontFace(value);
    this.cachedFrontFace = value;
    this.count();
    this.change();
    return this;
  }

  /* -------------------------------------------------------------- colour mask */

  /**
   * Sets the per-channel colour write mask.
   *
   * @param r Write red.
   * @param g Write green.
   * @param b Write blue.
   * @param a Write alpha.
   * @returns This state, for chaining.
   */
  public setColorMask(r: boolean, g: boolean, b: boolean, a: boolean): this {
    const mask = (r ? 1 : 0) | (g ? 2 : 0) | (b ? 4 : 0) | (a ? 8 : 0);
    if (this.cachedColorMask === mask) return this;
    this.gl.colorMask(r, g, b, a);
    this.cachedColorMask = mask;
    this.count();
    this.change();
    return this;
  }

  /**
   * Applies a whole {@link ColorWriteState}.
   *
   * @param colorWrite Channel mask.
   * @returns This state, for chaining.
   */
  public setColorWriteState(colorWrite: Readonly<ColorWriteState>): this {
    return this.setColorMask(colorWrite.r, colorWrite.g, colorWrite.b, colorWrite.a);
  }

  /* -------------------------------------------------------------- viewport/scissor */

  /**
   * Sets the viewport.
   *
   * @param viewport Requested rectangle, in device pixels.
   * @returns This state, for chaining.
   */
  public setViewport(viewport: ViewportLike): this {
    const cached = this.cachedViewport;
    if (
      this.viewportKnown &&
      cached.x === viewport.x &&
      cached.y === viewport.y &&
      cached.width === viewport.width &&
      cached.height === viewport.height
    ) {
      return this;
    }

    const x = Math.floor(viewport.x);
    const y = Math.floor(viewport.y);
    const width = Math.max(0, Math.floor(viewport.width));
    const height = Math.max(0, Math.floor(viewport.height));

    this.gl.viewport(x, y, width, height);
    cached.x = viewport.x;
    cached.y = viewport.y;
    cached.width = viewport.width;
    cached.height = viewport.height;
    this.viewportKnown = true;
    this.count();
    this.change();
    return this;
  }

  /**
   * Sets or disables scissor clipping.
   *
   * @param rect Requested rectangle, or `null` to disable.
   * @returns This state, for chaining.
   */
  public setScissor(rect: ScissorRect | null): this {
    const cap = glConst(this.gl, 'SCISSOR_TEST', 0x0c11);

    if (rect === null) {
      this.cachedScissorTest = this.applyCapability(cap, false, this.cachedScissorTest);
      this.cachedScissor = null;
      return this;
    }

    this.cachedScissorTest = this.applyCapability(cap, true, this.cachedScissorTest);

    const cached = this.cachedScissor;
    if (
      cached !== UNKNOWN &&
      cached !== null &&
      cached.x === rect.x &&
      cached.y === rect.y &&
      cached.width === rect.width &&
      cached.height === rect.height
    ) {
      return this;
    }

    const x = Math.floor(rect.x);
    const y = Math.floor(rect.y);
    const width = Math.max(0, Math.floor(rect.width));
    const height = Math.max(0, Math.floor(rect.height));

    this.gl.scissor(x, y, width, height);
    this.cachedScissor = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    this.count();
    this.change();
    return this;
  }

  /* ----------------------------------------------------------------- stencil */

  /**
   * Enables or disables the stencil test.
   *
   * @param enabled Requested value.
   * @returns This state, for chaining.
   */
  public setStencilTest(enabled: boolean): this {
    this.cachedStencilTest = this.applyCapability(
      glConst(this.gl, 'STENCIL_TEST', 0x0b90),
      enabled,
      this.cachedStencilTest,
    );
    return this;
  }

  /**
   * Sets the stencil comparison function, reference value and read mask.
   *
   * @param compare Comparison applied to the reference value.
   * @param reference Reference value.
   * @param readMask Mask applied to both operands.
   * @returns This state, for chaining.
   */
  public setStencilFunc(compare: CompareFunction, reference: number, readMask: number = 0xff): this {
    const func = toGLCompareFunction(this.gl, compare);
    if (
      this.cachedStencilFunc === func &&
      this.cachedStencilReference === reference &&
      this.cachedStencilReadMask === readMask
    ) {
      return this;
    }
    this.gl.stencilFunc(func, reference, readMask);
    this.cachedStencilFunc = func;
    this.cachedStencilReference = reference;
    this.cachedStencilReadMask = readMask;
    this.count();
    this.change();
    return this;
  }

  /**
   * Sets the stencil write mask.
   *
   * @param writeMask Bits that may be written.
   * @returns This state, for chaining.
   */
  public setStencilMask(writeMask: number): this {
    if (this.cachedStencilWriteMask === writeMask) return this;
    this.gl.stencilMask(writeMask);
    this.cachedStencilWriteMask = writeMask;
    this.count();
    this.change();
    return this;
  }

  /**
   * Applies a whole {@link StencilState}.
   *
   * @param stencil Stencil configuration.
   * @returns This state, for chaining.
   */
  public setStencilState(stencil: Readonly<StencilState>): this {
    this.setStencilTest(stencil.enabled);
    if (!stencil.enabled) return this;
    this.setStencilFunc(stencil.compare, stencil.reference, stencil.readMask);
    this.setStencilMask(stencil.writeMask);
    return this;
  }

  /* --------------------------------------------------------- textures / buffers */

  /**
   * Selects the active texture unit.
   *
   * @param unit Zero-based texture unit.
   * @returns This state, for chaining.
   */
  public setActiveTexture(unit: number): this {
    const next = Math.max(0, Math.floor(unit));
    if (this.cachedActiveTexture === next) return this;
    this.gl.activeTexture(glConst(this.gl, 'TEXTURE0', 0x84c0) + next);
    this.cachedActiveTexture = next;
    this.count();
    this.change();
    return this;
  }

  /** @returns The currently selected texture unit. */
  public getActiveTexture(): number {
    return this.cachedActiveTexture < 0 ? 0 : this.cachedActiveTexture;
  }

  /**
   * Binds a texture to a unit/target pair.
   *
   * The unit is selected first, so the caller does not have to track it.
   *
   * @param unit Texture unit.
   * @param target GL texture target.
   * @param texture Texture to bind, or `null` to unbind.
   * @returns This state, for chaining.
   */
  public bindTexture(unit: number, target: number, texture: WebGLTexture | null): this {
    this.setActiveTexture(unit);

    let perTarget = this.cachedTextures.get(unit);
    if (perTarget === undefined) {
      perTarget = new Map<number, WebGLTexture | null>();
      this.cachedTextures.set(unit, perTarget);
    }
    if (perTarget.get(target) === texture) return this;

    this.gl.bindTexture(target, texture);
    perTarget.set(target, texture);
    this.count();
    this.change();
    return this;
  }

  /**
   * Binds an `ARRAY_BUFFER`.
   *
   * @param buffer Buffer to bind, or `null`.
   * @returns This state, for chaining.
   */
  public bindArrayBuffer(buffer: WebGLBuffer | null): this {
    if (this.cachedArrayBuffer === buffer) return this;
    this.gl.bindBuffer(glConst(this.gl, 'ARRAY_BUFFER', 0x8892), buffer);
    this.cachedArrayBuffer = buffer;
    this.count();
    this.change();
    return this;
  }

  /**
   * Binds an `ELEMENT_ARRAY_BUFFER`.
   *
   * @param buffer Buffer to bind, or `null`.
   * @returns This state, for chaining.
   */
  public bindElementArrayBuffer(buffer: WebGLBuffer | null): this {
    if (this.cachedElementArrayBuffer === buffer) return this;
    this.gl.bindBuffer(glConst(this.gl, 'ELEMENT_ARRAY_BUFFER', 0x8893), buffer);
    this.cachedElementArrayBuffer = buffer;
    this.count();
    this.change();
    return this;
  }

  /**
   * Binds a vertex array object.
   *
   * @param vao Object to bind, or `null` for the default array.
   * @param bindFn Optional custom binder (the WebGL1 extension entry point).
   * @returns This state, for chaining.
   */
  public bindVertexArray(
    vao: WebGLVertexArrayObject | WebGLVertexArrayObjectOES | null,
    bindFn?: (vao: WebGLVertexArrayObjectOES | null) => void,
  ): this {
    if (this.cachedVertexArray === vao) return this;
    if (bindFn !== undefined) {
      bindFn(vao as WebGLVertexArrayObjectOES | null);
    } else if (this.isWebGL2) {
      (this.gl as WebGL2RenderingContext).bindVertexArray(vao as WebGLVertexArrayObject | null);
    }
    this.cachedVertexArray = vao;
    this.count();
    this.change();
    return this;
  }

  /**
   * Makes a program current.
   *
   * @param program Program to use, or `null`.
   * @returns This state, for chaining.
   */
  public useProgram(program: WebGLProgram | null): this {
    if (this.cachedProgram === program) return this;
    this.gl.useProgram(program);
    this.cachedProgram = program;
    this.count();
    this.change();
    return this;
  }

  /* -------------------------------------------------------------- misc state */

  /**
   * Sets the line width.
   *
   * @param width Width in pixels.
   * @returns This state, for chaining.
   */
  public setLineWidth(width: number): this {
    if (this.cachedLineWidth === width) return this;
    this.gl.lineWidth(width);
    this.cachedLineWidth = width;
    this.count();
    this.change();
    return this;
  }

  /**
   * Sets the polygon offset applied to filled primitives.
   *
   * @param factor Scale factor applied to the depth slope.
   * @param units Units added to the scaled slope.
   * @returns This state, for chaining.
   */
  public setPolygonOffset(factor: number, units: number): this {
    const cap = glConst(this.gl, 'POLYGON_OFFSET_FILL', 0x8037);
    const enabled = factor !== 0 || units !== 0;

    this.cachedPolygonOffsetEnabled = this.applyCapability(cap, enabled, this.cachedPolygonOffsetEnabled);
    if (!enabled) return this;

    if (this.cachedPolygonOffsetFactor === factor && this.cachedPolygonOffsetUnits === units) return this;
    this.gl.polygonOffset(factor, units);
    this.cachedPolygonOffsetFactor = factor;
    this.cachedPolygonOffsetUnits = units;
    this.count();
    this.change();
    return this;
  }

  /* ------------------------------------------------------------- full state */

  /**
   * Applies every member of a {@link RenderState}.
   *
   * @param state Requested state.
   * @returns This state, for chaining.
   */
  public applyRenderState(state: Readonly<RenderState>): this {
    this.setCullFace(state.cull);
    this.setFrontFace(state.frontFaceCCW);
    this.setDepthState(state.depth);
    this.setStencilState(state.stencil);
    this.setBlendState(state.blend);
    this.setColorWriteState(state.colorWrite);
    this.setViewport(state.viewport);
    this.setScissor(state.scissor);
    this.setPolygonOffset(state.polygonOffsetFactor, state.polygonOffsetUnits);
    if (Number.isFinite(state.lineWidth) && state.lineWidth > 0) this.setLineWidth(state.lineWidth);
    return this;
  }

  /**
   * Issues the WebGL defaults and resynchronises every cached value.
   *
   * @returns This state, for chaining.
   */
  public reset(): this {
    this.invalidate();

    const gl = this.gl;
    gl.disable(glConst(gl, 'DEPTH_TEST', 0x0b71));
    this.count();
    gl.disable(glConst(gl, 'BLEND', 0x0be2));
    this.count();
    gl.disable(glConst(gl, 'CULL_FACE', 0x0b44));
    this.count();
    gl.disable(glConst(gl, 'SCISSOR_TEST', 0x0c11));
    this.count();
    gl.disable(glConst(gl, 'STENCIL_TEST', 0x0b90));
    this.count();
    gl.disable(glConst(gl, 'POLYGON_OFFSET_FILL', 0x8037));
    this.count();
    gl.depthMask(true);
    gl.depthFunc(glConst(gl, 'LESS', 0x0201));
    gl.colorMask(true, true, true, true);
    gl.frontFace(glConst(gl, 'CCW', 0x0901));
    gl.lineWidth(1);
    gl.polygonOffset(0, 0);
    this.count();
    this.count();
    this.count();
    this.count();
    this.count();
    this.count();
    if (this.isWebGL2) {
      (gl as WebGL2RenderingContext).bindVertexArray(null);
      this.count();
    }
    gl.useProgram(null);
    gl.bindBuffer(glConst(gl, 'ARRAY_BUFFER', 0x8892), null);
    gl.bindBuffer(glConst(gl, 'ELEMENT_ARRAY_BUFFER', 0x8893), null);
    this.count();
    this.count();
    this.count();

    this.cachedDepthTest = false;
    this.cachedBlend = false;
    this.cachedCullEnabled = false;
    this.cachedCullFace = UNKNOWN;
    this.cachedScissorTest = false;
    this.cachedStencilTest = false;
    this.cachedDepthWrite = true;
    this.cachedDepthFunc = glConst(gl, 'LESS', 0x0201);
    this.cachedColorMask = 15;
    this.cachedFrontFace = glConst(gl, 'CCW', 0x0901);
    this.cachedLineWidth = 1;
    this.cachedPolygonOffsetEnabled = false;
    this.cachedPolygonOffsetFactor = 0;
    this.cachedPolygonOffsetUnits = 0;
    this.cachedProgram = null;
    this.cachedArrayBuffer = null;
    this.cachedElementArrayBuffer = null;
    this.cachedVertexArray = this.isWebGL2 ? null : UNKNOWN;
    this.cachedTextures.clear();
    this.cachedActiveTexture = -1;
    this.cachedScissor = null;
    this.cachedViewport.x = NaN;
    this.cachedViewport.y = NaN;
    this.cachedViewport.width = NaN;
    this.cachedViewport.height = NaN;
    this.viewportKnown = false;
    this.cachedBlendColor[0] = NaN;
    this.cachedBlendColor[1] = NaN;
    this.cachedBlendColor[2] = NaN;
    this.cachedBlendColor[3] = NaN;
    this.cachedStencilFunc = UNKNOWN;
    this.cachedStencilReference = UNKNOWN;
    this.cachedStencilReadMask = UNKNOWN;
    this.cachedStencilWriteMask = UNKNOWN;
    return this;
  }

  /**
   * Marks every cached value unknown.
   *
   * Called after a context loss (or a reset performed by someone else), so the next
   * frame re-issues the complete state instead of trusting a stale shadow copy.
   */
  public invalidate(): void {
    this.cachedDepthTest = UNKNOWN;
    this.cachedDepthWrite = UNKNOWN;
    this.cachedDepthFunc = UNKNOWN;
    this.cachedBlend = UNKNOWN;
    this.cachedBlendSrc = UNKNOWN;
    this.cachedBlendDst = UNKNOWN;
    this.cachedBlendEquation = UNKNOWN;
    this.cachedBlendSrcAlpha = UNKNOWN;
    this.cachedBlendDstAlpha = UNKNOWN;
    this.cachedBlendAlphaEquation = UNKNOWN;
    this.cachedBlendSeparate = UNKNOWN;
    this.cachedBlendColor[0] = NaN;
    this.cachedBlendColor[1] = NaN;
    this.cachedBlendColor[2] = NaN;
    this.cachedBlendColor[3] = NaN;
    this.cachedCullEnabled = UNKNOWN;
    this.cachedCullFace = UNKNOWN;
    this.cachedFrontFace = UNKNOWN;
    this.cachedColorMask = UNKNOWN;
    this.cachedPolygonOffsetEnabled = UNKNOWN;
    this.cachedScissorTest = UNKNOWN;
    this.cachedScissor = UNKNOWN;
    this.cachedViewport.x = NaN;
    this.cachedViewport.y = NaN;
    this.cachedViewport.width = NaN;
    this.cachedViewport.height = NaN;
    this.viewportKnown = false;
    this.cachedStencilTest = UNKNOWN;
    this.cachedStencilFunc = UNKNOWN;
    this.cachedStencilReference = UNKNOWN;
    this.cachedStencilReadMask = UNKNOWN;
    this.cachedStencilWriteMask = UNKNOWN;
    this.cachedActiveTexture = -1;
    this.cachedTextures.clear();
    this.cachedArrayBuffer = undefined;
    this.cachedElementArrayBuffer = undefined;
    this.cachedVertexArray = undefined;
    this.cachedProgram = undefined;
    this.cachedLineWidth = -1;
    this.cachedPolygonOffsetFactor = NaN;
    this.cachedPolygonOffsetUnits = NaN;
    log.debug('WebGLState invalidated: the next frame re-issues the full state');
  }

  /* --------------------------------------------------------------- snapshots */

  /**
   * Describes the shadow state as a plain, comparable object.
   *
   * @returns A fresh snapshot; mutating it does not affect the state.
   */
  public getSnapshot(): WebGLStateSnapshot {
    const boundTextures: WebGLBoundTexture[] = [];
    for (const [unit, perTarget] of this.cachedTextures) {
      for (const [target, texture] of perTarget) boundTextures.push({ unit, target, texture });
    }
    boundTextures.sort((a, b) => (a.unit === b.unit ? a.target - b.target : a.unit - b.unit));

    return {
      depthTest: this.cachedDepthTest === UNKNOWN ? false : this.cachedDepthTest,
      depthWrite: this.cachedDepthWrite === UNKNOWN ? true : this.cachedDepthWrite,
      depthFunc: this.compareFromGL(this.cachedDepthFunc, CompareFunction.Less),
      blend: this.cachedBlend === UNKNOWN ? false : this.cachedBlend,
      blendSrc: this.blendFactorFromGL(this.cachedBlendSrc, BlendFactor.One),
      blendDst: this.blendFactorFromGL(this.cachedBlendDst, BlendFactor.Zero),
      blendEquation: this.blendEquationFromGL(this.cachedBlendEquation, BlendEquation.Add),
      blendSrcAlpha: this.blendFactorFromGL(this.cachedBlendSrcAlpha, BlendFactor.One),
      blendDstAlpha: this.blendFactorFromGL(this.cachedBlendDstAlpha, BlendFactor.Zero),
      blendAlphaEquation: this.blendEquationFromGL(this.cachedBlendAlphaEquation, BlendEquation.Add),
      blendSeparate: this.cachedBlendSeparate === UNKNOWN ? false : this.cachedBlendSeparate,
      blendColor: [...this.cachedBlendColor] as [number, number, number, number],
      cullFace: this.cullModeFromGL(),
      frontFaceCCW:
        this.cachedFrontFace === UNKNOWN
          ? true
          : this.cachedFrontFace === glConst(this.gl, 'CCW', 0x0901),
      colorMask: [
        (this.cachedColorMask === UNKNOWN ? 15 : this.cachedColorMask) & 1 ? true : false,
        (this.cachedColorMask === UNKNOWN ? 15 : this.cachedColorMask) & 2 ? true : false,
        (this.cachedColorMask === UNKNOWN ? 15 : this.cachedColorMask) & 4 ? true : false,
        (this.cachedColorMask === UNKNOWN ? 15 : this.cachedColorMask) & 8 ? true : false,
      ],
      scissor:
        this.cachedScissor === UNKNOWN || this.cachedScissor === null ? null : { ...this.cachedScissor },
      viewport: { ...this.cachedViewport },
      stencilTest: this.cachedStencilTest === UNKNOWN ? false : this.cachedStencilTest,
      stencilFunc: this.compareFromGL(this.cachedStencilFunc, CompareFunction.Always),
      stencilReference: this.cachedStencilReference === UNKNOWN ? 0 : this.cachedStencilReference,
      stencilReadMask: this.cachedStencilReadMask === UNKNOWN ? 0xff : this.cachedStencilReadMask,
      stencilWriteMask: this.cachedStencilWriteMask === UNKNOWN ? 0xff : this.cachedStencilWriteMask,
      activeTexture: this.cachedActiveTexture < 0 ? 0 : this.cachedActiveTexture,
      boundTextures,
      boundArrayBuffer: this.cachedArrayBuffer === undefined ? null : this.cachedArrayBuffer,
      boundElementArrayBuffer:
        this.cachedElementArrayBuffer === undefined ? null : this.cachedElementArrayBuffer,
      boundVertexArray: this.cachedVertexArray === undefined ? null : this.cachedVertexArray,
      currentProgram: this.cachedProgram === undefined ? null : this.cachedProgram,
      lineWidth: this.cachedLineWidth,
      polygonOffsetFactor: Number.isNaN(this.cachedPolygonOffsetFactor) ? 0 : this.cachedPolygonOffsetFactor,
      polygonOffsetUnits: Number.isNaN(this.cachedPolygonOffsetUnits) ? 0 : this.cachedPolygonOffsetUnits,
    };
  }

  /**
   * Pushes a snapshot of the current state.
   *
   * @returns This state, for chaining.
   */
  public pushState(): this {
    this.stack.push(this.getSnapshot());
    return this;
  }

  /**
   * Pops the most recent snapshot and re-applies it.
   *
   * Re-application goes through the ordinary setters, so only the members a nested
   * block actually altered produce GL calls.
   *
   * @returns This state, for chaining.
   * @throws Error When the stack is empty.
   */
  public popState(): this {
    const snapshot = this.stack.pop();
    if (snapshot === undefined) {
      throw new Error(
        'WebGLState.popState(): the state stack is empty. Every popState() must be ' +
          'paired with a pushState(); check that no early return skips the pop.',
      );
    }
    return this.restore(snapshot);
  }

  /**
   * Re-applies a snapshot taken earlier.
   *
   * @param snapshot Snapshot to restore.
   * @returns This state, for chaining.
   */
  public restore(snapshot: WebGLStateSnapshot): this {
    this.setDepthTest(snapshot.depthTest);
    this.setDepthWrite(snapshot.depthWrite);
    this.setDepthFunc(snapshot.depthFunc);
    this.setBlend(snapshot.blend);
    if (snapshot.blendSeparate) {
      this.setBlendFuncSeparate(
        snapshot.blendSrc,
        snapshot.blendDst,
        snapshot.blendSrcAlpha,
        snapshot.blendDstAlpha,
      );
      this.setBlendEquationSeparate(snapshot.blendEquation, snapshot.blendAlphaEquation);
    } else {
      this.setBlendFunc(snapshot.blendSrc, snapshot.blendDst);
      this.setBlendEquation(snapshot.blendEquation);
    }
    this.setBlendColor(...snapshot.blendColor);
    this.setCullFace(snapshot.cullFace);
    this.setFrontFace(snapshot.frontFaceCCW);
    this.setColorMask(...snapshot.colorMask);
    this.setScissor(snapshot.scissor);
    this.setViewport(snapshot.viewport);
    this.setStencilTest(snapshot.stencilTest);
    if (snapshot.stencilTest) {
      this.setStencilFunc(snapshot.stencilFunc, snapshot.stencilReference, snapshot.stencilReadMask);
      this.setStencilMask(snapshot.stencilWriteMask);
    }
    this.setPolygonOffset(snapshot.polygonOffsetFactor, snapshot.polygonOffsetUnits);
    if (Number.isFinite(snapshot.lineWidth) && snapshot.lineWidth > 0) this.setLineWidth(snapshot.lineWidth);

    for (const binding of snapshot.boundTextures) {
      this.bindTexture(binding.unit, binding.target, binding.texture);
    }
    this.bindArrayBuffer(snapshot.boundArrayBuffer);
    this.bindElementArrayBuffer(snapshot.boundElementArrayBuffer);
    if (this.isWebGL2) this.bindVertexArray(snapshot.boundVertexArray);
    this.useProgram(snapshot.currentProgram);
    return this;
  }

  /** Empties the snapshot stack. */
  public clearStack(): void {
    this.stack.length = 0;
  }

  /** @returns A human-readable summary of the shadow state. */
  public toString(): string {
    const snapshot = this.getSnapshot();
    return (
      `WebGLState(depth=${snapshot.depthTest ? snapshot.depthFunc : 'off'}${snapshot.depthWrite ? '+write' : ''}, ` +
      `blend=${snapshot.blend ? `${snapshot.blendSrc}->${snapshot.blendDst}` : 'off'}, ` +
      `cull=${snapshot.cullFace}, stateChanges=${this.changes})`
    );
  }

  /* --------------------------------------------------- reverse enum lookups */

  /** Maps a cached GL comparison back onto {@link CompareFunction}. */
  private compareFromGL(value: Maybe<number>, fallback: CompareFunction): CompareFunction {
    if (value === UNKNOWN) return fallback;
    const table: readonly (readonly [CompareFunction, string, number])[] = [
      [CompareFunction.Never, 'NEVER', 0x0200],
      [CompareFunction.Less, 'LESS', 0x0201],
      [CompareFunction.Equal, 'EQUAL', 0x0202],
      [CompareFunction.LessEqual, 'LEQUAL', 0x0203],
      [CompareFunction.Greater, 'GREATER', 0x0204],
      [CompareFunction.NotEqual, 'NOTEQUAL', 0x0205],
      [CompareFunction.GreaterEqual, 'GEQUAL', 0x0206],
      [CompareFunction.Always, 'ALWAYS', 0x0207],
    ];
    for (const [name, glName, fallbackValue] of table) {
      if (glConst(this.gl, glName, fallbackValue) === value) return name;
    }
    return fallback;
  }

  /** Maps a cached GL blend factor back onto {@link BlendFactor}. */
  private blendFactorFromGL(value: Maybe<number>, fallback: BlendFactor): BlendFactor {
    if (value === UNKNOWN) return fallback;
    const table: readonly (readonly [BlendFactor, string, number])[] = [
      [BlendFactor.Zero, 'ZERO', 0],
      [BlendFactor.One, 'ONE', 1],
      [BlendFactor.SrcColor, 'SRC_COLOR', 0x0300],
      [BlendFactor.OneMinusSrcColor, 'ONE_MINUS_SRC_COLOR', 0x0301],
      [BlendFactor.SrcAlpha, 'SRC_ALPHA', 0x0302],
      [BlendFactor.OneMinusSrcAlpha, 'ONE_MINUS_SRC_ALPHA', 0x0303],
      [BlendFactor.DstAlpha, 'DST_ALPHA', 0x0304],
      [BlendFactor.OneMinusDstAlpha, 'ONE_MINUS_DST_ALPHA', 0x0305],
      [BlendFactor.DstColor, 'DST_COLOR', 0x0306],
      [BlendFactor.OneMinusDstColor, 'ONE_MINUS_DST_COLOR', 0x0307],
      [BlendFactor.SrcAlphaSaturate, 'SRC_ALPHA_SATURATE', 0x0308],
      [BlendFactor.ConstantColor, 'CONSTANT_COLOR', 0x8001],
      [BlendFactor.OneMinusConstantColor, 'ONE_MINUS_CONSTANT_COLOR', 0x8002],
      [BlendFactor.ConstantAlpha, 'CONSTANT_ALPHA', 0x8003],
      [BlendFactor.OneMinusConstantAlpha, 'ONE_MINUS_CONSTANT_ALPHA', 0x8004],
    ];
    for (const [name, glName, fallbackValue] of table) {
      if (glConst(this.gl, glName, fallbackValue) === value) return name;
    }
    return fallback;
  }

  /** Maps a cached GL equation back onto {@link BlendEquation}. */
  private blendEquationFromGL(value: Maybe<number>, fallback: BlendEquation): BlendEquation {
    if (value === UNKNOWN) return fallback;
    const table: readonly (readonly [BlendEquation, string, number])[] = [
      [BlendEquation.Add, 'FUNC_ADD', 0x8006],
      [BlendEquation.Subtract, 'FUNC_SUBTRACT', 0x800a],
      [BlendEquation.ReverseSubtract, 'FUNC_REVERSE_SUBTRACT', 0x800b],
      [BlendEquation.Min, 'MIN', 0x8007],
      [BlendEquation.Max, 'MAX', 0x8008],
    ];
    for (const [name, glName, fallbackValue] of table) {
      if (glConst(this.gl, glName, fallbackValue) === value) return name;
    }
    return fallback;
  }

  /** Maps the cached cull face back onto {@link CullMode}. */
  private cullModeFromGL(): CullMode {
    if (this.cachedCullEnabled !== true) return CullMode.None;
    const value = this.cachedCullFace;
    if (value === UNKNOWN) return CullMode.Back;
    if (value === glConst(this.gl, 'FRONT', 0x0404)) return CullMode.Front;
    if (value === glConst(this.gl, 'BACK', 0x0405)) return CullMode.Back;
    if (value === glConst(this.gl, 'FRONT_AND_BACK', 0x0408)) return CullMode.FrontAndBack;
    return CullMode.Back;
  }
}

/**
 * Clamps a caller-supplied line width into the driver's aliased range.
 *
 * Exported because the renderer logs when a caller asks for a width the driver
 * cannot honour; the clamp itself lives here so it stays testable without a GPU.
 *
 * @param width Requested width in pixels.
 * @param range Inclusive range the driver reported.
 */
export function clampLineWidth(width: number, range: readonly [number, number]): number {
  if (!Number.isFinite(width) || width <= 0) return range[0];
  return clamp(width, range[0], range[1]);
}
