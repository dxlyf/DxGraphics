/**
 * DOM helpers.
 *
 * Every function tolerates a missing DOM (Node, workers) so the library can be
 * imported in a server context without touching `document` at module scope.
 *
 * @packageDocumentation
 */

/** `true` when a usable `document` is present. */
export function hasDom(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

/** `true` when a usable `window` is present. */
export function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

/** Returns `document.body` when available. */
export function getDocumentBody(): HTMLElement | null {
  return hasDom() ? document.body : null;
}

/**
 * Resolves a wide range of element inputs to an `HTMLElement`.
 *
 * Accepts an element, a CSS selector, or `null`/`undefined` (which resolves to
 * `document.body` when a DOM exists).
 */
export function resolveElement(target: string | HTMLElement | null | undefined): HTMLElement | null {
  if (target == null) return getDocumentBody();
  if (typeof target === 'string') {
    if (!hasDom()) return null;
    return document.querySelector<HTMLElement>(target);
  }
  return target;
}

/**
 * Resolves an element or canvas selector to an `HTMLCanvasElement`.
 *
 * When `target` is falsy a fresh, detached canvas is created; this mirrors how
 * renderers are usually constructed in tests and headless workers.
 */
export function resolveCanvas(
  target?: string | HTMLCanvasElement | null,
  options: { width?: number; height?: number; create?: boolean } = {},
): HTMLCanvasElement | null {
  const { width = 300, height = 150, create = true } = options;

  if (typeof target === 'string') {
    if (!hasDom()) return null;
    const found = document.querySelector(target);
    if (found instanceof HTMLCanvasElement) return found;
    if (found instanceof HTMLElement) {
      const canvas = createCanvas({ width, height });
      found.appendChild(canvas);
      return canvas;
    }
    return null;
  }

  if (target instanceof HTMLCanvasElement) return target;
  if (!create || !hasDom()) return null;
  return createCanvas({ width, height });
}

/** Creates a detached `HTMLCanvasElement` with the requested backing size. */
export function createCanvas(options: { width?: number; height?: number } = {}): HTMLCanvasElement {
  const { width = 300, height = 150 } = options;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(width));
  canvas.height = Math.max(1, Math.floor(height));
  return canvas;
}

/** Reads a canvas' CSS size, falling back to its backing-store size. */
export function getElementSize(
  element: HTMLElement | null,
  fallback: { width: number; height: number } = { width: 300, height: 150 },
): { width: number; height: number } {
  if (!element) return { ...fallback };
  const rect = element.getBoundingClientRect?.();
  const width = Math.round(rect?.width || element.clientWidth || fallback.width);
  const height = Math.round(rect?.height || element.clientHeight || fallback.height);
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/**
 * Resizes a canvas' backing store to match its device-pixel size.
 *
 * @returns The new pixel dimensions.
 */
export function resizeCanvasToDisplaySize(
  canvas: HTMLCanvasElement,
  pixelRatio: number = 1,
  force: boolean = false,
): { width: number; height: number; changed: boolean } {
  const { width: cssWidth, height: cssHeight } = getElementSize(canvas, {
    width: canvas.clientWidth || canvas.width,
    height: canvas.clientHeight || canvas.height,
  });

  const width = Math.max(1, Math.floor(cssWidth * pixelRatio));
  const height = Math.max(1, Math.floor(cssHeight * pixelRatio));
  const changed = force || canvas.width !== width || canvas.height !== height;

  if (changed) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height, changed };
}

/** Creates a styled `div` appended to `parent`, used for example scaffolding. */
export function createContainer(
  parent: HTMLElement,
  style: Partial<CSSStyleDeclaration> = {},
): HTMLDivElement {
  const container = document.createElement('div');
  container.style.position = style.position ?? 'relative';
  container.style.width = style.width ?? '100%';
  container.style.height = style.height ?? '100%';
  container.style.overflow = style.overflow ?? 'hidden';
  Object.assign(container.style, style);
  parent.appendChild(container);
  return container;
}

/** Removes an element from its parent when it is still attached. */
export function removeElement(element: Element | null | undefined): void {
  if (element && element.parentNode) element.parentNode.removeChild(element);
}

/** Registers a DOM event listener and returns an unsubscribe function. */
export function addListener<K extends keyof HTMLElementEventMap>(
  target: HTMLElement | Window | Document,
  type: K | string,
  listener: (event: any) => void,
  options?: AddEventListenerOptions | boolean,
): () => void {
  target.addEventListener(type as string, listener as EventListener, options);
  return () => target.removeEventListener(type as string, listener as EventListener, options);
}

/** Reads the computed `devicePixelRatio`, clamped to a sane range. */
export function getPixelRatio(max: number = 4): number {
  if (!hasWindow()) return 1;
  const ratio = window.devicePixelRatio || 1;
  return Math.min(max, Math.max(1, ratio));
}

/** Converts a pointer event's client coordinates into element-local pixels. */
export function getPointerPosition(
  event: { clientX: number; clientY: number },
  element: HTMLElement,
): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

/** Returns the bounds of an element as a plain object. */
export function getElementRect(element: HTMLElement): {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
} {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    top: rect.top,
    left: rect.left,
  };
}

/** Creates an `<img>` element and waits for it to decode. */
export function loadImageElement(src: string, crossOrigin?: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (crossOrigin) image.crossOrigin = crossOrigin;
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    image.src = src;
  });
}

/** Injects a `<style>` block into `document.head`, returning a removal handle. */
export function injectStyle(css: string, id?: string): () => void {
  if (!hasDom()) return () => undefined;
  const style = document.createElement('style');
  if (id) style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
  return () => removeElement(style);
}

/** Sets or removes an attribute, using `null` to remove. */
export function setAttribute(
  element: Element,
  name: string,
  value: string | number | boolean | null | undefined,
): void {
  if (value == null || value === false) element.removeAttribute(name);
  else element.setAttribute(name, String(value));
}

/** Applies a `Partial<CSSStyleDeclaration>` to an element's inline style. */
export function applyStyle(element: HTMLElement, style: Partial<CSSStyleDeclaration>): void {
  for (const [key, value] of Object.entries(style)) {
    if (value == null) continue;
    (element.style as any)[key] = value;
  }
}

/** Reads a data attribute as a number, falling back when absent/invalid. */
export function getDataNumber(element: HTMLElement, name: string, fallback: number): number {
  const raw = element.getAttribute(`data-${name}`);
  if (raw == null) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
