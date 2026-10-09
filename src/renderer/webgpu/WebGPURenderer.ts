/**
 * WebGPU renderer.
 *
 * A concrete {@link AbstractRenderer}: sizing, pixel ratio, the clear colour, the
 * animation loop, statistics and disposal all come from the base class. This file adds
 * the WebGPU-specific halves:
 *
 * 1. **device acquisition** through {@link WebGPUAdapter}/{@link WebGPUDevice}, with a
 *    documented fallback when requirements cannot be met, and `device.lost` wired to
 *    the same recovery path a lost WebGL context takes;
 * 2. **swap-chain management** through {@link WebGPUSwapChain}, including the
 *    `bgra8unorm`/`rgba8unorm` preference probe;
 * 3. **pipeline and bind-group caching** through {@link WebGPUPipelineCache};
 * 4. **draw submission** —a structural traversal accepting any object exposing
 *    `geometry`/`material`, with no import from `src/scene`, `src/materials` or
 *    `src/textures`.
 *
 * ## Asynchrony
 *
 * `requestAdapter` and `requestDevice` are promises, but {@link AbstractRenderer}'s
 * `initialise` hook is synchronous. Construction therefore starts the acquisition and
 * returns; {@link WebGPURenderer.readiness} resolves once the device exists, and
 * {@link WebGPURenderer.whenReady} lets a caller await it. Until then `render` logs a
 * warning and skips the frame rather than throwing, so a scene can be handed to the
 * renderer before the device arrives.
 *
 * ## Headless behaviour
 *
 * In Node (no DOM) the renderer constructs, tracks its size and supports `setSize`,
 * `setPixelRatio`, `clear` and `dispose`. Only `render` throws, with an explanatory
 * message, exactly like `Canvas2DRenderer`.
 *
 * @packageDocumentation
 */

import { BackendNames, type BackendName } from '../../constants';
import { createLogger } from '../../utils/Logger';
import type { CameraLike, SceneLike } from '../interfaces/IRenderer';
import type { IRenderTarget } from '../interfaces/IRenderTarget';
import type { GeometryLike, MaterialLike, AttributeLike } from '../interfaces/types';
import {
  ClearFlags,
  CullMode,
  PixelFormat,
  PrimitiveTopology,
  TextureFilter,
  TextureWrap,
  type RenderTargetOptions,
  type RendererInfo,
  type RendererOptions,
} from '../interfaces/types';
import type { IShader, UniformValue } from '../interfaces/IShader';
import { triangleCountFor } from '../interfaces/ICommandEncoder';
import { BufferType } from '../interfaces/IBuffer';
import { RenderContext } from '../core/RenderContext';
import type { Scissor } from '../core/Scissor';
import type { Viewport } from '../core/Viewport';
import { AbstractRenderer, type CanvasSurface } from '../core/AbstractRenderer';
import {
  type WebGPUAdapterOptions,
  WebGPUCapabilities,
  type WebGPUDeviceRequestOptions,
  acquireDevice,
  getCapabilities,
} from './WebGPUAdapter';
import { WebGPUDevice } from './WebGPUDevice';
import { WebGPUSwapChain, type SwapChainAlphaMode } from './WebGPUSwapChain';
import { WebGPUShader } from './WebGPUShader';
import {
  WebGPUPipelineCache,
  buildColorTargetState,
  buildDepthStencilState,
  buildMultisampleState,
  buildPrimitiveState,
  type RenderPipelineDescriptorLike,
} from './WebGPUPipeline';
import { WebGPUBuffer } from './WebGPUBuffer';
import { SamplerCache, WebGPUTexture, type TextureResourceLike } from './WebGPUTexture';
import { WebGPURenderTarget } from './WebGPURenderTarget';
import { WebGPUState } from './WebGPUState';
import {
  GPUBufferUsageFlags,
  buildVertexBufferLayouts,
  hasFeature,
  isWebGPUAvailable,
  toGPUIndexFormat,
  type AttributeLayoutDescriptor,
  type GPUCanvasContextLike,
  type GPUCommandBufferLike,
  type GPUDeviceLike,
  type GPURenderPassEncoderLike,
  type GPUTextureViewLike,
} from './WebGPUUtils';

/** Logger for renderer diagnostics. */
const log = createLogger('renderer:webgpu');

/* -------------------------------------------------------------------------- */
/* Structural shapes                                                          */
/* -------------------------------------------------------------------------- */

/*
 * This backend must not import `src/materials/**`, `src/textures/**`,
 * `src/shaders/**` or `src/scene/**`: those modules are written concurrently by other
 * layers. The interfaces below describe exactly the members this renderer reads; the
 * concrete classes satisfy them structurally.
 */

/**
 * Structural material.
 *
 * `vertexShader`/`fragmentShader` are WGSL sources, or a ready {@link IShader} can be
 * supplied through `shader`.
 */
export interface WebGPUMaterialLike extends MaterialLike {
  /** `true` when the material should be skipped. */
  readonly visible?: boolean;
  /** WGSL vertex source. */
  readonly vertexShader?: string | null;
  /** WGSL fragment source. */
  readonly fragmentShader?: string | null;
  /** Vertex entry point name. */
  readonly vertexEntryPoint?: string;
  /** Fragment entry point name. */
  readonly fragmentEntryPoint?: string;
  /** Vertex attribute layout descriptors. */
  readonly attributes?: readonly AttributeLayoutDescriptor[];
  /** Textures keyed by binding name. */
  readonly textures?: Readonly<Record<string, GPUWTextureBindingLike>>;
  /** Uniform values, uploaded into a material uniform buffer. */
  readonly uniforms?: Readonly<Record<string, UniformValue>>;
  /** `true` when fragments are depth-tested; defaults to `true`. */
  readonly depthTest?: boolean;
  /** `true` when fragments write depth; defaults to `true`. */
  readonly depthWrite?: boolean;
  /** Primitive topology override. */
  readonly topology?: PrimitiveTopology;
  /** Face-culling mode override. */
  readonly side?: CullMode;
}

