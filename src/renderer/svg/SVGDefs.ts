/**
 * SVG `<defs>` manager.
 *
 * Gradients, patterns, clip paths, masks, filters and markers are shared resources:
 * several nodes usually reference the same definition. This manager gives every
 * definition a generated id, keeps a **reference count**, and removes the element
 * from the DOM as soon as its last reference is released.
 *
 * @packageDocumentation
 */

import { createId } from '../../utils/Id';
import { createLogger } from '../../utils/Logger';
import { svgUrlReference, toSvgPaint, type SVGPaintInput } from './SVGStyle';
import { SVGNodeFactory } from './SVGNodeFactory';

/** Logger for defs diagnostics. */
const log = createLogger('renderer:svg:defs');

/* -------------------------------------------------------------------------- */
/* Descriptions                                                               */
/* -------------------------------------------------------------------------- */

/** One colour stop of a gradient. */
export interface GradientStop {
  /** Position along the gradient, in 0..1. */
  offset: number;
  /** Stop colour. */
  color: SVGPaintInput;
  /** Stop opacity in 0..1. */
  opacity?: number;
}

/** Common gradient description. */
export interface GradientDescription {
  /** Stops, in order. */
  stops: readonly GradientStop[];
  /** `gradientUnits`. Defaults to `'userSpaceOnUse'`. */
  units?: 'userSpaceOnUse' | 'objectBoundingBox';
  /** `gradientTransform`. */
  transform?: string;
  /** `spreadMethod`. Defaults to `'pad'`. */
  spreadMethod?: 'pad' | 'reflect' | 'repeat';
}

/** Linear-gradient description. */
export interface LinearGradientDescription extends GradientDescription {
  /** Start x. */
  x1: number;
  /** Start y. */
  y1: number;
  /** End x. */
  x2: number;
  /** End y. */
  y2: number;
}

/** Radial-gradient description. */
export interface RadialGradientDescription extends GradientDescription {
  /** Outer circle centre x. */
  cx: number;
  /** Outer circle centre y. */
  cy: number;
  /** Outer radius. */
  r: number;
  /** Inner circle centre x. Defaults to `cx`. */
  fx?: number;
  /** Inner circle centre y. Defaults to `cy`. */
  fy?: number;
  /** Inner radius. Defaults to `0`. */
  fr?: number;
}

/** Pattern description. */
export interface PatternDescription {
  /** Tile width. */
  width: number;
  /** Tile height. */
  height: number;
  /** `patternUnits`. Defaults to `'userSpaceOnUse'`. */
  units?: 'userSpaceOnUse' | 'objectBoundingBox';
  /** `patternContentUnits`. */
  contentUnits?: 'userSpaceOnUse' | 'objectBoundingBox';
  /** `patternTransform`. */
  transform?: string;
  /** Tile content; appended to the `<pattern>`. */
  content?: Element | null;
}

/** Filter description. */
export interface FilterDescription {
  /** `x` region. Defaults to `'-10%'`. */
  x?: string | number;
  /** `y` region. Defaults to `'-10%'`. */
  y?: string | number;
  /** `width` region. Defaults to `'120%'`. */
  width?: string | number;
  /** `height` region. Defaults to `'120%'`. */
  height?: string | number;
  /** `filterUnits`. */
  units?: 'userSpaceOnUse' | 'objectBoundingBox';
  /** `filterRes`, when the caller needs a fixed resolution. */
  resolution?: { x: number; y: number };
  /** Primitive elements to append, in order. */
  primitives?: readonly Element[];
  /** Convenience: build a Gaussian blur primitive with this radius. */
  blurRadius?: number;
}

/** Marker description. */
export interface MarkerDescription {
  /** `markerWidth`. */
  width: number;
  /** `markerHeight`. */
  height: number;
  /** `refX`. */
  refX?: number;
  /** `refY`. */
  refY?: number;
  /** `orient`. Defaults to `'auto'`. */
  orient?: string | number;
  /** `markerUnits`. Defaults to `'strokeWidth'`. */
  units?: 'strokeWidth' | 'userSpaceOnUse';
  /** Marker content. */
  content?: Element | null;
}

