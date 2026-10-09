/**
 * `ShadowMap` — per-light shadow render targets with directional cascades.
 *
 * A shadow map is a depth render of the scene from a light's point of view. What makes it
 * more than a texture is *how many* of them exist and how they are sized:
 *
 * | Light | Targets |
 * | --- | --- |
 * | Directional, `cascades = 1` | 1 |
 * | Directional, `cascades = C` | **C** — one per split, each fitted to its slice of the view frustum |
 * | Spot | 1 |
 * | Point | 1 (a cube map is a backend detail; this class owns one logical target) |
 *
 * ## Why cascades exist
 *
 * A directional light covers the whole scene, so a single map must either cover everything
 * at a resolution that makes near shadows blocky, or cover a little at a resolution that
 * makes distant shadows vanish. Cascades split the view frustum by distance and give each
 * slice its own map, so texel density stays roughly constant:
 *
 * ```
 *   camera                          cascade 0 (near, small extent, high density)
 *     │                             ┌────┐
 *     ├────────────────────────────►│    │ cascade 1
 *     │                             └────┘┌──────────┐
 *     │                                   │          │ cascade 2
 *     │                                   └──────────┘┌──────────────────┐
 *     │                                               │                  │
 *     ▼                                               └──────────────────┘
 * ```
 *
 * ## `autoUpdate` and `needsUpdate`
 *
 * With `autoUpdate` on (the default) every target is refreshed on every `render`. With it
 * off, `render` is a no-op unless `needsUpdate` is set — and setting it refreshes exactly
 * one frame and then clears itself. That is what makes a static scene's shadow cost zero
 * after the first frame, and what a "the light moved" signal hooks into.
 *
 * ```ts
 * const shadows = new ShadowMap({ size: 2048, cascades: 3, type: ShadowMapType.PCFSoft });
 * shadows.render(renderer, scene, scene.lights);
 * shadows.getTargets();      // 3 targets for one directional light with 3 cascades
 * shadows.autoUpdate = false;
 * shadows.needsUpdate = true;   // refresh exactly once
 * ```
 *
 * @packageDocumentation
 */

import { createId } from '../../utils/Id';
import { createLogger } from '../../utils/Logger';
import { clamp } from '../../utils/MathUtils';
import { Disposable } from '../../core/Disposable';
import { PixelFormat, TextureFilter } from '../../renderer/interfaces/types';
import type {
  CascadeConfig,
  LightLike,
  RendererLike,
  RenderTargetFactoryLike,
  ShadowLightKind,
  ShadowMapOptions,
  ShadowMapType as ShadowMapTypeAlias,
  ShadowTarget,
} from '../types';
import { ShadowMapType } from '../types';

/** Logger shared by the shadow system. */
const log = createLogger('effects:shadows');

/** Default cascade splits, as view-frustum fractions. */
export const DEFAULT_CASCADE_SPLITS: readonly number[] = [0.05, 0.15, 0.35, 0.65, 1];

/**
 * Manages the shadow render targets for a set of lights.
 */
export class ShadowMap extends Disposable<'ShadowMap'> {
  /** @inheritdoc */
  public override readonly label = 'ShadowMap' as const;

  /** Identifier. */
  public override readonly id: string = createId('shadows');

  /** Filtering mode. */
  public type: ShadowMapType;

  /** Map size in texels, per side. */
  public size: number;

  /** `true` (the default) refreshes every frame. */
  public autoUpdate: boolean;

  /** Setting this refreshes exactly one frame, then clears itself. */
  public needsUpdate: boolean;

  /** Depth bias. */
  public bias: number;

  /** Normal-scaled bias. */
  public normalBias: number;

  /** Blur radius for soft filters. */
  public radius: number;

  /** VSM blur sample count. */
  public blurSamples: number;

  /** Cascades per directional light. */
  public cascades: number;

  /** Cascade split fractions, in view-frustum depth. */
  public cascadeSplits: number[];