/**
 * Structural texture binding.
 *
 * A {@link WebGPUTexture} satisfies it directly; a texture-layer resource that exposes
 * `{ texture }` or `{ resource }` does too.
 */
export interface GPUWTextureBindingLike {
  /** A ready backend texture. */
  readonly texture?: WebGPUTexture | null;
  /** Alias of {@link GPUWTextureBindingLike.texture}. */
  readonly resource?: WebGPUTexture | null;
  /** Underlying texel data, uploaded into a backend texture on demand. */
  readonly image?: unknown;
  /** Width in texels. */
  readonly width?: number;
  /** Height in texels. */
  readonly height?: number;
  /** Storage format. */
  readonly format?: PixelFormat;
  /** Magnification filter. */
  readonly magFilter?: TextureFilter;
  /** Minification filter. */
  readonly minFilter?: TextureFilter;
  /** Horizontal wrap mode. */
  readonly wrapS?: TextureWrap;
  /** Vertical wrap mode. */
  readonly wrapT?: TextureWrap;
  /** Version used to detect re-uploads. */
  readonly version?: number;
}

/**
 * Structural renderable.
 *
 * The scene layer's objects all expose these members.
 */
export interface WebGPURenderableLike {
  /** `true` when the object should be skipped. */
  readonly visible?: boolean;
  /** Geometry to draw. */
  readonly geometry?: GeometryLike | null;
  /** Material to draw with. */
  readonly material?: WebGPUMaterialLike | null;
  /** Column-major world matrix. */
  readonly matrixWorld?: { elements: ArrayLike<number> } | null;
  /** Object-level uniform overrides. */
  readonly uniforms?: Readonly<Record<string, UniformValue>>;
  /** Topology override. */
  readonly topology?: PrimitiveTopology;
  /** Number of vertices/elements to draw. */
  readonly drawRangeCount?: number;
  /** First vertex/element to draw. */
  readonly drawRangeStart?: number;
  /** Instance count; `1` for a non-instanced draw. */
  readonly instanceCount?: number;
  /** Instance count alias. */
  readonly count?: number;
  /** Identifier used in diagnostics. */
  readonly id?: string | number;
  /** Human-readable name used in diagnostics. */
  readonly name?: string;
}

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/** Extended options accepted by {@link WebGPURenderer}. */
export interface WebGPURendererOptions extends RendererOptions {
  /** Adapter acquisition options. */
  adapterOptions?: WebGPUAdapterOptions;
  /** Device request options. */
  deviceOptions?: WebGPUDeviceRequestOptions;
  /** Explicit swap-chain format; the probe is skipped when set. */
  format?: string;
  /** Swap-chain alpha mode. Defaults to `'opaque'`. */
  alphaMode?: SwapChainAlphaMode;
  /** Maximum number of cached render pipelines. Defaults to `64`. */
  maxPipelines?: number;
  /** Assume timestamp queries are available, overriding the feature probe. */
  timestamps?: boolean;
  /** Depth format the default pass uses. */
  depthFormat?: PixelFormat;
  /** Sample count for the canvas pass; `1` for no MSAA. */
  samples?: number;
}

/** The status of the asynchronous device acquisition. */
export type WebGPUReadyState = 'idle' | 'pending' | 'ready' | 'failed' | 'lost' | 'disposed';

/** `render`/`memory` counters, mirroring the conventional GPU-backend report. */
export interface WebGPURenderInfo {
  /** Per-frame submission counts. */
  readonly render: {
    /** Draw calls issued this frame (`stats.drawCalls`). */
    readonly calls: number;
    /** Triangles submitted this frame. */
    readonly triangles: number;
    /** Points submitted this frame. */
    readonly points: number;
    /** Lines submitted this frame. */
    readonly lines: number;
  };
  /** Resource totals. */
  readonly memory: {
    /** Vertex buffers cached by the renderer. */
    readonly geometries: number;
    /** Textures owned by the renderer and its render targets. */
    readonly textures: number;
    /** Render pipelines held by the pipeline cache. */
    readonly programs: number;
  };
}

/**
 * Minimal WGSL used when a renderable has geometry but no material shader.
 *
 * Deliberately tiny: it exists so a geometry-only mesh renders something rather than
 * silently disappearing, and so the pipeline path has a default to exercise.
 */
export const DEFAULT_WGSL_SHADER = `
struct Uniforms {
  modelViewProjection: mat4x4<f32>,
  color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
  return output;
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return uniforms.color;
}
`;

/* -------------------------------------------------------------------------- */
/* WebGPURenderer                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Renders scenes through WebGPU.
 *
 * ```ts
 * const renderer = new WebGPURenderer({ canvas: '#stage' });
 * await renderer.readiness;
 * renderer.setClearColor('#101014');
 * renderer.render(scene, camera);
 * ```
 */
export class WebGPURenderer extends AbstractRenderer {
  /** @inheritdoc */
  public readonly backend: BackendName = BackendNames.WebGPU;

  /** Normalised options, exposed for subclasses and tests. */
  public readonly webgpuOptions: WebGPURendererOptions;

  /** The device wrapper, once acquisition succeeded. */
  public device: WebGPUDevice | null = null;

  /** The configured swap chain, once acquisition succeeded. */
  public swapChain: WebGPUSwapChain | null = null;

