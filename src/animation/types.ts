/**
 * Shared type vocabulary for the animation subsystem.
 *
 * The animation layer is deliberately **structural**: a track writes into
 * "anything that has the right property", and a mixer animates "anything that can
 * be traversed by name". That keeps `src/animation` independent of `src/scene`
 * (which is written by another agent) while still accepting `Object3D`, `Bone`
 * and `Skeleton` instances unchanged.
 *
 * @packageDocumentation
 */

import type { EventMap } from '../core/EventEmitter';

/* -------------------------------------------------------------------------- */
/* Time                                                                       */
/* -------------------------------------------------------------------------- */

/** A clock reading, in seconds, plus the mixer's internal direction. */
export interface AnimationTime {
  /** Current time, in seconds. */
  time: number;
  /** Time scale applied to the delta; negative plays backwards. */
  timeScale: number;
}

/** Callback invoked once per {@link IRenderableLike}-style update. */
export type AnimationCallback<TThis = unknown> = (this: TThis, delta: number) => void;

/* -------------------------------------------------------------------------- */
/* Track naming                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A parsed track name.
 *
 * The grammar mirrors three.js exactly:
 *
 * ```
 * objectName.propertyName[subscript].propertyName[subscript]...
 * ```
 *
 * Examples:
 * - `Cube.position` → object `Cube`, path `['position']`
 * - `Cube.material.color.r` → object `Cube`, path `['material', 'color', 'r']`
 * - `SkinnedMesh.morphTargetInfluences[3]` → object, path
 *   `[{ name: 'morphTargetInfluences', index: 3 }]`
 * - `.bones[2].position.x` → object `''` (the mixer root), path
 *   `[{ name: 'bones', index: 2 }, { name: 'position' }, { name: 'x' }]`
 *
 * A leading `.` means "resolve relative to the mixer root". Square brackets only
 * ever appear *after* a property name; `[0]` without a preceding name is a parse
 * error.
 */
export interface ParsedTrackName {
  /** Node name to look up in the mixer root, or `''` for the root itself. */
  nodeName: string;
  /** Property path below the node, from the outside in. */
  objectName: string;
  /** Object name variant kept for three.js compatibility. */
  parsedPath: ParsedPath;
  /** True when the track name started with `.`. */
  relative: boolean;
}

/**
 * One step of a parsed property path.
 *
 * `index` encodes three cases: `-1` means a plain property (no subscript), a
 * non-negative value is the numeric subscript, and `-2`
 * (`NAME_INDEX_SENTINEL` in `PropertyBinding.ts`) means a *named* subscript whose
 * identifier is held in {@link ParsedPathNode.name2}.
 */
export interface ParsedPathNode {
  /** Property name. */
  name: string;
  /** Array subscript: `-1` none, `>= 0` numeric, `-2` named. */
  index: number;
  /** Identifier inside a named subscript, e.g. `hand` in `bones[hand]`. */
  name2?: string;
}

/** The result of parsing the property portion of a track name. */
export interface ParsedPath {
  /** Path steps, from the node downwards. */
  nodes: ParsedPathNode[];
  /** The raw, unparsed track name. */
  original: string;
}

/* -------------------------------------------------------------------------- */
/* Mixing                                                                     */
/* -------------------------------------------------------------------------- */

/** How a track combines its value with the accumulator's current value. */
export type BlendMode = 'normal' | 'additive' | 'override';

/** Interpolation modes understood by {@link KeyframeTrackLike}. */
export type InterpolationType =
  | 'discrete'
  | 'linear'
  | 'smooth'
  | 'spline'
  | 'bezier'
  | 'catmullrom'
  | 'step';

/** Playback direction of an action that reached its end. */
export type LoopMode = 'once' | 'repeat' | 'pingpong';

/** Events emitted by {@link import('./AnimationMixer').AnimationMixer}. */
export interface AnimationMixerEventMap extends EventMap {
  /** A new action was created for a clip. */
  clipActionCreated: [action: unknown];
  /** An action started running. */
  actionStarted: [action: unknown];
  /** An action stopped running. */
  actionStopped: [action: unknown];
  /** The mixer advanced one step. */
  update: [delta: number, time: number];
  /** An action reached the end of a `LoopOnce` clip. */
  finished: [action: unknown];
  /** The mixer was disposed. */
  dispose: [];
}

/** Events emitted by {@link import('./Tween').Tween}. */
export interface TweenEventMap extends EventMap {
  /** The tween left its delay and began interpolating. */
  start: [];
  /** A value was written. */
  update: [progress: number, values: Record<string, number>];
  /** The tween finished all of its repetitions. */
  complete: [];
  /** The tween stopped before completing. */
  stop: [];
  /** The tween repeated. */
  repeat: [iteration: number];
  /** A yoyo leg reversed direction. */
  yoyo: [leg: number];
}

