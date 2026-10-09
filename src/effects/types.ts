/**
 * Shared type vocabulary for the effects subsystem.
 *
 * Post-processing, shadows, fog and particles have almost nothing in common except that
 * they all need to talk to a *renderer* the library must not import (other agents own
 * `src/renderer/webgl` and `src/renderer/webgpu`), and to *materials* and *textures* the
 * library must not import either. Every one of those relationships is therefore a
 * structural interface here, documented with exactly which members this package calls.
 *
 * @packageDocumentation
 */

import type { Color } from '../math/Color';
import type { Rect } from '../math/Rect';
import type { Vec2 } from '../math/Vec2';
import type { Vec3 } from '../math/Vec3';

/* -------------------------------------------------------------------------- */
/* Shader / material contracts                                                */
/* -------------------------------------------------------------------------- */

/** The shader description a `ShaderPass` can be built from. */
export interface ShaderDescriptorLike {
  /** Stable identifier, used as a cache key. */
  id?: string;
  /** Shading language; defaults to `'glsl'`. */
  language?: 'glsl' | 'wgsl';
  /** Vertex stage source, for a GLSL pair. */
  vertex?: string;
  /** Fragment stage source, for a GLSL pair. */
  fragment?: string;
  /** Combined source, for a WGSL module or a single-file GLSL shader. */
  source?: string;
  /** Preprocessor defines. */
  defines?: Record<string, string | number | boolean>;
  /** Initial uniform values. */
  uniforms?: Record<string, UniformValue>;
}

/** A value that can be uploaded to a uniform. */
export type UniformValue =
  | number
  | boolean
  | number[]
  | Float32Array
  | Int32Array
  | Vec2
  | Vec3
  | Color
  | TextureLike
  | null
  | undefined;

/** A uniform map keyed by name. */
export type UniformMap = Record<string, UniformValue>;

/** A structural texture. */
export interface TextureLike {
  /** Source image or data. */
  image?: unknown;
  /** Width in texels. */
  width?: number;
  /** Height in texels. */
  height?: number;
  /** `true` when the bytes changed. */
  needsUpdate?: boolean;
  /** Releases GPU resources. */
  dispose?(): void;
}

/** A structural material. */
export interface MaterialLike {
  /** `false` skips the object. */
  visible?: boolean;
  /** `true` when the material is not fully opaque. */
  transparent?: boolean;
  /** Resolved opacity. */
  opacity?: number;
  /** `'front'`, `'back'` or `'double'`. */
  side?: string;
  /** Whether the material writes depth. */
  depthWrite?: boolean;
  /** Whether the material tests depth. */
  depthTest?: boolean;
  /** Which colour attachments it writes, for an MRT pass. */
  blendMode?: string;
  /** Releases GPU resources. */
  dispose?(): void;
}

/** A structural scene. */
export interface SceneLike {
  /** Background colour, as a hex integer or a CSS string. */
  background?: number | string | null;
  /** Fog descriptor. */
  fog?: unknown;
  /** Root children, when the scene is traversable. */
  children?: readonly unknown[];
  /** Recomputes world matrices. */
  updateMatrixWorld?(force?: boolean): void;
}

/** A structural camera. */
export interface CameraLike {
  /** World matrix. */
  matrixWorld?: { elements: ArrayLike<number> };
  /** Inverse world matrix. */
  matrixWorldInverse?: { elements: ArrayLike<number> };
  /** Projection matrix. */
  projectionMatrix?: { elements: ArrayLike<number> };
  /** Projection-inverse matrix. */
  projectionInverse?: { elements: ArrayLike<number> };
  /** Near plane distance. */
  near?: number;
  /** Far plane distance. */
  far?: number;
}

