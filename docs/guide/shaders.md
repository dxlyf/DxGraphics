# Shaders

The shader layer: descriptors, the chunk registry, the compile cache, and a built-in library of
twelve programs.

> **Note:** the material layer consumes these descriptors. `src/materials/` ships the full family —
> `MeshBasicMaterial` through `MeshPhysicalMaterial`, plus `ShaderMaterial`, `RawShaderMaterial`,
> `ShadowMaterial`, `DepthMaterial` and `NormalMaterial` — and `ShaderMaterial` takes a descriptor
> directly. This page documents the shader layer itself, which is also usable standalone through
> `ShaderCompiler` and the WebGL renderer's structural material contract.

## The library

`ShaderLib` maps a name to a descriptor pair. `registerShaderLib(name, descriptor)` adds your
own.

| Name | Description |
| --- | --- |
| `basic` | Unlit colour, optional diffuse/alpha maps and vertex colours. |
| `lambert` | Diffuse-only lighting with emissive support. |
| `phong` | Blinn–Phong specular highlights on top of Lambert diffuse. |
| `standard` | Metallic-roughness physically based shading. |
| `physical` | `standard` plus clearcoat, transmission, sheen and iridescence. |
| `points` | Screen-space point sprites with size attenuation. |
| `dashed` | Line rendering with a dash/gap pattern along the segment length. |
| `sprite` | Camera-facing quad with rotation and size attenuation. |
| `depth` | Depth-only pass with optional packing and displacement. |
| `normal` | View-space normals with optional normal mapping, for debug output. |
| `shadow` | Shadow-caster pass: depth only, alpha-tested where a map is bound. |
| `background` | Full-screen background/skybox gradient and cube sampling. |

```ts
import { ShaderLib, registerShaderLib } from '@dxyl/graphics';

const entry = ShaderLib['standard'];   // ShaderLibEntry
entry.name;                            // 'standard'
entry.description;                     // 'Metallic-roughness physically based shading.'
entry.glsl;                            // ShaderDescriptor
entry.wgsl;                            // ShaderDescriptor | null — null when no WGSL variant exists
```

An entry carries **both** a GLSL and a WGSL descriptor, and `wgsl` is `null` for a program with
no WGSL variant. That is the shape a backend-agnostic material needs: pick the descriptor the
active backend understands rather than branching on the backend name.

```ts
registerShaderLib('toon', {
  name: 'toon',
  description: 'Two-band cel shading.',
  glsl: { /* vertex/fragment sources or chunks */ },
  wgsl: null,
});
```

`ShaderLibError` is thrown for an unknown or malformed entry.

## Compiling

`ShaderCompiler` turns a descriptor into a backend object, caching by key.

```ts
import { ShaderCompiler } from '@dxyl/graphics';

const compiler = new ShaderCompiler(/* backend hooks */);

try {
  const shader = compiler.compile(descriptor);
} catch (error) {
  if (error instanceof ShaderCompileError) {
    // Carries the compiler's own log, which is the only useful text for a GLSL failure.
    console.error(error.message);
  }
}
```

`ShaderCompileError` is the failure type. A compile failure is a real error, not a warning: a
shader that did not link draws nothing, and swallowing that produces a blank frame with no
explanation — which is the failure mode this library is written to avoid.

The compile cache is keyed on the descriptor's identity plus its `defines`, so changing a
preprocessor definition produces a distinct entry rather than silently reusing a stale program.
`renderer.stats.programCompiles` counts compilations, which is how you confirm the cache is
working: it should stop rising after the first few frames.

## Descriptors, chunks and uniforms

| Export | Role |
| --- | --- |
| `Shader` | A compiled shader program. |
| `ShaderChunk` | A named, reusable piece of GLSL/WGSL source. |
| `ShaderCache` | Keyed storage for compiled shaders. |
| `ShaderCompiler` | Descriptor → backend object, with `ShaderCompileError`. |
| `ShaderLib` / `ShaderLibEntry` / `registerShaderLib` | The built-in program library. |
| `Uniforms` | The uniform-bag helpers the compiler and the WebGL renderer share. |
| `types` | `ShaderDescriptor`, `ShaderBackend` and the rest of the vocabulary. |
| `glsl/` | GLSL libraries and the `lib/*` chunk set (`basic`, `dashed`, `depth`, …). |
| `wgsl/` | The WGSL counterparts. |

