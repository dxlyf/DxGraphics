/**
 * `ParticleMaterial` — the render state a particle system draws with.
 *
 * Deliberately **structural**: it describes blending, point size and texture binding as
 * plain data, so it can be handed to any backend without this module importing a material
 * or texture class. That is what keeps `src/effects` free of the `src/materials` and
 * `src/textures` dependencies (owned by other agents) while still being a valid material.
 *
 * ## Blending presets
 *
 * The three presets are the three things a particle system actually wants:
 *
 * | Preset | Effect | Use for |
 * | --- | --- | --- |
 * | `additive` | light adds to light | sparks, fire, magic, glow |
 * | `normal` | source over destination | smoke, dust, leaves, debris |
 * | `multiply` | light is filtered | soot, shadow puffs, colour grading |
 *
 * `subtractive` is also provided (destination minus source), which is what a "dark smoke"
 * or a hole-punching effect wants.
 *
 * ```ts
 * const material = ParticleMaterial.additive({ size: 0.5, softParticles: true });
 * material.getBlendState();   // { src: 'src-alpha', dst: 'one', ... }
 * material.setBlending('normal');
 * ```
 *
 * @packageDocumentation
 */

import { Color } from '../../math/Color';
import { Vec2 } from '../../math/Vec2';
import { Disposable } from '../../core/Disposable';
import { clamp01 } from '../../utils/MathUtils';
import type {
  ParticleBlendMode,
  ParticleBlendState,
  ParticleMaterialOptions,
  TextureLike,
} from '../types';

/**
 * Render state for a particle system.
 */
export class ParticleMaterial extends Disposable<'ParticleMaterial'> {
  /** @inheritdoc */
  public override readonly label = 'ParticleMaterial' as const;

  /** Base colour. */
  public readonly color: Color;

  /** Opacity in `[0, 1]`. */
  public opacity: number;

  /** Point size in world units (or pixels, when attenuation is off). */
  public size: number;

  /** `false` keeps the point size constant in screen space. */
  public sizeAttenuation: boolean;

  /** Blend preset. */
  public blending: ParticleBlendMode;

  /** `true` renders round sprites rather than squares. */
  public billboard: boolean;

  /** `true` applies the scene's fog. */
  public fog: boolean;

  /** `true` tests depth. */
  public depthTest: boolean;

  /** Whether the material writes depth; `false` for additive particles. */
  public depthWrite: boolean;

  /** `true` fades a particle against scene depth, softening intersections. */
  public softParticles: boolean;

  /** Particle texture, or `null`. */
  public map: TextureLike | null;

  /** Texture coordinate offset. */
  public readonly mapOffset: Vec2;

  /** Texture coordinate scale. */
  public readonly mapScale: Vec2;

  /** A fixed rotation applied to every particle, in radians. */
  public rotation: number;

  /**
   * Creates a particle material.
   *
   * @param options Colour, size and blending configuration.
   */
  constructor(options: ParticleMaterialOptions = {}) {
    super();

    this.color = options.color === undefined ? Color.white() : Color.from(options.color);
    this.opacity = clamp01(options.opacity ?? 1);
    this.size = options.size ?? 1;
    this.sizeAttenuation = options.sizeAttenuation ?? true;
    this.blending = options.blending ?? 'normal';
    this.billboard = options.billboard ?? true;
    this.fog = options.fog ?? false;
    this.depthTest = options.depthTest ?? true;
    this.depthWrite = options.depthWrite ?? false;
    this.softParticles = options.softParticles ?? false;
    this.map = options.map ?? null;
    this.mapOffset = options.mapOffset !== undefined ? Vec2.from(options.mapOffset) : new Vec2(0, 0);
    this.mapScale = options.mapScale !== undefined ? Vec2.from(options.mapScale) : new Vec2(1, 1);
    this.rotation = options.rotation ?? 0;
  }

  /* ---------------------------------------------------------------- presets */

  /**
   * An additive preset: light adds to light.
   *
   * @param options Overrides applied on top of the preset.
   * @returns A new material.
   */
  public static additive(options: ParticleMaterialOptions = {}): ParticleMaterial {
    return new ParticleMaterial({
      depthWrite: false,
      // Additive particles that write depth punch holes in each other.
      depthTest: true,
      ...options,
      blending: 'additive',
    });
  }

  /**
   * A normal (source-over) preset.
   *
   * @param options Overrides applied on top of the preset.
   * @returns A new material.
   */
  public static normal(options: ParticleMaterialOptions = {}): ParticleMaterial {
    return new ParticleMaterial({ ...options, blending: 'normal' });
  }

  /**
   * A multiply preset: light is filtered.
   *
   * @param options Overrides applied on top of the preset.
   * @returns A new material.
   */
  public static multiply(options: ParticleMaterialOptions = {}): ParticleMaterial {
    return new ParticleMaterial({ depthWrite: false, ...options, blending: 'multiply' });
  }

  /**
   * A subtractive preset: destination minus source.
   *
   * @param options Overrides applied on top of the preset.
   * @returns A new material.
   */
  public static subtractive(options: ParticleMaterialOptions = {}): ParticleMaterial {
    return new ParticleMaterial({
      depthWrite: false,
      ...options,
      blending: 'subtractive',
    });
  }

