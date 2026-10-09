/**
 * Runtime capability and environment detection.
 *
 * @packageDocumentation
 */

import { BackendNames, type BackendName } from '../constants';

/**
 * Minimal structural declaration of the worker global scope.
 *
 * `WorkerGlobalScope` is declared in TypeScript's `webworker` lib, which cannot
 * be combined with `dom` in a single `tsconfig` because the two declare
 * conflicting globals. Declaring the small surface this module needs keeps the
 * library buildable with the `dom` lib while still detecting worker contexts.
 */
declare const WorkerGlobalScope: (new () => object) | undefined;

/** Cached environment probe; the answer cannot change during a process. */
let cachedEnvironment: 'browser' | 'worker' | 'node' | 'unknown' | null = null;

/** Detects the current JavaScript environment. */
export function getEnvironment(): 'browser' | 'worker' | 'node' | 'unknown' {
  if (cachedEnvironment) return cachedEnvironment;

  const globalObject: any = typeof globalThis !== 'undefined' ? globalThis : {};

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    cachedEnvironment = 'browser';
  } else if (
    typeof WorkerGlobalScope !== 'undefined' &&
    globalObject instanceof (WorkerGlobalScope as unknown as new () => object)
  ) {
    cachedEnvironment = 'worker';
  } else if (
    typeof process !== 'undefined' &&
    process.versions != null &&
    process.versions.node != null
  ) {
    cachedEnvironment = 'node';
  } else if (
    typeof globalObject.importScripts === 'function' ||
    (typeof globalObject.self !== 'undefined' && typeof globalObject.document === 'undefined' && globalObject.self === globalObject)
  ) {
    cachedEnvironment = 'worker';
  } else {
    cachedEnvironment = 'unknown';
  }
  return cachedEnvironment;
}

/** `true` when running inside a Web Worker (dedicated, shared or service). */
export function isWorker(): boolean {
  return getEnvironment() === 'worker';
}

/** `true` when running in Node.js. */
export function isNode(): boolean {
  return getEnvironment() === 'node';
}

/** `true` when running in a browser main thread. */
export function isBrowser(): boolean {
  return getEnvironment() === 'browser';
}

/** `true` when the page is cross-origin isolated (`SharedArrayBuffer` enabled). */
export function isCrossOriginIsolated(): boolean {
  const globalObject: any = globalThis as any;
  return globalObject.crossOriginIsolated === true;
}

/** `true` when `OffscreenCanvas` is available. */
export function hasOffscreenCanvas(): boolean {
  return typeof (globalThis as any).OffscreenCanvas === 'function';
}

/** `true` when the WebGPU API surface is present. */
export function hasWebGPU(): boolean {
  const nav: any = typeof navigator !== 'undefined' ? navigator : undefined;
  return typeof nav?.gpu?.requestAdapter === 'function';
}

/** `true` when WebGL2 is available. */
export function hasWebGL2(): boolean {
  return typeof WebGL2RenderingContext !== 'undefined' && probeContext('webgl2') !== null;
}

/** `true` when WebGL1 is available. */
export function hasWebGL(): boolean {
  if (typeof WebGLRenderingContext === 'undefined') return false;
  return probeContext('webgl') !== null || probeContext('webgl2') !== null;
}

/** `true` when a 2D canvas context can be created. */
export function hasCanvas2D(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('2d') != null;
  } catch {
    return false;
  }
}

/** `true` when the SVG DOM is available (`document.createElementNS`). */
export function hasSVG(): boolean {
  return typeof document !== 'undefined' && typeof document.createElementNS === 'function';
}

/** Creates a throwaway canvas and requests a context, never throwing. */
function probeContext(type: string): RenderingContext | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    return (canvas.getContext(type as any) as RenderingContext | null) ?? null;
  } catch {
    return null;
  }
}

/** Reports every backend that is usable in the current environment. */
export function getSupportedBackends(): BackendName[] {
  const result: BackendName[] = [];
  if (hasCanvas2D()) result.push(BackendNames.Canvas2D);
  if (hasSVG()) result.push(BackendNames.SVG);
  if (hasWebGL()) result.push(BackendNames.WebGL);
  if (hasWebGL2()) result.push(BackendNames.WebGL2);
  if (hasWebGPU()) result.push(BackendNames.WebGPU);
  return result;
}

