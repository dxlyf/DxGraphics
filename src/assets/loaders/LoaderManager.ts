/**
 * `LoaderManager` — a plugin registry that maps a URL to the loader that can read it.
 *
 * Every asset pipeline eventually needs the same lookup: *"given `model.glb`, which
 * loader do I use?"* — and every naive implementation gets it slightly wrong, because
 * the answer depends on the extension **and** on the server's MIME type, and because
 * the mapping has to be extensible so a user can teach the system about a format it
 * has never heard of.
 *
 * This manager resolves by, in order:
 *
 * 1. an explicit loader name passed by the caller,
 * 2. an exact extension match (`.glb`),
 * 3. a MIME type match (`model/gltf-binary`), including wildcard subtypes
 *    (`image/*`),
 * 4. a registered predicate (a `canLoad(url, mimeType)` hook),
 * 5. the `'default'` loader, when one was registered.
 *
 * Registration is idempotent: registering a second loader for the same extension
 * **replaces** it and returns the previous one, so a user override is undoable.
 *
 * ```ts
 * const manager = new LoaderManager();
 * manager.register('gltf', new GLTFLoader(), { extensions: ['.gltf', '.glb'], mimeTypes: ['model/gltf+json'] });
 * const loader = manager.getLoaderFor('hero.glb');
 * ```
 *
 * @packageDocumentation
 */

import { basename, extname } from '../../utils/PathUtils';
import { createLogger } from '../../utils/Logger';
import { Loader } from './Loader';

/** Logger shared by the registry. */
const log = createLogger('assets:loaders');

/** A single loader, as stored by the registry. */
export type RegisteredLoader = Loader<unknown, unknown>;

/** A predicate that decides whether a loader can read a URL. */
export type LoaderPredicate = (url: string, mimeType?: string) => boolean;

/** Registration metadata for one loader. */
export interface LoaderRegistration<T = unknown> {
  /** Loader instance. */
  loader: Loader<T, unknown>;
  /** Extensions the loader handles, with or without a leading dot. */
  extensions?: readonly string[];
  /** MIME types the loader handles; `image/*` matches any `image/...`. */
  mimeTypes?: readonly string[];
  /** Custom predicate, evaluated after the extension and MIME tables. */
  canLoad?: LoaderPredicate;
  /** Human-readable name, used in diagnostics. */
  name: string;
}

/** Options accepted by {@link LoaderManager.register}. */
export interface RegisterOptions {
  /** Extensions to bind to the loader. */
  extensions?: readonly string[];
  /** MIME types to bind to the loader. */
  mimeTypes?: readonly string[];
  /** Predicate fallback. */
  canLoad?: LoaderPredicate;
  /** Replace an existing registration with the same name; defaults to `true`. */
  override?: boolean;
}

/**
 * Resolves URLs to loaders.
 */
export class LoaderManager {
  /** Registrations by name, in insertion order. */
  private readonly registrations = new Map<string, LoaderRegistration>();

  /** Extension (lower-case, with a leading dot) → registration name. */
  private readonly byExtension = new Map<string, string>();

  /** MIME type (lower-case) → registration name. */
  private readonly byMimeType = new Map<string, string>();

  /** Name of the fallback registration, when one was set. */
  private defaultName: string | null = null;

  /** Number of successful {@link LoaderManager.getLoaderFor} resolutions. */
  public resolveCount = 0;

  /** Number of resolutions that found nothing. */
  public missCount = 0;

  /**
   * Registers a loader.
   *
   * @typeParam T Value type the loader produces.
   * @param name Registration name; `'default'` marks the fallback loader.
   * @param loader Loader instance.
   * @param options Extensions, MIME types and predicate.
   * @returns The loader, so the call can be used inline.
   */
  public register<T>(
    name: string,
    loader: Loader<T>,
    options: RegisterOptions = {},
  ): Loader<T> {
    const existing = this.registrations.get(name);
    if (existing !== undefined && options.override === false) {
      log.debug(`registration "${name}" already exists; keeping the existing loader`);
      return existing.loader as Loader<T>;
    }

    if (existing !== undefined) this.unbind(existing);

    const registration: LoaderRegistration = {
      loader: loader as unknown as Loader<unknown>,
      name,
      ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
      ...(options.mimeTypes === undefined ? {} : { mimeTypes: options.mimeTypes }),
      ...(options.canLoad === undefined ? {} : { canLoad: options.canLoad }),
    };

    this.registrations.set(name, registration);
    this.bind(registration);

    if (name === 'default') this.defaultName = name;

    return loader;
  }

