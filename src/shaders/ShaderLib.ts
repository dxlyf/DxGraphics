/**
 * `ShaderLib` — the built-in shader library.
 *
 * Every family (`basic`, `lambert`, `phong`, `standard`, `physical`, `points`,
 * `dashed`, `sprite`, `depth`, `normal`, `shadow`, `background`) is registered
 * once, with a GLSL **and** a WGSL variant wherever the backend can express it:
 *
 * ```ts
 * const entry = getShaderLib('standard');
 * compiler.compile(entry.glsl, { backend: 'webgl2' });
 * if (entry.wgsl) compiler.compile(entry.wgsl, { backend: 'webgpu' });
 * ```
 *
 * ## Languages
 *
 * The GLSL variants live in `src/shaders/glsl/lib/*.ts` and the WGSL variants in
 * `src/shaders/wgsl/lib/*.ts`, both as TypeScript string constants (see the
 * barrel files for the rationale). Descriptors are plain data, so this module
 * never touches a GPU and can be exercised in a Node test run.
 *
 * An entry whose WGSL variant is genuinely not portable declares `wgsl: null`
 * together with {@link ShaderLibEntry.wgslUnsupportedReason} and a
 * {@link ShaderLibEntry.buildWGSL} fallback that reports the limitation instead
 * of throwing.
 *
 * @packageDocumentation
 */

import { log } from '../utils/Logger';
import { glslShaderLib } from './glsl';
import { wgslShaderLib } from './wgsl';
import type { ShaderDescriptor, ShaderLanguage } from './types';

/** One library family, with a variant per language. */
export interface ShaderLibEntry {
  /** Family name, e.g. `'standard'`. */
  name: string;
  /** One-line description of what the program draws. */
  description: string;
  /** GLSL program. Always present: WebGL is the baseline backend. */
  glsl: ShaderDescriptor;
  /**
   * WGSL program, or `null` when the family has no portable WGSL variant.
   *
   * When `null`, {@link wgslUnsupportedReason} must explain why and
   * {@link buildWGSL} must report the limitation instead of throwing.
   */
  wgsl: ShaderDescriptor | null;
  /** Why the family has no WGSL variant; only set when {@link wgsl} is `null`. */
  wgslUnsupportedReason?: string;
  /**
   * Builds the WGSL variant on demand.
   *
   * @returns The WGSL descriptor, or `null` when the family is unsupported —
   *   in which case the reason has already been logged.
   */
  buildWGSL?: () => ShaderDescriptor | null;
}

/** Raised when a library lookup fails or a language is unsupported. */
export class ShaderLibError extends Error {
  /** Family the error is about. */
  public readonly shaderName: string;

  /**
   * @param message Human-readable description.
   * @param shaderName Family name.
   */
  constructor(message: string, shaderName: string) {
    super(message);
    this.name = 'ShaderLibError';
    this.shaderName = shaderName;
  }
}

/**
 * The registered library, keyed by family name.
 *
 * Exposed as a mutable record for parity with the rest of the layer; prefer
 * {@link registerShaderLib} and {@link getShaderLib} so the invariant "a GLSL
 * variant always exists" is preserved.
 */
export const ShaderLib: Record<string, ShaderLibEntry> = {};

/** Human-readable summaries used for registration logging. */
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  basic: 'Unlit colour, optional diffuse/alpha maps and vertex colours.',
  lambert: 'Diffuse-only lighting with emissive support.',
  phong: 'Blinn-Phong specular highlights on top of Lambert diffuse.',
  standard: 'Metallic-roughness physically based shading.',
  physical: 'Standard plus clearcoat, transmission, sheen and iridescence.',
  points: 'Screen-space point sprites with size attenuation.',
  dashed: 'Line rendering with a dash/gap pattern along the segment length.',
  sprite: 'Camera-facing quad with rotation and size attenuation.',
  depth: 'Depth-only pass with optional packing and displacement.',
  normal: 'View-space normals with optional normal mapping for debug output.',
  shadow: 'Shadow-caster pass: depth only, alpha-tested where a map is bound.',
  background: 'Full-screen background/skybox gradient and cube sampling.',
};

/**
 * Registers (or replaces) a library family.
 *
 * @param name Family name; normally one of the built-in names.
 * @param descriptor Entry to store under that name.
 * @throws ShaderLibError when the entry has no GLSL variant or no explanation
 *   for a missing WGSL variant.
 */
export function registerShaderLib(name: string, descriptor: ShaderLibEntry): void {
  if (!descriptor.glsl) {
    throw new ShaderLibError(`ShaderLib entry "${name}" must provide a GLSL variant`, name);
  }
  if (descriptor.wgsl === null && !descriptor.wgslUnsupportedReason) {
    throw new ShaderLibError(
      `ShaderLib entry "${name}" declares no WGSL variant and must document why`,
      name,
    );
  }
  ShaderLib[name] = { ...descriptor, name };
}