/** Clip-path / mask description. */
export interface ShapeReferenceDescription {
  /** Shapes defining the clip/mask region. */
  shapes: readonly Element[];
  /** `clipPathUnits` / `maskUnits`. */
  units?: 'userSpaceOnUse' | 'objectBoundingBox';
  /** `maskContentUnits`. */
  contentUnits?: 'userSpaceOnUse' | 'objectBoundingBox';
}

/** Kind of definition managed by {@link SVGDefs}. */
export enum SVGDefKind {
  LinearGradient = 'linearGradient',
  RadialGradient = 'radialGradient',
  Pattern = 'pattern',
  ClipPath = 'clipPath',
  Mask = 'mask',
  Filter = 'filter',
  Marker = 'marker',
}

/** A managed definition. */
export interface SVGDefEntry {
  /** Generated identifier. */
  readonly id: string;
  /** Kind of definition. */
  readonly kind: SVGDefKind;
  /** The `<defs>` child element. */
  readonly element: Element;
  /** Number of live references. */
  references: number;
}

/** Returned by {@link SVGDefs.reference}. */
export interface SVGDefReference {
  /** Definition id. */
  readonly id: string;
  /** Ready-to-use `url(#id)` value. */
  readonly url: string;
  /**
   * Releases one reference.
   *
   * When the count reaches zero the definition is removed from `<defs>`.
   */
  release(): void;
}

/* -------------------------------------------------------------------------- */
/* SVGDefs                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Owns the `<defs>` element of one SVG document.
 *
 * ```ts
 * const defs = new SVGDefs(factory, defsElement);
 * const gradient = defs.createLinearGradient({ x1: 0, y1: 0, x2: 1, y2: 0, stops });
 * path.setAttribute('fill', gradient.url);
 * // later
 * gradient.release();
 * ```
 */
export class SVGDefs {
  /** Element factory used to build definition children. */
  public readonly factory: SVGNodeFactory;

  /** The `<defs>` element, or `null` without a DOM. */
  public readonly element: Element | null;

  /** Live definitions, keyed by id. */
  private readonly entries: Map<string, SVGDefEntry> = new Map();

  /** Ids the caller wants to keep alive even at zero references. */
  private readonly pins: Set<string> = new Set();

  /**
   * Creates a defs manager.
   *
   * @param factory Element factory.
   * @param element The `<defs>` element to manage, or `null`.
   */
  constructor(factory: SVGNodeFactory, element: Element | null) {
    this.factory = factory;
    this.element = element;
  }

  /** Number of live definitions. */
  public get size(): number {
    return this.entries.size;
  }

