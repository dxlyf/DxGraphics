/**
 * SVG element factory.
 *
 * Creates and caches SVG elements through
 * `document.createElementNS(SVG_NAMESPACE, name)` and provides the bulk
 * `setAttributes` helper the rest of the backend uses. Every method tolerates a
 * missing DOM by returning `null`, so an SVG scene can be *described* in Node even
 * though it cannot be painted.
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import { toSvgPaint, type SVGPaintInput } from './SVGStyle';

/** Logger for factory diagnostics. */
const log = createLogger('renderer:svg');

/** The SVG namespace every element is created in. */
export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** The XLINK namespace, still required for `<use xlink:href>` in SVG 1.1. */
export const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';

/** Element names {@link SVGNodeFactory} knows how to create. */
export type SVGElementName =
  | 'svg'
  | 'g'
  | 'path'
  | 'rect'
  | 'circle'
  | 'ellipse'
  | 'line'
  | 'polyline'
  | 'polygon'
  | 'text'
  | 'tspan'
  | 'image'
  | 'use'
  | 'defs'
  | 'clipPath'
  | 'mask'
  | 'marker'
  | 'pattern'
  | 'linearGradient'
  | 'radialGradient'
  | 'stop'
  | 'filter'
  | 'feGaussianBlur'
  | 'feColorMatrix'
  | 'feOffset'
  | 'feBlend'
  | 'feComposite'
  | 'feFlood'
  | 'feTurbulence'
  | 'foreignObject'
  | 'symbol'
  | 'title'
  | 'desc';

/** A value accepted by {@link SVGNodeFactory.setAttributes}. */
export type SVGAttributeValue = string | number | boolean | null | undefined;

/** Attribute bag accepted by {@link SVGNodeFactory.setAttributes}. */
export type SVGAttributes = Readonly<Record<string, SVGAttributeValue>>;

/**
 * Creates and caches SVG elements.
 *
 * The "cache" is a per-factory element pool: detached elements of a requested name
 * are recycled rather than re-created, which keeps long-lived scenes from
 * churning the DOM. Elements that are still attached to the document are never
 * recycled.
 */
export class SVGNodeFactory {
  /** Document the elements belong to, or `null` when there is no DOM. */
  public readonly document: Document | null;

  /** Detached elements available for reuse, keyed by tag name. */
  private readonly pool: Map<string, Element[]> = new Map();

  /** Number of elements handed out through {@link SVGNodeFactory.createElement}. */
  private created: number = 0;

  /**
   * Creates a factory.
   *
   * @param doc Document to create elements in. Defaults to the global `document`
   *   when one exists.
   */
  constructor(doc?: Document | null) {
    this.document = doc ?? defaultDocument();
  }

  /** @returns `true` when a DOM is available and elements can be created. */
  public get isAvailable(): boolean {
    return this.document !== null && typeof this.document.createElementNS === 'function';
  }

  /** @returns The number of elements created (excluding recycled ones). */
  public get createdCount(): number {
    return this.created;
  }

  /* ------------------------------------------------------------------ creation */

  /**
   * Creates (or recycles) an element in the SVG namespace.
   *
   * @param name Tag name, without a namespace prefix.
   * @returns The element, or `null` when no DOM is available.
   */
  public createElement(name: string): SVGElement | null {
    const doc = this.document;
    if (doc === null || typeof doc.createElementNS !== 'function') return null;

    const recycled = this.pool.get(name);
    if (recycled !== undefined && recycled.length > 0) {
      const element = recycled.pop() as SVGElement;
      this.resetElement(element);
      return element;
    }

    try {
      const element = doc.createElementNS(SVG_NAMESPACE, name);
      this.created++;
      return element as unknown as SVGElement;
    } catch (error) {
      log.warn(`failed to create <${name}>`, error);
      return null;
    }
  }

  /**
   * Creates the root `<svg>` element.
   *
   * @param width Logical width in CSS pixels.
   * @param height Logical height in CSS pixels.
   * @param attributes Extra attributes.
   * @returns The root element, or `null` without a DOM.
   */
  public createRoot(width: number, height: number, attributes: SVGAttributes = {}): SVGElement | null {
    const root = this.createElement('svg');
    if (root === null) return null;
    this.setAttributes(root, {
      xmlns: SVG_NAMESPACE,
      viewBox: `0 0 ${width} ${height}`,
      width: String(width),
      height: String(height),
      ...attributes,
    });
    return root;
  }

  /** Creates a `<g>` group. */
  public createGroup(attributes: SVGAttributes = {}): SVGElement | null {
    return this.createWithAttributes('g', attributes);
  }

  /** Creates a `<defs>` container. */
  public createDefs(attributes: SVGAttributes = {}): SVGElement | null {
    return this.createWithAttributes('defs', attributes);
  }

  /** Creates a `<path>`. */
  public createPath(d: string, attributes: SVGAttributes = {}): SVGElement | null {
    return this.createWithAttributes('path', { d, ...attributes });
  }