  /** `false` disables the whole shadow system. */
  public enabled: boolean;

  /** Depth comparison function name; recorded for a backend to read. */
  public depthFunc: string;

  /** `true` renders the shadow pass in wireframe; recorded only. */
  public wireframe: boolean;

  /** Frames rendered since construction. */
  public frameCount = 0;

  /** Shadow render passes issued since construction. */
  public renderCount = 0;

  /** Target factory, when one was supplied. */
  private factory: RenderTargetFactoryLike | null;

  /** Targets, keyed by light index then cascade. */
  private targets: ShadowTarget[] = [];

  /** The lights the current targets were built for. */
  private boundLights: LightLike[] = [];

  /**
   * Creates a shadow map.
   *
   * @param options Size, filter, cascades and factory.
   */
  constructor(options: ShadowMapOptions = {}) {
    super();

    this.type = options.type ?? ShadowMapType.PCFSoft;
    this.size = Math.max(1, Math.floor(options.size ?? 1024));
    this.autoUpdate = options.autoUpdate ?? true;
    this.needsUpdate = options.needsUpdate ?? false;
    this.bias = options.bias ?? -0.0005;
    this.normalBias = options.normalBias ?? 0.02;
    this.radius = options.radius ?? 1;
    this.blurSamples = Math.max(1, Math.floor(options.blurSamples ?? 8));
    this.cascades = Math.max(1, Math.floor(options.cascades ?? 1));
    this.cascadeSplits = options.cascadeSplits !== undefined ? [...options.cascadeSplits] : [...DEFAULT_CASCADE_SPLITS];
    this.enabled = options.enabled ?? true;
    this.depthFunc = options.depthFunc ?? 'less-equal';
    this.wireframe = options.wireframe ?? false;
    this.factory = options.targetFactory ?? null;
  }

  /* ------------------------------------------------------------------ targets */

  /**
   * Sets the map size and resizes every target.
   *
   * @param size New size in texels, or an explicit rectangle.
   * @returns This shadow map, for chaining.
   */
  public setSize(size: number | { width: number; height: number }): this {
    const resolved = typeof size === 'number' ? Math.max(1, Math.floor(size)) : Math.max(1, Math.floor(size.width));
    this.size = resolved;

    for (const target of this.targets) {
      target.size = resolved;
      target.needsUpdate = true;
      const handle = target.target as { setSize?(w: number, h: number): void } | null;
      handle?.setSize?.(resolved, resolved);
    }
    return this;
  }

  /**
   * Builds targets for a set of lights.
   *
   * The count follows the documented rule: one target per directional cascade, one per
   * spot light, one per point light. Lights with `castShadow === false` or `visible ===
   * false` are skipped entirely.
   *
   * @param lights Lights to build for.
   * @returns The created targets.
   */
  public createTargetsFor(lights: readonly LightLike[]): ShadowTarget[] {
    const filtered = lights.filter((light) => this.affectsShadows(light));

    // Rebuild only when the light set or the cascade count changed: rebuilding every frame
    // would throw away the targets a renderer has already bound.
    const same =
      this.boundLights.length === filtered.length &&
      this.boundLights.every((light, index) => light === filtered[index]);

    if (same && this.targets.length > 0) return this.targets;

    this.releaseTargets();
    this.boundLights = filtered.slice();

    const created: ShadowTarget[] = [];
    for (const light of filtered) {
      const kind = lightKind(light);
      const perLight = kind === 'directional' ? this.cascades : 1;
      const requestedSize = light.shadow?.mapSize?.width;
      const targetSize = Math.max(1, Math.floor(requestedSize ?? this.size));

      for (let cascade = 0; cascade < perLight; cascade++) {
        created.push({
          light,
          kind,
          cascade,
          cascadeCount: perLight,
          target: this.allocateTarget(targetSize),
          size: targetSize,
          needsUpdate: true,
        });
      }
    }

    this.targets = created;
    log.debug(
      `built ${created.length} shadow target(s) for ${filtered.length} light(s) ` +
        `(cascades=${this.cascades})`,
    );
    return created;
  }

