/**
 * WebGL renderer.
 *
 * A concrete {@link AbstractRenderer}: everything about sizing, pixel ratio, the
 * clear colour, the animation loop, statistics and disposal comes from the base
 * class. This file adds the WebGL-specific halves:
 *
 * 1. **context acquisition** through {@link WebGLContext}, WebGL2 first with a
 *    documented WebGL1 fallback, plus the context-loss/restore wiring;
 * 2. **state translation** —the frame's {@link RenderState} is pushed through
 *    {@link WebGLState}, so redundant driver calls disappear;
 * 3. **resource management** —attribute buffers ({@link WebGLAttributes}), vertex
 *    arrays ({@link WebGLVertexArrayCache}), programs ({@link WebGLProgramCache})
 *    and textures;
 * 4. **draw submission** —a structural traversal that accepts any object exposing
 *    `geometry`/`material`, with no import from `src/scene`, `src/materials` or
 *    `src/textures`.
 *
 * ## Headless behaviour
 *
 * In Node (no DOM) the renderer still constructs, tracks its size and supports
 * `setSize`, `setPixelRatio`, `clear` and `dispose`. Only `render` throws, with an
 * explanatory message, exactly like `Canvas2DRenderer`.
 *
 * ## Counting
 *
 * {@link WebGLRenderer.stats} carries the frame counters the base class owns
 * (`drawCalls`, `triangles`, `vertices`, `lines`, `points`).
 * {@link WebGLRenderer.renderInfo} presents the same numbers in the
 * `render.calls` / `memory.geometries` shape plus the resource totals.
 *
 * @packageDocumentation
 */

import { BackendNames, type BackendName } from '../../constants';
import { createLogger } from '../../utils/Logger';
import type { CameraLike, SceneLike } from '../interfaces/IRenderer';
import type { IRenderTarget } from '../interfaces/IRenderTarget';
import type { MaterialLike, GeometryLike, AttributeLike } from '../interfaces/types';
import {
  BlendEquation,
  BlendFactor,
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
import { RenderContext } from '../core/RenderContext';
import type { Scissor } from '../core/Scissor';
import type { Viewport } from '../core/Viewport';
import { AbstractRenderer, type CanvasSurface } from '../core/AbstractRenderer';
import { convertColor, convertDepth, glConst, toGLClearMask, toGLTopology } from './WebGLUtils';
import {
  WebGLContext,
  type WebGLContextAttributeOptions,
  type WebGLContextOptions,
} from './WebGLContext';
import { WebGLProgram, WebGLProgramCache } from './WebGLProgram';
import { WebGLAttributes, type WebGLAttributeRecord, type IndexLike } from './WebGLAttributes';
import { getVertexArrayExtension, WebGLVertexArrayCache } from './WebGLVertexArray';
import { WebGLTexture } from './WebGLTexture';
import { WebGLRenderTarget } from './WebGLRenderTarget';
import type { WebGLState } from './WebGLState';

/** Logger for renderer diagnostics. */
const log = createLogger('renderer:webgl');

/* -------------------------------------------------------------------------- */
/* Structural shapes                                                          */
/* -------------------------------------------------------------------------- */

/*
 * This backend must not import `src/materials/**`, `src/textures/**`,
 * `src/shaders/**` or `src/scene/**`: those modules are written concurrently by
 * other layers, and importing them would create a compile-time dependency on
 * something that may not exist yet. The interfaces below describe exactly the
 * members this renderer reads; the concrete classes satisfy them structurally, so
 * no adapter and no cast is needed at the call site.
 */

/**
 * Structural material.
 *
 * Anything exposing these members works. `vertexShader`/`fragmentShader` are GLSL
 * sources; a material that instead exposes a ready {@link IShader} through `shader`
 * is used directly and the sources are ignored.
 */
export interface WebGLMaterialLike extends MaterialLike {
  /** `true` when the material should be skipped. */
  readonly visible?: boolean;
  /** GLSL vertex source, when the material carries its own. */
  readonly vertexShader?: string | null;
  /** GLSL fragment source. */
  readonly fragmentShader?: string | null;
  /** Preprocessor definitions injected into both stages. */
  readonly defines?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  /** Uniform bag uploaded before the draw. */
  readonly uniforms?: Readonly<Record<string, UniformValue>>;
  /** Textures keyed by sampler uniform name. */
  readonly textures?: Readonly<Record<string, TextureBindingLike>>;
  /** `true` when fragments are depth-tested; defaults to `true`. */
  readonly depthTest?: boolean;
  /** `true` when fragments write depth; defaults to `true`. */
  readonly depthWrite?: boolean;
  /** Primitive topology override. */
  readonly topology?: PrimitiveTopology;
  /** Face-culling mode; defaults to the frame's render state. */
  readonly side?: CullMode;
}

/**
 * Structural texture binding.
 *
 * A `WebGLTexture` satisfies it directly; a texture-layer resource that exposes
 * `{ texture }` or `{ glTexture }` does too.
 */
export interface TextureBindingLike {
  /** A ready backend texture, when the binding wraps one. */
  readonly texture?: WebGLTexture | null;
  /** Alias of {@link TextureBindingLike.texture}. */
  readonly glTexture?: WebGLTexture | null;
  /** Texture data a `WebGLTexture` can upload itself. */
  readonly image?: unknown;
  /** Texture unit to bind on, when the binding pins one. */
  readonly unit?: number;
  /** Version used to detect re-uploads. */
  readonly version?: number;
  /** Width in texels, for sources that do not report their own size. */
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
  /** `true` to generate a mip chain after upload. */
  readonly generateMipmaps?: boolean;
}

/**
 * Structural renderable.
 *
 * The scene layer's `Mesh`/`Points`/`Line`/`Sprite` objects all expose these
 * members; so does the geometry layer's bare `{ geometry, material }` pairing.
 */
export interface WebGLRenderableLike {
  /** `true` when the object should be skipped. */
  readonly visible?: boolean;
  /** Geometry to draw. */
  readonly geometry?: GeometryLike | null;
  /** Material to draw with. */
  readonly material?: WebGLMaterialLike | null;
  /** Column-major world matrix. */
  readonly matrixWorld?: { elements: ArrayLike<number> } | null;
  /** Object-level uniform overrides, applied after the material's own bag. */
  readonly uniforms?: Readonly<Record<string, UniformValue>>;
  /** Topology override. */
  readonly topology?: PrimitiveTopology;
  /** Index of the first vertex/element to draw. */
  readonly drawRangeStart?: number;
  /** Number of vertices/elements to draw. */
  readonly drawRangeCount?: number;
  /** Instance count; `1` for a non-instanced draw. */
  readonly instanceCount?: number;
  /** Instance count alias used by `InstancedMesh`-style objects. */
  readonly count?: number;
  /** Identifier used in diagnostics. */
  readonly id?: string | number;
  /** Human-readable name used in diagnostics. */
  readonly name?: string;
}

/* -------------------------------------------------------------------------- */
/* Options and reports                                                        */
/* -------------------------------------------------------------------------- */

/** Extended options accepted by {@link WebGLRenderer}. */
export interface WebGLRendererOptions extends RendererOptions {
  /** Attribute overrides merged over the chosen preset. */
  contextAttributes?: WebGLContextAttributeOptions;
  /** Attribute preset to start from. */
  preset?: 'default3D' | 'highPerformance' | 'readback';
  /** Prefer WebGL2 when the runtime offers it. Defaults to `true`. */
  preferWebGL2?: boolean;
  /** Force WebGL1 even when WebGL2 is available. */
  forceWebGL1?: boolean;
  /** Maximum number of linked programs kept in the LRU. Defaults to `64`. */
  maxPrograms?: number;
  /** Suppress the debug records emitted while probing context ids. */
  quietContextProbe?: boolean;
}

/** `render`/`memory` counters, mirroring the conventional GPU-backend report. */
export interface WebGLRenderInfo {
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
    /** Attribute buffers tracked by {@link WebGLAttributes}. */
    readonly geometries: number;
    /** Live textures known to the renderer. */
    readonly textures: number;
    /** Linked programs held by the program cache. */
    readonly programs: number;
  };
}

