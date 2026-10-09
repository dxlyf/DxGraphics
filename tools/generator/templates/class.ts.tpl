/**
 * `{{NAME_PASCAL}}` — one-line description of what the class represents.
 *
 * Replace this paragraph with the class's responsibility and its invariants. State
 * explicitly whether instances own resources (in which case the class should extend
 * `Disposable` and release children through `addDisposable`), and whether the hot-path
 * mutators return `this` so they can be chained without allocating.
 *
 * ```ts
 * const instance = new {{NAME_PASCAL}}({ /* options *\/ });
 * instance.update(delta);
 * ```
 */

/**
 * Options accepted by the {@link {{NAME_PASCAL}}} constructor.
 */
export interface {{NAME_PASCAL}}Options {
  /** Human-readable name used by diagnostics. Defaults to `''`. */
  name?: string;
}

/**
 * One-line summary of the class.
 *
 * A longer explanation goes here when the class needs one: what it does, what it does
 * not do, and any convention a caller has to know.
 */
export class {{NAME_PASCAL}} {
  /** Allows consumers to detect the class without an `instanceof` check. */
  public readonly is{{NAME_PASCAL}} = true;

  /** Diagnostic name. */
  public name: string;

  /** Creates an instance. */
  public constructor(options: {{NAME_PASCAL}}Options = {}) {
    this.name = options.name ?? '';
  }

  /**
   * Advances the instance by `delta`.
   *
   * @param delta Seconds since the previous update.
   * @returns This instance, so calls chain.
   */
  public update(_delta: number): this {
    return this;
  }

  /** Releases anything this instance owns. Idempotent. */
  public dispose(): void {
    /* release owned resources here */
  }
}

/** Convenience factory mirroring the `Vec3`/`Mat4` helpers. */
export function {{NAME_CAMEL}}(options?: {{NAME_PASCAL}}Options): {{NAME_PASCAL}} {
  return new {{NAME_PASCAL}}(options);
}

/** `true` when `value` is a {{NAME_PASCAL}}. */
export function is{{NAME_PASCAL}}(value: unknown): value is {{NAME_PASCAL}} {
  return value instanceof {{NAME_PASCAL}};
}
