/**
 * `CoreEventMap` — the single event map shared by every scene-graph object.
 *
 * The library uses one superset event map instead of a per-class generic. That is
 * deliberate:
 *
 *  - `emit('resize', w, h)` stays **fully type-checked** — a wrong name or a
 *    wrong arity is a compile error;
 *  - subclasses can add events without re-declaring the inherited ones;
 *  - there is no generic parameter to thread through `Node`/`Scene`/`Camera`,
 *    `add`/`remove`/`clone`, or the structural interfaces the renderer uses;
 *  - an object that listens for an event it can never receive is harmless.
 *
 * The trade-off is that `node.on('resize', ...)` type-checks even on a plain
 * `Node`. That is preferred here because the alternative (a generic parameter per
 * class) breaks assignability between nodes of different families, which is
 * exactly what a heterogeneous scene graph needs.
 *
 * @packageDocumentation
 */

import type { Layer } from './Layer';
import type { Scene } from './Scene';

/** Events available on every object in the graph. */
export interface CoreEvents {
  /* --- graph structure ---------------------------------------------------- */

  /** A child was attached. */
  added: [parent: unknown, child: unknown];
  /** A child was removed. */
  removed: [parent: unknown, child: unknown];
  /** A child was attached to an ancestor, anywhere in this subtree. */
  descendantadded: [parent: unknown, child: unknown];
  /** A child was removed from an ancestor, anywhere in this subtree. */
  descendantremoved: [parent: unknown, child: unknown];
  /** `visible` changed. */
  visibilitychange: [visible: boolean];
  /** A layer bit was enabled or disabled. */
  layerchange: [layer: Layer | number, enabled: boolean];

  /* --- transforms --------------------------------------------------------- */

  /** The local matrix is stale after a position/rotation/scale change. */
  matrixchanged: [];
  /** The world matrix was recomputed. */
  worldmatrixchanged: [];
  /** The transform was replaced wholesale. */
  transformchange: [];

  /* --- lifecycle ---------------------------------------------------------- */

  /** The object is about to be released. */
  dispose: [];
  /** The object has been released. */
  disposed: [];

  /* --- update loop -------------------------------------------------------- */

  /** The object started receiving updates. */
  updateenabled: [];
  /** The object stopped receiving updates. */
  updatedisabled: [];

  /* --- camera ------------------------------------------------------------- */

  /** The projection matrix was rebuilt. */
  projectionchange: [];
  /** The viewport size changed. */
  viewportchange: [width: number, height: number];
  /** The camera was activated on a renderer. */
  cameraactivated: [];
  /** The camera was deactivated on a renderer. */
  cameradeactivated: [];

  /* --- scene -------------------------------------------------------------- */

  /** The scene graph changed structurally. */
  change: [];
  /** One full `updateMatrixWorld` pass finished. */
  update: [];
  /** The background, fog or environment changed. */
  environmentchange: [];
  /** The scene's computed bounds were refreshed. */
  boundschange: [];

  /* --- renderer ----------------------------------------------------------- */

  /** A backend was selected or lost. */
  backendchange: [backend: string];
  /** The render target changed. */
  targetchange: [];
  /** The GPU context was lost. */
  contextlost: [];
  /** The GPU context was restored. */
  contextrestored: [];
  /** A shader finished compiling. */
  shadercompiled: [key: string, durationMs: number];

  /* --- geometry / buffers ------------------------------------------------- */

  /** An attribute's data or layout changed. */
  attributemodified: [name: string];
  /** The index buffer changed. */
  indexmodified: [];
  /** A GPU buffer was (re)uploaded. */
  bufferupload: [bytes: number];
  /** A geometry's bounds were recomputed. */
  boundsrecomputed: [];

  /* --- textures / assets -------------------------------------------------- */

  /** An image or video texture finished loading. */
  textureloaded: [];
  /** A texture failed to load. */
  textureerror: [error: Error];
  /** A texture upload completed. */
  textureupload: [bytes: number];
  /** An asset finished loading. */
  assetloaded: [url: string];
  /** An asset failed to load. */
  asseterror: [url: string, error: Error];
  /** Progress of a batch load, in `[0, 1]`. */
  loadprogress: [loaded: number, total: number];

  /* --- animation ---------------------------------------------------------- */

  /** An animation action started. */
  animationstart: [];
  /** An animation action finished. */
  animationfinish: [];
  /** An animation loop wrapped around. */
  animationloop: [count: number];
  /** A keyframe track was updated. */
  trackupdate: [name: string, time: number];

  /* --- interaction -------------------------------------------------------- */

  /** A pointer entered the object. */
  pointerenter: [x: number, y: number];
  /** A pointer left the object. */
  pointerleave: [x: number, y: number];
  /** A pointer pressed on the object. */
  pointerdown: [x: number, y: number];
  /** A pointer released on the object. */
  pointerup: [x: number, y: number];
  /** A pointer moved while over the object. */
  pointermove: [x: number, y: number];
  /** The object was clicked or tapped. */
  click: [x: number, y: number];
  /** The object was hovered by a picking pass. */
  hover: [x: number, y: number];
  /** A drag gesture progressed. */
  drag: [dx: number, dy: number];
  /** Two-finger pinch progressed. */
  pinch: [scale: number];
  /** Controls finished moving the camera. */
  controlschange: [];

  /* --- text --------------------------------------------------------------- */

  /** A glyph was added to an atlas. */
  glyphadded: [character: string];
  /** Text layout was recomputed. */
  layoutchange: [width: number, height: number];
}

/** The complete event map: every event any graph object can emit. */
export type CoreEventMap = CoreEvents;

/**
 * A cached snapshot of a scene's structure.
 *
 * Emitted with the `change` event when the caller wants to avoid re-traversing.
 */
export interface SceneChangeDetail {
  scene: Scene;
  kind: 'added' | 'removed' | 'visible' | 'layers' | 'environment';
  target: unknown;
}
