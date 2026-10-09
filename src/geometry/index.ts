/**
 * Geometry layer.
 *
 * Re-exports the three sub-layers:
 *
 *  - {@link core} — `BufferGeometry`, `BufferAttribute`, `InterleavedBuffer`,
 *    the legacy authorable `Geometry` and `InstancedBufferGeometry`;
 *  - {@link two} — 2D curves, paths, shapes, polygons and boolean operations;
 *  - `3d` — primitives, generators and geometry utilities;
 *  - {@link types} — the cross-layer vocabulary (`GeometryKind`,
 *    `GeometryOptions`, `GeometrySource`, `AttributeLayout`).
 *
 * @packageDocumentation
 */

export * from './core';
export * from './2d';
export * from './3d';
export * from './types';
