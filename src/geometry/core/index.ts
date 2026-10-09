/**
 * Geometry core: the buffer-backed representations the renderer consumes.
 *
 * `BufferGeometry`/`BufferAttribute` are the hot path — a named typed array plus
 * the layout metadata a backend needs. `Geometry` is the legacy authorable form
 * and `InstancedBufferGeometry` adds a per-instance attribute stream.
 *
 * @packageDocumentation
 */

export * from './BufferAttribute';
export * from './InterleavedBuffer';
export * from './BufferGeometry';
export * from './Geometry';
export * from './InstancedBufferGeometry';
export type * from './types';
