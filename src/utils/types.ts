/**
 * Utility-layer types.
 *
 * @packageDocumentation
 */

/** A resource that can be released, optionally asynchronously. */
export interface IDestroyable {
  destroy(): void;
}

/** Options accepted by {@link Pool}. */
export interface PoolOptions<T> {
  capacity?: number;
  prewarm?: number;
  onAcquire?: (item: T) => void;
  onRelease?: (item: T) => void;
}

/** A binary search range. */
export interface Range {
  min: number;
  max: number;
}

/** A value measured over time (used by the profiler helpers). */
export interface TimingSample {
  /** Label of the measured section. */
  label: string;
  /** Duration in milliseconds. */
  duration: number;
  /** `performance.now()` timestamp when the sample was taken. */
  timestamp: number;
}

/** Structured payload accepted by every loader. */
export interface ResourceRequest {
  /** Source URL or path. */
  url: string;
  /** Optional cache key override. */
  key?: string;
  /** Per-request options forwarded to the loader. */
  options?: Record<string, unknown>;
}

/** Perceptual/format metadata describing an uploaded texture. */
export interface ImageInfo {
  width: number;
  height: number;
  /** `true` when the dimensions are powers of two. */
  powerOfTwo: boolean;
}

/** Direction constants shared by layout and controls code. */
export enum Direction {
  Up = 'up',
  Down = 'down',
  Left = 'left',
  Right = 'right',
}

/** 3D axis identifier. */
export enum Axis {
  X = 'x',
  Y = 'y',
  Z = 'z',
}

/** 2D axis identifier. */
export enum Axis2D {
  X = 'x',
  Y = 'y',
}
