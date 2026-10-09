/**
 * `MaterialFactory` — the type registry and the descriptor/JSON entry points.
 *
 * Every concrete material registers itself here at import time, which is what
 * makes a material describable as data — in a scene file, a test fixture or a
 * network payload:
 *
 * ```ts
 * registerMaterialType('ToonMaterial', ToonMaterial);
 *
 * const material = createMaterial('MeshStandardMaterial', { roughness: 0.4 });
 * const fromData = createMaterial({ type: 'MeshPhongMaterial', shininess: 60 });
 * const restored = createMaterialFromJSON(material.toJSON());
 * ```
 *
 * The abstract `BasicMaterial` is deliberately absent: it has no primitive of its
 * own, so `getMaterialConstructor('BasicMaterial')` returns `undefined`.
 *
 * @packageDocumentation
 */

import { log } from '../utils/Logger';
import { DepthMaterial } from './DepthMaterial';
import { LineBasicMaterial } from './LineBasicMaterial';
import { LineDashedMaterial } from './LineDashedMaterial';
import { Material } from './Material';
import { MeshBasicMaterial } from './MeshBasicMaterial';
import { MeshLambertMaterial } from './MeshLambertMaterial';
import { MeshPhongMaterial } from './MeshPhongMaterial';
import { MeshPhysicalMaterial } from './MeshPhysicalMaterial';
import { MeshStandardMaterial } from './MeshStandardMaterial';
import { NormalMaterial } from './NormalMaterial';
import { PointsMaterial } from './PointsMaterial';
import { RawShaderMaterial } from './RawShaderMaterial';
import { ShaderMaterial } from './ShaderMaterial';
import { ShadowMaterial } from './ShadowMaterial';
import { SpriteMaterial } from './SpriteMaterial';
import type { MaterialConstructor, MaterialDescriptor, MaterialJSON, MaterialParameters } from './types';

/** Raised when a material type cannot be resolved or is registered twice. */
export class MaterialFactoryError extends Error {
  /** Name of the material type the error is about. */
  public readonly materialType: string;

  /**
   * @param message Human-readable description.
   * @param materialType Type name involved.
   */
  constructor(message: string, materialType: string) {
    super(message);
    this.name = 'MaterialFactoryError';
    this.materialType = materialType;
  }
}

/** Registered constructors, keyed by `Material.type`. */
const registry = new Map<string, MaterialConstructor>();

/** Type used when `createMaterial` is asked for an unknown name. */
let fallbackType: string | null = null;

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Registers (or replaces) a material type.
 *
 * @param name Type name; must match the class's own `type` field so `toJSON` and
 *   `createMaterialFromJSON` round-trip.
 * @param ctor Constructor taking an optional parameter bag.
 * @throws MaterialFactoryError when the name is empty or the constructor is not
 *   callable.
 */
export function registerMaterialType(name: string, ctor: MaterialConstructor): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new MaterialFactoryError('registerMaterialType() needs a non-empty name', String(name));
  }
  if (typeof ctor !== 'function') {
    throw new MaterialFactoryError(`Material type "${name}" must be a constructor`, name);
  }
  if (registry.has(name)) log.debug(`Material type "${name}" was redefined`);
  registry.set(name, ctor);
}

/**
 * Removes a material type.
 *
 * @param name Type name.
 * @returns `true` when a type was removed.
 */
export function unregisterMaterialType(name: string): boolean {
  if (fallbackType === name) fallbackType = null;
  return registry.delete(name);
}

/**
 * Resolves a registered constructor.
 *
 * @param name Type name.
 * @returns The constructor, or `undefined` when the name is unknown.
 */
export function getMaterialConstructor(name: string): MaterialConstructor | undefined {
  return registry.get(name);
}

/** `true` when the type is registered. */
export function hasMaterialType(name: string): boolean {
  return registry.has(name);
}

/** Every registered type name, in registration order. */
export function listMaterialTypes(): string[] {
  return Array.from(registry.keys());
}

/**
 * Chooses the type used when an unknown name is requested.
 *
 * @param name Registered type name, or `null` to fail loudly again.
 */
export function setFallbackMaterialType(name: string | null): void {
  if (name !== null && !registry.has(name)) {
    throw new MaterialFactoryError(`Cannot use unknown material type "${name}" as the fallback`, name);
  }
  fallbackType = name;
}

/* -------------------------------------------------------------------------- */
/* Creation                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Creates a material from a type name or a descriptor.
 *
 * @param descriptor `'MeshStandardMaterial'` or `{ type, ...values }`. In the
 *   object form every key other than `type`, `name` and `parameters` is treated as
 *   a parameter, and an explicit `parameters` bag is merged over them.
 * @param overrides Parameters applied after the descriptor's own.
 * @returns The new material.
 * @throws MaterialFactoryError when the type is unknown and no fallback is set.
 */