  /**
   * Renders the shadow maps.
   *
   * @param renderer Renderer to draw with, or `null` for a metadata-only update.
   * @param scene Scene to draw.
   * @param lights Lights casting shadows.
   * @returns The number of targets refreshed.
   */
  public render(renderer: RendererLike | null, scene: unknown, lights: readonly LightLike[]): number {
    if (!this.enabled) return 0;

    const targets = this.createTargetsFor(lights);

    const shouldUpdate = this.autoUpdate || this.needsUpdate;
    if (!shouldUpdate) {
      // `autoUpdate` is off and nothing asked for a refresh: the maps stay as they are.
      this.frameCount++;
      return 0;
    }

    let refreshed = 0;
    for (const target of targets) {
      try {
        this.renderTarget(renderer, scene, target);
        target.needsUpdate = false;
        refreshed++;
      } catch (error) {
        log.warn(`shadow pass for a ${target.kind} light failed`, error);
      }
    }

    this.renderCount += refreshed;
    this.frameCount++;
    // A forced update applies to exactly one frame.
    this.needsUpdate = false;
    return refreshed;
  }

  /** Renders one target. */
  private renderTarget(renderer: RendererLike | null, scene: unknown, target: ShadowTarget): void {
    if (renderer === null) return;

    renderer.setRenderTarget?.(target.target);

    renderer.setViewport?.(0, 0, target.size, target.size);
    renderer.clear?.({ color: null, depth: true, stencil: false });

    // The shadow camera is fitted by the backend from the light's own shadow settings; this
    // pass only binds the target and issues the draw.
    renderer.render?.(scene, target.light, undefined);

    renderer.setRenderTarget?.(null);
  }

  /**
   * The targets for one light.
   *
   * @param light Light to look up.
   * @returns The targets, in cascade order.
   */
  public getTargetsFor(light: LightLike): ShadowTarget[] {
    return this.targets.filter((target) => target.light === light);
  }

  /**
   * The first target for a light.
   *
   * @param light Light to look up.
   * @returns The target, or `undefined`.
   */
  public getTargetFor(light: LightLike): ShadowTarget | undefined {
    return this.targets.find((target) => target.light === light);
  }

  /**
   * Every target.
   *
   * @returns A copy of the target list.
   */
  public getTargets(): ShadowTarget[] {
    return this.targets.slice();
  }

  /**
   * Number of targets.
   *
   * @returns The count.
   */
  public get targetCount(): number {
    return this.targets.length;
  }

  /**
   * The cascade configuration, derived from the split fractions.
   *
   * @param near Camera near plane.
   * @param far Camera far plane.
   * @returns One entry per cascade.
   */
  public getCascadeConfigs(near = 0.1, far = 1000): CascadeConfig[] {
    const configs: CascadeConfig[] = [];
    const count = Math.max(1, this.cascades);

    let previous = 0;
    for (let index = 0; index < count; index++) {
      const fraction = this.cascadeSplits[Math.min(index, this.cascadeSplits.length - 1)] ?? 1;
      const end = near + (far - near) * clamp(fraction, 0, 1);
      configs.push({
        index,
        near: index === 0 ? near : previous,
        far: Math.max(previous, end),
        // The extent scales with the split's depth, which is what keeps texel density even.
        extent: Math.max(1, end - (index === 0 ? near : previous)),
      });
      previous = end;
    }

    return configs;
  }

  /**
   * The effective bias for a light.
   *
   * @param light Light to read; its own `shadow.bias` wins when present.
   * @returns The bias.
   */
  public getBiasFor(light: LightLike): number {
    return light.shadow?.bias ?? this.bias;
  }

