/**
 * `OutlinePass` — mask-based silhouette edges.
 *
 * An outline is drawn by rendering the selected objects into a **mask**, dilating its alpha,
 * and subtracting the original mask:
 *
 * ```
 *   mask            dilated          outline = dilated - mask
 *   ┌──────┐        ┌────────┐        ┌────────┐
 *   │ ▓▓▓▓ │   ->   │ ░░░░░░ │   ->   │ ░    ░ │
 *   │ ▓▓▓▓ │        │ ░▓▓▓▓░ │        │ ░    ░ │
 *   └──────┘        └────────┘        └────────┘
 * ```
 *
 * The result is an edge of exactly `edgeThickness` texels around every selected object,
 * which is why this approach is preferred over a normal/depth discontinuity detector: it
 * gives a *closed* contour at a controllable width, and it works on objects with no usable
 * normals (points, sprites, thin geometry).
 *
 * ## Occluded versus visible edges
 *
 * The mask is rendered twice: once with depth testing on (only the visible parts of the
 * selection) and once with it off (the whole selection, including hidden parts).
 * `visible - hidden` is the contour of what you can see, and `hidden - visible` is the
 * contour of what is behind something — drawn in a different colour so the two are
 * distinguishable.
 *
 * ## Pulsing
 *
 * `pulsePeriod > 0` modulates the glow with a sine of the elapsed time divided by the
 * period, so the outline breathes. Useful for a "this is selected" affordance that should
 * be noticeable without being distracting.
 *
 * ```ts
 * const outline = new OutlinePass({ edgeThickness: 2, pulsePeriod: 2 });
 * outline.setSelection([meshA, meshB]);
 * outline.expandMask(mask, 8, 8, 2);   // CPU dilation, for the test suite
 * ```
 *
 * @packageDocumentation
 */

import { Color } from '../../math/Color';
import { clamp01 } from '../../utils/MathUtils';
import type { RenderContext } from '../../renderer/core/RenderContext';
import { Pass } from './Pass';
import { ShaderPass } from './ShaderPass';
import type { OutlineOptions } from '../types';

/**
 * The GLSL body of the mask dilation stage.
 *
 * Exposed as a string constant so a consumer can compose it into a larger shader.
 */
export const OUTLINE_MASK_CHUNK = `
uniform sampler2D tDiffuse;
uniform vec2 resolution;
uniform float edgeThickness;
varying vec2 vUv;

void main() {
  vec2 texel = 1.0 / resolution;
  float maxAlpha = 0.0;
  for (int x = -MAX_THICKNESS; x <= MAX_THICKNESS; x++) {
    for (int y = -MAX_THICKNESS; y <= MAX_THICKNESS; y++) {
      if (float(abs(x)) > edgeThickness || float(abs(y)) > edgeThickness) continue;
      vec2 offset = vec2(float(x), float(y)) * texel;
      maxAlpha = max(maxAlpha, texture2D(tDiffuse, vUv + offset).a);
    }
  }
  gl_FragColor = vec4(1.0, 1.0, 1.0, maxAlpha);
}
`;

/**
 * The GLSL body of the edge-composite stage.
 *
 * Exposed as a string constant for the same reason as {@link OUTLINE_MASK_CHUNK}.
 */
export const OUTLINE_COMPOSITE_CHUNK = `
uniform sampler2D tDiffuse;
uniform sampler2D tMask;
uniform sampler2D tMaskOriginal;
uniform vec3 visibleEdgeColor;
uniform vec3 hiddenEdgeColor;
uniform float edgeStrength;
uniform float edgeGlow;
uniform vec2 resolution;
varying vec2 vUv;

void main() {
  vec4 scene = texture2D(tDiffuse, vUv);
  float dilated = texture2D(tMask, vUv).a;
  float original = texture2D(tMaskOriginal, vUv).a;

  float edge = clamp(dilated - original, 0.0, 1.0) * edgeStrength;
  vec3 color = edge > 0.0 ? visibleEdgeColor : hiddenEdgeColor;
  float amount = edge * (edge > 0.0 ? edgeGlow : 0.0);

  gl_FragColor = vec4(mix(scene.rgb, color, clamp(amount, 0.0, 1.0)), scene.a);
}
`;

/**
 * A mask-based outline pass.
 */
export class OutlinePass extends Pass {
  /** Edge strength multiplier. */
  public edgeStrength: number;

