/**
 * `FBXLoader` — **honest, documented stub.**
 *
 * ## What this loader actually does
 *
 * 1. Detects the encoding. Binary FBX starts with the 23-byte magic
 *    `Kaydara FBX Binary  \0`; everything else is treated as ASCII.
 * 2. **ASCII:** parses the header records (`FBXHeaderExtension`,
 *    `FBXHeaderVersion`, `FBXVersion`, `Creator`, ...) and the full nested **node
 *    tree** (`Name: prop, prop { child { ... } }`), returning it as
 *    {@link FBXParseResult}. That is genuinely useful — it is enough to inspect a
 *    file's object graph, find `Model`/`Geometry`/`Material` nodes and read their
 *    properties.
 * 3. **Binary:** throws {@link FBXUnsupportedError} with a message naming the version
 *    and explaining precisely what is missing.
 *
 * ## What this loader does **not** do, and will not pretend to
 *
 * It does **not** decode geometry. An ASCII FBX stores vertices in a
 * `Geometry: ... { Vertices: *N { a: 1,2,3,... } }` node whose payload can be
 * deflated (`Geometry: ... , base64, ...`), zlib-compressed, or both, and which uses
 * FBX's own `PolygonVertexIndex` convention where a **negative** index marks the last
 * vertex of a polygon. A binary FBX uses a proprietary record layout with
 * zlib-deflated array properties. Implementing either correctly is a project of its
 * own, and a half-implementation that returns plausible-looking but wrong triangles
 * is worse than a clear error.
 *
 * If you need FBX geometry, convert it offline (`FBX2glTF`, Blender, Assimp) and load
 * the resulting glTF — `GLTFLoader` in this package parses that for real.
 *
 * ```ts
 * const header = new FBXLoader().parseHeader(asciiFbx);   // node tree, no geometry
 * new FBXLoader().parse(binaryFbx, 'model.fbx');            // throws, descriptively
 * ```
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import { Loader, type LoadedSource } from './Loader';
import type { FBXNode, FBXParseResult, FetchLike, LoadOptions } from '../types';

/** Logger shared by the FBX path. */
const log = createLogger('assets:fbx');

/** The 23-byte magic that opens a binary FBX file. */
export const FBX_BINARY_MAGIC = 'Kaydara FBX Binary  \u0000';

/** Error raised for a format this loader does not implement. */
export class FBXUnsupportedError extends Error {
  /** The format that was detected. */
  public readonly detected: 'binary' | 'unknown';

  /** FBX version, when the header exposed one. */
  public readonly version: number | null;

  /**
   * Creates the error.
   *
   * @param detected Detected encoding.
   * @param version Version parsed from the header, when available.
   * @param detail Extra context appended to the message.
   */
  constructor(detected: 'binary' | 'unknown', version: number | null, detail = '') {
    const versionText = version === null ? '' : ` (FBX version ${version})`;
    super(
      `FBXLoader: ${detected === 'binary' ? 'binary' : 'unknown'} FBX${versionText} is not ` +
        'implemented. This loader parses the ASCII FBX header and node tree only; it does ' +
        'not decode geometry, and it will not return incorrect triangles in place of an ' +
        'error. Convert the asset offline (FBX2glTF, Blender, or Assimp) and load the ' +
        'resulting glTF/GLB with GLTFLoader, which is fully implemented in this package.' +
        (detail.length > 0 ? ` ${detail}` : ''),
    );
    this.name = 'FBXUnsupportedError';
    this.detected = detected;
    this.version = version;
  }
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `true` when the bytes open with the binary FBX magic.
 *
 * @param bytes Source bytes.
 * @returns `true` for a binary FBX.
 */
export function isBinaryFBX(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 23) return false;
  const decoder = new TextDecoder('latin1', { fatal: false });
  return decoder.decode(bytes.subarray(0, 23)) === FBX_BINARY_MAGIC;
}

