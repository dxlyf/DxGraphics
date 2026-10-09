/**
 * Demo contract shared by the playground registry and the demos themselves.
 *
 * Each demo owns its scene, its parameter schema and its camera; the shell only owns
 * the canvas, the renderer and the frame loop. That split is what lets a backend be
 * swapped without touching a demo, because the demos never see the renderer directly —
 * only the painter the backend hands them.
 */

import type { BackendName, Canvas2DPainter, Renderable2D } from '../../../src/index';

/** Backends the playground can drive. `webgl` and `webgpu` are handled by the shell. */
export type PlaygroundBackend = BackendName;

/** A camera in the shape the 2D backends read structurally. */
export interface DemoCamera {
  readonly position: { x: number; y: number; z: number };
  zoom: number;
  rotation: number;
}

/**
 * One editable demo parameter.
 *
 * The shell renders these into the options panel and keeps a mutable `value` record, so
 * a demo reads its parameters through `ctx.params` and never touches the DOM.
 */
export interface DemoParam {
  /** Key inside the `params` record. */
  readonly key: string;
  readonly label: string;
  readonly kind: 'slider' | 'toggle' | 'select';
  readonly value: number | boolean | string;
  /** Slider bounds. */
  readonly min?: number;
  readonly max?: number;
  /** Slider granularity. */
  readonly step?: number;
  /** Select choices. */
  readonly choices?: readonly { value: string; label: string }[];
}

/** Mutable parameter values, keyed by `DemoParam.key`. */
export type ParamValues = Record<string, number | boolean | string>;

/** What a demo is given each frame. */
export interface DemoContext {
  /** The live painter for the active backend, or `null` when the backend has no painter. */
  readonly painter: Canvas2DPainter | null;
  /** The camera this demo should render through. */
  readonly camera: DemoCamera;
  /** Seconds since the previous frame, as reported by the renderer's loop. */
  readonly delta: number;
  /** Seconds since the demo was created. */
  readonly time: number;
  /** Current logical canvas size in CSS pixels. */
  readonly width: number;
  /** Current logical canvas height in CSS pixels. */
  readonly height: number;
  /** Live parameter values. */
  readonly params: ParamValues;
  /** The `Renderable2D[]` the shell submits to the renderer. */
  readonly objects: Renderable2D[];
}

/** A runnable demo. */
export interface SceneDemo {
  /** Stable identifier used in the registry and the URL hash. */
  readonly id: string;
  /** Human-readable name for the demo picker. */
  readonly label: string;
  /** One-line description shown under the picker. */
  readonly description: string;
  /** Backends this demo can render through. */
  readonly backends: readonly PlaygroundBackend[];
  /** Editable parameters. */
  readonly params: readonly DemoParam[];
  /** Initial camera. */
  readonly camera: { position: { x: number; y: number; z: number }; zoom: number; rotation: number };
  /** Builds the demo's renderables and fills `ctx.objects`. */
  setup(ctx: DemoContext): void;
  /** Advances one frame. Implementations should not allocate per call. */
  update(ctx: DemoContext): void;
}

/** Convenience: reads a numeric parameter, falling back when absent. */
export function numberParam(params: ParamValues, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Convenience: reads a boolean parameter, falling back when absent. */
export function booleanParam(params: ParamValues, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** Convenience: reads a string parameter, falling back when absent. */
export function stringParam(params: ParamValues, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === 'string' ? value : fallback;
}