  /** Glow multiplier. */
  public edgeGlow: number;

  /** Edge thickness in texels. */
  public edgeThickness: number;

  /** Pulse period in seconds; `0` disables pulsing. */
  public pulsePeriod: number;

  /** Colour of a visible silhouette edge. */
  public readonly visibleEdgeColor: Color;

  /** Colour of an occluded edge. */
  public readonly hiddenEdgeColor: Color;

  /** Objects to outline. */
  public selectedObjects: unknown[];

  /** Mask dilation sub-pass. */
  public readonly maskPass: ShaderPass;

  /** Edge composite sub-pass. */
  public readonly compositePass: ShaderPass;

  /** Frames this pass has executed. */
  public renderCount = 0;

  /** Elapsed time, accumulated by {@link OutlinePass.update}. */
  public elapsed = 0;

  /** Current pulse multiplier in `[0, 1]`. */
  public pulse = 1;

  /**
   * Creates an outline pass.
   *
   * @param options Thickness, colours and pulse period.
   */
  constructor(options: OutlineOptions = {}) {
    super({ name: options.name ?? 'OutlinePass', ...options });

    this.edgeStrength = options.edgeStrength ?? 3;
    this.edgeGlow = options.edgeGlow ?? 0.5;
    this.edgeThickness = Math.max(1, Math.round(options.edgeThickness ?? 1));
    this.pulsePeriod = Math.max(0, options.pulsePeriod ?? 0);
    this.visibleEdgeColor = Color.from(options.visibleEdgeColor ?? 0xffffff);
    this.hiddenEdgeColor = Color.from(options.hiddenEdgeColor ?? 0x000000);
    this.selectedObjects = options.selectedObjects ? [...options.selectedObjects] : [];

    this.maskPass = new ShaderPass(
      { id: 'outline-mask', fragment: OUTLINE_MASK_CHUNK },
      { name: `${this.name}:mask` },
    );
    this.compositePass = new ShaderPass(
      { id: 'outline-composite', fragment: OUTLINE_COMPOSITE_CHUNK },
      { name: `${this.name}:composite` },
    );

    this.needsSwap = true;
    this.syncUniforms();
  }

  /* ---------------------------------------------------------------- setters */

  /**
   * Replaces the selection.
   *
   * @param objects Objects to outline.
   * @returns This pass, for chaining.
   */
  public setSelection(objects: readonly unknown[]): this {
    this.selectedObjects = [...objects];
    return this;
  }

  /**
   * Adds objects to the selection.
   *
   * @param objects Objects to add.
   * @returns This pass, for chaining.
   */
  public addToSelection(...objects: unknown[]): this {
    for (const object of objects) {
      if (!this.selectedObjects.includes(object)) this.selectedObjects.push(object);
    }
    return this;
  }

  /**
   * Clears the selection.
   *
   * @returns This pass, for chaining.
   */
  public clearSelection(): this {
    this.selectedObjects.length = 0;
    return this;
  }

  /**
   * Sets the edge thickness.
   *
   * @param thickness New thickness in texels.
   * @returns This pass, for chaining.
   */
  public setEdgeThickness(thickness: number): this {
    this.edgeThickness = Math.max(1, Math.round(thickness));
    this.syncUniforms();
    return this;
  }

  /**
   * Sets the edge colours.
   *
   * @param visible Colour of a visible edge.
   * @param hidden Colour of an occluded edge.
   * @returns This pass, for chaining.
   */
  public setEdgeColors(
    visible: number | string | Color,
    hidden: number | string | Color = this.hiddenEdgeColor,
  ): this {
    this.visibleEdgeColor.set(visible);
    this.hiddenEdgeColor.set(hidden);
    this.syncUniforms();
    return this;
  }

  /**
   * `true` when an object is in the selection.
   *
   * @param object Object to test.
   * @returns The selection flag.
   */
  public isSelected(object: unknown): boolean {
    return this.selectedObjects.includes(object);
  }

