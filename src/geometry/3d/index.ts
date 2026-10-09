/**
 * 3D geometry: primitives, curves, modifiers and utilities.
 *
 * The 3D layer builds on the 2D `Curve` base (which is generic over `Vec2 | Vec3`)
 * and the buffer representation in `geometry/core`. Nothing here imports a
 * renderer, so a generator runs in a worker as easily as on the main thread.
 *
 * @packageDocumentation
 */

export * from './primitives';
export * from './curves';
export * from './modifiers';
export * from './utils';
export type * from './types';
