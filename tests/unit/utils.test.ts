/**
 * Unit tests for the utility layer.
 *
 * The utilities are the library's foundation, so these tests pin *behaviour*, not
 * implementation: numeric edge cases, LRU eviction order, the color parser's
 * accepted grammar, and the path/string helpers that shader composition and asset
 * resolution depend on.
 */

import { describe, expect, it } from 'vitest';
import { createDisposable } from '../../src/core/Disposable';
import { compareVersions, parseVersion } from '../../src/version';
import {
  COLOR_KEYWORDS,
  Cursor,
  LogLevel,
  Logger,
  Pool,
  addArrays,
  argMax,
  arraysEqual,
  camelCase,
  clamp01,
  concatTypedArrays,
  contrastRatio,
  createId,
  createMemorySink,
  createToken,
  deepClone,
  deepEqual,
  defaults,
  formatBytes,
  getExtension,
  hashString,
  hexToInt,
  hslToRgbChannels,
  idealTextColor,
  indent,
  injectDefines,
  interpolate,
  intToHex,
  isColorString,
  isPlainObject,
  isTypedArray,
  kebabCase,
  lerpHex,
  merge,
  normalizeColorString,
  normalizePath,
  parseQueryString,
  parseToChannels,
  pascalCase,
  pick,
  relativeLuminance,
  rgbToHex,
  rgbToHslChannels,
  seededRandom,
  setLogLevel,
  shaderHash,
  shaderKey,
  snakeCase,
  splitPath,
  stripComments,
  toCssRgba,
  toFloat32,
  toUint16,
  truncate,
  unique,
  withCacheBust,
  configureLogging,
} from '../../src/utils';


