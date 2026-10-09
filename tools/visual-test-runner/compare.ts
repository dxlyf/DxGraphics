#!/usr/bin/env -S node --experimental-strip-types
/**
 * Pixel comparison for the visual test runner.
 *
 * ## Why there is no PNG decoder here
 *
 * Comparing rendered snapshots means comparing decoded pixels, and decoding a PNG without a
 * dependency means writing an inflate implementation — hundreds of lines of bit-twiddling
 * that would be the least trustworthy code in the repository. This project has a
 * **zero-runtime-dependency** rule and `package.json` may not gain one, so this module does
 * not decode PNGs.
 *
 * Instead it compares **raw RGBA bitmaps** that a caller supplies. Getting those bitmaps is
 * the caller's job, and there are two realistic ways:
 *
 * 1. **In the browser**, where the snapshot is taken: a real `RenderingContext2D`
 *    (`ctx.getImageData(x, y, w, h)`) or a `WebGLRenderingContext` readback
 *    (`gl.readPixels`) already returns an `RGBA` byte array. Dump it to disk as a headerless
 *    `.rgba` file (or a `.bin`) and this tool compares it directly.
 * 2. **In Node**, when `sharp` or `pixelmatch` happens to be installed in the ambient
 *    environment, `readPngToRgba()` below uses it. Nothing is added to `package.json`; if
 *    neither module resolves, the function throws with an explanation instead of silently
 *    producing a wrong comparison.
 *
 * See `runner.ts` for the CLI and `README.md` for the workflow.
 *
 * ## Usage as a library
 *
 * ```ts
 * import { compareBitmaps, type Bitmap } from './compare';
 *
 * const baseline: Bitmap = { width, height, data: baselineRgba };
 * const actual: Bitmap = { width, height, data: actualRgba };
 * const result = compareBitmaps(baseline, actual, { threshold: 0.1 });
 * if (result.diffRatio > 0.01) { ... }
 * ```
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** A raw 8-bit RGBA bitmap, row-major, top-left origin, 4 bytes per pixel. */
export interface Bitmap {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes. */
  readonly data: Uint8ClampedArray | Uint8Array;
}

/** Per-comparison tuning. */
export interface CompareOptions {
  /**
   * Per-channel tolerance, `0..1`, below which a pixel counts as unchanged.
   *
   * Antialiasing and GPU float precision mean two "identical" frames are rarely
   * bit-identical. `0` demands an exact match; `0.1` is the default and tolerates roughly
   * 25 levels out of 255 per channel, which absorbs edge resampling without hiding a real
   * colour change.
   */
  readonly threshold?: number;

  /**
   * Fraction of pixels that may differ before the comparison is considered a failure.
   *
   * This is the knob that makes the tool usable: a handful of edge pixels always move, so a
   * strict `0` would fail every run. The default of `0.01` allows 1% of the image to differ.
   */
  readonly maxDiffRatio?: number;

  /**
   * Alpha below which a pixel is ignored (`0..255`).
   *
   * Useful when a baseline has a transparent background that a compositor resolves
   * differently. `0` (the default) compares every pixel, including fully transparent ones.
   */
  readonly alphaCutoff?: number;

  /**
   * When set, writes a diff bitmap for every comparison, assigning a scheme-relative path
   * the caller can write to disk. Kept as a callback so this module stays free of `fs`.
   */
  readonly onDiff?: (diff: Bitmap) => void;
}

/** The outcome of one comparison. */
export interface CompareResult {
  /** `true` when `diffRatio <= maxDiffRatio`. */
  readonly passed: boolean;
  /** Number of pixels that exceeded the threshold. */
  readonly diffPixels: number;
  /** Total pixels considered. */
  readonly totalPixels: number;
  /** `diffPixels / totalPixels`, in `0..1`. */
  readonly diffRatio: number;
  /** Largest per-channel absolute difference seen, `0..255`. */
  readonly maxChannelDelta: number;
  /** Mean per-channel absolute difference across differing pixels, `0..255`. */
  readonly meanChannelDelta: number;
  /** Why the comparison failed, when it did. */
  readonly reason?: string;
  /** The diff bitmap, when `onDiff` was supplied. */
  readonly diff?: Bitmap;
}