/* -------------------------------------------------------------------------- */
/* ASCII node-tree parser                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Parses the ASCII FBX header records.
 *
 * A header record is the first `;`-delimited block, of the form
 * `; FBX 7.4.0 project file` followed by `FBXHeaderExtension: { ... }`. This function
 * returns the raw text and the version number, which is all most tooling wants.
 *
 * @param source ASCII FBX text.
 * @returns The header text and the version.
 */
export function parseFBXHeader(source: string): { header: string; version: number } {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

  // The header is everything before the first top-level record that is not a comment
  // or a header-extension block.
  const lines = text.split('\n');
  const headerLines: string[] = [];
  let version = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      headerLines.push(line);
      continue;
    }
    if (trimmed.startsWith(';')) {
      // `; FBX 7.4.0 project file` carries the version in the comment.
      const commentVersion = /FBX\s+(\d+)\.(\d+)\.(\d+)/.exec(trimmed);
      if (commentVersion !== null && version === 0) {
        version = Number(commentVersion[1]);
      }
      headerLines.push(line);
      continue;
    }
    if (trimmed.startsWith('FBXHeaderVersion') || trimmed.startsWith('FBXVersion')) {
      const value = Number(trimmed.replace(/[^0-9.]/g, ''));
      if (Number.isFinite(value) && trimmed.startsWith('FBXVersion')) version = Math.floor(value);
      headerLines.push(line);
      continue;
    }
    if (trimmed.startsWith('CreationTime') || trimmed.startsWith('Creator') || trimmed.startsWith('EncryptionType')) {
      headerLines.push(line);
      continue;
    }
    break;
  }

  return { header: headerLines.join('\n'), version };
}

/** Tokenises the ASCII FBX record syntax. */
interface FBXToken {
  /** Token kind. */
  kind: 'identifier' | 'number' | 'string' | 'punct';
  /** Token text. */
  text: string;
}

/** Splits ASCII FBX text into tokens, aware of quotes and comments. */
function tokenize(source: string): FBXToken[] {
  const tokens: FBXToken[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i];

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      i++;
      continue;
    }
    if (char === ';') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (char === '"') {
      let value = '';
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) i++;
        value += source[i];
        i++;
      }
      i++;
      tokens.push({ kind: 'string', text: value });
      continue;
    }
    if (char === '{' || char === '}' || char === ':') {
      tokens.push({ kind: 'punct', text: char });
      i++;
      continue;
    }
    if (char === '*' || char === '-' || char === '+' || (char >= '0' && char <= '9')) {
      // A numeric token, possibly with a trailing `*N` array marker.
      let value = '';
      while (
        i < source.length &&
        (source[i] === '*' ||
          source[i] === '-' ||
          source[i] === '+' ||
          source[i] === '.' ||
          source[i] === 'e' ||
          source[i] === 'E' ||
          (source[i] >= '0' && source[i] <= '9'))
      ) {
        value += source[i];
        i++;
      }
      if (value.length > 0 && value !== '*' && value !== '-' && value !== '+') {
        tokens.push({ kind: 'number', text: value });
        continue;
      }
      // A lone `*` is the array marker: fall through and treat it as punctuation.
      tokens.push({ kind: 'punct', text: '*' });
      continue;
    }

    let identifier = '';
    while (
      i < source.length &&
      source[i] !== ' ' &&
      source[i] !== '\t' &&
      source[i] !== '\n' &&
      source[i] !== '\r' &&
      source[i] !== ',' &&
      source[i] !== '{' &&
      source[i] !== '}' &&
      source[i] !== ':' &&
      source[i] !== '"'
    ) {
      identifier += source[i];
      i++;
    }
    if (identifier.length > 0) {
      tokens.push({ kind: 'identifier', text: identifier });
      continue;
    }
    i++;
  }

  return tokens;
}

/**
 * Parses the ASCII FBX node tree.
 *
 * The grammar is `Name: prop, prop { child { ... } }`, where a property is a bare
 * token, a quoted string, or `<type>: value`. Unknown property syntax is preserved
 * verbatim as a string rather than dropped, so a caller can still see it.
 *
 * @param source ASCII FBX text.
 * @returns The top-level nodes plus the number of nodes visited.
 * @throws FBXUnsupportedError When the source is a binary FBX.
 */
