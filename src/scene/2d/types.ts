/**
 * Shared type vocabulary for the 2D scene graph.
 *
 * The renderer and text layers are written by other agents in parallel with
 * this one, so nothing here imports them: every cross-layer dependency is
 * expressed as a structural interface ({@link Painter2D}, {@link Texture2DLike},
 * ...) which keeps `src/scene` compiling on its own and stays assignable from
 * the concrete classes once they exist.
 *
 * @packageDocumentation
 */

import type { Mat4 } from '../../math/Mat4';
import type { Rect } from '../../math/Rect';
import type { Vec2 } from '../../math/Vec2';
import type { Node2D } from './Node2D';
import type { Vector2Like } from '../3d/types';

/* -------------------------------------------------------------------------- */
/* Compositing                                                                */
/* -------------------------------------------------------------------------- */

/** Compositing operation applied when a node is drawn. */
export type BlendMode2D =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'
  | 'add'
  | 'subtract';

/** Every blend mode, useful for validation and tooling. */
export const BLEND_MODES_2D: readonly BlendMode2D[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'add',
  'subtract',
];

/** `true` when `value` is one of the supported 2D blend modes. */
export function isBlendMode2D(value: unknown): value is BlendMode2D {
  return typeof value === 'string' && (BLEND_MODES_2D as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Renderer + asset contracts                                                 */
/* -------------------------------------------------------------------------- */

/** Structural view of the renderer a `render(painter)` callback receives. */
export interface Painter2D {
  /** Current global alpha, as set by the scene walker. */
  readonly alpha?: number;
  /** Applies a transform; the painter owns the stack. */
  save?(): void;
  /** Restores the previous transform. */
  restore?(): void;
  /** Multiplies the transform by a column-major 4x4 matrix. */
  transform?(matrix: Mat4): void;
  /** Sets the current compositing operation. */
  setBlendMode?(mode: BlendMode2D): void;
  /** Fills the current path. */
  fill?(): void;
  /** Strokes the current path. */
  stroke?(): void;
  /** Begins a path. */
  beginPath?(): void;
  /** Closes the current path. */
  closePath?(): void;
  /** Moves the current point. */
  moveTo?(x: number, y: number): void;
  /** Adds a line to the current point. */
  lineTo?(x: number, y: number): void;
  /** Adds a quadratic curve. */
  quadraticCurveTo?(cx: number, cy: number, x: number, y: number): void;
  /** Adds a cubic curve. */
  bezierCurveTo?(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number,
  ): void;
  /** Adds a circular arc. */
  arc?(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterClockwise?: boolean,
  ): void;
  /** Draws an axis-aligned rectangle. */
  rect?(x: number, y: number, width: number, height: number): void;
  /** Draws a rounded rectangle. */
  roundRect?(x: number, y: number, width: number, height: number, radii: number): void;
  /** Draws an image with an optional source rectangle. */
  drawImage?(image: unknown, x: number, y: number, width: number, height: number): void;
  /** Draws a text string. */
  fillText?(text: string, x: number, y: number): void;
  /** Measures a text string, in device pixels. */
  measureText?(text: string): { width: number; height?: number; ascent?: number };
}

/** Structural view of a 2D texture (image, canvas, atlas region, ...). */
export interface Texture2DLike {
  /** Source image the backend can draw. */
  readonly image?: unknown;
  /** Natural width, when the texture reports one. */
  readonly width?: number;
  /** Natural height, when the texture reports one. */
  readonly height?: number;
  /** Releases GPU-side resources; implemented by `Texture`. */
  dispose?(): void;
}

/** Structural view of a 2D material. */
export interface Material2DLike {
  /** `false` skips the node while rendering. */
  visible?: boolean;
  /** Multiplied with the node's alpha. */
  opacity?: number;
  /** Colour, in a form the backend understands. */
  color?: unknown;
  /** Releases GPU-side resources. */
  dispose?(): void;
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

/** A path segment accepted by `Path2DObject` and `Shape2D`. */
export type PathSegment2D =
  | { type: 'move'; x: number; y: number }
  | { type: 'line'; x: number; y: number }
  | { type: 'quadratic'; cx: number; cy: number; x: number; y: number }
  | { type: 'cubic'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }
  | { type: 'arc'; x: number; y: number; radius: number; startAngle?: number; endAngle?: number }
  | { type: 'close' };

/** Stroke description shared by the vector shape nodes. */
export interface StrokeStyle2D {
  /** Stroke colour in a backend-specific form. */
  color?: unknown;
  /** Stroke width in local units. */
  width?: number;
  /** Line cap style (`'butt'`, `'round'`, `'square'`). */
  cap?: string;
  /** Line join style (`'miter'`, `'round'`, `'bevel'`). */
  join?: string;
  /** Dash pattern, in local units. */
  dash?: readonly number[];
  /** Miter limit for `'miter'` joins. */
  miterLimit?: number;
  /** Skips the stroke when `false`. */
  enabled?: boolean;
}

/** Fill description shared by the vector shape nodes. */
export interface FillStyle2D {
  /** Fill colour in a backend-specific form. */
  color?: unknown;
  /** Even-odd winding rule when `true`. */
  evenOdd?: boolean;
  /** Skips the fill when `false`. */
  enabled?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Node configuration                                                         */
/* -------------------------------------------------------------------------- */

/** Options accepted by every 2D node constructor. */
export interface Node2DOptions {
  /** Human-readable name; defaults to `''`. */
  name?: string;
  /** X position in the parent's coordinate space. */
  x?: number;
  /** Y position in the parent's coordinate space. */
  y?: number;
  /** Rotation in radians, clockwise because Y points down. */
  rotation?: number;
  /** Horizontal scale. */
  scaleX?: number;
  /** Vertical scale. */
  scaleY?: number;
  /** Draw order within the parent. */
  zIndex?: number;
  /** Opacity in `[0, 1]`. */
  alpha?: number;
  /** Compositing operation. */
  blendMode?: BlendMode2D;
  /** Skips this subtree while rendering when `false`. */
  visible?: boolean;
  /** Enables hit testing for this node. */
  interactive?: boolean;
  /** Rotation/scale origin, in local units. */
  pivot?: Vec2;
  /** Shear applied before rotation. */
  skew?: Vec2;
  /** Explicit local bounds; computed from children when omitted. */
  bounds?: Rect | null;
  /** Plain payload carried by the node. */
  userData?: Record<string, unknown>;
}

/** Options accepted by the `hitTest` helpers. */
export interface HitTestOptions {
  /** Ignores {@link Node2D.interactive} and tests every node. */
  includeNonInteractive?: boolean;
  /** Pixels of slack added around the bounds. */
  tolerance?: number;
  /** Includes cached child bounds when a node has no bounds of its own. */
  includeChildren?: boolean;
}

/** Options accepted by `Scene2D`. */
export interface Scene2DOptions extends Node2DOptions {
  /** Clear colour: hex integer, CSS string, or `null` to leave the canvas as-is. */
  background?: number | string | null;
  /** Active camera, or `null` to use the identity transform. */
  camera?: unknown;
  /** `true` to keep rendering while the document is hidden. */
  autoResize?: boolean;
}

/** Options accepted by `Layer2D`. */
export interface Layer2DOptions extends Node2DOptions {
  /** Layer name; also used as the lookup key on the scene. */
  name?: string;
  /** Scales the layer with the scene camera when `true`. */
  cameraScale?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                              */
/* -------------------------------------------------------------------------- */

/** JSON representation produced by {@link Node2D.toJSON}. */
export interface Node2DJson {
  /** Serialisation metadata (`{ version, generator }`). */
  metadata: { version: number; generator: string };
  /** Class name of the serialised node. */
  type: string;
  /** Stable identifier. */
  id: string;
  /** Name of the node. */
  name: string;
  /** Flat transform fields. */
  x: number;
  /** Y position. */
  y: number;
  /** Rotation in radians. */
  rotation: number;
  /** Horizontal scale. */
  scaleX: number;
  /** Vertical scale. */
  scaleY: number;
  /** Draw order. */
  zIndex: number;
  /** Opacity in `[0, 1]`. */
  alpha: number;
  /** Compositing operation. */
  blendMode: BlendMode2D;
  /** Visibility flag. */
  visible: boolean;
  /** Interaction flag. */
  interactive: boolean;
  /** Pivot, in local units. */
  pivot: { x: number; y: number };
  /** Skew, in radians. */
  skew: { x: number; y: number };
  /** Local matrix, column-major. */
  matrix: number[];
  /** Serialised children. */
  children?: Node2DJson[];
  /** Free-form payload. */
  userData?: Record<string, unknown>;
  /** Backend-specific extras added by subclasses. */
  [key: string]: unknown;
}

/** Version stamped into {@link Node2DJson.metadata}. */
export const SCENE2D_JSON_VERSION = 1;

/** Generator name stamped into {@link Node2DJson.metadata}. */
export const SCENE2D_JSON_GENERATOR = '@dxyl/graphics';

/** Node accepted by the 2D traversal helpers. */
export type Node2DLike = Node2D;

/** Re-exported so 2D consumers get the pair type from one import. */
export type { Vector2Like };
