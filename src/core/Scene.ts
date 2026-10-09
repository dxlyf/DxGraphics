/**
 * `Scene` — the backend-agnostic root of a renderable graph.
 *
 * A scene adds the things a root needs and a leaf does not: an environment
 * (background, fog, ambient lighting), a render-list version for cache
 * invalidation, statistics, and helpers for the traversal the renderer performs
 * every frame.
 *
 * ```ts
 * const scene = new Scene({ background: '#101018' });
 * scene.add(mesh, light);
 * scene.updateMatrixWorld();
 * ```
 *
 * @packageDocumentation
 */

import { Color } from '../math/Color';
import { Mat4 } from '../math/Mat4';
import { Sphere } from '../math/Sphere';
import { Vec3 } from '../math/Vec3';
import { BoundingVolume } from './BoundingVolume';
import { Camera } from './Camera';
import { Node, type NodeOptions } from './Node';
import { createId } from '../utils/Id';
import type { FogLike, SceneBackground, SceneStatistics } from './types';

/** Events emitted by {@link Scene}. */
export interface SceneEvents {
  /** Fired when any structural change occurs (add/remove/visibility). */
  change: [];
  /** Fired after `updateMatrixWorld` finishes a full pass. */
  update: [];
  /** Fired when the background, fog or environment changes. */
  environmentchange: [];
}

/** Options accepted by the {@link Scene} constructor. */
export interface SceneOptions extends NodeOptions {
  /** Background colour (any CSS colour) or `null` for transparent. */
  background?: SceneBackground;
  /** Fog description; `null` disables fog. */
  fog?: FogLike | null;
  /** Global ambient intensity multiplier applied by the renderer. */
  ambientIntensity?: number;
}

/**
 * Root node of a renderable scene graph.
 */
export class Scene extends Node {
  /** Overrides {@link Node.type}. */
  public override get type(): 'Scene3D' {
    return 'Scene3D';
  }

  /** Background colour/texture, or `null`. */
  public background: SceneBackground = null;

  /** Fog description; `null` disables fog. */
  public fog: FogLike | null = null;

  /** Ambient intensity multiplier applied on top of the `AmbientLight` objects. */
  public ambientIntensity = 1;

  /** World-space bounds of every bounded child, refreshed by {@link computeBounds}. */
  public readonly bounds: BoundingVolume = new BoundingVolume();

  /** Bumped whenever the graph structure changes; used to invalidate render lists. */
  public version = 0;

  /** `true` when the scene should recompute its bounds on the next render. */
  public needsBoundsUpdate = true;

  /** Cameras that have been attached to this scene, in registration order. */
  public readonly cameras: Camera[] = [];

  /** `true` to skip shadow-map generation entirely for this scene. */
  public shadowsEnabled = true;

  /** Identifier used in debug output. */
  public readonly sceneId: string = createId('scene');

  /** Creates a scene. */
  constructor(options: SceneOptions = {}) {
    super(options);
    if (options.background !== undefined) this.background = options.background;
    if (options.fog !== undefined) this.fog = options.fog;
    if (options.ambientIntensity !== undefined) this.ambientIntensity = options.ambientIntensity;
  }

  /* ------------------------------------------------------------ structure */

  /** Adds nodes and registers any camera that is attached. */
  public override add<T extends Node>(...nodes: T[]): T {
    super.add(...nodes);
    for (const node of nodes) {
      if (node instanceof Camera && !this.cameras.includes(node)) this.cameras.push(node);
    }
    this.invalidate();
    return nodes[0];
  }

  /** Removes nodes and unregisters any camera that was attached. */
  public override remove(...nodes: Node[]): this {
    super.remove(...nodes);
    for (const node of nodes) {
      const index = this.cameras.indexOf(node as Camera);
      if (index >= 0) this.cameras.splice(index, 1);
    }
    this.invalidate();
    return this;
  }

  /** Overrides {@link Node.clear} to also drop registered cameras. */
  public override clear(): this {
    this.cameras.length = 0;
    super.clear();
    this.invalidate();
    return this;
  }

