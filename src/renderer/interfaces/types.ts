/**
 * Shared renderer types.
 *
 * This module holds every value type that crosses a backend boundary. Nothing
 * here imports a concrete backend, so `interfaces` stays free of cycles and can
 * be consumed by the WebGL/WebGPU implementations as well.
 *
 * @packageDocumentation
 */

import type { BackendName } from '../../constants';
import type { CanvasLike } from '../utils/createCanvas';
import type { ColorInput, RGBA } from '../utils/colorUtils';
import type { IShader } from './IShader';

/* -------------------------------------------------------------------------- */
/* Enumerations                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Blend factors, named after the WebGL `blendFunc` constants.
 *
 * The 2D backends map the subset they support onto
 * `CanvasRenderingContext2D.globalCompositeOperation` and ignore the rest.
 */
export enum BlendFactor {
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

/** Depth/stencil comparison functions (`depthFunc`). */
export enum CompareFunction {
  Never = 'never',
  Less = 'less',
  Equal = 'equal',
  LessEqual = 'less-equal',
  Greater = 'greater',
  NotEqual = 'not-equal',
  GreaterEqual = 'greater-equal',
  Always = 'always',
}

/** Polygon culling modes. */
export enum CullMode {
  None = 'none',
  Front = 'front',
  Back = 'back',
  /** Cull both faces; used to draw nothing but still write depth. */
  FrontAndBack = 'front-and-back',
}

/** Primitive assembly topology. */
export enum PrimitiveTopology {
  Points = 'points',
  Lines = 'lines',
  LineLoop = 'line-loop',
  LineStrip = 'line-strip',
  Triangles = 'triangles',
  TriangleStrip = 'triangle-strip',
  TriangleFan = 'triangle-fan',
}

/** High-level draw mode used by the 2D backends. */
export enum DrawMode {
  Fill = 'fill',
  Stroke = 'stroke',
  FillAndStroke = 'fill-and-stroke',
}

/** Texture/pixel storage formats. */
export enum PixelFormat {
  R8 = 'r8',
  RG8 = 'rg8',
  RGB8 = 'rgb8',
  RGBA8 = 'rgba8',
  SRGB8Alpha8 = 'srgb8-alpha8',
  R16F = 'r16f',
  RG16F = 'rg16f',
  RGBA16F = 'rgba16f',
  R32F = 'r32f',
  RGBA32F = 'rgba32f',
  Depth16 = 'depth16',
  Depth24Stencil8 = 'depth24-stencil8',
  Depth32F = 'depth32f',
  BGRA8 = 'bgra8',
}

/** Texture magnification/minification filters. */
export enum TextureFilter {
  Nearest = 'nearest',
  Linear = 'linear',
  NearestMipmapNearest = 'nearest-mipmap-nearest',
  LinearMipmapNearest = 'linear-mipmap-nearest',
  NearestMipmapLinear = 'nearest-mipmap-linear',
  LinearMipmapLinear = 'linear-mipmap-linear',
}

/** Texture coordinate wrapping. */
export enum TextureWrap {
  ClampToEdge = 'clamp-to-edge',
  Repeat = 'repeat',
  MirroredRepeat = 'mirrored-repeat',
}

/* -------------------------------------------------------------------------- */
/* Geometry values                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A viewport rectangle, usually in device pixels.
 *
 * Coordinates are relative to the bottom-left corner in the GPU backends and to
 * the top-left corner in the Canvas2D/SVG backends; each backend documents its
 * own convention on {@link IRenderer.setViewport}.
 *
 * This is the *structural* form. The mutable value class with the same purpose
 * lives in `renderer/core/Viewport.ts` and is the one re-exported from the
 * renderer barrel — `export *` treats a value/type name collision as ambiguous,
 * so the two names are kept distinct on purpose (the same convention `Vector2` /
 * `Vector2Like` follows elsewhere in the library).
 */
export interface ViewportLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A scissor rectangle in device pixels. */
export interface ScissorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/** Background/clear colour accepted by every renderer. */
export type ClearColorInput = ColorInput;

/**
 * Clear-bit mask.
 *
 * The numeric values are bit flags so they can be combined with `|`; the
 * Canvas2D/SVG backends only honour {@link ClearFlags.Color}.
 */
export enum ClearFlags {
  None = 0,
  Color = 1 << 0,
  Depth = 1 << 1,
  Stencil = 1 << 2,
  All = Color | Depth | Stencil,
}

/** Per-call clear overrides accepted by {@link IRenderer.clear}. */
export interface ClearOptions {
  /** Colour to fill with; `null` keeps the renderer's clear colour. */
  color?: ClearColorInput | null;
  /** Depth value written when the depth bit is set. */
  depth?: number;
  /** Stencil value written when the stencil bit is set. */
  stencil?: number;
  /** Which buffers to clear; defaults to `ClearFlags.All`. */
  flags?: ClearFlags;
}

/** Extra options accepted by {@link IRenderer.setAnimationLoop}. */
export interface AnimationLoopOptions {
  /** Clamp the reported delta (seconds) to this value. Defaults to `MAX_DELTA`. */
  maxDelta?: number;
  /** `true` when the loop should start immediately. */
  autoStart?: boolean;
}

/** Anything the renderer may target: a canvas, a selector or nothing at all. */
export type RendererTarget = CanvasLike | string | HTMLElement | null | undefined;

/**
 * Options shared by every renderer implementation.
 *
 * Concrete backends extend this with their own attribute bags.
 */
export interface RendererOptions {
  /**
   * Canvas to render into. Accepts a canvas-like object, a CSS selector, or
   * `null`/`undefined`. When omitted the renderer tries to create a canvas and
   * falls back to a headless "null surface" in environments without one.
   */
  canvas?: RendererTarget;
  /**
   * Element the renderer's `domElement` is appended to, when it has to create
   * one (the SVG backend). Defaults to `document.body`.
   */
  container?: HTMLElement | string | null;
  /** Initial logical width in CSS pixels. Defaults to the canvas size, or `300`. */
  width?: number;
  /** Initial logical height in CSS pixels. Defaults to the canvas size, or `150`. */
  height?: number;
  /** Initial device-pixel ratio; defaults to `getPixelRatio()`. */
  pixelRatio?: number;
  /** Background colour used by {@link IRenderer.clear}. */
  clearColor?: ClearColorInput;
  /** Background alpha, overriding the alpha of `clearColor`. */
  clearAlpha?: number;
  /** `true` to resize the drawing buffer to the CSS/display size automatically. */
  autoResize?: boolean;
  /** `true` to keep the CSS size in sync with `setSize`. Defaults to `true`. */
  updateStyle?: boolean;
  /** `true` to clear automatically at the start of every `render` call. */
  autoClear?: boolean;
  /** Cap on `devicePixelRatio`, to bound the drawing-buffer area. */
  maxPixelRatio?: number;
  /** Human-readable label used in logs. */
  name?: string;
}

/** Options accepted when creating a render target. */
export interface RenderTargetOptions {
  /** Target width in device pixels. */
  width: number;
  /** Target height in device pixels. */
  height: number;
  /** Number of colour attachments; defaults to `1`. */
  colorAttachments?: number;
  /** Allocate a depth buffer. Defaults to `true`. */
  depth?: boolean;
  /** Pixel format of the depth buffer. */
  depthFormat?: PixelFormat;
  /** Allocate a stencil buffer. Defaults to `false`. */
  stencil?: boolean;
  /** Generate a mipmap chain for the colour attachment. Defaults to `false`. */
  mipmaps?: boolean;
  /** Sample count for MSAA targets; `1` disables multisampling. */
  samples?: number;
  /** Colour attachment format. Defaults to `PixelFormat.RGBA8`. */
  format?: PixelFormat;
  /** Filtering applied to the colour attachment. */
  filter?: TextureFilter;
  /** Wrapping applied to the colour attachment. */
  wrap?: TextureWrap;
}

/* -------------------------------------------------------------------------- */
/* Introspection                                                              */
/* -------------------------------------------------------------------------- */

/** Static description of a live renderer instance. */
export interface RendererInfo {
  /** Backend name the renderer implements. */
  readonly backend: BackendName;
  /** Drawing-buffer width in device pixels. */
  readonly width: number;
  /** Drawing-buffer height in device pixels. */
  readonly height: number;
  /** Logical (CSS) width in pixels. */
  readonly logicalWidth: number;
  /** Logical (CSS) height in pixels. */
  readonly logicalHeight: number;
  /** Active device-pixel ratio. */
  readonly pixelRatio: number;
  /** Unmasked GPU renderer string, when the backend can report one. */
  readonly renderer?: string;
  /** Unmasked GPU vendor string, when the backend can report one. */
  readonly vendor?: string;
  /** Maximum texture dimension the backend accepts. */
  readonly maxTextureSize?: number;
  /** Maximum number of simultaneous texture units. */
  readonly maxTextureUnits?: number;
  /** Maximum number of vertex attributes. */
  readonly maxAttributes?: number;
  /** Capabilities the concrete backend advertised during initialisation. */
  readonly capabilities: readonly string[];
}

/** Per-frame numbers accumulated by a renderer. */
export interface RenderStats {
  /** Frames submitted since the last {@link RenderStats.reset}. */
  frame: number;
  /** Draw calls issued in the current frame. */
  drawCalls: number;
  /** Triangles submitted in the current frame. */
  triangles: number;
  /** Vertices submitted in the current frame. */
  vertices: number;
  /** Lines submitted in the current frame. */
  lines: number;
  /** Points submitted in the current frame. */
  points: number;
  /** Renderables submitted in the current frame. */
  objects: number;
  /** Renderables rejected by frustum culling in the current frame. */
  culled: number;
  /** Textures uploaded since the renderer was created. */
  textureUploads: number;
  /** Buffers uploaded since the renderer was created. */
  bufferUploads: number;
  /** Shader programs compiled since the renderer was created. */
  programCompiles: number;
  /** State blocks applied since the renderer was created. */
  stateChanges: number;
  /** Wall-clock duration of the last frame, in milliseconds. */
  frameTime: number;
  /** Frames per second, smoothed with an exponential moving average. */
  fps: number;
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Structural description of a vertex attribute.
 *
 * Matches the shape produced by the geometry layer (`BufferAttribute`) without
 * importing it, so this module stays independently type-checkable.
 */
export interface AttributeLike {
  /** Component array. */
  array: ArrayLike<number>;
  /** Components per vertex (1..4). */
  itemSize: number;
  /** `true` when values are normalised integers. */
  normalized?: boolean;
  /** Number of vertices. */
  count?: number;
  /** `true` when the attribute is uploaded once and never rewritten. */
  static?: boolean;
  /** Monotonic version used for change detection. */
  version?: number;
}

/**
 * Structural description of a geometry resource.
 *
 * Any object satisfying this shape can be handed to a backend's buffer builder.
 */
export interface GeometryLike {
  /** Returns an attribute by name, or `undefined` when absent. */
  getAttribute(name: string): AttributeLike | undefined;
  /** Returns the index buffer description, or `undefined` for non-indexed geometry. */
  getIndex(): { array: ArrayLike<number>; itemSize: number; count?: number } | undefined;
  /** Names of every attribute the geometry exposes. */
  readonly attributeNames?: readonly string[];
  /** Stable identifier used for cache keys. */
  readonly id?: string;
}

/**
 * Structural description of a material, as consumed by the render list.
 *
 * Declared structurally so the renderer never imports `src/materials` (which may
 * not exist yet). Any object with these members is accepted.
 */
export interface MaterialLike {
  /** Stable identifier; used as the secondary sort key by the render queue. */
  readonly id?: string | number;
  /** `true` when the material blends against what is already in the target. */
  readonly transparent?: boolean;
  /** Overrides the renderable's own `renderOrder` when present. */
  readonly renderOrder?: number;
  /** Shader program backing the material, when the backend has one. */
  readonly shader?: IShader | null;
}

