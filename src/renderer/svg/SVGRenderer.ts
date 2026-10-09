/**
 * SVG renderer.
 *
 * Produces a **live SVG DOM**: an `<svg>` root with a `<defs>` container and one
 * `<g>` per renderable. Unlike the Canvas2D backend there is no pixel buffer, so
 * sizing is expressed through the `viewBox` (which is DPR-independent by design)
 * and the camera is a `transform` on the world group.
 *
 * Nodes receive an {@link SVGPainter}: a node factory plus helpers for building
 * paths, applying styles and appending children.
 *
 * ## Headless behaviour
 *
 * Without a DOM the renderer still constructs, tracks its size and supports
 * `setSize`, `setPixelRatio`, `clear` and `dispose`; `render` throws. `domElement`
 * and `svg` are `null` in that state.
 *
 * @packageDocumentation
 */

import { BackendNames, type BackendName } from '../../constants';
import { createLogger } from '../../utils/Logger';
import type { CameraLike, SceneLike } from '../interfaces/IRenderer';
import type { IRenderTarget } from '../interfaces/IRenderTarget';
import type { RenderTargetOptions, RendererOptions } from '../interfaces/types';
import { ClearFlags } from '../interfaces/types';
import { RenderContext } from '../core/RenderContext';
import { RenderList, type Renderable2D } from '../core/RenderList';
import { RenderQueue } from '../core/RenderQueue';
import type { RGBA } from '../utils/colorUtils';
import { toCss } from '../utils/colorUtils';
import { AbstractRenderer } from '../core/AbstractRenderer';
import { SVGDefs } from './SVGDefs';
import { SVGNodeFactory, setSVGAttribute, type SVGAttributes } from './SVGNodeFactory';
import { SVGPath, type CurveLike, type PathPointLike, type RectLike } from './SVGPath';
import { SVGStyle, svgUrlReference, type SVGStyleDescription } from './SVGStyle';

/** Logger for renderer diagnostics. */
const log = createLogger('renderer:svg');

/** Extended options accepted by {@link SVGRenderer}. */
export interface SVGRendererOptions extends RendererOptions {
  /** `true` to insert the root `<svg>` into the container. Defaults to `true`. */
  attachRoot?: boolean;
  /** Extra attributes applied to the root `<svg>` element. */
  rootAttributes?: SVGAttributes;
  /** `preserveAspectRatio` attribute of the root element. */
  preserveAspectRatio?: string;
}

/**
 * The drawing surface handed to SVG nodes.
 *
 * It is not immediate mode: nothing is rasterised until the browser lays out the
 * DOM. The API mirrors the subset of an immediate-mode painter that makes sense
 * for retained-mode SVG (creation, styling, transforms, children).
 */
export class SVGPainter {
  /** Renderer that owns this painter. */
  readonly #renderer: SVGRenderer;

  /** Group this painter appends to. */
  #target: Element | null;

  /** Cached style object applied to newly created elements. */
  public readonly style: SVGStyle = new SVGStyle();

  /**
   * Creates a painter.
   *
   * @param renderer Owning renderer.
   * @param target Initial group to append to.
   */
  constructor(renderer: SVGRenderer, target: Element | null = null) {
    this.#renderer = renderer;
    this.#target = target;
  }

  /** Element the painter appends to. */
  public get target(): Element | null {
    return this.#target;
  }

  /**
   * Redirects the painter at another parent element.
   *
   * @param target New parent, or `null` to detach.
   * @returns This painter, for chaining.
   */
  public setTarget(target: Element | null): this {
    this.#target = target;
    return this;
  }

  /** @returns The element factory backing this painter. */
  public get factory(): SVGNodeFactory {
    return this.#renderer.nodeFactory;
  }

  /** @returns The `<defs>` manager backing this painter. */
  public get defs(): SVGDefs | null {
    return this.#renderer.defs;
  }

  /* ---------------------------------------------------------------- creation */

