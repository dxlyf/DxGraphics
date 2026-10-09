/**
 * Pre-rendered glow sprites, drawn once per preset.
 *
 * ## Why a sprite cache instead of one gradient per particle
 *
 * The obvious way to draw a particle is to build a radial gradient at its position and
 * fill a circle with it. That is also the slowest: `createRadialGradient` allocates a
 * gradient object and the browser re-rasterises it on every `fill()`. With a few
 * thousand particles per frame the cost is entirely in gradient construction, not in the
 * pixels.
 *
 * So each preset's glow is rasterised **once** into a small offscreen canvas and then
 * blitted per particle with `drawImage`. A 64x64 sprite scaled up to any particle size
 * looks the same as a generated gradient at these radii, and the per-particle cost drops
 * to one `drawImage` call.
 *
 * The sprites are transparent disc glows: bright and nearly opaque in the middle, fading
 * to fully transparent at the rim. Composited with `lighter` (additive) they accumulate
 * into a bright core where particles overlap, which is what makes a fountain read as fire
 * rather than as confetti.
 *
 * @packageDocumentation
 */

/** Sprite edge length in pixels. A power of two keeps the scaling cheap. */
export const SPRITE_SIZE = 64;

/** Base tint of a sprite, as an opaque RGB triple. */
export interface GlowTint {
  /** Red, 0..255. */
  readonly r: number;
  /** Green, 0..255. */
  readonly g: number;
  /** Blue, 0..255. */
  readonly b: number;
}

/**
 * Rasterises one glow sprite.
 *
 * The falloff is a squared term rather than linear: a linear ramp produces a visible
 * hard-edged disc, while `(1 - t)²` puts most of the energy in the core and makes the
 * edge disappear into the background.
 *
 * @param tint Colour of the sprite core.
 * @param alpha Peak alpha at the centre, `0..1`.
 * @returns A canvas holding the sprite, or `null` when no 2D context is available.
 */
export function createGlowSprite(tint: GlowTint, alpha = 1): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_SIZE;
  canvas.height = SPRITE_SIZE;

  const context = canvas.getContext('2d');
  if (context === null) return null;

  const centre = SPRITE_SIZE / 2;
  const gradient = context.createRadialGradient(centre, centre, 0, centre, centre, centre);

  // Four stops, because a two-stop ramp has a visible shoulder where the eye expects a
  // smooth falloff.
  const stops: readonly (readonly [number, number])[] = [
    [0, 1],
    [0.25, 0.72],
    [0.6, 0.18],
    [1, 0],
  ];
  for (const [offset, strength] of stops) {
    gradient.addColorStop(offset, `rgba(${tint.r}, ${tint.g}, ${tint.b}, ${(strength * alpha).toFixed(4)})`);
  }

  context.fillStyle = gradient;
  context.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  return canvas;
}

/**
 * A flat colour sprite: a hard-edged rectangle with no falloff.
 *
 * Used by the "sparks" preset, where a crisp streak reads as a spark and a soft glow
 * reads as smoke.
 *
 * @param tint Colour of the sprite.
 * @returns A canvas holding the sprite, or `null` when no 2D context is available.
 */
export function createStreakSprite(tint: GlowTint): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = SPRITE_SIZE;

  const context = canvas.getContext('2d');
  if (context === null) return null;

  const gradient = context.createLinearGradient(0, 0, 0, SPRITE_SIZE);
  gradient.addColorStop(0, `rgba(${tint.r}, ${tint.g}, ${tint.b}, 0)`);
  gradient.addColorStop(0.5, `rgba(${tint.r}, ${tint.g}, ${tint.b}, 1)`);
  gradient.addColorStop(1, `rgba(${tint.r}, ${tint.g}, ${tint.b}, 0)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}
