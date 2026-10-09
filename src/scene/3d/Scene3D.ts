/**
 * `Scene3D` - the root of a 3D scene graph.
 *
 * Beyond `Object3D`, a scene carries the state the renderer needs to begin a
 * frame: the clear colour, optional fog, and the environment-map hooks used by
 * image-based lighting. The scene is never a child of another node.
 *
 * @packageDocumentation
 */

import { Euler } from '../../math/Euler';
import { Object3D } from './Object3D';
import type { FogLike, Scene3DOptions } from './types';

/** The root node of a 3D scene. */
export class Scene3D extends Object3D {
  /** Allows consumers to detect a scene without an `instanceof` check. */
  public readonly isScene3D: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'Scene3D';

  /** Clear colour: hex integer, CSS string, or `null` to leave the target as-is. */
  public background: number | string | null = null;

  /** Fog applied to every material that opts in, or `null`. */
  public fog: FogLike | null = null;

  /** Environment map consumed by image-based lighting; owned by the renderer. */
  public environment: unknown = null;

  /** Multiplier applied to {@link Scene3D.environment}. */
  public environmentIntensity = 1;

  /** Rotation applied to {@link Scene3D.environment}, in radians. */
  public readonly environmentRotation: Euler = new Euler(0, 0, 0, 'XYZ');

  /** Number of frames this scene has been rendered; maintained by the renderer. */
  public frame = 0;

  /** Creates a scene. */
  constructor(options: Scene3DOptions = {}) {
    super(options);
    this.name = options.name ?? '';
    this.background = options.background ?? null;
    this.fog = options.fog ?? null;
    this.environment = options.environment ?? null;
    this.environmentIntensity = options.environmentIntensity ?? 1;
    this.frame = options.frame ?? 0;
    if (options.environmentRotation) {
      const [x, y, z, order] = options.environmentRotation;
      this.environmentRotation.set(x, y, z, order ?? 'XYZ');
    }
  }

  /**
   * Collects every visible renderable in the graph, depth-first and in child order.
   *
   * This is the `collectRenderables` hook the renderers look for
   * (`SceneLike.collectRenderables`). Its absence is not harmless: the renderer's
   * fallback only walks `children` **one level deep**, so without this method a scene
   * containing a group submits nothing below depth 2 — the objects are simply not
   * drawn, with no error.
   *
   * Traversal rules:
   *
   * - a node with `visible === false` is skipped **together with its subtree**, which
   *   is what hiding a group has to mean;
   * - a node carrying `geometry` is a renderable and is appended;
   * - a node carrying a `renderable` payload (`Sprite`, `Points`, a custom
   *   `Renderable`) is appended too, because not every drawable owns a geometry;
   * - ordering is depth-first pre-order, so a parent's payload is submitted before its
   *   children's — the same order `Object3D.traverse` reports.
   *
   * @param list Array the renderer passes in; it is filled in place.
   * @param _camera Camera for the frame. Unused: this traversal performs no culling,
   *   because the renderer owns the frustum and the queue.
   */
  public collectRenderables(list: unknown[], _camera?: unknown): void {
    const append = (object: Object3D): void => {
      if (object.visible === false) return;
      const candidate = object as Object3D & { geometry?: unknown; renderable?: unknown };
      if (candidate.geometry != null || candidate.renderable != null) list.push(object);
      for (const child of object.children) append(child);
    };

    for (const child of this.children) append(child);
  }

  /**
   * Walks the scene and releases the resources the payloads own.
   *
   * Geometry and material ownership stays with the caller (two meshes may share
   * both), so only the listeners and the parent link are released here.
   */
  public override dispose(): void {
    this.traverse((object) => object.removeAllListeners());
    super.dispose();
  }
}
