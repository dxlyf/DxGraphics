# Materials and textures

> **Note:** this module is still stabilising — `src/materials/` and `src/textures/` are **empty
> directories** in this checkout. There are no `MeshStandardMaterial`, `MeshBasicMaterial`,
> `ShaderMaterial`, `Texture`, `DataTexture` or `Sampler` classes yet.

This page documents the **verified subset**: the structural contracts the renderer actually
reads. Those contracts are load-bearing — the renderers are written against them, so an object
satisfying one is a material as far as this library is concerned. Nothing below is invented; each
interface is quoted from the file that declares it.

## What a material is today

There is no base class. The renderer and the scene graph accept **any object** with the right
members, so a plain object literal is a complete material:

```ts
import { Mesh, BufferGeometry } from '@dxyl/graphics';

// A 2D material: the minimum the Canvas2D/SVG backends read.
const flat = { color: '#2f6fdf', opacity: 1, visible: true, transparent: false };

// A WebGL material: GLSL sources plus a uniform bag.
const lit = {
  vertexShader: `…`,
  fragmentShader: `…`,
  uniforms: { baseColor: [0.18, 0.44, 0.87], lightDirection: [0.45, 0.8, 0.55] },
  depthTest: true,
  depthWrite: true,
  transparent: false,
};

scene.add(new Mesh({ geometry, material: lit }));
```

## The renderer's material contract

From `src/renderer/interfaces/types.ts`:

```ts
export interface MaterialLike {
  /** Stable identifier; used as the secondary sort key by the render queue. */
  readonly id?: string | number;
  /** `true` when the material blends against what is already in the target. */
  readonly transparent?: boolean;
  /** Overrides the renderable's own `renderOrder` when present. */
  readonly renderOrder?: number;
  /** Shader program backing the material, when the backend has one. */
  readonly shader?: IShader | null;
}
```

Four fields, all optional. `id` matters more than it looks: the render queue sorts by
`renderOrder`, then `materialId`, then depth, so giving two objects the same `id` groups their
draws and reduces state changes. Leaving it undefined makes the queue fall back to the object's
own `id`, which groups nothing.

`transparent` decides the bucket: transparent geometry is drawn after opaque, back-to-front,
with blending. `RenderList.push` resolves it as, in order:

1. an explicit per-submission `transparent` option,
2. the renderable's own `transparent` field,
3. `false` if the renderable declares `opaque: true`,
4. otherwise the material's `transparent`,
5. otherwise `true` if the depth falls below the list's `transparentDepthThreshold`.

## The 3D scene's material contract

From `src/scene/3d/types.ts`:

```ts
export interface MaterialLike {
  visible?: boolean;
  transparent?: boolean;
  opacity?: number;
  readonly effectiveOpacity?: number;
  side?: string;          // 'front' | 'back' | 'double'
  depthWrite?: boolean;
  depthTest?: boolean;
  readonly type?: string;
  dispose?(): void;
}
```

`Mesh.material` accepts one of these **or a `readonly MaterialLike[]`**; an array selects one
material per geometry group, and `mesh.getMaterialAt(index)` returns the right one (index `0`
for a single-material mesh). `Mesh.raycast` skips a mesh whose material has `visible === false`.

## The 2D scene's material contract

From `src/scene/2d/types.ts`:

```ts
export interface Material2DLike {
  visible?: boolean;
  opacity?: number;   // multiplied with the node's alpha
  color?: unknown;    // in a form the backend understands
  dispose?(): void;
}
```

Note `opacity` here is **multiplied with the node's `alpha`**, whereas the 3D contract's
`opacity` is the resolved alpha. That asymmetry is real, and it is why `effectiveOpacity` exists
on the 3D side.

## The WebGL material contract

`src/renderer/webgl/WebGLRenderer.ts` extends the renderer contract with the shader and state
fields:

```ts
export interface WebGLMaterialLike extends MaterialLike {
  readonly visible?: boolean;
  readonly vertexShader?: string | null;    // GLSL, used when `shader` is absent
  readonly fragmentShader?: string | null;
  readonly defines?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  readonly uniforms?: Readonly<Record<string, UniformValue>>;
  readonly textures?: Readonly<Record<string, TextureBindingLike>>;  // keyed by sampler name
  readonly depthTest?: boolean;   // default true
  readonly depthWrite?: boolean;  // default true
  readonly topology?: PrimitiveTopology;
  readonly side?: CullMode;
}
```