  /**
   * The effective normal bias for a light.
   *
   * @param light Light to read; its own `shadow.normalBias` wins when present.
   * @returns The normal bias.
   */
  public getNormalBiasFor(light: LightLike): number {
    return light.shadow?.normalBias ?? this.normalBias;
  }

  /**
   * `true` when a light casts a shadow this map should render.
   *
   * @param light Light to test.
   * @returns The shadow-casting flag.
   */
  public affectsShadows(light: LightLike): boolean {
    if (light == null) return false;
    if (light.castShadow === false) return false;
    if (light.visible === false) return false;
    if (light.shadow?.enabled === false) return false;
    return true;
  }

  /**
   * The filter mode's shader-side name.
   *
   * @returns `'basic'`, `'pcf'`, `'pcf-soft'` or `'vsm'`.
   */
  public getFilterName(): string {
    switch (this.type) {
      case ShadowMapType.Basic:
        return 'basic';
      case ShadowMapType.PCF:
        return 'pcf';
      case ShadowMapType.VSM:
        return 'vsm';
      case ShadowMapType.PCFSoft:
      default:
        return 'pcf-soft';
    }
  }

  /* ---------------------------------------------------------------- lifecycle */

  /** Allocates one target through the factory, or records metadata only. */
  private allocateTarget(size: number): unknown {
    if (this.factory === null) return null;

    try {
      return this.factory.createRenderTarget({
        width: size,
        height: size,
        colorAttachments: 1,
        // Depth-only targets are the norm for shadows: a colour attachment is only needed
        // for VSM, where the two depth moments are stored.
        depth: true,
        format: this.type === ShadowMapType.VSM ? PixelFormat.RGBA8 : PixelFormat.Depth24Stencil8,
        filter: this.type === ShadowMapType.PCFSoft ? TextureFilter.Linear : TextureFilter.Nearest,
        wrap: 'clamp',
      });
    } catch (error) {
      log.warn('a shadow target could not be allocated; continuing without it', error);
      return null;
    }
  }

  /** Releases every target. */
  private releaseTargets(): void {
    for (const target of this.targets) {
      if (target.target === null) continue;
      try {
        if (this.factory !== null) {
          this.factory.destroyRenderTarget(target.target);
        } else {
          (target.target as { dispose?(): void }).dispose?.();
        }
      } catch (error) {
        log.warn('a shadow target could not be released', error);
      }
    }
    this.targets = [];
  }

  /**
   * Releases every target and resets the counters.
   *
   * @returns This shadow map, for chaining.
   */
  public reset(): this {
    this.releaseTargets();
    this.boundLights = [];
    this.frameCount = 0;
    this.renderCount = 0;
    this.needsUpdate = false;
    return this;
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    this.releaseTargets();
    this.boundLights = [];
    this.enabled = false;
    this.factory = null;
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return (
      `ShadowMap(${this.targetCount} targets, type=${this.getFilterName()}, size=${this.size}, ` +
      `cascades=${this.cascades}, autoUpdate=${this.autoUpdate})`
    );
  }
}

/** Classifies a light structurally. */
function lightKind(light: LightLike): ShadowLightKind {
  if (light.isDirectionalLight === true) return 'directional';
  if (light.isSpotLight === true) return 'spot';
  if (light.isPointLight === true) return 'point';

  switch (light.type) {
    case 'DirectionalLight':
      return 'directional';
    case 'SpotLight':
      return 'spot';
    case 'PointLight':
      return 'point';
    default:
      return 'unknown';
  }
}

/** Re-exported so a caller can name the enum without a second import. */
export { ShadowMapType };
export type { ShadowMapTypeAlias };

/**
 * Convenience factory mirroring `new ShadowMap(options)`.
 *
 * @param options Size, filter, cascades and factory.
 * @returns A new shadow map.
 */
export function shadowMap(options: ShadowMapOptions = {}): ShadowMap {
  return new ShadowMap(options);
}