  /** Creates a `<rect>`. */
  public createRect(
    x: number,
    y: number,
    width: number,
    height: number,
    attributes: SVGAttributes = {},
  ): SVGElement | null {
    return this.createWithAttributes('rect', { x, y, width, height, ...attributes });
  }

  /** Creates a `<circle>`. */
  public createCircle(cx: number, cy: number, r: number, attributes: SVGAttributes = {}): SVGElement | null {
    return this.createWithAttributes('circle', { cx, cy, r, ...attributes });
  }

  /** Creates an `<ellipse>`. */
  public createEllipse(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    attributes: SVGAttributes = {},
  ): SVGElement | null {
    return this.createWithAttributes('ellipse', { cx, cy, rx, ry, ...attributes });
  }

  /** Creates a `<line>`. */
  public createLine(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    attributes: SVGAttributes = {},
  ): SVGElement | null {
    return this.createWithAttributes('line', { x1, y1, x2, y2, ...attributes });
  }

  /** Creates a `<polyline>`. */
  public createPolyline(points: string, attributes: SVGAttributes = {}): SVGElement | null {
    return this.createWithAttributes('polyline', { points, ...attributes });
  }

  /** Creates a `<polygon>`. */
  public createPolygon(points: string, attributes: SVGAttributes = {}): SVGElement | null {
    return this.createWithAttributes('polygon', { points, ...attributes });
  }

  /** Creates a `<text>` element. */
  public createText(text: string, x: number, y: number, attributes: SVGAttributes = {}): SVGElement | null {
    const element = this.createWithAttributes('text', { x, y, ...attributes });
    if (element !== null) element.textContent = text;
    return element;
  }

  /** Creates an `<image>` element. */
  public createImage(href: string, attributes: SVGAttributes = {}): SVGElement | null {
    const element = this.createWithAttributes('image', attributes);
    if (element !== null) setHref(element, href);
    return element;
  }

  /** Creates a `<use>` element referencing another element by id. */
  public createUse(reference: string, attributes: SVGAttributes = {}): SVGElement | null {
    const element = this.createWithAttributes('use', attributes);
    if (element !== null) setHref(element, reference);
    return element;
  }

  /** Creates a `<clipPath>`. */
  public createClipPath(id: string, attributes: SVGAttributes = {}): SVGElement | null {
    return this.createWithAttributes('clipPath', { id, ...attributes });
  }

  /** Creates a `<mask>`. */
  public createMask(id: string, attributes: SVGAttributes = {}): SVGElement | null {
    return this.createWithAttributes('mask', { id, ...attributes });
  }

  /** Creates a `<marker>`. */
  public createMarker(id: string, attributes: SVGAttributes = {}): SVGElement | null {
    return this.createWithAttributes('marker', { id, ...attributes });
  }

  /** Creates a `<pattern>`. */
  public createPattern(id: string, attributes: SVGAttributes = {}): SVGElement | null {
    return this.createWithAttributes('pattern', { id, patternUnits: 'userSpaceOnUse', ...attributes });
  }

  /** Creates a `<linearGradient>`. */
  public createLinearGradient(id: string, attributes: SVGAttributes = {}): SVGElement | null {
    return this.createWithAttributes('linearGradient', { id, ...attributes });
  }

  /** Creates a `<radialGradient>`. */
  public createRadialGradient(id: string, attributes: SVGAttributes = {}): SVGElement | null {
    return this.createWithAttributes('radialGradient', { id, ...attributes });
  }

  /**
   * Creates a gradient `<stop>`.
   *
   * @param offset Position along the gradient, in 0..1.
   * @param color Stop colour; `null` disables the stop colour.
   * @param opacity Optional stop opacity in 0..1.
   */
  public createStop(offset: number, color: SVGPaintInput, opacity?: number): SVGElement | null {
    const attributes: Record<string, SVGAttributeValue> = {
      offset: `${Math.max(0, Math.min(1, offset)) * 100}%`,
    };
    const paint = toSvgPaint(color);
    if (paint !== undefined && paint !== 'none') attributes['stop-color'] = paint;
    if (opacity !== undefined) attributes['stop-opacity'] = opacity;
    return this.createWithAttributes('stop', attributes);
  }

  /** Creates a `<filter>`. */
  public createFilter(id: string, attributes: SVGAttributes = {}): SVGElement | null {
    return this.createWithAttributes('filter', { id, ...attributes });
  }

  /**
   * Creates an arbitrary element and applies attributes in one step.
   *
   * @param name Tag name.
   * @param attributes Attributes to apply.
   */
  public createWithAttributes(name: string, attributes: SVGAttributes = {}): SVGElement | null {
    const element = this.createElement(name);
    if (element === null) return null;
    this.setAttributes(element, attributes);
    return element;
  }

  /* ------------------------------------------------------------------- helpers */

  /**
   * Applies an attribute bag to an element.
   *
   * `null` and `undefined` values **remove** the attribute; booleans are written as
   * `'true'`/`'false'`; numbers are formatted without trailing zeros.
   *
   * @param element Element to modify.
   * @param attributes Attributes to apply.
   * @returns The element, for chaining.
   */
  public setAttributes(element: Element, attributes: SVGAttributes): Element {
    for (const [name, value] of Object.entries(attributes)) {
      setSVGAttribute(element, name, value);
    }
    return element;
  }

