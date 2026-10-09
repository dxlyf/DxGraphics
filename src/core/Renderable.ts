/**
 * `Renderable` — the render-queue participation contract.
 *
 * A renderable contributes itself to a `RenderList`, declares how it should be
 * sorted, and answers a few questions the renderer needs before issuing a draw
 * call (which material, which geometry, whether it is ready).
 *
 * Nothing here imports a renderer: `Renderable` is pure metadata, so a node can
 * describe itself without pulling the whole renderer into its module graph.
 *
 * @packageDocumentation
 */

import { Layers } from './Layer';

/** How a renderable should be sorted within the render queue. */
export enum RenderSort {
  /** Sort by material id, then by distance. The default for opaque geometry. */
  Material = 'material',
  /** Sort back-to-front by distance from the camera. Used for transparency. */
  DistanceDescending = 'distance-descending',
  /** Sort front-to-back by distance. Used to maximise early-Z rejection. */
  DistanceAscending = 'distance-ascending',
  /** Sort only by {@link Renderable.renderOrder}, preserving insertion order. */
  Stable = 'stable',
  /** Sort by program id, then material id (minimises state changes). */
  Program = 'program',
}

/** Which render group a draw belongs to. */
export enum RenderGroup {
  /** Opaque geometry, drawn first with depth writes enabled. */
  Opaque = 'opaque',
  /** Transparent geometry, drawn after opaque with blending. */
  Transparent = 'transparent',
  /** Content drawn before everything (backgrounds, skyboxes). */
  Background = 'background',
  /** Content drawn after everything (overlays, UI). */
  Overlay = 'overlay',
}

/** Metadata a renderable exposes to the render queue. */
export interface RenderableInfo {
  /** Bitmask used by `Layer` filtering. */
  layers: number;
  /** Draw order hint; higher values draw later within the same group. */
  renderOrder: number;
  /** Which group to place the draw in. */
  renderGroup: RenderGroup;
  /** How to sort within the group. */
  sortMode: RenderSort;
  /** `true` when the material uses alpha blending. */
  transparent: boolean;
  /** `true` when the object writes to the depth buffer. */
  depthWrite: boolean;
  /** `true` when the object should appear in shadow maps. */
  castShadow: boolean;
  /** `true` when the object should receive shadows. */
  receiveShadow: boolean;
  /** `true` to disable frustum culling for this object. */
  frustumCulled: boolean;
}

/** Anything that can be submitted to a render queue. */
export interface IRenderable {
  /** `false` to skip the object entirely. */
  visible: boolean;
  /** Draw order hint; higher values draw later. */
  renderOrder: number;
  /** Layer mask tested against the camera's. */
  layers: { mask: number; test(other: { mask: number }): boolean };
  /** Group this draw belongs to. */
  renderGroup: RenderGroup;
  /** Sorting mode for this draw. */
  sortMode: RenderSort;
  /** `true` when the object can be skipped outside the view frustum. */
  frustumCulled: boolean;
  /** Stable key used to group draws that share state. */
  readonly renderId: string;
}

/**
 * Default {@link RenderableInfo} values, shared so every renderable starts from
 * the same baseline instead of re-declaring the same literals.
 */
export const DEFAULT_RENDERABLE_INFO: RenderableInfo = {
  layers: 1,
  renderOrder: 0,
  renderGroup: RenderGroup.Opaque,
  sortMode: RenderSort.Material,
  transparent: false,
  depthWrite: true,
  castShadow: false,
  receiveShadow: false,
  frustumCulled: true,
};

/**
 * Mixin that adds the render-queue members to a class.
 *
 * ```ts
 * class MyMesh extends withRenderable(EventDispatcher) {}
 * const mesh = new MyMesh();
 * mesh.renderOrder = 5;
 * mesh.renderGroup = RenderGroup.Overlay;
 * ```
 */