export function createMaterial(
  descriptor: string | MaterialDescriptor,
  overrides: MaterialParameters = {},
): Material {
  const { type, name, parameters } = normalizeDescriptor(descriptor);
  const ctor = registry.get(type);

  if (!ctor) {
    if (fallbackType !== null) {
      log.warnOnce(`Material type "${type}" is unknown; falling back to "${fallbackType}"`);
      return createMaterial(fallbackType, { ...parameters, ...overrides });
    }
    throw new MaterialFactoryError(
      `Unknown material type "${type}" (registered: ${listMaterialTypes().join(', ')})`,
      type,
    );
  }

  const material = new ctor(parameters);
  if (name !== undefined) material.name = name;
  if (Object.keys(overrides).length > 0) material.setValues(overrides);
  return material;
}

/**
 * Recreates a material from `Material.toJSON()` output.
 *
 * `null` values for `attenuationDistance` are decoded back to `Infinity`, which is
 * what a `JSON.stringify` round-trip does to that field. Texture references are
 * *not* restored: re-attach them with `setValues` after loading.
 *
 * @param json Serialised material.
 * @returns The new material.
 * @throws MaterialFactoryError when the type is unknown and no fallback is set.
 */
export function createMaterialFromJSON(
  json: MaterialJSON | { type: string; name?: string; parameters?: MaterialParameters },
): Material {
  if (!json || typeof json.type !== 'string') {
    throw new MaterialFactoryError('createMaterialFromJSON() needs a "type" member', String(json?.type));
  }
  const parameters = decodeParameters(json.parameters ?? {});
  return createMaterial({ type: json.type, name: json.name, parameters });
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/** Splits a descriptor into its type, name and parameter bag. */
function normalizeDescriptor(descriptor: string | MaterialDescriptor): {
  type: string;
  name: string | undefined;
  parameters: MaterialParameters;
} {
  if (typeof descriptor === 'string') {
    return { type: descriptor, name: undefined, parameters: {} };
  }
  if (!descriptor || typeof descriptor.type !== 'string') {
    throw new MaterialFactoryError('createMaterial() needs a type name', String(descriptor));
  }

  const parameters: MaterialParameters = {};
  for (const [key, value] of Object.entries(descriptor)) {
    if (key === 'type' || key === 'name' || key === 'parameters') continue;
    parameters[key] = value;
  }
  if (descriptor.parameters) {
    for (const [key, value] of Object.entries(descriptor.parameters)) parameters[key] = value;
  }

  return { type: descriptor.type, name: descriptor.name, parameters };
}

/** Decodes values a JSON round-trip cannot represent. */
function decodeParameters(parameters: MaterialParameters): MaterialParameters {
  const decoded: MaterialParameters = { ...parameters };
  if (decoded.attenuationDistance === null) decoded.attenuationDistance = Infinity;
  return decoded;
}

/* -------------------------------------------------------------------------- */
/* Built-in registration                                                      */
/* -------------------------------------------------------------------------- */

/** Every concrete built-in material, keyed by its type name. */
export const BUILTIN_MATERIAL_TYPES: Readonly<Record<string, MaterialConstructor>> = {
  Material: Material as MaterialConstructor,
  MeshBasicMaterial: MeshBasicMaterial as MaterialConstructor,
  MeshLambertMaterial: MeshLambertMaterial as MaterialConstructor,
  MeshPhongMaterial: MeshPhongMaterial as MaterialConstructor,
  MeshStandardMaterial: MeshStandardMaterial as MaterialConstructor,
  MeshPhysicalMaterial: MeshPhysicalMaterial as MaterialConstructor,
  LineBasicMaterial: LineBasicMaterial as MaterialConstructor,
  LineDashedMaterial: LineDashedMaterial as MaterialConstructor,
  PointsMaterial: PointsMaterial as MaterialConstructor,
  SpriteMaterial: SpriteMaterial as MaterialConstructor,
  ShaderMaterial: ShaderMaterial as MaterialConstructor,
  RawShaderMaterial: RawShaderMaterial as MaterialConstructor,
  ShadowMaterial: ShadowMaterial as MaterialConstructor,
  DepthMaterial: DepthMaterial as MaterialConstructor,
  NormalMaterial: NormalMaterial as MaterialConstructor,
};

for (const [name, ctor] of Object.entries(BUILTIN_MATERIAL_TYPES)) {
  registerMaterialType(name, ctor);
}