/** Events emitted by {@link import('./Timeline').Timeline}. */
export interface TimelineEventMap extends EventMap {
  /** Playback started. */
  play: [];
  /** Playback paused. */
  pause: [];
  /** The playhead moved to a new time. */
  seek: [time: number];
  /** The playhead passed a label. */
  label: [name: string, time: number];
  /** The timeline reached its end. */
  complete: [];
  /** The label set changed. */
  labelsChanged: [];
}

/* -------------------------------------------------------------------------- */
/* Structural views                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Anything a track can drive.
 *
 * `Object3D` and `Bone` both satisfy this. The mixer never assumes a base class:
 * it only ever walks `parent`/`children`/`name` and hands property paths to
 * {@link import('./PropertyBinding').PropertyBinding}.
 */
export interface Object3DLike {
  /** Node name, used by the track-name grammar. */
  name?: string;
  /** Parent node, used for upward name searches. */
  parent?: Object3DLike | null;
  /** Child nodes, used for downward name searches. */
  children?: readonly Object3DLike[];
  /** `false` removes the node from every search. */
  visible?: boolean;
  /** Arbitrary property bag the tracks index into. */
  [property: string]: unknown;
}

/**
 * Structural view of a `BufferGeometry`-derived object.
 *
 * Only the attributes the animation layer reads are declared, which keeps this
 * module free of a geometry import.
 */
export interface GeometryLike {
  /** Vertex attributes, keyed by name. */
  attributes?: Record<string, { array: ArrayLike<number>; itemSize: number; count?: number } | undefined>;
  /** Morph-target attributes, keyed by target name. */
  morphAttributes?: Record<string, { array: ArrayLike<number>; itemSize: number; count?: number }[]>;
  /** `true` when the geometry has an index buffer. */
  indexed?: boolean;
  /** Releases GPU resources. */
  dispose?(): void;
}

/** Structural view of a morph-target-bearing mesh. */
export interface MorphTargetLike {
  /** Per-target weights written by a `morphTargetInfluences` track. */
  morphTargetInfluences?: number[];
  /** Name → index map for `morphTargetDictionary` bindings. */
  morphTargetDictionary?: Record<string, number>;
  /** Geometry that carries the morph attributes. */
  geometry?: GeometryLike | null;
}

/** Structural view of a skinned mesh. */
export interface SkinnedLike {
  /** Bone list written by a `bones[...]` binding. */
  skeleton?: { bones?: unknown[] } | null;
  /** Direct bone array, accepted when `skeleton` is absent. */
  bones?: unknown[];
}

/**
 * Anything the mixer can be rooted at.
 *
 * Identical to {@link Object3DLike}; the alias exists so mixer signatures read as
 * "the thing being animated".
 */
export type RootObject = Object3DLike;

/* -------------------------------------------------------------------------- */
/* Serialisation                                                              */
/* -------------------------------------------------------------------------- */

/** Options accepted by `AnimationClip.toJSON` and the `KeyframeTrack` serialisers. */
export interface TrackJSON {
  /** Concrete track class name, e.g. `'VectorKeyframeTrack'`. */
  type: string;
  /** Track name in the `objectName.propertyName[subscript]` grammar. */
  name: string;
  /** Keyframe times, in seconds. */
  times: number[];
  /** Flattened keyframe values. */
  values: number[];
  /** Component count per keyframe. */
  valueSize: number;
  /** Interpolation mode name. */
  interpolation?: string;
}

/** JSON representation of an {@link import('./AnimationClip').AnimationClip}. */
export interface AnimationClipJSON {
  /** Serialisation metadata. */
  metadata?: { version: number; generator: string };
  /** Friendly clip name. */
  name: string;
  /** Clip duration in seconds. */
  duration: number;
  /** Clip identifier. */
  uuid?: string;
  /** Serialised tracks. */
  tracks: TrackJSON[];
  /** Blend mode applied to every track. */
  blendMode?: string;
}

/** Close-up description of an action, used by debug overlays. */
export interface ActionSnapshot {
  /** Clip the action plays. */
  clipName: string;
  /** `true` while the action is time-advancing. */
  running: boolean;
  /** Effective weight in `[0, 1]`. */
  weight: number;
  /** Current time inside the clip, in seconds. */
  time: number;
  /** Playback rate. */
  timeScale: number;
  /** Number of completed repetitions. */
  repetitions: number;
  /** `true` when the action's weight is being faded. */
  fading: boolean;
}

/** Version stamped into serialised animation data. */
export const ANIMATION_JSON_VERSION = 1;

/** Generator name stamped into serialised animation data. */
export const ANIMATION_JSON_GENERATOR = '@dxyl/graphics';