  /** Marks the scene as structurally changed. */
  public invalidate(): this {
    this.version++;
    this.needsBoundsUpdate = true;
    this.emit('change');
    return this;
  }

  /**
   * Sets the background.
   *
   * Accepts a `Color`, any CSS colour string (`'#101018'`, `'rebeccapurple'`,
   * `'rgb(16, 16, 24)'`) or a texture-like value, which is stored as-is for the
   * renderer to interpret.
   */
  public setBackground(color: Color | string | number | null): this {
    this.background = typeof color === 'string' || typeof color === 'number' ? Color.from(color) : color;
    this.emit('environmentchange');
    return this;
  }

  /** Sets or clears the fog. */
  public setFog(fog: FogLike | null): this {
    this.fog = fog;
    this.emit('environmentchange');
    return this;
  }

  /**
   * Creates and installs a linear fog.
   *
   * @param color Fog colour.
   * @param near Distance where fog starts.
   * @param far Distance where fog is fully opaque.
   */
  public setLinearFog(color: string | number | Color, near: number, far: number): this {
    const parsed: Color = color instanceof Color ? color : Color.from(color);
    return this.setFog({
      type: 'linear',
      color: { r: parsed.r, g: parsed.g, b: parsed.b },
      near,
      far,
      density: 0,
      disabled: false,
    });
  }

  /**
   * Creates and installs exponential fog.
   *
   * @param color Fog colour.
   * @param density Falloff density; typical values are `0.01`–`0.1`.
   */
  public setExponentialFog(color: string | number | Color, density: number): this {
    const parsed: Color = color instanceof Color ? color : Color.from(color);
    return this.setFog({
      type: 'exponential',
      color: { r: parsed.r, g: parsed.g, b: parsed.b },
      near: 0,
      far: Infinity,
      density,
      disabled: false,
    });
  }

  /* ----------------------------------------------------------- traversal */

  /** First camera in the scene, or `null`. */
  public getActiveCamera(): Camera | null {
    if (this.cameras.length > 0) return this.cameras[0];
    let found: Camera | null = null;
    this.traverse((node) => {
      if (!found && node instanceof Camera) found = node;
    });
    return found;
  }

  /** Recomputes the world matrices of the whole graph and bumps the version. */
  public override updateMatrixWorld(force: boolean = false): this {
    super.updateMatrixWorld(force);
    this.emit('update');
    return this;
  }

  /**
   * Recomputes world-space bounds from every child that exposes a
   * `boundingVolume`.
   */
  public computeBounds(force: boolean = false): BoundingVolume {
    if (!force && !this.needsBoundsUpdate) return this.bounds;

    this.bounds.localBox.makeEmpty();
    const points: Vec3[] = [];

    this.traverse((node) => {
      const candidate = node as unknown as { boundingVolume?: BoundingVolume; visible?: boolean };
      const volume = candidate.boundingVolume;
      if (!volume || !volume.hasWorldBounds) return;
      if (volume.box.isEmpty()) return;
      points.push(volume.box.min.clone(), volume.box.max.clone());
    });

    if (points.length > 0) {
      this.bounds.setFromPoints(points);
      this.bounds.update(Scene.IDENTITY_MATRIX);
      this.bounds.hasWorldBounds = true;
    } else {
      this.bounds.localBox.makeEmpty();
      this.bounds.box.makeEmpty();
      this.bounds.hasWorldBounds = false;
    }

    this.needsBoundsUpdate = false;
    return this.bounds;
  }

  /** Whether a sphere is entirely outside the scene's bounds (conservative). */
  public intersectsBounds(sphere: Sphere): boolean {
    if (this.bounds.isEmpty) return true;
    return this.bounds.sphere.intersectsSphere(sphere);
  }

  /* ------------------------------------------------------------ statistics */