  /** Pipeline cache, once a device exists. */
  public pipelines: WebGPUPipelineCache | null = null;

  /** Shadow pass state. */
  public readonly gpuState: WebGPUState = new WebGPUState();

  /** Capability report; a synthetic one until an adapter is known. */
  public capabilities: WebGPUCapabilities;

  /** Resolves once the device is ready (or acquisition failed). */
  public readonly readiness: Promise<boolean>;

  /** Renderables collected for the current frame. */
  private readonly collected: WebGPURenderableLike[] = [];

  /** Sampler cache shared by every texture the renderer creates. */
  private samplers: SamplerCache | null = null;

  /** Render targets created by this renderer. */
  private readonly targets: Set<WebGPURenderTarget> = new Set();

  /** Textures the renderer owns (created for renderables without a backend texture). */
  private readonly textures: Set<WebGPUTexture> = new Set();

  /** Pending acquisition, so `ready` can be awaited. */
  private resolveReady: ((value: boolean) => void) | null = null;

  /** Current acquisition status. */
  private readyState: WebGPUReadyState = 'idle';

  /** Reason acquisition failed, when it did. */
  private failureReason: string | null = null;

  /** `true` once a "device not ready" warning has been emitted. */
  private warnedNotReady: boolean = false;

  /**
   * Creates a renderer.
   *
   * @param options Renderer options plus the WebGPU adapter/device configuration.
   */
  constructor(options: WebGPURendererOptions = {}) {
    super(options as RendererOptions, BackendNames.WebGPU);
    this.webgpuOptions = options;
    this.capabilities = getCapabilities(null);

    this.readiness = new Promise<boolean>((resolve) => {
      this.resolveReady = resolve;
    });

    if (this.headless) {
      // Nothing to acquire and nothing to draw into: `render` throws through the base
      // class, which is the documented headless contract.
      this.readyState = 'failed';
      this.failureReason = 'headless: no canvas could be bound';
      this.resolveReady?.(false);
      this.resolveReady = null;
      return;
    }

    this.initialise();
  }

  /* ---------------------------------------------------------------- lifecycle */

  /** @inheritdoc */
  protected override onInitialise(): void {
    this.readyState = 'pending';
    void this.acquireDeviceAsync();
  }

  /**
   * Acquires the adapter, device and swap chain.
   *
   * Failures are recorded rather than thrown: the renderer stays usable for sizing and
   * disposal, and `render` reports the problem through the log.
   */
  private async acquireDeviceAsync(): Promise<void> {
    if (!isWebGPUAvailable()) {
      this.fail(
        'WebGPU is not available in this runtime (`navigator.gpu.requestAdapter` was not found). ' +
          'Use the WebGL backend, or run in a browser/worker with WebGPU enabled.',
      );
      return;
    }

    try {
      const adapterOptions: WebGPUAdapterOptions = { powerPreference: 'high-performance' };
      if (this.webgpuOptions.adapterOptions !== undefined) Object.assign(adapterOptions, this.webgpuOptions.adapterOptions);

      const deviceOptions: WebGPUDeviceRequestOptions = {};
      if (this.webgpuOptions.deviceOptions !== undefined) Object.assign(deviceOptions, this.webgpuOptions.deviceOptions);
      if (this.webgpuOptions.timestamps === true) {
        deviceOptions.requiredFeatures = [...(deviceOptions.requiredFeatures ?? []), 'timestamp-query'];
      }

      const { adapter, result } = await acquireDevice(adapterOptions, deviceOptions);
      if (adapter === null || result.device === null) {
        this.fail(result.error ?? 'no WebGPU adapter is available in this runtime');
        return;
      }

      this.capabilities = new WebGPUCapabilities(adapter);
      this.installDevice(result.device, adapter);
    } catch (error) {
      this.fail(`device acquisition threw: ${(error as Error)?.message ?? String(error)}`);
    }
  }

  /** Installs an acquired device and configures the swap chain. */
  private installDevice(device: GPUDeviceLike, adapter: Parameters<typeof getCapabilities>[0]): void {
    this.device = new WebGPUDevice(device, { label: `${this.backend}-device` });
    this.pipelines = new WebGPUPipelineCache(device, this.webgpuOptions.maxPipelines ?? 64);
    this.samplers = new SamplerCache(device);
    this.capabilities = new WebGPUCapabilities(adapter);

    this.device.onLost((info) => {
      this.onDeviceLost(info?.message ?? info?.reason ?? 'unknown reason');
    });

    const context = this.acquireCanvasContext();
    if (context !== null) {
      const swapChainOptions: ConstructorParameters<typeof WebGPUSwapChain>[2] = {
        width: this.surface.width,
        height: this.surface.height,
      };
      if (this.webgpuOptions.format !== undefined) swapChainOptions.format = this.webgpuOptions.format;
      if (this.webgpuOptions.alphaMode !== undefined) swapChainOptions.alphaMode = this.webgpuOptions.alphaMode;
      this.swapChain = new WebGPUSwapChain(context, device, swapChainOptions);
      this.swapChain.configure();
    } else {
      log.warn(
        'WebGPURenderer: the canvas did not provide a WebGPU context, so nothing can be presented. ' +
          'Rendering into an off-screen target still works.',
      );
    }

    this.readyState = 'ready';
    this.warnedNotReady = false;
    this.resolveReady?.(true);
    this.resolveReady = null;

    log.debug(`device ready: ${this.capabilities.toString()}`);
  }

  /** Records an acquisition failure and resolves `ready` with `false`. */
  private fail(reason: string): void {
    this.failureReason = reason;
    this.readyState = 'failed';
    log.warn(`WebGPURenderer: ${reason}`);
    this.resolveReady?.(false);
    this.resolveReady = null;
  }

