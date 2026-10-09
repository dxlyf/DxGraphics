/**
 * 3D primitive generators.
 *
 * Every generator here follows the same contract:
 *
 * - it is available both as a `create*Geometry(options)` **function** and as a
 *   `*Geometry` **class**, so `createBoxGeometry({ width: 2 })` and
 *   `new BoxGeometry({ width: 2 })` both work;
 * - it returns a `BufferGeometry` carrying `position`, and `normal`/`uv` unless
 *   those are switched off through {@link GeometryGeneratorOptions};
 * - it is **indexed by default** (pass `indexed: false` for a triangle soup);
 * - it computes its bounding volumes, so the result is immediately cullable and
 *   pickable;
 * - it is centred on the origin, and documents the axis it is aligned with.
 *
 * | Generator | Aligned with | Notes |
 * | --- | --- | --- |
 * | `BoxGeometry` | any | six independent faces, so edges stay hard |
 * | `PlaneGeometry` | XY, facing +Z | the quad a full-screen pass wants |
 * | `SphereGeometry` | Y (poles) | one pole vertex per segment, so UVs do not pinch |
 * | `CylinderGeometry` | Y | also a cone and a frustum |
 * | `ConeGeometry` | Y | a cylinder with a zero top radius |
 * | `CapsuleGeometry` | Y | one swept surface, so no cap/wall seam |
 * | `TorusGeometry` | XZ | analytic normals, so the silhouette is exact |
 * | `CircleGeometry` | XY, facing +Z | triangle fan |
 * | `RingGeometry` | XY, facing +Z | annulus, square or polar UVs |
 * | `Tetra/Octa/Dodeca/IcosahedronGeometry` | any | `detail` subdivides onto the circumsphere |
 * | `TubeGeometry` | along a path | parallel-transport frames, so no twist or flip |
 *
 * @packageDocumentation
 */

export * from './GeometryBuilder';
export * from './PolyhedronGeometry';
export * from './polyhedra';
export * from './BoxGeometry';
export * from './PlaneGeometry';
export * from './SphereGeometry';
export * from './CylinderGeometry';
export * from './ConeGeometry';
export * from './CapsuleGeometry';
export * from './TorusGeometry';
export * from './CircleGeometry';
export * from './RingGeometry';
export * from './TetrahedronGeometry';
export * from './OctahedronGeometry';
export * from './DodecahedronGeometry';
export * from './IcosahedronGeometry';
export * from './TubeGeometry';
