/**
 * Command-encoder contract.
 *
 * An encoder records the draw calls a backend will replay. The 2D backends use it
 * as a batching/measurement device (and their immediate-mode painters bypass it);
 * the GPU backends use it to build real command buffers.
 *
 * A single `DrawCommand` value object is used for every draw variant so that
 * render lists, queues and encoders can exchange one predictable shape.
 *
 * @packageDocumentation
 */

import type {
  BlendEquation,
  BlendFactor,
  CullMode,
  CompareFunction,
  GeometryLike,
  ScissorRect,
  ViewportLike,
} from './types';
import { PrimitiveTopology } from './types';
import type { IBuffer } from './IBuffer';
import type { IShader } from './IShader';
import type { ITexture } from './ITexture';

/** A recorded draw call. */
export interface DrawCommand {
  /** Monotonic index assigned by the encoder. */
  readonly index: number;
  /** Geometry to draw, when the call is geometry-driven. */
  readonly geometry: GeometryLike | null;
  /** Number of vertices (or indices) to draw. */
  readonly count: number;
  /** First vertex (or index) to draw. */
  readonly offset: number;
  /** Primitive assembly topology. */
  readonly topology: PrimitiveTopology;
  /** Program to draw with, when the call is shader-driven. */
  readonly shader: IShader | null;
  /** Vertex buffers bound for this call, keyed by attribute name. */
  readonly attributes: Readonly<Record<string, IBuffer>>;
  /** Index buffer bound for this call, when indexed. */
  readonly indexBuffer: IBuffer | null;
  /** Textures bound for this call, keyed by sampler name. */
  readonly textures: Readonly<Record<string, ITexture>>;
  /** Uniform bag applied for this call. */
  readonly uniforms: Readonly<Record<string, unknown>>;
  /** Instance count; `1` for non-instanced calls. */
  readonly instances: number;
  /** Number of triangles the call submits (`0` for non-triangle topologies). */
  readonly triangles: number;
  /** Render order the call was recorded with. */
  readonly renderOrder: number;
  /** Material identifier used by the render queue's secondary sort. */
  readonly materialId: string | number;
  /** Depth value used by the render queue's tertiary sort. */
  readonly depth: number;
}

/** Description accepted by {@link ICommandEncoder.draw}. */
export interface DrawCommandOptions {
  /** Geometry to draw. */
  geometry?: GeometryLike | null;
  /** Number of vertices/indices; defaults to the geometry's extent. */
  count?: number;
  /** First vertex/index; defaults to `0`. */
  offset?: number;
  /** Topology override; defaults to the encoder's current one. */
  topology?: PrimitiveTopology;
  /** Shader to draw with; defaults to the encoder's current program. */
  shader?: IShader | null;
  /** Vertex buffers, keyed by attribute name. */
  attributes?: Record<string, IBuffer>;
  /** Index buffer. */
  index?: IBuffer | null;
  /** Textures, keyed by sampler name. */
  textures?: Record<string, ITexture>;
  /** Uniform bag. */
  uniforms?: Record<string, unknown>;
  /** Instance count. */
  instances?: number;
  /** Render order recorded with the call. */
  renderOrder?: number;
  /** Material identifier recorded with the call. */
  materialId?: string | number;
  /** Depth recorded with the call. */
  depth?: number;
}

/** A recorded state change. */
export interface StateCommand {
  /** Which member of the render state changed. */
  readonly key: string;
  /** Value before the change, when known. */
  readonly previous: unknown;
  /** Value after the change. */
  readonly value: unknown;
}

/** Union of everything an encoder can record. */
export type Command = { readonly kind: 'draw'; readonly draw: DrawCommand } | { readonly kind: 'state'; readonly state: StateCommand };

/** Records draw and state commands for a backend to replay. */
export interface ICommandEncoder {
  /** Identifier, used in diagnostics. */
  readonly id: string;

  /** Commands recorded so far, in submission order. */
  readonly commands: readonly Command[];

  /**
   * Number of commands recorded.
   *
   * Cheap to read in a hot loop, unlike `commands.length` on very long buffers.
   */
  readonly length: number;

  /** `true` while the encoder accepts commands. */
  readonly isRecording: boolean;

  /** Begins a recording pass; commands recorded before this are kept. */
  begin(): void;

  /**
   * Ends the recording pass.
   *
   * @returns The recorded commands.
   */
  end(): readonly Command[];

  /** Discards every recorded command without ending the pass. */
  reset(): void;

  /**
   * Records a draw call.
   *
   * @param options Draw description.
   * @returns The recorded command.
   */
  draw(options?: DrawCommandOptions): DrawCommand;

  /**
   * Records a state change so a replay can reproduce it.
   *
   * @param key State member name (`'cullMode'`, `'depthTest'`, ...).
   * @param value New value.
   * @param previous Previous value, when known.
   */
  setState(key: string, value: unknown, previous?: unknown): void;

  /** Records a viewport change. */
  setViewport(viewport: ViewportLike): void;

  /** Records a scissor change; `null` disables scissoring. */
  setScissor(scissor: ScissorRect | null): void;

  /** Records a cull-mode change. */
  setCullMode(mode: CullMode): void;

  /** Records a depth-test change; `compare` is `null` to disable the test. */
  setDepthTest(compare: CompareFunction | null, write?: boolean): void;

  /** Records a blend-state change; `factors` is `null` to disable blending. */
  setBlend(
    factors: { src: BlendFactor; dst: BlendFactor; equation?: BlendEquation } | null,
    alphaFactors?: { src: BlendFactor; dst: BlendFactor } | null,
  ): void;

  /** Plays the recorded commands back into a backend decoder. */
  flush(): void;
}

/** `true` when `value` satisfies the minimum {@link ICommandEncoder} shape. */
export function isCommandEncoder(value: unknown): value is ICommandEncoder {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value as Partial<ICommandEncoder>;
  return typeof candidate.draw === 'function' && typeof candidate.end === 'function';
}

/** Number of triangles a draw submits, derived from its topology. */
export function triangleCountFor(topology: PrimitiveTopology, count: number): number {
  switch (topology) {
    case PrimitiveTopology.Triangles:
      return Math.floor(count / 3);
    case PrimitiveTopology.TriangleStrip:
    case PrimitiveTopology.TriangleFan:
      return Math.max(0, count - 2);
    default:
      return 0;
  }
}
