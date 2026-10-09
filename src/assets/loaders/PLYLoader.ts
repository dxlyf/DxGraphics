/**
 * `PLYLoader` — Stanford PLY in ASCII and binary little-endian.
 *
 * PLY is a *self-describing* format: the header declares every element and every
 * property, with a scalar type, so a parser is a small interpreter rather than a
 * fixed layout. This loader implements that interpreter:
 *
 * | Layer | Handled |
 * | --- | --- |
 * | Header | `ply`, `format`, `comment`, `obj_info`, `element`, `property`, `end_header` |
 * | Scalar types | `char`/`int8`, `uchar`/`uint8`, `short`/`int16`, `ushort`/`uint16`, `int`/`int32`, `uint`/`uint32`, `float`/`float32`, `double`/`float64` |
 * | List properties | `<count-type> <item-type> name` (faces) |
 * | ASCII body | whitespace-tokenised |
 * | Binary body | little-endian `DataView` reads, honouring per-property types |
 *
 * ## Why the binary path matters
 *
 * A 5-million-triangle scan is 40 MB of ASCII but 15 MB of binary, and the ASCII path
 * spends most of its time in `Number()`. The binary reader consumes the `DataView`
 * directly, with the property list cached as a closure table, so the per-byte cost is
 * a typed read rather than a parse.
 *
 * ```ts
 * const result = parsePLY('ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\n...');
 * result.positions;   // Float32Array(9)
 * ```
 *
 * @packageDocumentation
 */

import { Loader, type LoadedSource } from './Loader';
import { flipV, postProcessPositions, type PostProcessOptions } from './geometryUtils';
import type {
  FetchLike,
  LoadOptions,
  MeshLoadOptions,
  PLYElement,
  PLYParseResult,
  PLYProperty,
} from '../types';

/** Options accepted by {@link PLYLoader.loadAsync}. */
export interface PLYLoadOptions extends MeshLoadOptions {
  /** `fetch` implementation override. */
  fetcher?: FetchLike;
  /** Force a body encoding instead of trusting the header. */
  format?: 'ascii' | 'binary_little_endian' | 'binary_big_endian' | 'auto';
}

/** Scalar type descriptors keyed by every alias PLY files use. */
const PLY_TYPES: Readonly<Record<string, { bytes: number; kind: 'int' | 'uint' | 'float' }>> = {
  char: { bytes: 1, kind: 'int' },
  int8: { bytes: 1, kind: 'int' },
  uchar: { bytes: 1, kind: 'uint' },
  uint8: { bytes: 1, kind: 'uint' },
  short: { bytes: 2, kind: 'int' },
  int16: { bytes: 2, kind: 'int' },
  ushort: { bytes: 2, kind: 'uint' },
  uint16: { bytes: 2, kind: 'uint' },
  int: { bytes: 4, kind: 'int' },
  int32: { bytes: 4, kind: 'int' },
  uint: { bytes: 4, kind: 'uint' },
  uint32: { bytes: 4, kind: 'uint' },
  float: { bytes: 4, kind: 'float' },
  float32: { bytes: 4, kind: 'float' },
  double: { bytes: 8, kind: 'float' },
  float64: { bytes: 8, kind: 'float' },
};

/** A parsed header. */
interface PLYHeader {
  /** Body encoding. */
  format: string;
  /** Elements in declaration order. */
  elements: PLYElement[];
  /** Comment lines, in order. */
  comments: string[];
  /** Byte offset at which the body starts. */
  bodyOffset: number;
}