/**
 * The minimal renderer surface `ShadowMap` and the post-processing passes call.
 *
 * Every member is optional and every call site is guarded, so a headless test can pass a
 * recorder that implements only the methods it wants to observe.
 *
 * | Member | Called by | Purpose |
 * | --- | --- | --- |
 * | `createRenderTarget` | `ShadowMap`, `EffectComposer` | allocate shadow and ping-pong targets |
 * | `destroyRenderTarget` | both | release them |
 * | `setRenderTarget` | both | bind a target, `null` for the screen |
 * | `clear` | both | clear colour/depth before a pass |
 * | `render` | `RenderPass`, `ShadowMap` | draw a scene |
 * | `setViewport` | `ShadowMap` | restrict a shadow map to a cascade |
 * | `getSize` | `EffectComposer` | initial target sizing |
 * | `readPixels` | `GPUPicking`-style consumers | readback |
 */
export interface RendererLike {
  /** Creates an off-screen target. */
  createRenderTarget?(options: Record<string, unknown>): unknown;
  /** Releases an off-screen target. */
  destroyRenderTarget?(target: unknown): void;
  /** Binds a target; `null` means the screen. */
  setRenderTarget?(target: unknown): void;
  /** Clears the bound target. */
  clear?(options?: Record<string, unknown>): void;
  /** Draws a scene. */
  render?(scene: unknown, camera: unknown, overrideMaterial?: unknown): void;
  /** Sets the viewport in device pixels. */
  setViewport?(x: number, y: number, width: number, height: number): void;
  /** Reports the drawing-surface size. */
  getSize?(): { width: number; height: number };
  /** Reads pixels back from the bound target. */
  readPixels?(x: number, y: number, width?: number, height?: number): Uint8ClampedArray | null;
  /** Compiles a shader; used by `ShaderPass` when available. */
  createShader?(descriptor: ShaderDescriptorLike): unknown;
  /** Releases a compiled shader. */
  destroyShader?(shader: unknown): void;
  /** Binds a material. */
  setMaterial?(material: unknown): void;
  /** Draws the currently bound material over the current target. */
  drawFullscreenQuad?(): void;
  /** Applies a uniform map. */
  applyUniforms?(shader: unknown, uniforms: UniformMap): void;
}

/* -------------------------------------------------------------------------- */
/* Post-processing                                                            */
/* -------------------------------------------------------------------------- */

/** Options accepted by the post-processing passes. */
export interface PostProcessOptions {
  /** Pass name, used in diagnostics. */
  name?: string;
  /** Sort order within the composer. */
  order?: number;
  /** `false` starts the pass disabled. */
  enabled?: boolean;
  /** Resolution scale applied to the pass's own targets; defaults to `1`. */
  resolutionScale?: number;
}

/** One pass in a composer, as far as the composer needs to know. */
export interface PassLike {
  /** Stable identifier. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** `false` skips the pass. */
  enabled: boolean;
  /** Sort order. */
  order: number;
  /** `true` when the composer must swap buffers after this pass. */
  needsSwap: boolean;
  /** `true` when this pass draws to the screen. */
  renderToScreen: boolean;
  /** Optional attach hook. */
  onAttach?(context: unknown): void;
  /** Optional detach hook. */
  onDetach?(): void;
  /** Sizes the pass's own targets. */
  setSize?(width: number, height: number): void;
  /** Resets internal state. */
  reset?(): void;
  /** Executes the pass. */
  execute(context: unknown): void;
}

/** Construction options for a composer. */
export interface EffectComposerOptions extends PostProcessOptions {
  /** Explicit render target size; derived from the renderer when omitted. */
  width?: number;
  /** Explicit render target size. */
  height?: number;
  /** Device-pixel ratio applied to the target size; defaults to `1`. */
  pixelRatio?: number;
  /** Renderer used for the pass sequence. */
  renderer?: RendererLike | null;
  /** Target factory; when omitted the composer falls back to a resource-less target. */
  targetFactory?: RenderTargetFactoryLike | null;
  /** `true` (the default) sorts the passes by `order` before each execution. */
  autoSort?: boolean;
  /** `true` keeps executing after a pass throws. */
  continueOnError?: boolean;
}