  /**
   * Counts the objects in the scene.
   *
   * Counts are cheap approximations for debug overlays: triangles are derived
   * from each geometry's index/position count when available.
   */
  public getStatistics(): SceneStatistics {
    const stats: SceneStatistics = {
      objects: 0,
      meshes: 0,
      lights: 0,
      cameras: 0,
      triangles: 0,
      estimatedDrawCalls: 0,
    };

    this.traverse((node) => {
      stats.objects++;
      const type = node.type as string;
      if (type === 'Mesh' || type === 'Mesh2D' || type === 'SkinnedMesh' || type === 'InstancedMesh') {
        stats.meshes++;
        stats.estimatedDrawCalls++;
      } else if (type === 'Points' || type === 'Line' || type === 'LineSegments') {
        stats.estimatedDrawCalls++;
      } else if (type.endsWith('Light')) {
        stats.lights++;
      } else if (type === 'Camera2D' || type === 'Camera3D' || type === 'PerspectiveCamera' || type === 'OrthographicCamera') {
        stats.cameras++;
      }

      const geometry = (node as unknown as { geometry?: { getIndex?(): unknown; getAttribute?(n: string): unknown } }).geometry;
      if (!geometry) return;
      const index = geometry.getIndex?.() as { count?: number } | undefined;
      if (index && typeof index.count === 'number') {
        stats.triangles += Math.floor(index.count / 3);
        return;
      }
      const position = geometry.getAttribute?.('position') as { count?: number } | undefined;
      if (position && typeof position.count === 'number') {
        stats.triangles += Math.floor(position.count / 3);
      }
    });

    return stats;
  }

  /** `true` when no node other than this scene is present. */
  public get isEmpty(): boolean {
    return this.children.length === 0;
  }

  /**
   * Collects every visible renderable in the scene, depth-first and in child order.
   *
   * This is the `collectRenderables` hook the renderers look for
   * (`SceneLike.collectRenderables`). Without it the renderer's fallback walks
   * `children` only **one level deep**, so a scene containing a group submits nothing
   * below depth 2 and the objects silently fail to appear.
   *
   * A node with `visible === false` is skipped together with its whole subtree — that
   * is what hiding a group must mean — and a node is treated as drawable when it
   * carries either a `geometry` or a `renderable` payload.
   *
   * @param list Array the renderer passes in; it is filled in place.
   * @param _camera Camera for the frame. Unused: culling belongs to the renderer,
   *   which owns the frustum and the render queue.
   */
  public collectRenderables(list: unknown[], _camera?: unknown): void {
    const append = (node: Node): void => {
      if (node.visible === false) return;
      const candidate = node as Node & { geometry?: unknown; renderable?: unknown };
      if (candidate.geometry != null || candidate.renderable != null) list.push(node);
      for (const child of node.children) append(child);
    };

    for (const child of this.children) append(child);
  }

  /* --------------------------------------------------------------- output */

  /** Overrides {@link Node.copy}. */
  public override copy(source: Node, recursive: boolean = true): this {
    super.copy(source, recursive);
    if (source instanceof Scene) {
      this.background = source.background;
      this.fog = source.fog;
      this.ambientIntensity = source.ambientIntensity;
      this.shadowsEnabled = source.shadowsEnabled;
    }
    return this;
  }

  /** Overrides {@link Node.clone}. */
  public override clone(recursive: boolean = true): Scene {
    const scene = new Scene();
    scene.copy(this, recursive);
    return scene;
  }

  /** JSON-friendly representation including the environment. */
  public override toJSON(recursive: boolean = true): Record<string, unknown> {
    const background = this.background;
    return {
      ...super.toJSON(recursive),
      type: 'Scene',
      sceneId: this.sceneId,
      background:
        background instanceof Color
          ? { r: background.r, g: background.g, b: background.b, a: background.a }
          : background === null
            ? null
            : '[texture]',
      fog: this.fog,
      ambientIntensity: this.ambientIntensity,
      shadowsEnabled: this.shadowsEnabled,
    };
  }

  /** Identity matrix reused when computing scene bounds. */
  private static readonly IDENTITY_MATRIX = Mat4.identity();
}

/** Convenience factory. */
export function scene(options?: SceneOptions): Scene {
  return new Scene(options);
}

/** Type guard for {@link Scene}. */
export function isScene(value: unknown): value is Scene {
  return value instanceof Scene;
}
