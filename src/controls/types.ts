/**
 * Shared type vocabulary for the controls subsystem.
 *
 * Controls sit between a **DOM event source** and a **camera-like object**, and both
 * sides are described structurally here so that:
 *
 * - a unit test can drive a control with a hand-built fake `EventTarget` and a plain
 *   `{ position, quaternion, up }` object, with no DOM and no renderer, and
 * - a control can be attached to any host because it only ever reads the handful of
 *   event fields it actually needs.
 *
 * ## Why the event types are structural
 *
 * Using the real DOM types would make every control untestable outside a browser
 * (constructing a `PointerEvent` needs a DOM). Declaring only the fields the code
 * reads — `clientX`, `pointerId`, `deltaY`, `touches`, ... — means a test passes
 * `{ type: 'pointerdown', clientX: 10, clientY: 20, pointerId: 1, ... }` and the
 * control cannot tell the difference.
 *
 * @packageDocumentation
 */

import type { EventMap } from '../core/EventEmitter';
import type { Quat } from '../math/Quat';
import type { Vec2 } from '../math/Vec2';
import type { Vec3 } from '../math/Vec3';

/* -------------------------------------------------------------------------- */
/* DOM contracts                                                              */
/* -------------------------------------------------------------------------- */

/** A listener as accepted by `EventTarget.addEventListener`. */
export type DomListener = (event: never) => void;

/**
 * The `EventTarget` subset every control uses.
 *
 * `DOMEventTarget` satisfies this; so does a ten-line fake.
 */
export interface EventTargetLike {
  /** Registers a listener. */
  addEventListener(
    type: string,
    listener: (event: never) => void,
    options?: boolean | { capture?: boolean; passive?: boolean; once?: boolean },
  ): void;
  /** Removes a listener. */
  removeEventListener(
    type: string,
    listener: (event: never) => void,
    options?: boolean | { capture?: boolean },
  ): void;
}

/** Fields shared by every pointer-derived event. */
export interface PointerEventLike {
  /** X in CSS pixels, relative to the viewport. */
  clientX: number;
  /** Y in CSS pixels, relative to the viewport. */
  clientY: number;
  /** X in CSS pixels, relative to the document. */
  pageX?: number;
  /** Y in CSS pixels, relative to the document. */
  pageY?: number;
  /** Pointer identifier; unique while the pointer is down. */
  pointerId?: number;
  /** `'mouse'`, `'pen'`, `'touch'`, or `''`. */
  pointerType?: string;
  /** Button that changed state: `0` left, `1` middle, `2` right. */
  button?: number;
  /** Buttons currently held, as a bitmask. */
  buttons?: number;
  /** `1` for a wheel notch; see {@link WheelEventLike.deltaMode}. */
  detail?: number;
  /** Wheel delta along X. */
  deltaX?: number;
  /** Wheel delta along Y. */
  deltaY?: number;
  /** `0` pixels, `1` lines, `2` pages. */
  deltaMode?: number;
  /** `true` when the control key was held. */
  ctrlKey?: boolean;
  /** `true` when the shift key was held. */
  shiftKey?: boolean;
  /** `true` when the alt key was held. */
  altKey?: boolean;
  /** `true` when the meta/command key was held. */
  metaKey?: boolean;
  /** Mouse button for a legacy `mousedown`/`mouseup`/`mousemove`. */
  which?: number;
  /** Movement along X since the previous event, in CSS pixels. */
  movementX?: number;
  /** Movement along Y since the previous event, in CSS pixels. */
  movementY?: number;
  /** The element the event was dispatched on. */
  target?: unknown;
  /** The element the listener is attached to. */
  currentTarget?: unknown;
  /** Cancels the event's default behaviour, when the host supports it. */
  preventDefault?(): void;
  /** Stops the event propagating, when the host supports it. */
  stopPropagation?(): void;
  /** `true` when `preventDefault` was called. */
  defaultPrevented?: boolean;
}

/** A wheel event, which adds deltas to the pointer fields. */
export type WheelEventLike = PointerEventLike;

