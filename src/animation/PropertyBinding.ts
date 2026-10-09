/**
 * `PropertyBinding` — resolves a track name to a live property on a scene object.
 *
 * The grammar is three.js' exactly:
 *
 * ```
 * nodeName.propertyName[subscript].propertyName[subscript]...
 * ```
 *
 * | Track name                      | Resolves to                                |
 * | ------------------------------- | ------------------------------------------ |
 * | `Cube.position`                 | `root.getObjectByName('Cube').position`    |
 * | `.position.x`                   | `root.position.x` (leading `.` = the root) |
 * | `Cube.material.color.r`         | one channel of the material colour         |
 * | `Mesh.morphTargetInfluences[2]` | the third morph weight                     |
 * | `Rig.bones[4].quaternion`       | bone 4's quaternion                        |
 * | `.bones[hand].position`         | bone found by **name** inside `bones`      |
 *
 * Parsing is strict: an empty track name, an unterminated or empty subscript, a
 * subscript before any property name, a trailing `.` and a doubled `..` all raise
 * a {@link PropertyBindingError} naming the offending offset. Resolution is lazy:
 * a binding that cannot resolve yet (the object has not been added to the graph)
 * reports `null` from {@link PropertyBinding.getValue} instead of throwing when it
 * is constructed, because a mixer creates bindings for every clip long before the
 * objects exist.
 *
 * @packageDocumentation
 */

import type { ParsedPath, ParsedPathNode, ParsedTrackName } from './types';

/** Error thrown for a malformed track name. */
export class PropertyBindingError extends Error {
  /** The track name that failed. */
  public readonly trackName: string;

  /** Character offset inside the track name, when the failure was syntactic. */
  public readonly offset: number | undefined;

  /**
   * Creates a binding error.
   *
   * @param message Human-readable explanation.
   * @param trackName The track name that failed.
   * @param offset Character offset for syntax errors.
   */
  constructor(message: string, trackName: string, offset?: number) {
    super(message);
    this.name = 'PropertyBindingError';
    this.trackName = trackName;
    this.offset = offset;
  }
}

/**
 * Sentinel `index` marking a *named* subscript such as `bones[hand]`.
 *
 * A real array access can never be negative, so `-2` unambiguously means "the
 * bracket held an identifier, which is stored in {@link ParsedPathNode.name2}".
 */
export const NAME_INDEX_SENTINEL = -2;

/** Sentinel `index` meaning "this step is a plain property, not a subscript". */
export const NO_INDEX = -1;

/* -------------------------------------------------------------------------- */
/* Track-name parser                                                          */
/* -------------------------------------------------------------------------- */

/** Characters that terminate a bare property name. */
function isTerminator(char: string): boolean {
  return char === '.' || char === '[' || char === ']' || char === ' ' || char === '\t';
}

/** Renders one path step back into dotted/bracketed form. */
function renderStep(node: ParsedPathNode): string {
  if (node.index === NAME_INDEX_SENTINEL && node.name2 !== undefined) {
    return `.${node.name}[${node.name2}]`;
  }
  if (node.index >= 0) return `.${node.name}[${node.index}]`;
  return `.${node.name}`;
}

/**
 * Parses a track name into its node and property path.
 *
 * @param trackName Track name in the standard grammar.
 * @returns The parsed node name, the dotted object path and the structured path.
 * @throws PropertyBindingError When the name is empty or malformed.
 */