  /**
   * Appends children to a parent.
   *
   * @param parent Element to append to.
   * @param children Children to append; `null` entries are skipped.
   * @returns The parent, for chaining.
   */
  public appendChildren(parent: Element, children: readonly (Element | null | undefined)[]): Element {
    for (const child of children) {
      if (child != null) parent.appendChild(child);
    }
    return parent;
  }

  /**
   * Clears an element and returns it to the pool.
   *
   * @param element Element to recycle.
   */
  public recycle(element: Element | null | undefined): void {
    if (element == null) return;
    if (typeof element.remove === 'function') element.remove();
    else element.parentNode?.removeChild(element);

    const name = element.tagName;
    const bucket = this.pool.get(name);
    if (bucket === undefined) this.pool.set(name, [element]);
    else bucket.push(element);
  }

  /**
   * Serves a child element from a per-parent pool.
   *
   * Keeps the child count of `parent` at `count`, creating or recycling as needed,
   * which is how the SVG renderer avoids rebuilding its tree every frame.
   *
   * @param parent Element whose children are managed.
   * @param count Desired number of children.
   * @param name Tag name of the children.
   * @returns The list of child elements, all attached to `parent`.
   */
  public ensureChildren(parent: Element, count: number, name: string = 'g'): Element[] {
    const result: Element[] = [];

    for (let i = 0; i < count; i++) {
      const existing = parent.childNodes[i] as Element | undefined;
      if (existing !== undefined && existing.tagName?.toLowerCase() === name.toLowerCase()) {
        result.push(existing);
        continue;
      }
      const child = this.createElement(name);
      if (child === null) break;
      if (existing !== undefined) parent.insertBefore(child, existing);
      else parent.appendChild(child);
      result.push(child);
    }

    while (parent.childNodes.length > count) {
      const extra = parent.lastChild;
      if (extra === null) break;
      parent.removeChild(extra);
    }

    return result;
  }

  /** Empties every pool. */
  public clearPool(): void {
    this.pool.clear();
  }

  /** @returns The number of detached elements currently pooled. */
  public getPoolSize(): number {
    let total = 0;
    for (const bucket of this.pool.values()) total += bucket.length;
    return total;
  }

  /* -------------------------------------------------------------------- private */

  /** Removes every attribute, child and text node from a recycled element. */
  private resetElement(element: SVGElement): void {
    const attributes = element.attributes;
    for (let i = attributes.length - 1; i >= 0; i--) {
      const attribute = attributes.item(i);
      if (attribute !== null) element.removeAttribute(attribute.name);
    }
    element.textContent = '';
  }
}

/* -------------------------------------------------------------------------- */
/* Free helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Resolves the ambient document, or `null`. */
function defaultDocument(): Document | null {
  if (typeof document === 'undefined') return null;
  return typeof document.createElementNS === 'function' ? document : null;
}

/**
 * Sets or removes a single attribute.
 *
 * @param element Element to modify.
 * @param name Attribute name.
 * @param value Attribute value; `null`/`undefined` removes it.
 */
export function setSVGAttribute(element: Element, name: string, value: SVGAttributeValue): void {
  if (value === null || value === undefined) {
    element.removeAttribute(name);
    return;
  }
  if (typeof value === 'boolean') {
    element.setAttribute(name, value ? 'true' : 'false');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      element.removeAttribute(name);
      return;
    }
    const rounded = Number(value.toFixed(4));
    element.setAttribute(name, String(rounded === 0 ? 0 : rounded));
    return;
  }
  element.setAttribute(name, value);
}

/**
 * Applies an attribute bag to an element.
 *
 * Free-function form of {@link SVGNodeFactory.setAttributes}, for code that has no
 * factory at hand.
 *
 * @param element Element to modify.
 * @param attributes Attributes to apply.
 * @returns The element, for chaining.
 */
export function setAttributes(element: Element, attributes: SVGAttributes): Element {
  for (const [name, value] of Object.entries(attributes)) setSVGAttribute(element, name, value);
  return element;
}

/** Sets `href` and the legacy `xlink:href`, which Safari still needs for `<use>`. */
export function setHref(element: Element, href: string): void {
  const value = href.startsWith('#') || href.startsWith('url(') ? href : href;
  setSVGAttribute(element, 'href', value);
  try {
    element.setAttributeNS(XLINK_NAMESPACE, 'xlink:href', value);
  } catch {
    /* `xlink:href` is optional in SVG 2 */
  }
}

/** Serialises a point list as a `points` attribute value. */
export function pointsToAttribute(points: readonly { x: number; y: number }[]): string {
  const parts: string[] = [];
  for (const point of points) {
    parts.push(`${Number(point.x.toFixed(4))},${Number(point.y.toFixed(4))}`);
  }
  return parts.join(' ');
}