/** A keyboard event. */
export interface KeyEventLike {
  /** `'keydown'` or `'keyup'`. */
  type?: string;
  /** `KeyboardEvent.code`-style physical key name (`'KeyW'`, `'ArrowUp'`). */
  code?: string;
  /** `KeyboardEvent.key`-style logical key name (`'w'`, `'ArrowUp'`). */
  key?: string;
  /** `true` when the control key was held. */
  ctrlKey?: boolean;
  /** `true` when the shift key was held. */
  shiftKey?: boolean;
  /** `true` when the alt key was held. */
  altKey?: boolean;
  /** `true` when the meta/command key was held. */
  metaKey?: boolean;
  /** Cancels the event's default behaviour. */
  preventDefault?(): void;
  /** Stops the event propagating. */
  stopPropagation?(): void;
}

/** One touch contact point. */
export interface TouchLike {
  /** Stable identifier for the duration of the touch. */
  identifier: number;
  /** X in CSS pixels relative to the viewport. */
  clientX: number;
  /** Y in CSS pixels relative to the viewport. */
  clientY: number;
  /** X in CSS pixels relative to the document. */
  pageX?: number;
  /** Y in CSS pixels relative to the document. */
  pageY?: number;
  /** Radius of the contact area along X, when reported. */
  radiusX?: number;
  /** Radius of the contact area along Y, when reported. */
  radiusY?: number;
  /** Contact force in `[0, 1]`, when reported. */
  force?: number;
  /** The element the touch started on. */
  target?: unknown;
}

/** A touch list; array-like and iterable. */
export interface TouchListLike {
  /** Number of contacts. */
  readonly length: number;
  /** Contact at `index`. */
  item(index: number): TouchLike | null;
  /** Indexed access. */
  [index: number]: TouchLike;
}

/** A touch event. */
export interface TouchEventLike {
  /** All contacts currently on the surface. */
  touches: TouchListLike;
  /** Contacts that changed in this event. */
  changedTouches: TouchListLike;
  /** `true` when the control key was held. */
  ctrlKey?: boolean;
  /** `true` when the shift key was held. */
  shiftKey?: boolean;
  /** `true` when the alt key was held. */
  altKey?: boolean;
  /** `true` when the meta/command key was held. */
  metaKey?: boolean;
  /** Cancels the event's default behaviour. */
  preventDefault?(): void;
  /** Stops the event propagating. */
  stopPropagation?(): void;
}

/* -------------------------------------------------------------------------- */
/* Camera/object contracts                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The object a camera control drives.
 *
 * `Object3D`, `Camera3D`, `PerspectiveCamera` and `Node` all satisfy this shape; the
 * optional members are what a control uses when it wants look-at behaviour instead of
 * writing the quaternion directly.
 */