A material that supplies a ready `IShader` through `shader` is used as-is and the GLSL sources
are ignored. A material that supplies **neither** makes the renderer fall back to its built-in
ES 1.00 program, which links on both WebGL generations — that is why a bare `{}` material still
draws.

## Per-object overrides

Uniforms can be set on the **renderable** as well as the material, and the renderable wins:

```ts
this.uploadAutomaticUniforms(program, renderable, camera);
if (material?.uniforms !== undefined) program.setUniforms(material.uniforms);
if (renderable.uniforms !== undefined) program.setUniforms(renderable.uniforms);
```

That ordering is what lets two objects share one material and differ in a single uniform,
instead of forcing one material per object.

`uploadAutomaticUniforms` supplies these for free when the program declares them:
`projectionMatrix`, `viewMatrix`, `modelMatrix`, `modelViewMatrix`, `normalMatrix` and
`cameraPosition`. It reads the view matrix from **`camera.viewMatrix`**, which `Camera3D` exposes
as an alias of its `matrixWorldInverse` — see
[rendering-backends.md](rendering-backends.md#webgl-specifics).

## Textures

> **Note:** `src/textures/` is empty. There is no `Texture`, `DataTexture`, `CubeTexture`,
> `TextureLoader`, sampler or format enum yet. What exists is the structural binding the WebGL
> renderer reads.

From `src/renderer/webgl/WebGLRenderer.ts`:

```ts
export interface TextureBindingLike {
  readonly image?: TexImageSource | null;
  // plus the sampler state the backend applies when it binds the unit
}
```

Bindings are keyed by **sampler uniform name**, and the renderer assigns units itself:

```ts
const material = {
  fragmentShader: `…`,
  textures: { map: { image: myImageBitmap } },   // `map` is the sampler's name in the shader
};
```

`renderer.bindTextures(program, state, textures)` returns the number of units it bound, and
`renderer.renderInfo.memory.textures` reports how many are live. Texture memory is bounded by
the context's `maxTextureUnits` (in `renderer.info.maxTextureUnits`) and
`DEFAULT_MAX_TEXTURE_UNITS` from `src/constants.ts` is the fallback when a device reports
nothing (`16`).

The 2D side has its own structural texture view, which is what a `Sprite` or a textured quad
would use:

```ts
export interface Texture2DLike {
  readonly image?: unknown;   // anything `drawImage` accepts
  readonly width?: number;
  readonly height?: number;
  dispose?(): void;
}
```

## Render state that a material controls

| Field | Applies to | Effect |
| --- | --- | --- |
| `transparent` | all backends | Buckets the draw and enables blending |
| `opacity` / `effectiveOpacity` | all backends | Multiplied into the node alpha |
| `depthTest` / `depthWrite` | WebGL | Depth buffer behaviour; defaults are `true` |
| `side` | WebGL | `CullMode` — front, back or none |
| `topology` | WebGL | `PrimitiveTopology.Triangles` by default |
| `visible` | all backends | Skips the draw entirely |
| `renderOrder` | all backends | Secondary sort key, after the renderable's own |

The Canvas2D and SVG backends have no depth buffer, so `depthTest`/`depthWrite` are ignored
there: ordering is entirely the render queue's business. See
[rendering-backends.md](rendering-backends.md#sorting-and-the-render-queue).

## Disposal

A material that owns GPU resources should implement `dispose()`. The renderer does not dispose
materials for you, because two meshes may share one — the same rule as geometry.

```ts
const geometry = makeCube(1);
const material = { vertexShader, fragmentShader, uniforms: {}, dispose() { /* release GL objects */ } };

const mesh = new Mesh({ geometry, material });

// Later, once nothing uses them:
geometry.dispose();
material.dispose();
```

`Scene3D.dispose()` releases listeners and the parent link for every node but explicitly leaves
geometry and materials alone. See
[../architecture/resource-lifetimes.md](../architecture/resource-lifetimes.md).

## What to use until the layer lands

| Need | Today |
| --- | --- |
| A flat-coloured 3D object | A material literal, plus the WebGL renderer's built-in program |
| A lit 3D object | Write the GLSL yourself, as `examples/webgl` does |
| A 2D filled shape | `Canvas2DPainter.fillStyle` / a renderable's own `render` |
| A textured quad | `painter.drawImage(image, { dx, dy, dw, dh })` |
| A cached decoded image | A `Map<string, ImageBitmap>` — see `examples/assets` |
| Blending | `painter.globalCompositeOperation`, or `transparent` on WebGL |

`docs/architecture/extending.md` describes what a real material and texture layer needs to
provide, so the shapes above are a specification rather than a placeholder.