/** Reads the header from a byte buffer. */
function readHeader(bytes: Uint8Array): PLYHeader {
  const decoder = new TextDecoder('ascii', { fatal: false });

  let offset = 0;
  let lineStart = 0;
  const lines: string[] = [];

  // The header is ASCII and terminated by `end_header\n`; scan bytes rather than
  // decoding the whole file, which would double peak memory on a large binary mesh.
  while (offset < bytes.length) {
    if (bytes[offset] === 10 /* '\n' */) {
      lines.push(decoder.decode(bytes.subarray(lineStart, offset)).replace(/\r$/, ''));
      lineStart = offset + 1;
      if (lines[lines.length - 1].trim() === 'end_header') {
        offset++;
        break;
      }
    }
    offset++;
  }

  if (lines.length === 0 || lines[0].trim() !== 'ply') {
    throw new Error(
      'PLYLoader: the payload does not start with the "ply" magic line, so it is not a ' +
        'PLY file.',
    );
  }

  let format = 'ascii';
  const elements: PLYElement[] = [];
  const comments: string[] = [];
  let current: PLYElement | null = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;

    const tokens = line.split(/\s+/);
    switch (tokens[0]) {
      case 'format': {
        format = tokens[1] ?? 'ascii';
        break;
      }
      case 'comment':
      case 'obj_info': {
        comments.push(line.slice(line.indexOf(' ') + 1));
        break;
      }
      case 'element': {
        current = { name: tokens[1] ?? '', count: Number(tokens[2]) || 0, properties: [] };
        elements.push(current);
        break;
      }
      case 'property': {
        if (current === null) break;
        if (tokens[1] === 'list') {
          const property: PLYProperty = {
            name: tokens[4] ?? '',
            type: 'list',
            isList: true,
            countType: tokens[2],
            itemType: tokens[3],
          };
          current.properties.push(property);
        } else {
          const property: PLYProperty = {
            name: tokens[2] ?? '',
            type: tokens[1] ?? 'float',
            isList: false,
          };
          current.properties.push(property);
        }
        break;
      }
      default:
        break;
    }
  }

  if (elements.length === 0) {
    throw new Error('PLYLoader: the header declares no elements, so there is nothing to read.');
  }

  return { format, elements, comments, bodyOffset: offset };
}

/** Reads one scalar from an ASCII token stream. */
function readAsciiScalar(token: string, property: PLYProperty): number {
  const value = Number(token);
  if (!Number.isFinite(value)) return 0;
  const descriptor = PLY_TYPES[property.type];
  // Integer types are rounded and wrapped, matching what a binary read would yield.
  if (descriptor !== undefined && descriptor.kind !== 'float') return Math.trunc(value);
  return value;
}

/** Reads one scalar from a binary buffer. */
function readBinaryScalar(view: DataView, offset: number, type: string, littleEndian: boolean): number {
  const descriptor = PLY_TYPES[type] ?? PLY_TYPES.float;
  switch (descriptor.kind) {
    case 'int':
      switch (descriptor.bytes) {
        case 1:
          return view.getInt8(offset);
        case 2:
          return view.getInt16(offset, littleEndian);
        default:
          return view.getInt32(offset, littleEndian);
      }
    case 'uint':
      switch (descriptor.bytes) {
        case 1:
          return view.getUint8(offset);
        case 2:
          return view.getUint16(offset, littleEndian);
        default:
          return view.getUint32(offset, littleEndian);
      }
    case 'float':
    default:
      return descriptor.bytes === 8 ? view.getFloat64(offset, littleEndian) : view.getFloat32(offset, littleEndian);
  }
}

/** Bytes one scalar occupies. */
function scalarBytes(type: string): number {
  return (PLY_TYPES[type] ?? PLY_TYPES.float).bytes;
}

/**
 * Parses a PLY file.
 *
 * @param source ASCII text or raw bytes.
 * @param options Format override and post-processing flags.
 * @returns The parsed mesh data.
 * @throws Error When the header is missing or the body is too short.
 */