/* -------------------------------------------------------------------------- */
/* Built-in fallback program                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Minimal GLSL ES 1.00 vertex source used when a renderable has geometry but no
 * material shader.
 *
 * Written for GLSL ES 1.00 so the same text compiles on WebGL2 (which accepts it)
 * and WebGL1. Attributes the geometry does not provide are optimised out by the
 * linker, and the renderer skips locations of `-1`.
 */
export const DEFAULT_VERTEX_SHADER = `
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

varying vec3 vNormal;
varying vec2 vUv;

void main() {
  vNormal = mat3(modelViewMatrix) * normal;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Minimal GLSL ES 1.00 fragment source matching {@link DEFAULT_VERTEX_SHADER}.
 *
 * The `USE_MAP` definition is injected only when the draw has a `map` texture
 * bound, which keeps the sampler out of programs that do not need one —and
 * exercises the define-sensitive half of the program cache key.
 */
export const DEFAULT_FRAGMENT_SHADER = `
precision mediump float;

uniform vec4 diffuse;
uniform float opacity;
#ifdef USE_MAP
uniform sampler2D map;
#endif

varying vec3 vNormal;
varying vec2 vUv;

void main() {
  vec4 base = diffuse;
#ifdef USE_MAP
  base *= texture2D(map, vUv);
#endif
  gl_FragColor = vec4(base.rgb, base.a * opacity);
}
`;

/** Definitions the fallback program is compiled with. */
export interface DefaultProgramDefines {
  /** `true` when a `map` sampler is bound. */
  readonly useMap: boolean;
}

/* -------------------------------------------------------------------------- */
/* WebGLRenderer                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Renders scenes through WebGL2 (or WebGL1).
 *
 * ```ts
 * const renderer = new WebGLRenderer({ canvas: '#stage', pixelRatio: 2 });
 * renderer.setClearColor('#101014');
 * renderer.setSize(800, 600);
 * renderer.render(scene, camera);
 * ```
 */
export class WebGLRenderer extends AbstractRenderer {
  /** @inheritdoc */
  public readonly backend: BackendName = BackendNames.WebGL;

  /** Normalised options, exposed for subclasses and tests. */
  public readonly webglOptions: WebGLRendererOptions;

  /** Linked-program cache, or `null` while headless. */
  public programCache: WebGLProgramCache | null = null;

  /** Attribute buffer store, or `null` while headless. */
  public attributes: WebGLAttributes | null = null;

  /** Vertex array cache, or `null` while headless. */
  public vertexArrays: WebGLVertexArrayCache | null = null;

  /** The acquired context, or `null` while headless. */
  private glContext: WebGLContext | null = null;

  /** Renderables collected for the current frame. */
  private readonly collected: WebGLRenderableLike[] = [];

  /** Live textures known to the renderer. */
  private readonly textures: Set<WebGLTexture> = new Set();

  /** Render targets created by this renderer. */
  private readonly targets: Set<WebGLRenderTarget> = new Set();

  /** Next free texture unit for a frame. */
  private nextTextureUnit: number = 0;

  /** `true` once a "context lost" warning has been emitted. */
  private warnedLost: boolean = false;

  /** `true` once a "no program" warning has been emitted. */
  private warnedNoProgram: boolean = false;

  /**
   * Creates a renderer.
   *
   * @param options Renderer options plus the WebGL attribute bag.
   */
  constructor(options: WebGLRendererOptions = {}) {
    super(options as RendererOptions, BackendNames.WebGL);
    this.webglOptions = options;

    if (!this.headless) this.acquireContext();
    this.initialise();

    if (this.glContext !== null) {
      this.backend = this.glContext.isWebGL2 ? BackendNames.WebGL2 : BackendNames.WebGL;
    }
  }

  /* ------------------------------------------------------------------ context */

  /**
   * Acquires the context, tolerating a canvas that cannot provide one.
   *
   * A failure is recorded rather than thrown: the renderer stays constructible so
   * that `setSize`/`clear`/`dispose` keep working, and `render` reports the problem.
   */
  private acquireContext(): void {
    if (this.glContext !== null) return;
    const surface = this.surface as CanvasSurface;

    const contextOptions: WebGLContextOptions = {
      preset: this.webglOptions.preset ?? 'default3D',
      silent: this.webglOptions.quietContextProbe ?? false,
    };
    if (this.webglOptions.contextAttributes !== undefined) {
      contextOptions.attributes = this.webglOptions.contextAttributes;
    }
    if (this.webglOptions.preferWebGL2 !== undefined) contextOptions.preferWebGL2 = this.webglOptions.preferWebGL2;
    if (this.webglOptions.forceWebGL1 !== undefined) contextOptions.forceWebGL1 = this.webglOptions.forceWebGL1;

    try {
      this.glContext = new WebGLContext(surface, contextOptions);
    } catch (error) {
      this.glContext = null;
      log.warn(
        'WebGLRenderer: could not acquire a WebGL context, so nothing will be drawn. ' +
          'The renderer remains usable for sizing, clearing and disposal.',
        error,
      );
    }
  }

  /** @inheritdoc */
  protected override onInitialise(): void {
    if (this.glContext === null) this.acquireContext();
    const context = this.glContext;
    if (context === null) return;

    const isWebGL2 = context.isWebGL2;
    const vertexArrayExtension = getVertexArrayExtension(context.gl, isWebGL2);

    this.attributes = new WebGLAttributes(context.gl, {
      isWebGL2,
      state: context.state,
    });
    this.programCache = new WebGLProgramCache(context.gl, {
      maxSize: this.webglOptions.maxPrograms ?? 64,
      backend: isWebGL2 ? BackendNames.WebGL2 : BackendNames.WebGL,
    });
    this.vertexArrays = new WebGLVertexArrayCache(context.gl, {
      isWebGL2,
      extension: vertexArrayExtension,
      state: context.state,
    });

    context.onRestored(() => {
      this.onContextRestored();
    });
    context.onLost(() => {
      this.onContextLost();
    });

    this.renderState.viewport = { x: 0, y: 0, width: this.surface.width, height: this.surface.height };
    this.renderState.pixelRatio = this.pixelRatio;
    this.renderState.cull = CullMode.Back;
    this.renderState.depth.test = true;
    this.renderState.depth.write = true;
    context.state.applyRenderState(this.renderState);
  }

  /** @inheritdoc */
  protected override getCapabilities(): readonly string[] {
    const context = this.glContext;
    if (context === null) return [];
    return context.capabilities.toList();
  }

  /** @inheritdoc */
  protected override buildInfo(): RendererInfo {
    const base = super.buildInfo();
    const context = this.glContext;
    if (context === null) return base;

    const rendererInfo = context.extensions.getRendererInfo();
    return {
      ...base,
      ...(rendererInfo !== null ? { vendor: rendererInfo.vendor, renderer: rendererInfo.renderer } : {}),
      maxTextureSize: context.capabilities.limits.maxTextureSize,
      maxTextureUnits: context.capabilities.limits.maxTextureUnits,
      maxAttributes: context.capabilities.limits.maxAttributes,
    };
  }

  /* --------------------------------------------------------------- accessors */

  /** The acquired context, or `null` while headless or after a failed probe. */
  public get contextRef(): WebGLContext | null {
    return this.glContext;
  }

  /** The state shadow copy, or `null` while headless. */
  public get state(): WebGLState | null {
    return this.glContext?.state ?? null;
  }

  /** `true` when the context is usable for drawing right now. */
  public get isContextUsable(): boolean {
    return this.glContext !== null && this.glContext.isUsable;
  }

  /** Context generation counter, bumped on every loss and restore. */
  public get contextGeneration(): number {
    return this.glContext?.generation ?? 0;
  }

  /**
   * `render`/`memory` counters.
   *
   * `render.*` mirrors {@link WebGLRenderer.stats} (the base class owns the frame
   * counters), and `memory.*` counts the resources the renderer is tracking.
   */
  public get renderInfo(): WebGLRenderInfo {
    const stats = this.stats;
    return {
      render: {
        calls: stats.drawCalls,
        triangles: stats.triangles,
        points: stats.points,
        lines: stats.lines,
      },
      memory: {
        geometries: this.attributes?.geometryCount ?? 0,
        textures: this.textures.size,
        programs: this.programCache?.size ?? 0,
      },
    };
  }

  /* ------------------------------------------------------------------ sizing */

  /** @inheritdoc */
  protected override onSizeChanged(width: number, height: number, pixelRatio: number): void {
    this.renderState.viewport = { x: 0, y: 0, width: this.surface.width, height: this.surface.height };
    this.renderState.pixelRatio = pixelRatio;
    this.glContext?.state.setViewport(this.renderState.viewport);
    log.debug(`resized to ${width}x${height} @${pixelRatio}x`);
  }

  /** @inheritdoc */
  protected override onViewportChanged(viewport: Viewport): void {
    this.glContext?.state.setViewport(viewport);
  }

  /** @inheritdoc */
  protected override onScissorChanged(scissor: Scissor | null): void {
    this.glContext?.state.setScissor(scissor);
  }

  /* ------------------------------------------------------------------- clear */

  /** @inheritdoc */
  protected override clearSurface(options: {
    color: { r: number; g: number; b: number; a: number };
    depth: number;
    stencil: number;
    flags: ClearFlags;
  }): void {
    const context = this.glContext;
    if (context === null || !context.isUsable) return;

    const gl = context.gl;
    const state = context.state;

    // A clear obeys the write masks, so a mask left over from the previous draw
    // would silently swallow part of it.
    if ((options.flags & ClearFlags.Color) !== 0) state.setColorMask(true, true, true, true);
    if ((options.flags & ClearFlags.Depth) !== 0) state.setDepthWrite(true);
    if ((options.flags & ClearFlags.Stencil) !== 0) state.setStencilMask(0xff);

    if ((options.flags & ClearFlags.Color) !== 0) {
      const rgba = convertColor(options.color);
      gl.clearColor(rgba[0], rgba[1], rgba[2], rgba[3]);
    }
    if ((options.flags & ClearFlags.Depth) !== 0) gl.clearDepth(convertDepth(options.depth));
    if ((options.flags & ClearFlags.Stencil) !== 0) gl.clearStencil(Math.max(0, Math.floor(options.stencil)));

    gl.clear(toGLClearMask(gl, options.flags));
    this.stats.stateChanges++;
  }

  /* ------------------------------------------------------------------ render */

  /** @inheritdoc */
  protected override renderScene(
    scene: SceneLike | null,
    camera: CameraLike | null,
    context: RenderContext,
  ): void {
    const webgl = this.glContext;
    const attributes = this.attributes;
    const programs = this.programCache;
    const vertexArrays = this.vertexArrays;

    if (webgl === null || attributes === null || programs === null || vertexArrays === null) {
      log.warn(
        'WebGLRenderer: render() called without a usable WebGL context, so the frame is skipped. ' +
          'Pass a canvas that supports `getContext("webgl2")`/`("webgl")`, or run in an environment ' +
          'with a DOM.',
      );
      return;
    }

    if (!webgl.isUsable) {
      if (!this.warnedLost) {
        this.warnedLost = true;
        log.warn(
          'WebGLRenderer: the WebGL context is lost, so the frame is skipped. Rendering resumes ' +
            'automatically once the driver restores the context.',
        );
      }
      return;
    }
    this.warnedLost = false;

    const gl = webgl.gl;
    const state = webgl.state;
    const stateChangesBefore = state.changeCount;

    // The surface may have changed since the last frame (auto-resize, DPR swap).
    state.applyRenderState(this.renderState);

    if (this.resolvedAutoClear()) this.clearSurface(this.clearState.resolve(null));

    this.collected.length = 0;
    const renderables = this.collectRenderables(scene, camera);
    this.nextTextureUnit = 0;

    for (const renderable of renderables) {
      try {
        this.drawRenderable(renderable, camera, context, gl, state, attributes, programs, vertexArrays);
      } catch (error) {
        log.error(`a renderable threw while drawing (${describeRenderable(renderable)})`, error);
      }
    }

    this.stats.stateChanges += state.changeCount - stateChangesBefore;

    // Leave the context in a predictable state for the next owner.
    if (typeof gl.flush === 'function') gl.flush();
  }

  /** @returns `true` when the frame should clear itself first. */
  private resolvedAutoClear(): boolean {
    return this.options.autoClear !== false;
  }

  /**
   * Collects the renderables of a scene.
   *
   * The traversal is intentionally structural: a scene that implements
   * `collectRenderables(list, camera)` owns its own traversal; otherwise the direct
   * `children` are walked one level deep, and a bare renderable is drawn directly.
   *
   * @param scene Scene to walk.
   * @param camera Camera for the frame.
   * @returns The renderables to draw, in submission order.
   */
  protected collectRenderables(scene: SceneLike | null, camera: CameraLike | null): readonly WebGLRenderableLike[] {
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
    const object = candidate as WebGLRenderableLike;
    if (object.visible === false) return;
    if (object.geometry == null) return;
    this.collected.push(object);
  }

  /**
   * Draws one renderable.
   *
   * Exposed as a method (rather than inlined) so a subclass can wrap it with its own
   * instrumentation.
   */
  protected drawRenderable(
    renderable: WebGLRenderableLike,
    camera: CameraLike | null,
    context: RenderContext,
    gl: NonNullable<WebGLContext['gl']>,
    state: WebGLState,
    attributes: WebGLAttributes,
    programs: WebGLProgramCache,
    vertexArrays: WebGLVertexArrayCache,
  ): void {
    const geometry = renderable.geometry;
    if (geometry == null) return;

    const material = renderable.material ?? null;
    if (material?.visible === false) return;

    const topology = renderable.topology ?? material?.topology ?? PrimitiveTopology.Triangles;
    const mode = toGLTopology(gl, topology);

    // 1. Resolve the program. A ready IShader is used as-is; GLSL sources go
    //    through the LRU cache; nothing at all falls back to the built-in program.
    const textures = material?.textures ?? null;
    const defines = buildDefaultDefines(material?.defines, textures);
    const resolved = this.resolveProgram(programs, material, defines);
    if (resolved === null) {
      if (!this.warnedNoProgram) {
        this.warnedNoProgram = true;
        log.warn(
          `WebGLRenderer: could not obtain a program for material ${describeMaterial(material)}, so the ` +
            'draw is skipped. Give the material `vertexShader`/`fragmentShader` sources, or a ready ' +
            '`shader` implementing IShader.',
        );
      }
      return;
    }

    const program = resolved.program;
    if (!program.use()) {
      log.debug(`WebGLRenderer: program ${program.id} is not linked; skipping`, describeRenderable(renderable));
      return;
    }
    state.useProgram(program.handleOrNull);
    // 2. Bind the attribute buffers and the vertex array for this (geometry, program).
    const geometryKey = geometryKeyOf(geometry);
    const vao = vertexArrays.acquire(`${geometryKey}:${program.shaderKey}`);
    vao.bind();

    let vertexCount = 0;
    let boundAttributes = 0;
    const attributeNames = geometryAttributeNames(geometry);
    for (const name of attributeNames) {
      const attribute = geometry.getAttribute(name);
      if (attribute == null) continue;
      const location = program.getAttributeLocation(name);
      if (location < 0) continue;

      const record = attributes.update(attribute);
      if (record === null) continue;
      attributes.setPointer(location, record);
      vao.setAttributeEnabled(location, true);
      boundAttributes++;
      vertexCount = Math.max(vertexCount, attributeVertexCount(attribute));
    }

    if (boundAttributes === 0) {
      log.debug(
        `WebGLRenderer: geometry ${geometryKey} shares no attribute name with the program, so the ` +
          'draw is skipped. Check that the geometry exposes `position`/`normal`/`uv`.',
        describeRenderable(renderable),
      );
      return;
    }

    // 3. Upload uniforms: the automatic matrices, then the material's bag, then any
    //    per-object overrides (so an object can win over its material).
    this.uploadAutomaticUniforms(program, renderable, camera);
    if (material?.uniforms !== undefined) program.setUniforms(material.uniforms);
    if (renderable.uniforms !== undefined) program.setUniforms(renderable.uniforms);

    // 4. Bind textures and point their samplers at the units they landed on.
    this.bindTextures(program, state, textures);

    // 5. Apply the per-material state overrides.
    if (material?.side !== undefined) state.setCullFace(material.side);
    if (material?.depthTest !== undefined) state.setDepthTest(material.depthTest);
    if (material?.depthWrite !== undefined) state.setDepthWrite(material.depthWrite);
    if (material?.transparent === true) {
      // Straight (non-premultiplied) source-over blending: the conventional
      // default for a transparent material in a 3D scene.
      state.setBlend(true);
      state.setBlendFuncSeparate(
        BlendFactor.SrcAlpha,
        BlendFactor.OneMinusSrcAlpha,
        BlendFactor.One,
        BlendFactor.OneMinusSrcAlpha,
      );
      state.setBlendEquationSeparate(BlendEquation.Add, BlendEquation.Add);
    }

    // 6. Submit the draw.
    const index = geometry.getIndex();
    const instances = resolveInstanceCount(renderable);
    const stats = this.stats;
    const primitiveCount =
      renderable.drawRangeCount !== undefined && renderable.drawRangeCount > 0
        ? Math.floor(renderable.drawRangeCount)
        : vertexCount;
    const offset = Math.max(0, Math.floor(renderable.drawRangeStart ?? 0));

    if (index != null && index.array.length > 0) {
      const indexRecord: WebGLAttributeRecord | null = attributes.updateIndex(index as IndexLike);
      if (indexRecord === null) return;
      attributes.bindIndexBuffer(indexRecord);
      const elementCount = Math.min(indexRecord.count, index.array.length);
      const indexType = indexRecord.type;
      const bytesPerIndex = indexType === glConst(gl, 'UNSIGNED_INT', 0x1405) ? 4 : 2;
      const byteOffset = offset * bytesPerIndex;

      if (instances > 1) {
        this.drawElementsInstanced(gl, mode, elementCount - offset, indexType, byteOffset, instances);
      } else {
        gl.drawElements(mode, elementCount - offset, indexType, byteOffset);
      }
      this.countPrimitives(topology, elementCount - offset, instances);
    } else {
      const count = primitiveCount - offset;
      if (count <= 0) return;
      if (instances > 1) {
        this.drawArraysInstanced(gl, mode, offset, count, instances);
      } else {
        gl.drawArrays(mode, offset, count);
      }
      this.countPrimitives(topology, count, instances);
    }

    stats.drawCalls++;
    context.countObject(false);
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

  /** Issues an instanced `drawArrays`, using the WebGL1 extension when needed. */
  private drawArraysInstanced(gl: WebGLContext['gl'], mode: number, first: number, count: number, instances: number): void {
    if (this.glContext?.isWebGL2 === true) {
      (gl as WebGL2RenderingContext).drawArraysInstanced(mode, first, count, instances);
      return;
    }
    const extension = gl.getExtension('ANGLE_instanced_arrays') as ANGLE_instanced_arrays | null;
    if (extension !== null) {
      extension.drawArraysInstancedANGLE(mode, first, count, instances);
      return;
    }
    log.debug('instanced drawing is unavailable on this WebGL1 context; drawing a single instance');
    gl.drawArrays(mode, first, count);
  }

  /** Issues an instanced `drawElements`, using the WebGL1 extension when needed. */
  private drawElementsInstanced(
    gl: WebGLContext['gl'],
    mode: number,
    count: number,
    type: number,
    offset: number,
    instances: number,
  ): void {
    if (this.glContext?.isWebGL2 === true) {
      (gl as WebGL2RenderingContext).drawElementsInstanced(mode, count, type, offset, instances);
      return;
    }
    const extension = gl.getExtension('ANGLE_instanced_arrays') as ANGLE_instanced_arrays | null;
    if (extension !== null) {
      extension.drawElementsInstancedANGLE(mode, count, type, offset, instances);
      return;
    }
    gl.drawElements(mode, count, type, offset);
  }

  /* ------------------------------------------------------------------ programs */

  /** Resolved program for one draw. */
  private resolveProgram(
    programs: WebGLProgramCache,
    material: WebGLMaterialLike | null,
    defines: Readonly<Record<string, string | number | boolean>>,
  ): { program: WebGLProgram; defines: Readonly<Record<string, string | number | boolean>> } | null {
    const shader = material?.shader ?? null;
    if (shader !== null && shader instanceof WebGLProgram) {
      return { program: shader, defines: {} };
    }

    const vertexSource = material?.vertexShader ?? DEFAULT_VERTEX_SHADER;
    const fragmentSource = material?.fragmentShader ?? DEFAULT_FRAGMENT_SHADER;

    const acquired = programs.acquire({
      vertexSource,
      fragmentSource,
      defines,
      label: materialLabel(material),
    });
    if (acquired.program === null) return null;
    return { program: acquired.program, defines };
  }

  /**
   * Uploads the matrices and camera values a program may declare.
   *
   * Only uniforms the program actually declares are written, so a material's shader
   * can use as few or as many as it likes.
   *
   * @param program Program to upload into.
   * @param renderable Object being drawn.
   * @param camera Camera for the frame.
   */
  public uploadAutomaticUniforms(
    program: WebGLProgram,
    renderable: WebGLRenderableLike,
    camera: CameraLike | null,
  ): void {
    const uniforms = program.getUniformTable();
    if (uniforms.size === 0) return;

    const view = camera?.viewMatrix?.elements;
    const projection = camera?.projectionMatrix?.elements;
    const model = renderable.matrixWorld?.elements;

    if (projection !== undefined && uniforms.has('projectionMatrix')) {
      program.setUniform('projectionMatrix', toFloatArray(projection, 16));
    }
    if (view !== undefined && uniforms.has('viewMatrix')) {
      program.setUniform('viewMatrix', toFloatArray(view, 16));
    }
    if (model !== undefined && uniforms.has('modelMatrix')) {
      program.setUniform('modelMatrix', toFloatArray(model, 16));
    }
    if (model !== undefined && uniforms.has('modelViewMatrix')) {
      const modelView = view !== undefined ? multiplyMat4(view, model) : toFloatArray(model, 16);
      program.setUniform('modelViewMatrix', modelView);
      if (uniforms.has('normalMatrix')) {
        program.setUniform('normalMatrix', computeNormalMatrix(modelView));
      }
    }
    if (uniforms.has('cameraPosition') && camera?.position !== undefined) {
      const position = camera.position;
      program.setUniform('cameraPosition', [position.x, position.y, position.z ?? 0]);
    }
  }

  /* ------------------------------------------------------------------ textures */

  /**
   * Binds a material's textures and assigns their sampler uniforms.
   *
   * @param program Program whose samplers are being pointed at.
   * @param state State object used for deduplicated binding.
   * @param textures Material texture map, or `null`.
   * @returns The number of textures bound.
   */
  public bindTextures(
    program: WebGLProgram,
    state: WebGLState,
    textures: Readonly<Record<string, TextureBindingLike>> | null,
  ): number {
    if (textures == null) return 0;

    const maxUnits = this.glContext?.capabilities.limits.maxTextureUnits ?? 16;
    let bound = 0;

    for (const name of Object.keys(textures)) {
      const binding = textures[name];
      if (binding == null) continue;

      const texture = this.resolveTexture(binding, name);
      if (texture === null) continue;

      if (this.nextTextureUnit >= maxUnits) {
        log.warn(
          `WebGLRenderer: the material binds more textures than this context has units ` +
            `(${maxUnits}); '${name}' was skipped.`,
        );
        break;
      }

      const unit = binding.unit !== undefined ? Math.max(0, Math.floor(binding.unit)) : this.nextTextureUnit;
      if (binding.unit === undefined) this.nextTextureUnit++;

      texture.bind(unit);
      program.setUniform(name, unit);
      this.registerTexture(texture);
      bound++;
    }

    void state;
    return bound;
  }

  /** Resolves a texture binding into a backend texture, creating one when needed. */
  private resolveTexture(binding: TextureBindingLike, name: string): WebGLTexture | null {
    const direct = binding.texture ?? binding.glTexture;
    if (direct instanceof WebGLTexture) {
      direct.setData(binding);
      return direct;
    }

    const context = this.glContext;
    if (context === null) return null;

    // A binding that wraps an image gets its own backend texture here; nothing else
    // is able to upload texels.
    if (binding.image === undefined && direct == null) {
      log.debug(`WebGLRenderer: the texture bound as '${name}' carries no image; it is skipped.`);
      return null;
    }

    const texture = new WebGLTexture(
      {
        gl: context.gl,
        isWebGL2: context.isWebGL2,
        capabilities: context.capabilities,
        extensions: context.extensions,
        state: context.state,
      },
      {
        width: binding.width,
        height: binding.height,
        format: binding.format ?? PixelFormat.RGBA8,
        magFilter: binding.magFilter ?? TextureFilter.Linear,
        minFilter: binding.minFilter ?? TextureFilter.Linear,
        wrapS: binding.wrapS ?? TextureWrap.ClampToEdge,
        wrapT: binding.wrapT ?? TextureWrap.ClampToEdge,
        mipmaps: binding.generateMipmaps ?? false,
        label: name,
      },
    );
    texture.setData(normalizeBinding(binding));
    return texture;
  }

  /**
   * Registers a texture so it is counted and disposed with the renderer.
   *
   * @param texture Texture to track.
   * @returns The same texture, for chaining.
   */
  public registerTexture(texture: WebGLTexture): WebGLTexture {
    this.textures.add(texture);
    return texture;
  }

  /**
   * Stops tracking a texture without disposing it.
   *
   * @param texture Texture to forget.
   */
  public unregisterTexture(texture: WebGLTexture): void {
    this.textures.delete(texture);
  }

  /* ------------------------------------------------------------------ targets */

  /** @inheritdoc */
  protected override onCreateRenderTarget(options: RenderTargetOptions): IRenderTarget {
    const context = this.glContext;
    if (context === null) {
      throw new Error(
        'WebGLRenderer: cannot create a render target without a WebGL context. The renderer is ' +
          'either headless or the context could not be created; supply a canvas that supports WebGL.',
      );
    }

    const target = new WebGLRenderTarget(options, {
      gl: context.gl,
      isWebGL2: context.isWebGL2,
      capabilities: context.capabilities,
      extensions: context.extensions,
      generation: context.generation,
    });

    this.targets.add(target);
    for (const attachment of targetTextures(target)) this.registerTexture(attachment);
    return target;
  }

  /** @inheritdoc */
  public override setRenderTarget(target: IRenderTarget | null): void {
    super.setRenderTarget(target);

    const context = this.glContext;
    if (context === null || !context.isUsable) return;

    if (target === null) {
      context.gl.bindFramebuffer(glConst(context.gl, 'FRAMEBUFFER', 0x8d40), null);
      context.state.setViewport(this.viewport);
      context.state.setScissor(this.scissor);
      return;
    }

    if (target instanceof WebGLRenderTarget) {
      if (target.isStale(context.generation)) {
        target.setGeneration(context.generation);
        target.reinitialise({
          width: target.width,
          height: target.height,
          format: target.format,
          samples: target.samples,
          mipmaps: target.mipmaps,
        });
      }
      target.bind();
      context.state.setViewport({ x: 0, y: 0, width: target.width, height: target.height });
      context.state.setScissor(null);
      return;
    }

    throw new Error(
      'WebGLRenderer.setRenderTarget: the supplied target was not created by this renderer ' +
        `(${target.constructor?.name ?? 'unknown type'}). Create targets with ` +
        '`renderer.createRenderTarget({...})`.',
    );
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
    callback: (renderer: WebGLRenderer, target: IRenderTarget) => T,
  ): T {
    const previous = this.getRenderTarget();
    this.setRenderTarget(target);
    try {
      return callback(this, target);
    } finally {
      this.setRenderTarget(previous);
      if (target instanceof WebGLRenderTarget) target.resolve();
    }
  }

  /**
   * Reads pixels back from a render target.
   *
   * @param target Target to read.
   * @param x Left edge in device pixels.
   * @param y Bottom edge in device pixels.
   * @param width Region width; defaults to the whole attachment.
   * @param height Region height.
   * @returns RGBA bytes, or `null` when readback is not possible.
   */
  public readRenderTargetPixels(
    target: IRenderTarget,
    x: number = 0,
    y: number = 0,
    width?: number,
    height?: number,
  ): Uint8ClampedArray | null {
    if (!(target instanceof WebGLRenderTarget)) {
      throw new Error(
        'WebGLRenderer.readRenderTargetPixels: the supplied target was not created by this renderer.',
      );
    }
    return target.readPixels(x, y, width, height);
  }

  /**
   * Compiles every program the scene needs, without drawing.
   *
   * Uploading shaders before the first frame removes the hitch a first-draw
   * compilation causes; `compile` returns how many programs were linked.
   *
   * @param scene Scene to walk.
   * @param camera Camera the programs will be used with; accepted for symmetry.
   * @returns The number of programs compiled by this call.
   */
  public compile(scene: SceneLike | null, camera?: CameraLike | null): number {
    const programs = this.programCache;
    if (programs === null) return 0;

    this.collected.length = 0;
    const renderables = this.collectRenderables(scene, camera ?? null);
    let compiled = 0;

    for (const renderable of renderables) {
      const material = renderable.material ?? null;
      const textures = material?.textures ?? null;
      const defines = buildDefaultDefines(material?.defines, textures);
      const source = material?.vertexShader ?? DEFAULT_VERTEX_SHADER;
      const fragment = material?.fragmentShader ?? DEFAULT_FRAGMENT_SHADER;

      const before = programs.misses;
      const acquired = programs.acquire({
        vertexSource: source,
        fragmentSource: fragment,
        defines,
        label: materialLabel(material),
      });
      if (acquired.program === null) {
        log.warn(`WebGLRenderer.compile: a program failed to link\n${acquired.result?.log ?? ''}`);
      } else if (programs.misses > before) {
        compiled++;
      }
    }

    this.stats.programCompiles += compiled;
    return compiled;
  }

  /* ------------------------------------------------------------------ context loss */

  /** Handles the context-loss notification: stops submitting work. */
  private onContextLost(): void {
    this.attributes?.invalidate();
    this.vertexArrays?.clear();
    for (const target of this.targets) target.setGeneration(-1);
    log.warn('WebGLRenderer: GPU resources are now stale and will be re-uploaded after a restore.');
  }

  /** Handles the context-restore notification: replays the state and drops stale caches. */
  private onContextRestored(): void {
    const context = this.glContext;
    if (context === null) return;

    // Programs and VAOs belong to the dead context and cannot be reused.
    this.programCache?.dispose();
    this.programCache = new WebGLProgramCache(context.gl, {
      maxSize: this.webglOptions.maxPrograms ?? 64,
      backend: context.isWebGL2 ? BackendNames.WebGL2 : BackendNames.WebGL,
    });
    this.attributes?.invalidate();
    this.vertexArrays?.clear();
    this.vertexArrays = new WebGLVertexArrayCache(context.gl, {
      isWebGL2: context.isWebGL2,
      extension: getVertexArrayExtension(context.gl, context.isWebGL2),
      state: context.state,
    });

    for (const texture of this.textures) texture.markStale();
    for (const target of this.targets) {
      target.setGeneration(context.generation);
      target.reinitialise({
        width: target.width,
        height: target.height,
        format: target.format,
        samples: target.samples,
        mipmaps: target.mipmaps,
      });
    }

    context.state.applyRenderState(this.renderState);
    log.warn('WebGLRenderer: the context was restored; resources are re-created lazily.');
  }

  /* ------------------------------------------------------------------ dispose */

  /** @inheritdoc */
  protected override onDispose(): void {
    this.collected.length = 0;

    for (const target of this.targets) target.dispose();
    this.targets.clear();

    for (const texture of this.textures) texture.dispose();
    this.textures.clear();

    this.programCache?.dispose();
    this.programCache = null;
    this.attributes?.dispose();
    this.attributes = null;
    this.vertexArrays?.dispose();
    this.vertexArrays = null;

    this.glContext?.dispose();
    this.glContext = null;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Attribute names probed on a geometry, in the order the fallback program declares them. */
const WELL_KNOWN_ATTRIBUTES: readonly string[] = ['position', 'normal', 'uv', 'uv2', 'color', 'tangent', 'skinIndex', 'skinWeight'];

/**
 * Lists the attribute names of a geometry.
 *
 * `attributeNames` is preferred when the geometry exposes it (an interleaved
 * geometry knows its own layout); otherwise the well-known names are probed with
 * `getAttribute`, which is what a geometry layer that only implements the required
 * members needs to support.
 */
export function geometryAttributeNames(geometry: GeometryLike): readonly string[] {
  const declared = geometry.attributeNames;
  if (declared !== undefined && declared.length > 0) return declared;
  return WELL_KNOWN_ATTRIBUTES;
}

/** Number of vertices an attribute describes. */
export function attributeVertexCount(attribute: AttributeLike): number {
  const itemSize = Math.max(1, Math.floor(attribute.itemSize ?? 1));
  if (typeof attribute.count === 'number' && attribute.count > 0) return Math.floor(attribute.count);
  return Math.floor(attribute.array.length / itemSize);
}

/** Cache-key fragment identifying a geometry. */
export function geometryKeyOf(geometry: GeometryLike): string {
  const id = geometry.id;
  if (typeof id === 'string' && id.length > 0) return id;
  const names = geometry.attributeNames;
  const count = names === undefined ? 0 : names.length;
  return `geometry-${count}-${geometry.getIndex() !== undefined ? 'indexed' : 'plain'}`;
}

/** Instance count for a draw. */
export function resolveInstanceCount(renderable: WebGLRenderableLike): number {
  const explicit = renderable.instanceCount ?? renderable.count;
  if (typeof explicit !== 'number' || !Number.isFinite(explicit) || explicit < 1) return 1;
  return Math.floor(explicit);
}

/** Label used for a material in diagnostics. */
export function materialLabel(material: WebGLMaterialLike | null): string {
  if (material == null) return 'default-material';
  const id = material.id;
  if (typeof id === 'string' && id.length > 0) return id;
  if (typeof id === 'number') return `material-${id}`;
  return 'material';
}

/** Describes a renderable for error messages. */
export function describeRenderable(renderable: WebGLRenderableLike): string {
  if (typeof renderable.name === 'string' && renderable.name.length > 0) return renderable.name;
  if (renderable.id !== undefined) return `id=${String(renderable.id)}`;
  return 'anonymous renderable';
}

/** Describes a material for error messages. */
export function describeMaterial(material: WebGLMaterialLike | null): string {
  return material === null ? 'null' : `'${materialLabel(material)}'`;
}

/** `true` when a texture map is present. */
function hasTexture(textures: Readonly<Record<string, TextureBindingLike>> | null): boolean {
  return textures != null && textures['map'] != null;
}

/**
 * Lists every texture attachment of a render target.
 *
 * `RenderTarget` exposes its colour slots by index plus a single depth attachment;
 * this flattens the two into one list for registration.
 *
 * @param target Target to inspect.
 */
export function targetTextures(target: WebGLRenderTarget): WebGLTexture[] {
  const textures: WebGLTexture[] = [];
  for (let index = 0; index < target.colorAttachmentCount; index++) {
    const texture = target.getColorTexture(index);
    if (texture instanceof WebGLTexture) textures.push(texture);
  }
  const depth = target.getDepthTexture();
  if (depth instanceof WebGLTexture) textures.push(depth);
  return textures;
}

/**
 * Normalises a texture binding into the resource shape `WebGLTexture.setData` reads.
 *
 * @param binding Binding to normalise.
 * @returns A resource-shaped object with a no-op `dispose`.
 */
export function normalizeBinding(binding: TextureBindingLike): {
  image: unknown;
  width?: number;
  height?: number;
  format?: PixelFormat;
  magFilter?: TextureFilter;
  minFilter?: TextureFilter;
  wrapS?: TextureWrap;
  wrapT?: TextureWrap;
  generateMipmaps?: boolean;
  version?: number;
  dispose(): void;
} {
  const resource: {
    image: unknown;
    width?: number;
    height?: number;
    format?: PixelFormat;
    magFilter?: TextureFilter;
    minFilter?: TextureFilter;
    wrapS?: TextureWrap;
    wrapT?: TextureWrap;
    generateMipmaps?: boolean;
    version?: number;
    dispose(): void;
  } = {
    image: binding.image,
    dispose: () => {
      /* the renderer owns the texture's lifetime, not the binding */
    },
  };

  if (binding.width !== undefined) resource.width = binding.width;
  if (binding.height !== undefined) resource.height = binding.height;
  if (binding.format !== undefined) resource.format = binding.format;
  if (binding.magFilter !== undefined) resource.magFilter = binding.magFilter;
  if (binding.minFilter !== undefined) resource.minFilter = binding.minFilter;
  if (binding.wrapS !== undefined) resource.wrapS = binding.wrapS;
  if (binding.wrapT !== undefined) resource.wrapT = binding.wrapT;
  if (binding.generateMipmaps !== undefined) resource.generateMipmaps = binding.generateMipmaps;
  if (binding.version !== undefined) resource.version = binding.version;
  return resource;
}

/**
 * Builds the defines a program is compiled with.
 *
 * The material's own definitions come first so a material can always override the
 * inferred ones (`USE_MAP` in particular).
 */
export function buildDefaultDefines(
  defines: Readonly<Record<string, string | number | boolean | null | undefined>> | undefined,
  textures: Readonly<Record<string, TextureBindingLike>> | null,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  if (textures != null && textures['map'] != null) result['USE_MAP'] = 1;
  if (defines !== undefined) {
    for (const name of Object.keys(defines)) {
      const value = defines[name];
      if (value === null || value === undefined) continue;
      result[name] = value;
    }
  }
  return result;
}

/** Copies an `ArrayLike<number>` matrix into a `Float32Array` of at least 16 slots. */
export function toFloatArray(source: ArrayLike<number>, minimumLength: number): Float32Array {
  const out = new Float32Array(Math.max(minimumLength, source.length));
  for (let i = 0; i < source.length && i < out.length; i++) out[i] = source[i];
  return out;
}

/** Multiplies two column-major 4x4 matrices (`left * right`). */
export function multiplyMat4(left: ArrayLike<number>, right: ArrayLike<number>): Float32Array {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += (left[k * 4 + row] ?? 0) * (right[column * 4 + k] ?? 0);
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * Computes the inverse-transpose of the upper-left 3x3 of a column-major 4x4.
 *
 * This is the matrix that correctly transforms normals under non-uniform scale; a
 * plain `mat3(modelView)` skews them.
 *
 * @param m Column-major 4x4 source matrix.
 * @returns A column-major 3x3 normal matrix.
 */
export function computeNormalMatrix(m: ArrayLike<number>): Float32Array {
  const a00 = m[0] ?? 0;
  const a01 = m[1] ?? 0;
  const a02 = m[2] ?? 0;
  const a10 = m[4] ?? 0;
  const a11 = m[5] ?? 0;
  const a12 = m[6] ?? 0;
  const a20 = m[8] ?? 0;
  const a21 = m[9] ?? 0;
  const a22 = m[10] ?? 0;

  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;

  const determinant = a00 * b01 + a01 * b11 + a02 * b21;
  const out = new Float32Array(9);
  if (determinant === 0) {
    // Degenerate transform: fall back to the identity rather than producing NaNs
    // that would silently blank every normal-dependent shading term.
    out[0] = 1;
    out[4] = 1;
    out[8] = 1;
    return out;
  }

  const inverse = 1 / determinant;
  // `out` is the transpose of the inverse, laid out column-major.
  out[0] = b01 * inverse;
  out[1] = (-a22 * a01 + a02 * a21) * inverse;
  out[2] = (a12 * a01 - a02 * a11) * inverse;
  out[3] = b11 * inverse;
  out[4] = (a22 * a00 - a02 * a20) * inverse;
  out[5] = (-a12 * a00 + a02 * a10) * inverse;
  out[6] = b21 * inverse;
  out[7] = (-a21 * a00 + a01 * a20) * inverse;
  out[8] = (a11 * a00 - a01 * a10) * inverse;
  return out;
}

/** Re-exported so callers of the renderer need one import for the index shape. */
export type { IndexLike };