  /**
   * Creates an element, applies this painter's style and appends it.
   *
   * @param name Tag name.
   * @param attributes Attributes to apply before the style.
   * @returns The element, or `null` without a DOM.
   */
  public create(name: string, attributes: SVGAttributes = {}): SVGElement | null {
    const element = this.factory.createWithAttributes(name, attributes);
    if (element === null) return null;
    this.applyStyle(element);
    this.append(element);
    return element;
  }

  /**
   * Creates a `<path>` from a path builder or a `d` string.
   *
   * @param path Path builder, `d` string, or a point list.
   * @param attributes Extra attributes.
   */
  public path(path: SVGPath | string | readonly PathPointLike[], attributes: SVGAttributes = {}): SVGElement | null {
    const d = typeof path === 'string' ? path : Array.isArray(path) ? SVGPath.fromPoints(path as readonly PathPointLike[]).toString() : path.toString();
    return this.create('path', { d, ...attributes });
  }

  /** Creates a `<rect>` and appends it. */
  public rect(x: number, y: number, width: number, height: number, attributes: SVGAttributes = {}): SVGElement | null {
    return this.create('rect', { x, y, width, height, ...attributes });
  }

  /** Creates a `<circle>` and appends it. */
  public circle(cx: number, cy: number, r: number, attributes: SVGAttributes = {}): SVGElement | null {
    return this.create('circle', { cx, cy, r, ...attributes });
  }

  /** Creates an `<ellipse>` and appends it. */
  public ellipse(cx: number, cy: number, rx: number, ry: number, attributes: SVGAttributes = {}): SVGElement | null {
    return this.create('ellipse', { cx, cy, rx, ry, ...attributes });
  }

  /** Creates a `<line>` and appends it. */
  public line(x1: number, y1: number, x2: number, y2: number, attributes: SVGAttributes = {}): SVGElement | null {
    return this.create('line', { x1, y1, x2, y2, ...attributes });
  }

  /** Creates a `<polygon>` from points and appends it. */
  public polygon(points: readonly { x: number; y: number }[], attributes: SVGAttributes = {}): SVGElement | null {
    return this.create('polygon', { points: pointsToAttribute(points), ...attributes });
  }

  /** Creates a `<polyline>` from points and appends it. */
  public polyline(points: readonly { x: number; y: number }[], attributes: SVGAttributes = {}): SVGElement | null {
    return this.create('polyline', { points: pointsToAttribute(points), ...attributes });
  }

  /**
   * Creates a `<text>` element and appends it.
   *
   * @param text Text content.
   * @param attributes Attributes (including `x`/`y`).
   */
  public text(text: string, attributes: SVGAttributes = {}): SVGElement | null {
    const element = this.create('text', attributes);
    if (element !== null) element.textContent = text;
    return element;
  }

  /**
   * Creates an `<image>` and appends it.
   *
   * @param href Image source.
   * @param attributes Attributes (including `x`/`y`/`width`/`height`).
   */
  public image(href: string, attributes: SVGAttributes = {}): SVGElement | null {
    const element = this.factory.createImage(href, attributes);
    if (element === null) return null;
    this.applyStyle(element);
    this.append(element);
    return element;
  }

  /**
   * Creates a `<g>` group and appends it.
   *
   * @param attributes Attributes to apply.
   */
  public group(attributes: SVGAttributes = {}): SVGElement | null {
    return this.create('g', attributes);
  }