  /* ---------------------------------------------------------------- setters */

  /**
   * Sets the blend preset.
   *
   * @param mode New preset.
   * @returns This material, for chaining.
   */
  public setBlending(mode: ParticleBlendMode): this {
    this.blending = mode;
    // Additive and multiply blending must not write depth, or the particles occlude each
    // other in submission order.
    if (mode !== 'normal') this.depthWrite = false;
    return this;
  }

  /**
   * Sets the colour.
   *
   * @param color New colour.
   * @returns This material, for chaining.
   */
  public setColor(color: number | string | Color): this {
    this.color.set(color);
    return this;
  }

  /**
   * Sets the opacity.
   *
   * @param opacity New opacity in `[0, 1]`.
   * @returns This material, for chaining.
   */
  public setOpacity(opacity: number): this {
    this.opacity = clamp01(opacity);
    return this;
  }

  /**
   * Sets the point size.
   *
   * @param size New size.
   * @returns This material, for chaining.
   */
  public setSize(size: number): this {
    this.size = Math.max(0, size);
    return this;
  }

  /**
   * Attaches a texture.
   *
   * @param map Texture, or `null`.
   * @returns This material, for chaining.
   */
  public setMap(map: TextureLike | null): this {
    this.map = map;
    return this;
  }

  /* --------------------------------------------------------------- blending */

  /**
   * The blend state this preset resolves to.
   *
   * Factor names are backend-independent (`'src-alpha'`, `'one'`, `'one-minus-src-alpha'`),
   * so a backend maps them onto its own enum without this module knowing which backend it
   * is.
   *
   * @returns The blend state descriptor.
   */
  public getBlendState(): ParticleBlendState {
    switch (this.blending) {
      case 'additive':
        return {
          src: 'src-alpha',
          dst: 'one',
          equation: 'add',
          premultiplied: false,
          mode: 'additive',
        };
      case 'subtractive':
        return {
          src: 'zero',
          dst: 'one-minus-src-color',
          equation: 'add',
          premultiplied: false,
          mode: 'subtractive',
        };
      case 'multiply':
        return {
          src: 'dst-color',
          dst: 'zero',
          equation: 'add',
          premultiplied: false,
          mode: 'multiply',
        };
      case 'normal':
      default:
        return {
          src: 'src-alpha',
          dst: 'one-minus-src-alpha',
          equation: 'add',
          premultiplied: false,
          mode: 'normal',
        };
    }
  }

  /**
   * `true` when the preset needs the transparent render queue.
   *
   * @returns The transparency flag.
   */
  public get isTransparent(): boolean {
    return this.blending !== 'normal' || this.opacity < 1;
  }

  /**
   * The effective opacity, folding the blend preset in.
   *
   * @returns A value in `[0, 1]`.
   */
  public get effectiveOpacity(): number {
    return this.blending === 'multiply' ? clamp01(this.opacity) : this.opacity;
  }

  /**
   * `true` when the material is visible.
   *
   * @returns The visibility flag.
   */
  public get visible(): boolean {
    return this.opacity > 0;
  }

  /* --------------------------------------------------------------- copying */

  /**
   * Copies another material's values into this one.
   *
   * @param source Material to copy.
   * @returns This material, for chaining.
   */
  public copy(source: ParticleMaterial): this {
    this.color.copy(source.color);
    this.opacity = source.opacity;
    this.size = source.size;
    this.sizeAttenuation = source.sizeAttenuation;
    this.blending = source.blending;
    this.billboard = source.billboard;
    this.fog = source.fog;
    this.depthTest = source.depthTest;
    this.depthWrite = source.depthWrite;
    this.softParticles = source.softParticles;
    this.map = source.map;
    this.mapOffset.copy(source.mapOffset);
    this.mapScale.copy(source.mapScale);
    this.rotation = source.rotation;
    return this;
  }

  /**
   * @returns A copy of this material.
   */
  public clone(): ParticleMaterial {
    return new ParticleMaterial().copy(this);
  }

  /**
   * @returns A JSON-friendly representation.
   */
  public toJSON(): Record<string, unknown> {
    return {
      color: this.color.getHex(),
      opacity: this.opacity,
      size: this.size,
      sizeAttenuation: this.sizeAttenuation,
      blending: this.blending,
      billboard: this.billboard,
      fog: this.fog,
      depthTest: this.depthTest,
      depthWrite: this.depthWrite,
      softParticles: this.softParticles,
      mapOffset: this.mapOffset.toArray(),
      mapScale: this.mapScale.toArray(),
      rotation: this.rotation,
      blendState: this.getBlendState(),
    };
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    this.map = null;
    this.opacity = 0;
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return (
      `ParticleMaterial(blending=${this.blending}, opacity=${this.opacity}, size=${this.size}, ` +
      `map=${this.map === null ? 'none' : 'set'})`
    );
  }
}

/**
 * Convenience factory mirroring `new ParticleMaterial(options)`.
 *
 * @param options Colour, size and blending configuration.
 * @returns A new material.
 */
export function particleMaterial(options: ParticleMaterialOptions = {}): ParticleMaterial {
  return new ParticleMaterial(options);
}