/** Error raised when a caller asks for something this module cannot do. */
export class BitmapError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BitmapError';
  }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/** Throws unless `bitmap` has a plausible shape and enough data. */
export function assertBitmap(bitmap: Bitmap, label: string): void {
  if (!Number.isInteger(bitmap.width) || bitmap.width <= 0) {
    throw new BitmapError(`${label}: width must be a positive integer (got ${bitmap.width})`);
  }
  if (!Number.isInteger(bitmap.height) || bitmap.height <= 0) {
    throw new BitmapError(`${label}: height must be a positive integer (got ${bitmap.height})`);
  }
  const expected = bitmap.width * bitmap.height * 4;
  if (bitmap.data.length !== expected) {
    throw new BitmapError(
      `${label}: expected ${expected} bytes for ${bitmap.width}×${bitmap.height} RGBA, ` +
        `but the data is ${bitmap.data.length} bytes. The bitmap must be tightly packed ` +
        'RGBA with 4 bytes per pixel and no row padding.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Comparison                                                                 */
/* -------------------------------------------------------------------------- */

/** Colour used to mark a changed pixel in the diff bitmap: magenta, rarely in a real render. */
const DIFF_MARK = [255, 0, 200, 255] as const;

/** Colours used to mark a dimension or presence mismatch, so the diff is self-describing. */
const MISSING_MARK = [255, 60, 60, 255] as const;
const EXTRA_MARK = [60, 140, 255, 255] as const;

/**
 * Compares two raw RGBA bitmaps.
 *
 * Two mismatched dimensions are **not** treated as an automatic hard failure: the overlap is
 * compared, and pixels that exist in only one bitmap are counted as differing and marked.
 * That is more useful than refusing to compare, because a resize regression then shows up as
 * a diff image with an obvious band rather than a bare error.
 *
 * @param baseline The reference bitmap (the committed baseline).
 * @param actual The freshly rendered bitmap.
 * @param options Tuning; see {@link CompareOptions}.
 * @returns A {@link CompareResult}.
 */
export function compareBitmaps(
  baseline: Bitmap,
  actual: Bitmap,
  options: CompareOptions = {},
): CompareResult {
  assertBitmap(baseline, 'baseline');
  assertBitmap(actual, 'actual');

  const threshold = clamp01(options.threshold ?? 0.1);
  const maxDiffRatio = clamp01(options.maxDiffRatio ?? 0.01);
  const alphaCutoff = Math.max(0, Math.min(255, Math.round(options.alphaCutoff ?? 0)));
  // Per-channel allowance in 0..255 units.
  const channelLimit = threshold * 255;

  const width = Math.max(baseline.width, actual.width);
  const height = Math.max(baseline.height, actual.height);
  const totalPixels = width * height;

  const diff = new Uint8ClampedArray(width * height * 4);
  let diffPixels = 0;
  let maxChannelDelta = 0;
  let deltaSum = 0;

  const dimensionsMatch = baseline.width === actual.width && baseline.height === actual.height;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;

      const inBaseline = x < baseline.width && y < baseline.height;
      const inActual = x < actual.width && y < actual.height;

      if (!inBaseline || !inActual) {
        // Present in only one bitmap: a difference by definition.
        const mark = inBaseline ? EXTRA_MARK : MISSING_MARK;
        diff[out] = mark[0];
        diff[out + 1] = mark[1];
        diff[out + 2] = mark[2];
        diff[out + 3] = mark[3];
        diffPixels++;
        continue;
      }

      const bi = (y * baseline.width + x) * 4;
      const ai = (y * actual.width + x) * 4;

      const baselineAlpha = baseline.data[bi + 3];
      const actualAlpha = actual.data[ai + 3];

      // Both fully transparent at or below the cutoff: nothing observable to compare.
      if (baselineAlpha <= alphaCutoff && actualAlpha <= alphaCutoff) {
        diff[out + 3] = 0;
        continue;
      }

      const dr = Math.abs(baseline.data[bi] - actual.data[ai]);
      const dg = Math.abs(baseline.data[bi + 1] - actual.data[ai + 1]);
      const db = Math.abs(baseline.data[bi + 2] - actual.data[ai + 2]);
      const da = Math.abs(baselineAlpha - actualAlpha);
      const delta = Math.max(dr, dg, db, da);

      if (delta > maxChannelDelta) maxChannelDelta = delta;

      if (delta > channelLimit) {
        diffPixels++;
        deltaSum += delta;
        diff[out] = DIFF_MARK[0];
        diff[out + 1] = DIFF_MARK[1];
        diff[out + 2] = DIFF_MARK[2];
        diff[out + 3] = 255;
        continue;
      }

      // Unchanged: keep a desaturated ghost of the baseline, so the diff image still shows
      // the frame's composition rather than a transparent void.
      const grey = (baseline.data[bi] + baseline.data[bi + 1] + baseline.data[bi + 2]) / 3;
      const ghost = grey * 0.25 + 40;
      diff[out] = ghost;
      diff[out + 1] = ghost;
      diff[out + 2] = ghost;
      diff[out + 3] = 160;
    }
  }

  const diffRatio = totalPixels === 0 ? 0 : diffPixels / totalPixels;
  const passed = diffRatio <= maxDiffRatio;
  const diffBitmap: Bitmap = { width, height, data: diff };
  options.onDiff?.(diffBitmap);

  let reason: string | undefined;
  if (!passed) {
    reason = dimensionsMatch
      ? `${(diffRatio * 100).toFixed(3)}% of pixels differ ` +
        `(${diffPixels} of ${totalPixels}), above the ${(maxDiffRatio * 100).toFixed(3)}% limit; ` +
        `largest channel delta ${maxChannelDelta}`
      : `dimensions differ (baseline ${baseline.width}×${baseline.height}, ` +
        `actual ${actual.width}×${actual.height}), and the compared region is ` +
        `${(diffRatio * 100).toFixed(3)}% different`;
  }

  return {
    passed,
    diffPixels,
    totalPixels,
    diffRatio,
    maxChannelDelta,
    meanChannelDelta: diffPixels === 0 ? 0 : deltaSum / diffPixels,
    ...(reason === undefined ? {} : { reason }),
    diff: diffBitmap,
  };
}

/** Clamps into `0..1`, tolerating `NaN`. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/* -------------------------------------------------------------------------- */
/* Optional PNG decoding                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Reads a PNG into a raw RGBA bitmap, using an **already installed** decoder.
 *
 * Nothing is added to `package.json`. This tries, in order:
 *
 * 1. `sharp`, if it resolves in the ambient environment;
 * 2. `pngjs`, if it resolves.
 *
 * If neither is present it throws a {@link BitmapError} naming both options and pointing at
 * the raw-RGBA workflow instead. It never guesses, and it never returns a partially decoded
 * image.
 *
 * @param path Absolute or relative path to the PNG.
 * @returns The decoded bitmap.
 * @throws BitmapError When no decoder is available.
 */
export async function readPngToRgba(path: string): Promise<Bitmap> {
  const sharpModule = await tryImport('sharp');
  if (sharpModule !== null) {
    const factory = sharpModule as unknown as (input: string) => {
      ensureAlpha(): { raw(): { toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }> } };
    };
    const { data, info } = await factory(path)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    };
  }

  const pngjsModule = await tryImport('pngjs');
  if (pngjsModule !== null) {
    const { PNG } = pngjsModule as unknown as {
      PNG: { sync: { read(buffer: Buffer): { width: number; height: number; data: Buffer } } };
    };
    const { readFileSync } = await import('node:fs');
    const decoded = PNG.sync.read(readFileSync(path));
    return {
      width: decoded.width,
      height: decoded.height,
      data: new Uint8ClampedArray(
        decoded.data.buffer,
        decoded.data.byteOffset,
        decoded.data.byteLength,
      ),
    };
  }

  throw new BitmapError(
    `readPngToRgba: cannot decode '${path}' — no PNG decoder is available.\n` +
      'This project adds no runtime dependencies, so a decoder is never installed for you. ' +
      'Either:\n' +
      '  1. snapshot raw RGBA from the renderer instead of PNG:\n' +
      '       browser  ctx.getImageData(...)  or  gl.readPixels(...)  -> write a .rgba file\n' +
      '  2. or install a decoder yourself (`pnpm add -D sharp` or `-D pngjs`) and re-run.\n' +
      'A baseline .rgba file is compared directly by compareBitmaps().',
  );
}

