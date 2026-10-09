/**
 * `assets` — loading, caching and parsing files.
 *
 * The public surface is four things:
 *
 * ```ts
 * import { AssetManager, Cache, FileLoader, parseOBJ } from '@dxyl/graphics';
 *
 * const assets = new AssetManager({ concurrency: 4 });
 * assets.register('json', new JSONLoader(), { extensions: ['.json'] });
 *
 * const manifest = await assets.load('manifest.json');
 * const tree = parseOBJ(objText);            // no network needed
 * ```
 *
 * ## Layers
 *
 * | File | Role |
 * | --- | --- |
 * | {@link Loader} | retry, backoff, cancellation, URL joining, progress events |
 * | {@link LoaderManager} | URL → loader resolution by extension, MIME type and predicate |
 * | {@link AssetManager} | batches, the concurrency cap, aggregate progress, the cache |
 * | {@link Cache} | bounded LRU with optional refcounting |
 * | `loaders/*` | one class per format, plus the parsers they are built on |
 *
 * ## Parser honesty
 *
 * OBJ (with groups/UVs/normals), STL (ASCII and binary), PLY (ASCII and binary
 * little/big-endian), glTF/GLB (buffers, accessors, meshes, materials, nodes) and SVG
 * path data are parsed **for real**. FBX is a **documented stub**: it reads the ASCII
 * header and node tree and throws a descriptive `FBXUnsupportedError` for the binary
 * form and for geometry decoding. Nothing here returns fabricated geometry.
 *
 * ## Zero dependencies
 *
 * Every parser is implemented in this directory. The only host APIs used are `fetch`,
 * `XMLHttpRequest`, `TextDecoder`/`TextEncoder`, `DataView`, `Blob` and
 * `createImageBitmap`/`Image` — all of which are injectable through options, which is
 * what lets the whole subsystem run headlessly in a test.
 *
 * @packageDocumentation
 */

export { AssetManager, assetManager, isCancelledResult } from './AssetManager';
export type {
  AssetManagerEvents,
  AssetManagerOptions,
  AssetManagerStats,
  AssetGroup,
  AssetGroupResult,
} from './AssetManager';
export * from './Cache';
export * from './Loader';
export * from './loaders/index';
export type * from './types';