  /** Reads the canvas' WebGPU context. */
  private acquireCanvasContext(): GPUCanvasContextLike | null {
    const surface = this.surface as CanvasSurface;
    try {
      const context = surface.getContext('webgpu', {});
      return isCanvasContext(context) ? context : null;
    } catch (error) {
      log.debug('getContext("webgpu") threw', error);
      return null;
    }
  }

  /* ------------------------------------------------------------------ queries */

  /** Current acquisition status. */
  public get readyStateName(): WebGPUReadyState {
    return this.readyState;
  }

  /** `true` when a device exists and is usable. */
  public get isDeviceUsable(): boolean {
    return this.device !== null && this.device.isUsable;
  }

  /** Reason acquisition failed, when it did. */
  public get lastFailure(): string | null {
    return this.failureReason;
  }

  /**
   * Waits until the device is ready.
   *
   * @returns `true` when a usable device exists.
   */
  public async whenReady(): Promise<boolean> {
    return this.readiness;
  }

  /** @inheritdoc */
  protected override getCapabilities(): readonly string[] {
    return this.capabilities.toList();
  }

  /** @inheritdoc */
  protected override buildInfo(): RendererInfo {
    const base = super.buildInfo();
    const info = this.capabilities.info;
    return {
      ...base,
      ...(info?.vendor === undefined ? {} : { vendor: info.vendor }),
      ...(info?.device === undefined ? {} : { renderer: info.device }),
      maxTextureSize: this.capabilities.maxTextureDimension2D,
      maxTextureUnits: this.capabilities.maxSampledTexturesPerShaderStage,
      maxAttributes: this.capabilities.maxVertexAttributes,
    };
  }

  /**
   * `render`/`memory` counters.
   *
   * `render.*` mirrors {@link WebGPURenderer.stats} (the base class owns the frame
   * counters); `memory.*` counts the resources the renderer is tracking.
   */
  public get renderInfo(): WebGPURenderInfo {
    const stats = this.stats;
    return {
      render: {
        calls: stats.drawCalls,
        triangles: stats.triangles,
        points: stats.points,
        lines: stats.lines,
      },
      memory: {
        geometries: this.trackedBuffers,
        textures: this.textures.size + this.targetTextures,
        programs: this.pipelines?.size ?? 0,
      },
    };
  }

  /** Number of buffers the renderer created for geometry. */
  private trackedBuffers: number = 0;

  /** Number of textures held by render targets. */
  private targetTextures: number = 0;

  /* ------------------------------------------------------------------ sizing */

  /** @inheritdoc */
  protected override onSizeChanged(width: number, height: number, pixelRatio: number): void {
    this.renderState.viewport = { x: 0, y: 0, width: this.surface.width, height: this.surface.height };
    this.renderState.pixelRatio = pixelRatio;
    this.swapChain?.resize(this.surface.width, this.surface.height);
    this.gpuState.setViewport(null, this.renderState.viewport);
    log.debug(`resized to ${width}x${height} @${pixelRatio}x`);
  }

  /** @inheritdoc */
  protected override onViewportChanged(viewport: Viewport): void {
    this.gpuState.setViewport(null, viewport);
  }

  /** @inheritdoc */
  protected override onScissorChanged(scissor: Scissor | null): void {
    this.gpuState.setScissor(null, scissor);
  }

  /* ------------------------------------------------------------------- clear */

  /** @inheritdoc */
  protected override clearSurface(options: {
    color: { r: number; g: number; b: number; a: number };
    depth: number;
    stencil: number;
    flags: ClearFlags;
  }): void {
    // WebGPU has no `clear()`: a clear is the load operation of the next pass. The
    // request is therefore recorded and applied when the frame's pass opens.
    this.pendingClear = {
      enabled: options.flags !== ClearFlags.None,
      color: { ...options.color },
      depth: options.depth,
      stencil: options.stencil,
      flags: options.flags,
    };
    this.stats.stateChanges++;
  }

  /** Clear request recorded by `clearSurface`, applied when the frame's pass opens. */
  private pendingClear: {
    enabled: boolean;
    color: { r: number; g: number; b: number; a: number };
    depth: number;
    stencil: number;
    flags: ClearFlags;
  } | null = null;

  /* ------------------------------------------------------------------ render */

  /** @inheritdoc */
  protected override renderScene(
    scene: SceneLike | null,
    camera: CameraLike | null,
    context: RenderContext,
  ): void {
    const device = this.device;
    const pipelines = this.pipelines;
    if (device === null || pipelines === null || !device.isUsable) {
      if (!this.warnedNotReady) {
        this.warnedNotReady = true;
        log.warn(
          `WebGPURenderer: render() called before the WebGPU device was ready ` +
            `(state: ${this.readyState}${this.failureReason === null ? '' : `, reason: ${this.failureReason}`}). ` +
            'The frame is skipped; await `renderer.readiness` before the first render.',
        );
      }
      return;
    }
    this.warnedNotReady = false;

    const rawDevice = device.device;
    const target = this.getRenderTarget();
    const targetView: GPUTextureViewLike | null =
      target instanceof WebGPURenderTarget
        ? (target.getRenderViews()[0] ?? null)
        : (this.swapChain?.getCurrentTextureView() ?? null);

    if (targetView === null) {
      log.debug('WebGPURenderer: no attachment is available for this frame; skipping it');
      return;
    }

    const encoder = rawDevice.createCommandEncoder({ label: `${this.backend}-frame` });
    const clearOptions =
      this.pendingClear !== null && this.pendingClear.enabled
        ? {
            color: this.pendingClear.color,
            depth: this.pendingClear.depth,
            stencil: this.pendingClear.stencil,
            flags: this.pendingClear.flags,
          }
        : this.options.autoClear === false
          ? null
          : { color: this.clearColor, depth: 1, stencil: 0, flags: ClearFlags.All };
    this.pendingClear = null;

    const passDescriptor =
      target instanceof WebGPURenderTarget
        ? target.createRenderPassDescriptor(clearOptions)
        : this.createCanvasPassDescriptor(targetView, clearOptions);

    const pass = this.gpuState.beginPass(encoder.beginRenderPass(passDescriptor), 'render');

    this.collected.length = 0;
    const renderables = this.collectRenderables(scene, camera);

    for (const renderable of renderables) {
      try {
        this.drawRenderable(renderable, context, pass, pipelines);
      } catch (error) {
        log.error(`a renderable threw while drawing (${describeWebGPURenderable(renderable)})`, error);
      }
    }

    this.gpuState.endPass();
    this.submit([encoder.finish()]);
  }