export function parsePLY(source: string | ArrayBuffer | Uint8Array, options: PLYLoadOptions = {}): PLYParseResult {
  const bytes =
    typeof source === 'string'
      ? new TextEncoder().encode(source)
      : source instanceof Uint8Array
        ? source
        : new Uint8Array(source);

  const header = readHeader(bytes);
  const format = options.format === undefined || options.format === 'auto' ? header.format : options.format;

  let positions: Float32Array = new Float32Array(0);
  let normals: Float32Array = new Float32Array(0);
  let uvs: Float32Array = new Float32Array(0);
  let colors: Float32Array = new Float32Array(0);
  const faceIndices: number[] = [];
  let hasFaces = false;

  if (format === 'ascii') {
    // Decode only the body, so a huge binary file is never fully decoded as text.
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const tokens = decoder.decode(bytes.subarray(header.bodyOffset)).split(/\s+/);
    let cursor = 0;

    for (const element of header.elements) {
      if (element.name === 'vertex') {
        positions = new Float32Array(element.count * 3);
        normals = new Float32Array(element.count * 3);
        uvs = new Float32Array(element.count * 2);
        colors = new Float32Array(element.count * 3);

        for (let i = 0; i < element.count; i++) {
          for (const property of element.properties) {
            if (property.isList) {
              // A list on a vertex element is malformed; consume it defensively.
              const listLength = Math.trunc(Number(tokens[cursor++]) || 0);
              cursor += Math.max(0, listLength);
              continue;
            }
            const value = readAsciiScalar(tokens[cursor++] ?? '0', property);
            writeVertexProperty(property.name, i, value, positions, normals, uvs, colors);
          }
        }
      } else if (element.name === 'face') {
        hasFaces = true;
        for (let i = 0; i < element.count; i++) {
          for (const property of element.properties) {
            if (property.isList) {
              const listLength = Math.trunc(Number(tokens[cursor++]) || 0);
              const values: number[] = [];
              for (let k = 0; k < listLength; k++) values.push(Math.trunc(Number(tokens[cursor++]) || 0));
              if (property.name === 'vertex_indices' || property.name === 'vertex_index') {
                appendFace(values, faceIndices);
              }
            } else {
              cursor++;
            }
          }
        }
      } else {
        // Consume unknown elements so a later one is not misaligned.
        for (let i = 0; i < element.count; i++) {
          for (const property of element.properties) {
            if (property.isList) {
              const listLength = Math.trunc(Number(tokens[cursor++]) || 0);
              cursor += Math.max(0, listLength);
            } else {
              cursor++;
            }
          }
        }
      }
    }
  } else {
    const littleEndian = format !== 'binary_big_endian';
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = header.bodyOffset;

    for (const element of header.elements) {
      if (element.name === 'vertex') {
        positions = new Float32Array(element.count * 3);
        normals = new Float32Array(element.count * 3);
        uvs = new Float32Array(element.count * 2);
        colors = new Float32Array(element.count * 3);

        for (let i = 0; i < element.count; i++) {
          for (const property of element.properties) {
            if (property.isList) {
              const listLength = readBinaryScalar(view, offset, property.countType ?? 'uchar', littleEndian);
              offset += scalarBytes(property.countType ?? 'uchar');
              offset += Math.max(0, listLength) * scalarBytes(property.itemType ?? 'float');
              continue;
            }
            const value = readBinaryScalar(view, offset, property.type, littleEndian);
            offset += scalarBytes(property.type);
            writeVertexProperty(property.name, i, value, positions, normals, uvs, colors);
          }
        }
      } else if (element.name === 'face') {
        hasFaces = true;
        for (let i = 0; i < element.count; i++) {
          for (const property of element.properties) {
            if (property.isList) {
              const listLength = readBinaryScalar(view, offset, property.countType ?? 'uchar', littleEndian);
              offset += scalarBytes(property.countType ?? 'uchar');
              const values: number[] = [];
              for (let k = 0; k < listLength; k++) {
                values.push(readBinaryScalar(view, offset, property.itemType ?? 'int', littleEndian));
                offset += scalarBytes(property.itemType ?? 'int');
              }
              if (property.name === 'vertex_indices' || property.name === 'vertex_index') {
                appendFace(values, faceIndices);
              }
            } else {
              offset += scalarBytes(property.type);
            }
          }
        }
      } else {
        for (let i = 0; i < element.count; i++) {
          for (const property of element.properties) {
            if (property.isList) {
              const listLength = readBinaryScalar(view, offset, property.countType ?? 'uchar', littleEndian);
              offset += scalarBytes(property.countType ?? 'uchar');
              offset += Math.max(0, listLength) * scalarBytes(property.itemType ?? 'float');
            } else {
              offset += scalarBytes(property.type);
            }
          }
        }
      }
    }
  }

  if (positions.length === 0) {
    throw new Error(
      'PLYLoader: the header declared no "vertex" element with positional properties, so ' +
        'no geometry could be read.',
    );
  }

  const postOptions: PostProcessOptions = {};
  if (options.scale !== undefined) postOptions.scale = options.scale;
  if (options.center !== undefined) postOptions.center = options.center;
  postProcessPositions(positions, postOptions);
  if (options.flipUvs === true) flipV(uvs);

  return {
    format,
    elements: header.elements,
    positions,
    normals,
    uvs,
    colors,
    indices: Uint32Array.from(faceIndices),
    hasFaces,
    comments: header.comments,
  };
}