export function withRenderable<TBase extends abstract new (...args: any[]) => object>(
  Base: TBase,
): TBase & (abstract new (...args: any[]) => IRenderable) {
  abstract class WithRenderable extends (Base as abstract new (...args: any[]) => object) {
    /** `false` to skip the object entirely. */
    public visible = true;

    /** Draw order hint; higher values draw later. */
    public renderOrder = 0;

    /** Layer mask; defaults to bit 0. */
    public layers = new Layers();

    /** Render group for this draw. */
    public renderGroup: RenderGroup = RenderGroup.Opaque;

    /** Sort mode for this draw. */
    public sortMode: RenderSort = RenderSort.Material;

    /** `true` when the object can be culled by the view frustum. */
    public frustumCulled = true;

    /** Stable identity used to group draws that share state. */
    public get renderId(): string {
      const self = this as unknown as { __renderId?: string };
      if (!self.__renderId) {
        self.__renderId = `r${renderIdCounter++}`;
      }
      return self.__renderId;
    }
  }
  return WithRenderable as unknown as TBase & (abstract new (...args: any[]) => IRenderable);
}

/** Monotonic counter backing the `renderId` getter installed by {@link withRenderable}. */
let renderIdCounter = 0;

/**
 * Builds the {@link RenderableInfo} for an object.
 *
 * Missing fields fall back to {@link DEFAULT_RENDERABLE_INFO}; `transparent` is
 * inferred from `renderGroup` when the caller does not supply it explicitly.
 */
export function describeRenderable(
  source: Partial<RenderableInfo> & { transparent?: boolean } = {},
): RenderableInfo {
  const group = source.renderGroup ?? DEFAULT_RENDERABLE_INFO.renderGroup;
  return {
    layers: source.layers ?? DEFAULT_RENDERABLE_INFO.layers,
    renderOrder: source.renderOrder ?? DEFAULT_RENDERABLE_INFO.renderOrder,
    renderGroup: group,
    sortMode:
      source.sortMode ??
      (group === RenderGroup.Transparent
        ? RenderSort.DistanceDescending
        : DEFAULT_RENDERABLE_INFO.sortMode),
    transparent: source.transparent ?? group === RenderGroup.Transparent,
    depthWrite: source.depthWrite ?? group !== RenderGroup.Transparent,
    castShadow: source.castShadow ?? DEFAULT_RENDERABLE_INFO.castShadow,
    receiveShadow: source.receiveShadow ?? DEFAULT_RENDERABLE_INFO.receiveShadow,
    frustumCulled: source.frustumCulled ?? DEFAULT_RENDERABLE_INFO.frustumCulled,
  };
}

/** Comparator implementing a {@link RenderSort}. */
export function createRenderComparator(
  mode: RenderSort,
): (a: { renderOrder: number; renderId: string; distance: number; materialId?: number; programId?: number }, b: {
  renderOrder: number;
  renderId: string;
  distance: number;
  materialId?: number;
  programId?: number;
}) => number {
  switch (mode) {
    case RenderSort.DistanceAscending:
      return (a, b) => a.renderOrder - b.renderOrder || a.distance - b.distance;
    case RenderSort.DistanceDescending:
      return (a, b) => a.renderOrder - b.renderOrder || b.distance - a.distance;
    case RenderSort.Program:
      return (a, b) =>
        a.renderOrder - b.renderOrder ||
        (a.programId ?? 0) - (b.programId ?? 0) ||
        (a.materialId ?? 0) - (b.materialId ?? 0);
    case RenderSort.Stable:
      return (a, b) => a.renderOrder - b.renderOrder;
    case RenderSort.Material:
    default:
      return (a, b) =>
        a.renderOrder - b.renderOrder ||
        (a.materialId ?? 0) - (b.materialId ?? 0) ||
        a.distance - b.distance;
  }
}

/** `true` when `value` looks like a renderable. */
export function isRenderable(value: unknown): value is IRenderable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as IRenderable).visible === 'boolean' &&
    typeof (value as IRenderable).renderOrder === 'number'
  );
}