  /** Builds a render-pass descriptor for the canvas attachment. */
  private createCanvasPassDescriptor(
    view: GPUTextureViewLike,
    clearOptions: { color: { r: number; g: number; b: number; a: number }; depth: number; stencil: number; flags: ClearFlags } | null,
  ): Record<string, unknown> {
    const clearsColour = clearOptions !== null && (clearOptions.flags & ClearFlags.Color) !== 0;
    const descriptor: Record<string, unknown> = {
      label: `${this.backend}-canvas-pass`,
      colorAttachments: [
        {
          view,
          loadOp: clearsColour ? 'clear' : 'load',
          storeOp: 'store',
          ...(clearsColour && clearOptions !== null
            ? {
                clearValue: {
                  r: clearOptions.color.r,
                  g: clearOptions.color.g,
                  b: clearOptions.color.b,
                  a: clearOptions.color.a,
                },
              }
            : {}),
        },
      ],
    };
    return descriptor;
  }

  /**
   * Collects the renderables of a scene.
   *
   * @param scene Scene to walk.
   * @param camera Camera for the frame.
   * @returns The renderables to draw.
   */
  protected collectRenderables(scene: SceneLike | null, camera: CameraLike | null): readonly WebGPURenderableLike[] {
    if (scene == null || scene.visible === false) return this.collected;

    const collector = (scene as { collectRenderables?: (list: unknown, cam: unknown) => void }).collectRenderables;
    if (typeof collector === 'function') {
      collector.call(scene, this.collected, camera);
      return this.collected;
    }

    const children = (scene as { children?: readonly unknown[] }).children;
    if (Array.isArray(children)) {
      for (const child of children) this.pushRenderable(child);
      return this.collected;
    }

    this.pushRenderable(scene);
    return this.collected;
  }

  /** Adds one child when it looks renderable. */
  private pushRenderable(candidate: unknown): void {
    if (candidate == null || typeof candidate !== 'object') return;
    const object = candidate as WebGPURenderableLike;
    if (object.visible === false) return;
    if (object.geometry == null) return;
    this.collected.push(object);
  }

  /**
   * Draws one renderable.
   *
   * @param renderable Object to draw.
   * @param context Frame context.
   * @param pass Render pass encoder.
   * @param pipelines Pipeline cache.
   */
  protected drawRenderable(
    renderable: WebGPURenderableLike,
    context: RenderContext,
    pass: GPURenderPassEncoderLike,
    pipelines: WebGPUPipelineCache,
  ): void {
    const geometry = renderable.geometry;
    const device = this.device;
    if (geometry == null || device === null || !device.isUsable) return;

    const material = renderable.material ?? null;
    if (material?.visible === false) return;

    const topology = renderable.topology ?? material?.topology ?? PrimitiveTopology.Triangles;
    const depthFormat = this.webgpuOptions.depthFormat ?? PixelFormat.Depth32F;
    // The swap chain already resolved the presentable format; a render target uses
    // its own, which is handled by the target's own pass descriptor.
    const colorFormat = this.webgpuOptions.format ?? this.swapChain?.format ?? 'rgba8unorm';

    const descriptors = buildAttributeLayouts(geometry, material);
    const vertexSource = material?.vertexShader ?? DEFAULT_WGSL_SHADER;
    const fragmentSource = material?.fragmentShader ?? DEFAULT_WGSL_SHADER;
    const vertexEntry = material?.vertexEntryPoint ?? 'vs_main';
    const fragmentEntry = material?.fragmentEntryPoint ?? 'fs_main';

    const shader = this.acquireShader(device.device, material, vertexSource, fragmentSource, vertexEntry, fragmentEntry);
    const modules = shader.getModules();
    if (modules.vertex === null && modules.fragment === null) return;

    const descriptor: RenderPipelineDescriptorLike = {
      label: webGPUMaterialLabel(material),
      layout: 'auto',
      vertex: {
        module: modules.vertex ?? modules.fragment,
        entryPoint: vertexEntry,
        buffers: buildVertexBufferLayouts(descriptors),
      },
      fragment:
        modules.fragment === null
          ? null
          : {
              module: modules.fragment,
              entryPoint: fragmentEntry,
              targets: [buildColorTargetState(this.renderState, colorFormat)],
            },
      primitive: buildPrimitiveState(this.renderState, topology, { label: webGPUMaterialLabel(material) }),
      depthStencil: buildDepthStencilState(this.renderState, this.formatForDepth(depthFormat), {
        depthWriteEnabled: material?.depthWrite ?? this.renderState.depth.write,
      }),
      multisample: buildMultisampleState(1),
    };

    const pipeline = pipelines.acquire(descriptor);
    if (pipeline === null) return;
    this.gpuState.setPipeline(pass, pipeline.pipeline);

    // Vertex buffers: one per attribute, uploaded through WebGPUBuffer wrappers.
    const vertexBuffers = this.uploadVertexBuffers(geometry);
    if (vertexBuffers === null) return;
    vertexBuffers.forEach((buffer, slot) => {
      if (buffer === null) return;
      this.gpuState.setVertexBuffer(pass, slot, buffer.handle, 0);
    });

    const index = geometry.getIndex();
    let indexCount = 0;
    if (index != null && index.array.length > 0) {
      const indexBuffer = this.uploadIndexBuffer(index);
      if (indexBuffer === null) return;
      const format = toGPUIndexFormat(index.array);
      this.gpuState.setIndexBuffer(pass, indexBuffer.handle, format, 0);
      indexCount = Math.floor(index.array.length / Math.max(1, index.itemSize ?? 1));
    }

    let vertexCount = 0;
    for (const name of attributeNames(geometry)) {
      const attribute = geometry.getAttribute(name);
      if (attribute != null) vertexCount = Math.max(vertexCount, vertexCountOf(attribute));
    }

    const instances = resolveWebGPUInstanceCount(renderable);
    const count =
      Math.floor(renderable.drawRangeCount ?? 0) > 0
        ? Math.floor(renderable.drawRangeCount ?? 0)
        : indexCount > 0
          ? indexCount
          : vertexCount;
    const first = Math.max(0, Math.floor(renderable.drawRangeStart ?? 0));
    if (count - first <= 0) return;

    if (indexCount > 0) {
      pass.drawIndexed(count - first, instances, first, 0, 0);
    } else {
      pass.draw(count - first, instances, first, 0);
    }

    this.stats.drawCalls++;
    this.countPrimitives(topology, count - first, instances);
    context.countObject(false);
  }