export function parseTrackName(trackName: string): ParsedTrackName {
  if (typeof trackName !== 'string') {
    throw new PropertyBindingError(
      `PropertyBinding: track name must be a string, received ${typeof trackName}`,
      String(trackName),
    );
  }
  const source = trackName;
  if (source.length === 0) {
    throw new PropertyBindingError(
      'PropertyBinding: track name is empty. Expected "objectName.property" or ".property".',
      source,
    );
  }

  let i = 0;
  const relative = source[0] === '.';

  // ---- node name ----------------------------------------------------------
  let nodeName = '';
  if (!relative) {
    const start = i;
    while (i < source.length && !isTerminator(source[i])) i++;
    nodeName = source.slice(start, i);
    if (nodeName.length === 0) {
      throw new PropertyBindingError(
        `PropertyBinding: track name "${source}" must start with an object name or ".".`,
        source,
        0,
      );
    }
    if (i >= source.length) {
      throw new PropertyBindingError(
        `PropertyBinding: track name "${source}" names an object but no property. ` +
          'Expected "objectName.propertyName".',
        source,
        i,
      );
    }
  } else {
    i = 1;
    if (i >= source.length) {
      throw new PropertyBindingError(
        `PropertyBinding: track name "${source}" is only a "."; a property name must follow.`,
        source,
        0,
      );
    }
  }

  // ---- property path ------------------------------------------------------
  const nodes: ParsedPathNode[] = [];
  const remaining = source.slice(i);
  let search = 0;

  while (search < remaining.length) {
    const char = remaining[search];

    if (char === '.') {
      if (search === 0) {
        // The separator that follows the node name lands at index 0 of the remainder, so a
        // leading dot is expected here rather than an error.
        search++;
        if (search >= remaining.length) {
          throw new PropertyBindingError(
            `PropertyBinding: track name "${source}" ends with "."; a property name must follow.`,
            source,
            i + search,
          );
        }
        continue;
      }
      search++;
      if (search >= remaining.length) {
        throw new PropertyBindingError(
          `PropertyBinding: track name "${source}" ends with "."; a property name must follow.`,
          source,
          i + search,
        );
      }
      if (remaining[search] === '.') {
        throw new PropertyBindingError(
          `PropertyBinding: track name "${source}" has an empty path step at offset ${i + search}.`,
          source,
          i + search,
        );
      }
      continue;
    }

    if (char === ']') {
      throw new PropertyBindingError(
        `PropertyBinding: track name "${source}" has a stray "]" at offset ${i + search}.`,
        source,
        i + search,
      );
    }

    if (char === '[') {
      throw new PropertyBindingError(
        `PropertyBinding: track name "${source}" starts a path step with "[" at offset ` +
          `${i + search}; a property name must precede it.`,
        source,
        i + search,
      );
    }

    const nameStart = search;
    while (search < remaining.length && !isTerminator(remaining[search])) search++;
    const name = remaining.slice(nameStart, search);

    const step: ParsedPathNode = { name, index: NO_INDEX };

    if (search < remaining.length && remaining[search] === '[') {
      const open = search;
      search++;
      const closed = remaining.indexOf(']', search);
      if (closed < 0) {
        throw new PropertyBindingError(
          `PropertyBinding: track name "${source}" has an unterminated "[" at offset ${i + open}.`,
          source,
          i + open,
        );
      }
      const token = remaining.slice(search, closed).trim();
      if (token.length === 0) {
        throw new PropertyBindingError(
          `PropertyBinding: track name "${source}" has an empty subscript at offset ${i + open}.`,
          source,
          i + open,
        );
      }
      if (/^-?\d+$/.test(token)) {
        step.index = Number.parseInt(token, 10);
      } else {
        step.index = NAME_INDEX_SENTINEL;
        step.name2 = token;
      }
      search = closed + 1;

      // A subscript must be followed by `.` or the end of the name.
      if (search < remaining.length && remaining[search] !== '.') {
        throw new PropertyBindingError(
          `PropertyBinding: track name "${source}" has unexpected "${remaining[search]}" after ` +
            `"]" at offset ${i + search}; expected "." or the end of the name.`,
          source,
          i + search,
        );
      }
    }

    nodes.push(step);
  }

  if (nodes.length === 0) {
    throw new PropertyBindingError(
      `PropertyBinding: track name "${source}" has no property path. ` +
        'Expected "objectName.propertyName".',
      source,
    );
  }

  const objectName = nodes
    .map((node) => renderStep(node).slice(1))
    .join('.')
    .replace(/\[(\d+)\]/g, '[$1]');

  const parsedPath: ParsedPath = { nodes, original: source };
  return { nodeName, objectName, parsedPath, relative };
}

/**
 * `true` when the track name parses without error.
 *
 * @param trackName Candidate track name.
 * @returns `true` when {@link parseTrackName} would succeed.
 */