  /**
   * Creates a `<g>` group and returns a painter scoped to it.
   *
   * @param attributes Attributes applied to the new group.
   * @returns A painter whose `target` is the new group.
   */
  public beginGroup(attributes: SVGAttributes = {}): SVGPainter {
    const group = this.group(attributes);
    return new SVGPainter(this.#renderer, group).applyCurrentStyle(this.style);
  }

  /**
   * Appends an existing element.
   *
   * @param element Element to append.
   * @returns The element, or `null` when the target is missing.
   */
  public append(element: Element | null): Element | null {
    if (element == null) return null;
    this.#target?.appendChild(element);
    return element;
  }

  /* ------------------------------------------------------------------- style */

  /**
   * Applies this painter's style to an element.
   *
   * @param element Element to style.
   * @returns The element, for chaining.
   */
  public applyStyle(element: Element): Element {
    return applyStyleToElement(element, this.style);
  }

  /**
   * Replaces the style applied to subsequently created elements.
   *
   * @param description Style fields to assign.
   * @returns This painter, for chaining.
   */
  public setStyle(description: SVGStyleDescription): this {
    this.style.assign(description);
    return this;
  }

  /**
   * Copies a style object into the painter.
   *
   * @param style Style to copy.
   * @returns This painter, for chaining.
   */
  public applyCurrentStyle(style: SVGStyle): this {
    this.style.assign(style.toObject());
    return this;
  }

  /* --------------------------------------------------------------- utilities */

  /**
   * Sets attributes on an element.
   *
   * @param element Element to modify.
   * @param attributes Attributes to apply.
   */
  public setAttributes(element: Element, attributes: SVGAttributes): void {
    this.factory.setAttributes(element, attributes);
  }

  /**
   * Resolves a definition id into a `url(#id)` reference.
   *
   * @param id Definition id, or `null`.
   */
  public url(id: string | null | undefined): string {
    return svgUrlReference(id);
  }

  /**
   * Builds a path from a parametric curve.
   *
   * @param curve Curve exposing `getPoint(t)`.
   * @param divisions Number of segments.
   */
  public curvePath(curve: CurveLike, divisions?: number): SVGPath {
    return SVGPath.fromCurve(curve, divisions);
  }

  /**
   * Builds a path from a rectangle.
   *
   * @param rect Rectangle to convert.
   */
  public rectPath(rect: RectLike): SVGPath {
    return SVGPath.fromRect(rect);
  }
}

/* -------------------------------------------------------------------------- */
/* SVGRenderer                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Renders scenes into a live SVG DOM.
 *
 * ```ts
 * const renderer = new SVGRenderer({ container: '#stage', width: 800, height: 600 });
 * renderer.setClearColor('#ffffff');
 * renderer.render(scene, camera);
 * ```
 */
export class SVGRenderer extends AbstractRenderer {
  /** @inheritdoc */
  public readonly backend: BackendName = BackendNames.SVG;

  /**
   * The surface the renderer reports.
   *
   * The SVG backend has no canvas, so this is always `null`; the DOM is reached
   * through {@link SVGRenderer.svg} and {@link SVGRenderer.domElement}.
   */
  public readonly painter: SVGPainter;

  /** Per-frame reusable render list. */
  public readonly renderList: RenderList<Renderable2D> = new RenderList<Renderable2D>();

  /** Per-frame reusable draw-order producer. */
  public readonly renderQueue: RenderQueue<Renderable2D> = new RenderQueue<Renderable2D>();

  /** Element factory for the managed document. */
  public readonly nodeFactory: SVGNodeFactory;

  /** `<defs>` manager, or `null` without a DOM. */
  public readonly defs: SVGDefs | null;

  /** Normalised options. */
  public readonly svgOptions: SVGRendererOptions;

  /** Wrapper `<div>` the root `<svg>` lives in, or `null`. */
  #wrapper: HTMLElement | null = null;

  /** Root `<svg>` element, or `null`. */
  #svg: SVGElement | null = null;

  /** `<defs>` element, or `null`. */
  #defsElement: SVGElement | null = null;

  /** Group holding the camera transform. */
  #world: SVGElement | null = null;

  /** Full-viewport background `<rect>`. */
  #background: SVGElement | null = null;

  /** Group elements assigned to renderables, keyed by object identity. */
  #groups: WeakMap<object, SVGElement> = new WeakMap();

  /** Scratch camera transform reused every frame. */
  readonly #cameraScratch = { x: 0, y: 0, zoom: 1, rotation: 0, hasCamera: false };

  /** Camera world position, for depth sorting. */
  readonly #cameraOrigin = { x: 0, y: 0, z: 0 };