  /** Format string for a depth attachment, or `null` when depth is disabled. */
  private formatForDepth(format: PixelFormat): string | null {
    if (!this.renderState.depth.test && !this.renderState.depth.write) return null;
    return format === PixelFormat.Depth24Stencil8 ? 'depth24plus-stencil8' : 'depth32float';
  }

  /** Increments the primitive counters for one submitted draw. */
  private countPrimitives(topology: PrimitiveTopology, count: number, instances: number): void {
    const stats = this.stats;
    const total = count * Math.max(1, instances);
    stats.vertices += total;
    stats.triangles += triangleCountFor(topology, count) * Math.max(1, instances);
    if (topology === PrimitiveTopology.Points) stats.points += total;
    if (
      topology === PrimitiveTopology.Lines ||
      topology === PrimitiveTopology.LineLoop ||
      topology === PrimitiveTopology.LineStrip
    ) {
      stats.lines += total;
    }
  }

  /* ------------------------------------------------------------------ buffers */

  /** Buffers created for geometry attributes, keyed by the attribute object. */
  private readonly attributeBuffers: WeakMap<object, WebGPUBuffer> = new WeakMap();

  /** Buffers created for index buffers, keyed by the index object. */
  private readonly indexBuffers: WeakMap<object, WebGPUBuffer> = new WeakMap();

  /** Shader pairs created for materials, keyed by a structural hash. */
  private readonly shaderCache: Map<string, WebGPUShader> = new Map();

  /**
   * Returns the shader pair for a material, creating and caching it on first use.
   *
   * Creating a `GPUShaderModule` per draw would be indefensible —every one of them is
   * a WGSL compile —so the pair is keyed by the (source, entry point) tuple.
   *
   * @param device Device to create modules on.
   * @param material Material the shader belongs to.
   * @param vertexSource Vertex WGSL.
   * @param fragmentSource Fragment WGSL.
   * @param vertexEntry Vertex entry point.
   * @param fragmentEntry Fragment entry point.
   */
  private acquireShader(
    device: GPUDeviceLike,
    material: WebGPUMaterialLike | null,
    vertexSource: string,
    fragmentSource: string,
    vertexEntry: string,
    fragmentEntry: string,
  ): WebGPUShader {
    const key = `${vertexSource.length}x${fragmentSource.length}:${vertexEntry}:${fragmentEntry}:${hashSource(
      vertexSource,
    )}:${hashSource(fragmentSource)}`;
    const cached = this.shaderCache.get(key);
    if (cached !== undefined) return cached;

    const shader = new WebGPUShader(device, { label: webGPUMaterialLabel(material) });
    shader.compileStages(vertexSource, fragmentSource, { vertex: vertexEntry, fragment: fragmentEntry });
    this.shaderCache.set(key, shader);
    return shader;
  }

  /**
   * Uploads the geometry's attributes into one GPU buffer per attribute.
   *
   * @param geometry Geometry to upload.
   * @returns The buffers by slot, or `null` when no device is available.
   */
  private uploadVertexBuffers(geometry: GeometryLike): (WebGPUBuffer | null)[] | null {
    const device = this.device;
    if (device === null) return null;

    const names = attributeNames(geometry);
    const buffers: (WebGPUBuffer | null)[] = [];

    let slot = 0;
    for (const name of names) {
      const attribute = geometry.getAttribute(name);
      if (attribute == null) continue;

      const bytes = bytesOf(attribute.array);
      let buffer = this.attributeBuffers.get(attribute as object);
      if (buffer === undefined) {
        buffer = new WebGPUBuffer(
          device.device,
          { type: BufferType.Vertex, size: Math.max(4, bytes), label: `attribute:${name}` },
          { wrapper: device },
        );
        this.attributeBuffers.set(attribute as object, buffer);
        this.trackedBuffers++;
      }
      buffer.write(toView(attribute.array));
      buffers[slot] = buffer;
      slot++;
    }

    return buffers;
  }