  /** @returns The definitions currently managed, in insertion order. */
  public getEntries(): readonly SVGDefEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Looks a definition up by id.
   *
   * @param id Definition id.
   */
  public get(id: string): SVGDefEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Increments the reference count of a definition.
   *
   * @param id Definition id.
   * @returns A releasable reference handle.
   */
  public reference(id: string): SVGDefReference {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      log.warnOnce(`reference() called for the unknown definition '${id}'`);
      return { id, url: `url(#${id})`, release: () => undefined };
    }
    entry.references++;
    let released = false;
    return {
      id,
      url: `url(#${id})`,
      release: () => {
        if (released) return;
        released = true;
        entry.references = Math.max(0, entry.references - 1);
        this.collectIfUnused(entry);
      },
    };
  }

  /**
   * Prevents a definition from being collected when its count reaches zero.
   *
   * @param id Definition id.
   * @param pinned Whether the definition should be pinned.
   */
  public pin(id: string, pinned: boolean = true): void {
    if (pinned) this.pins.add(id);
    else {
      this.pins.delete(id);
      const entry = this.entries.get(id);
      if (entry !== undefined) this.collectIfUnused(entry);
    }
  }

  /* ---------------------------------------------------------------- factories */

  /**
   * Creates a `<linearGradient>`.
   *
   * @param description Gradient geometry and stops.
   * @returns A releasable reference; {@link SVGDefReference.url} is the paint value.
   */
  public createLinearGradient(description: LinearGradientDescription): SVGDefReference {
    const element = this.factory.createElement(SVGDefKind.LinearGradient);
    const id = this.allocateId('gradient');
    if (element === null) return this.detachedReference(id);

    this.factory.setAttributes(element, {
      id,
      x1: description.x1,
      y1: description.y1,
      x2: description.x2,
      y2: description.y2,
      gradientUnits: description.units ?? 'userSpaceOnUse',
      spreadMethod: description.spreadMethod ?? 'pad',
      gradientTransform: description.transform,
    });
    this.appendStops(element, description.stops);
    return this.attach(SVGDefKind.LinearGradient, id, element);
  }

  /**
   * Creates a `<radialGradient>`.
   *
   * @param description Gradient geometry and stops.
   * @returns A releasable reference.
   */
  public createRadialGradient(description: RadialGradientDescription): SVGDefReference {
    const element = this.factory.createElement(SVGDefKind.RadialGradient);
    const id = this.allocateId('gradient');
    if (element === null) return this.detachedReference(id);

    this.factory.setAttributes(element, {
      id,
      cx: description.cx,
      cy: description.cy,
      r: Math.max(0, description.r),
      fx: description.fx,
      fy: description.fy,
      fr: description.fr,
      gradientUnits: description.units ?? 'userSpaceOnUse',
      spreadMethod: description.spreadMethod ?? 'pad',
      gradientTransform: description.transform,
    });
    this.appendStops(element, description.stops);
    return this.attach(SVGDefKind.RadialGradient, id, element);
  }

  /**
   * Creates a `<pattern>`.
   *
   * @param description Pattern geometry and content.
   * @returns A releasable reference.
   */
  public createPattern(description: PatternDescription): SVGDefReference {
    const element = this.factory.createElement(SVGDefKind.Pattern);
    const id = this.allocateId('pattern');
    if (element === null) return this.detachedReference(id);

    this.factory.setAttributes(element, {
      id,
      width: description.width,
      height: description.height,
      patternUnits: description.units ?? 'userSpaceOnUse',
      patternContentUnits: description.contentUnits,
      patternTransform: description.transform,
    });
    if (description.content != null) element.appendChild(description.content);
    return this.attach(SVGDefKind.Pattern, id, element);
  }

  /**
   * Creates a `<clipPath>`.
   *
   * @param description Clip shapes and units.
   * @returns A releasable reference.
   */
  public createClipPath(description: ShapeReferenceDescription): SVGDefReference {
    const element = this.factory.createElement(SVGDefKind.ClipPath);
    const id = this.allocateId('clip');
    if (element === null) return this.detachedReference(id);

    this.factory.setAttributes(element, {
      id,
      clipPathUnits: description.units ?? 'userSpaceOnUse',
    });
    this.factory.appendChildren(element, description.shapes);
    return this.attach(SVGDefKind.ClipPath, id, element);
  }

  /**
   * Creates a `<mask>`.
   *
   * @param description Mask shapes and units.
   * @returns A releasable reference.
   */
  public createMask(description: ShapeReferenceDescription): SVGDefReference {
    const element = this.factory.createElement(SVGDefKind.Mask);
    const id = this.allocateId('mask');
    if (element === null) return this.detachedReference(id);

    this.factory.setAttributes(element, {
      id,
      maskUnits: description.units ?? 'userSpaceOnUse',
      maskContentUnits: description.contentUnits,
    });
    this.factory.appendChildren(element, description.shapes);
    return this.attach(SVGDefKind.Mask, id, element);
  }

  /**
   * Creates a `<filter>`.
   *
   * @param description Filter region, primitives and optional convenience blur.
   * @returns A releasable reference.
   */
  public createFilter(description: FilterDescription = {}): SVGDefReference {
    const element = this.factory.createElement(SVGDefKind.Filter);
    const id = this.allocateId('filter');
    if (element === null) return this.detachedReference(id);

    this.factory.setAttributes(element, {
      id,
      x: description.x ?? '-10%',
      y: description.y ?? '-10%',
      width: description.width ?? '120%',
      height: description.height ?? '120%',
      filterUnits: description.units ?? 'objectBoundingBox',
      'filterRes': description.resolution
        ? `${description.resolution.x} ${description.resolution.y}`
        : undefined,
    });

    if (description.blurRadius !== undefined && description.blurRadius > 0) {
      const blur = this.factory.createWithAttributes('feGaussianBlur', {
        stdDeviation: description.blurRadius,
        result: 'blur',
      });
      if (blur !== null) element.appendChild(blur);
    }
    if (description.primitives) this.factory.appendChildren(element, description.primitives);

    return this.attach(SVGDefKind.Filter, id, element);
  }

  /**
   * Creates a `<marker>`.
   *
   * @param description Marker geometry and content.
   * @returns A releasable reference.
   */
  public createMarker(description: MarkerDescription): SVGDefReference {
    const element = this.factory.createElement(SVGDefKind.Marker);
    const id = this.allocateId('marker');
    if (element === null) return this.detachedReference(id);

    this.factory.setAttributes(element, {
      id,
      markerWidth: description.width,
      markerHeight: description.height,
      refX: description.refX,
      refY: description.refY,
      orient: description.orient ?? 'auto',
      markerUnits: description.units ?? 'strokeWidth',
    });
    if (description.content != null) element.appendChild(description.content);
    return this.attach(SVGDefKind.Marker, id, element);
  }

  /* ------------------------------------------------------------------ lifecycle */

  /**
   * Releases one reference to a definition.
   *
   * @param id Definition id.
   * @returns `true` when the definition was removed.
   */
  public release(id: string): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined) return false;
    entry.references = Math.max(0, entry.references - 1);
    return this.collectIfUnused(entry);
  }

  /**
   * Removes a definition immediately, regardless of its reference count.
   *
   * @param id Definition id.
   * @returns `true` when a definition was removed.
   */
  public remove(id: string): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined) return false;
    this.entries.delete(id);
    this.pins.delete(id);
    entry.element.remove();
    return true;
  }

  /** Removes every definition. */
  public clear(): void {
    for (const entry of this.entries.values()) entry.element.remove();
    this.entries.clear();
    this.pins.clear();
  }

  /**
   * Removes every definition that is no longer referenced.
   *
   * @returns The number of definitions collected.
   */
  public collect(): number {
    let removed = 0;
    for (const entry of [...this.entries.values()]) {
      if (this.collectIfUnused(entry)) removed++;
    }
    return removed;
  }

  /** @returns The number of definitions with at least one live reference. */
  public getReferencedCount(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.references > 0) total++;
    }
    return total;
  }

  /* -------------------------------------------------------------------- private */

  /** Creates and registers a definition, returning a counted reference. */
  private attach(kind: SVGDefKind, id: string, element: Element): SVGDefReference {
    this.element?.appendChild(element);
    const entry: SVGDefEntry = { id, kind, element, references: 0 };
    this.entries.set(id, entry);
    return this.reference(id);
  }

  /** Builds a reference for a definition that could not be created. */
  private detachedReference(id: string): SVGDefReference {
    return {
      id,
      url: svgUrlReference(id),
      release: () => undefined,
    };
  }

  /** Allocates a unique, human-readable id. */
  private allocateId(prefix: string): string {
    let id = `${prefix}-${createId()}`;
    while (this.entries.has(id)) id = `${prefix}-${createId()}`;
    return id;
  }

  /** Appends `<stop>` children for a gradient description. */
  private appendStops(gradient: Element, stops: readonly GradientStop[]): void {
    for (const stop of stops) {
      const element = this.factory.createStop(stop.offset, stop.color, stop.opacity);
      if (element !== null) gradient.appendChild(element);
    }
  }

  /** Removes a definition when it has no references and is not pinned. */
  private collectIfUnused(entry: SVGDefEntry): boolean {
    if (entry.references > 0) return false;
    if (this.pins.has(entry.id)) return false;
    this.entries.delete(entry.id);
    entry.element.remove();
    return true;
  }
}