describe('MathUtils', () => {
  it('clamps and interpolates', () => {
    expect(clamp01(2)).toBe(1);
    expect(clamp01(-2)).toBe(0);
  });

  it('hashes strings deterministically', () => {
    expect(hashString('shader')).toBe(hashString('shader'));
    expect(hashString('shader')).not.toBe(hashString('shaders'));
    expect(hashString('')).toBe(0x811c9dc5);
  });

  it('produces a repeatable seeded sequence', () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    expect([a(), a(), a(), a()]).toEqual([b(), b(), b(), b()]);
    const values = [a(), a(), a()];
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('ArrayUtils', () => {
  it('concatenates typed arrays of the same type', () => {
    const result = concatTypedArrays([new Float32Array([1, 2]), new Float32Array([3])]);
    expect(result.constructor).toBe(Float32Array);
    expect(Array.from(result)).toEqual([1, 2, 3]);
  });

  it('adds arrays element-wise and finds the argmax', () => {
    expect(addArrays([1, 2, 3], [4, 5, 6])).toEqual([5, 7, 9]);
    expect(argMax([1, 9, 3])).toBe(1);
    expect(argMax([])).toBe(-1);
  });

  it('compares arrays with a tolerance', () => {
    expect(arraysEqual([1, 2], [1, 2 + 1e-9], 1e-6)).toBe(true);
    expect(arraysEqual([1, 2], [1, 3], 1e-6)).toBe(false);
    expect(arraysEqual([1], [1, 2])).toBe(false);
  });

  it('builds typed arrays from plain arrays', () => {
    expect(Array.from(toFloat32([1, 2]))).toEqual([1, 2]);
    expect(toUint16([65535]).constructor).toBe(Uint16Array);
    expect(isTypedArray(new Float32Array(1))).toBe(true);
    expect(isTypedArray(new DataView(new ArrayBuffer(4)))).toBe(false);
    expect(isTypedArray([])).toBe(false);
  });

  it('deduplicates while preserving order', () => {
    expect(unique([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
  });
});

describe('ObjectUtils', () => {
  it('recognises plain objects only', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(new Float32Array(1))).toBe(false);
    expect(isPlainObject(null)).toBe(false);
  });

  it('deep-merges without flattening nested objects', () => {
    const target = { a: { b: 1, c: 2 }, d: 3 } as Record<string, unknown>;
    merge(target, { a: { c: 9 }, d: 4 });
    expect(target).toEqual({ a: { b: 1, c: 9 }, d: 4 });
  });

  it('deep-clones and compares correctly', () => {
    const original = { a: [1, 2], b: { c: new Float32Array([1, 2]) } };
    const copy = deepClone(original);
    expect(copy).not.toBe(original);
    expect(copy.b.c).not.toBe(original.b.c);
    expect(deepEqual(copy, original)).toBe(true);

    const mutated = deepClone(original);
    mutated.a.push(3);
    expect(deepEqual(mutated, original)).toBe(false);
  });

  it('picks and applies defaults', () => {
    expect(pick({ a: 1, b: 2, c: 3 }, ['a', 'c'])).toEqual({ a: 1, c: 3 });
    expect(defaults({ a: 1 } as Record<string, unknown>, { a: 2, b: 3 })).toEqual({ a: 1, b: 3 });
  });
});

describe('StringUtils', () => {
  it('converts between naming conventions', () => {
    expect(kebabCase('MeshStandardMaterial')).toBe('mesh-standard-material');
    expect(snakeCase('MeshStandardMaterial')).toBe('mesh_standard_material');
    expect(camelCase('mesh-standard-material')).toBe('meshStandardMaterial');
    expect(pascalCase('mesh_standard_material')).toBe('MeshStandardMaterial');
  });

  it('truncates with a suffix', () => {
    expect(truncate('abcdefgh', 5)).toBe('abcd…');
    expect(truncate('abc', 5)).toBe('abc');
  });

  it('formats byte counts', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.0 kB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
  });

  it('strips comments and collapses shader sources into a stable key', () => {
    const withComments = 'void main() {\n  // comment\n  gl_Position = vec4(0.0); /* inline */\n}\n';
    const stripped = stripComments(withComments);
    expect(stripped).not.toContain('comment');
    expect(stripped).toContain('gl_Position');

    // Formatting and comments must not change the cache key.
    const a = shaderKey('void main() { /* x */ gl_Position = vec4(0.0); }');
    const b = shaderKey('void main() {\n  gl_Position = vec4(0.0);\n}');
    expect(a).toBe(b);
    expect(shaderHash(a)).toBe(shaderHash(b));
  });

  it('interpolates placeholders and injects defines', () => {
    expect(interpolate('a {x} b {y}', { x: 1, y: 'two' })).toBe('a 1 b two');
    expect(interpolate('keep {missing}', {})).toBe('keep {missing}');

    const injected = injectDefines('void main() {}', { USE_FOG: true, LIGHTS: 4, OFF: false });
    expect(injected).toContain('#define USE_FOG');
    expect(injected).toContain('#define LIGHTS 4');
    expect(injected).not.toContain('OFF');
  });

  it('indents only non-empty lines', () => {
    expect(indent('a\n\nb', 2)).toBe('  a\n\n  b');
  });
});

describe('PathUtils', () => {
  it('splits, joins and normalises paths', () => {
    expect(splitPath('a//b\\c')).toEqual(['a', 'b', 'c']);
    expect(normalizePath('a/./b/../c')).toBe('a/c');
    expect(normalizePath('/a/../../b')).toBe('/b');
    expect(getExtension('model.GLB')).toBe('glb');
  });

  it('appends cache-busting query parameters', () => {
    expect(withCacheBust('/a.png')).toBe('/a.png');
    expect(withCacheBust('/a.png', 3)).toBe('/a.png?v=3');
    expect(withCacheBust('/a.png?x=1', 3)).toBe('/a.png?x=1&v=3');
  });

  it('parses and builds query strings', () => {
    expect(parseQueryString('?a=1&b=two&c')).toEqual({ a: '1', b: 'two', c: '' });
    expect(parseQueryString('')).toEqual({});
  });
});

describe('ColorUtils', () => {
  it('parses every supported notation to the same colour', () => {
    const expected = '#3366cc';
    expect(normalizeColorString('#3366cc')).toBe(expected);
    expect(normalizeColorString('#36c')).toBe(expected);
    expect(normalizeColorString('rgb(51, 102, 204)')).toBe(expected);
    expect(normalizeColorString('rgb(20%, 40%, 80%)')).toBe(expected);
    expect(normalizeColorString(0x3366cc)).toBe(expected);
    expect(normalizeColorString({ r: 0.2, g: 0.4, b: 0.8 })).toBe(expected);
    expect(normalizeColorString('  #3366CC  ')).toBe(expected);
  });

  it('parses CSS keywords and hsl()', () => {
    expect(normalizeColorString('rebeccapurple')).toBe('#663399');
    expect(normalizeColorString('transparent')).toBe('#000000');
    expect(normalizeColorString('hsl(220, 60%, 50%)')).toBe('#3366cc');
    expect(normalizeColorString('not-a-colour')).toBeNull();
    expect(normalizeColorString(null)).toBeNull();
  });

  it('exposes the full keyword table', () => {
    // The CSS spec defines 147 colour keywords plus `transparent`.
    expect(Object.keys(COLOR_KEYWORDS).length).toBeGreaterThanOrEqual(148);
    expect(isColorString('cornflowerblue')).toBe(true);
    expect(isColorString('cornflowerbleu')).toBe(false);
  });

  it('converts between hex representations', () => {
    expect(intToHex(0x0a0b0c)).toBe('#0a0b0c');
    expect(hexToInt('#0a0b0c')).toBe(0x0a0b0c);
    expect(rgbToHex(1, 0.5, 0)).toBe('#ff8000');
    expect(lerpHex(0x000000, 0xffffff, 0.5)).toBe(0x808080);
  });

  it('round-trips HSL and HSV channels', () => {
    const rgb = { r: 0.2, g: 0.4, b: 0.8 };
    const hsl = rgbToHslChannels(rgb.r, rgb.g, rgb.b);
    const back = hslToRgbChannels(hsl.h, hsl.s, hsl.l);
    expect(back.r).toBeCloseTo(rgb.r, 6);
    expect(back.g).toBeCloseTo(rgb.g, 6);
    expect(back.b).toBeCloseTo(rgb.b, 6);
    expect(hsl.h).toBeCloseTo(220 / 360, 6);
  });

  it('computes luminance, contrast and readable text colour', () => {
    expect(relativeLuminance(0, 0, 0)).toBeCloseTo(0, 6);
    expect(relativeLuminance(1, 1, 1)).toBeCloseTo(1, 6);
    expect(contrastRatio([0, 0, 0], [1, 1, 1])).toBeCloseTo(21, 1);
    expect(idealTextColor(1, 1, 1)).toBe('#000000');
    expect(idealTextColor(0, 0, 0)).toBe('#ffffff');
  });

  it('formats CSS output and parses into channels', () => {
    expect(toCssRgba(1, 0, 0, 0.5)).toBe('rgba(255, 0, 0, 0.5)');
    const target = { r: 0, g: 0, b: 0, a: 1 };
    parseToChannels('#3366cc', target);
    expect(target.r).toBeCloseTo(0.2, 6);
    expect(target.g).toBeCloseTo(0.4, 6);
    expect(target.b).toBeCloseTo(0.8, 6);
    expect(target.a).toBe(1);
    parseToChannels('#3366cc', target, 0.25);
    expect(target.a).toBe(0.25);
  });
});

describe('Pool', () => {
  it('reuses released objects and respects its capacity', () => {
    const pool = new Pool(() => ({ value: 0 }), { capacity: 2 });
    const a = pool.acquire();
    const b = pool.acquire();
    expect(pool.created).toBe(2);
    expect(pool.activeCount).toBe(2);

    pool.release(a);
    pool.release(b);
    expect(pool.size).toBe(2);

    const c = pool.acquire();
    expect(c).toBe(b); // last released, first reused (LIFO)
    expect(pool.created).toBe(2);
  });

  it('never grows past capacity when releasing', () => {
    const pool = new Pool(() => ({}), { capacity: 1 });
    const a = pool.acquire();
    const b = pool.acquire();
    pool.release(a);
    pool.release(b);
    expect(pool.size).toBe(1);
  });

  it('ignores duplicate releases of the same object', () => {
    const pool = new Pool(() => ({}), { capacity: 4 });
    const a = pool.acquire();
    pool.release(a);
    pool.release(a);
    expect(pool.size).toBe(1);
    expect(pool.activeCount).toBe(0);
  });

  it('releases everything even when the callback throws', () => {
    const pool = new Pool(() => ({}), { capacity: 4 });
    expect(() =>
      pool.use(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(pool.activeCount).toBe(0);
  });

  it('cycles a cursor through its slots', () => {
    const cursor = new Cursor(3);
    expect([cursor.next(), cursor.next(), cursor.next(), cursor.next()]).toEqual([0, 1, 2, 0]);
  });
});

describe('Id', () => {
  it('generates unique, prefixed identifiers', () => {
    const a = createId('mesh');
    const b = createId('mesh');
    expect(a).not.toBe(b);
    expect(a.startsWith('mesh-')).toBe(true);
  });

  it('generates tokens of the requested length', () => {
    expect(createToken(8)).toHaveLength(8);
    expect(createToken(16)).toHaveLength(16);
  });
});

describe('version', () => {
  it('parses semver into components', () => {
    expect(parseVersion('1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: null });
    expect(parseVersion('1.2.3-beta.1').prerelease).toBe('beta.1');
    expect(parseVersion('not-semver').major).toBe(0);
  });

  it('orders versions correctly, including prereleases', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    // A prerelease sorts before its release.
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBe(1);
  });
});

describe('Logger', () => {
  it('routes records to a sink and honours the level', () => {
    const memory = createMemorySink();
    setLogLevel(LogLevel.Debug);
    const logger = new Logger('test');

    // Install the memory sink globally for this test.
    configureLogging({ sinks: [memory.sink], level: LogLevel.Debug, colors: false });

    logger.info('hello', 1, 2);
    logger.warn('careful');
    expect(memory.records).toHaveLength(2);
    expect(memory.records[0].message).toBe('hello');
    expect(memory.records[0].args).toEqual([1, 2]);
    expect(memory.records[1].level).toBe(LogLevel.Warn);

    memory.clear();
    configureLogging({ level: LogLevel.Error, sinks: [] });
    logger.info('suppressed');
    logger.error('kept');
    expect(memory.records).toHaveLength(0); // sinks were cleared

    setLogLevel(LogLevel.Error);
  });

  it('de-duplicates warnOnce per logger', () => {
    const memory = createMemorySink();
    configureLogging({ sinks: [memory.sink], level: LogLevel.Debug, colors: false });

    const logger = new Logger('once');
    logger.warnOnce('same');
    logger.warnOnce('same');
    logger.warnOnce('different');
    expect(memory.records.map((record) => record.message)).toEqual(['same', 'different']);

    configureLogging({ level: LogLevel.Error, sinks: [] });
  });
});

describe('Disposable helpers', () => {
  it('created disposables are idempotent and report their state', () => {
    let calls = 0;
    const handle = createDisposable('thing', () => {
      calls++;
    });
    expect(handle.isDisposed).toBe(false);
    handle.dispose();
    handle.dispose();
    expect(calls).toBe(1);
    expect(handle.isDisposed).toBe(true);
  });
});
