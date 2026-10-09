/**
 * `Sprite` - a textured quad in a 2D scene.
 *
 * The sprite is the workhorse of 2D rendering: a texture, a source rectangle
 * inside it (for atlases), a tint and a flip. Everything else - layout, tiling,
 * nine-slice - is expressed through those five pieces of state.
 *
 * @packageDocumentation
 */

import { Rect } from '../../math/Rect';
import { Vec2 } from '../../math/Vec2';
import { Node2D } from './Node2D';
import type { Material2DLike, Node2DOptions, Texture2DLike } from './types';

/** A region of a texture, in texels. */
export interface SpriteFrame {
  /** Left edge of the frame, in texels. */
  x: number;
  /** Top edge of the frame, in texels. */
  y: number;
  /** Width of the frame, in texels. */
  width: number;
  /** Height of the frame, in texels. */
  height: number;
}

/** Options accepted by the {@link Sprite} constructor. */
export interface SpriteOptions extends Node2DOptions {
  /** Texture drawn by the sprite. */
  texture?: Texture2DLike | null;
  /** Region of the texture to draw; defaults to the whole texture. */
  frame?: SpriteFrame | null;
  /** Draws the sprite mirrored horizontally. */
  flipX?: boolean;
  /** Draws the sprite mirrored vertically. */
  flipY?: boolean;
  /** Tint applied on top of the texture, in a backend-specific form. */
  tint?: unknown;
  /** Material override. */
  material?: Material2DLike | null;
}

/** A textured quad anchored at the node's origin. */
export class Sprite extends Node2D {
  /** Allows consumers to detect a sprite without an `instanceof` check. */
  public readonly isSprite: true = true;

  /** Class name used by serialisation and the backend's dispatch. */
  public override readonly type: string = 'Sprite';

  /** Texture drawn by the sprite. */
  public texture: Texture2DLike | null;

  /** Region of {@link Sprite.texture} to draw, or `null` for the whole texture. */
  public frame: SpriteFrame | null;

  /** Draws the sprite mirrored horizontally. */
  public flipX: boolean;

  /** Draws the sprite mirrored vertically. */
  public flipY: boolean;

  /** Tint applied on top of the texture. */
  public tint: unknown;

  /** Material override, when the backend supports one. */
  public material: Material2DLike | null;

  /** Anchor inside the sprite's own rectangle; `(0, 0)` is its top-left corner. */
  public readonly anchor: Vec2;

  /**
   * Nine-slice border widths, or `null` for a plain quad.
   *
   * Order is `[left, top, right, bottom]`, in local units.
   */
  public nineSlice: [number, number, number, number] | null = null;

  /** Creates a sprite. */
  constructor(options: SpriteOptions = {}) {
    super(options);
    this.texture = options.texture ?? null;
    this.frame = options.frame ? { ...options.frame } : null;
    this.flipX = options.flipX ?? false;
    this.flipY = options.flipY ?? false;
    this.tint = options.tint ?? null;
    this.material = options.material ?? null;
    this.anchor = new Vec2(0, 0);

    if (!this.bounds) {
      const width = this.frame?.width ?? this.texture?.width ?? 0;
      const height = this.frame?.height ?? this.texture?.height ?? 0;
      this.setBounds(new Rect(0, 0, width, height));
    }
  }

  /** Sets the source frame, resizing the quad when it had no explicit size. */
  public setFrame(frame: SpriteFrame | null): this {
    const wasEmpty = this.bounds === null || (this.bounds.width === 0 && this.bounds.height === 0);
    this.frame = frame ? { ...frame } : null;
    if (frame && wasEmpty) this.setBounds(new Rect(0, 0, frame.width, frame.height));
    return this;
  }

  /** Sets both flip flags at once. */
  public setFlip(flipX: boolean, flipY = this.flipY): this {
    this.flipX = flipX;
    this.flipY = flipY;
    return this;
  }

  /** Copies the sprite state of `source`. */
  public override copy(source: Node2D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof Sprite) {
      this.texture = source.texture;
      this.frame = source.frame ? { ...source.frame } : null;
      this.flipX = source.flipX;
      this.flipY = source.flipY;
      this.tint = source.tint;
      this.material = source.material;
      this.anchor.copy(source.anchor);
      this.nineSlice = source.nineSlice ? [...source.nineSlice] : null;
    }
    return this;
  }

  /** Serialises the sprite alongside the node data. */
  public override toJSON(recursive = true): ReturnType<Node2D['toJSON']> {
    const json = super.toJSON(recursive);
    json.flipX = this.flipX;
    json.flipY = this.flipY;
    json.frame = this.frame as unknown as Record<string, unknown> | null;
    json.nineSlice = this.nineSlice;
    return json;
  }

  /** Returns a new sprite with the same state. */
  public override clone(recursive = true): Sprite {
    return this.createInstance().copy(this, recursive) as Sprite;
  }

  /** Creates an empty `Sprite`, used by `clone()`. */
  protected override createInstance(): Node2D {
    return new Sprite();
  }
}