  /** Pushes parameters into the composite pass. */
  private syncUniforms(): void {
    this.maskPass.setUniform('edgeThickness', this.edgeThickness);
    this.maskPass.setUniform('resolution', [this.width, this.height]);
    this.compositePass.setUniform('edgeStrength', this.edgeStrength * this.pulse);
    this.compositePass.setUniform('edgeGlow', this.edgeGlow);
    this.compositePass.setUniform('visibleEdgeColor', [
      this.visibleEdgeColor.r,
      this.visibleEdgeColor.g,
      this.visibleEdgeColor.b,
    ]);
    this.compositePass.setUniform('hiddenEdgeColor', [
      this.hiddenEdgeColor.r,
      this.hiddenEdgeColor.g,
      this.hiddenEdgeColor.b,
    ]);
    this.compositePass.setUniform('resolution', [this.width, this.height]);
  }

  /* --------------------------------------------------------------- analysis */

  /**
   * Dilates a single-channel mask on the CPU.
   *
   * The reference implementation of the shader's dilation, exposed so the edge geometry can
   * be verified without a GPU. Square (Chebyshev) structuring element, matching the shader.
   *
   * @param mask Source alpha values, row-major.
   * @param width Mask width.
   * @param height Mask height.
   * @param thickness Dilation radius in pixels.
   * @returns The dilated mask.
   */
  public expandMask(
    mask: ArrayLike<number>,
    width: number,
    height: number,
    thickness = this.edgeThickness,
  ): Float32Array {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const radius = Math.max(0, Math.round(thickness));
    const out = new Float32Array(w * h);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let peak = 0;
        for (let dy = -radius; dy <= radius && peak < 1; dy++) {
          const sy = y + dy;
          if (sy < 0 || sy >= h) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const sx = x + dx;
            if (sx < 0 || sx >= w) continue;
            const value = mask[sy * w + sx] ?? 0;
            if (value > peak) peak = value;
          }
        }
        out[y * w + x] = peak;
      }
    }

    return out;
  }

  /**
   * Extracts the edge band from a dilated and an original mask.
   *
   * `edge = clamp(dilated - original, 0, 1)`, the same subtraction the composite shader
   * performs.
   *
   * @param dilated Dilated mask.
   * @param original Original mask.
   * @returns One edge value per pixel.
   */
  public detectEdges(dilated: ArrayLike<number>, original: ArrayLike<number>): Float32Array {
    const length = Math.min(dilated.length, original.length);
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = clamp01((dilated[i] ?? 0) - (original[i] ?? 0));
    }
    return out;
  }

  /* ---------------------------------------------------------------- time */

  /**
   * Advances the pulse.
   *
   * @param delta Seconds since the previous call.
   * @returns The current pulse multiplier.
   */
  public update(delta: number): number {
    this.elapsed += Math.max(0, delta);
    if (this.pulsePeriod <= 0) {
      this.pulse = 1;
    } else {
      // `0.5 + 0.5 * sin` keeps the multiplier in `[0, 1]` and starts at the midpoint.
      const phase = (this.elapsed / this.pulsePeriod) * Math.PI * 2;
      this.pulse = 0.5 + 0.5 * Math.sin(phase);
    }
    this.compositePass.setUniform('edgeStrength', this.edgeStrength * this.pulse);
    return this.pulse;
  }

  /* ------------------------------------------------------------------ draw */

  /** @inheritdoc */
  public override setSize(width: number, height: number): void {
    super.setSize(width, height);
    this.maskPass.setSize(this.width, this.height);
    this.compositePass.setSize(this.width, this.height);
    this.syncUniforms();
  }

  /** @inheritdoc */
  protected override draw(context: RenderContext): void {
    // The selection is published so whatever renders the mask can read it; this pass does
    // not traverse the scene itself.
    context.values.set('outlineSelection', this.selectedObjects);
    context.values.set('outlineThickness', this.edgeThickness);

    this.maskPass.execute(context);
    this.compositePass.execute(context);
    this.renderCount++;
  }

  /** @inheritdoc */
  public override reset(): void {
    this.renderCount = 0;
    this.elapsed = 0;
    this.pulse = 1;
    this.maskPass.reset();
    this.compositePass.reset();
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return (
      `OutlinePass("${this.name}", selected=${this.selectedObjects.length}, ` +
      `thickness=${this.edgeThickness}, pulse=${this.pulsePeriod > 0 ? this.pulse.toFixed(2) : 'off'})`
    );
  }
}

/**
 * Convenience factory mirroring `new OutlinePass(options)`.
 *
 * @param options Thickness, colours and pulse period.
 * @returns A new outline pass.
 */
export function outlinePass(options: OutlineOptions = {}): OutlinePass {
  return new OutlinePass(options);
}