export function parseFBXTree(source: string): { nodes: FBXNode[]; nodeCount: number } {
  const tokens = tokenize(source);

  let cursor = 0;
  let nodeCount = 0;

  /** Parses a property value token. */
  const parseValue = (): string | number | boolean => {
    const token = tokens[cursor];
    if (token === undefined) return '';

    if (token.kind === 'string') {
      cursor++;
      return token.text;
    }
    if (token.kind === 'number') {
      cursor++;
      const value = Number(token.text.replace(/\*.*$/, ''));
      return Number.isFinite(value) ? value : token.text;
    }

    cursor++;
    if (token.text === 'T' || token.text === 'Y') return true;
    if (token.text === 'F' || token.text === 'N') return false;
    return token.text;
  };

  /** Parses one node starting at its identifier. */
  const parseNode = (): FBXNode | null => {
    const nameToken = tokens[cursor];
    if (nameToken === undefined || nameToken.kind !== 'identifier') {
      cursor++;
      return null;
    }
    cursor++;

    const node: FBXNode = { name: nameToken.text, properties: [], children: [] };
    nodeCount++;

    // Optional property list, terminated by `{`, the next node name, or the parent's `}`.
    if (tokens[cursor] !== undefined && tokens[cursor].text === ':') {
      cursor++;

      // A property may have a `Type: value` form; consume the type prefix.
      while (cursor < tokens.length && tokens[cursor].text !== '{' && tokens[cursor].text !== '}') {
        const token = tokens[cursor];
        if (token.kind === 'punct' && (token.text === ':' || token.text === '*')) {
          cursor++;
          continue;
        }
        if (token.kind === 'identifier' && tokens[cursor + 1] !== undefined && tokens[cursor + 1].text === ':') {
          // `<Type>: value` — skip the type marker.
          cursor += 2;
          continue;
        }
        node.properties.push(parseValue());
        if (tokens[cursor] !== undefined && tokens[cursor].text === '{') break;
      }
    }

    if (tokens[cursor] !== undefined && tokens[cursor].text === '{') {
      cursor++;
      while (cursor < tokens.length) {
        if (tokens[cursor].text === '}') {
          cursor++;
          break;
        }
        // A stray `:` at child level (from `Child: {...}`) is consumed here.
        if (tokens[cursor].kind === 'punct' && tokens[cursor].text === ':') {
          cursor++;
          continue;
        }
        const child = parseNode();
        if (child !== null) node.children.push(child);
      }
    }

    return node;
  };

  const nodes: FBXNode[] = [];
  while (cursor < tokens.length) {
    if (tokens[cursor].kind === 'punct') {
      cursor++;
      continue;
    }
    const node = parseNode();
    if (node !== null) nodes.push(node);
  }

  return { nodes, nodeCount };
}

/* -------------------------------------------------------------------------- */
/* Public parse entry point                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Parses an ASCII FBX file's header and node tree.
 *
 * @param source ASCII FBX text, or raw bytes.
 * @returns The header, version and node tree.
 * @throws FBXUnsupportedError When the payload is a binary FBX or unreadable.
 */
export function parseFBX(source: string | ArrayBuffer | Uint8Array): FBXParseResult {
  if (typeof source !== 'string') {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    if (isBinaryFBX(bytes)) {
      // Read the version out of the binary header so the error can name it: bytes
      // 23..27 hold a `uint32` version at offset 23 in most writers.
      let version: number | null = null;
      if (bytes.byteLength >= 27) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        version = view.getUint32(23, true);
      }
      throw new FBXUnsupportedError('binary', version);
    }
    source = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  if (source.startsWith(FBX_BINARY_MAGIC)) {
    throw new FBXUnsupportedError('binary', null);
  }

  const { header, version } = parseFBXHeader(source);
  const { nodes, nodeCount } = parseFBXTree(source);

  if (nodeCount === 0) {
    throw new FBXUnsupportedError(
      'unknown',
      version === 0 ? null : version,
      'No FBX record could be tokenised, so this is neither an ASCII FBX nor a ' +
        'recognised encoding.',
    );
  }

  log.debug(`parsed ASCII FBX with ${nodeCount} nodes (version ${version})`);

  return {
    format: 'ascii',
    version,
    header,
    nodes,
    nodeCount,
  };
}