export interface ControlsObjectLike {
  /** Local position; always present on every node in this library. */
  position: Vec3;
  /** Local rotation as a quaternion. */
  quaternion: Quat;
  /** Up vector; defaults to `+Y`. */
  up?: Vec3;
  /** `true` for a camera, which looks down `-Z`. */
  readonly isCamera?: boolean;
  /** Points the object at a target. */
  lookAt?(target: Vec3 | number, y?: number, z?: number): unknown;
  /** Recomputes the local matrix. */
  updateMatrix?(): unknown;
  /** Recomputes the world matrix. */
  updateMatrixWorld?(force?: boolean): unknown;
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Events every control publishes.
 *
 * Extends {@link EventMap} so it can be used as the bus type of an `EventEmitter`
 * without a constraint problem, and so concrete maps can extend it.
 */
export interface ControlsEventMap extends EventMap {
  /** The controlled state changed; the delta describes what moved. */
  change: [delta: ChangeDelta];
  /** A drag/zoom/pan interaction began. */
  changeStart: [delta: ChangeDelta];
  /** An interaction ended. */
  changeEnd: [delta: ChangeDelta];
  /** The control was connected to an element. */
  connect: [element: EventTargetLike];
  /** The control was disconnected. */
  disconnect: [];
  /** The control was reset to its saved state. */
  reset: [];
}

/** What changed during one control update. */
export interface ChangeDelta {
  /** `true` when the camera rotated. */
  rotated: boolean;
  /** `true` when the camera panned. */
  panned: boolean;
  /** `true` when the camera zoomed (distance changed). */
  zoomed: boolean;
  /** Change in azimuth, in radians. */
  azimuth: number;
  /** Change in polar angle, in radians. */
  polar: number;
  /** Change in distance. */
  distance: number;
}

/** A fresh, all-false {@link ChangeDelta}. */
export function createChangeDelta(): ChangeDelta {
  return { rotated: false, panned: false, zoomed: false, azimuth: 0, polar: 0, distance: 0 };
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/** Mouse button roles an orbit-style control understands. */
export const MouseAction = {
  /** No action. */
  None: -1,
  /** Rotate the camera. */
  Rotate: 0,
  /** Pan the target. */
  Pan: 1,
  /** Dolly in and out. */
  Zoom: 2,
} as const;

/** Union of the {@link MouseAction} values. */
export type MouseActionValue = (typeof MouseAction)[keyof typeof MouseAction];

/** Constructor options shared by every control. */
export interface ControlsOptions {
  /** Element to attach to; can also be supplied later with `connect`. */
  domElement?: EventTargetLike | null;
  /** Initial `enabled` flag; defaults to `true`. */
  enabled?: boolean;
  /** Initial damping flag; defaults to `false`. */
  enableDamping?: boolean;
  /** Damping factor in `[0, 1]`; defaults to `0.05`. */
  dampingFactor?: number;
  /** Initial target; defaults to the origin. */
  target?: Vec3;
  /** Prevent the browser default for every handled event; defaults to `true`. */
  preventDefault?: boolean;
}

/** Geometric state a spherical camera control works in. */
export interface SphericalState {
  /** Distance from the target. */
  radius: number;
  /** Angle from `+Y`, in radians. */
  phi: number;
  /** Angle around `+Y`, in radians. */
  theta: number;
}

/** A saved control state, produced by `saveState`. */
export interface ControlsState {
  /** Controlled object's position at save time. */
  position: [number, number, number];
  /** Controlled object's quaternion at save time. */
  quaternion: [number, number, number, number];
  /** Target at save time. */
  target: [number, number, number];
  /** Spherical coordinates at save time, for orbit-style controls. */
  spherical?: SphericalState;
}

/** A pointer's tracked state inside a multi-pointer control. */
export interface PointerState {
  /** Pointer identifier. */
  id: number;
  /** `'mouse'`, `'pen'` or `'touch'`. */
  type: string;
  /** Whether the pointer is currently down. */
  down: boolean;
  /** Start position, in CSS pixels. */
  start: Vec2;
  /** Latest position, in CSS pixels. */
  current: Vec2;
  /** Previous position, in CSS pixels. */
  previous: Vec2;
  /** Total movement since press, in CSS pixels. */
  movement: number;
  /** Milliseconds since the press. */
  duration: number;
  /** Button that started the press. */
  button: number;
  /** The element that captured the pointer, when capture was used. */
  captureTarget?: unknown;
}

/** Swipe direction names used by `TouchControls`. */
export type SwipeDirection = 'left' | 'right' | 'up' | 'down';

/** A detected gesture, reported by `TouchControls` and `GestureControls`. */
export interface GestureInfo {
  /** Gesture name. */
  type:
    | 'tap'
    | 'doubletap'
    | 'longpress'
    | 'swipe'
    | 'pinch'
    | 'rotate'
    | 'pan'
    | 'press'
    | 'release';
  /** Position of the gesture's centroid, in CSS pixels. */
  position: Vec2;
  /** Swipe direction, when the gesture is a swipe. */
  direction?: SwipeDirection;
  /** Swipe speed in pixels per millisecond. */
  velocity?: number;
  /** Pinch scale factor, when the gesture is a pinch. */
  scale?: number;
  /** Rotation in radians, when the gesture is a rotation. */
  rotation?: number;
  /** Translation in pixels, when the gesture is a pan. */
  translation?: Vec2;
  /** Number of pointers involved. */
  pointerCount: number;
  /** Event that produced the gesture, for `preventDefault`. */
  source?: TouchEventLike | PointerEventLike;
}