  /**
   * Uploads an index buffer.
   *
   * @param index Index description.
   * @returns The buffer, or `null`.
   */
  private uploadIndexBuffer(index: {
    array: ArrayLike<number>;
    itemSize?: number;
    version?: number;
  }): WebGPUBuffer | null {
    const device = this.device;
    if (device === null) return null;

    const bytes = bytesOf(index.array);
    let buffer = this.indexBuffers.get(index as object);
    if (buffer === undefined) {
      buffer = new WebGPUBuffer(
        device.device,
        { type: BufferType.Index, size: Math.max(4, bytes), label: 'index' },
        { wrapper: device },
      );
      this.indexBuffers.set(index as object, buffer);
      this.trackedBuffers++;
    }
    buffer.write(toView(index.array));
    return buffer;
  }

  /* ------------------------------------------------------------------ targets */

  /** @inheritdoc */
  protected override onCreateRenderTarget(options: RenderTargetOptions): IRenderTarget {
    const device = this.device;
    if (device === null) {
      throw new Error(
        'WebGPURenderer: cannot create a render target before the WebGPU device is ready. ' +
          'Await `renderer.readiness` first.',
      );
    }

    const target = new WebGPURenderTarget(options, {
      device: device.device,
      wrapper: device,
      capabilities: this.capabilities,
      samplers: this.samplers,
      generation: 0,
    });

    this.targets.add(target);
    this.targetTextures += target.colorAttachmentCount + (target.getDepthTexture() === null ? 0 : 1);
    return target;
  }

  /**
   * Renders into a target, then restores the previous binding.
   *
   * @param target Target to draw into.
   * @param callback Work performed while the target is bound.
   * @returns Whatever the callback returned.
   */
  public renderToTarget<T>(
    target: IRenderTarget,
    callback: (renderer: WebGPURenderer, target: IRenderTarget) => T,
  ): T {
    const previous = this.getRenderTarget();
    this.setRenderTarget(target);
    try {
      return callback(this, target);
    } finally {
      this.setRenderTarget(previous);
    }
  }

  /**
   * Reads pixels back from a render target.
   *
   * WebGPU readback is asynchronous, so this returns a promise. Targets that are not
   * {@link WebGPURenderTarget}s resolve to `null`.
   *
   * @param target Target to read.
   * @param x Left edge in texels.
   * @param y Top edge in texels.
   * @param width Region width.
   * @param height Region height.
   * @returns The pixels, or `null`.
   */
  public async readRenderTargetPixels(
    target: IRenderTarget,
    x: number = 0,
    y: number = 0,
    width?: number,
    height?: number,
  ): Promise<Uint8ClampedArray | null> {
    const device = this.device;
    if (device === null) return null;
    if (!(target instanceof WebGPURenderTarget)) {
      throw new Error(
        'WebGPURenderer.readRenderTargetPixels: the supplied target was not created by this renderer.',
      );
    }
    return target.readPixelsAsync(device, x, y, width, height);
  }

  /**
   * Compiles (creates) the pipelines the scene needs, without drawing.
   *
   * Pipeline creation is the expensive step in WebGPU, so pre-creating the pipelines
   * a scene will use removes the first-frame hitch.
   *
   * @param scene Scene to walk.
   * @returns The number of pipelines created by this call.
   */
  public compile(scene: SceneLike | null, camera?: CameraLike | null): number {
    const pipelines = this.pipelines;
    if (pipelines === null) return 0;

    this.collected.length = 0;
    const renderables = this.collectRenderables(scene, camera ?? null);
    const before = pipelines.creations;

    for (const renderable of renderables) {
      const geometry = renderable.geometry;
      if (geometry == null) continue;
      const material = renderable.material ?? null;
      const topology = renderable.topology ?? material?.topology ?? PrimitiveTopology.Triangles;
      const depthFormat = this.webgpuOptions.depthFormat ?? PixelFormat.Depth32F;
      const colorFormat = this.webgpuOptions.format ?? 'bgra8unorm';

      const descriptors = buildAttributeLayouts(geometry, material);
      const shader = new WebGPUShader(this.device?.device ?? ({} as GPUDeviceLike), {
        label: webGPUMaterialLabel(material),
      });
      shader.compileStages(material?.vertexShader ?? DEFAULT_WGSL_SHADER, material?.fragmentShader ?? DEFAULT_WGSL_SHADER, {
        vertex: material?.vertexEntryPoint ?? 'vs_main',
        fragment: material?.fragmentEntryPoint ?? 'fs_main',
      });
      const modules = shader.getModules();

      pipelines.acquire({
        label: webGPUMaterialLabel(material),
        layout: 'auto',
        vertex: {
          module: modules.vertex ?? modules.fragment,
          entryPoint: material?.vertexEntryPoint ?? 'vs_main',
          buffers: buildVertexBufferLayouts(descriptors),
        },
        fragment:
          modules.fragment === null
            ? null
            : {
                module: modules.fragment,
                entryPoint: material?.fragmentEntryPoint ?? 'fs_main',
                targets: [buildColorTargetState(this.renderState, colorFormat)],
              },
        primitive: buildPrimitiveState(this.renderState, topology),
        depthStencil: buildDepthStencilState(this.renderState, this.formatForDepth(depthFormat)),
        multisample: buildMultisampleState(1),
      });
    }

    const created = pipelines.creations - before;
    this.stats.programCompiles += created;
    return created;
  }

  /* ------------------------------------------------------------ device lifecycle */

  /** Submits command buffers through the device wrapper. */
  private submit(commandBuffers: readonly GPUCommandBufferLike[]): void {
    const device = this.device;
    if (device === null) return;
    device.submit(commandBuffers);
  }