The `glsl/lib/` and `wgsl/` barrels are the language-specific halves. Both are re-exported from
`src/shaders/index.ts`, so `import { … } from '@dxyl/graphics'` reaches them.

## Using a shader today

Because there is no material class, a shader reaches the GPU through the WebGL renderer's
structural material contract:

```ts
import { Mat4, Vec3 } from '@dxyl/graphics';
import { WebGLRenderer } from './renderer/webgl/WebGLRenderer';

const material = {
  vertexShader: `
    attribute vec3 position;
    attribute vec3 normal;
    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;
    uniform mat3 normalMatrix;
    varying vec3 vNormal;
    void main() {
      vNormal = normalize(normalMatrix * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    precision mediump float;
    uniform vec3 baseColor;
    varying vec3 vNormal;
    void main() {
      float lambert = max(dot(normalize(vNormal), vec3(0.0, 1.0, 0.0)), 0.0);
      gl_FragColor = vec4(baseColor * (0.2 + lambert * 0.8), 1.0);
    }
  `,
  uniforms: { baseColor: new Color('#2f6fdf').toArray().slice(0, 3) },
};
```

Three conventions make this work, and all three are documented in
[../architecture/renderer-interface.md](../architecture/renderer-interface.md):

1. **GLSL ES 1.00** is the safe dialect. It links on both WebGL1 and WebGL2, and the renderer's
   own built-in program uses it for that reason. A fragment shader must declare a default float
   `precision`.
2. **`projectionMatrix`, `viewMatrix`, `modelMatrix`, `modelViewMatrix`, `normalMatrix` and
   `cameraPosition` are uploaded automatically** when the program declares them. Do not put them
   in the material's `uniforms` bag.
3. **Author in column-major, column-vector form.** `gl_Position = projectionMatrix *
   modelViewMatrix * vec4(position, 1.0)` is the whole vertex transform. Every matrix the
   library produces uploads verbatim — `gl.uniformMatrix4fv(location, false, m.elements)` needs
   no transpose. See [math-conventions.md](math-conventions.md).

> **Note:** a WGSL path exists in `src/shaders/wgsl/`, but `src/renderer/webgpu/` is empty, so
> there is no backend to consume it. The WGSL library is there for the layer that lands next.

## `defines` and program variants

`defines` is a `Readonly<Record<string, string | number | boolean | null | undefined>>` injected
into both stages:

```ts
const material = {
  vertexShader,
  fragmentShader,
  defines: { USE_NORMAL_MAP: true, MAX_LIGHTS: 4, DEBUG_CHANNEL: null },
  uniforms: { /* … */ },
};
```

A `null` or `undefined` value is a define with no value, which is what a plain `#ifdef` wants.
Because the value is part of the cache key, two materials that differ only in `USE_NORMAL_MAP`
compile to two programs — which is the point of the mechanism, and the reason to keep the set of
distinct define combinations small.

## Validating a shader without a GPU

`tools/shader-compiler/` runs a structural pass over a GLSL or WGSL file — unbalanced braces, a
missing entry point, an unused `varying`, a missing fragment `precision`, and GLSL/WGSL token
mix-ups — and then reports honestly that no GPU compiler is available to do a real one:

```bash
node --experimental-strip-types tools/shader-compiler/compile.ts src/shaders/glsl/mine.glsl
```

See [tools/shader-compiler/README.md](../../tools/shader-compiler/README.md).

## See also

- [materials-and-textures.md](materials-and-textures.md) — the structural contract a shader is
  consumed through.
- [../architecture/renderer-interface.md](../architecture/renderer-interface.md) — the WebGL
  draw path, step by step.
- [rendering-backends.md](rendering-backends.md#webgl-specifics) — the camera adapter that
  `viewMatrix` requires.