/** The subset of a target factory a composer uses. */
export interface RenderTargetFactoryLike {
  /** Creates an off-screen target. */
  createRenderTarget(options: Record<string, unknown>): unknown;
  /** Releases one. */
  destroyRenderTarget(target: unknown): void;
}

/* -------------------------------------------------------------------------- */
/* Bloom / blur / FXAA / SSAO / outline                                       */
/* -------------------------------------------------------------------------- */

/** Options accepted by `BloomPass`. */
export interface BloomOptions extends PostProcessOptions {
  /** Multiplier applied to the blurred result; defaults to `1`. */
  strength?: number;
  /** Blur radius in texels; defaults to `1`. */
  radius?: number;
  /** Luminance above which a pixel contributes; defaults to `0.85`. */
  threshold?: number;
  /** Soft-knee width around the threshold; defaults to `0.1`. */
  knee?: number;
  /** Blur iterations; defaults to `5`. */
  iterations?: number;
  /** Target resolution scale; defaults to `0.5`. */
  resolutionScale?: number;
}

/** Blur kernels `BlurPass` can use. */
export type BlurKernel = 'gaussian' | 'kawase' | 'box';

/** Blur direction. */
export type BlurDirection = 'horizontal' | 'vertical' | 'both';

/** Options accepted by `BlurPass`. */
export interface BlurOptions extends PostProcessOptions {
  /** Kernel; defaults to `'gaussian'`. */
  kernel?: BlurKernel;
  /** Direction of the separable pass; defaults to `'both'` (two sub-passes). */
  direction?: BlurDirection;
  /** Odd kernel size for the Gaussian; defaults to `9`. */
  kernelSize?: number;
  /** Standard deviation; derived from `kernelSize` when omitted. */
  sigma?: number;
  /** Kawase iteration count; defaults to `2`. */
  kawaseIterations?: number;
  /** Kawase offset in texels; defaults to `1`. */
  kawaseOffset?: number;
}

/** Options accepted by `FXAAPass`. */
export interface FXAAOptions extends PostProcessOptions {
  /** Contrast threshold above which an edge is kept; defaults to `0.0312`. */
  threshold?: number;
  /** Absolute minimum local contrast; defaults to `0.063`. */
  edgeThresholdMin?: number;
  /** Relative local contrast; defaults to `0.125`. */
  edgeThreshold?: number;
  /** Sub-pixel aliasing removal amount in `[0, 1]`; defaults to `0.75`. */
  subpixel?: number;
  /** `true` darkens the overall image; defaults to `false`. */
  darkening?: boolean;
}

/** Options accepted by `SSAOPass`. */
export interface SSAOOptions extends PostProcessOptions {
  /** Hemisphere sample count; defaults to `16`. */
  kernelSize?: number;
  /** Sampling radius in world units; defaults to `0.5`. */
  radius?: number;
  /** Minimum sample distance; defaults to `0.005`. */
  minDistance?: number;
  /** Maximum sample distance; defaults to `0.05`. */
  maxDistance?: number;
  /** Occlusion multiplier; defaults to `1`. */
  intensity?: number;
  /** Depth bias; defaults to `0.025`. */
  bias?: number;
  /** Noise texture edge length; defaults to `4`. */
  noiseSize?: number;
  /** Seed for the deterministic kernel; defaults to `1`. */
  seed?: number;
}

/** Options accepted by `OutlinePass`. */
export interface OutlineOptions extends PostProcessOptions {
  /** Edge strength; defaults to `3`. */
  edgeStrength?: number;
  /** Glow multiplier; defaults to `0.5`. */
  edgeGlow?: number;
  /** Edge thickness in texels; defaults to `1`. */
  edgeThickness?: number;
  /** Pulse period in seconds; `0` disables pulsing. */
  pulsePeriod?: number;
  /** Colour of a silhouette edge; defaults to white. */
  visibleEdgeColor?: number | string | Color;
  /** Colour of an occluded edge; defaults to black. */
  hiddenEdgeColor?: number | string | Color;
  /** Objects to outline. */
  selectedObjects?: unknown[];
}