  /**
   * Creates an SVG renderer.
   *
   * @param options Renderer options; `container` selects where the root element
   *   is inserted.
   */
  constructor(options: SVGRendererOptions = {}) {
    super(options as RendererOptions, BackendNames.SVG);
    this.svgOptions = options;

    const container = resolveContainer(options.container);
    this.nodeFactory = new SVGNodeFactory(resolveDocument(container));
    this.painter = new SVGPainter(this);

    this.defs = this.buildDom(container);

    this.initialise();
  }

  /* ------------------------------------------------------------------ DOM setup */

  /** Builds the `<svg>`/`<defs>`/world/background tree; returns the defs manager. */
  private buildDom(container: HTMLElement | null): SVGDefs | null {
    const factory = this.nodeFactory;
    if (!factory.isAvailable) return null;

    const doc = factory.document as Document;
    const wrapper = doc.createElement('div');
    wrapper.setAttribute('data-dxyl-renderer', 'svg');
    wrapper.style.position = 'relative';
    wrapper.style.display = 'block';
    wrapper.style.overflow = 'hidden';
    this.#wrapper = wrapper;

    const svg = factory.createRoot(this.width, this.height, {
      preserveAspectRatio: this.svgOptions.preserveAspectRatio ?? 'xMidYMid meet',
      ...(this.svgOptions.rootAttributes ?? {}),
    });
    if (svg === null) return null;
    svg.setAttribute('style', 'display:block;width:100%;height:100%');
    this.#svg = svg;
    wrapper.appendChild(svg);

    const defs = factory.createDefs();
    if (defs !== null) {
      svg.appendChild(defs);
      this.#defsElement = defs as SVGElement;
    }

    const background = factory.createRect(0, 0, this.width, this.height, {
      'data-dxyl-background': 'true',
    });
    if (background !== null) {
      setSVGAttribute(background, 'fill', '#000000');
      svg.appendChild(background);
      this.#background = background as SVGElement;
    }

    const world = factory.createGroup({ 'data-dxyl-world': 'true' });
    if (world !== null) {
      svg.appendChild(world);
      this.#world = world as SVGElement;
    }

    if (container !== null && (this.svgOptions.attachRoot ?? true)) {
      container.appendChild(wrapper);
    }

    return new SVGDefs(factory, this.#defsElement);
  }

  /** @inheritdoc */
  protected override onInitialise(): void {
    this.renderState.apply2DDefaults();
    this.renderState.viewport = { x: 0, y: 0, width: this.width, height: this.height };
    this.renderState.pixelRatio = this.pixelRatio;

    if (this.#svg === null) {
      log.warnOnce(
        'SVGRenderer: no DOM is available, so no <svg> element could be created. The ' +
          'renderer tracks its size, but render() throws until a DOM exists.',
      );
      return;
    }
    this.syncViewBox();
    this.painter.setTarget(this.#world);
  }

  /** @inheritdoc */
  protected override onSizeChanged(width: number, height: number, _pixelRatio: number): void {
    this.renderState.viewport = { x: 0, y: 0, width, height };
    this.syncViewBox();
    this.updateBackgroundRect();
  }

  /** @inheritdoc */
  protected override getCapabilities(): readonly string[] {
    const capabilities = ['vector-output', 'css-styling', 'gradients', 'patterns', 'filters', 'markers'];
    if (this.defs !== null) capabilities.push('defs');
    if (typeof (globalThis as unknown as { Path2D?: unknown }).Path2D !== 'undefined') capabilities.push('path2d-interop');
    return capabilities;
  }

  /**
   * Clearing an SVG document is a background-colour update, not a buffer wipe.
   *
   * With no DOM there is nothing to update, which is a no-op rather than an error,
   * so the renderer stays construct/size/clear/dispose-safe in Node.
   *
   * @returns Always `true`.
   */
  protected override allowsHeadlessClear(): boolean {
    return true;
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    this.defs?.clear();
    this.renderList.reset();
    this.renderQueue.reset();
    this.#groups = new WeakMap<object, SVGElement>();

    const wrapper = this.#wrapper;
    if (wrapper !== null && typeof wrapper.remove === 'function') wrapper.remove();

    this.#svg = null;
    this.#defsElement = null;
    this.#world = null;
    this.#background = null;
    this.#wrapper = null;
    this.painter.setTarget(null);
  }

  /* ------------------------------------------------------------------ accessors */

  /** The root `<svg>` element, or `null` when headless. */
  public get svg(): SVGElement | null {
    return this.#svg;
  }

  /** The world group that receives the camera transform, or `null`. */
  public get world(): SVGElement | null {
    return this.#world;
  }

  /** The background `<rect>`, or `null`. */
  public get background(): SVGElement | null {
    return this.#background;
  }

  /** @returns `true` when a DOM-backed `<svg>` root exists. */
  public get isLive(): boolean {
    return this.#svg !== null;
  }

  /* -------------------------------------------------------------------- sizing */

  /**
   * Enables or disables CSS-based sizing of the root element.
   *
   * When `fit` is `true` (the default) the root fills its wrapper and the viewBox
   * carries the logical size. When `false` the root uses explicit pixel dimensions,
   * which is what a fixed-size export needs.
   *
   * @param fit Whether the root should stretch to its container.
   */
  public setFitToContainer(fit: boolean): void {
    const svg = this.#svg;
    if (svg === null) return;
    svg.setAttribute('style', fit ? 'display:block;width:100%;height:100%' : 'display:block');
    if (!fit) {
      setSVGAttribute(svg, 'width', this.width);
      setSVGAttribute(svg, 'height', this.height);
    } else {
      svg.removeAttribute('width');
      svg.removeAttribute('height');
    }
  }

  /** Rewrites the `viewBox` and the root's explicit size. */
  private syncViewBox(): void {
    const svg = this.#svg;
    if (svg === null) return;
    setSVGAttribute(svg, 'viewBox', `0 0 ${this.width} ${this.height}`);
    this.updateBackgroundRect();
  }

  /** Keeps the background rectangle at the full logical size. */
  private updateBackgroundRect(): void {
    const background = this.#background;
    if (background === null) return;
    setSVGAttribute(background, 'x', 0);
    setSVGAttribute(background, 'y', 0);
    setSVGAttribute(background, 'width', this.width);
    setSVGAttribute(background, 'height', this.height);
  }

  /* -------------------------------------------------------------------- clear */

  /** @inheritdoc */
  protected override clearSurface(options: {
    color: RGBA;
    depth: number;
    stencil: number;
    flags: ClearFlags;
  }): void {
    const background = this.#background;
    if (background === null) return;

    // SVG has no depth or stencil buffers; only the colour bit is meaningful.
    if ((options.flags & ClearFlags.Color) === 0) return;

    if (options.color.a <= 0) {
      setSVGAttribute(background, 'fill', 'none');
    } else {
      setSVGAttribute(background, 'fill', toCss(options.color));
    }
    this.stats.drawCalls++;
  }

  /* ------------------------------------------------------------------- render */

  /**
   * Renders a scene, refusing politely when there is no `<svg>` root to draw into.
   *
   * @param scene Scene to render.
   * @param camera Camera for the frame, or `null`.
   * @throws Error When no DOM (and therefore no root element) is available.
   */
  public override render(scene: SceneLike | null, camera?: CameraLike | null): void {
    if (this.#svg === null) {
      throw new Error(
        'SVGRenderer: render() requires a DOM. No <svg> root exists because ' +
          '`document.createElementNS` is unavailable, so nothing can be painted. ' +
          'Construction, setSize, setPixelRatio, clear and dispose remain safe.',
      );
    }
    super.render(scene, camera);
  }

  /** @inheritdoc */
  protected override renderScene(
    scene: SceneLike | null,
    camera: CameraLike | null,
    context: RenderContext,
  ): void {
    if (this.#svg === null || this.#world === null) return;

    const list = this.renderList;
    list.reset();
    const collected = this.collectScene(scene, camera, list);
    context.renderList = list;
    context.renderQueue = this.renderQueue;

    this.applyCameraTransform(camera, context);
    this.applyClear(context.clearColor);

    if (collected) {
      const result = this.renderQueue.sort(list);
      this.paintEntries(result.order);
      context.countObject(false);
    }

    this.stats.stateChanges++;
  }

  /** Applies the frame's clear colour to the background rectangle. */
  private applyClear(color: Readonly<RGBA>): void {
    const background = this.#background;
    if (background === null) return;
    setSVGAttribute(background, 'fill', color.a <= 0 ? 'none' : toCss(color));
  }

  /**
   * Collects the renderables of a scene into the render list.
   *
   * Mirrors the Canvas2D traversal: `collectRenderables(list, camera)`, then
   * `children`, then the scene itself. Nothing here imports `src/scene`.
   *
   * @param scene Scene to walk.
   * @param camera Camera for the frame.
   * @param list List to fill.
   * @returns `true` when at least one renderable was collected.
   */
  protected collectScene(
    scene: SceneLike | null,
    camera: CameraLike | null,
    list: RenderList<Renderable2D>,
  ): boolean {
    if (scene == null || scene.visible === false) return false;

    const collector = (scene as { collectRenderables?: (target: unknown, cam: unknown) => void })
      .collectRenderables;
    if (typeof collector === 'function') {
      collector.call(scene, list, camera);
      return list.length > 0;
    }

    const children = (scene as { children?: readonly unknown[] }).children;
    if (Array.isArray(children)) {
      for (const child of children) this.pushRenderable(child, list, camera);
      return list.length > 0;
    }

    return this.pushRenderable(scene, list, camera);
  }

  /** Submits one child if it looks renderable. */
  private pushRenderable(
    candidate: unknown,
    list: RenderList<Renderable2D>,
    camera: CameraLike | null,
  ): boolean {
    if (candidate == null || typeof candidate !== 'object') return false;
    const object = candidate as Partial<Renderable2D> & { position?: { x: number; y: number; z?: number } };
    if (typeof object.render !== 'function') return false;

    const position = object.position;
    if (position !== undefined) {
      const dx = position.x - this.#cameraOrigin.x;
      const dy = position.y - this.#cameraOrigin.y;
      (object as { depth?: number }).depth = Math.sqrt(dx * dx + dy * dy);
    }

    return list.push(object as Renderable2D) !== null;
  }

  /** Draws every entry of a produced draw order. */
  private paintEntries(entries: readonly { object: Renderable2D }[]): void {
    for (const entry of entries) {
      const object = entry.object;
      if (object.visible === false) continue;

      const group = this.getOrCreateGroup(object);
      this.painter.setTarget(group);
      try {
        object.render(this.painter);
      } catch (error) {
        log.error(`an SVG renderable threw while drawing`, error);
      }
      this.stats.drawCalls++;
    }
    this.painter.setTarget(this.#world);
  }

  /**
   * Returns (creating when necessary) the `<g>` assigned to a renderable.
   *
   * @param object Renderable to look up.
   * @returns The group element, or `null` without a DOM.
   */
  public getOrCreateGroup(object: Renderable2D): SVGElement | null {
    const existing = this.#groups.get(object as object);
    if (existing !== undefined) return existing;

    const group = this.nodeFactory.createGroup({
      'data-dxyl-node': String((object as { id?: string | number }).id ?? 'anonymous'),
    });
    if (group === null) return null;

    this.#world?.appendChild(group);
    this.#groups.set(object as object, group as SVGElement);
    return group as SVGElement;
  }

  /**
   * Removes and forgets the group assigned to a renderable.
   *
   * @param object Renderable to detach.
   * @returns `true` when a group was removed.
   */
  public removeGroup(object: Renderable2D): boolean {
    const group = this.#groups.get(object as object);
    if (group === undefined) return false;
    this.nodeFactory.recycle(group);
    this.#groups.delete(object as object);
    return true;
  }

  /* ---------------------------------------------------------------- transform */

  /**
   * Applies the camera transform to the world group.
   *
   * World coordinates follow the math convention (`+Y` points up). Because SVG's
   * `+Y` points down, the mapping is
   * `translate(cx - x*z, cy + y*z) rotate(-r) scale(z, -z)`, where
   * `(x, y)` is the camera position, `z` its zoom and `r` its rotation.
   *
   * @param camera Camera for the frame, or `null` for the identity transform.
   * @param context Frame context carrying the extracted 2D transform.
   */
  public applyCameraTransform(camera: CameraLike | null, context: RenderContext): void {
    const world = this.#world;
    if (world === null) return;

    this.#cameraOrigin.x = camera?.position?.x ?? 0;
    this.#cameraOrigin.y = camera?.position?.y ?? 0;
    this.#cameraOrigin.z = camera?.position?.z ?? 0;

    const transform = context.camera2D;
    this.#cameraScratch.x = transform.x;
    this.#cameraScratch.y = transform.y;
    this.#cameraScratch.zoom = transform.zoom;
    this.#cameraScratch.rotation = transform.rotation;
    this.#cameraScratch.hasCamera = transform.hasCamera;

    const zoom = transform.zoom === 0 ? 1 : transform.zoom;
    const rotationDegrees = (transform.rotation * 180) / Math.PI;
    const translateX = this.width / 2 - transform.x * zoom;
    const translateY = this.height / 2 + transform.y * zoom;

    const parts = [`translate(${format(translateX)} ${format(translateY)})`];
    if (rotationDegrees !== 0) parts.push(`rotate(${format(-rotationDegrees)})`);
    parts.push(`scale(${format(zoom)} ${format(-zoom)})`);

    world.setAttribute('transform', parts.join(' '));
  }

  /* ----------------------------------------------------------- path shortcuts */

  /**
   * Creates a standalone `<path>` element from a builder.
   *
   * @param path Path builder or `d` string.
   * @param attributes Extra attributes.
   * @returns The element, or `null` without a DOM.
   */
  public createPath(path: SVGPath | string, attributes: SVGAttributes = {}): SVGElement | null {
    return this.nodeFactory.createPath(typeof path === 'string' ? path : path.toString(), attributes);
  }

  /* ------------------------------------------------------------------ targets */

  /** @inheritdoc */
  protected override onCreateRenderTarget(options: RenderTargetOptions): IRenderTarget {
    throw new Error(
      'SVGRenderer: off-screen render targets are not supported. SVG output lives in the ' +
        `document, so there is nothing to render into (requested ${options.width}x${options.height}). ` +
        'Use a WebGL/WebGPU backend for render-to-texture work.',
    );
  }

  /**
   * Serialises the current document to an SVG string.
   *
   * @returns The serialised markup, or `null` when there is no DOM or no
   *   `XMLSerializer` available.
   */
  public toSVGString(): string | null {
    const svg = this.#svg;
    if (svg === null) return null;
    const serializer = (globalThis as unknown as { XMLSerializer?: new () => XMLSerializer }).XMLSerializer;
    if (typeof serializer !== 'function') return null;
    try {
      return new serializer().serializeToString(svg);
    } catch (error) {
      log.warn('failed to serialise the SVG document', error);
      return null;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Resolves the container option into an element. */
function resolveContainer(container: SVGRendererOptions['container']): HTMLElement | null {
  if (container == null) {
    if (typeof document === 'undefined') return null;
    return document.body ?? null;
  }
  if (typeof container === 'string') {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
    return document.querySelector<HTMLElement>(container);
  }
  return container;
}

/** Picks the document to create elements in. */
function resolveDocument(container: HTMLElement | null): Document | null {
  if (container !== null && container.ownerDocument != null) return container.ownerDocument;
  if (typeof document !== 'undefined' && typeof document.createElementNS === 'function') return document;
  return null;
}

/** Writes every attribute of a style object onto an element. */
function applyStyleToElement(element: Element, style: SVGStyle): Element {
  const attributes = style.writeInto({});
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

/** Serialises a point list as a `points` attribute value. */
function pointsToAttribute(points: readonly { x: number; y: number }[]): string {
  const parts: string[] = [];
  for (const point of points) parts.push(`${format(point.x)},${format(point.y)}`);
  return parts.join(' ');
}

/** Formats a number without trailing zeros. */
function format(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Number(value.toFixed(4));
  return String(rounded === 0 ? 0 : rounded);
}