  /** Handles a lost device. */
  private onDeviceLost(reason: string): void {
    this.readyState = 'lost';
    this.failureReason = reason;

    // Every GPU object became invalid the moment the device went away.
    this.gpuState.invalidate();
    this.pipelines?.clear();
    for (const texture of this.textures) texture.dispose();
    this.textures.clear();
    for (const target of this.targets) target.setGeneration(-1);

    log.warn(
      `WebGPURenderer: the device was lost (${reason}). Rendering is suspended; create a new ` +
        'renderer, or install a replacement device, to resume.',
    );
  }

  /* ------------------------------------------------------------------ dispose */

  /** @inheritdoc */
  protected override onDispose(): void {
    this.readyState = 'disposed';
    this.collected.length = 0;

    for (const target of this.targets) target.dispose();
    this.targets.clear();
    this.targetTextures = 0;

    for (const texture of this.textures) texture.dispose();
    this.textures.clear();

    this.pipelines?.clear();
    this.pipelines = null;
    this.samplers = null;
    this.swapChain?.unconfigure();
    this.swapChain = null;

    this.device?.destroy();
    this.device = null;

    this.resolveReady?.(false);
    this.resolveReady = null;
  }

  /** @returns A human-readable description. */
  public override toString(): string {
    return (
      `${super.toString()}, device=${this.readyState}, pipelines=${this.pipelines?.size ?? 0}`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Attribute names probed on a geometry. */
const WELL_KNOWN_ATTRIBUTES: readonly string[] = ['position', 'normal', 'uv', 'uv2', 'color', 'tangent'];

/** Lists the attribute names of a geometry. */
export function attributeNames(geometry: GeometryLike): readonly string[] {
  const declared = geometry.attributeNames;
  if (declared !== undefined && declared.length > 0) return declared;
  return WELL_KNOWN_ATTRIBUTES;
}

/** Vertex count an attribute describes. */
export function vertexCountOf(attribute: AttributeLike): number {
  const itemSize = Math.max(1, Math.floor(attribute.itemSize ?? 1));
  if (typeof attribute.count === 'number' && attribute.count > 0) return Math.floor(attribute.count);
  return Math.floor(attribute.array.length / itemSize);
}

/** Byte length of an attribute array. */
export function bytesOf(array: ArrayLike<number>): number {
  if (ArrayBuffer.isView(array)) return (array as ArrayBufferView).byteLength;
  const name = (array as { constructor?: { BYTES_PER_ELEMENT?: number } }).constructor;
  const perElement = typeof name?.BYTES_PER_ELEMENT === 'number' ? name.BYTES_PER_ELEMENT : 4;
  return array.length * perElement;
}

/** Views an attribute array as bytes. */
export function toView(array: ArrayLike<number>): ArrayBufferView {
  if (ArrayBuffer.isView(array)) return array as ArrayBufferView;
  const values = array as ArrayLike<number>;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i];
  return out;
}

/**
 * Builds the vertex layout descriptors a geometry and material imply.
 *
 * @param geometry Geometry to describe.
 * @param material Material that may override the layout.
 */
export function buildAttributeLayouts(
  geometry: GeometryLike,
  material: WebGPUMaterialLike | null,
): AttributeLayoutDescriptor[] {
  if (material?.attributes !== undefined && material.attributes.length > 0) return [...material.attributes];

  const descriptors: AttributeLayoutDescriptor[] = [];
  let location = 0;
  for (const name of attributeNames(geometry)) {
    const attribute = geometry.getAttribute(name);
    if (attribute == null) continue;
    const itemSize = Math.max(1, Math.min(4, Math.floor(attribute.itemSize ?? 3)));
    const bytes = bytesOf(attribute.array);
    const count = vertexCountOf(attribute);
    descriptors.push({
      name,
      shaderLocation: location,
      itemSize,
      arrayStride: count > 0 ? Math.max(itemSize * 4, Math.floor(bytes / count)) : itemSize * 4,
      offset: 0,
      integer: false,
      normalized: attribute.normalized === true,
    });
    location++;
  }
  return descriptors;
}

/** Instance count for a draw. */
export function resolveWebGPUInstanceCount(renderable: WebGPURenderableLike): number {
  const explicit = renderable.instanceCount ?? renderable.count;
  if (typeof explicit !== 'number' || !Number.isFinite(explicit) || explicit < 1) return 1;
  return Math.floor(explicit);
}

/** Label used for a material in diagnostics. */
export function webGPUMaterialLabel(material: WebGPUMaterialLike | null): string {
  if (material == null) return 'default-material';
  const id = (material as MaterialLike).id;
  if (typeof id === 'string' && id.length > 0) return id;
  if (typeof id === 'number') return `material-${id}`;
  return 'material';
}

/** Describes a renderable for error messages. */
export function describeWebGPURenderable(renderable: WebGPURenderableLike): string {
  if (typeof renderable.name === 'string' && renderable.name.length > 0) return renderable.name;
  if (renderable.id !== undefined) return `id=${String(renderable.id)}`;
  return 'anonymous renderable';
}

/** `true` when the value is a WebGPU canvas context. */
export function isCanvasContext(value: unknown): value is GPUCanvasContextLike {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value as Partial<GPUCanvasContextLike>;
  return typeof candidate.configure === 'function' && typeof candidate.getCurrentTexture === 'function';
}

/**
 * 32-bit FNV-1a hash of a WGSL source.
 *
 * Used only as a cache-key component; the source lengths are part of the key too, so a
 * collision degrades to a re-created shader module rather than a wrong pipeline.
 *
 * @param value Source text.
 */
export function hashSource(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