/** Clear description forwarded to the renderer. */
export interface EffectsClearOptions {
  /** `true` clears the colour buffer. */
  color?: boolean;
  /** `true` clears the depth buffer. */
  depth?: boolean;
  /** `true` clears the stencil buffer. */
  stencil?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Shadows                                                                    */
/* -------------------------------------------------------------------------- */

/** Shadow filtering modes. */
export enum ShadowMapType {
  /** One depth comparison per fragment. */
  Basic = 0,
  /** Percentage-closer filtering with a 3x3 kernel. */
  PCF = 1,
  /** PCF with a wider, jittered kernel. */
  PCFSoft = 2,
  /** Variance shadow maps: blurrable depth moments. */
  VSM = 3,
}

/** What kind of light a shadow target belongs to. */
export type ShadowLightKind = 'directional' | 'spot' | 'point' | 'unknown';

/**
 * A structural light, as `ShadowMap` reads it.
 *
 * The `type` string and the `is*` flags are both accepted because `src/scene` sets the
 * flags while an imported glTF sets `type`.
 */
export interface LightLike {
  /** Class name (`'DirectionalLight'`, ...). */
  type?: string;
  /** `true` for a directional light. */
  readonly isDirectionalLight?: boolean;
  /** `true` for a spot light. */
  readonly isSpotLight?: boolean;
  /** `true` for a point light. */
  readonly isPointLight?: boolean;
  /** World position. */
  position?: Vec3;
  /** Light direction target. */
  target?: { position?: Vec3; matrixWorld?: { elements: ArrayLike<number> } };
  /** World matrix. */
  matrixWorld?: { elements: ArrayLike<number> };
  /** `false` removes the light from the shadow pass. */
  castShadow?: boolean;
  /** `false` disables shadow rendering for this light. */
  visible?: boolean;
  /** Shadow configuration; `mapSize` and `bias` are read when present. */
  shadow?: {
    /** `false` disables the shadow. */
    enabled?: boolean;
    /** Requested map size. */
    mapSize?: { width: number; height: number };
    /** Depth bias. */
    bias?: number;
    /** Normal-scaled bias. */
    normalBias?: number;
    /** Near plane distance. */
    near?: number;
    /** Far plane distance. */
    far?: number;
    /** Radius, for soft filters. */
    radius?: number;
  };
}

/** One shadow render target. */
export interface ShadowTarget {
  /** Owning light. */
  light: LightLike;
  /** Kind of light. */
  kind: ShadowLightKind;
  /** Cascade index; always `0` for non-directional lights. */
  cascade: number;
  /** Cascade count for the owning light. */
  cascadeCount: number;
  /** Allocated target, when a factory was supplied. */
  target: unknown;
  /** Map size in texels. */
  size: number;
  /** `true` when the target has valid contents. */
  needsUpdate: boolean;
}

/** Options accepted by `ShadowMap`. */
export interface ShadowMapOptions {
  /** Filtering mode; defaults to `PCFSoft`. */
  type?: ShadowMapType;
  /** Map size in texels; defaults to `1024`. */
  size?: number;
  /** `true` (the default) refreshes every frame. */
  autoUpdate?: boolean;
  /** Force a one-frame refresh on the next `render`. */
  needsUpdate?: boolean;
  /** Depth bias; defaults to `-0.0005`. */
  bias?: number;
  /** Normal-scaled bias; defaults to `0.02`. */
  normalBias?: number;
  /** Blur radius for soft filters; defaults to `1`. */
  radius?: number;
  /** VSM blur samples; defaults to `8`. */
  blurSamples?: number;
  /** Cascades per directional light; defaults to `1`. */
  cascades?: number;
  /** Cascade split distances, for `cascades > 1`. */
  cascadeSplits?: readonly number[];
  /** Target factory; without one the map tracks metadata only. */
  targetFactory?: RenderTargetFactoryLike | null;
  /** `false` disables the map entirely. */
  enabled?: boolean;
  /** Depth comparison function name; recorded only. */
  depthFunc?: string;
  /** `true` renders the shadow pass in wireframe; recorded only. */
  wireframe?: boolean;
}

/** One cascade's configuration. */
export interface CascadeConfig {
  /** Cascade index. */
  index: number;
  /** Near distance of the split. */
  near: number;
  /** Far distance of the split. */
  far: number;
  /** Orthographic half-extent used to fit the split. */
  extent: number;
}

/* -------------------------------------------------------------------------- */
/* Fog                                                                        */
/* -------------------------------------------------------------------------- */

/** Fog models. */
export type FogType = 'none' | 'linear' | 'exp' | 'exp2';

/** Options accepted by `Fog`. */
export interface FogOptions {
  /** Model; defaults to `'linear'`. */
  type?: FogType;
  /** Fog colour. */
  color?: number | string | Color;
  /** Near distance for linear fog; defaults to `1`. */
  near?: number;
  /** Far distance for linear fog; defaults to `1000`. */
  far?: number;
  /** Density for exponential fog; defaults to `0.00025`. */
  density?: number;
  /** `false` disables the fog without removing it. */
  enabled?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Particles                                                                  */
/* -------------------------------------------------------------------------- */

/** Emitter shapes. */
export type ParticleShape = 'point' | 'sphere' | 'box' | 'cone' | 'circle';

/** A range, or a single value that is treated as a degenerate range. */
export type RangeValue = number | { min: number; max: number };

/** A colour range, as one colour or two. */
export type ColorRangeValue = number | string | Color | readonly [number | string | Color, number | string | Color];

/** Blending presets for `ParticleMaterial`. */
export type ParticleBlendMode = 'normal' | 'additive' | 'subtractive' | 'multiply';

/** The blend state a preset resolves to. */
export interface ParticleBlendState {
  /** Source factor, as a backend-independent name. */
  src: string;
  /** Destination factor. */
  dst: string;
  /** Blend equation. */
  equation: string;
  /** `true` when the source is expected to be premultiplied. */
  premultiplied: boolean;
  /** `'normal'`, `'additive'`, `'subtractive'` or `'multiply'`. */
  mode: ParticleBlendMode;
}

/** Options accepted by `ParticleEmitter`. */
export interface ParticleEmitterOptions {
  /** Emission shape; defaults to `'point'`. */
  shape?: ParticleShape;
  /** Emitter origin in local space. */
  position?: Vec3;
  /** Initial direction; defaults to `+Y`. */
  direction?: Vec3;
  /** Cone half-angle in radians; defaults to `0.25`. */
  spread?: number;
  /** Sphere/circle radius; defaults to `1`. */
  radius?: number;
  /** Alias of `radius`, for readability at a sphere call site. */
  sphereRadius?: number;
  /** Circle radius; defaults to `radius`. */
  circleRadius?: number;
  /** Box half-extents; defaults to `(1, 1, 1)`. */
  boxSize?: Vec3;
  /** Cone height; defaults to `1`. */
  coneHeight?: number;
  /** Cone base radius; defaults to `radius`. */
  coneRadius?: number;
  /** `true` spawns on the shape's surface, `false` inside its volume. */
  emitFromEdge?: boolean;
  /** Particles per second; defaults to `10`. */
  rate?: number;
  /** Particles released in one burst. */
  burst?: number;
  /** Seconds between bursts; `0` disables bursting. */
  burstInterval?: number;
  /** Initial speed range. */
  speed?: RangeValue;
  /** Particle lifetime range in seconds; defaults to `{ min: 1, max: 1 }`. */
  lifetime?: RangeValue;
  /** Initial size range; defaults to `{ min: 1, max: 1 }`. */
  size?: RangeValue;
  /** Final size range, for size-over-life; defaults to the initial size. */
  endSize?: RangeValue;
  /** Initial colour range. */
  color?: ColorRangeValue;
  /** Final colour range, for a colour ramp. */
  endColor?: ColorRangeValue;
  /** Initial rotation range, in radians. */
  rotation?: RangeValue;
  /** Angular velocity range, in radians per second. */
  angularVelocity?: RangeValue;
  /** Gravity in world units per second squared. */
  gravity?: Vec3;
  /** Linear drag coefficient; defaults to `0`. */
  drag?: number;
  /** `true` treats velocities as world-space rather than emitter-local. */
  worldSpace?: boolean;
  /** Seed for the deterministic random source. */
  seed?: number;
}

/** Options accepted by `ParticleSystem`. */
export interface ParticleSystemOptions {
  /** Maximum live particles; defaults to `1000`. */
  maxParticles?: number;
  /** Particles emitted per second; defaults to `10`. */
  emissionRate?: number;
  /** Emission duration in seconds; `0` means "unlimited". */
  duration?: number;
  /** `true` (the default) restarts emission at the end of a duration. */
  loop?: boolean;
  /**
   * Emitter configuration.
   *
   * Typed as `unknown` to avoid a circular type reference between the option bag and the
   * class it configures; `ParticleSystem` accepts either a `ParticleEmitter` instance or a
   * `ParticleEmitterOptions` record.
   */
  emitter?: unknown;
  /**
   * Material configuration.
   *
   * Typed as `unknown` for the same reason as {@link ParticleSystemOptions.emitter}.
   */
  material?: unknown;
  /** Seed for the deterministic random source. */
  seed?: number;
  /** `true` (the default) starts emitting on construction. */
  autoStart?: boolean;
}

/** Options accepted by `ParticleMaterial`. */
export interface ParticleMaterialOptions {
  /** Base colour. */
  color?: number | string | Color;
  /** Opacity in `[0, 1]`; defaults to `1`. */
  opacity?: number;
  /** Point size in world units. */
  size?: number;
  /** `false` keeps the point size constant in screen space. */
  sizeAttenuation?: boolean;
  /** Blend preset; defaults to `'normal'`. */
  blending?: ParticleBlendMode;
  /** `true` (the default) renders round sprites rather than squares. */
  billboard?: boolean;
  /** `true` applies the scene's fog. */
  fog?: boolean;
  /** `true` (the default) tests depth. */
  depthTest?: boolean;
  /** Whether the material writes depth; defaults to `false`. */
  depthWrite?: boolean;
  /** Soft-particle fade distance. */
  softParticles?: boolean;
  /** Particle texture. */
  map?: TextureLike | null;
  /** Texture coordinate offset. */
  mapOffset?: Vec2;
  /** Texture coordinate scale. */
  mapScale?: Vec2;
  /** A fixed rotation applied to every particle, in radians. */
  rotation?: number;
}

/** Statistics for one particle system. */
export interface ParticleStats {
  /** Live particle count. */
  alive: number;
  /** Particles spawned since construction. */
  spawned: number;
  /** Particles killed since construction. */
  killed: number;
  /** Capacity. */
  capacity: number;
  /** `alive / capacity`. */
  utilization: number;
  /** Fractional emission carry-over. */
  emissionAccumulator: number;
  /** Seconds of emission remaining, or `Infinity`. */
  emissionRemaining: number;
  /** `true` while emitting. */
  emitting: boolean;
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

/** A screen-space rectangle, accepted by the outline and SSAO passes. */
export type RectLike = Rect;

/** A point-shaped value. */
export type PointLike = Vec2;
