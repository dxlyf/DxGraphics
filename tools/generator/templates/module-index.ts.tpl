/**
 * `{{NAME_PASCAL}}` — one-line description of what this module provides.
 *
 * Replace this paragraph with why the module exists, what it owns, and which layers it
 * may depend on. The library's dependency rule is that **nothing below `renderer`
 * imports a backend**, so if this module lives above `renderer` it may import one; if it
 * lives below, it must consume backends through structural interfaces instead.
 *
 * ```ts
 * import { {{NAME_PASCAL}} } from '@lyf/graphics';
 *
 * const instance = new {{NAME_PASCAL}}();
 * ```
 *
 * @packageDocumentation
 */

export * from './{{NAME_PASCAL}}';
export * from './types';
