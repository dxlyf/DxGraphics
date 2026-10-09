/**
 * `Layer2D` - a named, orderable layer inside a `Scene2D`.
 *
 * Layers exist so unrelated groups of content can be reordered, toggled and
 * culled independently: a HUD layer can stay in screen space while a world layer
 * follows the camera, and hiding the layer hides everything under it.
 *
 * @packageDocumentation
 */

import { Node2D } from './Node2D';
import type { Layer2DOptions } from './types';

/** A named group of nodes with an independent draw order. */
export class Layer2D extends Node2D {
  /** Allows consumers to detect a layer without an `instanceof` check. */
  public readonly isLayer2D: true = true;

  /** Class name used by serialisation and the backend's dispatch. */
  public override readonly type: string = 'Layer2D';

  /**
   * When `true`, the layer is transformed by the scene camera; when `false` it
   * is drawn in screen space (the usual choice for HUDs).
   */
  public cameraScale: boolean;

  /** Creates a layer. */
  constructor(options: Layer2DOptions = {}) {
    super(options);
    this.name = options.name ?? '';
    this.cameraScale = options.cameraScale ?? true;
  }

  /** Returns the layer with the given name, or `undefined`. */
  public getLayerByName(name: string): Layer2D | undefined {
    let found: Layer2D | undefined;
    this.traverse((node) => {
      if (found === undefined && node instanceof Layer2D && node.name === name) found = node;
    });
    return found;
  }

  /** Copies the layer state of `source`. */
  public override copy(source: Node2D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof Layer2D) this.cameraScale = source.cameraScale;
    return this;
  }

  /** Returns a new layer with the same state. */
  public override clone(recursive = true): Layer2D {
    return this.createInstance().copy(this, recursive) as Layer2D;
  }

  /** Creates an empty `Layer2D`, used by `clone()`. */
  protected override createInstance(): Node2D {
    return new Layer2D();
  }
}
