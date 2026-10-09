/**
 * Identifier generation.
 *
 * IDs are short, URL-safe and monotonically increasing within a process, which
 * makes them convenient for DOM `id` attributes (`SVGRenderer`) and for cache
 * keys that need to be stable for the lifetime of an object.
 *
 * @packageDocumentation
 */

import { hashString } from './MathUtils';

/** Base-36 counter shared by {@link createId}. */
let counter = 0;

/** Random suffix so IDs from different documents do not collide when merged. */
const instanceSalt = Math.floor(Math.random() * 0xffff).toString(36);

/**
 * Creates a unique identifier.
 *
 * @param prefix Optional human-readable prefix (`'mesh'` → `'mesh-3f-a1'`).
 */
export function createId(prefix?: string): string {
  counter = (counter + 1) >>> 0;
  const id = `${counter.toString(36)}-${instanceSalt}`;
  return prefix ? `${prefix}-${id}` : id;
}

/** Resets the global counter. Test helper to make snapshots deterministic. */
export function resetIdCounter(): void {
  counter = 0;
}

/** Returns the next raw counter value without formatting it. */
export function nextIdNumber(): number {
  counter = (counter + 1) >>> 0;
  return counter;
}

/**
 * Derives a deterministic identifier from a name.
 *
 * Unlike {@link createId} the result is stable across runs, which the shader
 * and material caches depend on.
 */
export function idFromName(name: string, prefix?: string): string {
  const safe = name
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const hash = hashString(name).toString(36);
  const base = safe.length > 0 ? safe : 'unnamed';
  return prefix ? `${prefix}-${base}-${hash}` : `${base}-${hash}`;
}

/**
 * Creates a universally unique identifier (RFC 4122 v4).
 *
 * Uses `crypto.randomUUID` when available and falls back to a `Math.random`
 * implementation for older runtimes and insecure contexts.
 */
export function createUuid(): string {
  const cryptoObject: any = (globalThis as any).crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex
    .slice(8, 10)
    .join('')}-${hex.slice(10, 16).join('')}`;
}

/** `true` when `value` looks like an ID produced by {@link createUuid}. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Generates a short random token, used for blob URLs and shader variants.
 *
 * @param length Number of base-36 characters to produce.
 */
export function createToken(length: number = 8): string {
  let result = '';
  while (result.length < length) {
    result += Math.floor(Math.random() * 0xffffffff).toString(36);
  }
  return result.slice(0, length);
}