/** Attempts a dynamic import, returning `null` when the module is not installed. */
async function tryImport(specifier: string): Promise<unknown | null> {
  try {
    return await import(specifier);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Raw RGBA files                                                             */
/* -------------------------------------------------------------------------- */

/** Loose view of the `node:fs` surface used here, loaded lazily via `import()`. */
interface FsModule {
  readFileSync(path: string): Uint8Array;
  writeFileSync(path: string, data: Uint8Array | Uint8ClampedArray): void;
}

/** Loose view of the `node:zlib` surface used here. */
interface ZlibModule {
  deflateSync(data: Uint8Array): Uint8Array;
  crc32?(data: Uint8Array): number;
}

/*
 * `node:fs` and `node:zlib` are loaded through `import()` inside the helpers below rather
 * than at module scope, so `compareBitmaps` — the pure comparison function — stays
 * importable in a browser bundle without a bundler shim for Node built-ins.
 */

/**
 * Reads a headerless raw RGBA file.
 *
 * The dimensions must be supplied because the format carries no header. This is the
 * dependency-free path: dump the bytes from the renderer, remember the size, and compare
 * directly.
 */
export async function readRawRgba(path: string, width: number, height: number): Promise<Bitmap> {
  const fs = (await import('node:fs')) as unknown as FsModule;
  const buffer = fs.readFileSync(path);
  const expected = width * height * 4;
  if (buffer.byteLength !== expected) {
    throw new BitmapError(
      `readRawRgba: '${path}' is ${buffer.byteLength} bytes but ${width}×${height} RGBA ` +
        `needs ${expected}. Check the dimensions, or whether the file has a PNG header ` +
        '(a PNG would start with the bytes 0x89 0x50 0x4E 0x47).',
    );
  }
  return {
    width,
    height,
    data: new Uint8ClampedArray(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  };
}

/** Writes a bitmap to a headerless raw RGBA file. */
export async function writeRawRgba(path: string, bitmap: Bitmap): Promise<void> {
  assertBitmap(bitmap, 'writeRawRgba');
  const fs = (await import('node:fs')) as unknown as FsModule;
  fs.writeFileSync(path, bitmap.data);
}

/**
 * Encodes a bitmap as a PNG, without any runtime dependency.
 *
 * `zlib` is a Node built-in, so this needs nothing added to `package.json`. Compression uses
 * the default deflate level, which produces a small, valid, viewable file — the right
 * trade-off for a diff artifact, which only has to be looked at.
 *
 * @param bitmap The image to encode.
 * @returns The PNG file bytes.
 */
export async function encodePng(bitmap: Bitmap): Promise<Uint8Array> {
  assertBitmap(bitmap, 'encodePng');

  const zlib = (await import('node:zlib')) as unknown as ZlibModule;

  // Scanlines are prefixed with a filter byte; filter 0 means "no filtering".
  const stride = bitmap.width * 4;
  const raw = new Uint8Array((stride + 1) * bitmap.height);
  for (let y = 0; y < bitmap.height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(bitmap.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, bitmap.width);
  view.setUint32(4, bitmap.height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  const chunks: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makeChunk('IHDR', ihdr, zlib),
    makeChunk('IDAT', zlib.deflateSync(raw), zlib),
    makeChunk('IEND', new Uint8Array(0), zlib),
  ];

  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const png = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    png.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return png;
}

/** Builds a length-prefixed, CRC-suffixed PNG chunk. */
function makeChunk(type: string, data: Uint8Array, zlib: ZlibModule): Uint8Array {
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);

  const body = new Uint8Array(typeBytes.byteLength + data.byteLength);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.byteLength);

  const chunk = new Uint8Array(4 + body.byteLength + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.byteLength);
  chunk.set(body, 4);

  // `zlib.crc32` exists from Node 20.12; fall back to a table-free CRC-32 otherwise.
  const checksum =
    typeof zlib.crc32 === 'function' ? zlib.crc32(body) >>> 0 : crc32Fallback(body);
  view.setUint32(4 + body.byteLength, checksum);
  return chunk;
}

/** Table-free CRC-32, used only when `zlib.crc32` is unavailable. */
function crc32Fallback(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