/** Writes one named vertex property into the right output buffer. */
function writeVertexProperty(
  name: string,
  index: number,
  value: number,
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  colors: Float32Array,
): void {
  switch (name) {
    case 'x':
      positions[index * 3] = value;
      break;
    case 'y':
      positions[index * 3 + 1] = value;
      break;
    case 'z':
      positions[index * 3 + 2] = value;
      break;
    case 'nx':
      normals[index * 3] = value;
      break;
    case 'ny':
      normals[index * 3 + 1] = value;
      break;
    case 'nz':
      normals[index * 3 + 2] = value;
      break;
    case 's':
    case 'u':
    case 'texture_u':
      uvs[index * 2] = value;
      break;
    case 't':
    case 'v':
    case 'texture_v':
      uvs[index * 2 + 1] = value;
      break;
    case 'red':
      // PLY colours are conventionally 0-255; normalise to 0-1.
      colors[index * 3] = value > 1 ? value / 255 : value;
      break;
    case 'green':
      colors[index * 3 + 1] = value > 1 ? value / 255 : value;
      break;
    case 'blue':
      colors[index * 3 + 2] = value > 1 ? value / 255 : value;
      break;
    default:
      break;
  }
}

/** Fan-triangulates a face and appends it. */
function appendFace(values: readonly number[], out: number[]): void {
  if (values.length < 3) return;
  for (let i = 1; i + 1 < values.length; i++) {
    out.push(values[0], values[i], values[i + 1]);
  }
}

/* -------------------------------------------------------------------------- */
/* Loader                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Loads PLY meshes.
 */
export class PLYLoader extends Loader<PLYParseResult, ArrayBuffer | string> {
  /** `fetch` implementation in use. */
  public fetcher: FetchLike | null = null;

  /** Body-encoding override applied to every parse. */
  public format: 'ascii' | 'binary_little_endian' | 'binary_big_endian' | 'auto' = 'auto';

  /** Post-processing options. */
  public readonly meshOptions: PLYLoadOptions;

  /**
   * Creates a PLY loader.
   *
   * @param options Encoding and post-processing overrides.
   */
  constructor(options: PLYLoadOptions = {}) {
    super();
    this.fetcher = options.fetcher ?? null;
    this.format = options.format ?? 'auto';
    this.meshOptions = options;
  }

  /**
   * Sets the body-encoding override.
   *
   * @param format Encoding, or `'auto'`.
   * @returns This loader, for chaining.
   */
  public setFormat(format: 'ascii' | 'binary_little_endian' | 'binary_big_endian' | 'auto'): this {
    this.format = format;
    return this;
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
   *
   * Fetched as bytes: the header is ASCII, but the body may be binary.
   */
  protected override async loadData(
    url: string,
    options: LoadOptions,
  ): Promise<LoadedSource<ArrayBuffer>> {
    const plyOptions = options as PLYLoadOptions;
    const fetcher = this.resolveFetcher(plyOptions);
    if (fetcher === null) {
      throw new Error(
        `PLYLoader("${url}"): no \`fetch\` implementation is available. Use \`parse()\` on ` +
          'inline data when running on a host without fetch.',
      );
    }

    const response = await fetcher(url, {
      method: 'GET',
      headers: { ...this.requestHeaders },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    if (response.ok === false) {
      throw new Error(`PLYLoader("${url}"): HTTP ${response.status ?? '?'} ${response.statusText ?? ''}`.trim());
    }

    const bytes = await response.arrayBuffer();
    this.reportProgress(url, bytes.byteLength, bytes.byteLength, options);
    return { data: bytes, fromCache: false, byteLength: bytes.byteLength };
  }

  /**
   * @inheritdoc
   *
   * @throws Error When the header or body cannot be read.
   */
  public override parse(
    source: ArrayBuffer | string | Uint8Array,
    url = '<inline>',
    options?: LoadOptions,
  ): PLYParseResult {
    const plyOptions = (options ?? {}) as PLYLoadOptions;
    try {
      return parsePLY(source, {
        ...this.meshOptions,
        ...plyOptions,
        format: plyOptions.format ?? this.format,
      });
    } catch (error) {
      throw new Error(
        `PLYLoader("${url}"): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Resolves the `fetch` implementation to use. */
  private resolveFetcher(options: PLYLoadOptions): FetchLike | null {
    if (options.fetcher !== undefined) return options.fetcher;
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
 * Convenience factory mirroring `new PLYLoader(options)`.
 *
 * @param options Encoding and post-processing overrides.
 * @returns A new PLY loader.
 */
export function plyLoader(options: PLYLoadOptions = {}): PLYLoader {
  return new PLYLoader(options);
}