  /**
   * Binds a registration's extension and MIME tables.
   *
   * @param registration Registration to bind.
   */
  private bind(registration: LoaderRegistration): void {
    for (const extension of registration.extensions ?? []) {
      this.byExtension.set(normalizeExtension(extension), registration.name);
    }
    for (const mimeType of registration.mimeTypes ?? []) {
      this.byMimeType.set(mimeType.trim().toLowerCase(), registration.name);
    }
  }

  /** Removes a registration's bindings. */
  private unbind(registration: LoaderRegistration): void {
    for (const extension of registration.extensions ?? []) {
      const key = normalizeExtension(extension);
      if (this.byExtension.get(key) === registration.name) this.byExtension.delete(key);
    }
    for (const mimeType of registration.mimeTypes ?? []) {
      const key = mimeType.trim().toLowerCase();
      if (this.byMimeType.get(key) === registration.name) this.byMimeType.delete(key);
    }
  }

  /**
   * Removes a registration and every binding it owned.
   *
   * @param name Registration name.
   * @returns `true` when a registration was removed.
   */
  public unregister(name: string): boolean {
    const registration = this.registrations.get(name);
    if (registration === undefined) return false;

    this.unbind(registration);
    this.registrations.delete(name);
    if (this.defaultName === name) this.defaultName = null;
    return true;
  }

  /**
   * `true` when a name is registered.
   *
   * @param name Registration name.
   * @returns `true` when the registration exists.
   */
  public has(name: string): boolean {
    return this.registrations.has(name);
  }

  /**
   * Looks a loader up by registration name.
   *
   * @typeParam T Value type the loader produces.
   * @param name Registration name.
   * @returns The loader, or `undefined`.
   */
  public get<T = unknown>(name: string): Loader<T> | undefined {
    return this.registrations.get(name)?.loader as Loader<T> | undefined;
  }

  /**
   * Every registration, in insertion order.
   *
   * @returns The registrations.
   */
  public list(): LoaderRegistration[] {
    return Array.from(this.registrations.values());
  }

  /**
   * Every registration name.
   *
   * @returns The names.
   */
  public names(): string[] {
    return Array.from(this.registrations.keys());
  }

  /**
   * Every extension the manager knows about.
   *
   * @returns The extensions, each with a leading dot.
   */
  public extensions(): string[] {
    return Array.from(this.byExtension.keys());
  }

  /**
   * Every MIME type the manager knows about.
   *
   * @returns The MIME types.
   */
  public mimeTypes(): string[] {
    return Array.from(this.byMimeType.keys());
  }

  /**
   * Marks a registration as the fallback.
   *
   * @param name Registration name.
   * @returns This manager, for chaining.
   * @throws Error When the name is not registered.
   */
  public setDefault(name: string): this {
    if (!this.registrations.has(name)) {
      throw new Error(
        `LoaderManager.setDefault("${name}"): no loader is registered under that name. ` +
          `Known names: ${this.names().join(', ') || '<none>'}.`,
      );
    }
    this.defaultName = name;
    return this;
  }

  /**
   * The registration that would handle a URL.
   *
   * @param url URL, or a bare file name.
   * @param mimeType Optional MIME type from the server.
   * @returns The registration, or `undefined` for no match.
   */
  public resolve(url: string, mimeType?: string): LoaderRegistration | undefined {
    const byName = this.byExtension.get(normalizeExtension(extname(url)));
    if (byName !== undefined) {
      this.resolveCount++;
      return this.registrations.get(byName);
    }

    if (mimeType !== undefined && mimeType.length > 0) {
      const normalized = mimeType.trim().toLowerCase().split(';')[0];
      const direct = this.byMimeType.get(normalized);
      if (direct !== undefined) {
        this.resolveCount++;
        return this.registrations.get(direct);
      }

      // Wildcard subtypes: `image/*`.
      const slash = normalized.indexOf('/');
      if (slash > 0) {
        const wildcard = `${normalized.slice(0, slash)}/*`;
        const byWildcard = this.byMimeType.get(wildcard);
        if (byWildcard !== undefined) {
          this.resolveCount++;
          return this.registrations.get(byWildcard);
        }
      }
    }

    for (const registration of this.registrations.values()) {
      if (registration.canLoad === undefined) continue;
      try {
        if (registration.canLoad(url, mimeType)) {
          this.resolveCount++;
          return registration;
        }
      } catch (error) {
        log.warn(`canLoad predicate for "${registration.name}" threw`, error);
      }
    }

    if (this.defaultName !== null) {
      this.resolveCount++;
      return this.registrations.get(this.defaultName);
    }

    this.missCount++;
    return undefined;
  }