/* -------------------------------------------------------------------------- */
/* Loader                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Loads ASCII FBX headers and node trees.
 */
export class FBXLoader extends Loader<FBXParseResult, ArrayBuffer | string> {
  /** `fetch` implementation in use. */
  public fetcher: FetchLike | null = null;

  /**
   * Creates an FBX loader.
   *
   * @param options Transport overrides.
   */
  constructor(options: LoadOptions & { fetcher?: FetchLike } = {}) {
    super();
    this.fetcher = options.fetcher ?? null;
  }

  /**
   * Installs a `fetch` implementation.
   *
   * @param fetcher Fetcher, or `null` for the global one.
   * @returns This loader, for chaining.
   */
  public setFetcher(fetcher: FetchLike | null): this {
    this.fetcher = fetcher;
    return this;
  }

  /**
   * @inheritdoc
   */
  protected override async loadData(
    url: string,
    options: LoadOptions,
  ): Promise<LoadedSource<ArrayBuffer>> {
    const fetcher = this.resolveFetcher(options);
    if (fetcher === null) {
      throw new Error(
        `FBXLoader("${url}"): no \`fetch\` implementation is available. Use \`parse()\` on ` +
          'inline data when running on a host without fetch.',
      );
    }

    const response = await fetcher(url, {
      method: 'GET',
      headers: { ...this.requestHeaders },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    if (response.ok === false) {
      throw new Error(`FBXLoader("${url}"): HTTP ${response.status ?? '?'} ${response.statusText ?? ''}`.trim());
    }

    const bytes = await response.arrayBuffer();
    this.reportProgress(url, bytes.byteLength, bytes.byteLength, options);
    return { data: bytes, fromCache: false, byteLength: bytes.byteLength };
  }

  /**
   * @inheritdoc
   *
   * @throws FBXUnsupportedError For a binary payload — deliberately, and with a
   *   message that says so.
   */
  public override parse(
    source: ArrayBuffer | string | Uint8Array,
    url = '<inline>',
  ): FBXParseResult {
    try {
      return parseFBX(source);
    } catch (error) {
      if (error instanceof FBXUnsupportedError) {
        throw new Error(`FBXLoader("${url}"): ${error.message}`);
      }
      throw new Error(
        `FBXLoader("${url}"): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Parses just the header, without building the node tree.
   *
   * @param source ASCII FBX text.
   * @returns The header text and version.
   */
  public parseHeader(source: string): { header: string; version: number } {
    return parseFBXHeader(source);
  }

  /**
   * `true` when the payload is a binary FBX this loader refuses.
   *
   * @param source Bytes to test.
   * @returns `true` for a binary FBX.
   */
  public isBinary(source: ArrayBuffer | Uint8Array): boolean {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    return isBinaryFBX(bytes);
  }

  /** Resolves the `fetch` implementation to use. */
  private resolveFetcher(options: LoadOptions): FetchLike | null {
    const override = (options as { fetcher?: FetchLike }).fetcher;
    if (override !== undefined) return override;
    if (this.fetcher !== null) return this.fetcher;
    const globalFetch = (globalThis as { fetch?: unknown }).fetch;
    return typeof globalFetch === 'function' ? (globalFetch as FetchLike) : null;
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    super.onDispose();
    this.fetcher = null;
  }
}

/**
 * Convenience factory mirroring `new FBXLoader(options)`.
 *
 * @param options Transport overrides.
 * @returns A new FBX loader.
 */
export function fbxLoader(options: LoadOptions & { fetcher?: FetchLike } = {}): FBXLoader {
  return new FBXLoader(options);
}
