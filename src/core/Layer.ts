/**
 * `Layer` — a bitmask used to group objects and control visibility per camera.
 *
 * Each object and each camera owns a `Layer` mask; an object is only considered
 * by a camera when the two masks share at least one bit. The library predefines
 * 32 named layers (bit `0` is `Default`), leaving plenty of room for application
 * specific grouping.
 *
 * ```ts
 * object.layers.enable(Layer.Transparent);
 * camera.layers.disable(Layer.Debug);
 * camera.layers.test(object.layers); // true when they overlap
 * ```
 *
 * @packageDocumentation
 */

import { DEFAULT_MAX_TEXTURE_UNITS } from '../constants';

/** Well-known layer bits. Every value is a single bit position. */
export enum Layer {
  /** Bit 0 — objects with no explicit layer assignment. */
  Default = 0,
  /** Bit 1 — opaque 3D geometry. */
  Opaque = 1,
  /** Bit 2 — alpha-blended geometry. */
  Transparent = 2,
  /** Bit 3 — UI/overlay content drawn on top. */
  UI = 3,
  /** Bit 4 — debug helpers (grids, axes, bounding volumes). */
  Debug = 4,
  /** Bit 5 — gizmos and editor handles. */
  Gizmo = 5,
  /** Bit 6 — 2D scene content. */
  Scene2D = 6,
  /** Bit 7 — text and glyph rendering. */
  Text = 7,
  /** Bit 8 — particle systems. */
  Particles = 8,
  /** Bit 9 — shadow casters. */
  ShadowCaster = 9,
  /** Bit 10 — shadow receivers. */
  ShadowReceiver = 10,
  /** Bit 11 — reflected/refracted content (mirrors, probes). */
  Reflection = 11,
  /** Bit 12 — picking proxies. Renderers skip these for the main pass. */
  Picking = 12,
  /** Bit 13 — post-processing full-screen quads. */
  PostProcess = 13,
  /** Bit 14 — skybox/environment. */
  Environment = 14,
  /** Bit 15 — physics debug visualisation. */
  PhysicsDebug = 15,
}

/**
 * A 32-bit layer mask.
 *
 * The class is deliberately tiny: it is stored on every scene object, so it
 * avoids validation overhead in `enable`/`disable` and exposes only bit
 * arithmetic.
 */
export class Layers {
  /** The raw 32-bit mask. Bit `0` is the least significant bit. */
  public mask: number;

  /**
   * Creates a mask.
   *
   * @param mask Raw mask value; defaults to bit `0` only (see {@link Layer.Default}).
   */
  constructor(mask: number = 1 << Layer.Default) {
    this.mask = mask;
  }

  /* ------------------------------------------------------------ mutation */

  /** Adds a single layer bit. */
  public enable(layer: Layer | number): this {
    this.mask |= Layers.bit(layer);
    return this;
  }

  /** Removes a single layer bit. */
  public disable(layer: Layer | number): this {
    this.mask &= ~Layers.bit(layer);
    return this;
  }

  /** Enables every given layer. */
  public enableAll(...layers: (Layer | number)[]): this {
    for (const layer of layers) this.enable(layer);
    return this;
  }

  /** Disables every given layer. */
  public disableAll(...layers: (Layer | number)[]): this {
    for (const layer of layers) this.disable(layer);
    return this;
  }

  /** Flips a layer bit. */
  public toggle(layer: Layer | number): this {
    this.mask ^= Layers.bit(layer);
    return this;
  }

  /** Enables every layer (`0xFFFFFFFF`). */
  public enableAllBits(): this {
    this.mask = 0xffffffff | 0;
    return this;
  }

  /** Disables every layer. */
  public disableAllBits(): this {
    this.mask = 0;
    return this;
  }

  /** Replaces the mask wholesale. */
  public set(mask: number): this {
    this.mask = mask | 0;
    return this;
  }

