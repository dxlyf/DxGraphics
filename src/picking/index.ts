/**
 * `picking` — everything that answers "what is under this point?".
 *
 * Four complementary strategies, one per situation:
 *
 * | Entry point | Strategy | Use when |
 * | --- | --- | --- |
 * | {@link Raycaster} | world-space ray vs scene graph | you need the object and a distance |
 * | {@link MeshPicker} | precise ray vs triangles | you need UV/barycentric/normal |
 * | {@link BoundingBoxPicker} | ray vs bounding volumes | you need speed, not accuracy |
 * | {@link GPUPicking} | render ids, read a pixel | the scene is huge, instanced or shader-generated |
 * | {@link HitTest2D} | z-ordered tree walk | the scene is 2D |
 * | {@link SpritePicker} | ray vs camera-facing quad | the target is a billboard |
 *
 * ```ts
 * const ray = new Raycaster();
 * ray.setFromCamera(ndc, camera);
 * const hit = ray.intersectObjects(scene.children, true)[0];
 * ```
 *
 * ## Independence from `src/scene`
 *
 * Nothing here imports the scene graph, geometry or renderer *modules*: every
 * dependency is a **structural interface** declared in {@link types}. `Object3D`,
 * `Mesh`, `BufferGeometry`, `Camera3D`, `Node2D` and the concrete renderers all
 * satisfy those interfaces unchanged, and `Raycaster` additionally implements the
 * `RaycasterLike` contract the scene graph already declares for its own raycast
 * methods — so either layer can drive the other.
 *
 * @packageDocumentation
 */

export * from './Raycaster';
export * from './MeshPicker';
export * from './BoundingBoxPicker';
export * from './SpritePicker';
export * from './HitTest2D';
export * from './PickingRenderTarget';
export * from './GPUPicking';
export * from './raycastData';
export type * from './types';
