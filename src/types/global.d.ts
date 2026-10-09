/**
 * Ambient type declarations shared by the whole library.
 *
 * These are intentionally *global* (no imports/exports) so that consumers that
 * opt into `"types": ["@dxyl/graphics/types"]` get the same base augmentations
 * the library itself compiles against.
 */

/** Environment the library is currently running in. */
type DXYLEnvironment = 'browser' | 'worker' | 'node' | 'unknown';

interface Window {
  /** WebKit-prefixed `requestAnimationFrame`, still present on older Safari. */
  webkitRequestAnimationFrame?: (callback: FrameRequestCallback) => number;
  /** WebKit-prefixed `cancelAnimationFrame`. */
  webkitCancelAnimationFrame?: (handle: number) => void;
  /** Opt-in flag set by consumers that embed the library in a shell. */
  __DXYL_GRAPHICS__?: {
    version?: string;
    backend?: string;
    debug?: boolean;
  };
}

interface OffscreenCanvasRenderingContext2D extends CanvasRenderingContext2D {
  canvas: OffscreenCanvas;
}

/** Minimal structural typing for the WebGPU global, feature-detected at runtime. */
interface GPUCanvasContext {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  configure(configuration: any): void;
  unconfigure(): void;
  getCurrentTexture(): any;
}

interface Navigator {
  /** Non-standard but universally shipped GPU vendor string. */
  readonly gpu?: any;
}