/**
 * Reads a library family.
 *
 * @param name Family name.
 * @throws ShaderLibError when the family is not registered.
 */
export function getShaderLib(name: string): ShaderLibEntry {
  const entry = ShaderLib[name];
  if (!entry) throw new ShaderLibError(`ShaderLib has no entry named "${name}"`, name);
  return entry;
}

/** `true` when the family is registered. */
export function hasShaderLib(name: string): boolean {
  return name in ShaderLib;
}

/** Removes a family. Returns `true` when one was removed. */
export function unregisterShaderLib(name: string): boolean {
  return delete ShaderLib[name];
}

/** Every registered family name, in registration order. */
export function listShaderLib(): string[] {
  return Object.keys(ShaderLib);
}

/** Every registered family, keyed by name. */
export function allShaderLib(): Record<string, ShaderLibEntry> {
  return { ...ShaderLib };
}

/** Languages a family can be compiled to. */
export function supportedLanguages(name: string): ShaderLanguage[] {
  const entry = getShaderLib(name);
  return entry.wgsl === null ? ['glsl'] : ['glsl', 'wgsl'];
}

/**
 * Reports that a family has no variant for a language.
 *
 * Used by the `buildWGSL()` fallbacks: it logs the documented reason once and
 * returns `null`, so a caller can degrade gracefully (fall back to a different
 * program, or skip the draw) instead of catching an exception.
 *
 * @param name Family name.
 * @param language Language that was requested.
 * @returns Always `null`.
 */
export function reportUnsupportedShader(name: string, language: ShaderLanguage): null {
  const entry = ShaderLib[name];
  const reason = entry?.wgslUnsupportedReason ?? 'the variant is not implemented';
  log.warnOnce(`ShaderLib "${name}" has no ${language.toUpperCase()} variant: ${reason}`);
  return null;
}

/**
 * Returns the descriptor for one family in one language.
 *
 * @param name Family name.
 * @param language Target language.
 * @throws ShaderLibError when the family is unknown or has no variant for the
 *   requested language.
 */
export function buildShaderDescriptor(name: string, language: ShaderLanguage): ShaderDescriptor {
  const entry = getShaderLib(name);
  if (language === 'glsl') return entry.glsl;
  const built = entry.wgsl ?? entry.buildWGSL?.() ?? null;
  if (!built) {
    throw new ShaderLibError(
      `ShaderLib "${name}" has no WGSL variant: ${entry.wgslUnsupportedReason ?? 'unsupported'}`,
      name,
    );
  }
  return built;
}

/* -------------------------------------------------------------------------- */
/* Built-in registration                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The WGSL families that are intentionally absent.
 *
 * `physical` is the only entry without a WGSL variant: its clearcoat,
 * transmission, volume-attenuation, sheen and iridescence parameters are
 * assembled from GLSL preprocessor branches whose WGSL equivalents (separate
 * struct members, `textureSampleLevel` variants and explicit `select()` chains)
 * are not implemented yet. The WGSL backend therefore reports the family as
 * unsupported and the renderer falls back to `standard`.
 */
const WGSL_UNSUPPORTED: Readonly<Record<string, string>> = {
  physical:
    'clearcoat/transmission/attenuation/sheen/iridescence are GLSL-only for now; the WGSL backend falls back to the "standard" family',
};

/** Registers every built-in family that has both variants available. */
function registerBuiltins(): void {
  for (const [name, glsl] of Object.entries(glslShaderLib)) {
    const wgsl = wgslShaderLib[name] ?? null;
    const reason = wgsl === null ? WGSL_UNSUPPORTED[name] : undefined;
    const entry: ShaderLibEntry = {
      name,
      description: DESCRIPTIONS[name] ?? `${name} shader program`,
      glsl,
      wgsl,
    };

    if (reason !== undefined) {
      entry.wgslUnsupportedReason = reason;
      entry.buildWGSL = () => reportUnsupportedShader(name, 'wgsl');
    } else if (wgsl === null) {
      // A missing variant that the table does not explain is a packaging bug:
      // make it loud instead of silently shipping a GLSL-only family.
      log.error(
        `ShaderLib "${name}" has no WGSL variant and no documented reason; ` +
          'register it before the compiler asks for WGSL output',
      );
      entry.wgslUnsupportedReason = 'the WGSL variant is missing from the build';
      entry.buildWGSL = () => reportUnsupportedShader(name, 'wgsl');
    }

    ShaderLib[name] = entry;
  }
}

registerBuiltins();