  /** Copies another mask. */
  public copy(layers: Layers | number): this {
    this.mask = typeof layers === 'number' ? layers | 0 : layers.mask;
    return this;
  }

  /** Returns a new mask with the same bits. */
  public clone(): Layers {
    return new Layers(this.mask);
  }

  /* -------------------------------------------------------------- queries */

  /** `true` when the given bit is set. */
  public isEnabled(layer: Layer | number): boolean {
    return (this.mask & Layers.bit(layer)) !== 0;
  }

  /** `true` when `other` shares at least one bit with this mask. */
  public test(other: Layers): boolean {
    return (this.mask & other.mask) !== 0;
  }

  /** `true` when this mask equals `other`. */
  public equals(other: Layers): boolean {
    return this.mask === other.mask;
  }

  /** Number of enabled layers. */
  public get count(): number {
    return Layers.popCount(this.mask);
  }

  /** Every enabled layer index, ascending. */
  public toArray(): number[] {
    const result: number[] = [];
    for (let bit = 0; bit < 32; bit++) {
      if ((this.mask & (1 << bit)) !== 0) result.push(bit);
    }
    return result;
  }

  /** The highest enabled layer index, or `-1` when the mask is empty. */
  public get highest(): number {
    if (this.mask === 0) return -1;
    return 31 - Math.clz32(this.mask);
  }

  /** `true` when no layer is enabled. */
  public get isEmpty(): boolean {
    return this.mask === 0;
  }

  /* --------------------------------------------------------------- output */

  /** `"Default|UI|Debug"`-style description of the enabled bits. */
  public toString(): string {
    const names: string[] = [];
    for (const bit of this.toArray()) {
      names.push(Layer[bit] ?? `Layer${bit}`);
    }
    return names.length > 0 ? names.join('|') : 'Layers(none)';
  }

  /** JSON-friendly representation: the raw mask plus the enabled bit indices. */
  public toJSON(): { mask: number; layers: number[] } {
    return { mask: this.mask, layers: this.toArray() };
  }

  /* --------------------------------------------------------------- static */

  /** Converts a bit index to its mask value. */
  public static bit(layer: Layer | number): number {
    return 1 << (layer as number);
  }

  /** Builds a mask from bit indices. */
  public static from(...layers: (Layer | number)[]): Layers {
    const result = new Layers(0);
    for (const layer of layers) result.enable(layer);
    return result;
  }

  /** Builds a mask with every layer enabled. */
  public static all(): Layers {
    return new Layers(0xffffffff | 0);
  }

  /** Builds an empty mask. */
  public static none(): Layers {
    return new Layers(0);
  }

  /** `true` when the two masks share at least one bit. */
  public static intersects(a: Layers, b: Layers): boolean {
    return (a.mask & b.mask) !== 0;
  }

  /**
   * Warns when more layers were enabled than the renderer can bind in one pass.
   *
   * Not a hard limit — layers only gate visibility — but exceeding the texture
   * unit count usually means the object should be split.
   */
  public static warnIfExcessive(layers: Layers, limit: number = DEFAULT_MAX_TEXTURE_UNITS * 4): boolean {
    if (layers.count <= limit) return false;
    // eslint-disable-next-line no-console
    console.warn(
      `Layers: ${layers.count} layers enabled, which exceeds the advisory limit of ${limit}.`,
    );
    return true;
  }

  /** Population count of a 32-bit integer. */
  private static popCount(value: number): number {
    let v = value - ((value >> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
    v = (v + (v >> 4)) & 0x0f0f0f0f;
    return (v * 0x01010101) >> 24;
  }
}

/** Convenience: a mask with only {@link Layer.Default} enabled. */
export function defaultLayers(): Layers {
  return new Layers(1 << Layer.Default);
}

/** `true` when `value` is a `Layers` instance. */
export function isLayers(value: unknown): value is Layers {
  return value instanceof Layers;
}