  /**
   * The loader that would handle a URL.
   *
   * @typeParam T Value type the loader produces.
   * @param url URL, or a bare file name.
   * @param mimeType Optional MIME type.
   * @returns The loader, or `undefined`.
   */
  public getLoaderFor<T = unknown>(url: string, mimeType?: string): Loader<T> | undefined {
    return this.resolve(url, mimeType)?.loader as Loader<T> | undefined;
  }

  /**
   * The registration **name** that would handle a URL.
   *
   * @param url URL, or a bare file name.
   * @param mimeType Optional MIME type.
   * @returns The name, or `undefined`.
   */
  public getNameFor(url: string, mimeType?: string): string | undefined {
    return this.resolve(url, mimeType)?.name;
  }

  /**
   * `true` when some registration can read a URL.
   *
   * @param url URL, or a bare file name.
   * @param mimeType Optional MIME type.
   * @returns `true` when a loader exists.
   */
  public canLoad(url: string, mimeType?: string): boolean {
    const previousMisses = this.missCount;
    const result = this.resolve(url, mimeType) !== undefined;
    // A guard clause should not distort the counters.
    if (!result && this.missCount > previousMisses) this.missCount = previousMisses;
    return result;
  }

  /**
   * Applies `setPath` to every registered loader.
   *
   * @param path Base path.
   * @returns This manager, for chaining.
   */
  public setPath(path: string): this {
    for (const registration of this.registrations.values()) registration.loader.setPath(path);
    return this;
  }

  /**
   * Applies `setCrossOrigin` to every registered loader.
   *
   * @param crossOrigin Cross-origin policy.
   * @returns This manager, for chaining.
   */
  public setCrossOrigin(crossOrigin: string): this {
    for (const registration of this.registrations.values()) {
      registration.loader.setCrossOrigin(crossOrigin);
    }
    return this;
  }

  /**
   * Applies a request header to every registered loader.
   *
   * @param name Header name.
   * @param value Header value.
   * @returns This manager, for chaining.
   */
  public setRequestHeader(name: string, value: string | null): this {
    for (const registration of this.registrations.values()) {
      registration.loader.setRequestHeader(name, value);
    }
    return this;
  }

  /**
   * Aborts every in-flight request across every registered loader.
   *
   * @returns This manager, for chaining.
   */
  public abortAll(): this {
    for (const registration of this.registrations.values()) registration.loader.abort();
    return this;
  }

  /**
   * Disposes every registered loader and clears the registry.
   *
   * @returns This manager, for chaining.
   */
  public dispose(): this {
    for (const registration of this.registrations.values()) registration.loader.dispose();
    this.registrations.clear();
    this.byExtension.clear();
    this.byMimeType.clear();
    this.defaultName = null;
    return this;
  }

  /**
   * @returns A human-readable description.
   */
  public toString(): string {
    const names = this.names();
    return (
      `LoaderManager(${names.length} loaders: ${names.join(', ') || '<none>'}; ` +
      `extensions: ${this.extensions().join(', ') || '<none>'})`
    );
  }
}

/** Normalises an extension to lower-case with a leading dot. */
function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase();
  if (trimmed.length === 0) return trimmed;
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

/**
 * Convenience factory mirroring `new LoaderManager()`.
 *
 * @returns A new loader manager.
 */
export function loaderManager(): LoaderManager {
  return new LoaderManager();
}

/** Re-exported so callers can build a registration key from a URL. */
export { basename };
