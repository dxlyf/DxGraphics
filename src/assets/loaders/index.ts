/**
 * `assets/loaders` — the concrete loaders and the format parsers behind them.
 *
 * | Loader | Format | Fidelity |
 * | --- | --- | --- |
 * | {@link FileLoader} | text/JSON/bytes/blob | real, with an XHR progress fallback |
 * | {@link ImageLoader} | any bitmap the host decodes | real, injectable decoder |
 * | {@link TextureLoader} | image + sampler state | real, returns a structural texture |
 * | {@link FontLoader} | BMFont text + JSON | real |
 * | {@link JSONLoader} | JSON, with a tolerant mode | real |
 * | {@link GLTFLoader} | glTF 2.0 + GLB | **real** — buffers, accessors, meshes, materials, nodes |
 * | {@link OBJLoader} | OBJ + MTL | **real** — groups, UVs, normals, negative indices, n-gons |
 * | {@link STLLoader} | STL ASCII + binary | **real** |
 * | {@link PLYLoader} | PLY ASCII + binary LE/BE | **real** — declared property types, lists |
 * | {@link SVGLoader} | SVG path data | **real** — full command grammar, arcs |
 * | {@link FBXLoader} | ASCII FBX header + node tree | **documented stub** — refuses binary FBX |
 *
 * The three parser modules (`geometryUtils`, and the format helpers inside each
 * loader) are exported too, so a caller that already has bytes — from a cache, a
 * worker, or a test fixture — can parse without going through a network round trip.
 *
 * @packageDocumentation
 */

export * from './Loader';
export * from './LoaderManager';
export * from './FileLoader';
export * from './ImageLoader';
export * from './TextureLoader';
export * from './FontLoader';
export * from './JSONLoader';
export * from './geometryUtils';
export * from './OBJLoader';
export * from './STLLoader';
export * from './PLYLoader';
export * from './GLTFLoader';
export * from './FBXLoader';
export * from './SVGLoader';