/** A snapshot of the host environment, useful for bug reports. */
export interface EnvironmentInfo {
  environment: 'browser' | 'worker' | 'node' | 'unknown';
  userAgent: string;
  platform: string;
  hardwareConcurrency: number;
  deviceMemory: number | null;
  devicePixelRatio: number;
  crossOriginIsolated: boolean;
  offscreenCanvas: boolean;
  webgpu: boolean;
  webgl: boolean;
  webgl2: boolean;
  canvas2d: boolean;
  svg: boolean;
}

/** Collects an {@link EnvironmentInfo} snapshot. */
export function getEnvironmentInfo(): EnvironmentInfo {
  const nav: any = typeof navigator !== 'undefined' ? navigator : undefined;
  return {
    environment: getEnvironment(),
    userAgent: nav?.userAgent ?? 'unknown',
    platform: nav?.platform ?? (isNode() ? process.platform : 'unknown'),
    hardwareConcurrency: typeof nav?.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : (isNode() ? 0 : 1),
    deviceMemory: typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : null,
    devicePixelRatio: typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1,
    crossOriginIsolated: isCrossOriginIsolated(),
    offscreenCanvas: hasOffscreenCanvas(),
    webgpu: hasWebGPU(),
    webgl: hasWebGL(),
    webgl2: hasWebGL2(),
    canvas2d: hasCanvas2D(),
    svg: hasSVG(),
  };
}

/** `true` when the user agent looks like a mobile device. */
export function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent);
}

/** `true` when the platform is macOS. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

/** `true` when the platform is Windows. */
export function isWindows(): boolean {
  if (typeof navigator === 'undefined') return isNode() && process.platform === 'win32';
  return /Win/i.test(navigator.platform || navigator.userAgent);
}

/** `true` when the browser is Safari (including iOS WebKit variants). */
export function isSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR/i.test(ua);
}

/** `true` when the browser is Firefox. */
export function isFirefox(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Firefox/i.test(navigator.userAgent);
}

/** `true` when the runtime prefers reduced motion. */
export function prefersReducedMotion(): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** `true` when the runtime reports a coarse (touch) pointer. */
export function isTouchDevice(): boolean {
  if (typeof matchMedia === 'function') {
    try {
      if (matchMedia('(pointer: coarse)').matches) return true;
    } catch {
      /* ignore */
    }
  }
  return typeof ontouchstart !== 'undefined' || isMobile();
}

/**
 * Requests an animation frame, falling back to a timer in Node.
 *
 * @returns A cancel handle accepted by {@link cancelFrame}.
 */
export function requestFrame(callback: (time: number) => void): number {
  const globalObject: any = globalThis as any;
  const raf =
    globalObject.requestAnimationFrame ??
    globalObject.webkitRequestAnimationFrame ??
    ((cb: (time: number) => void) => setTimeout(() => cb(Date.now()), 16) as unknown as number);
  return raf.call(globalObject, callback);
}

/** Cancels a handle returned by {@link requestFrame}. */
export function cancelFrame(handle: number): void {
  const globalObject: any = globalThis as any;
  const caf =
    globalObject.cancelAnimationFrame ??
    globalObject.webkitCancelAnimationFrame ??
    ((id: number) => clearTimeout(id as unknown as NodeJS.Timeout));
  caf.call(globalObject, handle);
}

/** High-resolution timestamp in milliseconds, monotonic where supported. */
export function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/** Idle callback wrapper that degrades to `setTimeout`. */
export function whenIdle(callback: () => void, timeout: number = 100): number {
  const globalObject: any = globalThis as any;
  if (typeof globalObject.requestIdleCallback === 'function') {
    return globalObject.requestIdleCallback(callback, { timeout });
  }
  return setTimeout(callback, 0) as unknown as number;
}

/** Resets the cached environment probe. Test-only helper. */
export function resetEnvironmentCache(): void {
  cachedEnvironment = null;
}
