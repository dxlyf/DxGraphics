/**
 * `Scene2D` - the root container for 2D content.
 *
 * A scene carries the frame-wide state the backend needs (clear colour, camera)
 * and provides named layers so content can be grouped and ordered without
 * reshuffling the node tree.
 *
 * ```ts
 * const scene = new Scene2D({ background: '#101014' });
 * const hud = new Layer2D({ name: 'hud', zIndex: 100 });
 * scene.addLayer(hud);
 * hud.add(new Text2D({ text: 'score' }));
 * ```
 *
 * @packageDocumentation
 */

import { Node2D } from './Node2D';
import { Layer2D } from './Layer2D';
import type { Scene2DOptions } from './types';

/** The root node of a 2D scene. */
export class Scene2D extends Node2D {
  /** Allows consumers to detect a scene without an `instanceof` check. */
  public readonly isScene2D: true = true;

  /** Class name used by serialisation and the backend's dispatch. */
  public override readonly type: string = 'Scene2D';

  /** Clear colour: hex integer, CSS string, or `null` to leave the target as-is. */
  public background: number | string | null;

  /** Active camera; the backend interprets it (see `Camera2D`). */
  public camera: unknown;

  /** `true` to resize the drawing surface with the host element. */
  public autoResize: boolean;

  /** Seconds accumulated by the owning loop; maintained by the host. */
  public elapsed = 0;

  /** Creates a scene. */
  constructor(options: Scene2DOptions = {}) {
    super(options);
    this.name = options.name ?? 'scene';
    this.background = options.background ?? null;
    this.camera = options.camera ?? null;
    this.autoResize = options.autoResize ?? true;
  }

  /**
   * Adds a named layer at `zIndex`, creating it when the name is new.
   *
   * @param layer Existing layer to adopt, or a name to create one for.
   * @param zIndex Draw order of the layer when it is created.
   * @returns The layer that is now part of the scene.
   */
  public addLayer(layer: Layer2D | string, zIndex = 0): Layer2D {
    if (typeof layer === 'string') {
      const existing = this.getLayer(layer);
      if (existing) return existing;
      const created = new Layer2D({ name: layer, zIndex });
      this.add(created);
      return created;
    }
    this.add(layer);
    return layer;
  }

  /** Returns the layer with `name`, or `undefined`. */
  public getLayer(name: string): Layer2D | undefined {
    for (let i = 0; i < this.children.length; i++) {
      const child = this.children[i];
      if (child instanceof Layer2D && child.name === name) return child;
    }
    return undefined;
  }

  /** Returns every layer, sorted by `zIndex`. */
  public getLayers(): Layer2D[] {
    const layers: Layer2D[] = [];
    for (let i = 0; i < this.children.length; i++) {
      const child = this.children[i];
      if (child instanceof Layer2D) layers.push(child);
    }
    return layers.sort((a, b) => a.zIndex - b.zIndex);
  }

  /** Removes a layer by reference or by name. */
  public removeLayer(layer: Layer2D | string): this {
    const target = typeof layer === 'string' ? this.getLayer(layer) : layer;
    if (target) this.remove(target);
    return this;
  }

  /**
   * Advances the scene clock and updates every node.
   *
   * @param delta Seconds elapsed since the previous frame.
   */
  public override update(delta: number): void {
    this.elapsed += delta;
    super.update(delta);
  }

  /** Copies the frame-wide state of `source`. */
  public override copy(source: Node2D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof Scene2D) {
      this.background = source.background;
      this.camera = source.camera;
      this.autoResize = source.autoResize;
      this.elapsed = source.elapsed;
    }
    return this;
  }

  /** Returns a new scene with the same frame-wide state. */
  public override clone(recursive = true): Scene2D {
    return this.createInstance().copy(this, recursive) as Scene2D;
  }

  /** Creates an empty `Scene2D`, used by `clone()`. */
  protected override createInstance(): Node2D {
    return new Scene2D();
  }
}