export function isValidTrackName(trackName: string): boolean {
  try {
    parseTrackName(trackName);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* PropertyBinding                                                            */
/* -------------------------------------------------------------------------- */

/** How a binding locates its target object inside the mixer root. */
export type BindingSearchMode = 'name' | 'uuid' | 'id';

/** Options accepted by the {@link PropertyBinding} constructor. */
export interface PropertyBindingOptions {
  /**
   * Access the property directly on the supplied object instead of resolving a
   * node name inside it. `AnimationMixer.clipAction(root)` uses this when the
   * caller already knows the target.
   */
  direct?: boolean;
  /** How to search for the node; defaults to `'name'`. */
  searchMode?: BindingSearchMode;
}

/** One resolved step of a binding's property path. */
export interface BindingFrame {
  /** Property name at this step. */
  name: string;
  /** Array subscript at this step: `-1` none, `>= 0` numeric, `-2` named. */
  index: number;
  /** The value found at this step. */
  object: unknown;
}

/**
 * A parsed, resolvable reference from a track name to a live property.
 *
 * ```ts
 * const binding = new PropertyBinding(mesh, '.scale.x');
 * binding.setValue([2]);          // mesh.scale.x = 2
 * binding.getValue();             // [2]
 * ```
 */
export class PropertyBinding {
  /** The root the binding searches. */
  public readonly rootObject: unknown;

  /** The raw track name. */
  public readonly trackName: string;

  /** Node name portion of the track name, or `''` for a root-relative binding. */
  public readonly nodeName: string;

  /** Dotted property path, e.g. `'material.color.r'`. */
  public readonly objectName: string;

  /** Structured property path. */
  public readonly parsedPath: ParsedPath;

  /** `true` when the track name began with `.`. */
  public readonly relativePath: boolean;

  /** How the target node is located. */
  public readonly searchMode: BindingSearchMode;

  /** `true` when the binding writes straight onto {@link rootObject}. */
  public readonly direct: boolean;

  /**
   * Number of components the last {@link PropertyBinding.getValue} read.
   *
   * The mixer uses this to size its blend buffer without asking the track.
   */
  public valueSize = 0;

  /**
   * Creates a binding.
   *
   * @param rootObject Root node the binding searches; also the target when
   *   `options.direct` is set.
   * @param trackName Track name in the standard grammar.
   * @param options Search/direct-access flags.
   * @throws PropertyBindingError When the track name is malformed.
   */
  constructor(rootObject: unknown, trackName: string, options: PropertyBindingOptions = {}) {
    const parsed = parseTrackName(trackName);
    this.rootObject = rootObject;
    this.trackName = trackName;
    this.nodeName = parsed.nodeName;
    this.objectName = parsed.objectName;
    this.parsedPath = parsed.parsedPath;
    this.relativePath = parsed.relative;
    this.searchMode = options.searchMode ?? 'name';
    this.direct = options.direct ?? false;
  }

  /**
   * Builds a binding, or returns `null` when the track name is malformed.
   *
   * The non-throwing counterpart of the constructor, for callers that prefer to
   * skip tracks they do not understand rather than fail the whole clip.
   *
   * @param rootObject Root node.
   * @param trackName Track name.
   * @param options Search/direct-access flags.
   * @returns The binding, or `null`.
   */
  public static tryCreate(
    rootObject: unknown,
    trackName: string,
    options: PropertyBindingOptions = {},
  ): PropertyBinding | null {
    try {
      return new PropertyBinding(rootObject, trackName, options);
    } catch {
      return null;
    }
  }

  /* --------------------------------------------------------------- resolve */

  /**
   * Finds the object the path starts from.
   *
   * `name` uses a breadth-first search that skips invisible subtrees, matching
   * three.js; `uuid`/`id` exist for callers with unstable names. A root-relative
   * track (leading `.`) resolves to the root itself.
   *
   * @returns The target object, or `null` when it is not in the graph.
   */
  public findNode(): Record<string, unknown> | null {
    const root = this.rootObject as Record<string, unknown> | null | undefined;
    if (root == null) return null;
    if (this.direct || this.relativePath || this.nodeName.length === 0) return root;

    const children = root.children;
    if (Array.isArray(children) && children.length > 0) {
      const found = this.searchBreadthFirst(children as Record<string, unknown>[]);
      if (found) return found;
    }

    return this.matches(root, this.nodeName) ? root : null;
  }

  /** Breadth-first search over `children`, honouring `visible === false`. */
  private searchBreadthFirst(start: Record<string, unknown>[]): Record<string, unknown> | null {
    const queue: Record<string, unknown>[] = start.slice();
    let head = 0;
    while (head < queue.length) {
      const child = queue[head++];
      if (child == null) continue;
      if (child.visible === false) continue;
      if (this.matches(child, this.nodeName)) return child;
      const nested = child.children;
      if (Array.isArray(nested) && nested.length > 0) {
        for (const grandchild of nested as Record<string, unknown>[]) queue.push(grandchild);
      }
    }
    return null;
  }

  /** `true` when `candidate` matches the node name under the active search mode. */
  private matches(candidate: Record<string, unknown>, name: string): boolean {
    switch (this.searchMode) {
      case 'uuid':
        return candidate.uuid === name;
      case 'id':
        return candidate.id === name;
      case 'name':
      default:
        return candidate.name === name;
    }
  }

  /**
   * Resolves the chain of objects the binding's path walks through.
   *
   * @returns One frame per path step, or `null` when any step is missing.
   */
  public resolvePath(): BindingFrame[] | null {
    const node = this.findNode();
    if (node === null) return null;

    const frames: BindingFrame[] = [];
    let object: unknown = node;

    for (const step of this.parsedPath.nodes) {
      if (object == null || (typeof object !== 'object' && typeof object !== 'function')) return null;

      const container = object as Record<string, unknown>;
      const property = container[step.name];
      if (property === undefined && !(step.name in container)) return null;

      frames.push({ name: step.name, index: step.index, object: property });
      object = property;

      if (step.index === NAME_INDEX_SENTINEL) {
        // `bones[hand]`: the property must be an array of objects carrying `name`.
        if (!Array.isArray(object)) return null;
        const found = findByBoneName(object, step.name2 ?? '');
        if (found === undefined) return null;
        frames.push({ name: step.name2 ?? '', index: NAME_INDEX_SENTINEL, object: found });
        object = found;
      } else if (step.index >= 0) {
        if (!isIndexable(object)) return null;
        const indexed = (object as ArrayLike<unknown>)[step.index];
        if (indexed === undefined) return null;
        frames.push({ name: String(step.index), index: step.index, object: indexed });
        object = indexed;
      }
    }

    return frames;
  }

  /* ------------------------------------------------------------ accessors */

  /**
   * Reads the bound value.
   *
   * Scalars are returned as one-element arrays so every track shares one code path. Objects
   * are read through `toArray`/`fromArray`-style accessors when they expose one, and through
   * the conventional component names (`x`/`y`/`z`/`w`, `r`/`g`/`b`/`a`) otherwise, which is
   * what lets a `Vec3`-, `Color`- or `Quat`-valued property be animated.
   *
   * @returns The current value, or `null` when the binding does not resolve or the value has
   *   no readable components.
   */
  public getValue(): ArrayLike<number> | null {
    const frames = this.resolvePath();
    if (frames === null || frames.length === 0) return null;

    const value = frames[frames.length - 1].object;
    const components = readComponents(value);
    if (components === null) return null;

    this.valueSize = components.length;
    return components;
  }

  /**
   * Writes the bound value.
   *
   * Numbers are assigned directly. Objects are written through `fromArray`, a numeric array
   * copy, `setRgb`, or the conventional component names as a last resort.
   *
   * @param buffer Value to write, one component per element.
   * @returns `true` when a value was written.
   */
  public setValue(buffer: ArrayLike<number>): boolean {
    const target = this.getTarget();
    if (target === null) return false;

    const { object, key } = target;
    const destination = object[key];

    if (typeof destination === 'number') {
      object[key] = buffer[0];
      return true;
    }
    if (typeof destination === 'boolean') {
      object[key] = buffer[0] !== 0;
      return true;
    }

    if (destination == null) {
      object[key] = Array.from(buffer as ArrayLike<number>);
      return true;
    }

    if (typeof destination !== 'object') return false;

    const writable = destination as {
      fromArray?: (array: ArrayLike<number>) => unknown;
      setRgb?: (r: number, g: number, b: number, a?: number) => unknown;
      set?: (...values: number[]) => unknown;
    };

    if (typeof writable.fromArray === 'function') {
      writable.fromArray(buffer);
      return true;
    }

    if (ArrayBuffer.isView(destination) || Array.isArray(destination)) {
      const array = destination as unknown as { length: number; [index: number]: number };
      const count = Math.min(array.length, buffer.length);
      for (let i = 0; i < count; i++) array[i] = buffer[i];
      return true;
    }

    const count = Math.min(buffer.length, COMPONENT_KEYS.length);
    if (count === 0) return false;

    if (count === 4 && typeof writable.setRgb === 'function') {
      writable.setRgb(buffer[0], buffer[1], buffer[2], buffer[3]);
      return true;
    }

    // Assign the conventional component names directly. This is the path a `Color`, a `Vec3`
    // and a `Quat` all take, and it keeps the binding free of imports from `src/math`.
    const record = destination as Record<string, unknown>;
    let written = 0;
    for (let i = 0; i < count; i++) {
      const componentKey = COMPONENT_KEYS[i];
      const current = record[componentKey];
      if (typeof current !== 'number' && current !== undefined) continue;
      record[componentKey] = buffer[i];
      written++;
    }
    return written > 0;
  }

  /**
   * The container object and key the binding ultimately writes.
   *
   * Exposed so `AnimationAction` can read a track's current value for additive
   * blending without materialising a fresh binding per frame.
   *
   * @returns `{ object, key }`, or `null` when the binding does not resolve.
   */
  public getTarget(): { object: Record<string, unknown>; key: string } | null {
    const frames = this.resolvePath();
    if (frames === null || frames.length === 0) return null;

    // The last frame holds the *value*; the one before it holds the container.
    // For a single-step path (`Cube.opacity`) the container is the node itself.
    const last = frames[frames.length - 1];
    const containerIndex = frames.length - 2;
    const container =
      containerIndex >= 0 ? frames[containerIndex].object : (this.findNode() as unknown);

    if (container == null || typeof container !== 'object') return null;
    return { object: container as Record<string, unknown>, key: last.name };
  }

  /**
   * `true` when the binding currently resolves to a readable property.
   *
   * @returns `true` when {@link PropertyBinding.getValue} would succeed.
   */
  public isResolvable(): boolean {
    return this.resolvePath() !== null;
  }

  /**
   * @returns A human-readable description, e.g.
   *   `PropertyBinding(".position.x" -> "Cube" + "position.x")`.
   */
  public toString(): string {
    return `PropertyBinding("${this.trackName}" -> "${this.nodeName}" + "${this.objectName}")`;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** `true` when `value` can be indexed with a numeric subscript. */
function isIndexable(value: unknown): boolean {
  if (value == null || typeof value !== 'object') return false;
  return Array.isArray(value) || ArrayBuffer.isView(value);
}

/**
 * The component names a vector/colour/quaternion-valued property is read and written
 * through, in the order the components occupy a track.
 */
const COMPONENT_KEYS: readonly string[] = ['x', 'y', 'z', 'w'];

/** The same, for an RGBA-valued property. */
const RGBA_KEYS: readonly string[] = ['r', 'g', 'b', 'a'];

/**
 * Reads numeric components from a scalar or an object-valued property.
 *
 * @param value Value to read.
 * @returns The components, or `null` when none could be read.
 */
function readComponents(value: unknown): ArrayLike<number> | null {
  if (typeof value === 'number') return [value];
  if (typeof value === 'boolean') return [value ? 1 : 0];
  if (value == null || typeof value !== 'object') return null;

  if (ArrayBuffer.isView(value)) return value as unknown as ArrayLike<number>;
  if (Array.isArray(value)) {
    if (value.length === 0) return value as number[];
    return typeof value[0] === 'number' ? (value as number[]) : null;
  }

  // A `toArray`-style accessor wins when present.
  const withToArray = value as { toArray?: () => number[] };
  if (typeof withToArray.toArray === 'function') {
    const array = withToArray.toArray();
    if (Array.isArray(array) && array.length > 0) return array;
  }

  const record = value as Record<string, unknown>;

  // A colour-shaped object: `r`/`g`/`b` are present and numeric.
  if (typeof record.r === 'number' && typeof record.g === 'number' && typeof record.b === 'number') {
    const alpha = typeof record.a === 'number' ? record.a : 1;
    return [record.r, record.g, record.b, alpha];
  }

  // A vector/quaternion-shaped object.
  if (typeof record.x === 'number' && typeof record.y === 'number') {
    if (typeof record.z !== 'number') return [record.x, record.y];
    if (typeof record.w !== 'number') return [record.x, record.y, record.z];
    return [record.x, record.y, record.z, record.w];
  }

  return null;
}

/** `true` when `value` is a numeric array-like carrying a `length`. */
function isNumericArrayLike(value: unknown): value is ArrayLike<number> {
  if (value == null || typeof value !== 'object') return false;
  if (ArrayBuffer.isView(value)) return true;
  if (!Array.isArray(value)) return false;
  return value.length === 0 || typeof value[0] === 'number';
}

/**
 * Finds an entry of `list` whose `name` equals `name`.
 *
 * @param list Array of bone-like objects.
 * @param name Bone name to match.
 * @returns The matching entry, or `undefined`.
 */
export function findByBoneName(
  list: readonly unknown[],
  name: string,
): Record<string, unknown> | undefined {
  for (const entry of list) {
    if (entry == null || typeof entry !== 'object') continue;
    if ((entry as { name?: unknown }).name === name) return entry as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Convenience factory mirroring `new PropertyBinding(root, name, options)`.
 *
 * @param rootObject Root node.
 * @param trackName Track name.
 * @param options Search/direct-access flags.
 * @returns A new binding.
 */
export function propertyBinding(
  rootObject: unknown,
  trackName: string,
  options: PropertyBindingOptions = {},
): PropertyBinding {
  return new PropertyBinding(rootObject, trackName, options);
}
