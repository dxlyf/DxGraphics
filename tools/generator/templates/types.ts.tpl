/**
 * Cross-layer type vocabulary for `{{NAME_KEBAB}}`.
 *
 * Types live here when more than one module in the layer needs them, or when a *different*
 * layer needs them and the alternative would be a circular import. Declaring a structural
 * interface here is the library's standard way to accept a class from a layer that may not
 * exist yet, without creating a compile-time dependency on it.
 *
 * @packageDocumentation
 */

/**
 * Structural view of a foreign type this module consumes.
 *
 * Every field is optional so any shape satisfying the subset the module actually reads is
 * assignable, and so a class from a not-yet-written layer still type-checks at the call
 * site.
 */
export interface {{NAME_PASCAL}}Like {
  /** Stable identifier, used as a cache key when present. */
  readonly id?: string | number;
  /** `false` to skip this object while processing. */
  readonly visible?: boolean;
  /** Releases resources this object owns, when it owns any. */
  dispose?(): void;
}

/** JSON representation produced by the module's `toJSON`. */
export interface {{NAME_PASCAL}}Json {
  /** Serialisation metadata (`{ version, generator }`). */
  metadata: { version: number; generator: string };
  /** Class name of the serialised object. */
  type: string;
  /** Free-form payload. */
  [key: string]: unknown;
}

/** Version stamped into `{{NAME_PASCAL}}Json.metadata`. */
export const {{NAME_PASCAL}}_JSON_VERSION = 1;

/** Generator name stamped into `{{NAME_PASCAL}}Json.metadata`. */
export const {{NAME_PASCAL}}_JSON_GENERATOR = '@lyf/graphics';
